import { readdir } from "node:fs/promises";
import path from "node:path";
import { classifyOuterGitlinkDiff, type GitOps } from "./git-ops.js";
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
   * - `gitlink_diverged` / `gitlink_unreachable`: a lone-outer group (campaign
   *   umbrella-widening P4) whose managed gitlink target is present-but-not-an-
   *   ancestor of the landing inner (`diverged`) or absent even after an all-refs
   *   fetch (`unreachable`) — DELIBERATE Tier-2 conservative rejects, never a land.
   * - `gitlink_mismatch`: the §11 post-assembly assertion failed (committed
   *   gitlink != Ri, or the working tree at gitlinkPath was not populated).
   */
  reason:
    | "backpressure"
    | "inner_conflict"
    | "outer_conflict"
    | "gitlink_diverged"
    | "gitlink_unreachable"
    | "gitlink_mismatch";
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
}

/** Resolve the outer detection ref to a concrete present commit, mirroring the DWIM
 *  that rebaseOnto's `git checkout <ref>` performs (bare branch → <remote>/<branch>),
 *  so isPureGitlinkBump sees the exact commit the rebase would. Returns null when
 *  neither form resolves ⇒ caller keeps the legacy rebase (fail-open). The `^{commit}`
 *  peel forces object presence (bare revparse of a 40-hex echoes it back unverified). */
