import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import type {
  MergeAttemptComplete,
  MergeAttemptStart,
  MergeAttemptView,
  VerifyStepResult,
} from "@pm/shared";
import { getDb, mergeAttempts, mergeRequests } from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";
import type { Actor } from "./merge-request.service.js";

// ─── Internal row shape ──────────────────────────────────────────
interface MergeAttemptRow {
  id: string;
  requestId: string;
  attemptNumber: number;
  baseSha: string;
  treeSha: string | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  verifyDurationMs: number | null;
  failureCategory: string | null;
  failureReason: string | null;
  failedFiles: string[] | null;
  logExcerpt: string | null;
  logUrl: string | null;
  steps: VerifyStepResult[] | null;
  createdAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────
function readAttempt(id: string): MergeAttemptRow | null {
  const db = getDb();
  const row = db.select().from(mergeAttempts).where(eq(mergeAttempts.id, id)).get();
  return (row as MergeAttemptRow | undefined) ?? null;
}

function readAttemptOrThrow(id: string): MergeAttemptRow {
  const row = readAttempt(id);
  if (!row) throw new AppError(404, "NOT_FOUND", `Merge attempt not found: ${id}`);
  return row;
}

function readRequestStatus(requestId: string): string {
  const db = getDb();
  const row = db
    .select({ status: mergeRequests.status, projectId: mergeRequests.projectId })
    .from(mergeRequests)
    .where(eq(mergeRequests.id, requestId))
    .get();
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Merge request not found: ${requestId}`);
  }
  return row.status;
}

function readRequestProjectId(requestId: string): string {
  const db = getDb();
  const row = db
    .select({ projectId: mergeRequests.projectId })
    .from(mergeRequests)
    .where(eq(mergeRequests.id, requestId))
    .get();
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Merge request not found: ${requestId}`);
  }
  return row.projectId;
}

function toView(row: MergeAttemptRow): MergeAttemptView {
  return {
    id: row.id,
    requestId: row.requestId,
    attemptNumber: row.attemptNumber,
    baseSha: row.baseSha,
    treeSha: row.treeSha,
    status: row.status as MergeAttemptView["status"],
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    verifyDurationMs: row.verifyDurationMs,
    failureCategory: row.failureCategory as MergeAttemptView["failureCategory"],
    failureReason: row.failureReason,
    failedFiles: row.failedFiles,
    logExcerpt: row.logExcerpt,
    logUrl: row.logUrl,
    steps: row.steps ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * SELECT MAX(attempt_number) FROM merge_attempts WHERE request_id = ?
 * Returns max + 1 (1-based monotonic).
 * UNIQUE(requestId, attemptNumber) on the table is the defense-in-depth backstop.
 */
function getNextAttemptNumber(requestId: string): number {
  const db = getDb();
  const row = db
    .select({ m: sql<number | null>`MAX(${mergeAttempts.attemptNumber})` })
    .from(mergeAttempts)
    .where(eq(mergeAttempts.requestId, requestId))
    .get();
  const max = row?.m ?? 0;
  return Number(max) + 1;
}

/**
 * Spread row + extras onto `entity` so SSE consumers see one flat object.
 * Always called AFTER the writing transaction commits.
 */
function emitAttempt(
  event: string,
  row: MergeAttemptRow,
  projectId: string,
  actorId: string | null,
  extra?: Record<string, unknown>,
): void {
  getEventBus().emit(event as never, {
    entity: { ...row, ...(extra ?? {}) },
    entityType: "merge_attempt",
    entityId: row.id,
    projectId,
    actorId,
    timestamp: new Date().toISOString(),
  });
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Start a new attempt. Inserts directly at status="running" (design §5.2
 * permits skipping the pending ceremony).
 *
 * Guard: parent request must be in state "integrating".
 * Authz: actor.type === "ai_agent".
 * Emits MERGE_ATTEMPT_STARTED AFTER the INSERT.
 */
export function startAttempt(
  requestId: string,
  params: MergeAttemptStart,
  actor: Actor,
  tags?: { batchId?: string; speculativePosition?: number },
): MergeAttemptView {
  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only integrator (ai_agent) users may start a merge attempt.",
    );
  }

  const requestStatus = readRequestStatus(requestId);
  if (requestStatus !== "integrating") {
    throw new AppError(
      409,
      "INVALID_TRANSITION",
      `Cannot start attempt for merge request ${requestId} in state "${requestStatus}"`,
    );
  }

  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();
  const attemptNumber = getNextAttemptNumber(requestId);

  db.insert(mergeAttempts)
    .values({
      id,
      requestId,
      attemptNumber,
      baseSha: params.baseSha,
      treeSha: null,
      status: "running",
      startedAt: now,
      completedAt: null,
      verifyDurationMs: null,
      failureCategory: null,
      failureReason: null,
      failedFiles: null,
      logExcerpt: null,
      logUrl: null,
      steps: null,
      createdAt: now,
    })
    .run();

  const row = readAttemptOrThrow(id);
  const projectId = readRequestProjectId(requestId);
  emitAttempt(EVENT_NAMES.MERGE_ATTEMPT_STARTED, row, projectId, actor.id, {
    requestId,
    baseSha: params.baseSha,
    // Phase 7.2: optional batch tags ride the started frame (omitted when absent).
    ...(tags?.batchId !== undefined ? { batchId: tags.batchId } : {}),
    ...(tags?.speculativePosition !== undefined
      ? { speculativePosition: tags.speculativePosition }
      : {}),
  });
  return toView(row);
}

/**
 * Complete an attempt. UPDATEs the attempt row only.
 *
 * Guard: attempt must currently be "running".
 * Authz: actor.type === "ai_agent".
 *
 * Note on one-shot ownership (design §5.2): mergeAttempts has no createdBy
 * column for Month 1, so we cannot enforce "only the starting integrator
 * may complete". The running→terminal state guard + parallelism=1
 * deployment is the practical safeguard.
 *
 * Emits MERGE_ATTEMPT_COMPLETED AFTER the UPDATE.
 */
export function completeAttempt(
  attemptId: string,
  body: MergeAttemptComplete,
  actor: Actor,
): MergeAttemptView {
  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only integrator (ai_agent) users may complete a merge attempt.",
    );
  }

  const existing = readAttemptOrThrow(attemptId);
  if (existing.status !== "running") {
    throw new AppError(
      409,
      "INVALID_TRANSITION",
      `Cannot complete merge attempt ${attemptId} in state "${existing.status}"`,
    );
  }

  const db = getDb();
  const now = new Date().toISOString();
  const startedAtMs = existing.startedAt ? Date.parse(existing.startedAt) : NaN;
  const verifyDurationMs = Number.isFinite(startedAtMs)
    ? Math.max(0, Date.parse(now) - startedAtMs)
    : null;

  const values: Record<string, unknown> = {
    status: body.status,
    completedAt: now,
    verifyDurationMs,
  };
  if (body.status === "passed") {
    values.treeSha = body.treeSha;
    if (body.steps !== undefined) values.steps = body.steps;
  } else if (body.status === "failed") {
    values.failureCategory = body.failureCategory;
    values.failureReason = body.failureReason;
    values.failedFiles = body.failedFiles ?? null;
    values.logExcerpt = body.logExcerpt ?? null;
    values.logUrl = body.logUrl ?? null;
    if (body.steps !== undefined) values.steps = body.steps;
  }
  // "cancelled" sets only status/completedAt/verifyDurationMs.

  db.update(mergeAttempts).set(values).where(eq(mergeAttempts.id, attemptId)).run();

  const updated = readAttemptOrThrow(attemptId);
  const projectId = readRequestProjectId(updated.requestId);
  emitAttempt(
    EVENT_NAMES.MERGE_ATTEMPT_COMPLETED,
    updated,
    projectId,
    actor.id,
    {
      requestId: updated.requestId,
      status: updated.status,
      treeSha: updated.treeSha,
      failureCategory: updated.failureCategory,
      failureReason: updated.failureReason,
    },
  );
  return toView(updated);
}

