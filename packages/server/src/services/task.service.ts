import {
  eq,
  and,
  like,
  isNull,
  or,
  desc,
  asc,
  count,
  sql,
  inArray,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import {
  createId,
  isValidTaskTransition,
  getValidTaskTargets,
  findTaskTransitionPath,
  LEASE_GRACE_MS_DEFAULT,
  LEASE_PICK_MARGIN_MS_DEFAULT,
} from "@pm/shared";
import type { ClaimResult, ClaimState, ClaimStatus, TaskStatus, UserType } from "@pm/shared";
import {
  getDb,
  getRawDb,
  tasks,
  taskLabels,
  labels,
  epics,
  projects,
  users,
} from "../db/index.js";
import { AppError } from "../types.js";
import type { AuthUser } from "../types.js";
import { computeChanges } from "./activity.service.js";
import * as commentService from "./comment.service.js";
import * as autonomyService from "./autonomy.service.js";
import {
  assertClaimOk as assertClaimOkRaw,
  deriveClaimStatus,
  deriveClaimState,
  forceClaim as forceClaimShared,
  releaseTo as releaseToShared,
  requestTakeover as requestTakeoverShared,
  type Actor as ClaimActor,
  type ClaimFilter,
  type ForceClaimConfig,
  type ForceClaimResult,
  type ReleaseToResult,
  type RequestTakeoverResult,
} from "./claim-helpers.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";
import {
  acquireLease,
  deleteLease,
  deriveLiveness,
  readLease,
  readLeasesFor,
  sweepStaleClaims,
  type ClaimLeaseRow,
} from "./claim-lease.service.js";

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
  sourceNoteId?: string | null;
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
  labelName?: string; // label name — resolved to id within the project scope
  claim?: ClaimFilter; // "available" | "mine" | "all"
  is_blocked?: string; // "true" or "false"
  sortBy?: string; // priority, created_at, updated_at, due_date, sort_order
  order?: "asc" | "desc";
  page?: number;
  perPage?: number;
}

export type TaskListItem = typeof tasks.$inferSelect &
  EnrichedFields & { claimStatus: ClaimStatus; claimState: ClaimState };

export interface TaskListResult {
  data: TaskListItem[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
}

// ─── Enrichment ───────────────────────────────────────────────────

interface TaskFKShape {
  id: string;
  projectId: string;
  epicId: string | null;
  parentTaskId: string | null;
  assigneeId: string | null;
  reporterId: string;
}

export type EnrichedFields = {
  epicName: string | null;
  projectName: string | null;
  parentTaskTitle: string | null;
  assigneeName: string | null;
  assigneeType: string | null;
  reporterName: string | null;
  reporterType: string | null;
};

/**
 * Batch-enrich tasks with the human-readable names of referenced epics,
 * projects, parent tasks, assignees, and reporters. Single query per
 * referenced table — safe for large pages.
 */
export function enrichTasks<T extends TaskFKShape>(
  rawTasks: T[],
): (T & EnrichedFields)[] {
  if (rawTasks.length === 0) return [];
  const db = getDb();

  const epicIds = new Set<string>();
  const projectIds = new Set<string>();
  const parentIds = new Set<string>();
  const userIds = new Set<string>();

  for (const t of rawTasks) {
    if (t.epicId) epicIds.add(t.epicId);
    projectIds.add(t.projectId);
    if (t.parentTaskId) parentIds.add(t.parentTaskId);
    if (t.assigneeId) userIds.add(t.assigneeId);
    if (t.reporterId) userIds.add(t.reporterId);
  }

  const epicMap = new Map<string, string>();
  if (epicIds.size > 0) {
    const rows = db
      .select({ id: epics.id, name: epics.name })
      .from(epics)
      .where(inArray(epics.id, [...epicIds]))
      .all();
    for (const r of rows) epicMap.set(r.id, r.name);
  }

  const projectMap = new Map<string, string>();
  if (projectIds.size > 0) {
    const rows = db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, [...projectIds]))
      .all();
    for (const r of rows) projectMap.set(r.id, r.name);
  }

  const parentMap = new Map<string, string>();
  if (parentIds.size > 0) {
    const rows = db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(inArray(tasks.id, [...parentIds]))
      .all();
    for (const r of rows) parentMap.set(r.id, r.title);
  }

  const userMap = new Map<string, { displayName: string; type: string }>();
  if (userIds.size > 0) {
    const rows = db
      .select({
        id: users.id,
        displayName: users.displayName,
        type: users.type,
      })
      .from(users)
      .where(inArray(users.id, [...userIds]))
      .all();
    for (const r of rows) {
      userMap.set(r.id, { displayName: r.displayName, type: r.type });
    }
  }

  return rawTasks.map((t) => {
    const assignee = t.assigneeId ? userMap.get(t.assigneeId) : null;
    const reporter = userMap.get(t.reporterId);
    return {
      ...t,
      epicName: t.epicId ? epicMap.get(t.epicId) ?? null : null,
      projectName: projectMap.get(t.projectId) ?? null,
      parentTaskTitle: t.parentTaskId
        ? parentMap.get(t.parentTaskId) ?? null
        : null,
      assigneeName: assignee?.displayName ?? null,
      assigneeType: assignee?.type ?? null,
      reporterName: reporter?.displayName ?? null,
      reporterType: reporter?.type ?? null,
    };
  });
}

