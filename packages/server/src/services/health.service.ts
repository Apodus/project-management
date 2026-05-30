import { and, eq } from "drizzle-orm";
import { createId } from "@pm/shared";
import { getDb, integratorHealth, projects } from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";

// ─── Constants ────────────────────────────────────────────────────

// The staleness threshold (§3.4): the default 30s heartbeat interval (§3.6)
// times a tolerance factor of 3 = 90s, giving two missed beats of slack
// before "unhealthy." A per-project heartbeat_interval_sec override
// (projects.settings.integrator.heartbeat_interval_sec) is deferred to §6.1.
export const HEALTH_STALE_MS = 90_000;

// ─── Types ────────────────────────────────────────────────────────

/**
 * The heartbeat payload the integrator denormalizes onto the health row
 * (§3.2). The route maps the wire body (snake_case) onto these camelCase
 * fields before calling recordHeartbeat.
 */
export interface HeartbeatPayload {
  status: string;
  poolSize: number | null;
  poolLeased: number | null;
  inFlightRequests: number;
  inFlightBatches: number;
  inFlightGroups: number;
  version: string | null;
}

/**
 * The on-read health view (§3.4). Carries the raw lastSeenAt plus the
 * derived staleness/healthy fields and the denormalized payload. The
 * dashboard renders "last heard 47s ago" from stalenessMs.
 */
export interface IntegratorHealthView {
  resource: string;
  status: string; // "idle" | "integrating" | "never_seen"
  healthy: boolean;
  lastSeenAt: string | null;
  stalenessMs: number | null;
  poolSize: number | null;
  poolLeased: number | null;
  inFlightRequests: number;
  inFlightBatches: number;
  inFlightGroups: number;
  version: string | null;
  integratorId: string | null;
}

// ─── Internal row shape ───────────────────────────────────────────

interface IntegratorHealthRow {
  id: string;
  projectId: string;
  resource: string;
  integratorId: string | null;
  status: string;
  poolSize: number | null;
  poolLeased: number | null;
  inFlightRequests: number;
  inFlightBatches: number;
  inFlightGroups: number;
  version: string | null;
  lastSeenAt: string;
  unhealthyNotified: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Internal helpers ─────────────────────────────────────────────

function ensureProjectExists(projectId: string): void {
  const db = getDb();
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }
}

function readRow(
  projectId: string,
  resource: string,
): IntegratorHealthRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(integratorHealth)
    .where(
      and(
        eq(integratorHealth.projectId, projectId),
        eq(integratorHealth.resource, resource),
      ),
    )
    .get() as IntegratorHealthRow | undefined;
}

function toView(row: IntegratorHealthRow, now: string): IntegratorHealthView {
  const stalenessMs = Date.parse(now) - Date.parse(row.lastSeenAt);
  return {
    resource: row.resource,
    status: row.status,
    healthy: stalenessMs <= HEALTH_STALE_MS,
    lastSeenAt: row.lastSeenAt,
    stalenessMs,
    poolSize: row.poolSize,
    poolLeased: row.poolLeased,
    inFlightRequests: row.inFlightRequests,
    inFlightBatches: row.inFlightBatches,
    inFlightGroups: row.inFlightGroups,
    version: row.version,
    integratorId: row.integratorId,
  };
}

/**
 * The "never started" view (§3.4): no heartbeat has ever arrived for this
 * lane, so we distinguish "never seen" from "died."
 */
