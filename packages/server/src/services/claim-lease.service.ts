import { and, asc, eq, inArray, lt } from "drizzle-orm";
import {
  createId,
  LEASE_MODES,
  LEASE_MODE_DEFAULT,
  LEASE_TTL_MS_DEFAULT,
  LEASE_GRACE_MS_DEFAULT,
  type AuditLogView,
  type LeaseEntityType,
  type LeaseLiveness,
  type LeaseMode,
} from "@pm/shared";
import {
  getDb,
  claimLeases,
  tasks,
  epics,
  proposals,
} from "../db/index.js";
import {
  record as recordAudit,
  emitAuditRecorded,
} from "./audit.service.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";

// ─── Config ───────────────────────────────────────────────────────
//
// Pure mechanics for the claim-lease engine (campaign C2 §P2). This module
// owns the lease lifecycle (acquire/renew/read), on-read liveness derivation,
// and the opportunistic stale-claim sweep. It deliberately does NOT wire into
// claim/start/pick or touch claim-helpers/event-bus — that's P3/P4. The only
// entity mutation it performs is clearing a holder during a mode `on` reclaim
// (and even that mirrors the existing forceClaim txn shape EXACTLY).
//
// The consts read PM_LEASE_MODE / PM_LEASE_TTL_SEC / PM_LEASE_GRACE_SEC, with
// the @pm/shared defaults as fallback so the production posture (shadow mode,
// 30m TTL, 24h grace) is unchanged when the env is unset. Every public fn also
// accepts an `opts` override so tests can exercise off/shadow/on + clock
// deterministically.
//
// Parse a `PM_LEASE_*_SEC` env value (seconds) into ms. An unset, non-numeric,
// or non-positive value falls back to `defaultMs` (warn-and-continue posture:
// a misconfigured knob never weakens the safe default).
function parsePositiveSec(raw: string | undefined, defaultMs: number): number {
  if (raw == null) return defaultMs;
  const sec = Number.parseInt(raw, 10);
  return Number.isNaN(sec) || sec <= 0 ? defaultMs : sec * 1000;
}

function resolveLeaseMode(): LeaseMode {
  const raw = process.env.PM_LEASE_MODE;
  if (raw == null) return LEASE_MODE_DEFAULT;
  if ((LEASE_MODES as readonly string[]).includes(raw)) return raw as LeaseMode;
  console.warn(
    `WARNING: PM_LEASE_MODE="${raw}" is not one of ${LEASE_MODES.join("/")}. ` +
      `Falling back to "${LEASE_MODE_DEFAULT}".`,
  );
  return LEASE_MODE_DEFAULT;
}

const LEASE_MODE: LeaseMode = resolveLeaseMode();

/**
 * The single, authoritative read of the active lease mode (resolved once at
 * module load from PM_LEASE_MODE). Callers OUTSIDE this module — notably
 * pickNextTask (C3.P3) — MUST read the mode through this getter and never
 * re-parse the env, so there is exactly one mode source of truth.
 */
export function resolveActiveLeaseMode(): LeaseMode {
  return LEASE_MODE;
}
const LEASE_TTL_MS = parsePositiveSec(
  process.env.PM_LEASE_TTL_SEC,
  LEASE_TTL_MS_DEFAULT,
);

/**
 * PURE resolver for the reclaim grace (ms) from a raw PM_LEASE_GRACE_SEC
 * value — exported so the env-derivation itself is unit-testable. Unset /
 * non-numeric / non-positive → the @pm/shared default (byte-identical to the
 * pinned constant when the env is untouched).
 */
export function resolveLeaseGraceMs(
  raw: string | undefined = process.env.PM_LEASE_GRACE_SEC,
): number {
  return parsePositiveSec(raw, LEASE_GRACE_MS_DEFAULT);
}

const LEASE_GRACE_MS = resolveLeaseGraceMs();

/**
 * The single, authoritative read of the active reclaim grace (resolved once at
 * module load from PM_LEASE_GRACE_SEC). Callers OUTSIDE this module — notably
 * claims-health.service (C2 amendment: the stale-claim ALERT grace must agree
 * with the lease engine's reclaim grace under a tuned env, or badge-staleness
 * and alert-staleness diverge) — MUST read it through this getter and never
 * re-parse the env or pin the default constant.
 */
