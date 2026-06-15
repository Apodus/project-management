import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import type {
  MergeLockAcquireResult,
  MergeLockHeartbeatResult,
  MergeLockLandingIntent,
  MergeLockReleaseResult,
  MergeLockView,
} from "@pm/shared";
import { getDb, mergeLocks, mergeLockQueue, projects, tasks, users } from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";

// ─── Constants ────────────────────────────────────────────────────

// Long enough to cover a 3–5 min rebase + verify build with a safety
// margin, short enough that a crashed holder doesn't wedge the train.
export const LEASE_TTL_MS = 5 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────

export interface Actor {
  id: string;
}

export type LandingIntent = MergeLockLandingIntent;

// ─── Internal helpers ─────────────────────────────────────────────

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

interface QueueRow {
  id: string;
  lockId: string;
  userId: string;
  enqueuedAt: string;
  notifiedAt: string | null;
  taskId: string | null;
  branch: string | null;
  commitSha: string | null;
  verifyCmd: string | null;
  worktreePath: string | null;
}

/**
 * Project-shared fields of a landing intent. Excludes worktreePath
 * because that's per-machine and undefined for non-holders.
 */
function landingFieldsFrom(intent: LandingIntent | null | undefined): {
  taskId: string | null;
  branch: string | null;
  commitSha: string | null;
  verifyCmd: string | null;
  worktreePath: string | null;
} {
  return {
    taskId: intent?.taskId ?? null,
    branch: intent?.branch ?? null,
    commitSha: intent?.commitSha ?? null,
    verifyCmd: intent?.verifyCmd ?? null,
    worktreePath: intent?.worktreePath ?? null,
  };
}

