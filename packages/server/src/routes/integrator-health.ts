import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables, AuthUser } from "../types.js";
import { AppError } from "../types.js";
import * as healthService from "../services/health.service.js";
import type { IntegratorHealthView } from "../services/health.service.js";

// ─── Param schema ─────────────────────────────────────────────────

const projectIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "projectId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const resourceQuery = z
  .string()
  .min(1)
  .optional()
  .openapi({
    param: { name: "resource", in: "query" },
    example: "main",
  });

// ─── Heartbeat body (§3.2) — Zod-4 mirror, snake_case on the wire ──
// The integrator MINTS the payload; PM denormalizes it onto the health row.
// pool_utilization.size/leased + version are required; in_flight defaults to
// all-zero.
// last_release_failure (C2) is TRI-STATE: absent (old integrator) → stored
// value untouched; explicit null → cleared; { at, message } → set.
const releaseFailureSchema = z.object({
  at: z.string().min(1),
  message: z.string(),
});

const heartbeatBody = z
  .object({
    resource: z.string().min(1).default("main"),
    status: z.enum(["idle", "integrating"]),
    pool_utilization: z.object({
      size: z.number().int(),
      leased: z.number().int(),
    }),
    in_flight: z
      .object({
        requests: z.number().int().default(0),
        batches: z.number().int().default(0),
        groups: z.number().int().default(0),
      })
      .default({ requests: 0, batches: 0, groups: 0 }),
    version: z.string().min(1),
    last_release_failure: releaseFailureSchema.nullable().optional(),
  })
  .openapi("IntegratorHeartbeat");

// ─── Response schemas ─────────────────────────────────────────────

const healthViewSchema = z
  .object({
    resource: z.string(),
    status: z.string(),
    healthy: z.boolean(),
    last_seen_at: z.string().nullable(),
    staleness_ms: z.number().nullable(),
    pool_size: z.number().nullable(),
    pool_leased: z.number().nullable(),
    in_flight_requests: z.number(),
    in_flight_batches: z.number(),
    in_flight_groups: z.number(),
    version: z.string().nullable(),
    integrator_id: z.string().nullable(),
    last_release_failure: releaseFailureSchema.nullable(),
  })
  .openapi("IntegratorHealth");

const healthEnvelope = z.object({ data: healthViewSchema });

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// ─── Routes ───────────────────────────────────────────────────────

const heartbeatRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/integrator/heartbeat",
  tags: ["Merge Train"],
  summary: "Integrator posts a liveness heartbeat",
  description:
    "The integrator POSTs a periodic heartbeat (status + worktree-pool utilization + in-flight counts + version) for a (project, resource) lane; PM upserts the integrator_health row (design §3.5). Integrator (ai_agent) only.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: {
      content: { "application/json": { schema: heartbeatBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Heartbeat recorded",
      content: { "application/json": { schema: healthEnvelope } },
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

const healthRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/integrator/health",
  tags: ["Merge Train"],
  summary: "Read a lane's integrator health",
  description:
    "Returns the on-read integrator health for a (project, resource) lane: derived staleness_ms + healthy flag + the denormalized heartbeat payload (design §3.4). This read fires the train.integrator_unhealthy edge when the lane is stale. Any authenticated user.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: z.object({ resource: resourceQuery }),
  },
  responses: {
    200: {
      description: "The lane health view",
      content: { "application/json": { schema: healthEnvelope } },
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

// ─── Helpers ──────────────────────────────────────────────────────

function requireUser(user: AuthUser | null): AuthUser {
  if (!user) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return user;
}

/** Map the camelCase service view onto the snake_case wire response. */
function toResponse(view: IntegratorHealthView): z.infer<typeof healthViewSchema> {
  return {
    resource: view.resource,
    status: view.status,
    healthy: view.healthy,
    last_seen_at: view.lastSeenAt,
    staleness_ms: view.stalenessMs,
    pool_size: view.poolSize,
    pool_leased: view.poolLeased,
    in_flight_requests: view.inFlightRequests,
    in_flight_batches: view.inFlightBatches,
    in_flight_groups: view.inFlightGroups,
    version: view.version,
    integrator_id: view.integratorId,
    last_release_failure: view.lastReleaseFailure,
  };
}

// ─── Router factory ───────────────────────────────────────────────

export function createIntegratorHealthRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  router.openapi(heartbeatRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);

    if (user.type !== "ai_agent") {
      throw new AppError(403, "FORBIDDEN", "Only integrator (ai_agent) users may post heartbeats.");
    }

    const body = c.req.valid("json");
    const now = new Date().toISOString();

    // The upsert resets the latch — a fresh beat re-arms the edge for this
    // lane, so the POST doesn't separately call checkStaleness for its own
    // lane (§3.5).
    const view = healthService.recordHeartbeat(
      projectId,
      body.resource,
      user.id,
      {
        status: body.status,
        poolSize: body.pool_utilization.size,
        poolLeased: body.pool_utilization.leased,
        inFlightRequests: body.in_flight.requests,
        inFlightBatches: body.in_flight.batches,
        inFlightGroups: body.in_flight.groups,
        version: body.version,
        // TRI-STATE passthrough: `undefined` (absent on the wire — an old
        // integrator) must stay undefined so recordHeartbeat leaves the
        // stored value untouched; null clears; a value sets.
        lastReleaseFailure: body.last_release_failure,
      },
      now,
    );

    return c.json({ data: toResponse(view) }, 200);
  });

  router.openapi(healthRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const { resource } = c.req.valid("query");
    requireUser(c.get("currentUser") as AuthUser | null);

    // This read fires the stale-edge event (§3.4).
    const view = healthService.getHealth(projectId, resource ?? "main");

    return c.json({ data: toResponse(view) }, 200);
  });

  return router;
}
