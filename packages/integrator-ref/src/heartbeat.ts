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
 * Build the heartbeat body. `status` is derived: "integrating" while a batch OR
 * a group is in flight, else "idle" (the lane's resting state). The pool numbers
 * are read straight from the WorktreePool; the in-flight counts are the shared
 * counters; `version` is the integrator's package version.
 */
export function buildHeartbeat(args: {
  resource: string;
  pool: HeartbeatPoolView;
  inFlight: InFlightCounters;
  version: string;
}): IntegratorHeartbeat {
  return {
    resource: args.resource,
    status:
      args.inFlight.batches > 0 || args.inFlight.groups > 0
        ? "integrating"
        : "idle",
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
  };
}
