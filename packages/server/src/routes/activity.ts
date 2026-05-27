import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ENTITY_TYPES, ACTIVITY_ACTIONS } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as activityService from "../services/activity.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const activitySchema = z
  .object({
    id: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    projectId: z.string().nullable(),
    actorId: z.string().nullable(),
    action: z.string(),
    changes: z.unknown().nullable(),
    createdAt: z.string(),
  })
  .openapi("ActivityLogEntry");

const activityListEnvelope = z.object({
  data: z.array(activitySchema),
  pagination: z.object({
    page: z.number(),
    perPage: z.number(),
    total: z.number(),
    totalPages: z.number(),
  }),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ──────────────────────────────────────────────

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const taskIdParam = z.string().min(1).openapi({
  param: { name: "taskId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

// ─── Route definitions ────────────────────────────────────────────

const listProjectActivityRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/activity",
  tags: ["Activity"],
  summary: "Project activity feed",
  description:
    "Get paginated activity feed for a project, with optional filters.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: z.object({
      entity_type: z.string().optional(),
      actor_id: z.string().optional(),
      page: z.coerce.number().int().min(1).optional(),
      per_page: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Activity feed",
      content: { "application/json": { schema: activityListEnvelope } },
    },
  },
});

const listTaskActivityRoute = createRoute({
  method: "get",
  path: "/api/v1/tasks/{taskId}/activity",
  tags: ["Activity"],
  summary: "Task activity history",
  description: "Get activity history for a specific task.",
  request: {
    params: z.object({ taskId: taskIdParam }),
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      per_page: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Task activity history",
      content: { "application/json": { schema: activityListEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createActivityRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:projectId/activity
  router.openapi(listProjectActivityRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const { entity_type, actor_id, page, per_page } = c.req.valid("query");
    const result = activityService.listByProject(projectId, {
      entityType: entity_type,
      actorId: actor_id,
      page,
      perPage: per_page,
    });

    return c.json(result, 200);
  });

  // GET /api/v1/tasks/:taskId/activity
  router.openapi(listTaskActivityRoute, (c) => {
    const { taskId } = c.req.valid("param");
    const { page, per_page } = c.req.valid("query");
    const result = activityService.listByEntity("task", taskId, {
      page,
      perPage: per_page,
    });

    return c.json(result, 200);
  });

  return router;
}
