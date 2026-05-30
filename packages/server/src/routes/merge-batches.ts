import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables, AuthUser } from "../types.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";

// ─── Param schema ─────────────────────────────────────────────────

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

// ─── Batch-marker event schema (Zod-4 mirror of batch.ts BatchEvent) ──
// LOCAL discriminated union — NO @pm/shared import (the integrator's
// `BatchEvent` type is the source of truth; this mirrors it field-for-field
// per design §13.2). Redeclared with the @hono/zod-openapi `z` (zod 4) so the
// OpenAPI generator can describe the relay body. The integrator MINTS the
// batchId (a ULID); PM never persists or generates it.
const batchEventBody = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("started"),
      batchId: z.string().min(1),
      resource: z.string().min(1),
      memberCount: z.number().int(),
      memberRequestIds: z.array(z.string()),
    }),
    z.object({
      type: z.literal("member_landed"),
      batchId: z.string().min(1),
      requestId: z.string().min(1),
      speculativePosition: z.number().int(),
      landedSha: z.string().min(1),
    }),
    z.object({
      type: z.literal("member_invalidated"),
      batchId: z.string().min(1),
      requestId: z.string().min(1),
      speculativePosition: z.number().int(),
      reason: z.string().min(1),
      failedPredecessorRequestId: z.string().min(1),
    }),
    z.object({
      type: z.literal("completed"),
      batchId: z.string().min(1),
      landed: z.number().int(),
      rejected: z.number().int(),
      invalidated: z.number().int(),
    }),
  ])
  .openapi("MergeBatchEvent");

const acceptedEnvelope = z.object({
  data: z.object({ ok: z.boolean() }),
});

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// ─── Route definition ─────────────────────────────────────────────

const relayRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/merge-batches/events",
  tags: ["Merge Requests"],
  summary: "Integrator relays a batch-marker event",
  description:
    "Thin relay (design §13.2): the integrator POSTs one of four batch markers (started / member_landed / member_invalidated / completed); PM re-emits it on the merge.batch.* SSE stream and persists NOTHING. Integrator (ai_agent) only.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: { content: { "application/json": { schema: batchEventBody } }, required: true },
  },
  responses: {
    202: {
      description: "Accepted and re-emitted",
      content: { "application/json": { schema: acceptedEnvelope } },
    },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
  },
});

// ─── Helpers ──────────────────────────────────────────────────────

function requireUser(user: AuthUser | null): AuthUser {
  if (!user) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return user;
}

// ─── Router factory ───────────────────────────────────────────────

export function createMergeBatchRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  router.openapi(relayRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);

    if (user.type !== "ai_agent") {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only integrator (ai_agent) users may relay batch events.",
      );
    }

    const body = c.req.valid("json");

    const eventNameByType = {
      started: EVENT_NAMES.MERGE_BATCH_STARTED,
      member_landed: EVENT_NAMES.MERGE_BATCH_MEMBER_LANDED,
      member_invalidated: EVENT_NAMES.MERGE_BATCH_MEMBER_INVALIDATED,
      completed: EVENT_NAMES.MERGE_BATCH_COMPLETED,
    } as const;
    const eventName = eventNameByType[body.type];

    // Re-emit only — PM persists nothing. Mirror the EventPayload shape used by
    // merge-request.service.emit: the full marker is spread onto `entity` so the
    // SSE wire projection (routes/events.ts) can read batchId/speculativePosition.
    getEventBus().emit(eventName as never, {
      entity: { ...body },
      entityType: "merge_batch",
      entityId: body.batchId,
      projectId,
      actorId: user.id,
      timestamp: new Date().toISOString(),
    });

    return c.json({ data: { ok: true } }, 202);
  });

  return router;
}
