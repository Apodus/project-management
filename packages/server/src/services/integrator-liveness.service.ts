import { and, eq, isNull } from "drizzle-orm";
import type { IntegratorLiveness } from "@pm/shared";
import { getDb, mergeAttempts, mergeRequests } from "../db/index.js";
import { getHealth } from "./health.service.js";

/**
 * Derive the agent-facing integrator liveness block for a `(project, resource)`
 * lane (campaign: integrator liveness legibility). READ-PATH ONLY — additive,
 * no persistence.
 *
 * Liveness reuses `getHealth` (the ONE source of truth for staleness,
 * `HEALTH_STALE_MS`) so it correctly fires the once-per-episode
 * `train.integrator_unhealthy` stale edge and never invents a second cutoff:
 *   - no health row (never heartbeated) → `status: "down"` (fail-safe)
 *   - fresh heartbeat                   → `status: "alive"`
 *   - stale heartbeat                   → `status: "stale"`
 *
 * `stall = "integrator_down"` iff the integrator is NOT alive AND a queued
 * request exists for the lane with ZERO merge_attempts rows of ANY status —
 * the exact "the queue is not being consumed" signal. Counting ALL attempt
 * rows (not just open ones) EXCLUDES a re-queued request, which retains
 * CANCELLED attempt rows, so a re-queue after a rejected attempt does not
 * false-positive. The `queuedZeroAttempt` conjunct guards a healthy-but-idle
 * lane with a legitimately empty queue.
 *
 * `stall = "pool_stranded"` is the ALIVE counterpart, added after the
 * 2026-08-02 wedge: the daemon heartbeats normally, the lane reads `idle` with
 * nothing in flight, yet every verify worktree is leased — so it can admit
 * nothing, forever, while the queue grows. Liveness alone reads "alive" and
 * says wait; this says restart. Both conjuncts matter: `poolLeased >= poolSize`
 * is normal DURING a batch (which reports in-flight work and lane_status
 * "integrating"), so the zero-in-flight requirement is what makes it a leak
 * rather than a busy lane. Same `queuedZeroAttempt` guard — a lane with nothing
 * waiting has no stall to report, whatever its pool says.
 */
export function deriveLiveness(
  projectId: string,
  resource: string,
  now: string,
): IntegratorLiveness {
  const live = getHealth(projectId, resource, now);

  const alive = live.lastSeenAt !== null && live.healthy;
  const status: IntegratorLiveness["status"] =
    live.lastSeenAt === null ? "down" : live.healthy ? "alive" : "stale";
  const lastHeartbeatAgeSec =
    live.stalenessMs === null ? null : Math.floor(live.stalenessMs / 1000);
  const laneStatus: IntegratorLiveness["lane_status"] =
    live.lastSeenAt === null ? null : (live.status as "idle" | "integrating");

  // Every verify slot leased while the lane reports NOTHING in flight — the
  // leaked-slot signature. Only meaningful on a live heartbeat (a stale row's
  // numbers describe a daemon that is already gone; "down" is the better read).
  const poolStranded =
    alive &&
    live.poolSize !== null &&
    live.poolSize > 0 &&
    (live.poolLeased ?? 0) >= live.poolSize &&
    live.inFlightRequests === 0 &&
    live.inFlightBatches === 0 &&
    live.inFlightGroups === 0;

  // Short-circuit order matters: the queued-zero-attempt probe is a DB read on
  // a hot path (every merge-lock / merge-request read), so it runs only once a
  // stall shape is already suspected.
  const suspected = !alive ? "integrator_down" : poolStranded ? "pool_stranded" : null;
  const stall: IntegratorLiveness["stall"] =
    suspected !== null && hasQueuedZeroAttempt(projectId, resource) ? suspected : null;

  return {
    status,
    last_heartbeat_age_sec: lastHeartbeatAgeSec,
    lane_status: laneStatus,
    version: live.version,
    stall,
  };
}

/**
 * Does a `queued` merge_request exist for the lane with ZERO merge_attempts
 * rows of ANY status? A LEFT JOIN + `merge_attempts.id IS NULL` keeps only
 * queued requests with no attempt row at all (a re-queued request keeps its
 * cancelled attempt rows and is thus excluded). Bounded to a single row.
 */
function hasQueuedZeroAttempt(projectId: string, resource: string): boolean {
  const db = getDb();
  const row = db
    .select({ id: mergeRequests.id })
    .from(mergeRequests)
    .leftJoin(mergeAttempts, eq(mergeAttempts.requestId, mergeRequests.id))
    .where(
      and(
        eq(mergeRequests.projectId, projectId),
        eq(mergeRequests.resource, resource),
        eq(mergeRequests.status, "queued"),
        isNull(mergeAttempts.id),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}
