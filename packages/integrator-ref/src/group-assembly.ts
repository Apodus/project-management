import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  checkMainGitlinkInvariant,
  classifyOuterGitlinkDiff,
  describeDanglingMainGitlink,
  type GitOps,
  type MainGitlinkVerdict,
  type OuterGitlinkClassification,
} from "./git-ops.js";
import type { Worktree } from "./worktree.js";
import { NOOP_PHASE_SPANS, type PhaseSpans } from "./phase-recorder.js";

// ─── Result type (discriminated union, mirrors git-ops RebaseResult) ──

/**
 * §5.2 success: the assembled multi-repo state. Inner worktree sits at `Ri`
 * (the rebased inner candidate SHA); the outer worktree sits at `Ro` (outer
 * rebased + the 160000 gitlink at `gitlinkPath` COMMITTED to point at `Ri`),
 * AND the outer working tree at `gitlinkPath` is physically populated with the
 * inner@Ri sources (step 9 materialization). `Ri` / `Ro` are the two candidate
 * SHAs the atomic land (§6) pushes. Step 9 does NOT verify and does NOT push.
 */
export interface AssembledGroupOk {
  ok: true;
  innerWt: Worktree;
  outerWt: Worktree;
  innerGitOps: GitOps;
  outerGitOps: GitOps;
  /** The inner candidate SHA (rebased inner HEAD). */
  Ri: string;
  /** The assembled outer candidate SHA (outer rebased + gitlink->Ri). */
  Ro: string;
  /** The inner main SHA the inner rebase anchored to (§6.1 precondition 4). */
  baseInnerSha: string;
  /** The outer main SHA the outer rebase anchored to (§6.1 precondition 4). */
  baseOuterSha: string;
  gitlinkPath: string;
  /**
   * Direction-C marker (campaign xrepo-gitlink-bump-autoconvert): true when a
   * REAL outer member (`outerRef !== null`) was recognized as a pure gitlink
   * bump and its rebase SKIPPED — the outer candidate was synthesized on live
   * main instead. Fires on BOTH the two-member arm (structural, campaign
   * autoconvert) AND the lone-outer arm (ancestry-gated `pure_bump`, campaign
   * umbrella-widening P4 — the real member is the outer, the inner is synthetic).
   * False on the legacy-rebased path (`outerRef !== null`, rebase performed) AND
   * the born-synthetic-outer path (`outerRef === null`, an inner-only group): a
   * conversion is a distinct honest signal — an integration-time interpretation
   * of a real outer member — NOT the same thing as a PM-minted synthetic outer.
   * Consumed by group-integration.ts for the log line + PM audit row; never
   * mutates the DB `synthetic` flag.
   */
  outerConverted: boolean;
  /**
   * Normalization marker (campaign xrepo-gitlink-umbrella-widening P2/P4): true
   * when a REAL outer member (`outerRef !== null`) carried real source ALONGSIDE
   * the managed gitlink hunk, and the gitlink hunk was STRIPPED — its source-only
   * net patch was synthesized onto live outer main via `applyExcludingGitlink`
   * (the outer rebase skipped) and step 8 authored the gitlink to Ri. Fires on
   * BOTH the two-member arm (P2, structural) AND the lone-outer arm (P4,
   * ancestry-gated `normalize`). Mutually exclusive with `outerConverted` (that
   * is the pure-bump, no-source arm). False on the legacy-rebased path and the
   * born-synthetic-outer path. Like `outerConverted`, an integration-time
   * interpretation surfaced via a log line + durable audit row (P3) — NEVER
   * mutates the DB `synthetic` flag.
   */
  outerGitlinkNormalized: boolean;
  /**
   * Campaign 2026-08-30 §S2: the invariant gate's reading, taken before any arm
   * ran. REQUIRED, and narrowed so a `dangling` verdict is not CONSTRUCTIBLE on
   * a success — i.e. an assembly that never ran the gate, or ran it and saw a
   * verdict that forbids landing, cannot be reported as a success. `heals` is a
   * legal success: main was broken and this assembly repairs it.
   *
   * The honest ceiling: this does not make the gate unfakeable. A fabricated
   * `{ kind: "holds", target: "", ... }` still compiles. What it prevents is a
   * refactor quietly tidying the check into one arm — the same ceiling S3 wrote
   * down for GitlinkMismatchEvidence, and the correct one, because the
   * 2026-08-29 defect was a SHRUG, not a lie.
   */
  mainGitlink: Exclude<MainGitlinkVerdict, { kind: "dangling" }>;
  /** Release BOTH correlated worktree slots back to their pools. */
  release(): void;
}

/**
 * Evidence the §11 post-assembly assertion produces. Only a site that RAN the
 * assertion holds these values; a catch block holds neither.
 */
export type GitlinkMismatchEvidence =
  | { asserted: "committed_gitlink"; committed: string; expected: string }
  | { asserted: "worktree_populated"; gitlinkPath: string };

