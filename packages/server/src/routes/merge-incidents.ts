import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  MERGE_INCIDENT_RESOLUTION_MODES,
  MERGE_INCIDENT_STATES,
  MERGE_INCIDENT_TYPES,
} from "@pm/shared";
import type { AppVariables, AuthUser } from "../types.js";
import { AppError } from "../types.js";
import * as incidentSvc from "../services/merge-incident.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const mergeIncidentResolutionSchema = z.object({
  mode: z.enum(MERGE_INCIDENT_RESOLUTION_MODES),
  outerLandedSha: z.string().optional(),
  resolvedByGroupId: z.string().optional(),
  note: z.string().optional(),
});

const mergeIncidentSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    groupId: z.string().nullable(),
    type: z.enum(MERGE_INCIDENT_TYPES),
    innerRepo: z.string(),
    orphanedSha: z.string(),
    outerRepo: z.string(),
    innerRequestId: z.string().nullable(),
    taskId: z.string().nullable(),
    state: z.enum(MERGE_INCIDENT_STATES),
    openedAt: z.string(),
    resolvedAt: z.string().nullable(),
    resolution: mergeIncidentResolutionSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("MergeIncident");

const mergeIncidentDataEnvelope = z.object({ data: mergeIncidentSchema });
const mergeIncidentListEnvelope = z.object({ data: z.array(mergeIncidentSchema) });
// The open response is composite: `created` distinguishes a real open from an
// idempotent reuse. It rides INSIDE `data` (the merge-phases.ts precedent)
// because the integrator's pm-client unwraps `json.data` and would silently
// drop a sibling field.
const mergeIncidentOpenEnvelope = z.object({
  data: z.object({ incident: mergeIncidentSchema, created: z.boolean() }),
});

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// ─── Param + query schemas ────────────────────────────────────────

const projectIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "projectId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const incidentIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "id", in: "path" },
    example: "01JE7KQXZJ9P3M4INCIDENT0X1",
  });

const listQuery = z.object({
  state: z.enum(MERGE_INCIDENT_STATES).optional(),
  type: z.enum(MERGE_INCIDENT_TYPES).optional(),
  groupId: z.string().optional(),
});

// ─── Request body schemas ─────────────────────────────────────────
// These mirror the shared zod schemas in @pm/shared/schemas/merge-incident.ts
// but are redeclared with the @hono/zod-openapi `z` (zod 4) because the
// shared package targets zod 3 and the two type universes don't unify.
// The runtime semantics are identical; the shared types remain the source
// of truth for non-server consumers (web UI, MCP server).
const openIncidentBody = z
  .object({
    type: z.enum(MERGE_INCIDENT_TYPES).default("orphaned_inner"),
    innerRepo: z.string().min(1),
    orphanedSha: z.string().min(1),
    outerRepo: z.string().min(1),
    groupId: z.string().nullable().optional(),
    innerRequestId: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
  })
  .openapi("MergeIncidentOpen");

const resolveIncidentBody = z
  .object({
    mode: z.enum(MERGE_INCIDENT_RESOLUTION_MODES),
    outerLandedSha: z.string().optional(),
    resolvedByGroupId: z.string().optional(),
    note: z.string().optional(),
  })
  .openapi("MergeIncidentResolve");

// ─── Route definitions ────────────────────────────────────────────

const openIncidentRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/merge-incidents",
  tags: ["Merge Incidents"],
  summary: "Integrator opens a merge incident",
  description:
    "Durable PM record that the inner/outer gitlink invariant is broken on main, in either direction. type='orphaned_inner': inner main landed at orphanedSha but the outer gitlink was NOT updated. type='dangling_gitlink': outer main's gitlink points at orphanedSha, which is not on inner main (groupId/innerRequestId are null — no group produced it). Atomically inserts the incident (state 'open') and, when taskId is set, a merge_incident comment. IDEMPOTENT: an OPEN incident with the same (type, innerRepo, outerRepo, orphanedSha, groupId) is reused — 200 with created=false and no second comment or event — so a blocked lane may call this on every pass. Dedup is open-only: a recurrence after a resolution opens a fresh incident. Integrator (ai_agent) only.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: { content: { "application/json": { schema: openIncidentBody } }, required: true },
  },
  responses: {
    200: {
      description: "Existing open incident reused (idempotent open)",
      content: { "application/json": { schema: mergeIncidentOpenEnvelope } },
    },
    201: {
      description: "Opened incident",
      content: { "application/json": { schema: mergeIncidentOpenEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Integrator (ai_agent) only",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getIncidentRoute = createRoute({
  method: "get",
  path: "/api/v1/merge-incidents/{id}",
  tags: ["Merge Incidents"],
  summary: "Get a merge incident",
  description: "Returns the incident row including its resolution (null while open).",
  request: { params: z.object({ id: incidentIdParam }) },
  responses: {
    200: {
      description: "Incident",
      content: { "application/json": { schema: mergeIncidentDataEnvelope } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Incident not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const listIncidentsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/merge-incidents",
  tags: ["Merge Incidents"],
  summary: "List merge incidents in a project",
  description:
    "Returns incidents for the project ordered by openedAt asc. Incidents record the inner/outer gitlink invariant broken in EITHER direction (orphaned_inner, dangling_gitlink), so a caller that means one direction must pass `type`. Optional filters: state, type, groupId.",
  request: { params: z.object({ projectId: projectIdParam }), query: listQuery },
  responses: {
    200: {
      description: "Filtered list",
      content: { "application/json": { schema: mergeIncidentListEnvelope } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const resolveIncidentRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-incidents/{id}/resolve",
  tags: ["Merge Incidents"],
  summary: "Resolve a merge incident",
  description:
    "open → auto_resolved (mode auto_rollforward or auto_observed, ai_agent only) OR open → human_resolved (mode human, admin only). The two auto modes differ in what the train DID: auto_rollforward means it applied a cure (the follow-up outer land); auto_observed means it observed a cure it did not apply (the invariant holds again — the only honest auto mode for an incident a human must cure). The authz split is deliberate. Idempotent on same-terminal resolve; cross-terminal is a 409.",
  request: {
    params: z.object({ id: incidentIdParam }),
    body: { content: { "application/json": { schema: resolveIncidentBody } }, required: true },
  },
  responses: {
    200: {
      description: "Resolved",
      content: { "application/json": { schema: mergeIncidentDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "auto requires ai_agent; human requires admin",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Incident not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Invalid transition from current state",
      content: { "application/json": { schema: errorEnvelope } },
    },
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

// ─── Router factory ───────────────────────────────────────────────

export function createMergeIncidentRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  router.openapi(openIncidentRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const body = c.req.valid("json");
    const { incident, created } = incidentSvc.openIncident(
      {
        projectId,
        type: body.type,
        innerRepo: body.innerRepo,
        orphanedSha: body.orphanedSha,
        outerRepo: body.outerRepo,
        groupId: body.groupId ?? null,
        innerRequestId: body.innerRequestId ?? null,
        taskId: body.taskId ?? null,
      },
      actorOf(user),
    );
    // Two returns, not one c.json(..., created ? 201 : 200): @hono/zod-openapi
    // types the handler's return against the literal status.
    if (created) {
      return c.json({ data: { incident, created } }, 201);
    }
    return c.json({ data: { incident, created } }, 200);
  });

  router.openapi(getIncidentRoute, (c) => {
    const { id } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    const view = incidentSvc.getById(id);
    return c.json({ data: view }, 200);
  });

  router.openapi(listIncidentsRoute, (c) => {
    const { projectId } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    const query = c.req.valid("query");
    const rows = incidentSvc.list(projectId, {
      state: query.state,
      type: query.type,
      groupId: query.groupId,
    });
    return c.json({ data: rows }, 200);
  });

  router.openapi(resolveIncidentRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const body = c.req.valid("json");
    const view = incidentSvc.resolve(
      id,
      {
        mode: body.mode,
        outerLandedSha: body.outerLandedSha,
        resolvedByGroupId: body.resolvedByGroupId,
        note: body.note,
      },
      actorOf(user),
    );
    return c.json({ data: view }, 200);
  });

  return router;
}
