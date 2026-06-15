/**
 * Phase 7.4 §3.2/§3.5 (Step 12): the pure heartbeat-payload builder.
 *
 * Extracted from index.ts so it is unit-testable WITHOUT importing index.ts
 * (which runs `main()` on import). The integrator mints the heartbeat from its
 * worktree-pool numbers (`pool.size`/`pool.leasedCount`, the only place the pool
 * lives) + the shared in-flight counters the batch/group lanes mutate. The wire
 * shape is snake_case to match `integratorHeartbeatSchema`.
 */
import type { IntegratorHeartbeat } from "@pm/shared";

export interface InFlightCounters {
  requests: number;
  batches: number;
  groups: number;
}

export interface HeartbeatPoolView {
  size: number;
  leasedCount: number;
}

/**
 * C2 (failure legibility): the shared, MUTABLE lane-health state the lock
 * releaser writes and the heartbeat reads. A failed `releaseLock` sets
 * `lastReleaseFailure` (the lane lock may be stuck held server-side → queued
 * work stalls); a subsequent successful release clears it back to `null`.
 * Single-threaded loop ⇒ synchronous mutation, no races (the `inFlight`
 * counters' idiom).
 */
export interface LaneHealthState {
  lastReleaseFailure: { at: string; message: string } | null;
}

/**
 * Build the heartbeat body. `status` is derived: "integrating" while a batch OR
 * a group is in flight, else "idle" (the lane's resting state). The pool numbers
 * are read straight from the WorktreePool; the in-flight counts are the shared
 * counters; `version` is the integrator's package version.
 *
 * `last_release_failure` is emitted ONLY when a `laneHealth` state is provided
 * (omit-when-absent — old payload shapes stay byte-identical): value ⇒ PM
 * records the failure; explicit null ⇒ PM clears any stored one (the wire
 * tri-state — see integratorHeartbeatSchema).
 */
export function buildHeartbeat(args: {
  resource: string;
  pool: HeartbeatPoolView;
  inFlight: InFlightCounters;
  version: string;
  laneHealth?: LaneHealthState;
}): IntegratorHeartbeat {
  return {
    resource: args.resource,
    status: args.inFlight.batches > 0 || args.inFlight.groups > 0 ? "integrating" : "idle",
    pool_utilization: {
      size: args.pool.size,
      leased: args.pool.leasedCount,
    },
    in_flight: {
      requests: args.inFlight.requests,
      batches: args.inFlight.batches,
      groups: args.inFlight.groups,
    },
    version: args.version,
    ...(args.laneHealth === undefined
      ? {}
      : { last_release_failure: args.laneHealth.lastReleaseFailure }),
  };
}
