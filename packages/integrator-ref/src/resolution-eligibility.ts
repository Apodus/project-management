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
 * Three classes, per the campaign's tier taxonomy:
 *
 *  - **Mechanical** — the correct answer is well-defined and does not require
 *    changing anyone's intent. A conflict is the canonical case: two edits, one
 *    file, a reconciliation. This is the grunt work the resolver exists to
 *    absorb, and it is where widening pays.
 *  - **Unfixable-by-anyone-but-the-author** — the inputs the resolver would
 *    need do not exist. `gitlink_unreachable` is the sharp example: the inner
 *    commit was never pushed, so the objects are not in any clone the daemon
 *    can reach. No agent can materialize them. A resolver session here burns
 *    budget to rediscover "you did not push", and converts a clear, immediately
 *    actionable answer into a slow confusing one.
 *  - **Our bug** — `gitlink_mismatch` is a post-assembly assertion failure: the
 *    train built something inconsistent. Handing that to a resolver destroys
 *    the evidence and hides a defect that should be loud.
 *
 * NOT decided here (deliberately): whether the resolver can EXECUTE an eligible
 * job. Eligibility is about whether it *should* be tried; capability is the
 * caller's problem. Keeping them apart is what lets the taxonomy ship and be
 * tested before the cross-repo executor exists.
 */

import type { AssembledGroupErr } from "./group-assembly.js";

/** The closed set of assembly outcomes, mirroring `AssembledGroupErr.reason`. */
export type GroupAssemblyReason =
  | "backpressure"
  | "inner_conflict"
  | "outer_conflict"
  | "gitlink_diverged"
  | "gitlink_unreachable"
  | "gitlink_mismatch";

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

export type EligibilityClass =
  /** Worth a resolver: the answer is mechanical and the inputs all exist. */
  | "mechanical"
  /** Not a failure at all — the group retries next pass. */
  | "not_a_failure"
  /** Only the author can fix it; a resolver would burn budget to say so. */
  | "author_only"
  /** A train defect. Resolving it would paper over the evidence. */
  | "train_bug";

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

    case "gitlink_mismatch":
      return {
        eligible: false,
        class: "train_bug",
        why: "the post-assembly assertion failed (committed gitlink != the landing inner, or the gitlink path was left unpopulated). That is a defect in the train, not in the change — a resolver session would paper over the evidence",
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
