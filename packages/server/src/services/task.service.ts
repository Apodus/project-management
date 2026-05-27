import { eq, and, like, isNull, desc, asc, count, sql, inArray } from "drizzle-orm";
import { createId, isValidTaskTransition, getValidTaskTargets } from "@pm/shared";
import type { TaskStatus, EffortSize } from "@pm/shared";
import { getDb, getRawDb, tasks, taskLabels, taskDependencies } from "../db/index.js";
import { AppError } from "../types.js";
import type { AuthUser } from "../types.js";
import * as dependencyService from "./dependency.service.js";
import { computeChanges } from "./activity.service.js";
import * as commentService from "./comment.service.js";
import * as autonomyService from "./autonomy.service.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";

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
  status?: string; // Rejected at runtime — must use transition() instead
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
  label?: string; // label id — filter to tasks with this label attached
  is_blocked?: string; // "true" or "false"
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

  // Label filter: tasks that have a specific label attached
  if (filters?.label) {
    conditions.push(
      sql`${tasks.id} IN (
        SELECT ${taskLabels.taskId} FROM ${taskLabels}
        WHERE ${taskLabels.labelId} = ${filters.label}
      )` as any,
    );
  }

  // is_blocked filter: tasks with/without unresolved blocking dependencies
  // A task is "blocked" if it has at least one "blocks" dependency where
  // the blocking task is NOT in "done" status.
  if (filters?.is_blocked !== undefined) {
    const wantBlocked = filters.is_blocked === "true";
    if (wantBlocked) {
      // Tasks that have at least one blocking dependency where the blocker is not done
      conditions.push(
        sql`${tasks.id} IN (
          SELECT td.task_id FROM task_dependencies td
          INNER JOIN tasks t2 ON t2.id = td.depends_on_task_id
          WHERE td.dependency_type = 'blocks' AND t2.status != 'done'
        )` as any,
      );
    } else {
      // Tasks that either have no blocking deps, or all blocking deps are done
      conditions.push(
        sql`${tasks.id} NOT IN (
          SELECT td.task_id FROM task_dependencies td
          INNER JOIN tasks t2 ON t2.id = td.depends_on_task_id
          WHERE td.dependency_type = 'blocks' AND t2.status != 'done'
        )` as any,
      );
    }
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
export function create(data: CreateTaskInput, actor?: AuthUser) {
  // Check autonomy guardrails for AI agents creating top-level tasks
  if (actor && !data.parentTaskId) {
    autonomyService.checkGuardrail(actor, "create_task", data.projectId);
  }
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

  const result = getById(id);

  getEventBus().emit(EVENT_NAMES.TASK_CREATED, {
    entity: result,
    entityType: "task",
    entityId: id,
    projectId: data.projectId,
    actorId: data.reporterId,
    timestamp: now,
  });

  return result;
}

/**
 * Update a task's fields. Throws 404 if not found.
 * Automatically updates the `updatedAt` timestamp.
 * Context JSON is merged with existing context (shallow merge).
 */
export function update(id: string, data: UpdateTaskInput, actor?: AuthUser) {
  // Reject status changes via PATCH — use POST /tasks/:id/transitions instead
  if (data.status !== undefined) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Cannot change status via PATCH. Use POST /tasks/:id/transitions to change task status.",
    );
  }

  const existing = getById(id);
  const db = getDb();
  const now = new Date().toISOString();

  // Check autonomy guardrails for priority changes by AI agents
  if (data.priority !== undefined && data.priority !== existing.priority && actor) {
    autonomyService.checkGuardrail(actor, "change_priority", existing.projectId);
  }

  const values: Record<string, unknown> = {
    updatedAt: now,
  };

  if (data.title !== undefined) values.title = data.title;
  if (data.description !== undefined) values.description = data.description;
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

  const result = getById(id);

  const changes = computeChanges(
    existing as unknown as Record<string, unknown>,
    result as unknown as Record<string, unknown>,
    ["title", "description", "priority", "assigneeId", "epicId", "type"],
  );

  // Determine the event based on what changed
  const isAssignment = data.assigneeId !== undefined && data.assigneeId !== existing.assigneeId;
  const eventName = isAssignment ? EVENT_NAMES.TASK_ASSIGNED : EVENT_NAMES.TASK_UPDATED;

  getEventBus().emit(eventName, {
    entity: result,
    entityType: "task",
    entityId: id,
    projectId: existing.projectId,
    actorId: actor?.id ?? null,
    timestamp: now,
    changes,
  });

  return result;
}

