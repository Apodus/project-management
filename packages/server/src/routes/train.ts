import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables, AuthUser } from "../types.js";
import { AppError } from "../types.js";
import * as trainService from "../services/train.service.js";
import * as metricsService from "../services/metrics.service.js";
import type {
  InFlightBundle,
  MetricsBundle,
} from "../services/metrics.service.js";

// ─── Param + query schemas ────────────────────────────────────────

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const requestIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const resourcePathParam = z.string().min(1).openapi({
  param: { name: "resource", in: "path" },
  example: "main",
});

const resourceQuery = z.string().min(1).optional().openapi({
  param: { name: "resource", in: "query" },
  example: "main",
});

// ─── Body schemas (Zod-4 mirror) ──────────────────────────────────

const pauseBody = z
  .object({
    resource: z.string().min(1).default("main"),
    reason: z.string().min(1).max(2048).nullable().optional(),
  })
  .openapi("TrainPause");

const resumeBody = z
  .object({
    resource: z.string().min(1).default("main"),
    reason: z.string().min(1).max(2048).nullable().optional(),
  })
  .openapi("TrainResume");

const forceReleaseBody = z
  .object({
    reason: z.string().min(1).max(2048).nullable().optional(),
  })
  .openapi("ForceReleaseLock");

const forceLandBody = z
  .object({
    landedSha: z.string().min(1).max(128).openapi({ example: "abc1234" }),
    reason: z.string().min(1).max(2048).openapi({
      example: "hotfix for prod outage; verify infra down",
    }),
  })
  .openapi("ForceLand");

const forceRejectBody = z
  .object({
    reason: z.string().min(1).max(2048).openapi({
      example: "obsoleted by a newer request; clearing the lane",
    }),
  })
  .openapi("ForceReject");

// ─── Response schemas ─────────────────────────────────────────────

const trainStateSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    resource: z.string(),
    state: z.string(),
    changedBy: z.string().nullable(),
    reason: z.string().nullable(),
    changedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("TrainState");

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
  .openapi("ForceMergeRequest");

const lockReleaseSchema = z
  .object({
    ok: z.boolean(),
    resource: z.string(),
    priorHolderId: z.string().nullable(),
  })
  .openapi("ForceReleaseResult");

const trainStateEnvelope = z.object({ data: trainStateSchema });
const mergeRequestEnvelope = z.object({ data: mergeRequestSchema });
const lockReleaseEnvelope = z.object({ data: lockReleaseSchema });

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// ─── Metrics + in-flight response schemas (§5.6 / §5.3) ───────────
// snake_case on the wire, mirroring routes/integrator-health.ts. The
// embedded health block reuses the same field names as IntegratorHealth.

const sloDimensionSchema = z.object({
  target_sec: z.number().optional(),
  target: z.number().optional(),
  measured_ms: z.number().nullable().optional(),
  measured: z.number().nullable().optional(),
  compliant: z.boolean(),
});

const metricsBundleSchema = z
  .object({
    resource: z.string(),
    queue_depth: z.number(),
    in_flight: z.number(),
    time_to_land: z.object({
      p50_ms: z.number().nullable(),
      p95_ms: z.number().nullable(),
      p99_ms: z.number().nullable(),
      sample_size: z.number(),
    }),
    verify_success_rate: z.object({
      ratio: z.number().nullable(),
      passed: z.number(),
      total: z.number(),
    }),
    abandon_rate: z.object({
      ratio: z.number().nullable(),
      abandoned: z.number(),
      resolved: z.number(),
    }),
    pool_utilization: z.object({
      size: z.number().nullable(),
      leased: z.number().nullable(),
      ratio: z.number().nullable(),
    }),
    health: z.object({
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
    }),
    slo: z.object({
      p95_time_to_land: sloDimensionSchema.optional(),
      verify_success_rate: sloDimensionSchema.optional(),
      abandon_rate: sloDimensionSchema.optional(),
      overall_compliant: z.boolean().nullable(),
    }),
    // Phase 7.5 §7.2 — the additive verify sub-block (cache observability).
    verify: z.object({
      cache_enabled: z.boolean(),
      cache_mode: z.string(),
      cache_hit_rate: z.object({
        ratio: z.number().nullable(),
        hits: z.number(),
        lookups: z.number(),
      }),
      time_saved_ms: z.number(),
      per_step: z.array(
        z.object({
          step_id: z.string(),
          runs: z.number(),
          cached: z.number(),
          pass_rate: z.number().nullable(),
          avg_duration_ms: z.number().nullable(),
          fail_count: z.number(),
        }),
      ),
      cache_mismatches: z.number(),
    }),
    window_hours: z.number(),
    computed_at: z.string(),
  })
  .openapi("TrainMetrics");

