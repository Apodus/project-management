import { z } from "zod";
import {
  MERGE_PHASES,
  MERGE_PHASES_DERIVED,
  MERGE_PHASES_OBSERVED,
  MERGE_PHASE_BASES,
} from "../constants/enums.js";

// ═══════════════════════════════════════════════════════════════════
// Train phase-timing wire schemas (campaign 2026-08-03 §P1).
//
// One row per COMPLETED phase of a merge request's trip through the train, plus
// the two phases PM derives on read (see constants/enums.ts for the partition
// and why it is the anti-double-count invariant).
//
// View convention mirrors verify.ts / observability.ts: z.string() ids + ISO
// timestamps, .nullable() for null-until-set columns, camelCase on the wire. The
// server routes carry structurally-identical Zod-4 mirrors — never import these
// Zod-3 schemas into a route.
//
// The ingest schema is deliberately STRICT about identity/shape (phase name,
// timestamp format, id shape → 400) and LENIENT about values (duration, label,
// detail → normalized server-side, never a 400). Rationale: design lock 1 —
// telemetry is never load-bearing, so a fat label or a skewed clock must never
// fail the POST that measures a merge. A wrong phase NAME, by contrast, would
// corrupt the aggregate, so it fails loudly at the wire.
// ═══════════════════════════════════════════════════════════════════

// ─── Ingest (integrator → PM) ─────────────────────────────────────

/**
 * One observed phase the integrator completed. `recordedBy` is deliberately
 * ABSENT: the server assigns it from the authenticated session, so spoofing the
 * recorder is not expressible on the wire.
 */
export const mergePhaseEntryInputSchema = z.object({
  // STRICT — identity and shape. A derived phase name (`queue_wait`/`forming`)
  // is not in this enum and therefore 400s: PM already computes those.
  phase: z.enum(MERGE_PHASES_OBSERVED),
  startedAt: z.string().datetime(),
  requestId: z.string().min(1).optional(),
  groupId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  // LENIENT — values. Clamped / truncated / dropped server-side, each such
  // normalization counted in `adjusted` rather than rejected.
  durationMs: z.number(),
  label: z.string().nullable().optional(),
  detail: z.record(z.unknown()).nullable().optional(),
});
export type MergePhaseEntryInput = z.infer<typeof mergePhaseEntryInputSchema>;

/** A batch of completed phases for one lane. */
export const mergePhaseIngestSchema = z.object({
  resource: z.string().min(1).default("main"),
  phases: z.array(mergePhaseEntryInputSchema).min(1).max(100),
});
export type MergePhaseIngest = z.infer<typeof mergePhaseIngestSchema>;

/**
 * The ingest ack. `adjusted` counts rows whose VALUES were normalized (duration
 * clamped, label truncated, detail dropped, or a dangling/cross-project id
 * nulled) — a row normalized twice still counts once. It is the signal that the
 * emitter is wrong: a healthy integrator reports `adjusted: 0` forever.
 */
export const mergePhaseIngestResultSchema = z.object({
  recorded: z.number(),
  adjusted: z.number(),
});
export type MergePhaseIngestResult = z.infer<typeof mergePhaseIngestResultSchema>;

// ─── Read views ───────────────────────────────────────────────────

/**
 * A STORED phase row (merge_phase_timings). `derived: false` is the union
 * discriminator, so a reader can never mistake a recorded observation for a
 * computed one — and only stored rows carry an `id`.
 */
export const mergePhaseRowSchema = z.object({
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
  detail: z.record(z.unknown()).nullable(),
  recordedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type MergePhaseRowView = z.infer<typeof mergePhaseRowSchema>;

/**
 * A DERIVED phase entry — computed on read, never stored, so it has NO `id`
 * (there is no row to address) and no `attemptId`/`recordedBy`.
 *
 * Two durations + a discriminator, per design lock 4 (pre-computed only):
 * - `durationMs` is the honest LAST queue segment (what P3 aggregates),
 * - `originDurationMs` is the total since submit / group creation (what P5/P6
 *   render as "waiting since"),
 * - `basis` says whether they differ because a prior integration ended inside
 *   the window (`requeued`) or not (`exact`).
 */
export const derivedPhaseEntrySchema = z.object({
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
});
export type DerivedPhaseEntry = z.infer<typeof derivedPhaseEntrySchema>;

/** The per-request / per-group trace element: a stored row OR a derived entry. */
export const phaseTraceEntrySchema = z.discriminatedUnion("derived", [
  mergePhaseRowSchema,
  derivedPhaseEntrySchema,
]);
export type PhaseTraceEntry = z.infer<typeof phaseTraceEntrySchema>;

/**
 * The minimal projection the aggregation (P3) consumes: enough to bucket by
 * phase and percentile the durations, nothing more. Stored and derived samples
 * share this shape (and are disjoint by `phase`), so P3 concatenates the two
 * sources instead of hand-rolling SQL over merge_requests.
 */
export const mergePhaseSampleSchema = z.object({
  phase: z.enum(MERGE_PHASES),
  durationMs: z.number(),
  startedAt: z.string(),
  requestId: z.string().nullable(),
  groupId: z.string().nullable(),
});
export type MergePhaseSample = z.infer<typeof mergePhaseSampleSchema>;
