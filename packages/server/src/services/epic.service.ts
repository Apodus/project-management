import { eq, and, count, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import { getDb, epics, tasks } from "../db/index.js";
import { AppError } from "../types.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";

// ─── Types ────────────────────────────────────────────────────────

export interface CreateEpicInput {
  projectId: string;
  name: string;
  description?: string | null;
  status?: string;
  priority?: string;
  proposalId?: string | null;
  milestoneId?: string | null;
  targetDate?: string | null;
  sortOrder?: number;
  createdBy?: string | null;
}

export interface UpdateEpicInput {
  name?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  proposalId?: string | null;
  milestoneId?: string | null;
  targetDate?: string | null;
  sortOrder?: number;
}

export interface EpicTaskSummary {
  total: number;
  done: number;
  byStatus: Record<string, number>;
}

// ─── Service functions ────────────────────────────────────────────

/**
 * Build the task summary (count by status) for a given epic.
 */
function getTaskSummary(epicId: string): EpicTaskSummary {
  const db = getDb();

  const rows = db
    .select({
      status: tasks.status,
      count: count(),
    })
    .from(tasks)
    .where(eq(tasks.epicId, epicId))
    .groupBy(tasks.status)
    .all();

  const byStatus: Record<string, number> = {};
  let total = 0;
  let done = 0;

  for (const row of rows) {
    byStatus[row.status] = row.count;
    total += row.count;
    if (row.status === "done") {
      done = row.count;
    }
  }

  return { total, done, byStatus };
}

/**
 * List epics for a project, with optional filters.
 * Includes task summary (count by status) for each epic.
 */
export function list(
  projectId: string,
  filters?: { status?: string; milestone?: string },
) {
  const db = getDb();

  const conditions = [eq(epics.projectId, projectId)];

  if (filters?.status) {
    conditions.push(eq(epics.status, filters.status));
  }
  if (filters?.milestone) {
    conditions.push(eq(epics.milestoneId, filters.milestone));
  }

  const epicList = db
    .select()
    .from(epics)
    .where(and(...conditions))
    .all();

  return epicList.map((epic) => ({
    ...epic,
    taskSummary: getTaskSummary(epic.id),
  }));
}

/**
 * Get a single epic by ID with task summary. Throws 404 if not found.
 */
export function getById(id: string) {
  const db = getDb();
  const epic = db.select().from(epics).where(eq(epics.id, id)).get();

  if (!epic) {
    throw new AppError(404, "NOT_FOUND", `Epic not found: ${id}`);
  }

  return {
    ...epic,
    taskSummary: getTaskSummary(epic.id),
  };
}

/**
 * Get a raw epic by ID (without task summary). Throws 404 if not found.
 */
function getRawById(id: string) {
  const db = getDb();
  const epic = db.select().from(epics).where(eq(epics.id, id)).get();

  if (!epic) {
    throw new AppError(404, "NOT_FOUND", `Epic not found: ${id}`);
  }

  return epic;
}

/**
 * Create a new epic with auto-generated ID and timestamps.
 */
export function create(data: CreateEpicInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();

  db.insert(epics)
    .values({
      id,
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      status: data.status ?? "draft",
      priority: data.priority ?? "medium",
      proposalId: data.proposalId ?? null,
      milestoneId: data.milestoneId ?? null,
      targetDate: data.targetDate ?? null,
      sortOrder: data.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
      createdBy: data.createdBy ?? null,
    })
    .run();

  const result = getById(id);

  getEventBus().emit(EVENT_NAMES.EPIC_CREATED, {
    entity: result,
    entityType: "epic",
    entityId: id,
    projectId: data.projectId,
    actorId: data.createdBy ?? null,
    timestamp: now,
  });

  return result;
}

/**
 * Update an epic's fields. Throws 404 if not found.
 * Automatically updates the `updatedAt` timestamp.
 */
export function update(id: string, data: UpdateEpicInput) {
  // Verify the epic exists
  getRawById(id);
  const db = getDb();
  const now = new Date().toISOString();

  const values: Record<string, unknown> = {
    updatedAt: now,
  };

  if (data.name !== undefined) values.name = data.name;
  if (data.description !== undefined) values.description = data.description;
  if (data.status !== undefined) values.status = data.status;
  if (data.priority !== undefined) values.priority = data.priority;
  if (data.proposalId !== undefined) values.proposalId = data.proposalId;
  if (data.milestoneId !== undefined) values.milestoneId = data.milestoneId;
  if (data.targetDate !== undefined) values.targetDate = data.targetDate;
  if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;

  db.update(epics).set(values).where(eq(epics.id, id)).run();

  const result = getById(id);

  getEventBus().emit(EVENT_NAMES.EPIC_UPDATED, {
    entity: result,
    entityType: "epic",
    entityId: id,
    projectId: result.projectId,
    actorId: null,
    timestamp: now,
  });

  return result;
}

/**
 * Claim an epic — set assignee_id to the given user.
 * Throws 404 if epic not found, 409 if already claimed by another user.
 */
export function claimEpic(epicId: string, userId: string) {
  const existing = getRawById(epicId);

  if (existing.assigneeId && existing.assigneeId !== userId) {
    throw new AppError(
      409,
      "ALREADY_CLAIMED",
      `Epic is already claimed by another user`,
    );
  }

  const db = getDb();
  const now = new Date().toISOString();

  db.update(epics)
    .set({ assigneeId: userId, updatedAt: now })
    .where(eq(epics.id, epicId))
    .run();

  return getById(epicId);
}

/**
 * Release an epic — clear assignee_id.
 * Throws 404 if epic not found.
 */
export function releaseEpic(epicId: string) {
  getRawById(epicId);

  const db = getDb();
  const now = new Date().toISOString();

  db.update(epics)
    .set({ assigneeId: null, updatedAt: now })
    .where(eq(epics.id, epicId))
    .run();

  return getById(epicId);
}

/**
 * Archive an epic (set status to "cancelled"). Throws 404 if not found.
 */
export function archive(id: string) {
  const existing = getRawById(id);
  const db = getDb();
  const now = new Date().toISOString();

  db.update(epics)
    .set({ status: "cancelled", updatedAt: now })
    .where(eq(epics.id, id))
    .run();

  const result = getById(id);

  getEventBus().emit(EVENT_NAMES.EPIC_ARCHIVED, {
    entity: result,
    entityType: "epic",
    entityId: id,
    projectId: existing.projectId,
    actorId: null,
    timestamp: now,
    changes: { status: { from: existing.status, to: "cancelled" } },
    previousStatus: existing.status,
  });

  return result;
}
