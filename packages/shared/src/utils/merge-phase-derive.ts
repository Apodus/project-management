// The two DERIVED train phases (campaign 2026-08-03 §P1), computed from
// timestamps PM already owns. Pure and TOTAL: no DB, no clock, no Zod at
// runtime (the DerivedPhaseEntry import below is type-only and erases), and
// never throws — an unparseable input yields null, because telemetry that
// throws would be telemetry that can fail a read (design lock 1).
//
// WHY two durations + a basis rather than one subtraction: a re-queue
// (post-verify drift, push race, suffix invalidation, crash recovery) NULLS
// merge_requests.picked_up_at while enqueued_at stands. A naive
// pickup − enqueued therefore charges the ENTIRE prior integration — a 39-minute
// verify — to "queue wait", which is exactly the dishonesty this campaign exists
// to remove. So when a prior integration ENDED inside the window we re-anchor:
//   durationMs       — the last queue segment (what the aggregation percentiles)
//   originDurationMs — the total since submit / group creation (what the trace renders)
//   basis            — which of the two cases produced them
// Both are pre-computed; a reader is never handed two timestamps to subtract
// (design lock 4 / deployment guide §14.14).

import type { DerivedPhaseEntry } from "../schemas/merge-phase.js";
import type { MergeDerivedPhase } from "../constants/enums.js";

/** The lane + entity identity a derived entry is attributed to. */
interface DerivedIdentity {
  projectId: string;
  resource: string;
  requestId: string | null;
  groupId: string | null;
}

/**
 * The shared rule. Completed windows only: a null pickup yields null, exactly as
 * a stored row exists only for a phase that finished — so an in-flight request
 * never contributes a half-open phase to the aggregate.
 */
function derive(
  phase: MergeDerivedPhase,
  identity: DerivedIdentity,
  originAt: string,
  pickupAt: string | null,
  priorIntegrationAt: string | null,
): DerivedPhaseEntry | null {
  if (pickupAt === null) return null;

  const origin = Date.parse(originAt);
  const pickup = Date.parse(pickupAt);
  if (!Number.isFinite(origin) || !Number.isFinite(pickup)) return null;

  const prior = priorIntegrationAt === null ? Number.NaN : Date.parse(priorIntegrationAt);
  // STRICTLY between: evidence at or outside the window tells us nothing about
  // this queue segment.
  const requeued = Number.isFinite(prior) && prior > origin && prior < pickup;
  const start = requeued ? prior : origin;

  return {
    derived: true,
    phase,
    ...identity,
    startedAt: requeued ? priorIntegrationAt! : originAt,
    // Both clamped at 0: a backwards clock (pickup before origin) must not mint
    // a negative duration, and clamping BOTH is what keeps the
    // originDurationMs >= durationMs invariant true unconditionally.
    durationMs: Math.max(0, Math.round(pickup - start)),
    originAt,
    originDurationMs: Math.max(0, Math.round(pickup - origin)),
    basis: requeued ? "requeued" : "exact",
  };
}

/**
 * `queue_wait` — a request sitting in the lane queue, from submit (or the end of
 * its prior integration) until the integrator picked it up.
 */
export function deriveQueueWait(args: {
  projectId: string;
  resource: string;
  requestId: string;
  enqueuedAt: string;
  pickedUpAt: string | null;
  priorIntegrationAt: string | null;
}): DerivedPhaseEntry | null {
  return derive(
    "queue_wait",
    {
      projectId: args.projectId,
      resource: args.resource,
      requestId: args.requestId,
      groupId: null,
    },
    args.enqueuedAt,
    args.pickedUpAt,
    args.priorIntegrationAt,
  );
}

/**
 * `forming` — a cross-repo group from creation until its FIRST member was picked
 * up (the group is assembled the moment integration begins, so the first pickup
 * is the end of forming).
 */
export function deriveForming(args: {
  projectId: string;
  resource: string;
  groupId: string;
  groupCreatedAt: string;
  firstMemberPickupAt: string | null;
  priorIntegrationAt: string | null;
}): DerivedPhaseEntry | null {
  return derive(
    "forming",
    {
      projectId: args.projectId,
      resource: args.resource,
      requestId: null,
      groupId: args.groupId,
    },
    args.groupCreatedAt,
    args.firstMemberPickupAt,
    args.priorIntegrationAt,
  );
}
