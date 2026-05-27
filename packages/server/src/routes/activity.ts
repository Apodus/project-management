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
      since: z.string().optional(),
      exclude_actor: z.string().optional(),
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

const updatesResponseSchema = z.object({
  has_updates: z.boolean(),
  count: z.number(),
  data: z.array(activitySchema),
});

const listUpdatesRoute = createRoute({
  method: "get",
  path: "/api/v1/activity/updates",
  tags: ["Activity"],
  summary: "Check for recent updates",
  description:
    "Returns recent activity by other users since a given timestamp. Designed for agents polling for human input between work steps.",
  request: {
    query: z.object({
      since: z.string().min(1),
      project_id: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Recent updates",
      content: { "application/json": { schema: updatesResponseSchema } },
    },
    400: {
      description: "Missing required parameter",
      content: { "application/json": { schema: errorEnvelope } },
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
    const { entity_type, actor_id, since, exclude_actor, page, per_page } = c.req.valid("query");
    const result = activityService.listByProject(projectId, {
      entityType: entity_type,
      actorId: actor_id,
      since,
      excludeActorId: exclude_actor,
      page,
      perPage: per_page,
    });

    return c.json(result, 200);
  });

  // GET /api/v1/activity/updates
  router.openapi(listUpdatesRoute, (c) => {
    const { since, project_id } = c.req.valid("query");
    const currentUser = c.get("currentUser");
    const excludeActorId = currentUser?.id ?? "";

    const result = activityService.listUpdates({
      since,
      excludeActorId,
      projectId: project_id,
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
