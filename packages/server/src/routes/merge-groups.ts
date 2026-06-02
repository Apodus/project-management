import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { MERGE_GROUP_STATES } from "@pm/shared";
import type { AppVariables, AuthUser } from "../types.js";
import { AppError } from "../types.js";
import * as groupSvc from "../services/merge-group.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const mergeGroupSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    resource: z.string(),
    state: z.enum(MERGE_GROUP_STATES),
    submittedBy: z.string(),
    integratorId: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    resolutionReason: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("MergeGroup");

// Mirrors the merge-request view projected by merge-group.service:toMemberView.
const mergeGroupMemberSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    resource: z.string(),
    submittedBy: z.string(),
    taskId: z.string().nullable(),
    resolvedFrom: z.string().nullable(),
    branch: z.string().nullable(),
    commitSha: z.string().nullable(),
    verifyCmd: z.string().nullable(),
    worktreePath: z.string().nullable(),
    status: z.string(),
    enqueuedAt: z.string(),
    pickedUpAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    landedSha: z.string().nullable(),
    rejectCategory: z.string().nullable(),
    rejectReason: z.string().nullable(),
    failedFiles: z.array(z.string()).nullable(),
    logExcerpt: z.string().nullable(),
    logUrl: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("MergeGroupMember");

const mergeGroupDetailSchema = mergeGroupSchema
  .extend({ members: z.array(mergeGroupMemberSchema) })
  .openapi("MergeGroupDetail");

const mergeGroupDetailEnvelope = z.object({ data: mergeGroupDetailSchema });
const mergeGroupMemberDataEnvelope = z.object({ data: mergeGroupMemberSchema });
const mergeGroupListEnvelope = z.object({ data: z.array(mergeGroupSchema) });

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// ─── Param + query schemas ────────────────────────────────────────

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const groupIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01JE7KQXZJ9P3M4GROUP000X1Y",
});

const requestIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01JE7KQXZJ9P3M4ABCDEF0X1Y2",
});

const listQuery = z.object({
  state: z.enum(MERGE_GROUP_STATES).optional(),
  resource: z.string().optional(),
});

// ─── Request body schemas ─────────────────────────────────────────
// These mirror the shared zod schemas in @pm/shared/schemas/merge-group.ts
// but are redeclared with the @hono/zod-openapi `z` (zod 4) because the
// shared package targets zod 3 and the two type universes don't unify.
// The runtime semantics are identical; the shared types remain the source
// of truth for non-server consumers (web UI, MCP server).
const createGroupBody = z
  .object({
    resource: z.string().min(1).default("main"),
    memberRequestIds: z.array(z.string().min(1)).min(2),
  })
  .openapi("MergeGroupCreate");

const landGroupBody = z
  .object({
    members: z
      .array(
        z.object({
          requestId: z.string().min(1),
          landedSha: z.string().min(1),
          role: z.string().optional(),
        }),
      )
      .min(1),
  })
  .openapi("MergeGroupLand");

const rejectGroupBody = z
  .object({
    reason: z.string().min(1),
    category: z.string().optional(),
  })
  .openapi("MergeGroupReject");

const markPartiallyLandedBody = z
  .object({
    reason: z.string().min(1),
    incidentId: z.string().optional(),
  })
  .openapi("MergeGroupPartiallyLand");

const markInnerOrphanedBody = z
  .object({ orphanedSha: z.string().min(1) })
  .openapi("MergeRequestOrphan");

const markIntegratingBody = z
  .object({ integratorId: z.string().optional() })
  .openapi("MergeGroupPickup");

const resetGroupBody = z
  .object({ reason: z.string().min(1).max(500).optional() })
  .openapi("MergeGroupReset");

// ─── Route definitions ────────────────────────────────────────────

const createGroupRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/merge-groups",
  tags: ["Merge Groups"],
  summary: "Create a merge group from queued requests",
  description:
    "Worker submits >=2 already-queued, ungrouped merge requests as one atomic unit (state 'forming'). The integrator lands-or-fails the whole group atomically. Subscribe to merge.group.* SSE events for the outcome.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: { content: { "application/json": { schema: createGroupBody } }, required: true },
  },
  responses: {
    201: { description: "Forming group with members", content: { "application/json": { schema: mergeGroupDetailEnvelope } } },
    400: { description: "Validation error (e.g. <2 members)", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project or member request not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "A member is not queued or is already grouped", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const getGroupRoute = createRoute({
  method: "get",
  path: "/api/v1/merge-groups/{id}",
  tags: ["Merge Groups"],
  summary: "Get a merge group with members",
  description: "Returns the group plus all member requests (ordered by enqueuedAt asc).",
  request: { params: z.object({ id: groupIdParam }) },
  responses: {
    200: { description: "Group + members", content: { "application/json": { schema: mergeGroupDetailEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Group not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const listGroupsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/merge-groups",
  tags: ["Merge Groups"],
  summary: "List merge groups in a project",
  description: "Returns groups for the project ordered by createdAt asc. Optional filters: state, resource.",
  request: { params: z.object({ projectId: projectIdParam }), query: listQuery },
  responses: {
    200: { description: "Filtered list", content: { "application/json": { schema: mergeGroupListEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const pickupGroupRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-groups/{id}/pickup",
  tags: ["Merge Groups"],
  summary: "Integrator picks up a forming group",
  description:
    "forming → integrating. Flips every queued member to integrating in one txn and emits merge.group.started. Integrator (ai_agent) only. 409 from any non-forming state.",
  request: {
    params: z.object({ id: groupIdParam }),
    body: { content: { "application/json": { schema: markIntegratingBody } }, required: false },
  },
  responses: {
    200: { description: "Picked up", content: { "application/json": { schema: mergeGroupDetailEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Group not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Group not in 'forming' state", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const resetGroupRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-groups/{id}/reset",
  tags: ["Merge Groups"],
  summary: "Integrator resets a stranded integrating group",
  description:
    "integrating → forming (stranded-group recovery, §9 finding 2 / §6.4). Atomically resets the group to forming AND every integrating member back to queued. Integrator (ai_agent) only. REFUSES a group that is not integrating (409) or that has an open incident (409, the corruption fence — a real orphan is recovered by rollforward, not reset). Idempotent on forming → forming.",
  request: {
    params: z.object({ id: groupIdParam }),
    body: { content: { "application/json": { schema: resetGroupBody } }, required: false },
  },
  responses: {
    200: { description: "Reset to forming", content: { "application/json": { schema: mergeGroupDetailEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Group not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Group not integrating, or has an open incident (corruption fence)", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const landGroupRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-groups/{id}/land",
  tags: ["Merge Groups"],
  summary: "Integrator atomically lands the whole group",
  description:
    "integrating → landed. Lands every member (status landed, landedSha, landed_sha git_ref per linked task) and the group in one txn. Integrator (ai_agent) only. Idempotent on landed → landed.",
  request: {
    params: z.object({ id: groupIdParam }),
    body: { content: { "application/json": { schema: landGroupBody } }, required: true },
  },
  responses: {
    200: { description: "Landed", content: { "application/json": { schema: mergeGroupDetailEnvelope } } },
    400: { description: "Validation error (e.g. member not in group)", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Group or member not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Group not in 'integrating' state", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const rejectGroupRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-groups/{id}/reject",
  tags: ["Merge Groups"],
  summary: "Reject the whole group",
  description:
    "forming → rejected OR integrating → rejected. Rejects every non-terminal member in one txn. Integrator (ai_agent), an admin, or the submitter may reject. Idempotent on rejected → rejected.",
  request: {
    params: z.object({ id: groupIdParam }),
    body: { content: { "application/json": { schema: rejectGroupBody } }, required: true },
  },
  responses: {
    200: { description: "Rejected", content: { "application/json": { schema: mergeGroupDetailEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Only the submitter, an admin, or the integrator", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Group not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Invalid transition from current state", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const partiallyLandGroupRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-groups/{id}/partially-land",
  tags: ["Merge Groups"],
  summary: "Integrator marks the group partially landed",
  description:
    "integrating → partially_landed. Outer-push-fail-after-inner-land: sets the group row only (member states are set by the orphan + outer reject). Integrator (ai_agent) only. Idempotent on partially_landed.",
  request: {
    params: z.object({ id: groupIdParam }),
    body: { content: { "application/json": { schema: markPartiallyLandedBody } }, required: true },
  },
  responses: {
    200: { description: "Partially landed", content: { "application/json": { schema: mergeGroupDetailEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Group not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Group not in 'integrating' state", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const orphanRequestRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-requests/{id}/orphan",
  tags: ["Merge Groups"],
  summary: "Integrator orphans an inner group member",
  description:
    "member integrating → orphaned. Sets the inner member to the 'orphaned' outcome (the inner main landed but the outer gitlink was not updated). Integrator (ai_agent) only. 409 if the request is not a group member or not integrating.",
  request: {
    params: z.object({ id: requestIdParam }),
    body: { content: { "application/json": { schema: markInnerOrphanedBody } }, required: true },
  },
  responses: {
    200: { description: "Orphaned member", content: { "application/json": { schema: mergeGroupMemberDataEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Request not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Request not a group member or not 'integrating'", content: { "application/json": { schema: errorEnvelope } } },
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

export function createMergeGroupRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  router.openapi(createGroupRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const body = c.req.valid("json");
    const detail = groupSvc.createGroup({
      projectId,
      memberRequestIds: body.memberRequestIds,
      resource: body.resource,
      submittedBy: user.id,
    });
    return c.json({ data: detail }, 201);
  });

  router.openapi(getGroupRoute, (c) => {
    const { id } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    const detail = groupSvc.getById(id);
    return c.json({ data: detail }, 200);
  });

  router.openapi(listGroupsRoute, (c) => {
    const { projectId } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    const query = c.req.valid("query");
    const rows = groupSvc.list(projectId, {
      state: query.state,
      resource: query.resource,
    });
    return c.json({ data: rows }, 200);
  });

  router.openapi(pickupGroupRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    let body: { integratorId?: string } = {};
    try {
      body = c.req.valid("json") ?? {};
    } catch {
      // Body optional; tolerate empty.
    }
    const detail = groupSvc.markIntegrating(id, actorOf(user), {
      integratorId: body.integratorId,
    });
    return c.json({ data: detail }, 200);
  });

  router.openapi(resetGroupRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    let body: { reason?: string } = {};
    try {
      body = c.req.valid("json") ?? {};
    } catch {
      // Body optional; tolerate empty.
    }
    const detail = groupSvc.resetGroup(id, actorOf(user), {
      reason: body.reason,
    });
    return c.json({ data: detail }, 200);
  });

  router.openapi(landGroupRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const body = c.req.valid("json");
    const detail = groupSvc.landGroup(id, { members: body.members }, actorOf(user));
    return c.json({ data: detail }, 200);
  });

  router.openapi(rejectGroupRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const body = c.req.valid("json");
    const detail = groupSvc.rejectGroup(
      id,
      { reason: body.reason, category: body.category },
      actorOf(user),
    );
    return c.json({ data: detail }, 200);
  });

  router.openapi(partiallyLandGroupRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const body = c.req.valid("json");
    const detail = groupSvc.markPartiallyLanded(
      id,
      { reason: body.reason, incidentId: body.incidentId },
      actorOf(user),
    );
    return c.json({ data: detail }, 200);
  });

  router.openapi(orphanRequestRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const body = c.req.valid("json");
    const view = groupSvc.markInnerOrphaned(id, body.orphanedSha, actorOf(user));
    return c.json({ data: view }, 200);
  });

  return router;
}
