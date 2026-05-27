import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { EPIC_STATUSES, PRIORITIES } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as epicService from "../services/epic.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const taskSummarySchema = z.object({
  total: z.number(),
  done: z.number(),
  byStatus: z.record(z.string(), z.number()),
});

const epicSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    proposalId: z.string().nullable(),
    milestoneId: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    priority: z.string(),
    targetDate: z.string().nullable(),
    sortOrder: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    createdBy: z.string().nullable(),
    taskSummary: taskSummarySchema,
  })
  .openapi("Epic");

const epicDataEnvelope = z.object({
  data: epicSchema,
});

const epicListEnvelope = z.object({
  data: z.array(epicSchema),
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

const createEpicBody = z
  .object({
    name: z.string().min(1, "Name is required"),
    description: z.string().nullable().optional(),
    status: z.enum(EPIC_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    proposalId: z.string().nullable().optional(),
    milestoneId: z.string().nullable().optional(),
    targetDate: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  })
  .openapi("CreateEpic");

const updateEpicBody = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: z.enum(EPIC_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    proposalId: z.string().nullable().optional(),
    milestoneId: z.string().nullable().optional(),
    targetDate: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  })
  .openapi("UpdateEpic");

const epicIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

// ─── Route definitions ────────────────────────────────────────────

const listEpicsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/epics",
  tags: ["Epics"],
  summary: "List epics",
  description: "List all epics for a project with optional status and milestone filters.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: z.object({
      status: z.enum(EPIC_STATUSES).optional(),
      milestone: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "List of epics",
      content: { "application/json": { schema: epicListEnvelope } },
    },
  },
});

const createEpicRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/epics",
  tags: ["Epics"],
  summary: "Create epic",
  description: "Create a new epic in a project.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: {
      content: { "application/json": { schema: createEpicBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Epic created",
      content: { "application/json": { schema: epicDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getEpicRoute = createRoute({
  method: "get",
  path: "/api/v1/epics/{id}",
  tags: ["Epics"],
  summary: "Get epic",
  description: "Get an epic by ID with task summary.",
  request: {
    params: z.object({ id: epicIdParam }),
  },
  responses: {
    200: {
      description: "Epic details",
      content: { "application/json": { schema: epicDataEnvelope } },
    },
    404: {
      description: "Epic not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updateEpicRoute = createRoute({
  method: "patch",
  path: "/api/v1/epics/{id}",
  tags: ["Epics"],
  summary: "Update epic",
  description: "Update epic fields.",
  request: {
    params: z.object({ id: epicIdParam }),
    body: {
      content: { "application/json": { schema: updateEpicBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Epic updated",
      content: { "application/json": { schema: epicDataEnvelope } },
    },
    404: {
      description: "Epic not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deleteEpicRoute = createRoute({
  method: "delete",
  path: "/api/v1/epics/{id}",
  tags: ["Epics"],
  summary: "Archive epic",
  description: "Soft-delete an epic by setting its status to cancelled.",
  request: {
    params: z.object({ id: epicIdParam }),
  },
  responses: {
    200: {
      description: "Epic archived",
      content: { "application/json": { schema: epicDataEnvelope } },
    },
    404: {
      description: "Epic not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createEpicRoutes(): OpenAPIHono<{ Variables: AppVariables }> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:projectId/epics
  router.openapi(listEpicsRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const { status, milestone } = c.req.valid("query");
    const epicsList = epicService.list(
      projectId,
      status || milestone ? { status, milestone } : undefined,
    );

    return c.json(
      {
        data: epicsList,
        pagination: { total: epicsList.length },
      },
      200,
    );
  });

  // POST /api/v1/projects/:projectId/epics
  router.openapi(createEpicRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const epic = epicService.create({ ...body, projectId });

    return c.json({ data: epic }, 201);
  });

  // GET /api/v1/epics/:id
  router.openapi(getEpicRoute, (c) => {
    const { id } = c.req.valid("param");
    const epic = epicService.getById(id);

    return c.json({ data: epic }, 200);
  });

  // PATCH /api/v1/epics/:id
  router.openapi(updateEpicRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const epic = epicService.update(id, body);

    return c.json({ data: epic }, 200);
  });

  // DELETE /api/v1/epics/:id
  router.openapi(deleteEpicRoute, (c) => {
    const { id } = c.req.valid("param");
    const epic = epicService.archive(id);

    return c.json({ data: epic }, 200);
  });

  return router;
}
