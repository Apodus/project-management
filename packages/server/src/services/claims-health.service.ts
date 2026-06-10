import { and, asc, desc, eq, inArray, isNotNull, lt, notInArray } from "drizzle-orm";
import {
  createId,
  LEASE_GRACE_MS_DEFAULT,
  type ClaimState,
  type LeaseEntityType,
  type UserType,
} from "@pm/shared";
import {
  getDb,
  claimLeases,
  claimsAlertState,
  epics,
  projects,
  proposals,
  tasks,
  users,
} from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";
import { deriveLiveness, readLeasesFor } from "./claim-lease.service.js";
import { deriveClaimState } from "./claim-helpers.js";

// ─── Constants ────────────────────────────────────────────────────
//
// The on-read, edge-triggered stale-claim alert (Campaign C3 §P5a). It mirrors
// the 7.4 train.stuck alert PRECISELY: detection is a side effect of an on-read
// aggregate (computeClaimsHealth), the alert fires exactly ONCE per stale
// episode (latched on claims_alert_state.stale_claims_notified), and re-arms
// when the stale claims clear. There is NO sweep / scheduler / side-effecting
// reclaim here — this module only READS (the latch boolean is the sole write).

// The grace window for the stale pre-filter + per-candidate liveness check. The
// same default the C2 lease engine uses (a lease is "stale" only once
// now > expiresAt + grace). staleness already embeds the long lease TTL+grace,
// so a claim past it is intrinsically rare — the threshold is simply
// staleCount > 0 (no extra floor needed).
const GRACE_MS = LEASE_GRACE_MS_DEFAULT;

// Bound the candidate batch. A lapsed-past-grace lease is rare (the TTL+grace is
// ~24.5h by default), so a few hundred is a generous ceiling that keeps the
// per-candidate entity resolution cheap. Mirrors sweepStaleClaims' bounded scan.
const CANDIDATE_LIMIT = 500;

// The three lease entity types, each resolved against its own table to scope the
// stale claim to a project (claim_leases carries NO projectId).
const ENTITY_TYPES: readonly LeaseEntityType[] = ["task", "epic", "proposal"];

const ENTITY_TABLE: Record<LeaseEntityType, typeof tasks | typeof epics | typeof proposals> = {
  task: tasks,
  epic: epics,
  proposal: proposals,
};

// ─── Types ────────────────────────────────────────────────────────

export interface ClaimsHealth {
  staleCount: number;
  oldestStaleAgeMs: number | null;
}

/**
 * The claims_alert_state latch row (camelCase Drizzle property names). Mirrors
 * train.service.TrainAlertLatchRow — id + the single edge-trigger flag.
 */
