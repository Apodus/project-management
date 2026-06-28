import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { NOTES_TRIAGE_MODES, TRIAGE_DECISION_KINDS } from "@pm/shared";
import type { AppVariables, AuthUser } from "../types.js";
import { AppError } from "../types.js";
import * as triageDecisionService from "../services/triage-decision.service.js";
import * as triageMetricsService from "../services/triage-metrics.service.js";
import type { TriageMetricsBundle } from "../services/triage-metrics.service.js";

// ─── Triage-decision routes (T2·P1) ───────────────────────────────
// Route-local Zod-4 schemas (via @hono/zod-openapi `z`), the established split
// from the canonical Zod-3 @pm/shared triage-decision schema. The side-log is
// append-only: POST records a decision (NEVER mutating a note); GET lists with
// optional filters. Auth = app-level authMiddleware (no extra gate — the row is
// an append-only audit attributed to the caller, mirroring the flag/promote
// no-gate idiom). This phase does NOT wire the daemon (T2·P4) and does NOT make
// the existing triage endpoints auto-emit rows.

// ─── Response schemas ─────────────────────────────────────────────

const triageDecisionSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    noteId: z.string(),
    mode: z.enum(NOTES_TRIAGE_MODES),
    decision: z.enum(TRIAGE_DECISION_KINDS),
    rationale: z.string().nullable(),
    confidence: z.number().nullable(),
    resultingProposalId: z.string().nullable(),
    resultingTaskId: z.string().nullable(),
    actorId: z.string(),
    createdAt: z.string(),
  })
  .openapi("TriageDecision");

const triageDecisionDataEnvelope = z.object({ data: triageDecisionSchema });

