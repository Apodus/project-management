import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { NOTES_TRIAGE_MODES, TRIAGE_DECISION_KINDS } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as triageDecisionService from "../services/triage-decision.service.js";

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
  mode: z.enum(NOTES_TRIAGE_MODES).optional(),
  decision: z.enum(TRIAGE_DECISION_KINDS).optional(),
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
    "List a project's triage decisions, newest first, with optional filters (mode / decision / since).",
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

// ─── Router ───────────────────────────────────────────────────────

export function createTriageDecisionRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

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
