/**
 * Campaign 2026-08-15 §S4 — is THIS failure worth handing to a resolver?
 *
 * The resolver's trigger has been one thing since Phase 7.6: a textual rebase
 * conflict in the single-repo path (`batch.ts` / `loop.ts`, both inside
 * `failure.kind === "conflict"`). Widening it is the point of this campaign,
 * and the widening needs a place where the JUDGEMENT lives — separate from the
 * plumbing, so it can be read, argued with, and tested without a git fixture.
 *
 * The rule this file encodes: **eligibility is a decision, never a default.**
 * Every reason is explicitly eligible or explicitly not, each with a stated
 * why. A reason added later gets a compile error rather than silently
 * inheriting an answer — which is the whole reason this is an exhaustive switch
 * over a closed union instead of a lookup table with a fallback.
 *
 * Six classes, one line each:
 *
 *  - `mechanical` — the correct answer is well-defined and does not require
 *    changing anyone's intent. A conflict is the canonical case: two edits, one
 *    file, a reconciliation. This is the grunt work the resolver exists to
 *    absorb, and it is where widening pays.
 *  - `not_a_failure` — nothing broke; the group simply retries next pass.
 *  - `author_only` — the inputs the resolver would need do not exist.
 *    `gitlink_unreachable` is the sharp example: the inner commit was never
 *    pushed, so the objects are not in any clone the daemon can reach. No agent
 *    can materialize them. A resolver session here burns budget to rediscover
 *    "you did not push", and converts a clear, immediately actionable answer
 *    into a slow confusing one.
 *  - `lane_blocked` — the fault is in the shared state of the LANE, measured.
 *    Nobody who can resubmit can clear it; a human with authority over main
 *    chooses the cure.
 *  - `train_bug` — `gitlink_mismatch` is a post-assembly assertion failure:
 *    the train built something inconsistent. Handing that to a resolver
 *    destroys the evidence and hides a defect that should be loud.
 *  - `unknown` — no check decided. Campaign 2026-08-30 design lock 4: an
 *    unclassified error gets a class that SAYS unclassified, and nothing
 *    decided is ever filed under `unknown` — the moment it holds a finding it
 *    stops meaning unknown and the next reader learns nothing from it.
 *
 * Design lock 3 lives here too: a `why` states what was observed and what to
 * check. It may name a probable cause; it may not pre-emptively rule one out.
 * The types make a shrug VISIBLE, not impossible — a verdict can still be
 * written dishonestly, it just cannot happen by inheritance any more.
 *
 * NOT decided here (deliberately): whether the resolver can EXECUTE an eligible
 * job. Eligibility is about whether it *should* be tried; capability is the
 * caller's problem. Keeping them apart is what lets the taxonomy ship and be
 * tested before the cross-repo executor exists.
 */

import type { AssembledGroupErr, UnclassifiedAssemblyReason } from "./group-assembly.js";

/** The closed set of assembly outcomes, mirroring `AssembledGroupErr.reason`. */
export type GroupAssemblyReason =
  | "backpressure"
  | "inner_conflict"
  | "outer_conflict"
  | "gitlink_diverged"
  | "gitlink_unreachable"
  | "gitlink_mismatch"
  | "main_gitlink_dangling"
  | "assembly_error";

/**
 * The mirror's unclassified half, pinned separately: a future reason that is
 * really a shrug must be declared as one here, or the `unknown`-purity test
 * stops meaning anything.
 */
export type UnclassifiedGroupAssemblyReason = "assembly_error";

/**
 * The mirror is PINNED, both directions. Re-declaring the union here (rather
 * than aliasing it) is what lets this module be read as a standalone statement
 * of policy — but a re-declaration that can drift from its source is a liability,
 * and drift in either direction is the specific way design lock 5 would fail
 * silently: a new assembly reason that never gets a decision, or a decision for
 * a reason that no longer exists. Both are compile errors here.
 */
type AssertMutuallyAssignable<A extends B, B extends C, C = A> = true;
// The DECLARATION is the test: instantiating it is what type-checks the mirror,
// so it is "unused" by construction and must not be deleted to please a linter.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssemblyReasonMirrorIsExact = AssertMutuallyAssignable<
  AssembledGroupErr["reason"],
  GroupAssemblyReason
>;
// The same pin for the unclassified HALF — see UnclassifiedGroupAssemblyReason.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _UnclassifiedMirrorIsExact = AssertMutuallyAssignable<
  UnclassifiedAssemblyReason,
  UnclassifiedGroupAssemblyReason
>;

export type EligibilityClass =
  /** Worth a resolver: the answer is mechanical and the inputs all exist. */
  | "mechanical"
  /** Not a failure at all — the group retries next pass. */
  | "not_a_failure"
  /** Only the author can fix it; a resolver would burn budget to say so. */
  | "author_only"
  /**
   * The fault is in the LANE's shared state (main) rather than in the submitted
   * change or the train's own code. Nobody who can resubmit can clear it; a
   * human with authority over main must choose a cure. This is the ONLY class
   * licensed to say where the fault is NOT — because it is the only class that
   * has measured it.
   */
  | "lane_blocked"
  /** A train defect. Resolving it would paper over the evidence. */
  | "train_bug"
  /**
   * No check decided. NOT a diagnosis — the class exists so an unclassified
   * failure never has to borrow a diagnosed reason's answer (campaign
   * 2026-08-30 design lock 4). Nothing decided may ever be filed here; a test
   * pins that.
   */
  | "unknown";