const triageDecisionListEnvelope = z.object({
  data: z.array(triageDecisionSchema),
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

// ─── On-read metrics schema (T3·P3) ───────────────────────────────
// Route-local Zod-4 mirror of @pm/shared triageMetricsSchema (the established
// split — the canonical shape is the shared Zod-3 schema). snake_case on the
// wire (escalation /metrics precedent). Derived live from the triage_decisions
// side-log (+ notes) — no new table. See triage-metrics.service for the SCOPE
// semantics (scoped to settings.notesTriage.triageAgentId when set, else all
// actors + a by_actor breakdown; lane counts ALWAYS project-wide). heartbeat is
// LAST-DECISION freshness, NOT daemon liveness.

const triageDecisionMatrixSchema = z.object({
  promote_standard: z.number(),
  promote_fast_track: z.number(),
  dismiss: z.number(),
  needs_human: z.number(),
  give_up: z.number(),
});

const triageMetricsSchema = z
  .object({
    decision_mix: z.object({
      shadow: triageDecisionMatrixSchema,
      on: triageDecisionMatrixSchema,
      shadow_total: z.number(),
      on_total: z.number(),
      total: z.number(),
    }),
    latency: z.object({
      p50_ms: z.number().nullable(),
      p95_ms: z.number().nullable(),
      sample_size: z.number(),
    }),
    lane_counts: z.object({
      open: z.number(),
      needs_human: z.number(),
      triaged: z.number(),
    }),
    scope: z.object({
      triage_agent_id: z.string().nullable(),
      filtered: z.boolean(),
      by_actor: z.array(z.object({ actor_id: z.string(), count: z.number() })),
    }),
    heartbeat: z.object({
      last_decision_at: z.string().nullable(),
      age_ms: z.number().nullable(),
    }),
    window_since: z.string().nullable(),
    total: z.number(),
    computed_at: z.string(),
  })
  .openapi("TriageMetrics");

const triageMetricsEnvelope = z.object({ data: triageMetricsSchema });

// ─── Request schemas ──────────────────────────────────────────────

const createTriageDecisionBody = z
  .object({
    noteId: z.string().min(1),
    mode: z.enum(NOTES_TRIAGE_MODES),
    decision: z.enum(TRIAGE_DECISION_KINDS),
    rationale: z.string().nullable().optional(),
    confidence: z.number().nullable().optional(),
    resultingProposalId: z.string().nullable().optional(),
    resultingTaskId: z.string().nullable().optional(),
  })
  .openapi("CreateTriageDecision");

const listTriageDecisionsQuery = z.object({
  noteId: z.string().optional(),
  mode: z.enum(NOTES_TRIAGE_MODES).optional(),
  decision: z.enum(TRIAGE_DECISION_KINDS).optional(),
  since: z.string().optional(),
});

const triageMetricsQuery = z.object({
  since: z.string().optional(),
});

const projectIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "projectId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

// ─── Route definitions ────────────────────────────────────────────

const createTriageDecisionRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/triage-decisions",
  tags: ["Triage decisions"],
  summary: "Record triage decision",
  description:
    "Record a triage decision in the append-only side-log. NEVER mutates the referenced note — it only attributes a decision (promote/dismiss/needs_human/give_up) to the caller, under a rollout mode (off/shadow/on). Both shadow- and on-mode triage write here.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: {
      content: { "application/json": { schema: createTriageDecisionBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Triage decision recorded",
      content: { "application/json": { schema: triageDecisionDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project or note not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const listTriageDecisionsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/triage-decisions",
  tags: ["Triage decisions"],
  summary: "List triage decisions",
  description:
    "List a project's triage decisions, newest first, with optional filters (noteId / mode / decision / since).",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: listTriageDecisionsQuery,
  },
  responses: {
    200: {
      description: "List of triage decisions",
      content: { "application/json": { schema: triageDecisionListEnvelope } },
    },
  },
});

const getTriageMetricsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/triage-decisions/metrics",
  tags: ["Triage decisions"],
  summary: "Read the on-read triage metrics for a project",
  description:
    "Returns the triage dashboard metric bundle for a project: decision mix by kind × mode (shadow/on), triage latency p50/p95 (note creation → decision), project-wide lane counts (open/needs_human/triaged), and last-decision freshness. Derived live from the triage_decisions side-log (+ notes) — no new table. SCOPE: when settings.notesTriage.triageAgentId is designated, the mix/latency/heartbeat figures are scoped to that identity (read DIRECTLY off settings — works while triage is off/shadow); otherwise ALL actors are included with a by_actor breakdown. Lane counts are ALWAYS project-wide. heartbeat is LAST-DECISION freshness, NOT daemon liveness. Any authenticated user (read-only).",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: triageMetricsQuery,
  },
  responses: {
    200: {
      description: "The triage metric bundle",
      content: { "application/json": { schema: triageMetricsEnvelope } },
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

/** Explicit 401 (the established per-file helper; mirror escalations metrics). */
function requireUser(user: AuthUser | null): AuthUser {
  if (!user) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return user;
}

/** camelCase triage metric bundle → snake_case wire response (T3·P3). */
function metricsToResponse(bundle: TriageMetricsBundle): z.infer<typeof triageMetricsSchema> {
  return {
    decision_mix: {
      shadow: bundle.decisionMix.shadow,
      on: bundle.decisionMix.on,
      shadow_total: bundle.decisionMix.shadowTotal,
      on_total: bundle.decisionMix.onTotal,
      total: bundle.decisionMix.total,
    },
    latency: {
      p50_ms: bundle.latency.p50Ms,
      p95_ms: bundle.latency.p95Ms,
      sample_size: bundle.latency.sampleSize,
    },
    lane_counts: {
      open: bundle.laneCounts.open,
      needs_human: bundle.laneCounts.needsHuman,
      triaged: bundle.laneCounts.triaged,
    },
    scope: {
      triage_agent_id: bundle.scope.triageAgentId,
      filtered: bundle.scope.filtered,
      by_actor: bundle.scope.byActor.map((a) => ({ actor_id: a.actorId, count: a.count })),
    },
    heartbeat: {
      last_decision_at: bundle.heartbeat.lastDecisionAt,
      age_ms: bundle.heartbeat.ageMs,
    },
    window_since: bundle.windowSince,
    total: bundle.total,
    computed_at: bundle.computedAt,
  };
}

// ─── Router ───────────────────────────────────────────────────────

export function createTriageDecisionRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:projectId/triage-decisions/metrics (on-read, no new
  // table; mirrors escalations/metrics). Registered BEFORE the flat list route;
  // the literal /metrics segment does not collide (there is no /{id} route on
  // this router).
  router.openapi(getTriageMetricsRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const { since } = c.req.valid("query");
    requireUser(c.get("currentUser") as AuthUser | null);
    const bundle = triageMetricsService.computeTriageMetrics(projectId, { since });
    return c.json({ data: metricsToResponse(bundle) }, 200);
  });

  // POST /api/v1/projects/:projectId/triage-decisions
  router.openapi(createTriageDecisionRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser")!;
    // actorId is ALWAYS the caller — never accepted from the body.
    const row = triageDecisionService.record(projectId, body, user.id);
    return c.json({ data: row }, 201);
  });

  // GET /api/v1/projects/:projectId/triage-decisions
  router.openapi(listTriageDecisionsRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const query = c.req.valid("query");
    const list = triageDecisionService.list(projectId, query);
    return c.json({ data: list, pagination: { total: list.length } }, 200);
  });

  return router;
}
