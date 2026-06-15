import { eq, asc } from "drizzle-orm";
import { createId, COMMENT_TYPES } from "@pm/shared";
import { getDb, comments, tasks, proposals } from "../db/index.js";
import { AppError } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────

export interface CreateCommentInput {
  taskId?: string | null;
  proposalId?: string | null;
  authorId: string;
  body: string;
  commentType?: string;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateCommentInput {
  body?: string;
  metadata?: Record<string, unknown> | null;
}

// ─── Helpers ─────────────────────────────────────────────────────

const VALID_COMMENT_TYPES = new Set<string>(COMMENT_TYPES);

// ─── Service functions ────────────────────────────────────────────

/**
 * List comments for a task, in chronological order.
 * Throws 404 if the task does not exist.
 */
export function listByTask(taskId: string) {
  const db = getDb();

  // Verify task exists
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) {
    throw new AppError(404, "NOT_FOUND", `Task not found: ${taskId}`);
  }

  return db
    .select()
    .from(comments)
    .where(eq(comments.taskId, taskId))
    .orderBy(asc(comments.createdAt))
    .all();
}

/**
 * List comments for a proposal, in chronological order.
 * Throws 404 if the proposal does not exist.
 */
export function listByProposal(proposalId: string) {
  const db = getDb();

  // Verify proposal exists
  const proposal = db.select().from(proposals).where(eq(proposals.id, proposalId)).get();
  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${proposalId}`);
  }

  return db
    .select()
    .from(comments)
    .where(eq(comments.proposalId, proposalId))
    .orderBy(asc(comments.createdAt))
    .all();
}

/**
 * Create a comment.
 * ENFORCES: exactly one of task_id or proposal_id must be set (not both, not neither).
 * Validates comment_type is a valid enum value.
 */
export function create(data: CreateCommentInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();

  // Enforce polymorphism: exactly one of task_id or proposal_id
  const hasTask = data.taskId != null && data.taskId !== "";
  const hasProposal = data.proposalId != null && data.proposalId !== "";

  if (hasTask && hasProposal) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Comment must belong to either a task or a proposal, not both",
    );
  }

  if (!hasTask && !hasProposal) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Comment must belong to either a task or a proposal",
    );
  }

  // Validate comment_type
  const commentType = data.commentType ?? "comment";
  if (!VALID_COMMENT_TYPES.has(commentType)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Invalid comment type: "${commentType}". Valid types: ${COMMENT_TYPES.join(", ")}`,
    );
  }

  // Verify parent exists
  if (hasTask) {
    const task = db.select().from(tasks).where(eq(tasks.id, data.taskId!)).get();
    if (!task) {
      throw new AppError(404, "NOT_FOUND", `Task not found: ${data.taskId}`);
    }
  }

  if (hasProposal) {
    const proposal = db.select().from(proposals).where(eq(proposals.id, data.proposalId!)).get();
    if (!proposal) {
      throw new AppError(404, "NOT_FOUND", `Proposal not found: ${data.proposalId}`);
    }
  }

  db.insert(comments)
    .values({
      id,
      taskId: hasTask ? data.taskId! : null,
      proposalId: hasProposal ? data.proposalId! : null,
      authorId: data.authorId,
      body: data.body,
      commentType,
      metadata: data.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return db.select().from(comments).where(eq(comments.id, id)).get()!;
}

/**
 * Update a comment's body and/or metadata.
 * Throws 404 if not found.
 */
export function update(id: string, data: UpdateCommentInput) {
  const db = getDb();

  const existing = db.select().from(comments).where(eq(comments.id, id)).get();

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `Comment not found: ${id}`);
  }

  const now = new Date().toISOString();
  const values: Record<string, unknown> = { updatedAt: now };

  if (data.body !== undefined) values.body = data.body;
  if (data.metadata !== undefined) values.metadata = data.metadata;

  db.update(comments).set(values).where(eq(comments.id, id)).run();

  return db.select().from(comments).where(eq(comments.id, id)).get()!;
}

/**
 * Delete a comment.
 * Throws 404 if not found.
 */
export function deleteComment(id: string) {
  const db = getDb();

  const existing = db.select().from(comments).where(eq(comments.id, id)).get();

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `Comment not found: ${id}`);
  }

  db.delete(comments).where(eq(comments.id, id)).run();

  return existing;
}