function validateIntent(projectId: string, intent: LandingIntent | undefined): void {
  if (!intent?.taskId) return;
  const db = getDb();
  const task = db
    .select({ id: tasks.id, projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, intent.taskId))
    .get();
  if (!task) {
    throw new AppError(404, "NOT_FOUND", `Task not found: ${intent.taskId}`);
  }
  if (task.projectId !== projectId) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Task ${intent.taskId} does not belong to project ${projectId}`,
    );
  }
}

function ensureProjectExists(projectId: string): void {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }
}

/**
 * Return the lock row for (projectId, resource), creating it lazily on
 * first contact so callers don't need a separate provisioning step.
 */
function getOrCreateLock(projectId: string, resource: string): MergeLockRow {
  const db = getDb();
  const existing = db
    .select()
    .from(mergeLocks)
    .where(and(eq(mergeLocks.projectId, projectId), eq(mergeLocks.resource, resource)))
    .get();
  if (existing) return existing as MergeLockRow;

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
    // Race: another caller inserted the same (project, resource) between
    // our SELECT and INSERT. The unique index rejected us — re-read.
  }
  const fresh = db
    .select()
    .from(mergeLocks)
    .where(and(eq(mergeLocks.projectId, projectId), eq(mergeLocks.resource, resource)))
    .get();
  return fresh as MergeLockRow;
}

function readLock(lockId: string): MergeLockRow {
  const db = getDb();
  const row = db.select().from(mergeLocks).where(eq(mergeLocks.id, lockId)).get();
  return row as MergeLockRow;
}

function queueHead(lockId: string) {
  const db = getDb();
  return db
    .select()
    .from(mergeLockQueue)
    .where(eq(mergeLockQueue.lockId, lockId))
    .orderBy(asc(mergeLockQueue.enqueuedAt))
    .limit(1)
    .get();
}

function queueLength(lockId: string): number {
  const db = getDb();
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(mergeLockQueue)
    .where(eq(mergeLockQueue.lockId, lockId))
    .get();
  return Number(row?.c ?? 0);
}

function positionForUser(lockId: string, userId: string): number | null {
  const db = getDb();
  const mine = db
    .select()
    .from(mergeLockQueue)
    .where(and(eq(mergeLockQueue.lockId, lockId), eq(mergeLockQueue.userId, userId)))
    .get();
  if (!mine) return null;
  const ahead = db
    .select({ c: sql<number>`count(*)` })
    .from(mergeLockQueue)
    .where(and(eq(mergeLockQueue.lockId, lockId), lt(mergeLockQueue.enqueuedAt, mine.enqueuedAt)))
    .get();
  return Number(ahead?.c ?? 0) + 1;
}

function emit(
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

/**
 * If the current holder's lease has elapsed, evict them and promote the
 * queue head atomically. Called opportunistically at the top of every
 * public operation. Returns true if a sweep happened.
 */
function sweepExpired(lockId: string): boolean {
  const db = getDb();
  const lock = readLock(lockId);
  if (!lock || !lock.holderId || !lock.expiresAt) return false;
  const now = new Date();
  if (new Date(lock.expiresAt) > now) return false;

  const evictedHolder = lock.holderId;
  const nowIso = now.toISOString();

  // Free the slot — also clears the evicted holder's landing intent
  // since it no longer reflects what's about to land. Preserves
  // landed_sha/landed_at and clears any prior abandon_reason.
  db.update(mergeLocks)
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
      updatedAt: nowIso,
    })
    .where(eq(mergeLocks.id, lockId))
    .run();

  const freed = readLock(lockId);
  emit(EVENT_NAMES.MERGE_LOCK_EXPIRED, freed, null, {
    evictedHolderId: evictedHolder,
  });

  const head = queueHead(lockId) as QueueRow | undefined;
  if (head) {
    db.delete(mergeLockQueue).where(eq(mergeLockQueue.id, head.id)).run();
    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
    // Promote: copy the queue entry's landing intent onto the lock row.
    db.update(mergeLocks)
      .set({
        holderId: head.userId,
        acquiredAt: nowIso,
        heartbeatAt: nowIso,
        expiresAt,
        taskId: head.taskId,
        branch: head.branch,
        commitSha: head.commitSha,
        verifyCmd: head.verifyCmd,
        worktreePath: head.worktreePath,
        updatedAt: nowIso,
      })
      .where(eq(mergeLocks.id, lockId))
      .run();
    const promoted = readLock(lockId);
    emit(EVENT_NAMES.MERGE_LOCK_GRANTED, promoted, head.userId);
  }
  return true;
}

// ─── View ─────────────────────────────────────────────────────────

function toView(lock: MergeLockRow, callerId: string | null): MergeLockView {
  const callerHolds = callerId !== null && lock.holderId === callerId;
  const holder = !lock.holderId ? "none" : callerHolds ? "you" : "someone_else";
  return {
    id: lock.id,
    projectId: lock.projectId,
    resource: lock.resource,
    holder,
    holderId: callerHolds ? lock.holderId : null,
    acquiredAt: lock.acquiredAt,
    heartbeatAt: lock.heartbeatAt,
    expiresAt: lock.expiresAt,
    landedSha: lock.landedSha,
    landedAt: lock.landedAt,
    taskId: lock.taskId,
    branch: lock.branch,
    commitSha: lock.commitSha,
    verifyCmd: lock.verifyCmd,
    worktreePath: lock.worktreePath,
    abandonReason: lock.abandonReason,
    queueLength: queueLength(lock.id),
    yourPosition: callerId ? positionForUser(lock.id, callerId) : null,
    createdAt: lock.createdAt,
    updatedAt: lock.updatedAt,
  };
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Acquire the lock for `actor`, or join the FIFO queue if held by
 * someone else. Idempotent for the current holder. The atomic claim
 * uses `WHERE holder_id IS NULL` + an `update.changes === 0` race
 * check so two concurrent callers can't both win.
 */
export function acquire(
  projectId: string,
  resource: string,
  actor: Actor,
  intent?: LandingIntent,
): MergeLockAcquireResult {
  ensureProjectExists(projectId);
  ensureUserExists(actor.id);
  validateIntent(projectId, intent);
  const lock = getOrCreateLock(projectId, resource);
  sweepExpired(lock.id);

  const db = getDb();
  const fresh = readLock(lock.id);
  const intentFields = landingFieldsFrom(intent);

  if (fresh.holderId === actor.id) {
    // Idempotent — but if the caller passed new intent fields, merge
    // them in so they can update branch/sha/etc on retry without
    // releasing first.
    if (intent) {
      const merged: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
      };
      if (intent.taskId !== undefined) merged.taskId = intent.taskId;
      if (intent.branch !== undefined) merged.branch = intent.branch;
      if (intent.commitSha !== undefined) merged.commitSha = intent.commitSha;
      if (intent.verifyCmd !== undefined) merged.verifyCmd = intent.verifyCmd;
      if (intent.worktreePath !== undefined) {
        merged.worktreePath = intent.worktreePath;
      }
      db.update(mergeLocks).set(merged).where(eq(mergeLocks.id, lock.id)).run();
    }
    return { ok: true, status: "already_held", expiresAt: fresh.expiresAt };
  }

  if (!fresh.holderId) {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
    const upd = db
      .update(mergeLocks)
      .set({
        holderId: actor.id,
        acquiredAt: nowIso,
        heartbeatAt: nowIso,
        expiresAt,
        taskId: intentFields.taskId,
        branch: intentFields.branch,
        commitSha: intentFields.commitSha,
        verifyCmd: intentFields.verifyCmd,
        worktreePath: intentFields.worktreePath,
        // Clear any prior abandon reason — fresh attempt.
        abandonReason: null,
        updatedAt: nowIso,
      })
      .where(and(eq(mergeLocks.id, lock.id), isNull(mergeLocks.holderId)))
      .run();
    if (upd.changes === 0) {
      // Race: someone else acquired between sweep and update. Fall
      // through to the queued branch.
    } else {
      const held = readLock(lock.id);
      emit(EVENT_NAMES.MERGE_LOCK_ACQUIRED, held, actor.id);
      return { ok: true, status: "held", expiresAt };
    }
  }

  // Held by another agent — enqueue (idempotently). If the caller
  // already has a queue entry and passed new intent fields, update them.
  const existing = db
    .select()
    .from(mergeLockQueue)
    .where(and(eq(mergeLockQueue.lockId, lock.id), eq(mergeLockQueue.userId, actor.id)))
    .get();
  if (!existing) {
    db.insert(mergeLockQueue)
      .values({
        id: createId(),
        lockId: lock.id,
        userId: actor.id,
        enqueuedAt: new Date().toISOString(),
        notifiedAt: null,
        taskId: intentFields.taskId,
        branch: intentFields.branch,
        commitSha: intentFields.commitSha,
        verifyCmd: intentFields.verifyCmd,
        worktreePath: intentFields.worktreePath,
      })
      .run();
    const after = readLock(lock.id);
    emit(EVENT_NAMES.MERGE_LOCK_QUEUED, after, actor.id);
  } else if (intent) {
    const merged: Record<string, unknown> = {};
    if (intent.taskId !== undefined) merged.taskId = intent.taskId;
    if (intent.branch !== undefined) merged.branch = intent.branch;
    if (intent.commitSha !== undefined) merged.commitSha = intent.commitSha;
    if (intent.verifyCmd !== undefined) merged.verifyCmd = intent.verifyCmd;
    if (intent.worktreePath !== undefined) {
      merged.worktreePath = intent.worktreePath;
    }
    if (Object.keys(merged).length > 0) {
      db.update(mergeLockQueue).set(merged).where(eq(mergeLockQueue.id, existing.id)).run();
    }
  }
  return {
    ok: true,
    status: "queued",
    position: positionForUser(lock.id, actor.id),
  };
}

/**
 * Refresh the holder's lease. Returns `not_holder` if `actor` doesn't
 * currently hold the lock (including the case where their lease was
 * already swept).
 */
export function heartbeat(
  projectId: string,
  resource: string,
  actor: Actor,
): MergeLockHeartbeatResult {
  ensureProjectExists(projectId);
  const lock = getOrCreateLock(projectId, resource);
  sweepExpired(lock.id);

  const fresh = readLock(lock.id);
  if (fresh.holderId !== actor.id) {
    return { ok: false, status: "not_holder" };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
  const db = getDb();
  db.update(mergeLocks)
    .set({ heartbeatAt: nowIso, expiresAt, updatedAt: nowIso })
    .where(eq(mergeLocks.id, lock.id))
    .run();
  return { ok: true, status: "refreshed", expiresAt };
}

/**
 * Release the lock. Optionally records `landedSha` so the release event
 * doubles as a "main moved at <sha>" announcement. Promotes the queue
 * head atomically and emits `merge.lock.granted` for the new holder.
 */
export function release(
  projectId: string,
  resource: string,
  actor: Actor,
  opts?: { landedSha?: string | null; reason?: string | null },
): MergeLockReleaseResult {
  ensureProjectExists(projectId);
  const lock = getOrCreateLock(projectId, resource);
  sweepExpired(lock.id);

  const fresh = readLock(lock.id);
  if (!fresh.holderId) return { ok: false, status: "not_held" };
  if (fresh.holderId !== actor.id) return { ok: false, status: "not_holder" };

  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();

  const landedSha = opts?.landedSha ?? null;
  // Reason is only meaningful for an abandon (no landed_sha). When the
  // release is a successful land, we drop any reason so the field can't
  // mislead the next holder about why main *didn't* move.
  const abandonReason = !landedSha && opts?.reason ? opts.reason : null;

  const updates: Record<string, unknown> = {
    holderId: null,
    acquiredAt: null,
    heartbeatAt: null,
    expiresAt: null,
    // Clear the landing intent — it applied to this attempt only.
    taskId: null,
    branch: null,
    commitSha: null,
    verifyCmd: null,
    worktreePath: null,
    abandonReason,
    updatedAt: nowIso,
  };
  if (landedSha) {
    updates.landedSha = landedSha;
    updates.landedAt = nowIso;
  }
  db.update(mergeLocks).set(updates).where(eq(mergeLocks.id, lock.id)).run();

  const released = readLock(lock.id);
  emit(EVENT_NAMES.MERGE_LOCK_RELEASED, released, actor.id, {
    landedSha,
    landedAt: landedSha ? nowIso : null,
    abandonReason,
  });

  // Promote queue head if any.
  const head = queueHead(lock.id) as QueueRow | undefined;
  let grantedTo: string | null = null;
  if (head) {
    db.delete(mergeLockQueue).where(eq(mergeLockQueue.id, head.id)).run();
    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
    db.update(mergeLocks)
      .set({
        holderId: head.userId,
        acquiredAt: nowIso,
        heartbeatAt: nowIso,
        expiresAt,
        taskId: head.taskId,
        branch: head.branch,
        commitSha: head.commitSha,
        verifyCmd: head.verifyCmd,
        worktreePath: head.worktreePath,
        // abandonReason from the prior holder remains visible until the
        // new holder lands or themselves abandons; that's intentional —
        // it tells them *why* they're at bat.
        updatedAt: nowIso,
      })
      .where(eq(mergeLocks.id, lock.id))
      .run();
    const promoted = readLock(lock.id);
    emit(EVENT_NAMES.MERGE_LOCK_GRANTED, promoted, head.userId);
    grantedTo = head.userId;
  }

  return { ok: true, status: "released", grantedTo };
}

/**
 * Get the lock view as seen by `actor`. Holder identity is masked to
 * "you" / "someone_else" / "none" so we don't leak other agents' IDs.
 */
export function getLock(projectId: string, resource: string, actor: Actor | null): MergeLockView {
  ensureProjectExists(projectId);
  const lock = getOrCreateLock(projectId, resource);
  sweepExpired(lock.id);
  const fresh = readLock(lock.id);
  return toView(fresh, actor?.id ?? null);
}

/**
 * List all known locks for a project (one row per (project, resource)).
 */
export function listLocks(projectId: string, actor: Actor | null): MergeLockView[] {
  ensureProjectExists(projectId);
  const db = getDb();
  const rows = db
    .select()
    .from(mergeLocks)
    .where(eq(mergeLocks.projectId, projectId))
    .all() as MergeLockRow[];
  // Sweep each before viewing.
  for (const row of rows) sweepExpired(row.id);
  const fresh = db
    .select()
    .from(mergeLocks)
    .where(eq(mergeLocks.projectId, projectId))
    .all() as MergeLockRow[];
  return fresh.map((r) => toView(r, actor?.id ?? null));
}

function ensureUserExists(userId: string): void {
  const db = getDb();
  const u = db.select().from(users).where(eq(users.id, userId)).get();
  if (!u) {
    throw new AppError(404, "NOT_FOUND", `User not found: ${userId}`);
  }
}
