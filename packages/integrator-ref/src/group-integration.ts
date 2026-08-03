/**
 * Phase 7.3 Step 10 — group integration + assembled verify.
 *
 * Drives ONE forming cross-repo merge group through the atomic
 * bind → assemble → pickup → per-member attempt → CONCURRENT assembled verify
 * (the AND) sequence, stopping at the Step-10/11 seam:
 *   - all repos pass  → `ready_to_land` (worktrees held; Step 11 lands from them).
 *   - any repo fails  → reject the whole group (atomic, server-side), worktrees freed.
 *   - backpressure    → leave the group forming, nothing touched (retry next pass).
 *
 * Design references: §5.2 (assemble — done by Step 9's assembleGroup), §5.3
 * (per-repo verify against the assembled checkout, concurrent, AND-combined),
 * §6.6 (assembled-verify-fail → reject group, nothing landed), §3.3 (legal
 * transitions: forming→rejected for a PRE-pickup failure; integrating→rejected
 * for a POST-pickup verify failure).
 *
 * SYNTHETIC groups (cross-repo synthesize forms) flow through the SAME sequence
 * with one synthetic (PM-minted, ref-less) member, no forked code path:
 *   - SYNTHETIC-OUTER (inner-only, campaign 2026-06-10): binding maps the
 *     synthetic to the outer role with `outerRef: null`; the assembly skips the
 *     outer rebase (the outer candidate is synthesized as one gitlink-bump
 *     commit on live outer main).
 *   - SYNTHETIC-INNER (outer-only, campaign umbrella-widening P4, the mirror):
 *     binding maps the synthetic to the inner role with `innerRef: null`; the
 *     assembly skips the inner rebase (Ri = live inner main, the no-op inner)
 *     and the inner verify is short-circuited to a pass — the outer verify
 *     against Ri is the sole gate. The ancestry classifier gates the gitlink
 *     (ancestor→normalize+land; not-ancestor→gitlink_diverged; unreachable→
 *     gitlink_unreachable).
 * Verify / land / reject are identical, keyed by requestId.
 *
 * The lane-lock acquire/heartbeat/release lives in the scheduler wrapper
 * (batch.ts), exactly as runBatchOnce wraps its drain — this function assumes
 * the lock is already held and never touches it.
 */
import type { Logger } from "./logger.js";
import type { GitOps } from "./git-ops.js";
import type { Worktree } from "./worktree.js";
import type { MergeRequestView } from "@pm/shared";
import type { PmClient, RejectCategory } from "./pm-client.js";
import { assembleGroup, type AssembledGroupOk, type AssembleGroupDeps } from "./group-assembly.js";
import { categorize, failureExcerpt } from "./categorize.js";
import { chaosCrashPoint } from "./chaos.js";
import {
  runPipeline,
  toVerifyStepResults,
  type PipelineCacheCtx,
  type PipelineResult,
} from "./verify-pipeline.js";
import type { CacheMode, VerifyStep, VerifyStepResult } from "@pm/shared";
import { NOOP_PHASE_SPANS, type PhaseSpans } from "./phase-recorder.js";

// ─── Role-bound repo descriptor (config-declared role) ────────────────

/**
 * One linked repo, with its CONFIG-DECLARED role and a per-repo worktree pool
 * (the correlated pools assembleGroup leases from) + a clone for ref binding.
 * `resolveRefInClone` resolves a ref in this repo's clone (FIX 1 binding): it
 * returns the SHA if the ref exists in this repo, or null if it does not. The
 * scheduler builds this from each linkedRepo.
 */
export interface RepoLane {
  /** linkedRepos[].role — the AUTHORITATIVE role (NOT inferred). */
  role: "inner" | "outer";
  /** linkedRepos[].name (for logging). */
  name: string;
  /** Acquire one slot from THIS repo's pool (sync, null on exhaustion). */
  acquire(): Worktree | null;
  /** Release a slot back to THIS repo's pool. */
  release(wt: Worktree): void;
  /** Build a GitOps bound to a worktree path (the batch.ts factory). */
  gitOps(worktreePath: string): GitOps;
  /** Inner repo's gitlink path within the outer tree (POSIX). Only the
   *  role:"inner" lane carries a meaningful value; outer carries undefined. */
  gitlinkPath?: string;
  /**
   * Resolve `ref` in THIS repo's binding clone. Returns the SHA, or null when
   * the ref does not exist in this repo (FIX 1: commitSha is globally ~unique,
   * so it resolves in exactly one repo). MUST NOT throw on an absent ref.
   */
  resolveRefInClone(ref: string): Promise<string | null>;
}

// ─── Dependencies ─────────────────────────────────────────────────────