/**
 * Archive a task (set status to "cancelled"). Throws 404 if not found.
 */
export function archive(id: string) {
  const existing = getById(id);
  const db = getDb();
  const now = new Date().toISOString();

  db.update(tasks)
    .set({ status: "cancelled", updatedAt: now })
    .where(eq(tasks.id, id))
    .run();

  const result = getById(id);

  getEventBus().emit(EVENT_NAMES.TASK_ARCHIVED, {
    entity: result,
    entityType: "task",
    entityId: id,
    projectId: existing.projectId,
    actorId: null,
    timestamp: now,
    changes: { status: { from: existing.status, to: "cancelled" } },
    previousStatus: existing.status,
  });

  return result;
}

/**
 * Create a subtask of a given parent task.
 * The parent task must exist. The subtask inherits the parent's projectId.
 */
export function createSubtask(parentTaskId: string, data: Omit<CreateTaskInput, "projectId" | "parentTaskId">, actor?: AuthUser) {
  const parent = getById(parentTaskId);

  // Check autonomy guardrails for AI agents creating subtasks
  if (actor) {
    autonomyService.checkGuardrail(actor, "create_subtask", parent.projectId);
  }

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

// ─── Workflow engine ─────────────────────────────────────────────

/**
 * Transition a task's status, enforcing valid workflow transitions.
 * - Validates the transition using TASK_TRANSITION_MAP
 * - Sets started_at when moving to in_progress
 * - Sets completed_at when moving to done
 * - Optionally creates a comment
 * - Logs status_changed activity
 */
export function transition(
  taskId: string,
  toStatus: TaskStatus,
  actor: AuthUser,
  comment?: string,
) {
  const existing = getById(taskId);
  const currentStatus = existing.status as TaskStatus;

  // Validate transition
  if (!isValidTaskTransition(currentStatus, toStatus)) {
    const validTargets = getValidTaskTargets(currentStatus);
    const validList = validTargets.length > 0 ? validTargets.join(", ") : "none";
    throw new AppError(
      400,
      "INVALID_TRANSITION",
      `Cannot transition from "${currentStatus}" to "${toStatus}". Valid transitions from "${currentStatus}": ${validList}`,
    );
  }

  const db = getDb();
  const now = new Date().toISOString();

  const values: Record<string, unknown> = {
    status: toStatus,
    updatedAt: now,
  };

  // Set started_at when moving to in_progress (if not already set)
  if (toStatus === "in_progress") {
    if (!existing.startedAt) {
      values.startedAt = now;
    }
    // Auto-assign to actor if not already assigned
    values.assigneeId = actor.id;
  }

  // Set completed_at when moving to done
  if (toStatus === "done") {
    values.completedAt = now;
  }

  db.update(tasks).set(values).where(eq(tasks.id, taskId)).run();

  const result = getById(taskId);

  // Create a comment if provided
  if (comment) {
    commentService.create({
      taskId,
      authorId: actor.id,
      body: comment,
      commentType: "comment",
    });
  }

  // Log activity via event bus
  getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
    entity: result,
    entityType: "task",
    entityId: taskId,
    projectId: existing.projectId,
    actorId: actor.id,
    timestamp: now,
    changes: { status: { from: currentStatus, to: toStatus } },
    previousStatus: currentStatus,
  });

  return result;
}

// ─── Effort ordering ─────────────────────────────────────────────

const EFFORT_ORDER: Record<string, number> = {
  xs: 1,
  s: 2,
  m: 3,
  l: 4,
  xl: 5,
};

// ─── Pick next task ──────────────────────────────────────────────

export interface PickNextOptions {
  projectId?: string;
  taskTypes?: string[];
  maxEffort?: string;
}

/**
 * Find and atomically claim the highest-priority ready task.
 *
 * For AI agents, checks autonomy guardrails (can_self_assign, max_concurrent_tasks).
 * Returns the claimed task, or null if nothing is available.
 */
