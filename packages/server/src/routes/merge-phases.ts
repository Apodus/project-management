import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables, AuthUser } from "../types.js";
import { AppError } from "../types.js";
import { MERGE_PHASES_DERIVED, MERGE_PHASES_OBSERVED, MERGE_PHASE_BASES } from "@pm/shared";
import * as mergePhaseService from "../services/merge-phase.service.js";

// ═══════════════════════════════════════════════════════════════════
// Train phase-timing REST surface (campaign 2026-08-03 §P1):
//   - the integrator ingest (ai_agent-gated, 202 — telemetry is accepted, not
//     transacted-with; the verify-cache record/mismatch gate idiom),
//   - the lane list + the two per-entity traces (any authenticated user — a
//     phase duration is operational telemetry, so it parallels the metrics GET,
//     not the admin-only audit log).
//
// The body/response schemas are LOCAL Zod-4 mirrors. Only the `as const` phase
// arrays are imported from @pm/shared — never the Zod-3 schemas, which do not
// unify with the Zod-4 instance @hono/zod-openapi builds routes from (the
// established route-local-mirror split).
//
// EACH route's `description` states its derived-inclusion contract verbatim:
// that OpenAPI text is where P3/P4/P5 will read whether a response already
// contains queue_wait/forming, and getting it wrong is how a phase gets counted
// twice.
// ═══════════════════════════════════════════════════════════════════

// ─── Param + query schemas ────────────────────────────────────────

const projectIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "projectId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const idParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "id", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const listQuery = z.object({
  resource: z
    .string()
    .min(1)
    .optional()
    .openapi({ param: { name: "resource", in: "query" }, example: "main" }),
  phase: z
    .enum(MERGE_PHASES_OBSERVED)
    .optional()
    .openapi({ param: { name: "phase", in: "query" } }),
  request_id: z
    .string()
    .min(1)
    .optional()
    .openapi({ param: { name: "request_id", in: "query" } }),
  group_id: z
    .string()
    .min(1)
    .optional()
    .openapi({ param: { name: "group_id", in: "query" } }),
  since: z
    .string()
    .min(1)
    .optional()
    .openapi({ param: { name: "since", in: "query" }, example: "2026-08-03T00:00:00.000Z" }),
  until: z
    .string()
    .min(1)
    .optional()
    .openapi({ param: { name: "until", in: "query" }, example: "2026-08-04T00:00:00.000Z" }),
  page: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .openapi({ param: { name: "page", in: "query" } }),
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .openapi({ param: { name: "perPage", in: "query" } }),
});

// ─── Body schema (Zod-4 mirror of mergePhaseIngestSchema) ─────────