const inFlightMemberSchema = z.object({
  id: z.string(),
  group_id: z.string().nullable(),
  status: z.string(),
  enqueued_at: z.string(),
  picked_up_at: z.string().nullable(),
  attempt: z
    .object({
      status: z.string(),
      base_sha: z.string(),
      tree_sha: z.string().nullable(),
      started_at: z.string().nullable(),
    })
    .nullable(),
});

const inFlightGroupSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  resource: z.string(),
  state: z.string(),
  submitted_by: z.string(),
  integrator_id: z.string().nullable(),
  resolved_at: z.string().nullable(),
  resolution_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const inFlightSchema = z
  .object({
    groups: z.array(inFlightGroupSchema),
    members: z.array(inFlightMemberSchema),
  })
  .openapi("TrainInFlight");

const metricsEnvelope = z.object({ data: metricsBundleSchema });
const inFlightEnvelope = z.object({ data: inFlightSchema });

// ─── Routes ───────────────────────────────────────────────────────

const pauseRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/train/pause",
  tags: ["Merge Train"],
  summary: "Pause the train (admin break-glass)",
  description:
    "Admin override: stop the integrator admitting NEW work for a (project, resource) lane; in-flight members finish cleanly (design §4.3.1). Idempotent no-op (no duplicate audit) when already paused. Writes one `pause` audit row.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: { content: { "application/json": { schema: pauseBody } }, required: false },
  },
  responses: {
    200: { description: "Train paused", content: { "application/json": { schema: trainStateEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Admin only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const resumeRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/train/resume",
  tags: ["Merge Train"],
  summary: "Resume the train (admin break-glass)",
  description:
    "Admin override: re-enable NEW pickups for a (project, resource) lane (design §4.3.2). Idempotent no-op (no audit) when already running. Writes one `resume` audit row.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: { content: { "application/json": { schema: resumeBody } }, required: false },
  },
  responses: {
    200: { description: "Train resumed", content: { "application/json": { schema: trainStateEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Admin only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const forceReleaseRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/merge-locks/{resource}/force-release",
  tags: ["Merge Train"],
  summary: "Force-release a stuck merge lock (admin break-glass)",
  description:
    "Admin override: HARD-clear a stuck lane lock without waiting for the lease TTL sweep (design §4.3.3). Does NOT promote the queue head and does NOT touch in-flight merge_requests. Writes one `force_release_lock` audit row + emits merge.lock.released.",
  request: {
    params: z.object({ projectId: projectIdParam, resource: resourcePathParam }),
    body: { content: { "application/json": { schema: forceReleaseBody } }, required: false },
  },
  responses: {
    200: { description: "Lock force-released", content: { "application/json": { schema: lockReleaseEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Admin only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const forceLandRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-requests/{id}/force-land",
  tags: ["Merge Train"],
  summary: "Force-land a request without verify (admin break-glass — THE R1 override)",
  description:
    "Admin override: land an `integrating` request WITHOUT verify (design §4.3.4) — the deliberate, recorded human bypass of the verify-gate. Admin-only, reason-required (both 400 if absent/empty). Grouped members → 409. Records the operator-asserted landedSha; does NOT run git (PM-state vs git-remote divergence is by design). Writes one prominently-recorded `force_land` audit row.",
  request: {
    params: z.object({ id: requestIdParam }),
    body: { content: { "application/json": { schema: forceLandBody } }, required: true },
  },
  responses: {
    200: { description: "Force-landed", content: { "application/json": { schema: mergeRequestEnvelope } } },
    400: { description: "Validation error (missing/empty reason or landedSha)", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Admin only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Merge request not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Grouped member or invalid transition", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const forceRejectRoute = createRoute({
  method: "post",
  path: "/api/v1/merge-requests/{id}/force-reject",
  tags: ["Merge Train"],
  summary: "Force-reject a stuck request (admin break-glass)",
  description:
    "Admin override: reject a stuck `integrating` request on policy grounds (design §4.3.5). Admin-only, reason-required (400 if empty). Writes the merge_rejection comment + one `force_reject` audit row.",
  request: {
    params: z.object({ id: requestIdParam }),
    body: { content: { "application/json": { schema: forceRejectBody } }, required: true },
  },
  responses: {
    200: { description: "Force-rejected", content: { "application/json": { schema: mergeRequestEnvelope } } },
    400: { description: "Validation error (missing/empty reason)", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Admin only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Merge request not found", content: { "application/json": { schema: errorEnvelope } } },
    409: { description: "Invalid transition", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const getTrainStateRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/train/state",
  tags: ["Merge Train"],
  summary: "Read a lane's train (pause/resume) state",
  description:
    "Returns the (project, resource) lane's running/paused control state (design §4.1). Lazy-creates the row defaulting to running. Any authenticated user.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: z.object({ resource: resourceQuery }),
  },
  responses: {
    200: { description: "The train state", content: { "application/json": { schema: trainStateEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const getMetricsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/train/metrics",
  tags: ["Merge Train"],
  summary: "Read the on-read metric bundle for a lane",
  description:
    "Returns the dashboard metric bundle for a (project, resource) lane: queue depth, in-flight count, 24h time-to-land p50/p95/p99, verify success + abandon rates, pool utilization, the embedded health view, and SLO compliance (design §5.6). The 24h window uses a JS-ISO cutoff. Computing this embeds health.getHealth, so a stale lane fires train.integrator_unhealthy once per episode. Any authenticated user (read-only observability).",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: z.object({ resource: resourceQuery }),
  },
  responses: {
    200: { description: "The metric bundle", content: { "application/json": { schema: metricsEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const getInFlightRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/train/in-flight",
  tags: ["Merge Train"],
  summary: "Read the in-flight composition for a lane",
  description:
    "Returns the lane's `integrating` merge requests with each one's latest attempt + groupId, plus the forming/integrating group rows (design §5.3). The server does NOT compute speculativePosition/batchId — the dashboard enriches those from the SSE stream. Any authenticated user.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: z.object({ resource: resourceQuery }),
  },
  responses: {
    200: { description: "The in-flight composition", content: { "application/json": { schema: inFlightEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
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
 * Inline admin gate per handler. These are HUMAN admin break-glass operations —
 * the OPPOSITE of the integrator-heartbeat endpoint's ai_agent gate. The
 * service double-checks admin too (defense in depth).
 */
function requireAdmin(user: AuthUser): void {
  if (user.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "Admin role required for this operation.");
  }
}

/** camelCase metric bundle → snake_case wire response (§5.6). */
function metricsToResponse(
  bundle: MetricsBundle,
): z.infer<typeof metricsBundleSchema> {
  const slo = bundle.slo;
  const sloResponse: z.infer<typeof metricsBundleSchema>["slo"] = {
    overall_compliant: slo.overallCompliant,
  };
  if (slo.p95TimeToLand) {
    sloResponse.p95_time_to_land = {
      target_sec: slo.p95TimeToLand.targetSec,
      measured_ms: slo.p95TimeToLand.measuredMs,
      compliant: slo.p95TimeToLand.compliant,
    };
  }
  if (slo.verifySuccessRate) {
    sloResponse.verify_success_rate = {
      target: slo.verifySuccessRate.target,
      measured: slo.verifySuccessRate.measured,
      compliant: slo.verifySuccessRate.compliant,
    };
  }
  if (slo.abandonRate) {
    sloResponse.abandon_rate = {
      target: slo.abandonRate.target,
      measured: slo.abandonRate.measured,
      compliant: slo.abandonRate.compliant,
    };
  }
  return {
    resource: bundle.resource,
    queue_depth: bundle.queueDepth,
    in_flight: bundle.inFlight,
    time_to_land: {
      p50_ms: bundle.timeToLand.p50Ms,
      p95_ms: bundle.timeToLand.p95Ms,
      p99_ms: bundle.timeToLand.p99Ms,
      sample_size: bundle.timeToLand.sampleSize,
    },
    verify_success_rate: {
      ratio: bundle.verifySuccessRate.ratio,
      passed: bundle.verifySuccessRate.passed,
      total: bundle.verifySuccessRate.total,
    },
    abandon_rate: {
      ratio: bundle.abandonRate.ratio,
      abandoned: bundle.abandonRate.abandoned,
      resolved: bundle.abandonRate.resolved,
    },
    pool_utilization: {
      size: bundle.poolUtilization.size,
      leased: bundle.poolUtilization.leased,
      ratio: bundle.poolUtilization.ratio,
    },
    health: {
      resource: bundle.health.resource,
      status: bundle.health.status,
      healthy: bundle.health.healthy,
      last_seen_at: bundle.health.lastSeenAt,
      staleness_ms: bundle.health.stalenessMs,
      pool_size: bundle.health.poolSize,
      pool_leased: bundle.health.poolLeased,
      in_flight_requests: bundle.health.inFlightRequests,
      in_flight_batches: bundle.health.inFlightBatches,
      in_flight_groups: bundle.health.inFlightGroups,
      version: bundle.health.version,
      integrator_id: bundle.health.integratorId,
    },
    slo: sloResponse,
    verify: {
      cache_enabled: bundle.verify.cacheEnabled,
      cache_mode: bundle.verify.cacheMode,
      cache_hit_rate: {
        ratio: bundle.verify.cacheHitRate.ratio,
        hits: bundle.verify.cacheHitRate.hits,
        lookups: bundle.verify.cacheHitRate.lookups,
      },
      time_saved_ms: bundle.verify.timeSavedMs,
      per_step: bundle.verify.perStep.map((s) => ({
        step_id: s.stepId,
        runs: s.runs,
        cached: s.cached,
        pass_rate: s.passRate,
        avg_duration_ms: s.avgDurationMs,
        fail_count: s.failCount,
      })),
      cache_mismatches: bundle.verify.cacheMismatches,
    },
    window_hours: bundle.windowHours,
    computed_at: bundle.computedAt,
  };
}

/** camelCase in-flight bundle → snake_case wire response (§5.3). */
function inFlightToResponse(
  bundle: InFlightBundle,
): z.infer<typeof inFlightSchema> {
  return {
    groups: bundle.groups.map((g) => ({
      id: g.id,
      project_id: g.projectId,
      resource: g.resource,
      state: g.state,
      submitted_by: g.submittedBy,
      integrator_id: g.integratorId,
      resolved_at: g.resolvedAt,
      resolution_reason: g.resolutionReason,
      created_at: g.createdAt,
      updated_at: g.updatedAt,
    })),
    members: bundle.members.map((m) => ({
      id: m.id,
      group_id: m.groupId,
      status: m.status,
      enqueued_at: m.enqueuedAt,
      picked_up_at: m.pickedUpAt,
      attempt: m.attempt
        ? {
            status: m.attempt.status,
            base_sha: m.attempt.baseSha,
            tree_sha: m.attempt.treeSha,
            started_at: m.attempt.startedAt,
          }
        : null,
    })),
  };
}

// ─── Router factory ───────────────────────────────────────────────

export function createTrainRoutes(): OpenAPIHono<{ Variables: AppVariables }> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  router.openapi(pauseRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireAdmin(user);
    let body: { resource?: string; reason?: string | null } = {};
    try {
      body = c.req.valid("json") ?? {};
    } catch {
      // Body optional.
    }
    const view = trainService.pause(
      projectId,
      body.resource ?? "main",
      actorOf(user),
      body.reason ?? null,
    );
    return c.json({ data: view }, 200);
  });

  router.openapi(resumeRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireAdmin(user);
    let body: { resource?: string; reason?: string | null } = {};
    try {
      body = c.req.valid("json") ?? {};
    } catch {
      // Body optional.
    }
    const view = trainService.resume(
      projectId,
      body.resource ?? "main",
      actorOf(user),
      body.reason ?? null,
    );
    return c.json({ data: view }, 200);
  });

  router.openapi(forceReleaseRoute, (c) => {
    const { projectId, resource } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireAdmin(user);
    let body: { reason?: string | null } = {};
    try {
      body = c.req.valid("json") ?? {};
    } catch {
      // Body optional.
    }
    const result = trainService.forceReleaseLock(
      projectId,
      resource,
      actorOf(user),
      body.reason ?? null,
    );
    return c.json({ data: result }, 200);
  });

  router.openapi(forceLandRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireAdmin(user);
    const body = c.req.valid("json");
    const view = trainService.forceLand(
      id,
      { landedSha: body.landedSha, reason: body.reason },
      actorOf(user),
    );
    return c.json({ data: view }, 200);
  });

  router.openapi(forceRejectRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireAdmin(user);
    const body = c.req.valid("json");
    const view = trainService.forceReject(id, { reason: body.reason }, actorOf(user));
    return c.json({ data: view }, 200);
  });

  router.openapi(getTrainStateRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const { resource } = c.req.valid("query");
    requireUser(c.get("currentUser") as AuthUser | null);
    const view = trainService.getTrainState(projectId, resource ?? "main");
    return c.json({ data: view }, 200);
  });

  router.openapi(getMetricsRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const { resource } = c.req.valid("query");
    requireUser(c.get("currentUser") as AuthUser | null);
    // computeMetrics embeds getHealth → fires the stale edge on-read (§3.4).
    const bundle = metricsService.computeMetrics(projectId, resource ?? "main");
    return c.json({ data: metricsToResponse(bundle) }, 200);
  });

  router.openapi(getInFlightRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const { resource } = c.req.valid("query");
    requireUser(c.get("currentUser") as AuthUser | null);
    const bundle = metricsService.getInFlight(projectId, resource ?? "main");
    return c.json({ data: inFlightToResponse(bundle) }, 200);
  });

  return router;
}
