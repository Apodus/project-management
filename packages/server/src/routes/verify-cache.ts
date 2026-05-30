import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables, AuthUser } from "../types.js";
import { AppError } from "../types.js";
import { VERIFY_RESULTS } from "@pm/shared";
import * as verifyCacheService from "../services/verify-cache.service.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";

// ═══════════════════════════════════════════════════════════════════
// Phase 7.5 §8.4/§8.5/§9 — the verify-cache REST surface:
//   - the debug list GET (requireAuth — any authed user, §8.4)
//   - the integrator lookup/record pair (ai_agent-gated — the integrator is
//     the only caller; non-ai_agent must 403, §8.5)
//   - the mismatch relay (ai_agent-gated, NON-persisted — re-emits
//     verify.cache_mismatch on the SSE stream, §9, the merge-batches pattern)
//
// The body/response schemas are LOCAL Zod-4 mirrors of the @pm/shared Zod-3
// verifyCacheRowSchema (camelCase per §3.1) — NEVER import the Zod-3 shared
// schema into createRoute (the established route-local-mirror split).
// ═══════════════════════════════════════════════════════════════════

// ─── Param + query schemas ────────────────────────────────────────

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const listQuery = z.object({
  resource: z.string().min(1).optional().openapi({
    param: { name: "resource", in: "query" },
    example: "main",
  }),
  step_id: z.string().min(1).optional().openapi({
    param: { name: "step_id", in: "query" },
    example: "lint",
  }),
  result: z
    .enum(VERIFY_RESULTS)
    .optional()
    .openapi({ param: { name: "result", in: "query" } }),
  page: z.coerce.number().int().min(1).optional().openapi({
    param: { name: "page", in: "query" },
  }),
  perPage: z.coerce.number().int().min(1).max(200).optional().openapi({
    param: { name: "perPage", in: "query" },
  }),
});

// ─── Body schemas (Zod-4 mirror, camelCase) ───────────────────────

const lookupBody = z
  .object({
    resource: z.string().min(1).default("main"),
    treeSha: z.string().min(1),
    stepId: z.string().min(1),
    stepConfigSha: z.string().min(1),
  })
  .openapi("VerifyCacheLookup");

const recordBody = z
  .object({
    resource: z.string().min(1).default("main"),
    treeSha: z.string().min(1),
    stepId: z.string().min(1),
    stepConfigSha: z.string().min(1),
    result: z.enum(VERIFY_RESULTS),
    durationMs: z.number().int().nullable().optional(),
    logExcerpt: z.string().nullable().optional(),
    logUrl: z.string().nullable().optional(),
  })
  .openapi("VerifyCacheRecord");

const mismatchBody = z
  .object({
    resource: z.string().min(1).default("main"),
    treeSha: z.string().min(1),
    stepId: z.string().min(1),
    stepConfigSha: z.string().min(1),
    cachedResult: z.enum(VERIFY_RESULTS),
    realResult: z.enum(VERIFY_RESULTS),
    requestId: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
  })
  .openapi("VerifyCacheMismatch");

// ─── Response schemas (Zod-4 LOCAL mirror of verifyCacheRowSchema) ──

const verifyCacheRowSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    resource: z.string(),
    treeSha: z.string(),
    stepId: z.string(),
    stepConfigSha: z.string(),
    result: z.enum(VERIFY_RESULTS),
    durationMs: z.number().nullable(),
    logExcerpt: z.string().nullable(),
    logUrl: z.string().nullable(),
    createdAt: z.string(),
    lastHitAt: z.string().nullable(),
    hitCount: z.number(),
    updatedAt: z.string(),
  })
  .openapi("VerifyCacheRow");

const listEnvelope = z
  .object({
    data: z.array(verifyCacheRowSchema),
    pagination: z.object({
      total: z.number(),
      page: z.number(),
      perPage: z.number(),
    }),
  })
  .openapi("VerifyCacheList");

// The lookup envelope: a hit returns the row view, a miss returns null.
const lookupEnvelope = z.object({
  data: verifyCacheRowSchema.nullable(),
});

const recordEnvelope = z.object({ data: verifyCacheRowSchema });

