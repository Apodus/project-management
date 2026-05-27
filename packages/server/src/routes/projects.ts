import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROJECT_STATUSES } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as projectService from "../services/project.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const projectSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    gitRepoUrl: z.string().nullable(),
    settings: z.unknown().nullable(),
    sortOrder: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    createdBy: z.string().nullable(),
  })
  .openapi("Project");

const projectDataEnvelope = z.object({
  data: projectSchema,
});

const projectListEnvelope = z.object({
  data: z.array(projectSchema),
  pagination: z.object({
    total: z.number(),
  }),
});

const projectStatsSchema = z
  .object({
    tasksByStatus: z.record(z.string(), z.number()),
    totalTasks: z.number(),
    epicCount: z.number(),
    proposalCount: z.number(),
  })
  .openapi("ProjectStats");

const projectStatsEnvelope = z.object({
  data: projectStatsSchema,
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ──────────────────────────────────────────────

const createProjectBody = z
  .object({
    name: z.string().min(1, "Name is required"),
    description: z.string().nullable().optional(),
    gitRepoUrl: z.string().nullable().optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    settings: z.unknown().nullable().optional(),
    sortOrder: z.number().int().optional(),
  })
  .openapi("CreateProject");

const updateProjectBody = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    gitRepoUrl: z.string().nullable().optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    settings: z.unknown().nullable().optional(),
    sortOrder: z.number().int().optional(),
  })
  .openapi("UpdateProject");

const projectIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

// ─── Route definitions ────────────────────────────────────────────

const listProjectsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects",
  tags: ["Projects"],
  summary: "List projects",
  description: "List all projects with optional status filter.",
  request: {
    query: z.object({
      status: z.enum(PROJECT_STATUSES).optional(),
    }),
  },
  responses: {
    200: {
      description: "List of projects",
      content: { "application/json": { schema: projectListEnvelope } },
    },
  },
});

const createProjectRoute = createRoute({
  method: "post",
  path: "/api/v1/projects",
  tags: ["Projects"],
  summary: "Create project",
  description: "Create a new project. A slug is auto-generated from the name.",
  request: {
    body: {
      content: { "application/json": { schema: createProjectBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Project created",
      content: { "application/json": { schema: projectDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getProjectRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{id}",
  tags: ["Projects"],
  summary: "Get project",
  description: "Get a project by ID.",
  request: {
    params: z.object({ id: projectIdParam }),
  },
  responses: {
    200: {
      description: "Project details",
      content: { "application/json": { schema: projectDataEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updateProjectRoute = createRoute({
  method: "patch",
  path: "/api/v1/projects/{id}",
  tags: ["Projects"],
  summary: "Update project",
  description: "Update project fields.",
  request: {
    params: z.object({ id: projectIdParam }),
    body: {
      content: { "application/json": { schema: updateProjectBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Project updated",
      content: { "application/json": { schema: projectDataEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deleteProjectRoute = createRoute({
  method: "delete",
  path: "/api/v1/projects/{id}",
  tags: ["Projects"],
  summary: "Archive project",
  description: "Soft-delete a project by setting its status to archived.",
  request: {
    params: z.object({ id: projectIdParam }),
  },
  responses: {
    200: {
      description: "Project archived",
      content: { "application/json": { schema: projectDataEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getProjectStatsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{id}/stats",
  tags: ["Projects"],
  summary: "Project statistics",
  description: "Get task counts by status, epic count, and proposal count for a project.",
  request: {
    params: z.object({ id: projectIdParam }),
  },
  responses: {
    200: {
      description: "Project statistics",
      content: { "application/json": { schema: projectStatsEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createProjectRoutes(): OpenAPIHono<{ Variables: AppVariables }> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects
  router.openapi(listProjectsRoute, (c) => {
    const { status } = c.req.valid("query");
    const projectsList = projectService.list(status ? { status } : undefined);

    return c.json(
      {
        data: projectsList,
        pagination: { total: projectsList.length },
      },
      200,
    );
  });

  // POST /api/v1/projects
  router.openapi(createProjectRoute, (c) => {
    const body = c.req.valid("json");
    const project = projectService.create(body);

    return c.json({ data: project }, 201);
  });

  // GET /api/v1/projects/:id
  router.openapi(getProjectRoute, (c) => {
    const { id } = c.req.valid("param");
    const project = projectService.getById(id);

    return c.json({ data: project }, 200);
  });

  // PATCH /api/v1/projects/:id
  router.openapi(updateProjectRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const project = projectService.update(id, body);

    return c.json({ data: project }, 200);
  });

  // DELETE /api/v1/projects/:id
  router.openapi(deleteProjectRoute, (c) => {
    const { id } = c.req.valid("param");
    const project = projectService.archive(id);

    return c.json({ data: project }, 200);
  });

  // GET /api/v1/projects/:id/stats
  router.openapi(getProjectStatsRoute, (c) => {
    const { id } = c.req.valid("param");
    const stats = projectService.getStats(id);

    return c.json({ data: stats }, 200);
  });

  return router;
}