/**
 * Reasons a CHECK decided. Each names a measurement that was actually made.
 *
 * - `backpressure`: a correlated pool slot was unavailable (§5.1). Retry next
 *   integration; nothing was acquired-and-held.
 * - `inner_conflict` / `outer_conflict`: the inner/outer rebase conflicted.
 *   (`outer_conflict` is structurally unreachable when the outer member is
 *   synthetic — there is no outer ref to rebase; see AssembleGroupDeps.outerRef.)
 * - `gitlink_diverged` / `gitlink_unreachable`: a lone-outer group (campaign
 *   umbrella-widening P4) whose managed gitlink target is present-but-not-an-
 *   ancestor of the landing inner (`diverged`) or absent even after an all-refs
 *   fetch (`unreachable`) — DELIBERATE Tier-2 conservative rejects, never a land.
 * - `gitlink_mismatch`: the §11 post-assembly assertion failed (committed
 *   gitlink != Ri, or the working tree at gitlinkPath was not populated).
 *   EXCLUSIVELY that assertion, since 2026-08-30: the catch-all used to borrow
 *   this reason, which is how an unclassified throw came to be reported as a
 *   post-assembly measurement nobody had taken.
 * - `main_gitlink_dangling`: outer main's committed gitlink references an inner
 *   commit that is not reachable from inner main. DECLARED here by campaign
 *   2026-08-30 §S3 with its verdict and category; PRODUCED by §S2's gate. A
 *   union member with no producer is expected until then.
 */
export type DiagnosedAssemblyReason =
  | "backpressure"
  | "inner_conflict"
  | "outer_conflict"
  | "gitlink_diverged"
  | "gitlink_unreachable"
  | "gitlink_mismatch"
  | "main_gitlink_dangling";

/**
 * The one reason that means "no check decided". Design lock 4, as a type.
 *
 * - `assembly_error`: something threw mid-assembly and NO check decided. It
 *   names WHERE, never why. Constructible in exactly one place
 *   (`unclassifiedAssembly`).
 */
export type UnclassifiedAssemblyReason = "assembly_error";

interface AssemblyErrBase {
  ok: false;
  /** Extra detail for logging (conflicting files / mismatch detail / raw error). */
  detail?: string;
  /**
   * Campaign 2026-08-15 §R4: the inputs a resolver needs to REPRODUCE a
   * conflict — the base the failing rebase ran against, the ref that failed,
   * and the conflicting paths as structure rather than a joined string.
   *
   * Populated on the conflict arms only. Without these the reject is a dead
   * end: `materializeConflict(baseSha, ref)` cannot replay anything, and the
   * hook would have to re-derive a base from a worktree the failed assembly
   * has already released.
   *
   * Declared OPTIONAL ON THE BASE on purpose: the reject choke-point reads
   * `asm.conflict` on a union that still contains arms which never carry it,
   * and a bare property access requires the property on every constituent.
   * Moving it onto the conflict arms does not compile.
   */
  conflict?: {
    baseSha: string;
    ref: string;
    conflictingFiles: string[];
  };
  /**
   * Campaign 2026-08-30 §S2: the invariant gate's reading, when it RAN this
   * pass. Absent on `backpressure` (nothing leased), on `inner_conflict` (that
   * arm returns above the gate) and on `assembly_error` (the catch-all measured
   * nothing). Optional ON THE BASE for the same reason `conflict` is: the
   * observation site reads it off the union, and a bare property access
   * requires the property on every constituent.
   *
   * This is the OBSERVATION channel, distinct from the `evidence` an arm
   * carries to back its OWN claim. It exists so a pass that assembles fine — or
   * fails for an unrelated reason — can still report the lane's health and let
   * an open incident open or close itself.
   */
  mainGitlink?: MainGitlinkVerdict;
  /** Release whatever slots were taken (no-op when nothing was acquired). */
  release(): void;
}

/**
 * A reason is a CLAIM ABOUT FACTS. The two arms whose claim was contested on
 * 2026-08-29 now require the facts, so a site holding none cannot make the
 * claim by accident:
 *
 *  - `gitlink_mismatch` requires the assertion record (what was compared, to what).
 *  - `assembly_error` requires the thrown cause, and nothing else — because a
 *    catch block holds nothing else.
 *
 * What this DOES buy: a catch-all can no longer accidentally inherit a
 * diagnosis. What it does NOT buy: immunity. Fabricating
 * `{ committed: "", expected: "" }` still compiles. The point is that doing so
 * stops being a shrug and becomes a deliberate lie a reader can see — the
 * correct ceiling, because the 2026-08-29 defect WAS a shrug: git-ops threw,
 * the catch named the nearest specific reason, and five authors were told the
 * fault had been ruled out of their change.
 */
export type AssembledGroupErr =
  | (AssemblyErrBase & {
      reason: Exclude<DiagnosedAssemblyReason, "gitlink_mismatch" | "main_gitlink_dangling">;
    })
  | (AssemblyErrBase & { reason: "gitlink_mismatch"; evidence: GitlinkMismatchEvidence })
  // Campaign 2026-08-30 §S2, the same rule one arm further: this claim's facts
  // ARE the verdict — which gitlink, which target, which three commits (outer
  // main, inner main, landing inner), and whether the target exists at all. A
  // site holding none of that cannot make the claim.
  | (AssemblyErrBase & {
      reason: "main_gitlink_dangling";
      evidence: Extract<MainGitlinkVerdict, { kind: "dangling" }>;
    })
  | (AssemblyErrBase & { reason: UnclassifiedAssemblyReason; evidence: { cause: unknown } });

