import { z } from "zod";
import { NOTES_TRIAGE_MODES, TRIAGE_DECISION_KINDS } from "../constants/enums.js";

// ─── Triage decision side-log (T2·P1) ─────────────────────────────
// A uniform decision-log row that BOTH shadow- and on-mode triage write via a
// decoupled record() that NEVER mutates a note. This is the contract T3 reads.
// `mode` reuses NOTES_TRIAGE_MODES (the off/shadow/on rollout ladder) — there is
// no second mode enum. `decision` is the disposition (TRIAGE_DECISION_KINDS).
// Zod-3, no .openapi(); bare z.string() for ids/timestamps (note.ts precedent).

// ─── View shape ───────────────────────────────────────────────────
// Full row shape. rationale/confidence/resultingProposalId/resultingTaskId are
// nullable (a shadow-mode row records intent without producing a target;
// give_up records no rationale). Field names mirror the eventual Drizzle
// camelCase property names.
export const triageDecisionSchema = z.object({
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
});
export type TriageDecision = z.infer<typeof triageDecisionSchema>;

// ─── DTOs ─────────────────────────────────────────────────────────
// Create body. Omits id/projectId/actorId/createdAt — all server/auth/URL-
// derived. noteId/mode/decision are required; the rest are optional nullable.
export const createTriageDecisionSchema = z.object({
  noteId: z.string(),
  mode: z.enum(NOTES_TRIAGE_MODES),
  decision: z.enum(TRIAGE_DECISION_KINDS),
  rationale: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  resultingProposalId: z.string().nullable().optional(),
  resultingTaskId: z.string().nullable().optional(),
});
export type CreateTriageDecision = z.infer<typeof createTriageDecisionSchema>;

// List/filter query.
export const listTriageDecisionsSchema = z.object({
  noteId: z.string().optional(),
  mode: z.enum(NOTES_TRIAGE_MODES).optional(),
  decision: z.enum(TRIAGE_DECISION_KINDS).optional(),
  since: z.string().optional(),
});
export type ListTriageDecisionsQuery = z.infer<typeof listTriageDecisionsSchema>;

// ─── On-read triage metrics (T3·P3) ───────────────────────────────
// The SNAKE_CASE wire shape of the triage dashboard metric bundle, derived live
// from the triage_decisions side-log (+ notes) — no new table. Mirrors the
// escalation-metrics wire schema. The per-kind decision keys are already
// snake_case wire-stable (TRIAGE_DECISION_KINDS), so no per-kind rename. The
// server maps its camelCase bundle to this shape at the route boundary. Zod-3,
// no .openapi() (the route re-declares a Zod-4 mirror via @hono/zod-openapi).
const triageDecisionMatrixSchema = z.object({
  promote_standard: z.number(),
  promote_fast_track: z.number(),
  dismiss: z.number(),
  needs_human: z.number(),
  give_up: z.number(),
});

export const triageMetricsSchema = z.object({
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
});
export type TriageMetrics = z.infer<typeof triageMetricsSchema>;