export function enrichTask<T extends TaskFKShape>(
  rawTask: T,
): T & EnrichedFields {
  return enrichTasks([rawTask])[0];
}

// ─── Claim helpers ────────────────────────────────────────────────
// Tasks use `assigneeId` as the claim holder, mirroring the epic
// decision (see epic.service.ts). For AI agents, the assignee IS the
// claim — writes require assigneeId === actor.id. Humans always pass.

const CLAIM_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "cancelled",
]);

export type Actor = ClaimActor;
export { type ClaimFilter };

/**
 * Decorate a task row with claim_status AND claim_state derived from the caller.
 * Tasks use `assigneeId` as the claim-holder field.
 *
 * `claimState` (C3.P1) folds in the C2 lease liveness; `lease`/`now` are optional
 * so existing `(row, caller)` call sites keep working (absent → fresh `now` + null
 * lease → fail-safe-to-live). The `claimStatus` value is unchanged (additive).
 */
export function withClaimStatus<T extends { assigneeId?: string | null }>(
  row: T,
  caller?: { id: string } | null,
  lease?: ClaimLeaseRow | null,
  now?: Date,
): T & { claimStatus: ClaimStatus; claimState: ClaimState } {
  return {
    ...row,
    claimStatus: deriveClaimStatus(row.assigneeId ?? null, caller),
    claimState: deriveClaimState(
      row.assigneeId ?? null,
      lease ?? null,
      now ?? new Date(),
      caller,
    ),
  };
}

export function assertTaskClaimOk(
  task: { id: string; assigneeId?: string | null },
  actor: Actor,
): void {
  assertClaimOkRaw(task.assigneeId ?? null, actor, "task", "task", task.id);
}

/**
 * Resolve a label name to its id within a single project. Returns null
 * if no matching label exists — callers should treat that as "no match"
 * so the filter narrows to an empty result rather than silently
 * matching everything.
 */
function resolveLabelIdByName(
  projectId: string,
  name: string,
): string | null {
  const db = getDb();
  const row = db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.projectId, projectId), eq(labels.name, name)))
    .get();
  return row?.id ?? null;
}

// ─── Service functions ────────────────────────────────────────────

/**
 * List tasks for a project with rich filtering, sorting, and pagination.
 * The optional `caller` is used to (a) resolve the `claim` filter
 * relative to the caller and (b) decorate each task with `claimStatus`.
 */