async function resolveDetectRef(
  gitOps: GitOps,
  ref: string,
  remote: string,
): Promise<string | null> {
  for (const cand of [`${ref}^{commit}`, `${remote}/${ref}^{commit}`]) {
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

    // ── steps 1-3: inner reset, base, then rebase (REAL inner member only) ──
    await innerWt.resetForAttempt();
    const baseInnerSha = await innerGitOps.resolveRef("HEAD"); // = Mi (live inner main)
    let Ri: string;
    if (deps.innerRef !== null) {
      const innerRebase = await innerGitOps.rebaseOnto(baseInnerSha, deps.innerRef);
      if (!innerRebase.ok) {
        return {
          ok: false,
          reason: "inner_conflict",
          detail: innerRebase.conflictingFiles.join(", "),
          release,
        };
      }
      Ri = innerRebase.treeSha;
    } else {
      // SYNTHETIC inner (outer-only group, campaign umbrella-widening P4): the
      // inner is a NO-OP — Ri = live inner main. No rebase ⇒ inner HEAD never
      // moves ⇒ the inner land push is an up-to-date no-op (inner main never
      // advances). `inner_conflict` is structurally unreachable on this arm.
      Ri = baseInnerSha;
    }

    // ── steps 4-6: outer reset, base, then rebase (REAL outer member only) ──
    await outerWt.resetForAttempt();
    const baseOuterSha = await outerGitOps.resolveRef("HEAD"); // = Mo (live outer main)

    // Direction-C conversion (campaign xrepo-gitlink-bump-autoconvert): a REAL outer
    // member whose NET contribution over its fork point is EXACTLY the gitlink is
    // content-free ceremony — step 8 overwrites the gitlink to Ri regardless, so the
    // outer rebase is pointless AND is the only thing that can mint outer_conflict.
    // Recognize it and take the synthetic arm (skip the rebase; steps 7-9 synthesize
    // the outer candidate on live main — identical to the outerRef===null arm).
    let skipOuterRebase = false;
    let outerConverted = false;
    let outerGitlinkNormalized = false;
    if (deps.outerRef !== null && deps.innerRef !== null) {
      // ── TWO-MEMBER arm (a REAL inner defines Ri): PURELY STRUCTURAL strip,
      //    no ancestry gate — the inner member DEFINES Ri, step 8 authors the
      //    landed gitlink to Ri, and the outer verify against Ri is the guard.
      //    BYTE-IDENTICAL to the P2 shipped path. ──
      // Split the outer member's NET diff into the managed gitlink hunk vs source
      // (fail-open null ⇒ keep the legacy rebase).
      const detectRef = await resolveDetectRef(outerGitOps, deps.outerRef, deps.gitRemote);
      if (detectRef !== null) {
        const managedPaths = new Set([deps.gitlinkPath]);
        const split = await outerGitOps.splitGitlinkDiff(detectRef, baseOuterSha, managedPaths);
        if (split !== null && split.gitlinkTargets.size > 0) {
          if (split.sourcePaths.length === 0) {
            // Pure gitlink bump — the existing skip-rebase synthesize arm.
            skipOuterRebase = true;
            outerConverted = true;
          } else {
            // Mixed source + managed gitlink: strip the gitlink hunk, synthesize
            // the source-only net patch onto live outer main. A SOURCE conflict
            // still rejects outer_conflict (byte-identity NOT claimed — a squashed
            // apply --3way can differ in conflict incidence from a per-commit
            // rebase); the gitlink hunk can never conflict (it's excluded).
            const applied = await outerGitOps.applyExcludingGitlink(
              baseOuterSha,
              detectRef,
              managedPaths,
            );
            if (!applied.ok) {
              return {
                ok: false,
                reason: "outer_conflict",
                detail: applied.conflictingFiles.join(", "),
                release,
              };
            }
            skipOuterRebase = true;
            outerGitlinkNormalized = true;
          }
        }
      }
    } else if (deps.outerRef !== null) {
      // ── LONE-OUTER arm (SYNTHETIC inner, campaign umbrella-widening P4): there
      //    is NO real inner to define Ri, so Ri = live inner main — the gitlink
      //    the outer bumps to MUST be an ancestor of it. The ANCESTRY-GATED
      //    classifier decides: ancestor→normalize/pure-bump+land; present-but-not-
      //    ancestor→gitlink_diverged; absent-after-all-refs-fetch→gitlink_
      //    unreachable. Both Tier-2 rejects are AssembledGroupErr → return BEFORE
      //    any push (safety invariant 5). ──
      const detectRef = await resolveDetectRef(outerGitOps, deps.outerRef, deps.gitRemote);
      if (detectRef !== null) {
        const managedPaths = new Set([deps.gitlinkPath]);
        const cls = await classifyOuterGitlinkDiff({
          outerGitOps,
          innerGitOps,
          outerRef: detectRef,
          baseOuterSha,
          innerLandingSha: Ri,
          managedGitlinkPaths: managedPaths,
          gitRemote: deps.gitRemote,
        });
        if (cls.kind === "diverged") {
          return {
            ok: false,
            reason: "gitlink_diverged",
            detail: `managed gitlink ${cls.path} targets ${cls.target}, not an ancestor of the landing inner ${Ri}`,
            release,
          };
        }
        if (cls.kind === "unreachable") {
          return {
            ok: false,
            reason: "gitlink_unreachable",
            detail: `managed gitlink ${cls.path} target ${cls.target} is unreachable (absent after an all-refs fetch)`,
            release,
          };
        }
        if (cls.kind === "pure_bump") {
          // Pure gitlink bump to an ancestor of Ri — skip the rebase, synthesize
          // the outer candidate on live main (step 8 authors gitlink→Ri).
          skipOuterRebase = true;
          outerConverted = true;
        } else if (cls.kind === "normalize") {
          // Ancestor gitlink alongside real source — strip the gitlink hunk,
          // synthesize the source-only net patch onto live outer main. A SOURCE
          // conflict still rejects outer_conflict; the gitlink hunk is excluded.
          const applied = await outerGitOps.applyExcludingGitlink(
            baseOuterSha,
            detectRef,
            managedPaths,
          );
          if (!applied.ok) {
            return {
              ok: false,
              reason: "outer_conflict",
              detail: applied.conflictingFiles.join(", "),
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
    // SYNTHETIC outer (outerRef null) OR a converted pure-bump: no rebase — the
    // worktree sits at live outer main (= baseOuterSha) and step 8 mints the one
    // gitlink-bump commit on top of it. outer_conflict is structurally unreachable
    // on this arm.

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
      outerConverted,
      outerGitlinkNormalized,
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
