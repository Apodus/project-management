import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  CLAIM_RESULT_STATUSES,
  CLAIM_STATUSES,
  CLAIM_STATES,
  TASK_STATUSES,
  PRIORITIES,
  TASK_TYPES,
  EFFORT_SIZES,
} from "@pm/shared";
import type { TaskStatus, UserType } from "@pm/shared";
import type { AppVariables, AuthUser } from "../types.js";
import * as taskService from "../services/task.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const taskSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    proposalId: z.string().nullable(),
    epicId: z.string().nullable(),
    parentTaskId: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    priority: z.string(),
    type: z.string(),
    assigneeId: z.string().nullable(),
    reporterId: z.string(),
    estimatedEffort: z.string().nullable(),
    dueDate: z.string().nullable(),
    sortOrder: z.number(),
    context: z.unknown().nullable(),
    gitBranch: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    // Server-enriched display names for foreign-key references.
    // Lets clients (especially MCP) talk about tasks by name without
    // separate lookup calls.
    epicName: z.string().nullable(),
    projectName: z.string().nullable(),
    parentTaskTitle: z.string().nullable(),
    assigneeName: z.string().nullable(),
    assigneeType: z.string().nullable(),
    reporterName: z.string().nullable(),
    reporterType: z.string().nullable(),
    claimStatus: z.enum(CLAIM_STATUSES),
    claimState: z.enum(CLAIM_STATES),
  })
  .openapi("Task");

const claimResultSchema = z
  .object({
    ok: z.boolean(),
    status: z.enum(CLAIM_RESULT_STATUSES),
  })
  .openapi("TaskClaimResult");

const claimResultEnvelope = z.object({ data: claimResultSchema });

const forceClaimBody = z
  .object({
    reason: z.string().min(1).max(2048),
    newAssigneeId: z.string().optional(),
  })
  .openapi("ForceClaimTask");

const forceClaimResultEnvelope = z.object({
  data: z.object({
    ok: z.boolean(),
    status: z.literal("force_claimed"),
    previousHolder: z.string(),
    newHolder: z.string(),
  }),
});

// Handoff bodies (Campaign C3 §P5b).
const releaseToBody = z
  .object({
    reason: z.string().min(1).max(2048),
    targetId: z.string().min(1),
  })
  .openapi("ReleaseTask");

const requestTakeoverBody = z
  .object({
    reason: z.string().min(1).max(2048),
  })
  .openapi("RequestTakeoverTask");

const requestTakeoverResultEnvelope = z.object({
  data: z.object({
    ok: z.boolean(),
    status: z.enum(CLAIM_RESULT_STATUSES),
    previousHolder: z.string().optional(),
    newHolder: z.string().optional(),
  }),
});

const awarenessAssigneeSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  type: z.string().nullable(),
});

const awarenessInFlightSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  assignee: awarenessAssigneeSchema.nullable(),
  gitBranch: z.string().nullable(),
  startedAt: z.string().nullable(),
  claimState: z.enum(CLAIM_STATES),
});

const awarenessSchema = z
  .object({
    label: z.string().nullable(),
    inFlight: z.array(awarenessInFlightSchema),
    total: z.number().int(),
  })
  .openapi("Awareness");

const awarenessEnvelope = z.object({ data: awarenessSchema });

const taskDataEnvelope = z.object({
  data: taskSchema,
});

const taskListEnvelope = z.object({
  data: z.array(taskSchema),
  pagination: z.object({
    page: z.number(),
    perPage: z.number(),
    total: z.number(),
    totalPages: z.number(),
  }),
});