function neverSeenView(resource: string): IntegratorHealthView {
  return {
    resource,
    status: "never_seen",
    healthy: false,
    lastSeenAt: null,
    stalenessMs: null,
    poolSize: null,
    poolLeased: null,
    inFlightRequests: 0,
    inFlightBatches: 0,
    inFlightGroups: 0,
    version: null,
    integratorId: null,
  };
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Record a heartbeat for (project, resource): upsert the integrator_health
 * row (§3.5). First beat INSERTs; every subsequent beat UPDATEs lastSeenAt +
 * the denormalized payload + unhealthyNotified=false (a fresh beat re-arms
 * the edge). Read-then-insert-or-update, mirroring merge-lock.service's
 * getOrCreateLock: the INSERT is guarded by try/catch for the unique-index
 * race (two concurrent first-beats). Emits NOTHING (heartbeats are
 * high-frequency — emitting per-beat would flood the SSE stream, §3.5).
 */
export function recordHeartbeat(
  projectId: string,
  resource: string,
  integratorId: string,
  payload: HeartbeatPayload,
  now: string,
): IntegratorHealthView {
  ensureProjectExists(projectId);
  const db = getDb();

  const existing = readRow(projectId, resource);

  if (!existing) {
    const id = createId();
    try {
      db.insert(integratorHealth)
        .values({
          id,
          projectId,
          resource,
          integratorId,
          status: payload.status,
          poolSize: payload.poolSize,
          poolLeased: payload.poolLeased,
          inFlightRequests: payload.inFlightRequests,
          inFlightBatches: payload.inFlightBatches,
          inFlightGroups: payload.inFlightGroups,
          version: payload.version,
          lastSeenAt: now,
          unhealthyNotified: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch {
      // Race: another caller inserted the same (project, resource) between
      // our SELECT and INSERT. The unique index rejected us — fall through
      // to the UPDATE path below by re-reading.
      db.update(integratorHealth)
        .set({
          integratorId,
          status: payload.status,
          poolSize: payload.poolSize,
          poolLeased: payload.poolLeased,
          inFlightRequests: payload.inFlightRequests,
          inFlightBatches: payload.inFlightBatches,
          inFlightGroups: payload.inFlightGroups,
          version: payload.version,
          lastSeenAt: now,
          unhealthyNotified: false,
          updatedAt: now,
        })
        .where(
          and(
            eq(integratorHealth.projectId, projectId),
            eq(integratorHealth.resource, resource),
          ),
        )
        .run();
    }
  } else {
    db.update(integratorHealth)
      .set({
        integratorId,
        status: payload.status,
        poolSize: payload.poolSize,
        poolLeased: payload.poolLeased,
        inFlightRequests: payload.inFlightRequests,
        inFlightBatches: payload.inFlightBatches,
        inFlightGroups: payload.inFlightGroups,
        version: payload.version,
        lastSeenAt: now,
        // A fresh heartbeat re-arms the edge so the NEXT stale episode fires
        // again (§3.4 recovery).
        unhealthyNotified: false,
        updatedAt: now,
      })
      .where(eq(integratorHealth.id, existing.id))
      .run();
  }

  const fresh = readRow(projectId, resource)!;
  return toView(fresh, now);
}

/**
 * The shared edge-trigger (§3.4). Computes staleness on the row; if the lane
 * is stale AND we have not yet notified for this stale episode, flips
 * unhealthyNotified=true (a single-statement autocommit UPDATE) and THEN —
 * after the write returns — emits train.integrator_unhealthy. The latch
 * (unhealthyNotified=true) makes it fire exactly ONCE per stale episode; the
 * next fresh heartbeat clears the latch, re-arming the edge. Reused by Step 5
 * (the metrics GET embeds health). Single-statement UPDATE then emit =
 * emit-after-write-safe.
 */
export function checkStaleness(row: IntegratorHealthRow, now: string): void {
  const stalenessMs = Date.parse(now) - Date.parse(row.lastSeenAt);
  if (stalenessMs > HEALTH_STALE_MS && !row.unhealthyNotified) {
    getDb()
      .update(integratorHealth)
      .set({ unhealthyNotified: true, updatedAt: now })
      .where(eq(integratorHealth.id, row.id))
      .run();
    // AFTER the write returns.
    getEventBus().emit(EVENT_NAMES.TRAIN_INTEGRATOR_UNHEALTHY, {
      entity: { ...row, resource: row.resource },
      entityType: "integrator_health",
      entityId: row.id,
      projectId: row.projectId,
      actorId: row.integratorId ?? null,
      timestamp: now,
    });
  }
}

/**
 * Read the lane health, computing freshness ON-READ (§3.4). When the lane is
 * stale this read fires the train.integrator_unhealthy edge (once per
 * episode, via checkStaleness). No row → "never_seen" (healthy:false,
 * lastSeenAt:null) — distinguishing "never started" from "died."
 */
export function getHealth(
  projectId: string,
  resource: string,
  now?: string,
): IntegratorHealthView {
  ensureProjectExists(projectId);
  const ts = now ?? new Date().toISOString();
  const row = readRow(projectId, resource);
  if (!row) return neverSeenView(resource);
  // Fire the stale-edge event if appropriate (mutates unhealthyNotified).
  checkStaleness(row, ts);
  return toView(row, ts);
}