export interface ClaimsAlertLatchRow {
  id: string;
  staleClaimsNotified: boolean;
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

// ─── Alert latch surface ──────────────────────────────────────────
//
// The stale-claim edge-trigger flag lives on the per-project claims_alert_state
// row. These thin helpers expose the latch read (lazy-creating the row) + a
// single-column set, mirroring train.service.readAlertLatch / setAlertLatch:
// the set touches ONLY the latch boolean + updatedAt, so a detection read can
// never clobber unrelated state, and the lazy-create INSERT is race-guarded by
// the unique (project_id) index (the getOrCreateTrainState idiom).

function readClaimsAlertStateRow(projectId: string): ClaimsAlertLatchRow | undefined {
  const db = getDb();
  const row = db
    .select({ id: claimsAlertState.id, staleClaimsNotified: claimsAlertState.staleClaimsNotified })
    .from(claimsAlertState)
    .where(eq(claimsAlertState.projectId, projectId))
    .get();
  return (row as ClaimsAlertLatchRow | undefined) ?? undefined;
}

/**
 * Read (lazily creating) the project's claims_alert_state latch row. Returns the
 * row id + the current stale-claim latch. The INSERT is guarded by try/catch for
 * the unique-index race (two concurrent first reads) — on rejection we re-read.
 */
export function readClaimsAlertLatch(projectId: string): ClaimsAlertLatchRow {
  const existing = readClaimsAlertStateRow(projectId);
  if (existing) return existing;

  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.insert(claimsAlertState)
      .values({
        id: createId(),
        projectId,
        staleClaimsNotified: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch {
    // Race: another caller inserted the same project between our SELECT and
    // INSERT. The unique index rejected us — re-read below.
  }
  return readClaimsAlertStateRow(projectId)!;
}

/**
 * Single-COLUMN autocommit UPDATE of the stale-claim latch by row id. Touches
 * ONLY the latch boolean + updatedAt — no clobber of any other column. Mirrors
 * train.service.setAlertLatch / health.service.checkStaleness's single-statement
 * latch write.
 */
export function setClaimsAlertLatch(rowId: string, value: boolean, now: string): void {
  getDb()
    .update(claimsAlertState)
    .set({ staleClaimsNotified: value, updatedAt: now })
    .where(eq(claimsAlertState.id, rowId))
    .run();
}

// ─── Stale-claim aggregate ────────────────────────────────────────

/**
 * Count the project's STALE claims + the age of its oldest stale claim.
 *
 * A claim is STALE when its lease has a non-null holder AND its expiry has
 * lapsed past the grace window (deriveLiveness === "stale"). Candidate selection
 * mirrors sweepStaleClaims: a cheap index pre-filter on idx_claim_leases_type_
 * expires (`expiresAt < now - grace`, oldest first, bounded), then a precise
 * per-candidate liveness re-check. Each candidate is resolved against its entity
 * table to keep ONLY claims whose entity belongs to THIS project (claim_leases
 * carries no projectId).
 *
 * oldestStaleAgeMs is `now − (oldest stale lease's expiresAt)` — the elapsed
 * time since the oldest stale claim lapsed (the age basis for the alert message,
 * analogous to train.stuck's oldestQueuedAgeMs).
 */
function aggregateStaleClaims(projectId: string, now: Date): ClaimsHealth {
  const db = getDb();
  const staleThresholdIso = new Date(now.getTime() - GRACE_MS).toISOString();

  let staleCount = 0;
  let oldestExpiresMs: number | null = null;

  for (const entityType of ENTITY_TYPES) {
    // The cheap index pre-filter: lapsed leases of this type, oldest-expiry
    // first, bounded (the same idiom sweepStaleClaims uses).
    const candidates = db
      .select({
        entityId: claimLeases.entityId,
        holderId: claimLeases.holderId,
        expiresAt: claimLeases.expiresAt,
      })
      .from(claimLeases)
      .where(
        and(
          eq(claimLeases.entityType, entityType),
          lt(claimLeases.expiresAt, staleThresholdIso),
        ),
      )
      .orderBy(asc(claimLeases.expiresAt))
      .limit(CANDIDATE_LIMIT)
      .all();

    if (candidates.length === 0) continue;

    // Keep only candidates with a holder + a precisely-stale liveness verdict.
    const stale = candidates.filter(
      (c) => c.holderId != null && deriveLiveness(now, c.expiresAt, GRACE_MS) === "stale",
    );
    if (stale.length === 0) continue;

    // Resolve the entities in one batched read to scope by project — only those
    // belonging to THIS project count toward the per-project alert.
    const table = ENTITY_TABLE[entityType];
    const entityIds = stale.map((c) => c.entityId);
    const owned = db
      .select({ id: table.id })
      .from(table)
      .where(and(inArray(table.id, entityIds), eq(table.projectId, projectId)))
      .all() as Array<{ id: string }>;
    const ownedIds = new Set(owned.map((r) => r.id));

    for (const c of stale) {
      if (!ownedIds.has(c.entityId)) continue;
      staleCount += 1;
      const expiresMs = Date.parse(c.expiresAt);
      if (!Number.isNaN(expiresMs) && (oldestExpiresMs === null || expiresMs < oldestExpiresMs)) {
        oldestExpiresMs = expiresMs;
      }
    }
  }

  return {
    staleCount,
    oldestStaleAgeMs: oldestExpiresMs === null ? null : now.getTime() - oldestExpiresMs,
  };
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Compute the project's stale-claim health AND fire the edge-triggered
 * stale-claim alert as a side effect (Campaign C3 §P5a). Mirrors
 * metrics.service.computeMetrics → checkAlerts PRECISELY:
 *
 *   - read the aggregate (staleCount + oldestStaleAgeMs),
 *   - fire when staleCount > 0 (staleness already embeds the long lease
 *     TTL+grace, so a stale claim is intrinsically rare),
 *   - edge-trigger on the per-project latch: emit + latch true on the rising
 *     edge, reset the latch on the falling edge — so the alert fires exactly
 *     ONCE per stale episode and re-arms when the claims clear.
 *
 * The emit is IDENTITY-MASKED: the payload carries NO holder id, only an
 * aggregate count + the oldest-stale age. All emission is post-latch-write and
 * fire-and-forget — the alerts-listener guards its own failures, so a webhook
 * failure can never throw out of this read path (mirrors checkAlerts + the
 * NOTE-2 discipline in alerts-listener.ts).
 *
 * Returns the aggregate for the read endpoint.
 */
export function computeClaimsHealth(projectId: string, now: Date = new Date()): ClaimsHealth {
  ensureProjectExists(projectId);

  const health = aggregateStaleClaims(projectId, now);
  const nowIso = now.toISOString();

  const fire = health.staleCount > 0;
  const latch = readClaimsAlertLatch(projectId);

  if (fire && !latch.staleClaimsNotified) {
    setClaimsAlertLatch(latch.id, true, nowIso);
    getEventBus().emit(EVENT_NAMES.CLAIM_STALE_ALERT, {
      // Identity-masked — aggregate only, NO holder id.
      entity: {
        projectId,
        staleCount: health.staleCount,
        oldestStaleAgeMs: health.oldestStaleAgeMs,
      },
      entityType: "project",
      entityId: projectId,
      projectId,
      actorId: null,
      timestamp: nowIso,
    });
  } else if (!fire && latch.staleClaimsNotified) {
    // Condition cleared — reset the latch so the NEXT stale episode re-fires.
    setClaimsAlertLatch(latch.id, false, nowIso);
  }

  return health;
}

// ─── Project claims aggregate (Campaign C3 — claims panel) ────────
//
// The read model behind GET /projects/{id}/claims: every ACTIVE claim in the
// project (tasks/epics/proposals with a non-null holder and a non-terminal
// status), each with its identity-masked claim_state, its holder (the entity's
// human-facing assigneeId/claimedBy pointer — NEVER the lease's holderId), and
// a nullable claimedAt age basis sourced from the lease layer (null for legacy
// pre-C2 claims that never acquired a lease).
//
// This is a PURE READ — it never touches the stale-claim alert latch (that
// side effect belongs exclusively to computeClaimsHealth).

/** Terminal statuses per entity type — a closed entity's claim is not active. */
const TERMINAL_STATUSES: Record<LeaseEntityType, readonly string[]> = {
  task: ["done", "cancelled"],
  epic: ["completed", "cancelled"],
  proposal: ["completed", "rejected"],
};

export interface ProjectClaimHolder {
  id: string;
  name: string;
  type: UserType;
}

export interface ProjectClaimItem {
  entityType: LeaseEntityType;
  id: string;
  title: string;
  status: string;
  claimState: ClaimState;
  holder: ProjectClaimHolder;
  /** Lease-layer acquisition time; null for legacy pre-C2 claims (no lease row). */
  claimedAt: string | null;
  updatedAt: string;
}

export interface ProjectClaims {
  items: ProjectClaimItem[];
  total: number;
}

interface RawClaimRow {
  id: string;
  title: string;
  status: string;
  holderId: string | null;
  updatedAt: string;
}

/** Per-type select of active claimed rows (holder non-null + non-terminal). */
function selectClaimedRows(projectId: string, entityType: LeaseEntityType): RawClaimRow[] {
  const db = getDb();
  const terminal = [...TERMINAL_STATUSES[entityType]];
  switch (entityType) {
    case "task":
      return db
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          holderId: tasks.assigneeId,
          updatedAt: tasks.updatedAt,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, projectId),
            isNotNull(tasks.assigneeId),
            notInArray(tasks.status, terminal),
          ),
        )
        .orderBy(desc(tasks.updatedAt))
        .all();
    case "epic":
      return db
        .select({
          id: epics.id,
          title: epics.name,
          status: epics.status,
          holderId: epics.assigneeId,
          updatedAt: epics.updatedAt,
        })
        .from(epics)
        .where(
          and(
            eq(epics.projectId, projectId),
            isNotNull(epics.assigneeId),
            notInArray(epics.status, terminal),
          ),
        )
        .orderBy(desc(epics.updatedAt))
        .all();
    case "proposal":
      return db
        .select({
          id: proposals.id,
          title: proposals.title,
          status: proposals.status,
          holderId: proposals.claimedBy,
          updatedAt: proposals.updatedAt,
        })
        .from(proposals)
        .where(
          and(
            eq(proposals.projectId, projectId),
            isNotNull(proposals.claimedBy),
            notInArray(proposals.status, terminal),
          ),
        )
        .orderBy(desc(proposals.updatedAt))
        .all();
  }
}

/**
 * List every active claim in the project, with its identity-masked claim_state
 * relative to `caller`, the holder resolved to {id, name, type} in ONE batched
 * users read, and the lease-layer claimedAt (null when no lease row exists —
 * the legacy pre-C2 case).
 *
 * Pure read: no latch write, no event, no sweep.
 */
export function listProjectClaims(
  projectId: string,
  caller?: { id: string } | null,
  now: Date = new Date(),
): ProjectClaims {
  ensureProjectExists(projectId);
  const db = getDb();

  // Per type: raw claimed rows + a batched lease read; derive claim_state per
  // row from the lease (fail-safe-to-live when no lease row exists).
  const pending: Array<Omit<ProjectClaimItem, "holder"> & { holderId: string }> = [];
  for (const entityType of ENTITY_TYPES) {
    const rows = selectClaimedRows(projectId, entityType);
    if (rows.length === 0) continue;
    const leases = readLeasesFor(
      entityType,
      rows.map((r) => r.id),
    );
    for (const row of rows) {
      // holderId is non-null by the isNotNull filter; guard anyway.
      if (row.holderId == null) continue;
      const lease = leases.get(row.id) ?? null;
      pending.push({
        entityType,
        id: row.id,
        title: row.title,
        status: row.status,
        claimState: deriveClaimState(row.holderId, lease, now, caller),
        claimedAt: lease?.claimedAt ?? null,
        updatedAt: row.updatedAt,
        holderId: row.holderId,
      });
    }
  }

  // ONE batched users read for every distinct holder.
  const holderIds = [...new Set(pending.map((p) => p.holderId))];
  const holderById = new Map<string, ProjectClaimHolder>();
  if (holderIds.length > 0) {
    const rows = db
      .select({ id: users.id, name: users.displayName, type: users.type })
      .from(users)
      .where(inArray(users.id, holderIds))
      .all();
    for (const u of rows) {
      holderById.set(u.id, { id: u.id, name: u.name, type: u.type as UserType });
    }
  }

  const items: ProjectClaimItem[] = pending.map(({ holderId, ...rest }) => ({
    ...rest,
    holder:
      holderById.get(holderId) ??
      // FK-backed, so a miss is theoretical — fall back to the raw id so the
      // row still renders rather than vanishing.
      { id: holderId, name: holderId, type: "ai_agent" as UserType },
  }));

  return { items, total: items.length };
}
