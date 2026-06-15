import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { MILESTONE_STATUSES } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as milestoneService from "../services/milestone.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const milestoneSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    targetDate: z.string().nullable(),
    status: z.string(),
    sortOrder: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Milestone");

const milestoneDataEnvelope = z.object({
  data: milestoneSchema,
});

const milestoneListEnvelope = z.object({
  data: z.array(milestoneSchema),
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

const createMilestoneBody = z
  .object({
    name: z.string().min(1, "Name is required"),
    description: z.string().nullable().optional(),
    targetDate: z.string().nullable().optional(),
    status: z.enum(MILESTONE_STATUSES).optional(),
    sortOrder: z.number().int().optional(),
  })
  .openapi("CreateMilestone");

const updateMilestoneBody = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    targetDate: z.string().nullable().optional(),
    status: z.enum(MILESTONE_STATUSES).optional(),
    sortOrder: z.number().int().optional(),
  })
  .openapi("UpdateMilestone");

const projectIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "projectId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const milestoneIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "id", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

// ─── Route definitions ────────────────────────────────────────────

const listMilestonesRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/milestones",
  tags: ["Milestones"],
  summary: "List milestones",
  description: "List all milestones for a project.",
  request: {
    params: z.object({ projectId: projectIdParam }),
  },
  responses: {
    200: {
      description: "List of milestones",
      content: { "application/json": { schema: milestoneListEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const createMilestoneRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/milestones",
  tags: ["Milestones"],
  summary: "Create milestone",
  description: "Create a new milestone for a project.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: {
      content: { "application/json": { schema: createMilestoneBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Milestone created",
      content: { "application/json": { schema: milestoneDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updateMilestoneRoute = createRoute({
  method: "patch",
  path: "/api/v1/milestones/{id}",
  tags: ["Milestones"],
  summary: "Update milestone",
  description: "Update milestone fields.",
  request: {
    params: z.object({ id: milestoneIdParam }),
    body: {
      content: { "application/json": { schema: updateMilestoneBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Milestone updated",
      content: { "application/json": { schema: milestoneDataEnvelope } },
    },
    404: {
      description: "Milestone not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deleteMilestoneRoute = createRoute({
  method: "delete",
  path: "/api/v1/milestones/{id}",
  tags: ["Milestones"],
  summary: "Delete milestone",
  description: "Delete a milestone.",
  request: {
    params: z.object({ id: milestoneIdParam }),
  },
  responses: {
    200: {
      description: "Milestone deleted",
      content: { "application/json": { schema: milestoneDataEnvelope } },
    },
    404: {
      description: "Milestone not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createMilestoneRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:projectId/milestones
  router.openapi(listMilestonesRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const milestonesList = milestoneService.list(projectId);

    return c.json(
      {
        data: milestonesList,
        pagination: { total: milestonesList.length },
      },
      200,
    );
  });

  // POST /api/v1/projects/:projectId/milestones
  router.openapi(createMilestoneRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const milestone = milestoneService.create({
      projectId,
      ...body,
    });

    return c.json({ data: milestone }, 201);
  });

  // PATCH /api/v1/milestones/:id
  router.openapi(updateMilestoneRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const milestone = milestoneService.update(id, body);

    return c.json({ data: milestone }, 200);
  });

  // DELETE /api/v1/milestones/:id
  router.openapi(deleteMilestoneRoute, (c) => {
    const { id } = c.req.valid("param");
    const milestone = milestoneService.deleteMilestone(id);

    return c.json({ data: milestone }, 200);
  });

  return router;
}