export function pickNextTask(actor: AuthUser, options?: PickNextOptions): ReturnType<typeof getById> | null {
  const db = getDb();
  const rawDb = getRawDb();

  // Check autonomy guardrails for AI agents
  if (actor.type === "ai_agent") {
    if (options?.projectId) {
      autonomyService.checkGuardrail(actor, "self_assign", options.projectId);
    }
    // If no projectId, we'll check per-candidate below
  }

  // Check max_concurrent_tasks
  const inProgressCount = db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.assigneeId, actor.id),
        eq(tasks.status, "in_progress"),
      ),
    )
    .get();

  // For AI agents, enforce max_concurrent_tasks
  if (actor.type === "ai_agent") {
    // Use the project-specific setting if projectId provided, otherwise use default
    const maxConcurrent = options?.projectId
      ? autonomyService.getMaxConcurrentTasks(options.projectId)
      : 3; // default

    if ((inProgressCount?.count ?? 0) >= maxConcurrent) {
      throw new AppError(
        403,
        "MAX_CONCURRENT_TASKS",
        "Maximum concurrent tasks reached",
      );
    }
  }

  // Build SQL conditions for finding candidates
  const conditions: string[] = [
    `t.status = 'ready'`,
    `t.assignee_id IS NULL`,
  ];
  const params: unknown[] = [];

  // Not blocked: no unresolved blocking dependencies
  conditions.push(`t.id NOT IN (
    SELECT td.task_id FROM task_dependencies td
    INNER JOIN tasks t2 ON t2.id = td.depends_on_task_id
    WHERE td.dependency_type = 'blocks' AND t2.status != 'done'
  )`);

  // Optional projectId filter
  if (options?.projectId) {
    conditions.push(`t.project_id = ?`);
    params.push(options.projectId);
  }

  // Optional taskTypes filter
  if (options?.taskTypes && options.taskTypes.length > 0) {
    const placeholders = options.taskTypes.map(() => "?").join(", ");
    conditions.push(`t.type IN (${placeholders})`);
    params.push(...options.taskTypes);
  }

  // Optional maxEffort filter
  if (options?.maxEffort) {
    const maxEffortValue = EFFORT_ORDER[options.maxEffort];
    if (maxEffortValue !== undefined) {
      // Tasks with null effort are included (eligible)
      // Tasks with effort > maxEffort are excluded
      const effortConditions: string[] = ["t.estimated_effort IS NULL"];
      for (const [effort, value] of Object.entries(EFFORT_ORDER)) {
        if (value <= maxEffortValue) {
          effortConditions.push(`t.estimated_effort = '${effort}'`);
        }
      }
      conditions.push(`(${effortConditions.join(" OR ")})`);
    }
  }

  const whereClause = conditions.join(" AND ");

  // Use a transaction to atomically find and claim
  const now = new Date().toISOString();

  const txn = rawDb.transaction(() => {
    // Find the highest priority ready task
    const candidateSql = `
      SELECT t.id, t.project_id FROM tasks t
      WHERE ${whereClause}
      ORDER BY
        CASE t.priority
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END ASC,
        t.created_at ASC
      LIMIT 1
    `;

    const candidate = rawDb.prepare(candidateSql).get(...params) as { id: string; project_id: string } | undefined;

    if (!candidate) {
      return null;
    }

    // For AI agents without a projectId filter, check guardrails per-candidate
    if (actor.type === "ai_agent" && !options?.projectId) {
      autonomyService.checkGuardrail(actor, "self_assign", candidate.project_id);
    }

    // Atomically claim the task
    const updateSql = `
      UPDATE tasks
      SET status = 'in_progress',
          assignee_id = ?,
          started_at = COALESCE(started_at, ?),
          updated_at = ?
      WHERE id = ?
        AND status = 'ready'
        AND assignee_id IS NULL
    `;

    const result = rawDb.prepare(updateSql).run(actor.id, now, now, candidate.id);

    if (result.changes === 0) {
      // Another caller claimed it between our SELECT and UPDATE
      return null;
    }

    return candidate.id;
  });

  const claimedId = txn();

  if (!claimedId) {
    return null;
  }

  const claimedTask = getById(claimedId);

  // Log activity via event bus (after transaction committed)
  getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
    entity: claimedTask,
    entityType: "task",
    entityId: claimedId,
    projectId: claimedTask.projectId,
    actorId: actor.id,
    timestamp: new Date().toISOString(),
    changes: { status: { from: "ready", to: "in_progress" } },
    previousStatus: "ready",
  });

  return claimedTask;
}