export interface GroupIntegrationDeps {
  pmClient: PmClient;
  logger: Logger;
  /** The two linked-repo lanes (exactly one inner + one outer). */
  innerLane: RepoLane;
  outerLane: RepoLane;
  /** The git remote name (e.g. "origin"), threaded to assembleGroup so the
   *  Direction-C detection can DWIM-resolve a bare outer branch ref. */
  gitRemote: string;
  /** Per-repo verify fallback when a member has no verifyCmd. */
  defaultVerifyCommand: string;
  verifyTimeoutSec: number;
  /** Integrator identity recorded on pickup (markGroupIntegrating). */
  integratorId?: string;
  /** Log directory for the per-attempt verify logs (per repo). */
  innerLogsDir?: string;
  outerLogsDir?: string;
  /**
   * PHASE 7.5 Step 6 (§6): the lane + cache config for the per-repo cache key.
   * The group keys each repo's pipeline on ITS OWN content-addressed TREE sha
   * (derived from Ri/Ro, which are COMMIT shas — CLARIFICATION A), distinct →
   * no cross-repo collision under one resource. Absent/false → cache off-path.
   */
  projectId?: string;
  resource?: string;
  cacheEnabled?: boolean;
  cacheMode?: CacheMode;
  /**
   * Campaign 2026-08-03 §P2: phase-timing spans, already scoped to this group's
   * id by the scheduler. OPTIONAL, and coalesced ONCE at function entry to a
   * non-nullable local — which is the whole point: `phases?.time(spec, fn)`
   * would short-circuit the entire call expression and SKIP `fn`, silently
   * deleting the operation it was meant to measure. With a non-nullable local
   * that bug is not expressible, and the ~26 test call sites that build these
   * deps as inline literals need no edit.
   */
  phases?: PhaseSpans;
}

// ─── Outcome union ────────────────────────────────────────────────────

export type GroupIntegrationOutcome =
  | {
      kind: "ready_to_land";
      assembled: AssembledGroupOk;
      innerMember: MergeRequestView;
      outerMember: MergeRequestView;
      innerAttemptId: string;
      outerAttemptId: string;
      Ri: string;
      Ro: string;
      // PHASE 7.5 FOLDED-FIX M1: the per-repo pipeline steps, threaded to the
      // passing-land completeAttempt in group-land.ts (pipeI/pipeO are out of
      // scope there — they only run here). Null if a repo produced no steps.
      innerSteps: VerifyStepResult[] | null;
      outerSteps: VerifyStepResult[] | null;
    }
  | { kind: "rejected"; reason: string }
  | { kind: "backpressure" };

// ─── Group input ──────────────────────────────────────────────────────

export interface GroupToIntegrate {
  id: string;
  members: MergeRequestView[];
}

// ─── Member→repo binding (FIX 1) ──────────────────────────────────────

interface MemberBinding {
  innerMember: MergeRequestView;
  outerMember: MergeRequestView;
  /**
   * The resolved inner ref to rebase (commitSha ?? branch). NULL ⇔ the inner
   * member is SYNTHETIC (an outer-only group, campaign umbrella-widening P4):
   * it carries no branch/commitSha — the assembly skips the inner rebase and
   * lands the outer with Ri = live inner main (the no-op inner).
   */
  innerRef: string | null;
  /**
   * NULL ⇔ the outer member is SYNTHETIC (an inner-only group): it carries no
   * branch/commitSha — the assembly skips the outer rebase and synthesizes the
   * outer gitlink-bump candidate on top of live outer main.
   */
  outerRef: string | null;
  gitlinkPath: string;
}

/**
 * The identity ref to bind/rebase a member by: prefer commitSha (globally
 * ~unique — exists in exactly one repo) over branch. Returns null if a member
 * carries neither (a degenerate request — fail-loud at the call site).
 */
function memberIdentityRef(m: MergeRequestView): string | null {
  return m.commitSha ?? m.branch ?? null;
}

/**
 * FIX 1 — deterministic, config-declared role binding (NO ref-existence guess).
 *
 * For each of the group's 2 members, resolve its identity ref (commitSha-first)
 * in BOTH per-repo clones. Bind member→repo by which clone resolves the ref,
 * then take ROLE FROM CONFIG (the lane's declared role). FAIL LOUD on ambiguity:
 * a member that resolves in BOTH repos, or NEITHER, is not unambiguously
 * bindable → return an error (the caller rejects the group from FORMING).
 *
 * SYNTHETIC arm (cross-repo synthesize forms): when exactly ONE member is
 * `synthetic === true` (strict — undefined takes the legacy arm byte-identically),
 * the synthetic member's role is derived from WHERE the REAL member's identity
 * ref resolves:
 *   - real → INNER repo ⇒ inner-only `synthesizeOuter` group (campaign
 *     2026-06-10): the synthetic IS the outer; `outerRef` null so the assembly
 *     skips the outer rebase and synthesizes the gitlink bump on live outer main.
 *   - real → OUTER repo ⇒ outer-only `synthesizeInner` group (campaign
 *     umbrella-widening P4, the mirror): the synthetic IS the inner; `innerRef`
 *     null so the assembly skips the inner rebase and lands the outer with
 *     Ri = live inner main (the ancestry classifier gates the gitlink).
 * Two synthetic members, or a synthetic member that unexpectedly carries a ref,
 * fail loud. All failures stay PRE-pickup (forming→rejected, the existing path).
 *
 * Returns the bound inner/outer members + their rebase refs + the inner
 * gitlink path, or `{ ok:false, reason }` when binding is ambiguous/unresolvable.
 */
