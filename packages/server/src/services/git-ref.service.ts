import { eq } from "drizzle-orm";
import { createId, GIT_REF_TYPES, GIT_REF_STATUSES } from "@pm/shared";
import { getDb, gitRefs, tasks } from "../db/index.js";
import { AppError } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────

export interface CreateGitRefInput {
  taskId: string;
  refType: string;
  refValue: string;
  url?: string | null;
  title?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateGitRefInput {
  refType?: string;
  refValue?: string;
  url?: string | null;
  title?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
}

// ─── Validation helpers ──────────────────────────────────────────

const VALID_REF_TYPES = new Set<string>(GIT_REF_TYPES);
const VALID_REF_STATUSES = new Set<string>(GIT_REF_STATUSES);

// ─── Service functions ────────────────────────────────────────────

/**
 * List git refs for a task.
 */
export function listByTask(taskId: string) {
  const db = getDb();

  // Verify task exists
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) {
    throw new AppError(404, "NOT_FOUND", `Task not found: ${taskId}`);
  }

  return db.select().from(gitRefs).where(eq(gitRefs.taskId, taskId)).all();
}

/**
 * Get a single git ref by ID. Throws 404 if not found.
 */
export function getById(id: string) {
  const db = getDb();
  const ref = db.select().from(gitRefs).where(eq(gitRefs.id, id)).get();

  if (!ref) {
    throw new AppError(404, "NOT_FOUND", `Git ref not found: ${id}`);
  }

  return ref;
}

/**
 * Create a new git ref for a task.
 */
export function create(data: CreateGitRefInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();

  // Verify task exists
  const task = db.select().from(tasks).where(eq(tasks.id, data.taskId)).get();
  if (!task) {
    throw new AppError(404, "NOT_FOUND", `Task not found: ${data.taskId}`);
  }

  // Validate ref_type
  if (!VALID_REF_TYPES.has(data.refType)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Invalid ref type: "${data.refType}". Valid types: ${GIT_REF_TYPES.join(", ")}`,
    );
  }

  // Validate status if provided
  if (data.status && !VALID_REF_STATUSES.has(data.status)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Invalid ref status: "${data.status}". Valid statuses: ${GIT_REF_STATUSES.join(", ")}`,
    );
  }

  db.insert(gitRefs)
    .values({
      id,
      taskId: data.taskId,
      refType: data.refType,
      refValue: data.refValue,
      url: data.url ?? null,
      title: data.title ?? null,
      status: data.status ?? null,
      metadata: data.metadata ?? null,
      createdAt: now,
    })
    .run();

  return getById(id);
}

/**
 * Update a git ref. Throws 404 if not found.
 */
export function update(id: string, data: UpdateGitRefInput) {
  getById(id); // verify exists
  const db = getDb();

  const values: Record<string, unknown> = {};

  if (data.refType !== undefined) {
    if (!VALID_REF_TYPES.has(data.refType)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Invalid ref type: "${data.refType}". Valid types: ${GIT_REF_TYPES.join(", ")}`,
      );
    }
    values.refType = data.refType;
  }
  if (data.refValue !== undefined) values.refValue = data.refValue;
  if (data.url !== undefined) values.url = data.url;
  if (data.title !== undefined) values.title = data.title;
  if (data.status !== undefined) {
    if (data.status !== null && !VALID_REF_STATUSES.has(data.status)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Invalid ref status: "${data.status}". Valid statuses: ${GIT_REF_STATUSES.join(", ")}`,
      );
    }
    values.status = data.status;
  }
  if (data.metadata !== undefined) values.metadata = data.metadata;

  db.update(gitRefs).set(values).where(eq(gitRefs.id, id)).run();

  return getById(id);
}

/**
 * Delete a git ref. Throws 404 if not found.
 */
export function deleteGitRef(id: string) {
  const existing = getById(id);
  const db = getDb();

  db.delete(gitRefs).where(eq(gitRefs.id, id)).run();

  return existing;
}