export type AssembledGroup = AssembledGroupOk | AssembledGroupErr;

// ─── Dependencies (injected — testable without index.ts) ──────────────

export interface AssembleGroupDeps {
  /**
   * Acquire one slot from the INNER per-repo pool. Sync, non-blocking; returns
   * null on exhaustion (the 7.2 pool `acquire()` contract). Typically
   * `() => innerPool.acquire()`.
   */
  acquireInner(): Worktree | null;
  /** Release an inner slot back to the inner pool. */
  releaseInner(wt: Worktree): void;
  /** Acquire one slot from the OUTER per-repo pool. */
  acquireOuter(): Worktree | null;
  /** Release an outer slot back to the outer pool. */
  releaseOuter(wt: Worktree): void;
  /** Build a GitOps bound to a worktree path (the batch.ts factory convention). */
  gitOps(worktreePath: string): GitOps;
  /**
   * Inner member ref to rebase: branch ?? commitSha. NULL ⇔ the inner member is
   * SYNTHETIC (an outer-only group, campaign umbrella-widening P4) — steps 1-3
   * degenerate to resetForAttempt + HEAD as both baseInnerSha AND Ri (no inner
   * ref, nothing to rebase ⇒ `inner_conflict` structurally unreachable and inner
   * main never advances at land). The outer arm then runs the ancestry-gated
   * `classifyOuterGitlinkDiff` against Ri = live inner main.
   */
  innerRef: string | null;
  /**
   * Outer member ref to rebase: branch ?? commitSha. NULL ⇔ the outer member
   * is SYNTHETIC (an inner-only group, campaign 2026-06-10) — steps 4-6
   * degenerate to resetForAttempt + HEAD as baseOuterSha (no outer ref, nothing
   * to rebase ⇒ `outer_conflict` structurally unreachable). Steps 7-9 then
   * synthesize the outer candidate as exactly one gitlink-bump commit on top of
   * live outer main.
   */
  outerRef: string | null;
  /** The inner linkedRepo's gitlink path within the outer tree (POSIX slashes). */
  gitlinkPath: string;
  /**
   * The git remote name (e.g. "origin"). Used to DWIM-resolve the outer
   * detection ref before `isPureGitlinkBump` — a bare branch name binds as
   * `<remote>/<branch>`, mirroring what `rebaseOnto`'s `git checkout <ref>`
   * performs, so detection sees the exact commit the rebase would.
   */
  gitRemote: string;
  /**
   * Campaign 2026-08-03 §P2: phase-timing spans (already scoped to the group).
   * OPTIONAL and coalesced ONCE at function entry — see GroupIntegrationDeps
   * for why a non-nullable local rather than `phases?.` at each call site.
   */
  phases?: PhaseSpans;
  /** Request ids so a per-role row names WHICH member's work it measured. */
  innerRequestId?: string;
  outerRequestId?: string;
}

/** Resolve the outer detection ref to a concrete present commit, mirroring what
 *  rebaseOnto's checkout performs, so isPureGitlinkBump sees the exact commit the
 *  rebase would. Returns null when neither form resolves ⇒ caller keeps the legacy
 *  rebase (fail-open). The `^{commit}` peel forces object presence (bare revparse of
 *  a 40-hex echoes it back unverified).
 *
 *  REMOTE-FIRST since 2026-08-22: this used to try the bare name first to mirror
 *  `git checkout <ref>`'s DWIM, which faithfully reproduced the stale-local-branch
 *  false-reject (see rebaseOnto). rebaseOnto now resolves `<remote>/<branch>` first
 *  and falls back to the bare name; the order here MUST match it, or detection reads
 *  a different commit than the one that gets rebased. A 40-hex commitSha is unchanged
 *  either way (it resolves on the first candidate and has no remote-tracking form). */
async function resolveDetectRef(
  gitOps: GitOps,
  ref: string,
  remote: string,
): Promise<string | null> {
  for (const cand of [`${remote}/${ref}^{commit}`, `${ref}^{commit}`]) {
    try {
      return await gitOps.resolveRef(cand);
    } catch {
      /* try next */
    }
  }
  return null;
}

// ─── The corrected §5.2 9-step assembly ──────────────────────────────

