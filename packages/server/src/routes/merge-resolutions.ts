import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { MERGE_ESCALATION_TARGETS, MERGE_RESOLUTION_STATES } from "@pm/shared";
import type { AppVariables, AuthUser } from "../types.js";
import { AppError } from "../types.js";
import * as resolutionSvc from "../services/merge-resolution.service.js";

// ═══════════════════════════════════════════════════════════════════
// Phase 7.6 §6 — the resolver-lifecycle REST surface. Clones the
// merge-incidents.ts route shape: createRoute + OpenAPIHono factory +
// requireUser/requireIntegrator gates. The four mutations are
// integrator-only (ai_agent); the two GETs are any-authenticated-user
// (debug + dashboard).
//
// The body/response schemas are LOCAL Zod-4 mirrors of the @pm/shared Zod-3
// merge-resolution schemas (camelCase per §4) — NEVER import the Zod-3 shared
// schema into createRoute (the established route-local-mirror split). The
// shared types remain the source of truth for non-server consumers.
// ═══════════════════════════════════════════════════════════════════

// ─── Response schemas (Zod-4 LOCAL mirror of mergeResolutionSchema) ──

const mergeResolutionDetailSchema = z.object({
  budgetConsumedSec: z.number().optional(),
  tokensConsumed: z.number().optional(),
  verifyVerdict: z.enum(["pass", "fail"]).optional(),
  escalationReason: z.string().optional(),
  logUrl: z.string().optional(),
});

const mergeResolutionSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    resource: z.string(),
    originRequestId: z.string().nullable(),
    resolvedRequestId: z.string().nullable(),
    state: z.enum(MERGE_RESOLUTION_STATES),
    conflictingFiles: z.array(z.string()).nullable(),
    attemptStartedAt: z.string().nullable(),
    attemptEndedAt: z.string().nullable(),
    escalationTarget: z.enum(MERGE_ESCALATION_TARGETS).nullable(),
    detail: mergeResolutionDetailSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("MergeResolution");

const mergeResolutionDataEnvelope = z.object({ data: mergeResolutionSchema });
const mergeResolutionListEnvelope = z.object({
  data: z.array(mergeResolutionSchema),
});

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// ─── Param + query schemas ────────────────────────────────────────

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const resolutionIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01JE7KQXZJ9P3M4RESOLUTN0X1",
});

const listQuery = z.object({
  state: z.enum(MERGE_RESOLUTION_STATES).optional(),
  resource: z.string().min(1).optional(),
});

// ─── Request body schemas (Zod-4 mirror, camelCase) ───────────────

const openResolutionBody = z
  .object({
    originRequestId: z.string().min(1),
    resource: z.string().min(1).default("main"),
    conflictingFiles: z.array(z.string()).nullable().optional(),
  })
  .openapi("MergeResolutionOpen");

const resolvedResolutionBody = z
  .object({
    resolvedRequestId: z.string().min(1),
    detail: mergeResolutionDetailSchema.nullable().optional(),
  })
  .openapi("MergeResolutionResolved");

const escalateResolutionBody = z
  .object({
    state: z.enum(["escalated", "failed"]).default("escalated"),
    target: z.enum(MERGE_ESCALATION_TARGETS),
    reason: z.string().min(1),
    detail: mergeResolutionDetailSchema.nullable().optional(),
  })
  .openapi("MergeResolutionEscalate");

// ─── Route definitions ────────────────────────────────────────────

const openResolutionRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/merge-resolutions",
  tags: ["Merge Resolutions"],
  summary: "Integrator opens a conflict resolution",
  description:
    "Durable PM record that the integrator hit a textual rebase conflict and (resolver enabled) spun a bounded resolution off-lane for an origin request. Inserts the resolution at state 'pending'. Integrator (ai_agent) only.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: {
      content: { "application/json": { schema: openResolutionBody } },
      required: true,
    },
  },
  responses: {
    201: { description: "Opened resolution", content: { "application/json": { schema: mergeResolutionDataEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const startResolutionRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-resolutions/{id}/start",
  tags: ["Merge Resolutions"],
  summary: "Start a resolution (pending → resolving)",
  description:
    "The resolver built the worktree and spawned the headless agent. Sets attemptStartedAt. Legal only from 'pending'. Integrator (ai_agent) only.",
  request: { params: z.object({ id: resolutionIdParam }) },
  responses: {
    200: { description: "Now resolving", content: { "application/json": { schema: mergeResolutionDataEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Resolution not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Invalid transition from current state", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const resolvedResolutionRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-resolutions/{id}/resolved",
  tags: ["Merge Resolutions"],
  summary: "Record a resolved resolution (resolving → resolved)",
  description:
    "The resolver produced a clean, locally-verified tree and resubmitted it as a new request. Records resolvedRequestId + attemptEndedAt. Legal only from 'resolving'. The resolved request still passes the real verify gate before landing. Integrator (ai_agent) only.",
  request: {
    params: z.object({ id: resolutionIdParam }),
    body: {
      content: { "application/json": { schema: resolvedResolutionBody } },
      required: true,
    },
  },
  responses: {
    200: { description: "Now resolved", content: { "application/json": { schema: mergeResolutionDataEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Resolution not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Invalid transition from current state", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const escalateResolutionRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-resolutions/{id}/escalate",
  tags: ["Merge Resolutions"],
  summary: "Escalate a resolution (resolving → escalated | failed)",
  description:
    "The resolver couldn't land a clean tree. 'escalated' = verify-fail / budget / agent-can't; 'failed' = infra error (tagged distinctly). Sets escalationTarget + attemptEndedAt + detail.escalationReason. Legal only from 'resolving'. Integrator (ai_agent) only.",
  request: {
    params: z.object({ id: resolutionIdParam }),
    body: {
      content: { "application/json": { schema: escalateResolutionBody } },
      required: true,
    },
  },
  responses: {
    200: { description: "Now escalated/failed", content: { "application/json": { schema: mergeResolutionDataEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Resolution not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Invalid transition from current state", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const listResolutionsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/merge-resolutions",
  tags: ["Merge Resolutions"],
  summary: "List merge resolutions in a project",
  description:
    "Returns resolutions for the project ordered by createdAt asc. Optional filters: state, resource. Any authenticated user (debug + dashboard).",
  request: { params: z.object({ projectId: projectIdParam }), query: listQuery },
  responses: {
    200: { description: "Filtered list", content: { "application/json": { schema: mergeResolutionListEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const getResolutionRoute = createRoute({
  method: "get",
  path: "/api/v1/merge-resolutions/{id}",
  tags: ["Merge Resolutions"],
  summary: "Get a merge resolution",
  description:
    "Returns the resolution row including its detail and lineage (originRequestId, resolvedRequestId). Any authenticated user.",
  request: { params: z.object({ id: resolutionIdParam }) },
  responses: {
    200: { description: "Resolution", content: { "application/json": { schema: mergeResolutionDataEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Resolution not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

// ─── Helpers ──────────────────────────────────────────────────────

function requireUser(user: AuthUser | null): AuthUser {
  if (!user) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return user;
}

function actorOf(user: AuthUser): { id: string; role: string; type: string } {
  return { id: user.id, role: user.role, type: user.type };
}

/**
 * Integrator-only gate (the resolver is integrator machinery, like the
 * 7.4/7.5 channels). A non-ai_agent caller must 403. The service re-asserts
 * this gate too (defense in depth — the service is the authority); this is the
 * route-level early-out for a clear OpenAPI contract.
 */
function requireIntegrator(user: AuthUser, what: string): void {
  if (user.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      `Only integrator (ai_agent) users may ${what}.`,
    );
  }
}

// ─── Router factory ───────────────────────────────────────────────

export function createMergeResolutionRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  router.openapi(openResolutionRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireIntegrator(user, "open a merge resolution");
    const body = c.req.valid("json");
    const view = resolutionSvc.open(
      {
        projectId,
        originRequestId: body.originRequestId,
        resource: body.resource,
        conflictingFiles: body.conflictingFiles ?? null,
      },
      actorOf(user),
    );
    return c.json({ data: view }, 201);
  });

  router.openapi(startResolutionRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireIntegrator(user, "start a merge resolution");
    const view = resolutionSvc.start(id, actorOf(user));
    return c.json({ data: view }, 200);
  });

  router.openapi(resolvedResolutionRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireIntegrator(user, "record a resolved merge resolution");
    const body = c.req.valid("json");
    const view = resolutionSvc.resolved(
      id,
      {
        resolvedRequestId: body.resolvedRequestId,
        detail: body.detail ?? null,
      },
      actorOf(user),
    );
    return c.json({ data: view }, 200);
  });

  router.openapi(escalateResolutionRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireIntegrator(user, "escalate a merge resolution");
    const body = c.req.valid("json");
    const view = resolutionSvc.escalate(
      id,
      {
        state: body.state,
        target: body.target,
        reason: body.reason,
        detail: body.detail ?? null,
      },
      actorOf(user),
    );
    return c.json({ data: view }, 200);
  });

  router.openapi(listResolutionsRoute, (c) => {
    const { projectId } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    const query = c.req.valid("query");
    const rows = resolutionSvc.list(projectId, {
      state: query.state,
      resource: query.resource,
    });
    return c.json({ data: rows }, 200);
  });

  router.openapi(getResolutionRoute, (c) => {
    const { id } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    const view = resolutionSvc.getById(id);
    return c.json({ data: view }, 200);
  });

  return router;
}