export async function bindMembersToRoles(
  members: MergeRequestView[],
  innerLane: RepoLane,
  outerLane: RepoLane,
): Promise<{ ok: true; binding: MemberBinding } | { ok: false; reason: string }> {
  if (members.length !== 2) {
    return {
      ok: false,
      reason: `merge group must have exactly 2 members for cross-repo integration; got ${members.length}`,
    };
  }

  // ── Synthetic partition (STRICT === true: undefined/false → the legacy arm
  //    below, byte-identically). ──
  const synthetics = members.filter((m) => m.synthetic === true);

  if (synthetics.length >= 2) {
    return {
      ok: false,
      reason: `group has ${synthetics.length} synthetic members; expected at most one`,
    };
  }

  if (synthetics.length === 1) {
    // ── SYNTHETIC-OUTER arm: the synthetic member IS the outer by construction. ──
    const synthetic = synthetics[0];
    const real = members.find((m) => m.synthetic !== true) as MergeRequestView;

    // Defense-in-depth: PM mints synthetic members ref-less; a ref here means
    // something upstream is broken — never guess, refuse.
    if (memberIdentityRef(synthetic) !== null) {
      return {
        ok: false,
        reason: `synthetic member ${synthetic.id} unexpectedly carries a branch/commitSha; refusing to integrate`,
      };
    }

    const ref = memberIdentityRef(real);
    if (!ref) {
      return {
        ok: false,
        reason: `could not unambiguously bind member ${real.id} to inner/outer repo: member has neither commitSha nor branch`,
      };
    }
    // Resolve the REAL member's identity ref in BOTH binding clones
    // (commitSha-first, the existing helper) — same fail-loud matrix as the
    // legacy arm, plus the outer-only guidance case.
    const [inInner, inOuter] = await Promise.all([
      innerLane.resolveRefInClone(ref),
      outerLane.resolveRefInClone(ref),
    ]);
    const resolvesInner = inInner !== null;
    const resolvesOuter = inOuter !== null;

    if (resolvesInner && resolvesOuter) {
      return {
        ok: false,
        reason: `could not unambiguously bind member ${real.id} to inner/outer repo: ref "${ref}" resolves in BOTH repos`,
      };
    }
    if (!resolvesInner && !resolvesOuter) {
      return {
        ok: false,
        reason: `could not unambiguously bind member ${real.id} to inner/outer repo: ref "${ref}" resolves in NEITHER repo`,
      };
    }
    // The gitlink path is a property of the inner repo regardless of WHICH
    // member is inner (shared with the legacy arm, unchanged).
    const gitlinkPath = innerLane.gitlinkPath;
    if (!gitlinkPath) {
      return {
        ok: false,
        reason: `inner linked repo "${innerLane.name}" has no gitlinkPath configured; cannot assemble the group`,
      };
    }

    if (!resolvesInner) {
      // OUTER only (Tier-3, campaign umbrella-widening P4): the real member is
      // the OUTER; the synthetic is the INNER. innerRef null ⇒ the assembly
      // skips the inner rebase and lands the outer with Ri = live inner main
      // (the no-op inner). The ancestry classifier gates the gitlink at
      // assembly (ancestor→normalize+land; not-ancestor→gitlink_diverged;
      // unreachable→gitlink_unreachable) — this is the mirror of the inner-only
      // synthesize_outer bind.
      return {
        ok: true,
        binding: {
          innerMember: synthetic,
          outerMember: real,
          innerRef: null,
          outerRef: ref,
          gitlinkPath,
        },
      };
    }

    // INNER only — bind: real member is the inner, synthetic is the outer,
    // outerRef null (the assembly skips the outer rebase).
    return {
      ok: true,
      binding: {
        innerMember: real,
        outerMember: synthetic,
        innerRef: ref,
        outerRef: null,
        gitlinkPath,
      },
    };
  }

  // ── LEGACY arm (0 synthetic members): two real members, both bound by ref
  //    resolution — UNCHANGED. ──
  let innerMember: MergeRequestView | undefined;
  let outerMember: MergeRequestView | undefined;

  for (const m of members) {
    const ref = memberIdentityRef(m);
    if (!ref) {
      return {
        ok: false,
        reason: `could not unambiguously bind member ${m.id} to inner/outer repo: member has neither commitSha nor branch`,
      };
    }
    // Resolve the SAME identity ref in BOTH clones. commitSha-first means a
    // SHA resolves in exactly one repo; a bare branch name could in theory
    // resolve in both — that is exactly the ambiguity we FAIL LOUD on.
    const [inInner, inOuter] = await Promise.all([
      innerLane.resolveRefInClone(ref),
      outerLane.resolveRefInClone(ref),
    ]);
    const resolvesInner = inInner !== null;
    const resolvesOuter = inOuter !== null;

    if (resolvesInner && resolvesOuter) {
      return {
        ok: false,
        reason: `could not unambiguously bind member ${m.id} to inner/outer repo: ref "${ref}" resolves in BOTH repos`,
      };
    }
    if (!resolvesInner && !resolvesOuter) {
      return {
        ok: false,
        reason: `could not unambiguously bind member ${m.id} to inner/outer repo: ref "${ref}" resolves in NEITHER repo`,
      };
    }
    // ROLE FROM CONFIG: bind to the lane (inner/outer) whose clone resolved it.
    if (resolvesInner) {
      if (innerMember) {
        return {
          ok: false,
          reason: `could not unambiguously bind members to inner/outer repo: two members both bound to the inner repo`,
        };
      }
      innerMember = m;
    } else {
      if (outerMember) {
        return {
          ok: false,
          reason: `could not unambiguously bind members to inner/outer repo: two members both bound to the outer repo`,
        };
      }
      outerMember = m;
    }
  }

  if (!innerMember || !outerMember) {
    return {
      ok: false,
      reason: `could not unambiguously bind members to inner/outer repo: missing an inner or outer member after binding`,
    };
  }

  const gitlinkPath = innerLane.gitlinkPath;
  if (!gitlinkPath) {
    return {
      ok: false,
      reason: `inner linked repo "${innerLane.name}" has no gitlinkPath configured; cannot assemble the group`,
    };
  }

  return {
    ok: true,
    binding: {
      innerMember,
      outerMember,
      // innerRef/outerRef are the rebase refs assembleGroup uses
      // (commitSha ?? branch — already validated non-null above).
      innerRef: memberIdentityRef(innerMember) as string,
      outerRef: memberIdentityRef(outerMember) as string,
      gitlinkPath,
    },
  };
}

