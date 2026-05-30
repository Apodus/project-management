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
 * The lane-lock acquire/heartbeat/release lives in the scheduler wrapper
 * (batch.ts), exactly as runBatchOnce wraps its drain — this function assumes
 * the lock is already held and never touches it.
 */
import type { Logger } from "./logger.js";
import type { GitOps } from "./git-ops.js";
import type { Worktree } from "./worktree.js";
import type { MergeRequestView } from "@pm/shared";
import type { PmClient, RejectCategory } from "./pm-client.js";
import {
  assembleGroup,
  type AssembledGroupOk,
  type AssembleGroupDeps,
} from "./group-assembly.js";
import { categorize } from "./categorize.js";
import { chaosCrashPoint } from "./chaos.js";

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
  /** Per-repo verify fallback when a member has no verifyCmd. */
  defaultVerifyCommand: string;
  verifyTimeoutSec: number;
  /** Integrator identity recorded on pickup (markGroupIntegrating). */
  integratorId?: string;
  /** Log directory for the per-attempt verify logs (per repo). */
  innerLogsDir?: string;
  outerLogsDir?: string;
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
  /** The resolved ref to rebase per repo (commitSha ?? branch). */
  innerRef: string;
  outerRef: string;
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
 * Returns the bound inner/outer members + their rebase refs + the inner
 * gitlink path, or `{ ok:false, reason }` when binding is ambiguous/unresolvable.
 */
export async function bindMembersToRoles(
  members: MergeRequestView[],
  innerLane: RepoLane,
  outerLane: RepoLane,
): Promise<
  | { ok: true; binding: MemberBinding }
  | { ok: false; reason: string }
> {
  if (members.length !== 2) {
    return {
      ok: false,
      reason: `merge group must have exactly 2 members for cross-repo integration; got ${members.length}`,
    };
  }

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

const PASS = (r: VerifyOutcome): boolean => r.exitCode === 0 && !r.timedOut;

const LOG_EXCERPT_CAP = 4096;

function summaryLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return (line ?? "").trim().slice(0, 500);
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

  // ── 1. Bind members → roles (FIX 1) BEFORE pickup. ──
  // An ambiguous/unresolvable binding is a PRE-PICKUP failure → reject from
  // FORMING (FIX 2: forming→rejected, a legal §3.3 edge; no 409). No worktrees
  // are leased yet, so there is nothing to release.
  const bound = await bindMembersToRoles(group.members, innerLane, outerLane);
  if (!bound.ok) {
    logger.warn(
      { groupId: group.id, reason: bound.reason },
      "group member→role binding failed; rejecting from forming",
    );
    // FIX 3: the rejectGroup `reason` IS the surfacing (the MERGE_GROUP_REJECTED
    // event + the group's resolutionReason carry it; the group-reject path does
    // NOT post a per-member merge_rejection comment — confirmed in
    // merge-group.service.rejectGroup / routes/merge-groups.ts). Surfacing
    // exactly once, no double-reject.
    await pmClient.rejectGroup(group.id, {
      reason: bound.reason,
      category: "other",
    });
    return { kind: "rejected", reason: bound.reason };
  }
  const { innerMember, outerMember, innerRef, outerRef, gitlinkPath } =
    bound.binding;

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
    // inner_conflict / outer_conflict / gitlink_mismatch: a PRE-PICKUP assembly
    // failure → reject straight from FORMING (FIX 2; do NOT markGroupIntegrating
    // — forming→rejected is a legal §3.3 edge, no 409).
    const isConflict =
      asm.reason === "inner_conflict" || asm.reason === "outer_conflict";
    const reason = `group assembly failed (${asm.reason})${asm.detail ? `: ${asm.detail}` : ""}`;
    logger.warn(
      { groupId: group.id, reason },
      "group assembly failed pre-pickup; rejecting from forming",
    );
    await pmClient.rejectGroup(group.id, {
      reason,
      category: isConflict ? "conflict" : "other",
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

  // ── 4. startAttempt per member (§5.3) — base = the SHA the per-repo rebase
  //       anchored to (Mi / Mo). No batch tags (a group is not a batch). ──
  const innerAttempt = await pmClient.startAttempt(
    innerMember.id,
    asm.baseInnerSha,
    {},
  );
  const outerAttempt = await pmClient.startAttempt(
    outerMember.id,
    asm.baseOuterSha,
    {},
  );

  // ── 5. CONCURRENT assembled verify + AND (§5.3). BOTH must settle (do NOT
  //       abort the sibling on first-fail) so each attempt gets a truthful
  //       outcome. ──
  const innerVerifyCmd = innerMember.verifyCmd ?? deps.defaultVerifyCommand;
  const outerVerifyCmd = outerMember.verifyCmd ?? deps.defaultVerifyCommand;
  const innerLogPath = logPathFor(deps.innerLogsDir, asm.innerWt, innerAttempt.id);
  const outerLogPath = logPathFor(deps.outerLogsDir, asm.outerWt, outerAttempt.id);

  const timeoutMs = deps.verifyTimeoutSec * 1000;
  const [resI, resO] = await Promise.all([
    asm.innerGitOps.runVerify(innerVerifyCmd, timeoutMs, {
      cwd: asm.innerWt.path,
      logPath: innerLogPath,
    }),
    asm.outerGitOps.runVerify(outerVerifyCmd, timeoutMs, {
      cwd: asm.outerWt.path,
      logPath: outerLogPath,
    }),
  ]);

  const innerPass = PASS(resI);
  const outerPass = PASS(resO);
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
    ): Promise<void> => {
      const cat = categorize({
        exitCode: res.exitCode,
        signal: res.signal,
        stdout: res.stdout,
        stderr: res.stderr,
        timedOut: res.timedOut,
      });
      const reason =
        cat.reason || summaryLine(res.stderr || res.stdout) || "verify failed";
      const excerpt = `${res.stdout}\n${res.stderr}`.slice(0, LOG_EXCERPT_CAP);
      await pmClient.completeAttempt(attemptId, {
        status: "failed",
        failureCategory: cat.category,
        failureReason: reason,
        failedFiles: cat.failedFiles,
        logExcerpt: excerpt,
        logUrl: undefined,
      });
      // Record the FIRST failing repo's category/reason for the group reason.
      if (!failingRepo) {
        rejectCategory = cat.category;
        failingRepo = label;
        failReason = reason;
      }
    };

    if (!innerPass) {
      await completeFailing("inner", innerAttempt.id, resI);
    } else {
      await pmClient.completeAttempt(innerAttempt.id, { status: "cancelled" });
    }
    if (!outerPass) {
      await completeFailing("outer", outerAttempt.id, resO);
    } else {
      await pmClient.completeAttempt(outerAttempt.id, { status: "cancelled" });
    }

    const reason = `assembled verify failed: ${failingRepo} ${failReason}`;
    // rejectGroup rejects ALL members atomically (do NOT also per-member
    // rejectMergeRequest — that would double-reject). FIX 3: the rejectGroup
    // `reason` IS the exactly-once surfacing record (no merge_rejection comment
    // is posted by the group-reject path).
    await pmClient.rejectGroup(group.id, { reason, category: rejectCategory });
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
  };
}

// ─── helpers ──────────────────────────────────────────────────────────

/**
 * Per-attempt verify log path. Prefers an explicit per-repo logs dir; falls
 * back to the worktree's own logsDir (mirrors batch.ts's logPathFor).
 */
function logPathFor(
  logsDir: string | undefined,
  wt: Worktree,
  attemptId: string,
): string {
  const dir = logsDir ?? wt.logsDir;
  return `${dir}/${attemptId}.log`;
}