export function list(
  projectId: string,
  filters?: TaskListFilters,
  caller?: { id: string } | null,
) {
  const db = getDb();

  const conditions: SQL[] = [eq(tasks.projectId, projectId)];

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
        )})`,
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
  let labelId = filters?.label;
  if (!labelId && filters?.labelName) {
    const resolved = resolveLabelIdByName(projectId, filters.labelName);
    // If the name doesn't resolve, force an empty result.
    labelId = resolved ?? "__no_match__";
  }
  if (labelId) {
    conditions.push(
      sql`${tasks.id} IN (
        SELECT ${taskLabels.taskId} FROM ${taskLabels}
        WHERE ${taskLabels.labelId} = ${labelId}
      )`,
    );
  }

  // Claim filter (relative to caller): "available" = unclaimed OR mine;
  // "mine" = claimed by me; "all" = no restriction.
  if (filters?.claim && filters.claim !== "all" && caller) {
    if (filters.claim === "mine") {
      conditions.push(eq(tasks.assigneeId, caller.id));
    } else {
      const availClause = or(
        isNull(tasks.assigneeId),
        eq(tasks.assigneeId, caller.id),
      );
      if (availClause) conditions.push(availClause);
    }
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
        )`,
      );
    } else {
      // Tasks that either have no blocking deps, or all blocking deps are done
      conditions.push(
        sql`${tasks.id} NOT IN (
          SELECT td.task_id FROM task_dependencies td
          INNER JOIN tasks t2 ON t2.id = td.depends_on_task_id
          WHERE td.dependency_type = 'blocks' AND t2.status != 'done'
        )`,
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
    const columnMap: Record<string, SQLWrapper> = {
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

  const leases = readLeasesFor(
    "task",
    data.map((t) => t.id),
  );
  const now = new Date();

  return {
    data: enrichTasks(data).map((t) =>
      withClaimStatus(t, caller ?? null, leases.get(t.id) ?? null, now),
    ),
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
 * Optional `caller` is used to set `claimStatus` relative to the caller.
 */
export function getById(id: string, caller?: { id: string } | null) {
  const db = getDb();
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();

  if (!task) {
    throw new AppError(404, "NOT_FOUND", `Task not found: ${id}`);
  }

  return withClaimStatus(
    enrichTask(task),
    caller ?? null,
    readLease("task", task.id),
    new Date(),
  );
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
      sourceNoteId: data.sourceNoteId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const result = getById(id, actor ? { id: actor.id } : null);

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

  // AI agents must hold the claim (be the assignee) to write to a task.
  // Humans always pass. This mirrors proposals/epics.
  if (actor) {
    assertTaskClaimOk(existing, { id: actor.id, type: actor.type as UserType });
  }

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

  const result = getById(id, actor ? { id: actor.id } : null);

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

  // FOLD-IN: keep the lease in sync with a direct assignee PATCH so no orphan
  // lease survives a reassign/unassign. Unassigned → delete; reassigned to a
  // different holder → acquire to the new holder (acquire = create-or-overwrite).
  if (isAssignment) {
    if (data.assigneeId == null) {
      deleteLease("task", id);
    } else {
      acquireLease("task", id, { id: data.assigneeId });
    }
  }

  return result;
}

/**
 * Archive a task (set status to "cancelled"). Throws 404 if not found.
 */
export function archive(id: string, actor?: AuthUser) {
  const existing = getById(id);
  const db = getDb();
  const now = new Date().toISOString();

  db.update(tasks)
    .set({ status: "cancelled", updatedAt: now })
    .where(eq(tasks.id, id))
    .run();

  // cancelled is terminal — tear down the lease (fixes the R4 leak where an
  // archived-while-claimed task left a dangling lease).
  deleteLease("task", id);

  const result = getById(id, actor ? { id: actor.id } : null);

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
export function listSubtasks(
  parentTaskId: string,
  caller?: { id: string } | null,
) {
  // Verify parent exists
  getById(parentTaskId);

  const db = getDb();
  const rows = db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId))
    .all();
  const leases = readLeasesFor(
    "task",
    rows.map((r) => r.id),
  );
  const now = new Date();
  return enrichTasks(rows).map((t) =>
    withClaimStatus(t, caller ?? null, leases.get(t.id) ?? null, now),
  );
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

  // AI agents must hold the claim (be the assignee) to transition.
  // Humans bypass the gate. Use pickNextTask for atomic "claim and
  // start" — this gate only applies to direct transition calls.
  assertTaskClaimOk(existing, { id: actor.id, type: actor.type as UserType });

  // Find transition path — auto-chain through intermediate statuses if needed
  const path = isValidTaskTransition(currentStatus, toStatus)
    ? [toStatus]
    : findTaskTransitionPath(currentStatus, toStatus);

  if (!path || path.length === 0) {
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

  // Walk through each step in the path
  for (const stepStatus of path) {
    const values: Record<string, unknown> = {
      status: stepStatus,
      updatedAt: now,
    };

    if (stepStatus === "in_progress") {
      const current = getById(taskId);
      if (!current.startedAt) {
        values.startedAt = now;
      }
      values.assigneeId = actor.id;
    }

    if (stepStatus === "done") {
      values.completedAt = now;
    }

    db.update(tasks).set(values).where(eq(tasks.id, taskId)).run();
  }

  // Lease lifecycle follows the status transition: starting work (the path
  // includes in_progress, which also stamps assigneeId = actor.id) acquires the
  // lease for the actor; reaching a terminal status (done/cancelled) tears it
  // down. A path that both starts and completes (e.g. ready→done) ends terminal,
  // so the delete wins — correct.
  if (path.includes("in_progress")) {
    acquireLease("task", taskId, { id: actor.id });
  }
  if (CLAIM_TERMINAL_STATUSES.has(path[path.length - 1])) {
    deleteLease("task", taskId);
  }

  const result = getById(taskId, { id: actor.id });

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
  epicId?: string;
  taskTypes?: string[];
  maxEffort?: string;
}

/**
 * Test/internal-only override knobs for pickNextTask. These are DELIBERATELY a
 * SEPARATE parameter from the route-facing PickNextOptions so they are
 * structurally UNREACHABLE from wire input (a route/MCP handler builds
 * PickNextOptions from an explicit field allowlist and never passes a second
 * arg). They let tests pin the clock and grace deterministically.
 *
 *  - now     → pin the clock (fake timers).
 *  - graceMs → override the reclaim grace BEFORE the pick margin is added.
 */
export interface PickNextInternalOptions {
  now?: Date;
  graceMs?: number;
}

/**
 * Find and atomically claim the highest-priority ready task.
 *
 * For AI agents, checks autonomy guardrails (can_self_assign, max_concurrent_tasks).
 * Returns the claimed task, or null if nothing is available.
 *
 * Liveness: the pick runs in two phases. Phase A prefers fresh, unassigned
 * `ready` work (atomic claim). Phase B fires when Phase A found nothing: it
 * reclaims-then-claims a `ready` task whose holder's lease has lapsed past
 * TTL + grace + pick-margin. The lease engine is always active, so Phase B is
 * unconditional (no mode gate).
 *
 * `internalOpts` is a SEPARATE, internal-only override surface (see
 * PickNextInternalOptions) — wire callers MUST NOT thread it through.
 */
export function pickNextTask(
  actor: AuthUser,
  options?: PickNextOptions,
  internalOpts?: PickNextInternalOptions,
): ReturnType<typeof getById> | null {
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

  // Liveness inputs. The pick grace is STRICTER than the plain reclaim grace —
  // a pick is a takeover of another holder's work, so a just-lapsed lease (its
  // holder possibly mid-action) is never grabbed: grace + LEASE_PICK_MARGIN_MS_DEFAULT.
  const nowDate = internalOpts?.now ?? new Date();
  const pickGraceMs =
    (internalOpts?.graceMs ?? LEASE_GRACE_MS_DEFAULT) +
    LEASE_PICK_MARGIN_MS_DEFAULT;

  // Shared candidate FILTERS (everything except the assignee predicate, which
  // differs per phase). Reused by Phase A (unassigned) and Phase B (stale-held).
  const filterConditions: string[] = [];
  const filterParams: unknown[] = [];

  // Not blocked: no unresolved blocking dependencies
  filterConditions.push(`t.id NOT IN (
    SELECT td.task_id FROM task_dependencies td
    INNER JOIN tasks t2 ON t2.id = td.depends_on_task_id
    WHERE td.dependency_type = 'blocks' AND t2.status != 'done'
  )`);

  // Optional projectId filter
  if (options?.projectId) {
    filterConditions.push(`t.project_id = ?`);
    filterParams.push(options.projectId);
  }

  // Optional epicId filter
  if (options?.epicId) {
    filterConditions.push(`t.epic_id = ?`);
    filterParams.push(options.epicId);
  }

  // Optional taskTypes filter
  if (options?.taskTypes && options.taskTypes.length > 0) {
    const placeholders = options.taskTypes.map(() => "?").join(", ");
    filterConditions.push(`t.type IN (${placeholders})`);
    filterParams.push(...options.taskTypes);
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
      filterConditions.push(`(${effortConditions.join(" OR ")})`);
    }
  }

  const PRIORITY_ORDER_SQL = `
    CASE t.priority
      WHEN 'critical' THEN 0
      WHEN 'high' THEN 1
      WHEN 'medium' THEN 2
      WHEN 'low' THEN 3
      ELSE 4
    END ASC,
    t.created_at ASC`;

  // Opportunistic stale-claim sweep before we pick: frees lapsed task claims
  // (TTL + grace) so they re-enter the available pool. Return discarded — the
  // pick proceeds against the freshly-swept state. Uses the plain reclaim grace
  // (a general cleanup), distinct from the stricter pick-margin grace Phase B
  // applies to the specific task it takes over.
  sweepStaleClaims({ entityType: "task" });

  const now = nowDate.toISOString();

  // Shared atomic-claim closure: the EXACT existing claim UPDATE (guarded by
  // status='ready' AND assignee_id IS NULL + changes===0). Used by both phases.
  // Runs in its own txn; returns the claimed id or null on a lost race.
  const claimAtomically = (candidate: {
    id: string;
    project_id: string;
  }): string | null => {
    const txn = rawDb.transaction(() => {
      // For AI agents without a projectId filter, check guardrails per-candidate
      if (actor.type === "ai_agent" && !options?.projectId) {
        autonomyService.checkGuardrail(
          actor,
          "self_assign",
          candidate.project_id,
        );
      }

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

      const result = rawDb
        .prepare(updateSql)
        .run(actor.id, now, now, candidate.id);

      if (result.changes === 0) {
        // Another caller claimed it between our SELECT and UPDATE
        return null;
      }

      return candidate.id;
    });

    return txn();
  };

  // ── Phase A (ALL modes): prefer fresh, UNASSIGNED ready work ──────────────
  // Today's exact candidate select + atomic claim. If something here lands the
  // behavior is byte-identical to pre-C3.P3 (preserves precedence: fresh
  // unassigned work beats reclaiming a stale-held task).
  let claimedId: string | null = null;
  {
    const whereClause = ["t.status = 'ready'", "t.assignee_id IS NULL", ...filterConditions].join(
      " AND ",
    );
    const candidateSql = `
      SELECT t.id, t.project_id FROM tasks t
      WHERE ${whereClause}
      ORDER BY${PRIORITY_ORDER_SQL}
      LIMIT 1
    `;
    const candidate = rawDb.prepare(candidateSql).get(...filterParams) as
      | { id: string; project_id: string }
      | undefined;
    if (candidate) {
      claimedId = claimAtomically(candidate);
    }
  }

  // ── Phase B (only if Phase A found nothing): ─────────────────────────────
  // reclaim-then-claim a STALE-CLAIMED ready task. Select ready tasks that ARE
  // assigned, join the lapsed lease (expires_at < now - pickGraceMs), re-check
  // liveness in JS (never stomp a live lease), reclaim the ONE entity (clears
  // the holder + tears down the lease + 1 audit + 1 SSE), then run the EXACT
  // atomic claim. A healed/raced candidate is skipped to the next.
  if (!claimedId) {
    const staleThreshold = new Date(
      nowDate.getTime() - pickGraceMs,
    ).toISOString();
    const whereClause = [
      "t.status = 'ready'",
      "t.assignee_id IS NOT NULL",
      "cl.expires_at < ?",
      ...filterConditions,
    ].join(" AND ");
    // The lease threshold param leads (its `?` is the first placeholder in the
    // JOIN/WHERE order), then the shared filter params — PARAMETERIZED, never
    // interpolated.
    const candidateSql = `
      SELECT t.id, t.project_id, cl.expires_at FROM tasks t
      INNER JOIN claim_leases cl
        ON cl.entity_type = 'task' AND cl.entity_id = t.id
      WHERE ${whereClause}
      ORDER BY${PRIORITY_ORDER_SQL}
      LIMIT 10
    `;
    const candidates = rawDb
      .prepare(candidateSql)
      .all(staleThreshold, ...filterParams) as {
      id: string;
      project_id: string;
      expires_at: string;
    }[];

    for (const candidate of candidates) {
      // JS re-check at the strict pick boundary — skip a still-live lease so we
      // never stomp a holder mid-action.
      if (deriveLiveness(nowDate, candidate.expires_at, pickGraceMs) !== "stale") {
        continue;
      }

      // Reclaim exactly this one entity (OUTSIDE the raw txn — same as the
      // line above this block's sweep call). A reclaim that lands clears the
      // holder + deletes the lease + writes 1 audit + emits 1 SSE.
      const swept = sweepStaleClaims({
        entityType: "task",
        entityId: candidate.id,
        graceMs: pickGraceMs,
        now: nowDate,
        actorId: actor.id,
      });
      if (swept.reclaimed.length !== 1) {
        // The candidate was healed (renew) or raced (another reclaim) — move on.
        continue;
      }

      // The task is now unassigned; run the EXACT atomic claim. If another
      // picker grabbed the now-unassigned task first, changes===0 → next.
      claimedId = claimAtomically(candidate);
      if (claimedId) break;
    }
  }

  if (!claimedId) {
    return null;
  }

  // Post-commit (OUTSIDE the txn): establish the lease for the freshly claimed
  // task. pick = atomic claim-and-start, so the picker holds the lease.
  acquireLease("task", claimedId, { id: actor.id });

  const claimedTask = getById(claimedId, { id: actor.id });

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

// ─── Claim / release ────────────────────────────────────────────

/**
 * Claim a task for an actor. Atomic via WHERE assignee_id IS NULL.
 * Idempotent for the holder (returns already_claimed_by_you).
 * Returns a ClaimResult — no claimant IDs leaked.
 */
export function claim(id: string, actor: Actor): ClaimResult {
  const db = getDb();
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();

  if (!task) {
    throw new AppError(404, "NOT_FOUND", `Task not found: ${id}`);
  }

  // Opportunistic single-entity sweep before the claim attempt (shadow no-op in
  // production; the wiring point where a lapsed lease on THIS task would be
  // reclaimed first). Discard the result — claim decides on the entity row.
  sweepStaleClaims({ entityType: "task", entityId: id });

  if (CLAIM_TERMINAL_STATUSES.has(task.status)) {
    return { ok: false, status: "closed" };
  }

  if (task.assigneeId === actor.id) {
    // Idempotent re-claim: establish the lease for a legacy holder whose claim
    // predates the lease engine (or whose lease lapsed) so the activity ledger
    // is re-armed even on the no-op path.
    acquireLease("task", id, { id: actor.id });
    return { ok: true, status: "already_claimed_by_you" };
  }

  if (task.assigneeId && task.assigneeId !== actor.id) {
    return { ok: false, status: "claimed_by_another_agent" };
  }

  const now = new Date().toISOString();
  const upd = db
    .update(tasks)
    .set({ assigneeId: actor.id, updatedAt: now })
    .where(and(eq(tasks.id, id), isNull(tasks.assigneeId)))
    .run();

  if (upd.changes === 0) {
    return { ok: false, status: "claimed_by_another_agent" };
  }

  const fresh = db.select().from(tasks).where(eq(tasks.id, id)).get()!;

  // Establish the lease for the new holder.
  acquireLease("task", id, { id: actor.id });

  getEventBus().emit(EVENT_NAMES.TASK_CLAIMED, {
    entity: fresh,
    entityType: "task",
    entityId: id,
    projectId: task.projectId,
    actorId: actor.id,
    timestamp: now,
    changes: { assignee_id: { from: null, to: actor.id } },
  });

  return { ok: true, status: "claimed_by_you" };
}

/**
 * Release a task claim. Humans can release any claim; AI agents only
 * their own.
 */
export function release(id: string, actor: Actor): ClaimResult {
  const db = getDb();
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();

  if (!task) {
    throw new AppError(404, "NOT_FOUND", `Task not found: ${id}`);
  }

  if (!task.assigneeId) {
    return { ok: false, status: "not_held" };
  }

  if (actor.type === "ai_agent" && task.assigneeId !== actor.id) {
    return { ok: false, status: "claimed_by_another_agent" };
  }

  const now = new Date().toISOString();
  const previousAssignee = task.assigneeId;
  db.update(tasks)
    .set({ assigneeId: null, updatedAt: now })
    .where(eq(tasks.id, id))
    .run();

  // The holder is gone — tear down the lease.
  deleteLease("task", id);

  const fresh = db.select().from(tasks).where(eq(tasks.id, id)).get()!;

  getEventBus().emit(EVENT_NAMES.TASK_RELEASED, {
    entity: fresh,
    entityType: "task",
    entityId: id,
    projectId: task.projectId,
    actorId: actor.id,
    timestamp: now,
    changes: { assignee_id: { from: previousAssignee, to: null } },
  });

  return { ok: true, status: "released" };
}

/**
 * Force-claim (take over) a task claim — reason-required + audited. Delegates
 * to the shared helper (the DRY home for the authz/reason/audit logic).
 */
const TASK_HANDOFF_CFG: ForceClaimConfig = {
  table: tasks,
  holderKey: "assigneeId",
  holderJsonKey: "assignee_id",
  terminalStatuses: CLAIM_TERMINAL_STATUSES,
  eventName: EVENT_NAMES.TASK_CLAIM_FORCED,
  entityType: "task",
};

export function forceClaim(
  id: string,
  actor: Actor,
  opts: { reason: string; newAssigneeId?: string | null },
): ForceClaimResult {
  return forceClaimShared(id, actor, opts, TASK_HANDOFF_CFG);
}

/**
 * release-to — hand this task's claim to a named worker (audited). The holder
 * (or a human) may release to another worker. Delegates to the shared helper.
 */
export function releaseTo(
  id: string,
  actor: Actor,
  opts: { reason: string; targetId: string },
): ReleaseToResult {
  return releaseToShared(id, actor, opts, TASK_HANDOFF_CFG);
}

/**
 * request-takeover — ask to take over this task's claim (stomp-safe). A stale
 * claim auto-grants to the requester; a live claim only notifies its holder.
 */
export function requestTakeover(
  id: string,
  actor: Actor,
  opts: { reason: string },
): RequestTakeoverResult {
  return requestTakeoverShared(id, actor, opts, TASK_HANDOFF_CFG);
}

// ─── Awareness ─────────────────────────────────────────────────

export interface AwarenessInFlight {
  taskId: string;
  title: string;
  assignee: {
    id: string;
    name: string | null;
    type: string | null;
  } | null;
  gitBranch: string | null;
  startedAt: string | null;
  // C3.P1: the identity-masked liveness of the in-flight task's claim. Awareness
  // is caller-agnostic (list is called without a caller below), so this is only
  // ever "live" / "stale" / "unclaimed" — never "yours".
  claimState: ClaimState;
}

export interface AwarenessResult {
  label: string | null;
  inFlight: AwarenessInFlight[];
  total: number;
}

/**
 * Return the in-flight (status=in_progress) tasks in a project,
 * optionally narrowed to those carrying a given label by name. This is
 * the boundary query agents use to detect concurrent activity in a
 * subsystem before starting work.
 */
export function awareness(
  projectId: string,
  labelName: string | null,
): AwarenessResult {
  // Project existence is enforced by upstream routes; the list call
  // narrows safely even for unknown projects (empty result).
  const result = list(projectId, {
    status: "in_progress",
    labelName: labelName ?? undefined,
    perPage: 100,
  });
  const inFlight: AwarenessInFlight[] = result.data.map((t) => ({
    taskId: t.id,
    title: t.title,
    assignee: t.assigneeId
      ? {
          id: t.assigneeId,
          name: t.assigneeName,
          type: t.assigneeType,
        }
      : null,
    gitBranch: t.gitBranch,
    startedAt: t.startedAt,
    claimState: t.claimState,
  }));
  return { label: labelName, inFlight, total: inFlight.length };
}
