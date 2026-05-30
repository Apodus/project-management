import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { CLAIM_STATUSES, EPIC_STATUSES, PRIORITIES } from "@pm/shared";
import type { UserType } from "@pm/shared";
import type { AppVariables, AuthUser } from "../types.js";
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
    assigneeId: z.string().nullable(),
    claimStatus: z.enum(CLAIM_STATUSES),
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

const claimResultSchema = z
  .object({
    ok: z.boolean(),
    status: z.enum([
      "claimed_by_you",
      "already_claimed_by_you",
      "claimed_by_another_agent",
      "released",
      "not_held",
      "closed",
      "force_claimed",
    ]),
  })
  .openapi("EpicClaimResult");

const claimResultEnvelope = z.object({ data: claimResultSchema });

const forceClaimBody = z
  .object({
    reason: z.string().min(1).max(2048),
    newAssigneeId: z.string().optional(),
  })
  .openapi("ForceClaimEpic");

const forceClaimResultEnvelope = z.object({
  data: z.object({
    ok: z.boolean(),
    status: z.literal("force_claimed"),
    previousHolder: z.string(),
    newHolder: z.string(),
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
    createdBy: z.string().min(1).optional(),
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

const claimFilterQuery = z.enum(["available", "mine", "all"]).optional();

// ─── Route definitions ────────────────────────────────────────────

const listEpicsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/epics",
  tags: ["Epics"],
  summary: "List epics",
  description:
    "List all epics for a project with optional status, milestone, and claim filters.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: z.object({
      status: z.enum(EPIC_STATUSES).optional(),
      milestone: z.string().optional(),
      claim: claimFilterQuery,
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
  description: "Get an epic by ID with task summary and claim_status.",
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
  description:
    "Update epic fields. AI agents must hold the claim. Transitioning to a terminal status (completed/cancelled) clears the claim.",
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
    409: {
      description: "Claim denied — epic claimed by another agent or unclaimed",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deleteEpicRoute = createRoute({
  method: "delete",
  path: "/api/v1/epics/{id}",
  tags: ["Epics"],
  summary: "Archive epic",
  description:
    "Soft-delete an epic by setting its status to cancelled. AI agents must hold the claim.",
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
    409: {
      description: "Claim denied — epic claimed by another agent or unclaimed",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const claimEpicRoute = createRoute({
  method: "post",
  path: "/api/v1/epics/{id}/claim",
  tags: ["Epics"],
  summary: "Claim epic",
  description:
    "Atomically claim an epic for the caller. Returns a structured result without leaking other claimants' IDs.",
  request: {
    params: z.object({ id: epicIdParam }),
  },
  responses: {
    200: {
      description: "Claim attempt outcome",
      content: { "application/json": { schema: claimResultEnvelope } },
    },
    404: {
      description: "Epic not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const forceClaimEpicRoute = createRoute({
  method: "post",
  path: "/api/v1/epics/{id}/force-claim",
  tags: ["Epics"],
  summary: "Force-claim epic (takeover)",
  description:
    "Take over an existing claim (reason required, audited). Self-recovery when a session identity changed. Targeting another agent requires a human director.",
  request: {
    params: z.object({ id: epicIdParam }),
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
      description: "Epic or target user not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Epic closed / not associated with a project",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const releaseEpicRoute = createRoute({
  method: "post",
  path: "/api/v1/epics/{id}/release",
  tags: ["Epics"],
  summary: "Release epic claim",
  description:
    "Release the caller's claim on an epic. Humans can release any claim; AI agents only their own.",
  request: {
    params: z.object({ id: epicIdParam }),
  },
  responses: {
    200: {
      description: "Release attempt outcome",
      content: { "application/json": { schema: claimResultEnvelope } },
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
    const { status, milestone, claim } = c.req.valid("query");
    const user = c.get("currentUser");
    const epicsList = epicService.list(
      projectId,
      { status, milestone, claim },
      user ? { id: user.id } : null,
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
    const user = c.get("currentUser") as AuthUser | null;
    // Derive createdBy: AI agents always self-attribute; humans may pass an
    // explicit createdBy or default to themselves.
    const createdBy =
      user?.type === "ai_agent" ? user.id : (body.createdBy ?? user?.id ?? null);
    const epic = epicService.create(
      { ...body, projectId, createdBy },
      user ? { id: user.id, type: user.type as UserType } : undefined,
    );

    return c.json({ data: epic }, 201);
  });

  // GET /api/v1/epics/:id
  router.openapi(getEpicRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser");
    const epic = epicService.getById(id, user ? { id: user.id } : null);

    return c.json({ data: epic }, 200);
  });

  // PATCH /api/v1/epics/:id
  router.openapi(updateEpicRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser") as AuthUser | null;
    const epic = epicService.update(
      id,
      body,
      user ? { id: user.id, type: user.type as UserType } : undefined,
    );

    return c.json({ data: epic }, 200);
  });

  // DELETE /api/v1/epics/:id
  router.openapi(deleteEpicRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser") as AuthUser | null;
    const epic = epicService.archive(
      id,
      user ? { id: user.id, type: user.type as UserType } : undefined,
    );

    return c.json({ data: epic }, 200);
  });

  // POST /api/v1/epics/:id/claim
  router.openapi(claimEpicRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser") as AuthUser;
    const result = epicService.claim(id, {
      id: user.id,
      type: user.type as UserType,
    });

    return c.json({ data: result }, 200);
  });

  // POST /api/v1/epics/:id/force-claim
  router.openapi(forceClaimEpicRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser") as AuthUser;
    const result = epicService.forceClaim(
      id,
      { id: user.id, type: user.type as UserType },
      { reason: body.reason, newAssigneeId: body.newAssigneeId },
    );

    return c.json({ data: result }, 200);
  });

  // POST /api/v1/epics/:id/release
  router.openapi(releaseEpicRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser") as AuthUser;
    const result = epicService.release(id, {
      id: user.id,
      type: user.type as UserType,
    });

    return c.json({ data: result }, 200);
  });

  return router;
}