const phaseEntryBody = z
  .object({
    // Only OBSERVED phases are ingestible. `queue_wait` / `forming` 400 here —
    // PM derives those from timestamps it already owns, so accepting them would
    // double-count the wait.
    phase: z.enum(MERGE_PHASES_OBSERVED),
    startedAt: z.string().datetime(),
    requestId: z.string().min(1).optional(),
    groupId: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
    durationMs: z.number(),
    label: z.string().nullable().optional(),
    detail: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("MergePhaseEntry");

const ingestBody = z
  .object({
    resource: z.string().min(1).default("main"),
    phases: z.array(phaseEntryBody).min(1).max(100),
  })
  .openapi("MergePhaseIngest");

// ─── Response schemas (Zod-4 mirrors of the shared views) ─────────

const mergePhaseRowSchema = z
  .object({
    derived: z.literal(false),
    id: z.string(),
    projectId: z.string(),
    resource: z.string(),
    requestId: z.string().nullable(),
    groupId: z.string().nullable(),
    attemptId: z.string().nullable(),
    phase: z.enum(MERGE_PHASES_OBSERVED),
    label: z.string().nullable(),
    startedAt: z.string(),
    durationMs: z.number(),
    detail: z.record(z.string(), z.unknown()).nullable(),
    recordedBy: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("MergePhaseRow");

const derivedPhaseEntrySchema = z
  .object({
    derived: z.literal(true),
    phase: z.enum(MERGE_PHASES_DERIVED),
    projectId: z.string(),
    resource: z.string(),
    requestId: z.string().nullable(),
    groupId: z.string().nullable(),
    startedAt: z.string(),
    durationMs: z.number(),
    originAt: z.string(),
    originDurationMs: z.number(),
    basis: z.enum(MERGE_PHASE_BASES),
  })
  .openapi("DerivedPhaseEntry");

const phaseTraceEntrySchema = z
  .discriminatedUnion("derived", [mergePhaseRowSchema, derivedPhaseEntrySchema])
  .openapi("PhaseTraceEntry");

const ingestEnvelope = z.object({
  data: z.object({ recorded: z.number(), adjusted: z.number() }),
});

const listEnvelope = z
  .object({
    data: z.array(mergePhaseRowSchema),
    pagination: z.object({
      total: z.number(),
      page: z.number(),
      perPage: z.number(),
    }),
  })
  .openapi("MergePhaseList");

const traceEnvelope = z.object({ data: z.array(phaseTraceEntrySchema) });

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// ─── Routes ───────────────────────────────────────────────────────

const ingestRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/merge-phases",
  tags: ["Merge Train"],
  summary: "Integrator records completed phase timings (batch)",
  description:
    "Append-only ingest of up to 100 COMPLETED phases for one lane. DERIVED-INCLUSION: this endpoint accepts OBSERVED phases only (assemble/materialize/rebase/verify/land) — `queue_wait` and `forming` are computed by PM from timestamps it already owns and are rejected here (400), so they can never be double-counted. Values are normalized rather than rejected (duration clamped, label truncated to 120 chars, detail dropped above 4KB, dangling or cross-project ids nulled); the `adjusted` count in the response reports how many rows were touched and is the signal that the emitter is wrong. `recordedBy` is taken from the session, never the body. Integrator (ai_agent) only.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: { content: { "application/json": { schema: ingestBody } }, required: true },
  },
  responses: {
    202: {
      description: "Accepted and recorded",
      content: { "application/json": { schema: ingestEnvelope } },
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

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/merge-phases",
  tags: ["Merge Train"],
  summary: "List recent phase timings for a lane",
  description:
    "Returns the project's merge_phase_timings rows, newest-first by (started_at, id), paginated (page/perPage, default 1/50, max 200), with optional resource/phase/request_id/group_id/since/until filters. DERIVED-INCLUSION: STORED ROWS ONLY — a derived `queue_wait`/`forming` entry is synthesized after the query and cannot participate in SQL LIMIT/OFFSET, so it is never mixed into this page. Use the per-request / per-group trace endpoints for the derived phases. Any authenticated user.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: listQuery,
  },
  responses: {
    200: {
      description: "The phase-timing page (stored rows only)",
      content: { "application/json": { schema: listEnvelope } },
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

const requestTraceRoute = createRoute({
  method: "get",
  path: "/api/v1/merge-requests/{id}/phases",
  tags: ["Merge Train"],
  summary: "The phase trace for one merge request",
  description:
    "The request's full phase trace in started_at ASCENDING order, bounded (no pagination). DERIVED-INCLUSION: INCLUDES the derived `queue_wait` entry at the head (derived:true, no id) — its `durationMs` is the last queue segment, `originDurationMs` the total since submit, and `basis` says which of the two applies (`requeued` when a prior integration ended inside the window). Stored rows follow (derived:false). Any authenticated user.",
  request: { params: z.object({ id: idParam }) },
  responses: {
    200: {
      description: "The trace (derived queue_wait + stored rows)",
      content: { "application/json": { schema: traceEnvelope } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Merge request not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const groupTraceRoute = createRoute({
  method: "get",
  path: "/api/v1/merge-groups/{id}/phases",
  tags: ["Merge Train"],
  summary: "The phase trace for one merge group",
  description:
    "The group's full phase trace — its own rows AND its members' — in started_at ASCENDING order, bounded (no pagination). DERIVED-INCLUSION: INCLUDES the derived `forming` entry at the head (derived:true, no id), measured from group creation to the EARLIEST member pickup. Stored rows follow (derived:false). Any authenticated user.",
  request: { params: z.object({ id: idParam }) },
  responses: {
    200: {
      description: "The trace (derived forming + stored rows)",
      content: { "application/json": { schema: traceEnvelope } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Merge group not found",
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

/**
 * Integrator-only gate. The integrator is the sole process that can observe a
 * phase (it is the only one inside the worktree), so a non-ai_agent writer must
 * 403 — mirrors the verify-cache record gate.
 */
function requireIntegrator(user: AuthUser, what: string): void {
  if (user.type !== "ai_agent") {
    throw new AppError(403, "FORBIDDEN", `Only integrator (ai_agent) users may ${what}.`);
  }
}

// ─── Router factory ───────────────────────────────────────────────

export function createMergePhaseRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  router.openapi(ingestRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireIntegrator(user, "record merge phase timings");
    const body = c.req.valid("json");

    const result = mergePhaseService.record(
      projectId,
      { resource: body.resource, phases: body.phases },
      { id: user.id },
      new Date().toISOString(),
    );

    return c.json({ data: result }, 202);
  });

  router.openapi(listRoute, (c) => {
    const { projectId } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    const q = c.req.valid("query");

    const page = q.page ?? 1;
    const perPage = q.perPage ?? 50;
    const result = mergePhaseService.listRecent(projectId, {
      resource: q.resource,
      phase: q.phase,
      requestId: q.request_id,
      groupId: q.group_id,
      since: q.since,
      until: q.until,
      page,
      perPage,
    });

    return c.json({ data: result.rows, pagination: { total: result.total, page, perPage } }, 200);
  });

  router.openapi(requestTraceRoute, (c) => {
    const { id } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    return c.json({ data: mergePhaseService.listForRequest(id) }, 200);
  });

  router.openapi(groupTraceRoute, (c) => {
    const { id } = c.req.valid("param");
    requireUser(c.get("currentUser") as AuthUser | null);
    return c.json({ data: mergePhaseService.listForGroup(id) }, 200);
  });

  return router;
}