const subtaskListEnvelope = z.object({
  data: z.array(taskSchema),
  pagination: z.object({
    total: z.number(),
  }),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ──────────────────────────────────────────────

const createTaskBody = z
  .object({
    title: z.string().min(1, "Title is required"),
    description: z.string().nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    type: z.enum(TASK_TYPES).optional(),
    assigneeId: z.string().nullable().optional(),
    reporterId: z.string().optional(),
    epicId: z.string().nullable().optional(),
    proposalId: z.string().nullable().optional(),
    estimatedEffort: z.enum(EFFORT_SIZES).nullable().optional(),
    dueDate: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
    context: z
      .object({
        relevant_files: z.array(z.string()).optional(),
        codebase_areas: z.array(z.string()).optional(),
        acceptance_criteria: z.array(z.string()).optional(),
        design_references: z.array(z.string()).optional(),
        notes: z.string().optional(),
        implementation_hints: z.string().optional(),
      })
      .nullable()
      .optional(),
    gitBranch: z.string().nullable().optional(),
  })
  .openapi("CreateTask");

const createSubtaskBody = z
  .object({
    title: z.string().min(1, "Title is required"),
    description: z.string().nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    type: z.enum(TASK_TYPES).optional(),
    assigneeId: z.string().nullable().optional(),
    reporterId: z.string().optional(),
    epicId: z.string().nullable().optional(),
    proposalId: z.string().nullable().optional(),
    estimatedEffort: z.enum(EFFORT_SIZES).nullable().optional(),
    dueDate: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
    context: z
      .object({
        relevant_files: z.array(z.string()).optional(),
        codebase_areas: z.array(z.string()).optional(),
        acceptance_criteria: z.array(z.string()).optional(),
        design_references: z.array(z.string()).optional(),
        notes: z.string().optional(),
        implementation_hints: z.string().optional(),
      })
      .nullable()
      .optional(),
    gitBranch: z.string().nullable().optional(),
  })
  .openapi("CreateSubtask");

const updateTaskBody = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    type: z.enum(TASK_TYPES).optional(),
    assigneeId: z.string().nullable().optional(),
    reporterId: z.string().optional(),
    epicId: z.string().nullable().optional(),
    proposalId: z.string().nullable().optional(),
    estimatedEffort: z.enum(EFFORT_SIZES).nullable().optional(),
    dueDate: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
    context: z
      .object({
        relevant_files: z.array(z.string()).optional(),
        codebase_areas: z.array(z.string()).optional(),
        acceptance_criteria: z.array(z.string()).optional(),
        design_references: z.array(z.string()).optional(),
        notes: z.string().optional(),
        implementation_hints: z.string().optional(),
      })
      .nullable()
      .optional(),
    gitBranch: z.string().nullable().optional(),
    startedAt: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
  })
  .openapi("UpdateTask");

const taskIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

// ─── Route definitions ────────────────────────────────────────────

const listTasksRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/tasks",
  tags: ["Tasks"],
  summary: "List tasks",
  description:
    "List tasks for a project with rich filtering, sorting, and pagination.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: z.object({
      status: z.string().optional(),
      priority: z.enum(PRIORITIES).optional(),
      type: z.enum(TASK_TYPES).optional(),
      assignee: z.string().optional(),
      epic: z.string().optional(),
      search: z.string().optional(),
      label: z.string().optional(),
      label_name: z.string().optional(),
      claim: z.enum(["available", "mine", "all"]).optional(),
      is_blocked: z.enum(["true", "false"]).optional(),
      sortBy: z
        .enum(["priority", "created_at", "updated_at", "due_date", "sort_order"])
        .optional(),
      order: z.enum(["asc", "desc"]).optional(),
      page: z.coerce.number().int().positive().optional(),
      perPage: z.coerce.number().int().positive().max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "List of tasks",
      content: { "application/json": { schema: taskListEnvelope } },
    },
  },
});

const createTaskRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/tasks",
  tags: ["Tasks"],
  summary: "Create task",
  description: "Create a new task in a project.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: {
      content: { "application/json": { schema: createTaskBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Task created",
      content: { "application/json": { schema: taskDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getTaskRoute = createRoute({
  method: "get",
  path: "/api/v1/tasks/{id}",
  tags: ["Tasks"],
  summary: "Get task",
  description: "Get a task by ID with full details.",
  request: {
    params: z.object({ id: taskIdParam }),
  },
  responses: {
    200: {
      description: "Task details",
      content: { "application/json": { schema: taskDataEnvelope } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updateTaskRoute = createRoute({
  method: "patch",
  path: "/api/v1/tasks/{id}",
  tags: ["Tasks"],
  summary: "Update task",
  description: "Update task fields. Context JSON is merged with existing context.",
  request: {
    params: z.object({ id: taskIdParam }),
    body: {
      content: { "application/json": { schema: updateTaskBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Task updated",
      content: { "application/json": { schema: taskDataEnvelope } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deleteTaskRoute = createRoute({
  method: "delete",
  path: "/api/v1/tasks/{id}",
  tags: ["Tasks"],
  summary: "Archive task",
  description: "Soft-delete a task by setting its status to cancelled.",
  request: {
    params: z.object({ id: taskIdParam }),
  },
  responses: {
    200: {
      description: "Task archived",
      content: { "application/json": { schema: taskDataEnvelope } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const createSubtaskRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/{id}/subtasks",
  tags: ["Tasks"],
  summary: "Create subtask",
  description: "Create a subtask of a given task. Inherits the parent's project.",
  request: {
    params: z.object({ id: taskIdParam }),
    body: {
      content: { "application/json": { schema: createSubtaskBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Subtask created",
      content: { "application/json": { schema: taskDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Parent task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const listSubtasksRoute = createRoute({
  method: "get",
  path: "/api/v1/tasks/{id}/subtasks",
  tags: ["Tasks"],
  summary: "List subtasks",
  description: "List all subtasks of a task.",
  request: {
    params: z.object({ id: taskIdParam }),
  },
  responses: {
    200: {
      description: "List of subtasks",
      content: { "application/json": { schema: subtaskListEnvelope } },
    },
    404: {
      description: "Parent task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Workflow schemas ────────────────────────────────────────────

const transitionBody = z
  .object({
    to_status: z.enum(TASK_STATUSES),
    comment: z.string().optional(),
  })
  .openapi("TransitionTask");

const pickNextBody = z
  .object({
    project_id: z.string().optional(),
    epic_id: z.string().optional(),
    task_types: z.array(z.enum(TASK_TYPES)).optional(),
    max_effort: z.enum(EFFORT_SIZES).optional(),
  })
  .openapi("PickNextTask");

// ─── Workflow route definitions ──────────────────────────────────

const transitionTaskRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/{id}/transitions",
  tags: ["Task Workflow"],
  summary: "Transition task status",
  description:
    "Change a task's status using validated workflow transitions. Optionally add a comment.",
  request: {
    params: z.object({ id: taskIdParam }),
    body: {
      content: { "application/json": { schema: transitionBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Task transitioned",
      content: { "application/json": { schema: taskDataEnvelope } },
    },
    400: {
      description: "Invalid transition",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const pickNextTaskRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/pick-next",
  tags: ["Task Workflow"],
  summary: "Pick next task",
  description:
    "Find and atomically claim the highest-priority ready task. Returns the claimed task or 404 if nothing available.",
  request: {
    body: {
      content: { "application/json": { schema: pickNextBody } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Task claimed",
      content: { "application/json": { schema: taskDataEnvelope } },
    },
    403: {
      description: "Guardrail blocked or max concurrent tasks reached",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "No task available",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Claim / release / awareness routes ─────────────────────────

const claimTaskRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/{id}/claim",
  tags: ["Tasks"],
  summary: "Claim task",
  description:
    "Atomically claim a task for the caller. Sets the caller as assignee. Returns a structured result without leaking other claimants' IDs.",
  request: { params: z.object({ id: taskIdParam }) },
  responses: {
    200: {
      description: "Claim outcome",
      content: { "application/json": { schema: claimResultEnvelope } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const forceClaimTaskRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/{id}/force-claim",
  tags: ["Tasks"],
  summary: "Force-claim task (takeover)",
  description:
    "Take over an existing claim (reason required, audited). Self-recovery when a session identity changed. Targeting another agent requires a human director.",
  request: {
    params: z.object({ id: taskIdParam }),
    body: {
      content: { "application/json": { schema: forceClaimBody } },
    },
  },
  responses: {
    200: {
      description: "Force-claim outcome",
      content: { "application/json": { schema: forceClaimResultEnvelope } },
    },
    400: {
      description: "Validation error (empty reason)",
      content: { "application/json": { schema: errorEnvelope } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Forbidden (non-human targeting another agent)",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Task or target user not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Task closed / not associated with a project",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const releaseTaskRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/{id}/release",
  tags: ["Tasks"],
  summary: "Release task claim",
  description:
    "Release the caller's claim. Humans can release any claim; AI agents only their own.",
  request: { params: z.object({ id: taskIdParam }) },
  responses: {
    200: {
      description: "Release outcome",
      content: { "application/json": { schema: claimResultEnvelope } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const releaseToTaskRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/{id}/release-to",
  tags: ["Tasks"],
  summary: "Release task claim to a named worker (handoff)",
  description:
    "Hand this task's claim to a named target worker (reason required, audited). The current holder (or a human director) may release; the lease transfers to the target. Never stomps a live claim — it directly transfers the holder's own claim.",
  request: {
    params: z.object({ id: taskIdParam }),
    body: {
      content: { "application/json": { schema: releaseToBody } },
    },
  },
  responses: {
    200: {
      description: "Release-to outcome",
      content: { "application/json": { schema: forceClaimResultEnvelope } },
    },
    400: {
      description: "Validation error (empty reason / missing target)",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Forbidden (non-holder agent)",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Task or target user not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Task closed / not associated with a project",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const requestTakeoverTaskRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/{id}/request-takeover",
  tags: ["Tasks"],
  summary: "Request takeover of a task claim (stomp-safe)",
  description:
    "Ask to take over this task's claim. A stale (lease-lapsed) claim is auto-granted to the caller; a LIVE claim is NEVER mutated — the holder is notified and the result is notified_holder.",
  request: {
    params: z.object({ id: taskIdParam }),
    body: {
      content: { "application/json": { schema: requestTakeoverBody } },
    },
  },
  responses: {
    200: {
      description: "Takeover-request outcome",
      content: {
        "application/json": { schema: requestTakeoverResultEnvelope },
      },
    },
    400: {
      description: "Validation error (empty reason)",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const awarenessRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/awareness",
  tags: ["Tasks"],
  summary: "Subsystem awareness check",
  description:
    "Return in-flight tasks for a project, optionally filtered to a label name. Used as a boundary-time check before touching a subsystem.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: z.object({ label: z.string().optional() }),
  },
  responses: {
    200: {
      description: "In-flight summary",
      content: { "application/json": { schema: awarenessEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createTaskRoutes(): OpenAPIHono<{ Variables: AppVariables }> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:projectId/tasks
  router.openapi(listTasksRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const query = c.req.valid("query");
    const user = c.get("currentUser") as AuthUser | null;
    const result = taskService.list(
      projectId,
      {
        status: query.status,
        priority: query.priority,
        type: query.type,
        assignee: query.assignee,
        epic: query.epic,
        search: query.search,
        label: query.label,
        labelName: query.label_name,
        claim: query.claim,
        is_blocked: query.is_blocked,
        sortBy: query.sortBy,
        order: query.order,
        page: query.page,
        perPage: query.perPage,
      },
      user ? { id: user.id } : null,
    );

    return c.json(result, 200);
  });

  // POST /api/v1/projects/:projectId/tasks
  router.openapi(createTaskRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("currentUser") as AuthUser | null;
    // Derive reporterId from auth. AI agents always reporter-of-record themselves
    // (can't impersonate); humans may pass an explicit reporterId to create
    // on behalf of someone else.
    const reporterId =
      actor?.type === "ai_agent"
        ? actor.id
        : (body.reporterId ?? actor?.id);
    if (!reporterId) {
      return c.json(
        { error: { code: "MISSING_REPORTER", message: "reporterId could not be determined from auth context" } },
        400,
      );
    }
    const task = taskService.create(
      { ...body, projectId, reporterId },
      actor ?? undefined,
    );

    return c.json({ data: task }, 201);
  });

  // GET /api/v1/tasks/:id
  router.openapi(getTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser") as AuthUser | null;
    const task = taskService.getById(id, user ? { id: user.id } : null);

    return c.json({ data: task }, 200);
  });

  // PATCH /api/v1/tasks/:id
  router.openapi(updateTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("currentUser") as AuthUser | null;
    const task = taskService.update(id, body, actor ?? undefined);

    return c.json({ data: task }, 200);
  });

  // DELETE /api/v1/tasks/:id
  router.openapi(deleteTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const actor = c.get("currentUser") as AuthUser | null;
    const task = taskService.archive(id, actor ?? undefined);

    return c.json({ data: task }, 200);
  });

  // POST /api/v1/tasks/:id/subtasks
  router.openapi(createSubtaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("currentUser") as AuthUser | null;
    const reporterId =
      actor?.type === "ai_agent"
        ? actor.id
        : (body.reporterId ?? actor?.id);
    if (!reporterId) {
      return c.json(
        { error: { code: "MISSING_REPORTER", message: "reporterId could not be determined from auth context" } },
        400,
      );
    }
    const subtask = taskService.createSubtask(
      id,
      { ...body, reporterId },
      actor ?? undefined,
    );

    return c.json({ data: subtask }, 201);
  });

  // GET /api/v1/tasks/:id/subtasks
  router.openapi(listSubtasksRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser") as AuthUser | null;
    const subtasks = taskService.listSubtasks(
      id,
      user ? { id: user.id } : null,
    );

    return c.json(
      {
        data: subtasks,
        pagination: { total: subtasks.length },
      },
      200,
    );
  });

  // POST /api/v1/tasks/pick-next
  router.openapi(pickNextTaskRoute, (c) => {
    const actor = c.get("currentUser") as AuthUser;
    let body: { project_id?: string; epic_id?: string; task_types?: string[]; max_effort?: string } = {};
    try {
      body = c.req.valid("json");
    } catch {
      // Body is optional — if parsing fails, use empty options
    }
    const task = taskService.pickNextTask(actor, {
      projectId: body.project_id,
      epicId: body.epic_id,
      taskTypes: body.task_types,
      maxEffort: body.max_effort,
    });

    if (!task) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "No task available" } },
        404,
      );
    }

    return c.json({ data: task }, 200);
  });

  // POST /api/v1/tasks/:id/transitions
  router.openapi(transitionTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("currentUser") as AuthUser;
    const task = taskService.transition(
      id,
      body.to_status as TaskStatus,
      actor,
      body.comment,
    );

    return c.json({ data: task }, 200);
  });

  // POST /api/v1/tasks/:id/claim
  router.openapi(claimTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser") as AuthUser;
    const result = taskService.claim(id, {
      id: user.id,
      type: user.type as UserType,
    });
    return c.json({ data: result }, 200);
  });

  // POST /api/v1/tasks/:id/force-claim
  router.openapi(forceClaimTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser") as AuthUser;
    const result = taskService.forceClaim(
      id,
      { id: user.id, type: user.type as UserType },
      { reason: body.reason, newAssigneeId: body.newAssigneeId },
    );
    return c.json({ data: result }, 200);
  });

  // POST /api/v1/tasks/:id/release
  router.openapi(releaseTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser") as AuthUser;
    const result = taskService.release(id, {
      id: user.id,
      type: user.type as UserType,
    });
    return c.json({ data: result }, 200);
  });

  // POST /api/v1/tasks/:id/release-to
  router.openapi(releaseToTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser") as AuthUser;
    const result = taskService.releaseTo(
      id,
      { id: user.id, type: user.type as UserType },
      { reason: body.reason, targetId: body.targetId },
    );
    return c.json({ data: result }, 200);
  });

  // POST /api/v1/tasks/:id/request-takeover
  router.openapi(requestTakeoverTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser") as AuthUser;
    const result = taskService.requestTakeover(
      id,
      { id: user.id, type: user.type as UserType },
      { reason: body.reason },
    );
    return c.json({ data: result }, 200);
  });

  // GET /api/v1/projects/:projectId/awareness
  router.openapi(awarenessRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const { label } = c.req.valid("query");
    const result = taskService.awareness(projectId, label ?? null);
    return c.json({ data: result }, 200);
  });

  return router;
}