// ─── Verify categorization → reject category ──────────────────────────

interface VerifyOutcome {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  logPath: string;
  durationMs: number;
}

const LOG_EXCERPT_CAP = 4096;

function summaryLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return (line ?? "").trim().slice(0, 500);
}

/**
 * The synthetic PASS PipelineResult for a NO-OP inner (a lone-outer group,
 * campaign umbrella-widening P4). innerRef === null ⇒ Ri === live inner main,
 * an already-landed-and-verified tree, so the inner verify is short-circuited
 * (see the verify site). Shaped so the downstream consumers behave exactly like
 * a real single-step pass: `outcome === "pass"`, no `failingStep`, one passing
 * step whose empty `logPath`/`treeSha`/`stepConfigSha` map through
 * `toVerifyStepResults` to a `logUrl: undefined` / empty-string wire shape (the
 * schema allows empty strings there). No verify actually ran.
 */
function syntheticInnerPass(): PipelineResult {
  return {
    outcome: "pass",
    failingStep: null,
    steps: [
      {
        stepId: "verify",
        outcome: "pass",
        durationMs: 0,
        // Campaign 2026-08-03 §P2: zeros because NOTHING RAN. The verify-span
        // emitter skips this pass entirely rather than recording a 0 ms sample —
        // a fabricated sample would drag the verify phase's p50 toward zero on
        // every lone-outer group.
        startedAtMs: Date.now(),
        wallMs: 0,
        waveIndex: 0,
        cached: false,
        treeSha: "",
        stepConfigSha: "",
        verify: {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          logPath: "",
        },
      },
    ],
  };
}

/**
 * Campaign 2026-08-03 §P2: record one `verify` span per pipeline step for ONE
 * repo of an assembled group. The role rides BOTH the label (so P3 can split
 * inner from outer) and `detail` (so a consumer that groups by step id alone
 * can still tell them apart).
 *
 * `wallMs`, never `durationMs`: on a cache HIT the latter is the ORIGINAL run's
 * duration, which would report a 26-minute verify for a pass that spent
 * milliseconds on a lookup.
 */
function recordRepoVerify(
  phases: PhaseSpans,
  pipeline: PipelineResult,
  role: "inner" | "outer",
  requestId: string,
  attemptId: string,
): void {
  for (const step of pipeline.steps) {
    phases.record({
      phase: "verify",
      label: `${role}:${step.stepId}`,
      requestId,
      attemptId,
      startedAtMs: step.startedAtMs,
      durationMs: step.wallMs,
      detail: {
        role,
        cached: step.cached,
        outcome: step.outcome,
        // The two repos verify CONCURRENTLY (the Promise.all below), and within
        // a repo a wave does too — so these durations OVERLAP and must never be
        // summed into an elapsed time.
        concurrent: true,
        waveIndex: step.waveIndex,
        ...(step.cached ? { cachedDurationMs: step.durationMs } : {}),
      },
    });
  }
}

// ─── rejectGroupLegibly (the single group-reject choke-point) ─────────

/**
 * Reject a whole group AND surface it legibly. The `rejectGroup` call is
 * BYTE-IDENTICAL to the bare call it replaces (same reason + category) — the
 * ONLY addition is a best-effort structured `merge_rejection` task comment per
 * real member, so an author sees the failure where they work instead of a
 * silent drain (the live P6-v1 binding-failure mode: the group-reject path
 * posts NO per-member comment by design). The comment posts are wrapped
 * individually and NEVER throw out of the reject path — a comment failure must
 * not turn a clean reject into an unhandled error.
 */
