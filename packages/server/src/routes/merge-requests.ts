import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  MERGE_ATTEMPT_STATUSES,
  MERGE_REJECT_CATEGORIES,
  MERGE_REQUEST_STATUSES,
} from "@pm/shared";
import type { AppVariables, AuthUser } from "../types.js";
import { AppError } from "../types.js";
import * as requestSvc from "../services/merge-request.service.js";
import * as attemptSvc from "../services/merge-attempt.service.js";
import { assertMemberLandableViaGroup } from "../services/merge-group.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const mergeRequestSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    resource: z.string(),
    submittedBy: z.string(),
    taskId: z.string().nullable(),
    branch: z.string().nullable(),
    commitSha: z.string().nullable(),
    verifyCmd: z.string().nullable(),
    worktreePath: z.string().nullable(),
    status: z.enum(MERGE_REQUEST_STATUSES),
    enqueuedAt: z.string(),
    pickedUpAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    landedSha: z.string().nullable(),
    rejectCategory: z.enum(MERGE_REJECT_CATEGORIES).nullable(),
    rejectReason: z.string().nullable(),
    failedFiles: z.array(z.string()).nullable(),
    logExcerpt: z.string().nullable(),
    logUrl: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("MergeRequest");

const mergeAttemptSchema = z
  .object({
    id: z.string(),
    requestId: z.string(),
    attemptNumber: z.number().int(),
    baseSha: z.string(),
    treeSha: z.string().nullable(),
    status: z.enum(MERGE_ATTEMPT_STATUSES),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    verifyDurationMs: z.number().int().nullable(),
    failureCategory: z.enum(MERGE_REJECT_CATEGORIES).nullable(),
    failureReason: z.string().nullable(),
    failedFiles: z.array(z.string()).nullable(),
    logExcerpt: z.string().nullable(),
    logUrl: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("MergeAttempt");

const mergeRequestDetailSchema = mergeRequestSchema
  .extend({ attempts: z.array(mergeAttemptSchema) })
  .openapi("MergeRequestDetail");

const mergeRequestDataEnvelope = z.object({ data: mergeRequestSchema });
const mergeRequestDetailEnvelope = z.object({ data: mergeRequestDetailSchema });
const mergeAttemptDataEnvelope = z.object({ data: mergeAttemptSchema });

// ─── Timeline schemas (design §5.7 / §8.3) ────────────────────────
// The per-request timeline is the ordered state history composed PM-side from
// the request milestones + every attempt + the audit rows targeting it + any
// orphaned-inner incident. camelCase on the wire (the merge-requests.ts
// convention) — landedSha/enqueuedAt, NOT the snake_case train.ts shape.
const timelineEventSchema = z
  .object({
    at: z.string(),
    kind: z.enum([
      "queued",
      "integrating",
      "landed",
      "rejected",
      "abandoned",
      "attempt",
      "audit",
      "incident",
    ]),
    // attempt
    attemptNumber: z.number().int().optional(),
    baseSha: z.string().nullable().optional(),
    treeSha: z.string().nullable().optional(),
    status: z.string().optional(),
    startedAt: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
    failureCategory: z.string().nullable().optional(),
    logExcerpt: z.string().nullable().optional(),
    logUrl: z.string().nullable().optional(),
    // terminal milestones
    landedSha: z.string().nullable().optional(),
    rejectCategory: z.string().nullable().optional(),
    rejectReason: z.string().nullable().optional(),
    // audit
    action: z.string().optional(),
    actorId: z.string().optional(),
    reason: z.string().nullable().optional(),
    metadataBefore: z.record(z.string(), z.unknown()).nullable().optional(),
    metadataAfter: z.record(z.string(), z.unknown()).nullable().optional(),
    // incident
    type: z.string().optional(),
    orphanedSha: z.string().optional(),
    state: z.string().optional(),
    openedAt: z.string().optional(),
    resolvedAt: z.string().nullable().optional(),
    resolution: z.unknown().optional(),
  })
  .openapi("MergeRequestTimelineEvent");

const timelineSchema = z
  .object({
    request: mergeRequestSchema,
    events: z.array(timelineEventSchema),
  })
  .openapi("MergeRequestTimeline");

const timelineEnvelope = z.object({ data: timelineSchema });

const mergeRequestListEnvelope = z.object({
  data: z.array(mergeRequestSchema),
  pagination: z.object({
    total: z.number().int(),
    page: z.number().int(),
    perPage: z.number().int(),
  }),
});

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// ─── Param + query schemas ────────────────────────────────────────

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const requestIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01JE7KQXZJ9P3M4ABCDEF0X1Y2",
});

const attemptIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01JE7KQXZJ9P3M4ATTEMPT01",
});

const listQuery = z.object({
  resource: z.string().optional(),
  status: z.enum(MERGE_REQUEST_STATUSES).optional(),
  taskId: z.string().optional(),
  ungrouped: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  page: z.coerce.number().int().positive().optional(),
  perPage: z.coerce.number().int().positive().max(200).optional(),
});

const forceCancelBody = z
  .object({ reason: z.string().min(1).max(2048).optional() })
  .openapi("MergeRequestForceCancel");

const resetToQueuedBody = z
  .object({ reason: z.string().min(1).max(500) })
  .openapi("MergeRequestResetToQueued");

// ─── Request body schemas ─────────────────────────────────────────
// These mirror the shared zod schemas in @pm/shared/schemas/merge-request.ts
// but are redeclared with the @hono/zod-openapi `z` (zod 4) because the
// shared package targets zod 3 and the two type universes don't unify.
// The runtime semantics are identical; the shared types remain the source
// of truth for non-server consumers (web UI, MCP server).
const submitBody = z
  .object({
    resource: z.string().min(1).default("main"),
    taskId: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    commitSha: z.string().nullable().optional(),
    verifyCmd: z.string().nullable().optional(),
    worktreePath: z.string().nullable().optional(),
  })
  .openapi("MergeRequestSubmit");

const landBody = z
  .object({ landedSha: z.string().min(1) })
  .openapi("MergeRequestLand");

const rejectBody = z
  .object({
    category: z.enum(MERGE_REJECT_CATEGORIES),
    reason: z.string().min(1),
    failedFiles: z.array(z.string()).optional(),
    logExcerpt: z.string().optional(),
    logUrl: z.string().optional(),
  })
  .openapi("MergeRequestReject");

// Optional batch tags (Phase 7.2 §13.1). When the integrator runs speculative
// batches it tags pickup/startAttempt with the batchId + speculativePosition so
// the resulting merge.request.integrating / merge.attempt.started SSE frames
// carry batch_id / speculative_position. Omitted by 7.1 callers → frames stay
// byte-identical.
const pickupBody = z
  .object({
    batchId: z.string().optional(),
    speculativePosition: z.number().int().optional(),
  })
  .openapi("MergeRequestPickup");

const startAttemptBody = z
  .object({
    baseSha: z.string().min(1),
    batchId: z.string().optional(),
    speculativePosition: z.number().int().optional(),
  })
  .openapi("MergeAttemptStart");

const completeAttemptBody = z
  .discriminatedUnion("status", [
    z.object({
      status: z.literal("passed"),
      treeSha: z.string().min(1),
    }),
    z.object({
      status: z.literal("failed"),
      failureCategory: z.enum(MERGE_REJECT_CATEGORIES),
      failureReason: z.string().min(1),
      failedFiles: z.array(z.string()).optional(),
      logExcerpt: z.string().optional(),
      logUrl: z.string().optional(),
    }),
    z.object({ status: z.literal("cancelled") }),
  ])
  .openapi("MergeAttemptComplete");

// ─── Route definitions ────────────────────────────────────────────

const submitRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/merge-requests",
  tags: ["Merge Requests"],
  summary: "Submit a merge request",
  description:
    "Worker submits a request to land branch/commitSha into the named lane (defaults to 'main'). Returns the queued row. The integrator process picks it up asynchronously; subscribe to merge.request.* SSE events for the outcome.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: { content: { "application/json": { schema: submitBody } }, required: true },
  },
  responses: {
    201: { description: "Queued request", content: { "application/json": { schema: mergeRequestDataEnvelope } } },
    400: { description: "Validation error (e.g. taskId not in this project)", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project or task not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/merge-requests",
  tags: ["Merge Requests"],
  summary: "List merge requests in a project",
  description: "Returns requests for the project ordered by enqueuedAt ASC. Optional filters: resource, status, taskId. Paginated.",
  request: { params: z.object({ projectId: projectIdParam }), query: listQuery },
  responses: {
    200: { description: "Filtered list", content: { "application/json": { schema: mergeRequestListEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/v1/merge-requests/{id}",
  tags: ["Merge Requests"],
  summary: "Get a merge request with attempts",
  description: "Returns the request plus all attempts (most-recent first).",
  request: { params: z.object({ id: requestIdParam }) },
  responses: {
    200: { description: "Request + attempts", content: { "application/json": { schema: mergeRequestDetailEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Request not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const timelineRoute = createRoute({
  method: "get",
  path: "/api/v1/merge-requests/{id}/timeline",
  tags: ["Merge Requests"],
  summary: "Get a merge request's ordered timeline",
  description:
    "Returns the request plus its chronological state history (design §5.7): the queued/integrating/terminal milestones, every attempt with its log pointers + failureCategory, the land/reject/force_land/force_reject audit rows, and any orphaned-inner incident. Events are ordered ascending by timestamp. Any authenticated user may read.",
  request: { params: z.object({ id: requestIdParam }) },
  responses: {
    200: { description: "Request + ordered events", content: { "application/json": { schema: timelineEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Request not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const cancelRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-requests/{id}/cancel",
  tags: ["Merge Requests"],
  summary: "Cancel a queued merge request",
  description: "Submitter or admin cancels a queued request (queued → abandoned). 409 if the request is integrating or already terminal (use force-cancel for integrating).",
  request: { params: z.object({ id: requestIdParam }) },
  responses: {
    200: { description: "Abandoned", content: { "application/json": { schema: mergeRequestDataEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Only the submitter or an admin may cancel", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Request not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Invalid transition from current state", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const pickupRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-requests/{id}/pickup",
  tags: ["Merge Requests"],
  summary: "Integrator picks up a queued request",
  description:
    "queued → integrating. Sets pickedUpAt and emits merge.request.integrating. Integrator (ai_agent) only. 409 from any non-queued state (no idempotent case — re-pickup throws). Optional batchId/speculativePosition tag the emitted SSE frame.",
  request: {
    params: z.object({ id: requestIdParam }),
    body: { content: { "application/json": { schema: pickupBody } }, required: false },
  },
  responses: {
    200: { description: "Picked up", content: { "application/json": { schema: mergeRequestDataEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Request not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Request not in 'queued' state", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const resetToQueuedRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-requests/{id}/reset-to-queued",
  tags: ["Merge Requests"],
  summary: "Integrator resets a stuck integrating request back to queued",
  description:
    "integrating → queued. Used for crash recovery and post-verify push-race retry. Cancels any open attempts. Integrator (ai_agent) only. Returns 409 if not in 'integrating'.",
  request: {
    params: z.object({ id: requestIdParam }),
    body: { content: { "application/json": { schema: resetToQueuedBody } }, required: true },
  },
  responses: {
    200: { description: "Re-queued", content: { "application/json": { schema: mergeRequestDataEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Request not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Request not in 'integrating' state", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const forceCancelRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-requests/{id}/force-cancel",
  tags: ["Merge Requests"],
  summary: "Admin force-cancel any non-terminal request",
  description: "Admin override: forces queued OR integrating → abandoned. The integrator discovers this on its next land/reject/completeAttempt call (which returns 409 INVALID_TRANSITION).",
  request: {
    params: z.object({ id: requestIdParam }),
    body: { content: { "application/json": { schema: forceCancelBody } }, required: false },
  },
  responses: {
    200: { description: "Abandoned", content: { "application/json": { schema: mergeRequestDataEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Admins only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Request not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Invalid transition (terminal)", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const startAttemptRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-requests/{id}/attempts",
  tags: ["Merge Requests"],
  summary: "Integrator starts a new attempt",
  description: "Records baseSha and creates a running attempt row.",
  request: {
    params: z.object({ id: requestIdParam }),
    body: { content: { "application/json": { schema: startAttemptBody } }, required: true },
  },
  responses: {
    201: { description: "Attempt started", content: { "application/json": { schema: mergeAttemptDataEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Request not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Request not in 'integrating' state", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const completeAttemptRoute = createRoute({
  method: "patch",
  path: "/api/v1/merge-attempts/{id}",
  tags: ["Merge Requests"],
  summary: "Integrator completes an attempt",
  description: "Discriminated on status: passed requires treeSha; failed requires failureCategory + failureReason; cancelled requires only status.",
  request: {
    params: z.object({ id: attemptIdParam }),
    body: { content: { "application/json": { schema: completeAttemptBody } }, required: true },
  },
  responses: {
    200: { description: "Attempt completed", content: { "application/json": { schema: mergeAttemptDataEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Attempt not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Attempt not in 'running' state", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const landRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-requests/{id}/land",
  tags: ["Merge Requests"],
  summary: "Integrator lands the request",
  description: "integrating → landed. Transactionally creates a git_refs row of type 'landed_sha' if the request is linked to a task. Idempotent on landed → landed.",
  request: {
    params: z.object({ id: requestIdParam }),
    body: { content: { "application/json": { schema: landBody } }, required: true },
  },
  responses: {
    200: { description: "Landed", content: { "application/json": { schema: mergeRequestDataEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Request not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Request not in 'integrating' state, or it is a grouped member that must land via its group (GROUPED_MEMBER)", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const rejectRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-requests/{id}/reject",
  tags: ["Merge Requests"],
  summary: "Integrator rejects the request",
  description: "integrating → rejected. Transactionally creates a 'merge_rejection' comment on the linked task with structured metadata. Idempotent on rejected → rejected.",
  request: {
    params: z.object({ id: requestIdParam }),
    body: { content: { "application/json": { schema: rejectBody } }, required: true },
  },
  responses: {
    200: { description: "Rejected", content: { "application/json": { schema: mergeRequestDataEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Request not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Request not in 'integrating' state", content: { "application/json": { schema: errorEnvelope } } },
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

export function createMergeRequestRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  router.openapi(submitRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const body = c.req.valid("json");
    const view = requestSvc.submit({
      projectId,
      submittedBy: user.id,
      resource: body.resource,
      taskId: body.taskId ?? null,
      branch: body.branch ?? null,
      commitSha: body.commitSha ?? null,
      verifyCmd: body.verifyCmd ?? null,
      worktreePath: body.worktreePath ?? null,
    });
    return c.json({ data: view }, 201);
  });

  router.openapi(listRoute, (c) => {
    const { projectId } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    const query = c.req.valid("query");
    const result = requestSvc.list(projectId, {
      resource: query.resource,
      status: query.status,
      taskId: query.taskId,
      ungrouped: query.ungrouped,
      page: query.page,
      perPage: query.perPage,
    });
    return c.json(result, 200);
  });

  router.openapi(getRoute, (c) => {
    const { id } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    const detail = requestSvc.getById(id);
    return c.json({ data: detail }, 200);
  });

  router.openapi(timelineRoute, (c) => {
    const { id } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    const timeline = requestSvc.getTimeline(id);
    return c.json({ data: timeline }, 200);
  });

  router.openapi(cancelRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const view = requestSvc.cancel(id, actorOf(user));
    return c.json({ data: view }, 200);
  });

  router.openapi(pickupRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    let body: { batchId?: string; speculativePosition?: number } = {};
    try {
      body = c.req.valid("json") ?? {};
    } catch {
      // Body optional; tolerate empty (7.1 callers send none).
    }
    const view = requestSvc.transitionToIntegrating(id, actorOf(user), {
      batchId: body.batchId,
      speculativePosition: body.speculativePosition,
    });
    return c.json({ data: view }, 200);
  });

  router.openapi(resetToQueuedRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const { reason } = c.req.valid("json");
    const view = requestSvc.resetToQueued(id, actorOf(user), reason);
    return c.json({ data: view }, 200);
  });

  router.openapi(forceCancelRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    let body: { reason?: string } = {};
    try {
      body = c.req.valid("json") ?? {};
    } catch {
      // Body optional; tolerate empty.
    }
    const view = requestSvc.forceCancel(id, actorOf(user), body.reason ?? null);
    return c.json({ data: view }, 200);
  });

  router.openapi(startAttemptRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const body = c.req.valid("json");
    const view = attemptSvc.startAttempt(id, { baseSha: body.baseSha }, actorOf(user), {
      batchId: body.batchId,
      speculativePosition: body.speculativePosition,
    });
    return c.json({ data: view }, 201);
  });

  router.openapi(completeAttemptRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const body = c.req.valid("json");
    const view = attemptSvc.completeAttempt(id, body, actorOf(user));
    return c.json({ data: view }, 200);
  });

  router.openapi(landRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const body = c.req.valid("json");
    assertMemberLandableViaGroup(id);
    const view = requestSvc.land(id, body, actorOf(user));
    return c.json({ data: view }, 200);
  });

  router.openapi(rejectRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const body = c.req.valid("json");
    const view = requestSvc.reject(id, body, actorOf(user));
    return c.json({ data: view }, 200);
  });

  return router;
}