const acceptedEnvelope = z.object({
  data: z.object({ ok: z.boolean() }),
});

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// ─── Routes ───────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/verify-cache",
  tags: ["Merge Train"],
  summary: "List recent verify-cache rows (debug / dashboard)",
  description:
    "Returns the project's verify_cache rows, newest-first by created_at, paginated (page/perPage, default 1/50, max 200), with optional resource/step_id/result filters (design §8.4). Any authenticated user — a cache row is operational telemetry (a tree SHA + a verdict + hit counts), NOT admin-tier accountability data, so it parallels the metrics GET (requireAuth), not the audit log (requireAdmin).",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: listQuery,
  },
  responses: {
    200: { description: "The verify-cache page", content: { "application/json": { schema: listEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const lookupRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/verify-cache/lookup",
  tags: ["Merge Train"],
  summary: "Integrator probes the verify cache (strict 5-tuple)",
  description:
    "The integrator probes the exact (project, resource, tree_sha, step_id, step_config_sha) key BEFORE running a step (design §3.2/§8.5). A HIT bumps hit_count/last_hit_at server-side (PM-owned, §8.5) and returns the cached verdict; a MISS returns data:null. Integrator (ai_agent) only.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: { content: { "application/json": { schema: lookupBody } }, required: true },
  },
  responses: {
    200: { description: "The cached row (hit) or null (miss)", content: { "application/json": { schema: lookupEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const recordRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/verify-cache/record",
  tags: ["Merge Train"],
  summary: "Integrator records a verify verdict (write-or-update)",
  description:
    "The integrator records the verdict for a (project, resource, tree_sha, step_id, step_config_sha) key AFTER running a step — an upsert on the unique key that PRESERVES hit_count/last_hit_at/created_at on a re-record (the shadow self-heal, §8.5/§4.4). Integrator (ai_agent) only.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: { content: { "application/json": { schema: recordBody } }, required: true },
  },
  responses: {
    200: { description: "The recorded row", content: { "application/json": { schema: recordEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
    404: { description: "Project not found", content: { "application/json": { schema: errorEnvelope } } },
  },
});

const mismatchRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/verify-cache/mismatch",
  tags: ["Merge Train"],
  summary: "Integrator relays a shadow-mode cache mismatch",
  description:
    "Thin relay (design §9): in shadow mode, when the real run disagrees with a cached verdict, the integrator POSTs the mismatch; PM re-emits it on the verify.cache_mismatch SSE stream and persists NOTHING (the durable record is the re-recorded corrected row + the metric count, §4.4/§9). Integrator (ai_agent) only.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: { content: { "application/json": { schema: mismatchBody } }, required: true },
  },
  responses: {
    202: { description: "Accepted and re-emitted", content: { "application/json": { schema: acceptedEnvelope } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: errorEnvelope } } },
    403: { description: "Integrator (ai_agent) only", content: { "application/json": { schema: errorEnvelope } } },
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

/**
 * Integrator-only gate (the OPPOSITE of the human-admin break-glass gate). The
 * integrator is the sole caller of lookup/record/mismatch — a non-ai_agent
 * caller must 403 (mirrors the integrator-health heartbeat + merge-batches
 * relay gate, §8.5).
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

export function createVerifyCacheRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  router.openapi(listRoute, (c) => {
    const { projectId } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    const q = c.req.valid("query");

    const page = q.page ?? 1;
    const perPage = q.perPage ?? 50;
    const result = verifyCacheService.list(projectId, {
      resource: q.resource,
      stepId: q.step_id,
      result: q.result,
      page,
      perPage,
    });

    return c.json(
      {
        data: result.rows,
        pagination: { total: result.total, page, perPage },
      },
      200,
    );
  });

  router.openapi(lookupRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireIntegrator(user, "probe the verify cache");
    const body = c.req.valid("json");
    const now = new Date().toISOString();

    // A HIT bumps hit_count/last_hit_at server-side (PM-owned, §8.5); a MISS → null.
    const view = verifyCacheService.lookup(
      {
        projectId,
        resource: body.resource,
        treeSha: body.treeSha,
        stepId: body.stepId,
        stepConfigSha: body.stepConfigSha,
      },
      now,
    );

    return c.json({ data: view }, 200);
  });

  router.openapi(recordRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireIntegrator(user, "record a verify verdict");
    const body = c.req.valid("json");
    const now = new Date().toISOString();

    const view = verifyCacheService.record(
      {
        projectId,
        resource: body.resource,
        treeSha: body.treeSha,
        stepId: body.stepId,
        stepConfigSha: body.stepConfigSha,
        result: body.result,
        durationMs: body.durationMs ?? null,
        logExcerpt: body.logExcerpt ?? null,
        logUrl: body.logUrl ?? null,
      },
      now,
    );

    return c.json({ data: view }, 200);
  });

  router.openapi(mismatchRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireIntegrator(user, "relay cache mismatches");
    const body = c.req.valid("json");

    // Re-emit only — PM persists nothing (the merge-batches relay pattern). The
    // key + result fields are spread onto `entity` so the SSE wire projection
    // (routes/events.ts) can read tree_sha/step_id/cached_result/real_result.
    getEventBus().emit(EVENT_NAMES.VERIFY_CACHE_MISMATCH as never, {
      entity: { ...body },
      entityType: "verify_cache",
      entityId: body.treeSha,
      projectId,
      actorId: user.id,
      timestamp: new Date().toISOString(),
    });

    return c.json({ data: { ok: true } }, 202);
  });

  return router;
}