/**
 * Assemble a 2-repo group into a verifiable multi-repo working state, per the
 * CORRECTED design §5.2 (now including step 9 materializeSubmoduleWorktree).
 *
 * Sequence:
 *   §5.1  correlated lease: acquire inner THEN outer (fixed order, deadlock-free);
 *         release-on-partial-failure; either null -> backpressure.
 *   1-3   inner: resetForAttempt; baseInnerSha = HEAD; then
 *           - `innerRef` non-null (a REAL inner member): rebase inner -> Ri.
 *           - `innerRef` null (a SYNTHETIC inner member, outer-only group,
 *             campaign umbrella-widening P4): Ri = baseInnerSha (live inner main),
 *             no rebase — the inner is a no-op and inner main never advances.
 *   4-6   outer: resetForAttempt; baseOuterSha = HEAD; then
 *           - `outerRef` non-null (a REAL outer member): rebase outer -> Ro'.
 *           - `outerRef` null (a SYNTHETIC outer member, inner-only group):
 *             nothing to rebase — the worktree sits at live outer main and
 *             steps 7-9 synthesize the outer candidate directly on top of it,
 *             so `outer_conflict` is structurally unreachable (the stale-
 *             outer-bump failure class cannot occur: there is no pre-minted
 *             outer branch to go stale).
 *   7     outerGitOps.fetchFromPath(innerWt.path, Ri) — so step 9 can checkout Ri.
 *   8     outerGitOps.updateSubmoduleGitlink(gitlinkPath, Ri) -> Ro (commit gitlink;
 *         idempotent — gitlink already at Ri returns HEAD, no empty bump commit).
 *   9     outerGitOps.materializeSubmoduleWorktree(gitlinkPath, Ri) — populate disk.
 *   §11   post-assembly assertion: readSubmoduleGitlink === Ri AND the working
 *         tree at gitlinkPath is populated -> else gitlink_mismatch.
 *
 * ONE assembly function, no forked code path: the synthetic arm is the same
 * sequence with the single outer-rebase step conditional on `outerRef !== null`.
 * Does NOT verify (§5.3 / Step 10) and does NOT push (§6 / Step 11).
 *
 * This is the CLASSIFIER. Its return type deliberately EXCLUDES
 * `assembly_error`: every `return` in this body is a site that RAN something,
 * so none of them may name the reason that means "nothing was decided". A
 * `return { reason: "assembly_error" }` here is a compile error — the half of
 * design lock 4 a type CAN carry. The complementary half (a catch may name ONLY
 * that reason) is `unclassifiedAssembly`, below. Callers use `assembleGroup`.
 */