export function resolveActiveLeaseGraceMs(): number {
  return LEASE_GRACE_MS;
}

// ─── Types ────────────────────────────────────────────────────────

export interface Actor {
  id: string;
}

/**
 * The persisted claim_leases row shape (camelCase Drizzle property names from
 * schema.ts §claimLeases). Mirrors @pm/shared claimLeaseSchema.
 */
export interface ClaimLeaseRow {
  id: string;
  entityType: string;
  entityId: string;
  holderId: string | null;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  lastActivityAt: string;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A minimal structural view of an entity table (tasks/epics/proposals). The
 * sweep only ever touches id/projectId plus the dynamic holder column (accessed
 * via the computed-key Record house pattern, never a `.set({ [key]: ... })`
 * literal — same constraint forceClaim documents in claim-helpers.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EntityTable = any;

interface EntityRow {
  id: string;
  projectId: string | null;
  assigneeId?: string | null;
  claimedBy?: string | null;
  [key: string]: unknown;
}

interface EntityConfig {
  table: EntityTable;
  holderKey: "assigneeId" | "claimedBy";
  holderJsonKey: "assignee_id" | "claimed_by";
  auditTargetType: "task" | "epic" | "proposal";
}

/**
 * Per-entity-type wiring for the lease engine. The triples are a deliberate
 * LOCAL copy of the forceClaim ENTITY_CFG shape (we do NOT import
 * ForceClaimConfig — that type carries terminalStatuses/eventName that the lease
 * engine has no use for). Keyed by LeaseEntityType.
 */
const ENTITY_CFG: Record<LeaseEntityType, EntityConfig> = {
  task: {
    table: tasks,
    holderKey: "assigneeId",
    holderJsonKey: "assignee_id",
    auditTargetType: "task",
  },
  epic: {
    table: epics,
    holderKey: "assigneeId",
    holderJsonKey: "assignee_id",
    auditTargetType: "epic",
  },
  proposal: {
    table: proposals,
    holderKey: "claimedBy",
    holderJsonKey: "claimed_by",
    auditTargetType: "proposal",
  },
};

// ─── Read ─────────────────────────────────────────────────────────

/**
 * Read the lease for (entityType, entityId). Null when no lease exists.
 */
export function readLease(
  entityType: LeaseEntityType,
  entityId: string,
): ClaimLeaseRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(claimLeases)
    .where(
      and(
        eq(claimLeases.entityType, entityType),
        eq(claimLeases.entityId, entityId),
      ),
    )
    .get();
  return (row as ClaimLeaseRow | undefined) ?? null;
}

/**
 * Batch-read leases for many entities of one type (C3.P1 list-path helper).
 * Returns a Map keyed by entityId — only entities that HAVE a lease row are
 * present (a missing key ⇒ no lease ⇒ fail-safe-to-live downstream). The list
 * views use this to avoid an N+1 per-row readLease.
 *
 * Guards the empty-array case: drizzle's `inArray(col, [])` produces invalid
 * SQL, so an empty id set short-circuits to an empty Map (no query).
 */
export function readLeasesFor(
  entityType: LeaseEntityType,
  entityIds: string[],
): Map<string, ClaimLeaseRow> {
  const result = new Map<string, ClaimLeaseRow>();
  if (entityIds.length === 0) return result;

  const rows = getDb()
    .select()
    .from(claimLeases)
    .where(
      and(
        eq(claimLeases.entityType, entityType),
        inArray(claimLeases.entityId, entityIds),
      ),
    )
    .all() as ClaimLeaseRow[];

  for (const row of rows) result.set(row.entityId, row);
  return result;
}

/**
 * Derive a lease's liveness from its `expiresAt` and the current clock.
 *
 * Fail-safe-to-LIVE: a null/unparseable `expiresAt` is treated as "live" so a
 * malformed row is never aggressively reclaimed. A lease is "stale" only once
 * `now > expiresAt + graceMs`; everything up to and including that boundary is
 * "live". `expiresAt` already folds in the TTL (set at acquire/renew), so this
 * signature takes expiresAt directly — same shape merge-lock derives expiry from.
 */
export function deriveLiveness(
  now: Date,
  expiresAt: string | null,
  graceMs = LEASE_GRACE_MS,
): LeaseLiveness {
  if (expiresAt == null) return "live";
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return "live";
  return now.getTime() > expiry + graceMs ? "stale" : "live";
}

// ─── Lifecycle ────────────────────────────────────────────────────

/**
 * Acquire — create-or-overwrite the single lease row for (entityType,
 * entityId). All lifecycle timestamps are stamped to `now`; `expiresAt` is
 * `now + ttl`. Idempotent over the unique (entityType, entityId) index: a
 * concurrent insert race re-reads and UPDATEs in place (mirrors
 * merge-lock.getOrCreateLock's try/catch-then-re-read). MUST NOT touch the
 * entity's assigneeId/claimedBy — that's P3.
 */
export function acquireLease(
  entityType: LeaseEntityType,
  entityId: string,
  holder: Actor,
  opts?: { sessionId?: string | null; now?: Date; ttlMs?: number },
): ClaimLeaseRow {
  const db = getDb();
  const now = opts?.now ?? new Date();
  const nowIso = now.toISOString();
  const ttlMs = opts?.ttlMs ?? LEASE_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const sessionId = opts?.sessionId ?? null;

  const existing = readLease(entityType, entityId);
  if (existing) {
    db.update(claimLeases)
      .set({
        holderId: holder.id,
        claimedAt: nowIso,
        heartbeatAt: nowIso,
        expiresAt,
        lastActivityAt: nowIso,
        sessionId,
        updatedAt: nowIso,
      })
      .where(eq(claimLeases.id, existing.id))
      .run();
    return readLease(entityType, entityId) as ClaimLeaseRow;
  }

  try {
    db.insert(claimLeases)
      .values({
        id: createId(),
        entityType,
        entityId,
        holderId: holder.id,
        claimedAt: nowIso,
        heartbeatAt: nowIso,
        expiresAt,
        lastActivityAt: nowIso,
        sessionId,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();
  } catch {
    // Race: another caller inserted the same (entityType, entityId) between our
    // readLease and INSERT. The unique index rejected us — UPDATE in place so
    // this caller's claim still wins (acquire is an overwrite).
    const raced = readLease(entityType, entityId);
    if (raced) {
      db.update(claimLeases)
        .set({
          holderId: holder.id,
          claimedAt: nowIso,
          heartbeatAt: nowIso,
          expiresAt,
          lastActivityAt: nowIso,
          sessionId,
          updatedAt: nowIso,
        })
        .where(eq(claimLeases.id, raced.id))
        .run();
    }
  }

  return readLease(entityType, entityId) as ClaimLeaseRow;
}

/**
 * Renew — refresh the holder's lease (heartbeat). Returns null (NOT a throw,
 * NOT a 409 — that authz lives in P3) when the lease is absent or held by a
 * different identity. Renewal ignores staleness: a holder still inside the
 * grace window can heal a lapsed-but-not-yet-swept lease.
 */
export function renewLease(
  entityType: LeaseEntityType,
  entityId: string,
  holder: Actor,
  opts?: { now?: Date; ttlMs?: number },
): ClaimLeaseRow | null {
  const lease = readLease(entityType, entityId);
  if (!lease || lease.holderId !== holder.id) return null;

  const db = getDb();
  const now = opts?.now ?? new Date();
  const nowIso = now.toISOString();
  const ttlMs = opts?.ttlMs ?? LEASE_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  db.update(claimLeases)
    .set({
      heartbeatAt: nowIso,
      expiresAt,
      lastActivityAt: nowIso,
      updatedAt: nowIso,
    })
    .where(eq(claimLeases.id, lease.id))
    .run();

  return readLease(entityType, entityId);
}

/**
 * Delete — tear down the lease for (entityType, entityId). Idempotent: a
 * missing lease is a no-op. The teardown primitive for release/terminal/
 * unassign paths (P3), where the holder is going away so the lease must too.
 */
export function deleteLease(
  entityType: LeaseEntityType,
  entityId: string,
): void {
  getDb()
    .delete(claimLeases)
    .where(
      and(
        eq(claimLeases.entityType, entityType),
        eq(claimLeases.entityId, entityId),
      ),
    )
    .run();
}

// ─── Stale-claim sweep ────────────────────────────────────────────

export interface SweepObservation {
  entityType: LeaseEntityType;
  entityId: string;
  holderId: string;
  expiresAt: string;
}

export interface SweepResult {
  reclaimed: SweepObservation[];
  observed: SweepObservation[];
}

/**
 * Opportunistic stale-claim sweep — the lease engine's reclaim primitive.
 *
 *  - mode `off`    → inert (early return). Byte-identical to pre-C2.
 *  - mode `shadow` → DETECT only: lapsed leases are pushed to `observed`, but
 *    NOTHING is cleared/deleted/audited/emitted (the safe-rollout rung).
 *  - mode `on`     → RECLAIM: each lapsed lease runs the reclaim txn (clear the
 *    holder + delete the lease + audit, atomic) and is pushed to `reclaimed`.
 *
 * Candidate selection is O(1) when `entityId` is supplied (single lease);
 * otherwise a bounded batch driven by idx_claim_leases_type_expires (expired
 * leases of `entityType`, oldest-expiry first, capped at `limit ?? 50`).
 * Liveness is re-checked per candidate via deriveLiveness — a row whose expiry
 * is within grace, or whose holder is already null, is skipped.
 */
export function sweepStaleClaims(opts: {
  entityType: LeaseEntityType;
  entityId?: string;
  limit?: number;
  mode?: LeaseMode;
  graceMs?: number;
  now?: Date;
  actorId?: string;
}): SweepResult {
  const result: SweepResult = { reclaimed: [], observed: [] };

  const mode = opts.mode ?? LEASE_MODE;
  if (mode === "off") return result;

  const db = getDb();
  const now = opts.now ?? new Date();
  const graceMs = opts.graceMs ?? LEASE_GRACE_MS;
  const { entityType } = opts;

  let candidates: ClaimLeaseRow[];
  if (opts.entityId != null) {
    const one = readLease(entityType, opts.entityId);
    candidates = one ? [one] : [];
  } else {
    // The reclaim-sweep hot path: lapsed leases of this type, oldest first.
    // `lt(expiresAt, now - graceMs)` is a cheap index pre-filter; the precise
    // boundary is re-checked per-candidate by deriveLiveness below.
    const staleThresholdIso = new Date(now.getTime() - graceMs).toISOString();
    candidates = db
      .select()
      .from(claimLeases)
      .where(
        and(
          eq(claimLeases.entityType, entityType),
          lt(claimLeases.expiresAt, staleThresholdIso),
        ),
      )
      .orderBy(asc(claimLeases.expiresAt))
      .limit(opts.limit ?? 50)
      .all() as ClaimLeaseRow[];
  }

  for (const lease of candidates) {
    if (lease.holderId == null) continue;
    if (deriveLiveness(now, lease.expiresAt, graceMs) === "live") continue;

    const observation: SweepObservation = {
      entityType,
      entityId: lease.entityId,
      holderId: lease.holderId,
      expiresAt: lease.expiresAt,
    };

    if (mode === "shadow") {
      // Detect only — never mutate.
      result.observed.push(observation);
      continue;
    }

    // mode === "on": reclaim. A txn that aborts (entity missing, no project,
    // or a concurrent renew re-armed the lease) is a no-op for this candidate.
    if (reclaimOne(entityType, lease, now, opts.actorId)) {
      result.reclaimed.push(observation);
    }
  }

  return result;
}

/**
 * Reclaim a single lapsed lease (mode `on`). Clears the entity's holder, deletes
 * the lease under an atomic holder guard, and writes a `claim_reclaimed` audit
 * row — all inside one txn (mirrors forceClaim claim-helpers.ts:176-242). Emits
 * the domain event + audit.recorded AFTER commit. Returns true if the reclaim
 * landed, false if it aborted (treat as still-live).
 */
function reclaimOne(
  entityType: LeaseEntityType,
  lease: ClaimLeaseRow,
  now: Date,
  actorId?: string,
): boolean {
  const cfg = ENTITY_CFG[entityType];
  const db = getDb();
  const nowIso = now.toISOString();
  const { entityId } = lease;

  // Load the entity. A lease pointing at a vanished entity is unreclaimable
  // (nothing to clear, and no projectId to audit against) — skip, but WARN
  // (C2 de-silence): a silently-skipped candidate would otherwise look like a
  // healthy live claim forever.
  const entityRow = db
    .select()
    .from(cfg.table)
    .where(eq(cfg.table.id, entityId))
    .get() as EntityRow | undefined;
  if (!entityRow) {
    console.warn(
      `[claim-lease] reclaim skipped: ${entityType} ${entityId} has a lapsed lease but the entity row is gone (unreclaimable; lease left in place)`,
    );
    return false;
  }

  // audit_log.projectId is NOT NULL — a proposal with a null projectId cannot
  // be audited, so refuse before the txn (uniform with forceClaim FOLDED-FIX 1;
  // harmless for tasks/epics whose projectId is NOT NULL). WARN (C2): the
  // skip is permanent for this entity, so it must be visible.
  const projectId = entityRow.projectId;
  if (projectId == null) {
    console.warn(
      `[claim-lease] reclaim skipped: ${entityType} ${entityId} has a null projectId (cannot write the NOT-NULL audit row; lease left in place)`,
    );
    return false;
  }

  // TOCTOU re-read: capture the holder at txn-entry time. Non-null by the
  // candidate construction above, but re-read so the audit `before` is honest.
  const fresh = readLease(entityType, entityId);
  if (!fresh || fresh.holderId == null) return false;
  const oldHolder = fresh.holderId;

  const auditActorId = actorId ?? oldHolder;
  let auditId: string | null = null;
  let auditView: AuditLogView | null = null;

  try {
    db.transaction((tx) => {
      // Clear the holder via the computed-key Record idiom (house pattern — NOT
      // a computed literal into .set()).
      const values: Record<string, unknown> = {
        [cfg.holderKey]: null,
        updatedAt: nowIso,
      };
      tx.update(cfg.table).set(values).where(eq(cfg.table.id, entityId)).run();

      // Delete the lease under an atomic guard: if a concurrent renew re-armed
      // it to a (possibly different) holder, the holderId no longer matches and
      // the delete affects 0 rows — abort this reclaim (treat as live).
      const del = tx
        .delete(claimLeases)
        .where(
          and(eq(claimLeases.id, fresh.id), eq(claimLeases.holderId, oldHolder)),
        )
        .run();
      if (del.changes === 0) {
        throw new ReclaimAborted();
      }

      const before = { [cfg.holderJsonKey]: oldHolder };
      const after = { [cfg.holderJsonKey]: null };
      auditId = recordAudit(tx, {
        projectId,
        actorId: auditActorId,
        action: "claim_reclaimed",
        targetType: cfg.auditTargetType,
        targetId: entityId,
        reason: "lease lapsed (TTL+grace exceeded)",
        before,
        after,
        now: nowIso,
      });
      auditView = {
        id: auditId,
        projectId,
        actorId: auditActorId,
        action: "claim_reclaimed",
        targetType: cfg.auditTargetType,
        targetId: entityId,
        reason: "lease lapsed (TTL+grace exceeded)",
        metadataBefore: before,
        metadataAfter: after,
        createdAt: nowIso,
      };
    });
  } catch (err) {
    // A concurrent renew re-armed the lease (the atomic delete guard caught it)
    // — the txn rolled back, so nothing was mutated. Treat the candidate as
    // still-live and skip it. Any other error is genuine — re-throw.
    if (err instanceof ReclaimAborted) return false;
    throw err;
  }

  // After commit: emit the domain event + audit.recorded.
  const updated = db
    .select()
    .from(cfg.table)
    .where(eq(cfg.table.id, entityId))
    .get() as EntityRow;
  getEventBus().emit(EVENT_NAMES.CLAIM_LEASE_RECLAIMED, {
    entity: updated,
    entityType: cfg.auditTargetType,
    entityId,
    projectId,
    actorId: auditActorId,
    timestamp: nowIso,
    changes: { [cfg.holderJsonKey]: { from: oldHolder, to: null } },
  });
  if (auditId !== null && auditView !== null) {
    emitAuditRecorded(auditId, projectId, auditActorId, auditView);
  }

  return true;
}

/**
 * Sentinel thrown inside the reclaim txn when the atomic delete guard catches a
 * concurrent renew. better-sqlite3 rolls the txn back; reclaimOne swallows it
 * and returns false (the candidate is treated as still-live).
 */
class ReclaimAborted extends Error {}
