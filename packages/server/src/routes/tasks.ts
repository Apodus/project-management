import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  TASK_STATUSES,
  PRIORITIES,
  TASK_TYPES,
  EFFORT_SIZES,
} from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as taskService from "../services/task.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const taskContextSchema = z
  .object({
    relevant_files: z.array(z.string()).optional(),
    codebase_areas: z.array(z.string()).optional(),
    acceptance_criteria: z.array(z.string()).optional(),
    design_references: z.array(z.string()).optional(),
    notes: z.string().optional(),
    implementation_hints: z.string().optional(),
  })
  .nullable();

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
  })
  .openapi("Task");

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
    reporterId: z.string(),
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
    reporterId: z.string(),
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

// ─── Router ───────────────────────────────────────────────────────

export function createTaskRoutes(): OpenAPIHono<{ Variables: AppVariables }> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:projectId/tasks
  router.openapi(listTasksRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const query = c.req.valid("query");
    const result = taskService.list(projectId, {
      status: query.status,
      priority: query.priority,
      type: query.type,
      assignee: query.assignee,
      epic: query.epic,
      search: query.search,
      sortBy: query.sortBy,
      order: query.order,
      page: query.page,
      perPage: query.perPage,
    });

    return c.json(result, 200);
  });

  // POST /api/v1/projects/:projectId/tasks
  router.openapi(createTaskRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const task = taskService.create({ ...body, projectId });

    return c.json({ data: task }, 201);
  });

  // GET /api/v1/tasks/:id
  router.openapi(getTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const task = taskService.getById(id);

    return c.json({ data: task }, 200);
  });

  // PATCH /api/v1/tasks/:id
  router.openapi(updateTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const task = taskService.update(id, body);

    return c.json({ data: task }, 200);
  });

  // DELETE /api/v1/tasks/:id
  router.openapi(deleteTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const task = taskService.archive(id);

    return c.json({ data: task }, 200);
  });

  // POST /api/v1/tasks/:id/subtasks
  router.openapi(createSubtaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const subtask = taskService.createSubtask(id, body);

    return c.json({ data: subtask }, 201);
  });

  // GET /api/v1/tasks/:id/subtasks
  router.openapi(listSubtasksRoute, (c) => {
    const { id } = c.req.valid("param");
    const subtasks = taskService.listSubtasks(id);

    return c.json(
      {
        data: subtasks,
        pagination: { total: subtasks.length },
      },
      200,
    );
  });

  return router;
}