export interface EligibilityVerdict {
  eligible: boolean;
  class: EligibilityClass;
  /**
   * Why — written for the operator reading a log line or a deployment guide,
   * not for the compiler. On an INELIGIBLE reason this doubles as the sentence
   * that belongs in the reject, so the author is told what to do instead.
   */
  why: string;
  /**
   * Which repo a resolver would have to work in, when that is knowable. The
   * cross-repo executor needs it; `null` when no resolution applies.
   */
  repo: "inner" | "outer" | null;
}

/**
 * Should a group whose assembly failed for `reason` be handed to a resolver?
 *
 * Exhaustive by construction: the `never` check at the bottom fails to compile
 * if `GroupAssemblyReason` gains a member without a decision here.
 */
export function assemblyResolutionEligibility(reason: GroupAssemblyReason): EligibilityVerdict {
  switch (reason) {
    case "inner_conflict":
      return {
        eligible: true,
        class: "mechanical",
        why: "a textual rebase conflict in the inner repo — two edits to one file, which is exactly the reconciliation a resolver session is for",
        repo: "inner",
      };

    case "outer_conflict":
      return {
        eligible: true,
        class: "mechanical",
        why: "a textual rebase conflict in the outer repo. Note this is only reachable when the outer member carries REAL content: a synthetic outer (inner-only group) has no outer ref to rebase, and a pure gitlink bump is auto-converted at assembly",
        repo: "outer",
      };

    case "gitlink_diverged":
      return {
        eligible: true,
        class: "mechanical",
        why: "the managed gitlink target is present but not an ancestor of the landing inner — a stale bump branch, which a resolver with both repos can rebase onto the landing inner",
        repo: "outer",
      };

    case "gitlink_unreachable":
      return {
        eligible: false,
        class: "author_only",
        why: "the gitlink target is absent even after an all-refs fetch: the inner commit was never pushed, so its objects exist in no clone the daemon can reach. No agent can materialize them — push the inner branch and resubmit",
        repo: null,
      };

    // The exonerating half of this sentence was removed on 2026-08-30 (design
    // lock 3): it ruled a cause out before anyone had looked, and it was bolted
    // to the reason that was ALSO the dumping ground for every unclassified
    // error, so five authors were handed a measurement nobody had taken. The
    // class is still `train_bug` — the taxonomy may hold that judgement — but
    // the author-facing string states the assertion and the failure and stops.
    case "gitlink_mismatch":
      return {
        eligible: false,
        class: "train_bug",
        why:
          "the post-assembly assertion failed: after assembly, the committed gitlink did " +
          "not equal the landing inner commit, or the gitlink path was left unpopulated. " +
          "Assembly authors both, so the tree it produced does not match what it claims — " +
          "this reject names which half failed. A resolver session would rewrite that tree " +
          "and destroy the record of how it came to be wrong",
        repo: null,
      };

    // `lane_blocked`, not `unknown`: the gate DECIDED — it measured "present,
    // not an ancestor". Filing a decided finding under a class named "we do not
    // know" is design lock 4 run backwards, and it corrupts the one class whose
    // entire value is purity. It is equally not `author_only` (the author
    // cannot fix main), not `train_bug` (the train cannot create this state),
    // not `mechanical` (design lock 2 forbids the train picking a cure), and
    // not `not_a_failure` (it is a hard gate). None of the five other classes
    // can hold it.
    case "main_gitlink_dangling":
      return {
        eligible: false,
        class: "lane_blocked",
        why:
          "the lane's shared state is broken, not this change: outer main's committed " +
          "gitlink references an inner commit that is not reachable from inner main. That " +
          "was measured, not inferred. Neither a resubmission by the author nor a resolver " +
          "session can clear it — every cure moves one of the two mains and changes what " +
          "consumers of outer main compile, so the train detects and refuses rather than " +
          "picking one",
        repo: null,
      };

    // The catch-all's reason. It names WHERE, never why, so its `why` hands the
    // reader the raw error FIRST (the only evidence that exists) and then names
    // checks to RUN. It must not imply a cause: an unclassified throw is not
    // evidence of any particular broken invariant.
    case "assembly_error":
      return {
        eligible: false,
        class: "unknown",
        why:
          "an unexpected git failure during assembly. NOTHING was classified — this is " +
          "what the train says when no check decided, so read it as a lead, not a " +
          "finding. Start with the raw git error in this reject's detail; it is the only " +
          "evidence there is. If that does not settle it, check the lane's own state " +
          "before assuming a train defect: `git -C <outer> ls-tree HEAD <gitlink path>` " +
          "for the committed gitlink target, then `git -C <inner> merge-base " +
          "--is-ancestor <target> origin/main`. No resolver is opened — an unclassified " +
          "throw leaves one nothing to replay",
        repo: null,
      };

    case "backpressure":
      return {
        eligible: false,
        class: "not_a_failure",
        why: "a correlated pool slot was unavailable; nothing was acquired and the group simply retries on the next pass",
        repo: null,
      };

    default: {
      // Exhaustiveness guard: a new reason must make a DECISION here, not
      // inherit one. This is the compile error that enforces design lock 5.
      const unreachable: never = reason;
      return unreachable;
    }
  }
}