async function assembleGroupClassified(
  deps: AssembleGroupDeps,
): Promise<AssembledGroupOk | (AssembledGroupErr & { reason: DiagnosedAssemblyReason })> {
  const phases = deps.phases ?? NOOP_PHASE_SPANS;
  const innerSpan = { requestId: deps.innerRequestId };
  const outerSpan = { requestId: deps.outerRequestId };

  // ── §5.1 correlated lease (fixed inner-before-outer; release-on-partial) ──
  //
  // DELIBERATELY UNMEASURED (campaign 2026-08-03 §P2). `acquireInner`/
  // `acquireOuter` are the 7.2 pool contract: synchronous, non-blocking
  // `pool.acquire()` returns that either hand back a slot or null. There is no
  // wall clock here to report, so a "correlated lease" span would be a 0 ms row
  // in every trace — fabricated legibility, and the same reason the synthetic
  // inner verify emits nothing. If leasing ever learns to WAIT, measure it then.
  const innerWt = deps.acquireInner();
  if (innerWt === null) {
    // Nothing acquired — release is a no-op. KNOWN, ACCEPTED GAP: a backpressure
    // return emits no rows at all, so a pass that could not lease is invisible to
    // the phase store. Nothing ran, so nothing is mis-reported; the pool's own
    // exhaustion signal is the right place to see it.
    return { ok: false, reason: "backpressure", release: () => {} };
  }
  const outerWt = deps.acquireOuter();
  if (outerWt === null) {
    // Partial failure: release the inner slot we already took, then backpressure
    // (again emitting nothing — see above).
    deps.releaseInner(innerWt);
    return { ok: false, reason: "backpressure", release: () => {} };
  }

  // From here on BOTH slots are held; release() returns both to their pools.
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    deps.releaseInner(innerWt);
    deps.releaseOuter(outerWt);
  };

  try {
    const innerGitOps = deps.gitOps(innerWt.path);
    const outerGitOps = deps.gitOps(outerWt.path);

    // ── steps 1-3: inner reset, base, then rebase (REAL inner member only) ──
    await phases.time({ phase: "assemble", label: "inner:reset", ...innerSpan }, () =>
      innerWt.resetForAttempt(),
    );
    const baseInnerSha = await innerGitOps.resolveRef("HEAD"); // = Mi (live inner main)
    let Ri: string;
    if (deps.innerRef !== null) {
      const innerRef = deps.innerRef;
      const innerRebase = await phases.time(
        {
          phase: "rebase",
          label: "inner",
          ...innerSpan,
          detail: (r) => ({
            ok: r?.ok ?? false,
            conflicts: r && !r.ok ? r.conflictingFiles.length : 0,
          }),
        },
        () => innerGitOps.rebaseOnto(baseInnerSha, innerRef),
      );
      if (!innerRebase.ok) {
        return {
          ok: false,
          reason: "inner_conflict",
          detail: innerRebase.conflictingFiles.join(", "),
          // §R4: everything a resolver needs to replay this exact conflict in
          // an inner-repo worktree, captured before `release()` takes the
          // assembly's worktrees away.
          conflict: {
            baseSha: baseInnerSha,
            ref: innerRef,
            conflictingFiles: innerRebase.conflictingFiles,
          },
          release,
        };
      }
      // `Ri` is `innerRef` REBASED ONTO `baseInnerSha`, so baseInnerSha is always
      // an ancestor of it. The §S2 gate's short-circuit (a true HEALTH answer
      // skips the LANDING probe) depends on that; a squash, a cherry-pick-based
      // assembly, or a rebase onto anything but live inner main would break it
      // silently. Pinned by `group-main-gitlink-gate.test.ts` on all three arms.
      Ri = innerRebase.treeSha;
    } else {
      // SYNTHETIC inner (outer-only group, campaign umbrella-widening P4): the
      // inner is a NO-OP — Ri = live inner main. No rebase ⇒ inner HEAD never
      // moves ⇒ the inner land push is an up-to-date no-op (inner main never
      // advances). `inner_conflict` is structurally unreachable on this arm.
      //
      // NO `rebase/"inner"` row is emitted here (campaign 2026-08-03 §P2,
      // AMENDMENT A3): no rebase runs, and a 0 ms sample would drag the rebase
      // phase's p50 toward zero on every lone-outer group.
      Ri = baseInnerSha;
    }

    // ── steps 4-6: outer reset, base, then rebase (REAL outer member only) ──
    await phases.time({ phase: "assemble", label: "outer:reset", ...outerSpan }, () =>
      outerWt.resetForAttempt(),
    );
    const baseOuterSha = await outerGitOps.resolveRef("HEAD"); // = Mo (live outer main)

    // ── §S2 INVARIANT GATE (campaign 2026-08-30) ──
    // MUST stay HERE. `Ri` is computed above and the outer worktree was reset
    // immediately above, which is the only point where its HEAD is provably
    // live outer main (readSubmoduleGitlink is HEAD-bound by contract, so
    // `outerMainSha: baseOuterSha` below is a LABEL for a fact this line
    // already holds — no extra spawn, no new GitOps member). It must also stay
    // ABOVE the arm fork below: one call site covers the two-member,
    // lone-outer and inner-only arms, and step 8 — which rewrites the committed
    // gitlink to Ri on ALL THREE — is unreachable past a `dangling` verdict.
    //
    // NOT redundant with classifyOuterGitlinkDiff. That asks whether the
    // SUBMITTED outer branch's proposed bump is sane, on the lone-outer arm
    // only; this asks whether outer MAIN's committed gitlink is sane, on every
    // arm — including the inner-only arm, where no gitlink check existed at
    // all. Outer main dangling + a branch bumping to a good target is exactly
    // the case classify calls `pure_bump` and step 8 then drags the pointer
    // backward: only this gate catches it.
    //
    // Measured like outer:classify — git work that DECIDES an arm.
    const mainGitlink = await phases.time(
      {
        phase: "assemble",
        label: "outer:main-gitlink",
        ...outerSpan,
        detail: (v) => ({ kind: v?.kind ?? "error" }),
      },
      () =>
        checkMainGitlinkInvariant({
          outerGitOps,
          innerGitOps,
          gitlinkPath: deps.gitlinkPath,
          outerMainSha: baseOuterSha,
          innerMainSha: baseInnerSha, // HEALTH — a property of the LANE
          landingInnerSha: Ri, // LANDING — a property of THIS candidate
          gitRemote: deps.gitRemote,
        }),
    );
    if (mainGitlink.kind === "dangling") {
      // WHAT THIS BLOCKS, AND WHAT IT DELIBERATELY PERMITS.
      //
      // The harm is step 8: it authors the committed gitlink to `Ri` on all
      // three arms. So the question that decides the group is whether `Ri`
      // still contains the commit outer main currently names.
      //   - contained  → the pointer moves forward or stays. No harm, and if
      //                  main was dangling this group REPAIRS it. That is
      //                  `heals`: assembly proceeds, and the incident still
      //                  opens (group-integration.ts's observation site),
      //                  because main is broken right now.
      //   - not        → step 8 moves the pointer backward or sideways,
      //                  silently changing what consumers of outer main
      //                  compile. That is THE ORDERING TRAP, and the state the
      //                  client's owner refused on purpose. Reject.
      //
      // Why `Ri` and not `baseInnerSha` (live inner main), which was the first
      // design: `baseInnerSha` is the right predicate for "is main healthy" —
      // and it IS what the incident uses — but as a GATE it over-blocks.
      // `git rebase <base>` preserves the checked-out commits when `base` is an
      // ancestor of the ref AND the range is LINEAR (a merge commit in between
      // is flattened and every commit rewritten). So an inner-only group whose
      // branch fast-forwards inner main and ends at the target lands
      // `Ri == target`, step 8 rewrites nothing, and the lane is CURED. Gating
      // on health would reject that group — the one cure the train can take —
      // and leave the author nothing but an out-of-band push. Splitting the two
      // predicates costs one conditional `merge-base` call and nothing on the
      // happy path.
      //
      // Why REJECT rather than re-queue. The 2026-08-15 "a race is not a
      // verdict" rule re-queues drift and non_fast_forward because those are
      // LOST RACES the next pass wins by itself. This is not a race: nothing
      // about the next pass differs — same gitlink, same main, same `Ri`, same
      // answer — so a re-queue would burn the bounded 4 integration attempts
      // (MAX_GROUP_INTEGRATION_ATTEMPTS, group-land.ts) and then reject anyway
      // with a worse sentence, blaming the lane's THROUGHPUT for a broken
      // pointer.
      //
      // What is still refused on purpose: a lone-outer group that merely
      // REVERTS the gitlink would make main self-consistent, and is rejected
      // anyway. Step 8 authors the gitlink identically for every group, so the
      // gate cannot distinguish that deliberate revert from an accidental
      // regression — and it is the cure design lock 2 reserves for a human,
      // because it drops the inner work outer main already depends on. The
      // reject text says so and points at the outer-repo route.
      return {
        ok: false,
        reason: "main_gitlink_dangling",
        detail: describeDanglingMainGitlink(mainGitlink),
        // Two field names, one object, deliberately: `evidence` is the facts
        // backing THIS claim (S3's rule for the other diagnosed arms);
        // `mainGitlink` is the lane observation reported on every outcome.
        evidence: mainGitlink,
        mainGitlink,
        release,
      };
    }

    // Direction-C conversion (campaign xrepo-gitlink-bump-autoconvert): a REAL outer
    // member whose NET contribution over its fork point is EXACTLY the gitlink is
    // content-free ceremony — step 8 overwrites the gitlink to Ri regardless, so the
    // outer rebase is pointless AND is the only thing that can mint outer_conflict.
    // Recognize it and take the synthetic arm (skip the rebase; steps 7-9 synthesize
    // the outer candidate on live main — identical to the outerRef===null arm).
    let skipOuterRebase = false;
    let outerConverted = false;
    let outerGitlinkNormalized = false;
    const managedPaths = new Set([deps.gitlinkPath]);
    if (deps.outerRef !== null && deps.innerRef !== null) {
      // ── TWO-MEMBER arm (a REAL inner defines Ri): PURELY STRUCTURAL strip,
      //    no ancestry gate — the inner member DEFINES Ri, step 8 authors the
      //    landed gitlink to Ri, and the outer verify against Ri is the guard.
      //    BYTE-IDENTICAL to the P2 shipped path. ──
      // Split the outer member's NET diff into the managed gitlink hunk vs source
      // (fail-open null ⇒ keep the legacy rebase). Measured as its own span: the
      // classification is git READ work that DECIDES which arm runs, and charging
      // it to whichever arm it picked would misattribute it.
      const outerRef = deps.outerRef;
      const cls = await phases.time(
        {
          phase: "assemble",
          label: "outer:classify",
          ...outerSpan,
          detail: (c) => ({ arm: "two_member", kind: c?.kind ?? "error" }),
        },
        async (): Promise<{
          kind: "legacy" | "pure_bump" | "normalize";
          detectRef: string | null;
        }> => {
          const detectRef = await resolveDetectRef(outerGitOps, outerRef, deps.gitRemote);
          if (detectRef === null) return { kind: "legacy", detectRef: null };
          const split = await outerGitOps.splitGitlinkDiff(detectRef, baseOuterSha, managedPaths);
          if (split === null || split.gitlinkTargets.size === 0) {
            return { kind: "legacy", detectRef };
          }
          return {
            kind: split.sourcePaths.length === 0 ? "pure_bump" : "normalize",
            detectRef,
          };
        },
      );
      if (cls.kind === "pure_bump") {
        // Pure gitlink bump — the existing skip-rebase synthesize arm. NO
        // `rebase/"outer"` row (AMENDMENT A3): neither an apply nor a rebase
        // runs, and this is now the COMMON cross-repo path, so a 0 ms row here
        // would drag the rebase phase's p50 toward zero on most groups.
        skipOuterRebase = true;
        outerConverted = true;
      } else if (cls.kind === "normalize") {
        // Mixed source + managed gitlink: strip the gitlink hunk, synthesize
        // the source-only net patch onto live outer main. A SOURCE conflict
        // still rejects outer_conflict (byte-identity NOT claimed — a squashed
        // apply --3way can differ in conflict incidence from a per-commit
        // rebase); the gitlink hunk can never conflict (it's excluded).
        const detectRef = cls.detectRef as string;
        const applied = await phases.time(
          {
            phase: "rebase",
            label: "outer",
            ...outerSpan,
            // `via` names WHICH mechanism produced the outer candidate — the
            // squashed apply and the per-commit rebase have different costs and
            // different conflict incidence, so an aggregate that silently mixes
            // them is answering a question nobody asked.
            detail: (a) => ({
              via: "apply",
              ok: a?.ok ?? false,
              conflicts: a && !a.ok ? a.conflictingFiles.length : 0,
            }),
          },
          () => outerGitOps.applyExcludingGitlink(baseOuterSha, detectRef, managedPaths),
        );
        if (!applied.ok) {
          return {
            ok: false,
            reason: "outer_conflict",
            detail: applied.conflictingFiles.join(", "),
            mainGitlink,
            release,
          };
        }
        skipOuterRebase = true;
        outerGitlinkNormalized = true;
      }
    } else if (deps.outerRef !== null) {
      // ── LONE-OUTER arm (SYNTHETIC inner, campaign umbrella-widening P4): there
      //    is NO real inner to define Ri, so Ri = live inner main — the gitlink
      //    the outer bumps to MUST be an ancestor of it. The ANCESTRY-GATED
      //    classifier decides: ancestor→normalize/pure-bump+land; present-but-not-
      //    ancestor→gitlink_diverged; absent-after-all-refs-fetch→gitlink_
      //    unreachable. Both Tier-2 rejects are AssembledGroupErr → return BEFORE
      //    any push (safety invariant 5). ──
      const outerRef = deps.outerRef;
      // The same span as the two-member arm, distinguished by `arm`: the
      // ancestry classifier additionally fetches + probes the inner object
      // store, making it the most expensive of the three classifications and
      // the one most worth seeing separately.
      const classified = await phases.time(
        {
          phase: "assemble",
          label: "outer:classify",
          ...outerSpan,
          detail: (c) => ({ arm: "lone_outer", kind: c?.cls.kind ?? "error" }),
        },
        async (): Promise<{
          cls: OuterGitlinkClassification;
          detectRef: string | null;
        }> => {
          const ref = await resolveDetectRef(outerGitOps, outerRef, deps.gitRemote);
          if (ref === null) {
            return { cls: { kind: "legacy", reason: "detect ref unresolved" }, detectRef: null };
          }
          return {
            cls: await classifyOuterGitlinkDiff({
              outerGitOps,
              innerGitOps,
              outerRef: ref,
              baseOuterSha,
              innerLandingSha: Ri,
              managedGitlinkPaths: managedPaths,
              gitRemote: deps.gitRemote,
            }),
            detectRef: ref,
          };
        },
      );
      const detectRef = classified.detectRef;
      if (detectRef !== null) {
        const cls = classified.cls;
        if (cls.kind === "diverged") {
          return {
            ok: false,
            reason: "gitlink_diverged",
            detail: `managed gitlink ${cls.path} targets ${cls.target}, not an ancestor of the landing inner ${Ri}`,
            mainGitlink,
            release,
          };
        }
        if (cls.kind === "unreachable") {
          return {
            ok: false,
            reason: "gitlink_unreachable",
            detail: `managed gitlink ${cls.path} target ${cls.target} is unreachable (absent after an all-refs fetch)`,
            mainGitlink,
            release,
          };
        }
        if (cls.kind === "pure_bump") {
          // Pure gitlink bump to an ancestor of Ri — skip the rebase, synthesize
          // the outer candidate on live main (step 8 authors gitlink→Ri). No
          // `rebase/"outer"` row: nothing ran (AMENDMENT A3).
          skipOuterRebase = true;
          outerConverted = true;
        } else if (cls.kind === "normalize") {
          // Ancestor gitlink alongside real source — strip the gitlink hunk,
          // synthesize the source-only net patch onto live outer main. A SOURCE
          // conflict still rejects outer_conflict; the gitlink hunk is excluded.
          const applied = await phases.time(
            {
              phase: "rebase",
              label: "outer",
              ...outerSpan,
              detail: (a) => ({
                via: "apply",
                ok: a?.ok ?? false,
                conflicts: a && !a.ok ? a.conflictingFiles.length : 0,
              }),
            },
            () => outerGitOps.applyExcludingGitlink(baseOuterSha, detectRef, managedPaths),
          );
          if (!applied.ok) {
            return {
              ok: false,
              reason: "outer_conflict",
              detail: applied.conflictingFiles.join(", "),
              mainGitlink,
              release,
            };
          }
          skipOuterRebase = true;
          outerGitlinkNormalized = true;
        }
        // cls.kind === "legacy" ⇒ fail-open: fall through to the rebase below.
      }
    }
    if (deps.outerRef !== null && !skipOuterRebase) {
      const legacyOuterRef = deps.outerRef;
      const outerRebase = await phases.time(
        {
          phase: "rebase",
          label: "outer",
          ...outerSpan,
          detail: (r) => ({
            via: "rebase",
            ok: r?.ok ?? false,
            conflicts: r && !r.ok ? r.conflictingFiles.length : 0,
          }),
        },
        () => outerGitOps.rebaseOnto(baseOuterSha, legacyOuterRef),
      );
      if (!outerRebase.ok) {
        return {
          ok: false,
          reason: "outer_conflict",
          detail: outerRebase.conflictingFiles.join(", "),
          mainGitlink,
          release,
        };
      }
      // outerRebase.treeSha is Ro' — outer rebased, gitlink still at the OLD inner.
    }
    // SYNTHETIC outer (outerRef null) OR a converted pure-bump: no rebase — the
    // worktree sits at live outer main (= baseOuterSha) and step 8 mints the one
    // gitlink-bump commit on top of it. outer_conflict is structurally unreachable
    // on this arm.

    // ── step 7: copy Ri's objects into the outer clone (for step 9's checkout) ──
    // MATERIALIZE, split three ways because the three steps cost and fail
    // differently: the object copy is bulk transfer (inner LFS binaries live
    // here — the prime suspect for cross-repo wall clock), the gitlink is one
    // commit, and populating the worktree is disk I/O over the whole inner tree.
    await phases.time({ phase: "materialize", label: "objects", ...outerSpan }, () =>
      outerGitOps.fetchFromPath(innerWt.path, Ri),
    );

    // ── step 8: commit the gitlink at gitlinkPath -> Ri ──
    const Ro = await phases.time({ phase: "materialize", label: "gitlink", ...outerSpan }, () =>
      outerGitOps.updateSubmoduleGitlink(deps.gitlinkPath, Ri),
    );

    // ── step 9: materialize Ri's tree into the outer working tree on disk ──
    // Pass innerWt.path (the inner pool worktree, rebased to Ri) so materialize
    // is LFS-aware: inner LFS files land as real binaries (smudge skipped + real
    // binaries overlaid from the inner worktree) instead of the outer LFS smudge
    // 404'ing on the inner's LFS objects.
    await phases.time(
      {
        phase: "materialize",
        label: "worktree",
        ...outerSpan,
        detail: { gitlinkPath: deps.gitlinkPath },
      },
      () => outerGitOps.materializeSubmoduleWorktree(deps.gitlinkPath, Ri, innerWt.path),
    );

    // ── §11 post-assembly assertion ──
    // Both halves in ONE span: they answer a single question ("did the assembly
    // actually produce what it claims?") and neither half is separately
    // actionable. `assemble` here is residual assembly work — NOT a parent
    // wrapping the rebase/materialize spans. No parent span exists anywhere.
    const assertion = await phases.time(
      {
        phase: "assemble",
        label: "assert",
        ...outerSpan,
        detail: (a) => ({ gitlinkOk: a?.gitlinkOk ?? false, populated: a?.populated ?? false }),
      },
      async (): Promise<{ committedGitlink: string; gitlinkOk: boolean; populated: boolean }> => {
        const committed = await outerGitOps.readSubmoduleGitlink(deps.gitlinkPath);
        const gitlinkOk = committed === Ri;
        // Short-circuits exactly as the two sequential asserts did: on a gitlink
        // mismatch the population probe never ran, and must not start now.
        const populated = gitlinkOk
          ? await worktreePopulated(outerWt.path, deps.gitlinkPath)
          : false;
        return { committedGitlink: committed, gitlinkOk, populated };
      },
    );
    // (a) the COMMITTED gitlink references Ri.
    const committedGitlink = assertion.committedGitlink;
    if (committedGitlink !== Ri) {
      return {
        ok: false,
        reason: "gitlink_mismatch",
        detail: `committed gitlink ${committedGitlink} != Ri ${Ri}`,
        evidence: { asserted: "committed_gitlink", committed: committedGitlink, expected: Ri },
        mainGitlink,
        release,
      };
    }
    // (b) the WORKING TREE at gitlinkPath is populated (step 9 worked) — the
    // R1-critical proof the outer verify will see the inner sources.
    if (!assertion.populated) {
      return {
        ok: false,
        reason: "gitlink_mismatch",
        detail: `working tree at ${deps.gitlinkPath} is empty after materialize`,
        evidence: { asserted: "worktree_populated", gitlinkPath: deps.gitlinkPath },
        mainGitlink,
        release,
      };
    }

    return {
      ok: true,
      innerWt,
      outerWt,
      innerGitOps,
      outerGitOps,
      Ri,
      Ro,
      baseInnerSha,
      baseOuterSha,
      gitlinkPath: deps.gitlinkPath,
      outerConverted,
      outerGitlinkNormalized,
      mainGitlink,
      release,
    };
  } catch (err) {
    // RELEASE BEFORE RETHROW — load-bearing. The wrapper below cannot see
    // `release`, and a throw that escapes without releasing strands BOTH
    // correlated slots for the life of the process (the 2026-08-02 wedge,
    // deployment guide §14.15). `release` is idempotent, so the wrapper's
    // no-op release is safe. Assembly precedes any push, so nothing landed —
    // §11 fs-full row semantics: reject this pass rather than retry.
    release();
    throw err;
  }
}

