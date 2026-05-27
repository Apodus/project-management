import { eq, and, like, isNull, desc, asc, count, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import { getDb, tasks } from "../db/index.js";
import { AppError } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string | null;
  status?: string;
  priority?: string;
  type?: string;
  assigneeId?: string | null;
  reporterId: string;
  epicId?: string | null;
  parentTaskId?: string | null;
  proposalId?: string | null;
  estimatedEffort?: string | null;
  dueDate?: string | null;
  sortOrder?: number;
  context?: Record<string, unknown> | null;
  gitBranch?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  type?: string;
  assigneeId?: string | null;
  reporterId?: string;
  epicId?: string | null;
  proposalId?: string | null;
  estimatedEffort?: string | null;
  dueDate?: string | null;
  sortOrder?: number;
  context?: Record<string, unknown> | null;
  gitBranch?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface TaskListFilters {
  status?: string; // comma-separated
  priority?: string;
  assignee?: string; // user id or "unassigned"
  epic?: string; // epic id or "none"
  type?: string;
  search?: string;
  sortBy?: string; // priority, created_at, updated_at, due_date, sort_order
  order?: "asc" | "desc";
  page?: number;
  perPage?: number;
}

export interface TaskListResult {
  data: ReturnType<typeof getDb>["select"] extends (...args: any[]) => any
    ? any[]
    : any[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
}

// ─── Priority ordering helper ─────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ─── Service functions ────────────────────────────────────────────

/**
 * List tasks for a project with rich filtering, sorting, and pagination.
 */
export function list(projectId: string, filters?: TaskListFilters) {
  const db = getDb();

  const conditions: ReturnType<typeof eq>[] = [eq(tasks.projectId, projectId)];

  // Status filter (supports comma-separated values)
  if (filters?.status) {
    const statuses = filters.status.split(",").map((s) => s.trim());
    if (statuses.length === 1) {
      conditions.push(eq(tasks.status, statuses[0]));
    } else {
      // Use SQL IN for multiple statuses
      conditions.push(
        sql`${tasks.status} IN (${sql.join(
          statuses.map((s) => sql`${s}`),
          sql`,`,
        )})` as any,
      );
    }
  }

  // Priority filter
  if (filters?.priority) {
    conditions.push(eq(tasks.priority, filters.priority));
  }

  // Type filter
  if (filters?.type) {
    conditions.push(eq(tasks.type, filters.type));
  }

  // Assignee filter
  if (filters?.assignee) {
    if (filters.assignee === "unassigned") {
      conditions.push(isNull(tasks.assigneeId));
    } else {
      conditions.push(eq(tasks.assigneeId, filters.assignee));
    }
  }

  // Epic filter
  if (filters?.epic) {
    if (filters.epic === "none") {
      conditions.push(isNull(tasks.epicId));
    } else {
      conditions.push(eq(tasks.epicId, filters.epic));
    }
  }

  // Search filter (LIKE on title)
  if (filters?.search) {
    conditions.push(like(tasks.title, `%${filters.search}%`));
  }

  // Count total matching items
  const totalResult = db
    .select({ count: count() })
    .from(tasks)
    .where(and(...conditions))
    .get();
  const total = totalResult?.count ?? 0;

  // Pagination
  const page = Math.max(1, filters?.page ?? 1);
  const perPage = Math.max(1, Math.min(100, filters?.perPage ?? 50));
  const offset = (page - 1) * perPage;
  const totalPages = Math.ceil(total / perPage);

  // Determine sort column and order
  const sortBy = filters?.sortBy ?? "created_at";
  const orderDir = filters?.order ?? "desc";

  let orderClause;
  if (sortBy === "priority") {
    // Sort by priority using custom order (critical=0, high=1, medium=2, low=3)
    const priorityCase = sql`CASE ${tasks.priority}
      WHEN 'critical' THEN 0
      WHEN 'high' THEN 1
      WHEN 'medium' THEN 2
      WHEN 'low' THEN 3
      ELSE 4
    END`;
    orderClause =
      orderDir === "asc" ? asc(priorityCase) : desc(priorityCase);
  } else {
    const columnMap: Record<string, any> = {
      created_at: tasks.createdAt,
      updated_at: tasks.updatedAt,
      due_date: tasks.dueDate,
      sort_order: tasks.sortOrder,
    };
    const column = columnMap[sortBy] ?? tasks.createdAt;
    orderClause = orderDir === "asc" ? asc(column) : desc(column);
  }

  const data = db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(orderClause)
    .limit(perPage)
    .offset(offset)
    .all();

  return {
    data,
    pagination: {
      page,
      perPage,
      total,
      totalPages,
    },
  };
}

/**
 * Get a single task by ID. Throws 404 if not found.
 */
export function getById(id: string) {
  const db = getDb();
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();

  if (!task) {
    throw new AppError(404, "NOT_FOUND", `Task not found: ${id}`);
  }

  return task;
}

/**
 * Create a new task with auto-generated ID and timestamps.
 */
export function create(data: CreateTaskInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();

  db.insert(tasks)
    .values({
      id,
      projectId: data.projectId,
      title: data.title,
      description: data.description ?? null,
      status: data.status ?? "backlog",
      priority: data.priority ?? "medium",
      type: data.type ?? "feature",
      assigneeId: data.assigneeId ?? null,
      reporterId: data.reporterId,
      epicId: data.epicId ?? null,
      parentTaskId: data.parentTaskId ?? null,
      proposalId: data.proposalId ?? null,
      estimatedEffort: data.estimatedEffort ?? null,
      dueDate: data.dueDate ?? null,
      sortOrder: data.sortOrder ?? 0,
      context: data.context ?? null,
      gitBranch: data.gitBranch ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return getById(id);
}

/**
 * Update a task's fields. Throws 404 if not found.
 * Automatically updates the `updatedAt` timestamp.
 * Context JSON is merged with existing context (shallow merge).
 */
export function update(id: string, data: UpdateTaskInput) {
  const existing = getById(id);
  const db = getDb();
  const now = new Date().toISOString();

  const values: Record<string, unknown> = {
    updatedAt: now,
  };

  if (data.title !== undefined) values.title = data.title;
  if (data.description !== undefined) values.description = data.description;
  if (data.status !== undefined) values.status = data.status;
  if (data.priority !== undefined) values.priority = data.priority;
  if (data.type !== undefined) values.type = data.type;
  if (data.assigneeId !== undefined) values.assigneeId = data.assigneeId;
  if (data.reporterId !== undefined) values.reporterId = data.reporterId;
  if (data.epicId !== undefined) values.epicId = data.epicId;
  if (data.proposalId !== undefined) values.proposalId = data.proposalId;
  if (data.estimatedEffort !== undefined)
    values.estimatedEffort = data.estimatedEffort;
  if (data.dueDate !== undefined) values.dueDate = data.dueDate;
  if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;
  if (data.gitBranch !== undefined) values.gitBranch = data.gitBranch;
  if (data.startedAt !== undefined) values.startedAt = data.startedAt;
  if (data.completedAt !== undefined) values.completedAt = data.completedAt;

  // Context: merge with existing context (shallow merge)
  if (data.context !== undefined) {
    if (data.context === null) {
      values.context = null;
    } else {
      const existingContext =
        existing.context && typeof existing.context === "object"
          ? (existing.context as Record<string, unknown>)
          : {};
      values.context = { ...existingContext, ...data.context };
    }
  }

  db.update(tasks).set(values).where(eq(tasks.id, id)).run();

  return getById(id);
}

/**
 * Archive a task (set status to "cancelled"). Throws 404 if not found.
 */
export function archive(id: string) {
  getById(id);
  const db = getDb();
  const now = new Date().toISOString();

  db.update(tasks)
    .set({ status: "cancelled", updatedAt: now })
    .where(eq(tasks.id, id))
    .run();

  return getById(id);
}

/**
 * Create a subtask of a given parent task.
 * The parent task must exist. The subtask inherits the parent's projectId.
 */
export function createSubtask(parentTaskId: string, data: Omit<CreateTaskInput, "projectId" | "parentTaskId">) {
  const parent = getById(parentTaskId);

  return create({
    ...data,
    projectId: parent.projectId,
    parentTaskId,
  });
}

/**
 * List subtasks of a given task. The parent task must exist.
 */
export function listSubtasks(parentTaskId: string) {
  // Verify parent exists
  getById(parentTaskId);

  const db = getDb();
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId))
    .all();
}