/**
 * FINDING 1 FIX — write-only, no emissions.
 *
 * Cancel every attempt belonging to `requestId` that is currently in a
 * non-terminal state. Returns the post-update rows so the caller can
 * emit MERGE_ATTEMPT_COMPLETED for each AFTER its surrounding
 * transaction commits.
 *
 * Safe to invoke from inside `db.transaction(...)` because better-sqlite3
 * is single-writer: getDb() calls run inside the outer write context.
 */
export function cancelOpenAttempts(
  requestId: string,
): { cancelledAttempts: MergeAttemptView[] } {
  const db = getDb();
  const now = new Date().toISOString();

  const open = db
    .select()
    .from(mergeAttempts)
    .where(
      and(
        eq(mergeAttempts.requestId, requestId),
        inArray(mergeAttempts.status, ["pending", "running"]),
      ),
    )
    .all() as MergeAttemptRow[];

  if (open.length === 0) {
    return { cancelledAttempts: [] };
  }

  const ids = open.map((a) => a.id);

  db.update(mergeAttempts)
    .set({
      status: "cancelled",
      completedAt: now,
    })
    .where(inArray(mergeAttempts.id, ids))
    .run();

  const updatedRows = db
    .select()
    .from(mergeAttempts)
    .where(inArray(mergeAttempts.id, ids))
    .orderBy(desc(mergeAttempts.attemptNumber))
    .all() as MergeAttemptRow[];

  const cancelledAttempts: MergeAttemptView[] = updatedRows.map((r) => {
    const view = toView(r);
    if (r.startedAt && r.completedAt && view.verifyDurationMs === null) {
      const ms = Date.parse(r.completedAt) - Date.parse(r.startedAt);
      view.verifyDurationMs = Number.isFinite(ms) ? Math.max(0, ms) : null;
    }
    return view;
  });

  return { cancelledAttempts };
}

/**
 * Public emit helper for callers of `cancelOpenAttempts` so they can
 * fire MERGE_ATTEMPT_COMPLETED AFTER their outer transaction commits.
 */
export function emitAttemptCompleted(
  attempt: MergeAttemptView,
  projectId: string,
  actorId: string | null,
  extra?: Record<string, unknown>,
): void {
  getEventBus().emit(EVENT_NAMES.MERGE_ATTEMPT_COMPLETED as never, {
    entity: { ...attempt, ...(extra ?? {}) },
    entityType: "merge_attempt",
    entityId: attempt.id,
    projectId,
    actorId,
    timestamp: new Date().toISOString(),
  });
}
