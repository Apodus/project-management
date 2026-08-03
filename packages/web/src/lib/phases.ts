import type { PhaseStat } from "./api";

// ═══════════════════════════════════════════════════════════════════
// The train phase taxonomy, web-side (campaign 2026-08-03 §P4).
//
// One place where a phase gets a name, a hue and a meaning. §P5's event trace
// reads the same maps, so a phase can never be "Queue wait" cyan in the panel
// and "queue_wait" green in the feed.
//
// PHASE_ORDER IS FOR ORDERING, COLOUR KEYING AND COMPUTING THE ABSENCE LIST —
// NEVER FOR PRESENCE. The server OMITS a phase with no samples (absent ≠ zero,
// enforced by the aggregation's types), so iterating PHASE_ORDER to look up
// stats would resurrect the `?? 0` bug the payload shape exists to prevent:
// rows come from the payload, and PHASE_ORDER only says what the payload did
// NOT contain.
// ═══════════════════════════════════════════════════════════════════

/**
 * The phase vocabulary, taken FROM the generated payload type rather than
 * re-declared — a phase added to the server enum widens this union and breaks
 * the `Record<PhaseName, …>` maps below until someone picks a label and a hue.
 */
export type PhaseName = PhaseStat["phase"];

/**
 * Sentence case, not Title Case: these are prose fragments ("Queue wait 40%",
 * "78% of Verify"), so `formatStatus` — which capitalizes every word — is the
 * wrong tool and deliberately not reused here.
 */
export const PHASE_LABEL: Record<PhaseName, string> = {
  forming: "Forming",
  queue_wait: "Queue wait",
  assemble: "Assemble",
  materialize: "Materialize",
  rebase: "Rebase",
  verify: "Verify",
  land: "Land",
};

/**
 * Pipeline order — forming → queue_wait → assemble → materialize → rebase →
 * verify → land, matching the server's MERGE_PHASES contract.
 *
 * Derived from PHASE_LABEL's key order rather than re-listed, so order and
 * exhaustiveness live in ONE place: PHASE_LABEL is a `Record<PhaseName, …>`
 * (every phase must appear) and JS preserves string-key insertion order (so
 * declaring it in pipeline order IS the pipeline order). Reordering PHASE_LABEL
 * reorders the pipeline — keep it in pipeline order.
 */
export const PHASE_ORDER: readonly PhaseName[] = Object.keys(PHASE_LABEL) as PhaseName[];

/**
 * The categorical hue per phase — validated as a set (distinguishable in light
 * and dark, adjacent pairs separated under the common CVD simulations).
 *
 * Class strings are LITERAL, never interpolated: Tailwind v4 discovers classes
 * by scanning source text, so a computed `bg-${hue}-500` is simply not
 * generated and the segment renders transparent.
 */
export const PHASE_BAR_COLOR: Record<PhaseName, string> = {
  forming: "bg-violet-500",
  queue_wait: "bg-cyan-500 dark:bg-cyan-600",
  assemble: "bg-indigo-500",
  materialize: "bg-lime-600",
  rebase: "bg-pink-500",
  verify: "bg-blue-500",
  land: "bg-green-500 dark:bg-green-600",
};

/**
 * What each phase actually covers — the answer to "is `assemble` the clone or
 * the rebase?", which nobody can infer from a seven-letter bar label.
 *
 * `forming` and `queue_wait` say they are DERIVED because that is operationally
 * load-bearing: they exist even on a lane whose integrator predates the phase
 * instrumentation, so seeing only those two means "daemon not emitting yet",
 * not "the train did nothing".
 */
export const PHASE_MEANING: Record<PhaseName, string> = {
  forming: "Group created → the train picked up its first member. Derived by PM from timestamps.",
  queue_wait:
    "Submitted (or re-queued) → picked up by the integrator. Derived by PM from timestamps.",
  assemble: "Preparing the candidate: worktree reset, repo binding, speculative base, outer patch.",
  materialize: "Making the candidate real on disk: LFS objects and submodule/gitlink checkout.",
  rebase: "Replaying the request's commits onto live main.",
  verify: "Running the project's verify command against the candidate tree.",
  land: "Fetching main and fast-forwarding it — twice for a cross-repo group.",
};