async function rejectGroupLegibly(
  pmClient: PmClient,
  logger: Logger,
  group: GroupToIntegrate,
  opts: { reason: string; category: RejectCategory; taskIds: string[] },
): Promise<void> {
  await pmClient.rejectGroup(group.id, { reason: opts.reason, category: opts.category });
  for (const taskId of opts.taskIds) {
    try {
      await pmClient.postTaskComment(taskId, {
        body: `Merge group rejected: ${opts.reason}`,
        commentType: "merge_rejection",
        metadata: { groupId: group.id, category: opts.category, reason: opts.reason },
      });
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e), taskId },
        "merge_rejection comment post failed (non-fatal)",
      );
    }
  }
}

// ─── runGroupIntegration ──────────────────────────────────────────────

/**
 * Integrate one forming group up to the Step-10/11 seam. The lane lock is held
 * by the scheduler. See the module header for the full sequence.
 */
export async function runGroupIntegration(
  group: GroupToIntegrate,
  deps: GroupIntegrationDeps,
): Promise<GroupIntegrationOutcome> {
  const { pmClient, logger, innerLane, outerLane } = deps;
  const phases = deps.phases ?? NOOP_PHASE_SPANS;

  // ── 1. Bind members → roles (FIX 1) BEFORE pickup. ──
  // An ambiguous/unresolvable binding is a PRE-PICKUP failure → reject from
  // FORMING (FIX 2: forming→rejected, a legal §3.3 edge; no 409). No worktrees
  // are leased yet, so there is nothing to release.
  // Binding resolves each member's identity ref in BOTH per-repo clones — two
  // git reads per member against clones that may be cold. It is `assemble` work
  // that happens before any worktree is leased, so nothing else can report it.
  const bound = await phases.time(
    { phase: "assemble", label: "bind", detail: (b) => ({ ok: b?.ok ?? false }) },
    () => bindMembersToRoles(group.members, innerLane, outerLane),
  );
  if (!bound.ok) {
    logger.warn(
      { groupId: group.id, reason: bound.reason },
      "group member→role binding failed; rejecting from forming",
    );
    // The rejectGroup `reason` rides the MERGE_GROUP_REJECTED event + the
    // group's resolutionReason; rejectGroupLegibly ADDITIVELY posts a structured
    // merge_rejection comment on every real member (the group-reject path posts
    // none by design — this binding-failure site is exactly the P6-v1 silent
    // drain). No bound innerMember here, so target every member carrying a
    // taskId (a synthetic outer has taskId == null and is skipped).
    await rejectGroupLegibly(pmClient, logger, group, {
      reason: bound.reason,
      category: "other",
      taskIds: group.members.map((m) => m.taskId).filter((t): t is string => t != null),
    });
    return { kind: "rejected", reason: bound.reason };
  }
  const { innerMember, outerMember, innerRef, outerRef, gitlinkPath } = bound.binding;

  // ── 2. assembleGroup (leases BOTH correlated worktrees, rebases, assembles)
  //       BEFORE any PM state change. ──
  const asmDeps: AssembleGroupDeps = {
    acquireInner: () => innerLane.acquire(),
    releaseInner: (wt) => innerLane.release(wt),
    acquireOuter: () => outerLane.acquire(),
    releaseOuter: (wt) => outerLane.release(wt),
    gitOps: (p) => innerLane.gitOps(p),
    innerRef,
    outerRef,
    gitlinkPath,
    gitRemote: deps.gitRemote,
    phases,
    // So a per-role assembly row names WHICH member's work it measured.
    innerRequestId: innerMember.id,
    outerRequestId: outerMember.id,
  };
  const asm = await assembleGroup(asmDeps);

  if (!asm.ok) {
    if (asm.reason === "backpressure") {
      // Pool exhaustion — nothing acquired-and-held, PM untouched. The group
      // stays FORMING; retry next pass.
      logger.info(
        { groupId: group.id },
        "group assembly backpressure; leaving group forming for retry",
      );
      return { kind: "backpressure" };
    }
    // inner_conflict / outer_conflict / gitlink_diverged / gitlink_unreachable /
    // gitlink_mismatch: a PRE-PICKUP assembly failure → reject straight from
    // FORMING (FIX 2; do NOT markGroupIntegrating — forming→rejected is a legal
    // §3.3 edge, no 409). Map each assembly reason to its OWN reject category so
    // the Tier-2 gitlink rejects surface with the right category (not collapsed
    // to "other"); the conflicts stay "conflict", the §11 mismatch stays "other".
    const category: RejectCategory =
      asm.reason === "inner_conflict" || asm.reason === "outer_conflict"
        ? "conflict"
        : asm.reason === "gitlink_diverged"
          ? "gitlink_diverged"
          : asm.reason === "gitlink_unreachable"
            ? "gitlink_unreachable"
            : "other";
    const reason = `group assembly failed (${asm.reason})${asm.detail ? `: ${asm.detail}` : ""}`;
    logger.warn(
      { groupId: group.id, reason },
      "group assembly failed pre-pickup; rejecting from forming",
    );
    // Target ALL real members' tasks (same pattern as the binding-failure
    // choke-point): a lone-outer group's inner member is SYNTHETIC (null
    // taskId), so `[innerMember.taskId]` alone would silently drain the outer
    // author's comment. (Two-member groups additively get the outer task a
    // comment too — intended.)
    await rejectGroupLegibly(pmClient, logger, group, {
      reason,
      category,
      taskIds: group.members.map((m) => m.taskId).filter((t): t is string => t != null),
    });
    // FIX 4 surfacing path also: release the (held) worktrees the failed
    // assembly leased.
    asm.release();
    return { kind: "rejected", reason };
  }

  // ── CHAOS (test-only): crash AFTER assembleGroup ok, BEFORE
  //    markGroupIntegrating. Group still forming, nothing pushed — the
  //    mid-assembly window. Recovery: the still-forming group is simply
  //    re-integrated from scratch on the next pass (zero side effects). ──
  chaosCrashPoint("mid_assembly");

  // ── 3. markGroupIntegrating (forming → integrating; flips members). ──
  // Any failure AFTER this point is a POST-PICKUP failure → reject from
  // INTEGRATING (FIX 2).
  try {
    await pmClient.markGroupIntegrating(group.id, {
      integratorId: deps.integratorId,
    });
  } catch (err) {
    // Could not pick up (e.g. someone else took it / cancelled). Release the
    // assembled worktrees and surface backpressure-like (PM owns the group).
    asm.release();
    logger.warn(
      {
        groupId: group.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "markGroupIntegrating failed; releasing worktrees",
    );
    return { kind: "backpressure" };
  }

  // ── 3b. Direction-C conversion surfacing (campaign xrepo-gitlink-bump-
  //        autoconvert). A REAL outer member recognized as a pure gitlink bump
  //        had its rebase SKIPPED (the outer candidate was synthesized on live
  //        main). Emit an UNCONDITIONAL log line + a best-effort PM audit row so
  //        the conversion is legible in the timeline/audit — never a silent
  //        magic. The audit call swallows errors: a surfacing failure must NEVER
  //        break the land (the DB `synthetic` flag stays untouched — this is an
  //        integration-time interpretation, not a row mutation). ──
  if (asm.outerConverted) {
    logger.info(
      {
        groupId: group.id,
        outerMemberId: outerMember.id,
        gitlinkPath,
        baseOuterSha: asm.baseOuterSha,
      },
      "outer member superseded: pure gitlink bump — outer candidate synthesized against live main",
    );
    try {
      await pmClient.noteOuterConverted(
        outerMember.id,
        "outer member superseded: pure gitlink bump — outer candidate synthesized against live main",
      );
    } catch (err) {
      logger.warn(
        { groupId: group.id, err: err instanceof Error ? err.message : String(err) },
        "noteOuterConverted surfacing failed (non-fatal)",
      );
    }
  }

  // ── 3c. Gitlink-normalization surfacing (campaign xrepo-gitlink-umbrella-
  //        widening P2). A REAL outer member carrying source ALONGSIDE the
  //        managed gitlink had the gitlink hunk STRIPPED — its source-only net
  //        patch was synthesized onto live outer main and step 8 authored the
  //        gitlink to the landing inner Ri. Emit an unconditional legible log
  //        line so the normalization is visible in the daemon trail; the DB
  //        `synthetic` flag stays untouched (an integration-time interpretation,
  //        like a conversion — never a row mutation). A best-effort durable
  //        `outer_gitlink_normalized` audit row makes it legible in the
  //        timeline/audit; the audit call swallows errors so a surfacing failure
  //        can never break the land.
  if (asm.outerGitlinkNormalized) {
    logger.info(
      {
        groupId: group.id,
        outerMemberId: outerMember.id,
        gitlinkPath,
        baseOuterSha: asm.baseOuterSha,
      },
      "outer member gitlink normalized: stale-but-reachable gitlink stripped — outer source applied onto live main, gitlink authored to landing inner",
    );
    try {
      await pmClient.noteOuterGitlinkNormalized(
        outerMember.id,
        "outer member gitlink normalized: stale-but-reachable gitlink stripped — outer source applied onto live main, gitlink authored to landing inner",
      );
    } catch (err) {
      logger.warn(
        { groupId: group.id, err: err instanceof Error ? err.message : String(err) },
        "noteOuterGitlinkNormalized surfacing failed (non-fatal)",
      );
    }
  }

  // ── 4. startAttempt per member (§5.3) — base = the SHA the per-repo rebase
  //       anchored to (Mi / Mo). No batch tags (a group is not a batch). ──
  const innerAttempt = await pmClient.startAttempt(innerMember.id, asm.baseInnerSha, {});
  const outerAttempt = await pmClient.startAttempt(outerMember.id, asm.baseOuterSha, {});

  // ── 5. CONCURRENT assembled verify + AND (§5.3). BOTH must settle (do NOT
  //       abort the sibling on first-fail) so each attempt gets a truthful
  //       outcome. ──
  const innerVerifyCmd = innerMember.verifyCmd ?? deps.defaultVerifyCommand;
  const outerVerifyCmd = outerMember.verifyCmd ?? deps.defaultVerifyCommand;

  // PHASE 7.5 Step 5: route each per-repo verify through runPipeline. linked_repos
  // carries NO per-repo verify_steps yet, so each repo uses the synthetic single
  // step over its existing verify command — byte-identical to today's single
  // runVerify (the synthetic-step bare logPath == the old logPathFor output).
  // Groups have no member-level kill → pass `signal: undefined` EXPLICITLY so each
  // runPipeline mints its own child from an absent parent (no cross-repo abort).
  const innerSteps: VerifyStep[] = [
    { id: "verify", command: innerVerifyCmd, depends_on: [], cache_key_inputs: [] },
  ];
  const outerSteps: VerifyStep[] = [
    { id: "verify", command: outerVerifyCmd, depends_on: [], cache_key_inputs: [] },
  ];
  const innerLogsDir = deps.innerLogsDir ?? asm.innerWt.logsDir;
  const outerLogsDir = deps.outerLogsDir ?? asm.outerWt.logsDir;

  // PHASE 7.5 Step 6 (§6): per-repo cache ctx. CLARIFICATION A — asm.Ri/asm.Ro are
  // COMMIT shas (rebaseOnto / updateSubmoduleGitlink return `git rev-parse HEAD`,
  // which carries a committer timestamp → NOT a stable cache key). Key each repo
  // on its REAL content-addressed TREE sha (`<commit>^{tree}`): inner on Ri's
  // tree, outer on the assembled-outer Ro's tree (the tree with the gitlink→Ri
  // committed). Both tree shas are distinct → no cross-repo collision under one
  // resource, AND the cache actually FUNCTIONS (a re-assembly of an identical tree
  // HITS). `signal: undefined` is explicit (groups have no member-level kill).
  const groupCacheOn =
    (deps.cacheEnabled ?? false) &&
    (deps.cacheMode ?? "off") !== "off" &&
    deps.projectId !== undefined &&
    deps.resource !== undefined;
  let innerCache: PipelineCacheCtx | undefined;
  let outerCache: PipelineCacheCtx | undefined;
  if (groupCacheOn) {
    const [innerTreeSha, outerTreeSha] = await Promise.all([
      asm.innerGitOps.resolveRef(`${asm.Ri}^{tree}`),
      asm.outerGitOps.resolveRef(`${asm.Ro}^{tree}`),
    ]);
    const mode = deps.cacheMode as CacheMode;
    innerCache = {
      enabled: true,
      mode,
      pmClient: deps.pmClient,
      projectId: deps.projectId as string,
      resource: deps.resource as string,
      treeSha: innerTreeSha,
      requestId: innerMember.id,
    };
    outerCache = {
      enabled: true,
      mode,
      pmClient: deps.pmClient,
      projectId: deps.projectId as string,
      resource: deps.resource as string,
      treeSha: outerTreeSha,
      requestId: outerMember.id,
    };
  }

  // Inner-verify short-circuit (campaign umbrella-widening P4): a lone-outer
  // group's inner is a NO-OP — innerRef === null ⇒ Ri === live inner main, an
  // already-landed-and-verified tree. Running defaultVerifyCommand against it is
  // redundant AND re-exposes the land to inner-verify flakiness (a transient
  // inner failure would wrongly reject a change that only touches the outer).
  // Synthesize a PASS instead of running the pipeline (the outer verify against
  // Ri remains the sole real gate).
  const runInnerPipeline = (): Promise<PipelineResult> => {
    if (innerRef === null) {
      return Promise.resolve(syntheticInnerPass());
    }
    return runPipeline(innerSteps, {
      gitOps: asm.innerGitOps,
      cwd: asm.innerWt.path,
      verifyTimeoutSec: deps.verifyTimeoutSec,
      signal: undefined,
      logsDir: innerLogsDir,
      attemptId: innerAttempt.id,
      cache: innerCache,
      logger: deps.logger,
    });
  };

  const [pipeI, pipeO] = await Promise.all([
    runInnerPipeline(),
    runPipeline(outerSteps, {
      gitOps: asm.outerGitOps,
      cwd: asm.outerWt.path,
      verifyTimeoutSec: deps.verifyTimeoutSec,
      signal: undefined,
      logsDir: outerLogsDir,
      attemptId: outerAttempt.id,
      cache: outerCache,
      logger: deps.logger,
    }),
  ]);

  // Campaign 2026-08-03 §P2: the assembled verify's spans. The SYNTHETIC inner
  // pass emits NOTHING — `innerRef === null` means no verify ran at all, and a
  // 0 ms sample is not a cheap verify, it is a fabricated one that would drag
  // the phase's p50 toward zero on every lone-outer group (design lock 3).
  if (innerRef !== null) {
    recordRepoVerify(phases, pipeI, "inner", innerMember.id, innerAttempt.id);
  }
  recordRepoVerify(phases, pipeO, "outer", outerMember.id, outerAttempt.id);

  // Extract the per-repo VerifyResult (the failing-step trigger on fail, else the
  // single synthetic step's result) — the SAME shape the VerifyOutcome consumer
  // (completeFailing / categorize) branched on.
  const resI = (pipeI.failingStep ?? pipeI.steps[0]).verify;
  const resO = (pipeO.failingStep ?? pipeO.steps[0]).verify;

  // PHASE 7.5 FOLDED-FIX M1: map each repo's pipeline RESULTS to the wire shape;
  // threaded to group-land's passing completeAttempt + attached to the failing
  // completeAttempt below (both repos run here, but the passing land is in
  // group-land.ts where pipeI/pipeO are out of scope). (Named *StepResults to
  // avoid colliding with the innerSteps/outerSteps VerifyStep[] config above.)
  const innerStepResults = toVerifyStepResults(pipeI.steps);
  const outerStepResults = toVerifyStepResults(pipeO.steps);

  const innerPass = pipeI.outcome === "pass";
  const outerPass = pipeO.outcome === "pass";
  const pass = innerPass && outerPass;

  // ── 6. Any-fail (POST-PICKUP, §6.6) → reject from INTEGRATING. ──
  if (!pass) {
    // Complete each member's attempt with a TRUTHFUL per-repo outcome: a
    // failing repo → failed (categorized); a passing sibling → cancelled
    // (it passed but the group did not land, so its attempt is not "passed").
    let rejectCategory: RejectCategory = "other";
    let failingRepo = "";
    let failReason = "";

    const completeFailing = async (
      label: string,
      attemptId: string,
      res: VerifyOutcome,
      steps: VerifyStepResult[] | null,
    ): Promise<void> => {
      const cat = categorize({
        exitCode: res.exitCode,
        signal: res.signal,
        stdout: res.stdout,
        stderr: res.stderr,
        timedOut: res.timedOut,
      });
      const reason = cat.reason || summaryLine(res.stderr || res.stdout) || "verify failed";
      const excerpt = failureExcerpt(res.stdout, res.stderr, LOG_EXCERPT_CAP);
      await pmClient.completeAttempt(attemptId, {
        status: "failed",
        failureCategory: cat.category,
        failureReason: reason,
        failedFiles: cat.failedFiles,
        logExcerpt: excerpt,
        logUrl: undefined,
        // PHASE 7.5 FOLDED-FIX M1: this repo's pipeline steps on the fail attempt.
        steps: steps ?? undefined,
      });
      // Record the FIRST failing repo's category/reason for the group reason.
      if (!failingRepo) {
        rejectCategory = cat.category;
        failingRepo = label;
        failReason = reason;
      }
    };

    if (!innerPass) {
      await completeFailing("inner", innerAttempt.id, resI, innerStepResults);
    } else {
      await pmClient.completeAttempt(innerAttempt.id, { status: "cancelled" });
    }
    if (!outerPass) {
      await completeFailing("outer", outerAttempt.id, resO, outerStepResults);
    } else {
      await pmClient.completeAttempt(outerAttempt.id, { status: "cancelled" });
    }

    const reason = `assembled verify failed: ${failingRepo} ${failReason}`;
    // rejectGroup rejects ALL members atomically (do NOT also per-member
    // rejectMergeRequest — that would double-reject). rejectGroupLegibly ADDS a
    // best-effort merge_rejection comment on every real member's task (the
    // group-reject path posts none) — no double-post: this site posts no member
    // comment today. Target ALL real members' tasks (a lone-outer group's inner
    // member is synthetic with a null taskId, so `[innerMember.taskId]` alone
    // would silently drain the outer author's comment).
    await rejectGroupLegibly(pmClient, logger, group, {
      reason,
      category: rejectCategory,
      taskIds: group.members.map((m) => m.taskId).filter((t): t is string => t != null),
    });
    asm.release();
    logger.info(
      { groupId: group.id, reason },
      "assembled verify failed; group rejected, worktrees released",
    );
    return { kind: "rejected", reason };
  }

  // ── 7. All-pass → ready_to_land (Step-10/11 seam). ──
  // Do NOT release worktrees (Step 11 lands from them). Do NOT complete the
  // attempts as passed (Step 11 completes with the treeSha on land).
  logger.info(
    { groupId: group.id, Ri: asm.Ri, Ro: asm.Ro },
    "group assembled verify passed; ready to land",
  );
  return {
    kind: "ready_to_land",
    assembled: asm,
    innerMember,
    outerMember,
    innerAttemptId: innerAttempt.id,
    outerAttemptId: outerAttempt.id,
    Ri: asm.Ri,
    Ro: asm.Ro,
    innerSteps: innerStepResults,
    outerSteps: outerStepResults,
  };
}
