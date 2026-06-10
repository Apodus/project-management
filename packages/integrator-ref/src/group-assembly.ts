import { readdir } from "node:fs/promises";
import path from "node:path";
import type { GitOps } from "./git-ops.js";
import type { Worktree } from "./worktree.js";

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
  /** Release BOTH correlated worktree slots back to their pools. */
  release(): void;
}

export interface AssembledGroupErr {
  ok: false;
  /**
   * - `backpressure`: a correlated pool slot was unavailable (§5.1). Retry next
   *   integration; nothing was acquired-and-held.
   * - `inner_conflict` / `outer_conflict`: the inner/outer rebase conflicted.
   *   (`outer_conflict` is structurally unreachable when the outer member is
   *   synthetic — there is no outer ref to rebase; see AssembleGroupDeps.outerRef.)
   * - `gitlink_mismatch`: the §11 post-assembly assertion failed (committed
   *   gitlink != Ri, or the working tree at gitlinkPath was not populated).
   */
  reason: "backpressure" | "inner_conflict" | "outer_conflict" | "gitlink_mismatch";
  /** Extra detail for logging (conflicting files / mismatch detail). */
  detail?: string;
  /** Release whatever slots were taken (no-op when nothing was acquired). */
  release(): void;
}

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
  /** Inner member ref to rebase: branch ?? commitSha. */
  innerRef: string;
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
}

// ─── The corrected §5.2 9-step assembly ──────────────────────────────

/**
 * Assemble a 2-repo group into a verifiable multi-repo working state, per the
 * CORRECTED design §5.2 (now including step 9 materializeSubmoduleWorktree).
 *
 * Sequence:
 *   §5.1  correlated lease: acquire inner THEN outer (fixed order, deadlock-free);
 *         release-on-partial-failure; either null -> backpressure.
 *   1-3   inner: resetForAttempt; baseInnerSha = HEAD; rebase inner -> Ri.
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
 */
export async function assembleGroup(deps: AssembleGroupDeps): Promise<AssembledGroup> {
  // ── §5.1 correlated lease (fixed inner-before-outer; release-on-partial) ──
  const innerWt = deps.acquireInner();
  if (innerWt === null) {
    // Nothing acquired — release is a no-op.
    return { ok: false, reason: "backpressure", release: () => {} };
  }
  const outerWt = deps.acquireOuter();
  if (outerWt === null) {
    // Partial failure: release the inner slot we already took, then backpressure.
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

    // ── steps 1-3: inner reset, base, rebase ──
    await innerWt.resetForAttempt();
    const baseInnerSha = await innerGitOps.resolveRef("HEAD"); // = Mi
    const innerRebase = await innerGitOps.rebaseOnto(baseInnerSha, deps.innerRef);
    if (!innerRebase.ok) {
      return {
        ok: false,
        reason: "inner_conflict",
        detail: innerRebase.conflictingFiles.join(", "),
        release,
      };
    }
    const Ri = innerRebase.treeSha;

    // ── steps 4-6: outer reset, base, then rebase (REAL outer member only) ──
    await outerWt.resetForAttempt();
    const baseOuterSha = await outerGitOps.resolveRef("HEAD"); // = Mo
    if (deps.outerRef !== null) {
      const outerRebase = await outerGitOps.rebaseOnto(baseOuterSha, deps.outerRef);
      if (!outerRebase.ok) {
        return {
          ok: false,
          reason: "outer_conflict",
          detail: outerRebase.conflictingFiles.join(", "),
          release,
        };
      }
      // outerRebase.treeSha is Ro' — outer rebased, gitlink still at the OLD inner.
    }
    // SYNTHETIC outer (outerRef null): no rebase — the worktree sits at live
    // outer main (= baseOuterSha) and step 8 mints the one gitlink-bump commit
    // on top of it. outer_conflict is structurally unreachable on this arm.

    // ── step 7: copy Ri's objects into the outer clone (for step 9's checkout) ──
    await outerGitOps.fetchFromPath(innerWt.path, Ri);

    // ── step 8: commit the gitlink at gitlinkPath -> Ri ──
    const Ro = await outerGitOps.updateSubmoduleGitlink(deps.gitlinkPath, Ri);

    // ── step 9: materialize Ri's tree into the outer working tree on disk ──
    // Pass innerWt.path (the inner pool worktree, rebased to Ri) so materialize
    // is LFS-aware: inner LFS files land as real binaries (smudge skipped + real
    // binaries overlaid from the inner worktree) instead of the outer LFS smudge
    // 404'ing on the inner's LFS objects.
    await outerGitOps.materializeSubmoduleWorktree(deps.gitlinkPath, Ri, innerWt.path);

    // ── §11 post-assembly assertion ──
    // (a) the COMMITTED gitlink references Ri.
    const committedGitlink = await outerGitOps.readSubmoduleGitlink(deps.gitlinkPath);
    if (committedGitlink !== Ri) {
      return {
        ok: false,
        reason: "gitlink_mismatch",
        detail: `committed gitlink ${committedGitlink} != Ri ${Ri}`,
        release,
      };
    }
    // (b) the WORKING TREE at gitlinkPath is populated (step 9 worked) — the
    // R1-critical proof the outer verify will see the inner sources.
    if (!(await worktreePopulated(outerWt.path, deps.gitlinkPath))) {
      return {
        ok: false,
        reason: "gitlink_mismatch",
        detail: `working tree at ${deps.gitlinkPath} is empty after materialize`,
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
      release,
    };
  } catch (err) {
    // Any unexpected git failure mid-assembly: release the slots and surface as
    // a mismatch (assembly precedes any push, so nothing landed — §11 fs-full
    // row semantics: reject this pass). Re-rethrow would strand the slots.
    release();
    return {
      ok: false,
      reason: "gitlink_mismatch",
      detail: err instanceof Error ? err.message : String(err),
      release: () => {},
    };
  }
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