/**
 * Assemble a cross-repo group. Thin by design: it owns the ONLY catch-all in
 * the assembly path, and the only failure that catch may construct is the one
 * that says nothing was classified.
 */
export async function assembleGroup(deps: AssembleGroupDeps): Promise<AssembledGroup> {
  try {
    return await assembleGroupClassified(deps);
  } catch (err) {
    // Design lock 4: a catch-all is never a diagnosis. This site established
    // NOTHING. Until 2026-08-30 it named `gitlink_mismatch` — a reason whose
    // own verdict asserts that a specific post-assembly assertion was measured
    // and failed — so every unclassified git failure reached its author as a
    // train fault that had already ruled their change out. The return type
    // below is what keeps that from happening by accident again: an accidental
    // inherited diagnosis is no longer constructible here, while a deliberate
    // one still is. A shrug becomes a deliberate lie a reader can see.
    return unclassifiedAssembly(err);
  }
}

/** The ONLY failure a catch may construct. Pinned to `assembly_error` by type. */
function unclassifiedAssembly(
  err: unknown,
): AssembledGroupErr & { reason: UnclassifiedAssemblyReason } {
  return {
    ok: false,
    reason: "assembly_error",
    detail: err instanceof Error ? err.message : String(err),
    evidence: { cause: err },
    // The classifier already released both slots before rethrowing.
    release: () => {},
  };
}

// ─── helpers ──────────────────────────────────────────────────────────

/**
 * True iff the outer working tree at `<outerWtPath>/<gitlinkPath>` physically
 * contains at least one file (step 9 materialized the inner sources). A bare or
 * absent directory => the materialize did not run / failed.
 */
async function worktreePopulated(outerWtPath: string, gitlinkPath: string): Promise<boolean> {
  const dir = path.join(outerWtPath, ...gitlinkPath.split("/"));
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}
