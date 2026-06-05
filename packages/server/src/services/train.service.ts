import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  comments,
  getDb,
  mergeAttempts,
  mergeLocks,
  mergeRequests,
  projects,
  trainState,
} from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";
import {
  emitAuditRecorded,
  record as recordAudit,
  type AuditLogView,
} from "./audit.service.js";
import {
  attachLandedRef,
  type Actor,
} from "./merge-request.service.js";
import { assertMemberLandableViaGroup } from "./merge-group.service.js";

// ─── Types ────────────────────────────────────────────────────────
//
// Reuses the Actor {id, role, type} shape from merge-request.service. Every
// break-glass override here is a HUMAN admin action — it MUST NOT delegate to
// the ai_agent-gated public service functions land()/reject()/startAttempt()/
// completeAttempt(), all of which throw 403 for a human actor. The row writes
// are performed DIRECTLY inside each override's own db.transaction (the
// tx-internal attachLandedRef helper is already non-gated and reusable).

export interface TrainStateView {
  id: string;
  projectId: string;
  resource: string;
  state: string; // "running" | "paused"
  changedBy: string | null;
  reason: string | null;
  changedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Internal row shapes ──────────────────────────────────────────

interface TrainStateRow {
  id: string;
  projectId: string;
  resource: string;
  state: string;
  changedBy: string | null;
  reason: string | null;
  changedAt: string | null;
  stuckNotified: boolean;
  abandonNotified: boolean;
  stalledNotified: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MergeLockRow {
  id: string;
  projectId: string;
  resource: string;
  holderId: string | null;
  acquiredAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
  landedSha: string | null;
  landedAt: string | null;
  taskId: string | null;
  branch: string | null;
  commitSha: string | null;
  verifyCmd: string | null;
  worktreePath: string | null;
  abandonReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MergeRequestRow {
  id: string;
  projectId: string;
  resource: string;
  submittedBy: string;
  taskId: string | null;
  branch: string | null;
  commitSha: string | null;
  verifyCmd: string | null;
  worktreePath: string | null;
  status: string;
  enqueuedAt: string;
  pickedUpAt: string | null;
  resolvedAt: string | null;
  landedSha: string | null;
  rejectCategory: string | null;
  rejectReason: string | null;
  failedFiles: string[] | null;
  logExcerpt: string | null;
  logUrl: string | null;
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

function readTrainState(
  projectId: string,
  resource: string,
): TrainStateRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(trainState)
    .where(
      and(
        eq(trainState.projectId, projectId),
        eq(trainState.resource, resource),
      ),
    )
    .get() as TrainStateRow | undefined;
}

/**
 * Return the train_state row for (projectId, resource), creating it lazily on
 * first contact defaulting to "running" (the getOrCreateLock idiom). The
 * INSERT is guarded by try/catch for the unique-index race (two concurrent
 * first reads) — on rejection we re-read.
 */
function getOrCreateTrainState(
  projectId: string,
  resource: string,
): TrainStateRow {
  const existing = readTrainState(projectId, resource);
  if (existing) return existing;

  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();
  try {
    db.insert(trainState)
      .values({
        id,
        projectId,
        resource,
        state: "running",
        changedBy: null,
        reason: null,
        changedAt: null,
        stuckNotified: false,
        abandonNotified: false,
        stalledNotified: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch {
    // Race: another caller inserted the same (project, resource) between our
    // SELECT and INSERT. The unique index rejected us — re-read.
  }
  return readTrainState(projectId, resource)!;
}

function readLock(
  projectId: string,
  resource: string,
): MergeLockRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(mergeLocks)
    .where(
      and(eq(mergeLocks.projectId, projectId), eq(mergeLocks.resource, resource)),
    )
    .get() as MergeLockRow | undefined;
}

/**
 * Lazily provision the lock row so force-release has a target even if the
 * lock was never acquired (mirrors merge-lock.service:getOrCreateLock). The
 * INSERT is race-guarded by the unique index.
 */
function getOrCreateLock(projectId: string, resource: string): MergeLockRow {
  const existing = readLock(projectId, resource);
  if (existing) return existing;

  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();
  try {
    db.insert(mergeLocks)
      .values({
        id,
        projectId,
        resource,
        holderId: null,
        acquiredAt: null,
        heartbeatAt: null,
        expiresAt: null,
        landedSha: null,
        landedAt: null,
        taskId: null,
        branch: null,
        commitSha: null,
        verifyCmd: null,
        worktreePath: null,
        abandonReason: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch {
    // Unique-index race — re-read below.
  }
  return readLock(projectId, resource)!;
}

function readRequest(id: string): MergeRequestRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(mergeRequests)
    .where(eq(mergeRequests.id, id))
    .get();
  return (row as MergeRequestRow | undefined) ?? null;
}

function requireAdmin(actor: Actor, message: string): void {
  if (actor.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", message);
  }
}

// ─── View projection ──────────────────────────────────────────────

function toTrainStateView(row: TrainStateRow): TrainStateView {
  return {
    id: row.id,
    projectId: row.projectId,
    resource: row.resource,
    state: row.state,
    changedBy: row.changedBy,
    reason: row.reason,
    changedAt: row.changedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Event emit helpers ───────────────────────────────────────────

function emitTrainState(
  event: string,
  row: TrainStateRow,
  actorId: string | null,
  extra?: Record<string, unknown>,
): void {
  getEventBus().emit(event as never, {
    entity: { ...row, ...(extra ?? {}) },
    entityType: "train",
    entityId: row.id,
    projectId: row.projectId,
    actorId,
    timestamp: new Date().toISOString(),
  });
}

function emitLock(
  event: string,
  lock: MergeLockRow,
  actorId: string | null,
  extra?: Record<string, unknown>,
): void {
  getEventBus().emit(event as never, {
    entity: { ...lock, ...(extra ?? {}) },
    entityType: "merge_lock",
    entityId: lock.id,
    projectId: lock.projectId,
    actorId,
    timestamp: new Date().toISOString(),
  });
}

function emitRequest(
  event: string,
  row: MergeRequestRow,
  actorId: string | null,
  extra?: Record<string, unknown>,
): void {
  getEventBus().emit(event as never, {
    entity: { ...row, ...(extra ?? {}) },
    entityType: "merge_request",
    entityId: row.id,
    projectId: row.projectId,
    actorId,
    timestamp: new Date().toISOString(),
  });
}

// ─── Alert latch surface (Step 7 — §7.3) ──────────────────────────
//
// The train.stuck / train.abandon_rate_high edge-trigger flags live on the
// train_state row. To keep ALL train_state writes in one module, these thin
// helpers expose the latch read + single-column set used by
// metrics.service.checkAlerts. The set touches ONLY the named latch column +
// updatedAt — NEVER state/changedBy/reason — so a metrics read can never
// clobber an admin pause (NOTE 1).

export interface TrainAlertLatchRow {
  id: string;
  state: string;
  stuckNotified: boolean;
  abandonNotified: boolean;
  stalledNotified: boolean;
}

/**
 * Read (lazily creating) the lane's train_state latch row. Returns the row id,
 * the current state (for the §7.3 paused guard), and the two alert latches.
 */
export function readAlertLatch(
  projectId: string,
  resource: string,
): TrainAlertLatchRow {
  const row = getOrCreateTrainState(projectId, resource);
  return {
    id: row.id,
    state: row.state,
    stuckNotified: row.stuckNotified,
    abandonNotified: row.abandonNotified,
    stalledNotified: row.stalledNotified,
  };
}

/**
 * Single-COLUMN autocommit UPDATE of one alert latch (stuck or abandon) by row
 * id. Touches ONLY the latch boolean + updatedAt — the pause state surface
 * (state/changedBy/reason) is preserved verbatim. Mirrors the
 * health.service.checkStaleness single-statement latch write.
 */
export function setAlertLatch(
  rowId: string,
  field: "stuckNotified" | "abandonNotified" | "stalledNotified",
  value: boolean,
  now: string,
): void {
  getDb()
    .update(trainState)
    .set(
      field === "stuckNotified"
        ? { stuckNotified: value, updatedAt: now }
        : field === "abandonNotified"
          ? { abandonNotified: value, updatedAt: now }
          : { stalledNotified: value, updatedAt: now },
    )
    .where(eq(trainState.id, rowId))
    .run();
}

// ─── Public API: read ─────────────────────────────────────────────

/**
 * Read the lane's train state (§4.3.6). Lazy-creates the row defaulting to
 * "running". No audit, no emit — a pure read.
 */
export function getTrainState(
  projectId: string,
  resource: string,
): TrainStateView {
  ensureProjectExists(projectId);
  const row = getOrCreateTrainState(projectId, resource);
  return toTrainStateView(row);
}

// ─── Public API: pause / resume (§4.3.1 / §4.3.2) ─────────────────

/**
 * Pause the lane: stop the integrator admitting NEW work (§4.2). Admin-gated.
 * IDEMPOTENT no-op WITHOUT a duplicate audit row when already paused (returns
 * the current row, no txn/write/emit — §4.3.1, the 7.1 terminal-no-op rule).
 * Else: in ONE db.transaction flip state="paused" + record the pause audit
 * row; emit train.paused + audit.recorded AFTER commit.
 */
export function pause(
  projectId: string,
  resource: string,
  actor: Actor,
  reason?: string | null,
): TrainStateView {
  ensureProjectExists(projectId);
  requireAdmin(actor, "Only admins may pause the train.");

  const row = getOrCreateTrainState(projectId, resource);
  if (row.state === "paused") {
    // Idempotent no-op — no audit, no emit.
    return toTrainStateView(row);
  }

  const now = new Date().toISOString();
  const prior = row.state;
  let auditId: string | null = null;
  let auditView: AuditLogView | null = null;

  const db = getDb();
  db.transaction((tx) => {
    tx.update(trainState)
      .set({
        state: "paused",
        changedBy: actor.id,
        reason: reason ?? null,
        changedAt: now,
        updatedAt: now,
      })
      .where(eq(trainState.id, row.id))
      .run();

    const before = { state: prior };
    const after = { state: "paused" };
    auditId = recordAudit(tx, {
      projectId,
      actorId: actor.id,
      action: "pause",
      targetType: "train",
      targetId: resource,
      reason: reason ?? null,
      before,
      after,
      now,
    });
    auditView = {
      id: auditId,
      projectId,
      actorId: actor.id,
      action: "pause",
      targetType: "train",
      targetId: resource,
      reason: reason ?? null,
      metadataBefore: before,
      metadataAfter: after,
      createdAt: now,
    };
  });

  const updated = readTrainState(projectId, resource)!;
  emitTrainState(EVENT_NAMES.TRAIN_PAUSED, updated, actor.id, {
    resource,
    changedBy: actor.id,
    reason: reason ?? null,
  });
  if (auditId !== null && auditView !== null) {
    emitAuditRecorded(auditId, projectId, actor.id, auditView);
  }
  return toTrainStateView(updated);
}

/**
 * Resume the lane: re-enable NEW pickups. Symmetric to pause — admin-gated,
 * idempotent no-op (no audit) when already running.
 */
export function resume(
  projectId: string,
  resource: string,
  actor: Actor,
  reason?: string | null,
): TrainStateView {
  ensureProjectExists(projectId);
  requireAdmin(actor, "Only admins may resume the train.");

  const row = getOrCreateTrainState(projectId, resource);
  if (row.state === "running") {
    // Idempotent no-op — no audit, no emit.
    return toTrainStateView(row);
  }

  const now = new Date().toISOString();
  const prior = row.state;
  let auditId: string | null = null;
  let auditView: AuditLogView | null = null;

  const db = getDb();
  db.transaction((tx) => {
    tx.update(trainState)
      .set({
        state: "running",
        changedBy: actor.id,
        reason: reason ?? null,
        changedAt: now,
        updatedAt: now,
      })
      .where(eq(trainState.id, row.id))
      .run();

    const before = { state: prior };
    const after = { state: "running" };
    auditId = recordAudit(tx, {
      projectId,
      actorId: actor.id,
      action: "resume",
      targetType: "train",
      targetId: resource,
      reason: reason ?? null,
      before,
      after,
      now,
    });
    auditView = {
      id: auditId,
      projectId,
      actorId: actor.id,
      action: "resume",
      targetType: "train",
      targetId: resource,
      reason: reason ?? null,
      metadataBefore: before,
      metadataAfter: after,
      createdAt: now,
    };
  });

  const updated = readTrainState(projectId, resource)!;
  emitTrainState(EVENT_NAMES.TRAIN_RESUMED, updated, actor.id, {
    resource,
    changedBy: actor.id,
    reason: reason ?? null,
  });
  if (auditId !== null && auditView !== null) {
    emitAuditRecorded(auditId, projectId, actor.id, auditView);
  }
  return toTrainStateView(updated);
}

// ─── Public API: force-release-lock (§4.3.3) ──────────────────────

/**
 * Admin force-release of a stuck lane lock — for when an integrator died and
 * the operator doesn't want to wait out the 5-minute LEASE_TTL_MS sweep.
 *
 * PIN 2: HARD CLEAR inline — do NOT call merge-lock.service:release(), which
 * promotes the queue head and emits merge.lock.granted to an unintended
 * waiter. We clear the EXACT field set release()/sweepExpired() clear, WITHOUT
 * any queue promotion. Does NOT touch in-flight merge_requests (a stranded
 * integrating request is reset by the integrator's crash-recovery sweep).
 */
export function forceReleaseLock(
  projectId: string,
  resource: string,
  actor: Actor,
  reason?: string | null,
): MergeLockReleaseView {
  ensureProjectExists(projectId);
  requireAdmin(actor, "Only admins may force-release a merge lock.");

  const lock = getOrCreateLock(projectId, resource);
  const priorHolder = lock.holderId;

  const now = new Date().toISOString();
  let auditId: string | null = null;
  let auditView: AuditLogView | null = null;

  const db = getDb();
  db.transaction((tx) => {
    // HARD CLEAR — the EXACT field set release()/sweepExpired() clear, scoped
    // by (projectId, resource). No queue promotion (PIN 2).
    tx.update(mergeLocks)
      .set({
        holderId: null,
        acquiredAt: null,
        heartbeatAt: null,
        expiresAt: null,
        taskId: null,
        branch: null,
        commitSha: null,
        verifyCmd: null,
        worktreePath: null,
        abandonReason: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(mergeLocks.projectId, projectId),
          eq(mergeLocks.resource, resource),
        ),
      )
      .run();

    const before = { holderId: priorHolder };
    const after = { holderId: null };
    auditId = recordAudit(tx, {
      projectId,
      actorId: actor.id,
      action: "force_release_lock",
      targetType: "merge_lock",
      targetId: resource,
      reason: reason ?? null,
      before,
      after,
      now,
    });
    auditView = {
      id: auditId,
      projectId,
      actorId: actor.id,
      action: "force_release_lock",
      targetType: "merge_lock",
      targetId: resource,
      reason: reason ?? null,
      metadataBefore: before,
      metadataAfter: after,
      createdAt: now,
    };
  });

  const released = readLock(projectId, resource)!;
  // Reuse the existing Stage-1 release event so existing consumers see it.
  emitLock(EVENT_NAMES.MERGE_LOCK_RELEASED, released, actor.id, {
    landedSha: null,
    landedAt: null,
    abandonReason: null,
    forced: true,
    priorHolderId: priorHolder,
  });
  if (auditId !== null && auditView !== null) {
    emitAuditRecorded(auditId, projectId, actor.id, auditView);
  }
  return { ok: true, resource, priorHolderId: priorHolder };
}

export interface MergeLockReleaseView {
  ok: boolean;
  resource: string;
  priorHolderId: string | null;
}

// ─── Public API: force-land (§4.3.4) — THE R1 OVERRIDE ────────────

export interface ForceLandBody {
  landedSha: string;
  reason: string;
}

/**
 * THE R1 OVERRIDE: land a request WITHOUT verify (§4.3.4). The single
 * highest-risk operation in 7.4 — a named human deliberately advances `main`
 * past an unverified tree. The mandatory force_land audit row is the entire
 * accountability mechanism.
 *
 * Admin-only, reason-required. Precondition: integrating (landed → idempotent
 * 200 no-op no-audit; queued/rejected/abandoned → 409). Grouped members → 409
 * (land via the group). Does NOT run git — records the operator-asserted
 * landedSha; PM-state vs git-remote divergence is BY DESIGN (§4.3.4).
 *
 * Does NOT delegate to land()/completeAttempt() (ai_agent-gated → would 403
 * the human admin). All writes inline in ONE db.transaction.
 */
export function forceLand(
  requestId: string,
  body: ForceLandBody,
  actor: Actor,
): MergeRequestView {
  // PRE-tx validation.
  requireAdmin(actor, "Only admins may force-land a merge request.");
  // Service double-check: reason required (route enforces via z.min(1)).
  if (!body.reason || body.reason.trim() === "") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "force-land requires a non-empty reason.",
    );
  }
  if (!body.landedSha || body.landedSha.trim() === "") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "force-land requires a non-empty landedSha.",
    );
  }

  const row = readRequest(requestId);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Merge request not found: ${requestId}`);
  }
  // Grouped members can only land via the group (reuses the existing guard →
  // 409 GROUPED_MEMBER, or 404 if absent).
  assertMemberLandableViaGroup(requestId);

  // Transition guard (force-land variant of the land matrix).
  if (row.status === "landed") {
    // Idempotent 200 no-op — no audit.
    return toRequestView(row);
  }
  if (row.status !== "integrating") {
    throw new AppError(
      409,
      "INVALID_TRANSITION",
      `Cannot force-land merge request ${requestId} from state "${row.status}"`,
    );
  }

  const now = new Date().toISOString();
  let gitRefId: string | null = null;
  let attemptId: string | null = null;
  let auditId: string | null = null;
  let auditView: AuditLogView | null = null;

  const db = getDb();
  db.transaction((tx) => {
    // 1. Complete or synthesize the attempt as passed-with-override.
    const open = tx
      .select({ id: mergeAttempts.id })
      .from(mergeAttempts)
      .where(
        and(
          eq(mergeAttempts.requestId, requestId),
          inArray(mergeAttempts.status, ["pending", "running"]),
        ),
      )
      .orderBy(desc(mergeAttempts.attemptNumber))
      .limit(1)
      .get();

    if (open) {
      attemptId = open.id;
      tx.update(mergeAttempts)
        .set({
          status: "passed",
          completedAt: now,
          treeSha: body.landedSha,
          failureReason: "force_land override (verify bypassed)",
        })
        .where(eq(mergeAttempts.id, open.id))
        .run();
    } else {
      // No open attempt — synthesize a passed/overridden one so the timeline
      // shows the force-land as an attempt, never a phantom land.
      const maxRow = tx
        .select({ m: sql<number | null>`MAX(${mergeAttempts.attemptNumber})` })
        .from(mergeAttempts)
        .where(eq(mergeAttempts.requestId, requestId))
        .get();
      const attemptNumber = Number(maxRow?.m ?? 0) + 1;
      attemptId = createId();
      tx.insert(mergeAttempts)
        .values({
          id: attemptId,
          requestId,
          attemptNumber,
          // PIN 1: baseSha is NOT NULL — use the asserted landedSha.
          baseSha: body.landedSha,
          treeSha: body.landedSha,
          status: "passed",
          startedAt: now,
          completedAt: now,
          verifyDurationMs: null,
          failureCategory: null,
          failureReason: "force_land override (verify bypassed)",
          failedFiles: null,
          logExcerpt: null,
          logUrl: null,
          createdAt: now,
        })
        .run();
    }

    // 2. Land the request — identical durable side-effects to a normal land,
    //    the ONLY difference being that no verify gated it.
    tx.update(mergeRequests)
      .set({
        status: "landed",
        resolvedAt: now,
        landedSha: body.landedSha,
        updatedAt: now,
      })
      .where(eq(mergeRequests.id, requestId))
      .run();

    // 3. Attach the landed_sha git_ref (non-gated tx-internal helper).
    gitRefId = attachLandedRef(tx, {
      requestId,
      taskId: row.taskId,
      landedSha: body.landedSha,
      resource: row.resource,
      now,
    });

    // 4. The mandatory force_land audit row — the sole record R1 was bypassed.
    const before = { status: "integrating", landedSha: null };
    const after = { status: "landed", landedSha: body.landedSha, overridden: true };
    auditId = recordAudit(tx, {
      projectId: row.projectId,
      actorId: actor.id,
      action: "force_land",
      targetType: "merge_request",
      targetId: requestId,
      reason: body.reason,
      before,
      after,
      now,
    });
    auditView = {
      id: auditId,
      projectId: row.projectId,
      actorId: actor.id,
      action: "force_land",
      targetType: "merge_request",
      targetId: requestId,
      reason: body.reason,
      metadataBefore: before,
      metadataAfter: after,
      createdAt: now,
    };
  });

  const updated = readRequest(requestId)!;
  // Emit MERGE_REQUEST_LANDED with overridden:true so the dashboard badges it.
  emitRequest(EVENT_NAMES.MERGE_REQUEST_LANDED, updated, actor.id, {
    landedSha: body.landedSha,
    gitRefId,
    attemptId,
    overridden: true,
  });
  if (auditId !== null && auditView !== null) {
    emitAuditRecorded(auditId, row.projectId, actor.id, auditView);
  }
  return toRequestView(updated);
}

// ─── Public API: force-reject (§4.3.5) ────────────────────────────

export interface ForceRejectBody {
  reason: string;
}

/**
 * Admin force-reject of a stuck integrating request (§4.3.5). Admin-only,
 * reason-required. Precondition: integrating (rejected → idempotent 200
 * no-op no-audit; other → 409). Completes/synthesizes the attempt as
 * failed/policy, sets the request rejected (policy), replicates the
 * merge_rejection comment, writes ONE force_reject audit. Does NOT delegate to
 * the ai_agent-gated reject()/completeAttempt().
 */
export function forceReject(
  requestId: string,
  body: ForceRejectBody,
  actor: Actor,
): MergeRequestView {
  requireAdmin(actor, "Only admins may force-reject a merge request.");
  if (!body.reason || body.reason.trim() === "") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "force-reject requires a non-empty reason.",
    );
  }

  const row = readRequest(requestId);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Merge request not found: ${requestId}`);
  }

  if (row.status === "rejected") {
    // Idempotent 200 no-op — no audit.
    return toRequestView(row);
  }
  if (row.status !== "integrating") {
    throw new AppError(
      409,
      "INVALID_TRANSITION",
      `Cannot force-reject merge request ${requestId} from state "${row.status}"`,
    );
  }

  const now = new Date().toISOString();
  let commentId: string | null = null;
  let attemptId: string | null = null;
  let auditId: string | null = null;
  let auditView: AuditLogView | null = null;

  const db = getDb();
  db.transaction((tx) => {
    // Complete or synthesize the attempt as failed/policy.
    const open = tx
      .select({
        id: mergeAttempts.id,
        baseSha: mergeAttempts.baseSha,
      })
      .from(mergeAttempts)
      .where(
        and(
          eq(mergeAttempts.requestId, requestId),
          inArray(mergeAttempts.status, ["pending", "running"]),
        ),
      )
      .orderBy(desc(mergeAttempts.attemptNumber))
      .limit(1)
      .get();

    if (open) {
      attemptId = open.id;
      tx.update(mergeAttempts)
        .set({
          status: "failed",
          completedAt: now,
          failureCategory: "policy",
          failureReason: body.reason,
        })
        .where(eq(mergeAttempts.id, open.id))
        .run();
    } else {
      const maxRow = tx
        .select({ m: sql<number | null>`MAX(${mergeAttempts.attemptNumber})` })
        .from(mergeAttempts)
        .where(eq(mergeAttempts.requestId, requestId))
        .get();
      const attemptNumber = Number(maxRow?.m ?? 0) + 1;
      attemptId = createId();
      tx.insert(mergeAttempts)
        .values({
          id: attemptId,
          requestId,
          attemptNumber,
          // baseSha is NOT NULL; a forced reject with no real verify has no
          // SHA — use "".
          baseSha: "",
          treeSha: null,
          status: "failed",
          startedAt: now,
          completedAt: now,
          verifyDurationMs: null,
          failureCategory: "policy",
          failureReason: body.reason,
          failedFiles: null,
          logExcerpt: null,
          logUrl: null,
          createdAt: now,
        })
        .run();
    }

    // Set the request rejected (policy).
    tx.update(mergeRequests)
      .set({
        status: "rejected",
        resolvedAt: now,
        rejectCategory: "policy",
        rejectReason: body.reason,
        updatedAt: now,
      })
      .where(eq(mergeRequests.id, requestId))
      .run();

    // Replicate the reject() merge_rejection comment (guard taskId != null).
    if (row.taskId !== null) {
      commentId = createId();
      const commentBody =
        `Merge rejected: policy.\n\n${body.reason}\n\n` +
        `0 failed file(s).\n` +
        `See log: (none)`;
      tx.insert(comments)
        .values({
          id: commentId,
          taskId: row.taskId,
          proposalId: null,
          authorId: actor.id,
          body: commentBody,
          commentType: "merge_rejection",
          metadata: {
            mergeRequestId: requestId,
            attemptId,
            category: "policy",
            reason: body.reason,
            failedFiles: [],
            logExcerpt: null,
            logUrl: null,
            baseSha: null,
            overridden: true,
          },
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const before = { status: "integrating" };
    const after = {
      status: "rejected",
      rejectCategory: "policy",
      overridden: true,
    };
    auditId = recordAudit(tx, {
      projectId: row.projectId,
      actorId: actor.id,
      action: "force_reject",
      targetType: "merge_request",
      targetId: requestId,
      reason: body.reason,
      before,
      after,
      now,
    });
    auditView = {
      id: auditId,
      projectId: row.projectId,
      actorId: actor.id,
      action: "force_reject",
      targetType: "merge_request",
      targetId: requestId,
      reason: body.reason,
      metadataBefore: before,
      metadataAfter: after,
      createdAt: now,
    };
  });

  const updated = readRequest(requestId)!;
  emitRequest(EVENT_NAMES.MERGE_REQUEST_REJECTED, updated, actor.id, {
    attemptId,
    commentId,
    category: "policy",
    reason: body.reason,
    overridden: true,
  });
  if (auditId !== null && auditView !== null) {
    emitAuditRecorded(auditId, row.projectId, actor.id, auditView);
  }
  return toRequestView(updated);
}

// ─── Merge-request view (mirrors merge-request.service.toView) ─────

export interface MergeRequestView {
  id: string;
  projectId: string;
  resource: string;
  submittedBy: string;
  taskId: string | null;
  branch: string | null;
  commitSha: string | null;
  verifyCmd: string | null;
  worktreePath: string | null;
  status: string;
  enqueuedAt: string;
  pickedUpAt: string | null;
  resolvedAt: string | null;
  landedSha: string | null;
  rejectCategory: string | null;
  rejectReason: string | null;
  failedFiles: string[] | null;
  logExcerpt: string | null;
  logUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRequestView(row: MergeRequestRow): MergeRequestView {
  return {
    id: row.id,
    projectId: row.projectId,
    resource: row.resource,
    submittedBy: row.submittedBy,
    taskId: row.taskId,
    branch: row.branch,
    commitSha: row.commitSha,
    verifyCmd: row.verifyCmd,
    worktreePath: row.worktreePath,
    status: row.status,
    enqueuedAt: row.enqueuedAt,
    pickedUpAt: row.pickedUpAt,
    resolvedAt: row.resolvedAt,
    landedSha: row.landedSha,
    rejectCategory: row.rejectCategory,
    rejectReason: row.rejectReason,
    failedFiles: row.failedFiles,
    logExcerpt: row.logExcerpt,
    logUrl: row.logUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
