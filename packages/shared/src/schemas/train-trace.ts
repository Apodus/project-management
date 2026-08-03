import { z } from "zod";
import {
  MERGE_PHASES,
  TRAIN_TRACE_KINDS,
  TRAIN_TRACE_SOURCES,
  TRAIN_TRACE_SUBJECT_TYPES,
} from "../constants/enums.js";

// ═══════════════════════════════════════════════════════════════════
// Train event-trace wire schema (campaign 2026-08-03 §P5).
//
// ONE row type for a feed merged from three producers — the phase-timing store
// (P1), the audit log, and the entity tables themselves. A reader of the feed
// must never need to know which of the three an entry came from, so everything
// that differs between them is normalized here rather than in a renderer.
//
// View convention mirrors merge-phase.ts: camelCase on the wire, ISO instants,
// `.nullable()` (never `.optional()`) for "this entry has no such fact" — a
// producer that has nothing to say must SAY null, so "absent" and "forgotten"
// can never be the same value. The server route carries a structurally
// identical Zod-4 mirror; never import these Zod-3 schemas into a route.
// ═══════════════════════════════════════════════════════════════════

// ─── elapsed: a number that always says what it measured ──────────

/**
 * THE point of this file. `elapsed` is a UNION with a literal `basis`, not a
 * bare `ms`, because the numbers this feed can attach to an event mean
 * different things and printing the wrong sentence over one of them is the
 * exact dishonesty the campaign exists to remove:
 *
 *  - `phase`        — the entry IS that interval. "took 26m".
 *  - `queue_wait`   — the request sat in the lane queue this long before pickup.
 *                     `ms` is the LAST queue segment and `sinceSubmitMs` the
 *                     total since submit; when `requeued` they differ, because a
 *                     re-queue nulls picked_up_at while enqueued_at stands and
 *                     the naive subtraction charges a whole prior 39-minute
 *                     verify to "queue wait". ALWAYS from deriveQueueWait.
 *  - `forming`      — the group-shaped twin of queue_wait: creation (or the end
 *                     of a prior integration) → the OLDEST member pickup.
 *                     `sinceSubmitMs` is measured from group creation.
 *  - `since_pickup` — an INSTANT that happened `ms` after its trip started. It
 *                     is not a duration of anything the entry did, so it renders
 *                     "42m after pickup" and never "took 42m". Two timestamps PM
 *                     already stores; the Discord feed prints the same fact.
 *  - `none`         — an instant with NO anchor (a pause, a mid-trip requeue, an
 *                     incident). It carries no `ms` AT ALL, so "no duration" is
 *                     unrepresentable as a zero.
 *
 * WHY `none` RATHER THAN A NULLABLE FIELD — the shape this design first reached
 * for, and a generator scar of the same family as the boolean discriminator P4
 * hit. `.nullable()` on a Zod UNION emits an OAS-3.0 `anyOf` whose last branch
 * is the bare `{ "nullable": true }`, and openapi-typescript renders that branch
 * as `unknown`; `A | B | C | D | unknown` IS `unknown`, so the whole union
 * collapses and the exhaustive `never` this file exists to enable silently stops
 * compiling anything. Naming the union does not help — the nullable branch is
 * folded into the NAMED schema, corrupting it for every consumer.
 * The explicit member is also the stronger contract: "no anchored duration"
 * becomes a case the exhaustive switch MUST handle rather than a null a renderer
 * must remember to check before switching.
 */
export const trainTracePhaseElapsedSchema = z.object({
  basis: z.literal("phase"),
  ms: z.number(),
});

const derivedWaitFields = {
  ms: z.number(),
  sinceSubmitMs: z.number(),
  requeued: z.boolean(),
};

export const trainTraceQueueWaitElapsedSchema = z.object({
  basis: z.literal("queue_wait"),
  ...derivedWaitFields,
});

export const trainTraceFormingElapsedSchema = z.object({
  basis: z.literal("forming"),
  ...derivedWaitFields,
});

export const trainTraceSincePickupElapsedSchema = z.object({
  basis: z.literal("since_pickup"),
  ms: z.number(),
});

/** No anchored duration. Deliberately carries NO `ms` field at all. */
export const trainTraceNoElapsedSchema = z.object({
  basis: z.literal("none"),
});

/**
 * A PLAIN union, matching the phaseTraceEntrySchema precedent. `basis` is a
 * string, so a `z.discriminatedUnion` would be legal OAS here (P4's scar was a
 * BOOLEAN discriminator, which is not) — but a plain union is what this repo's
 * generator is known to turn into a real TS union, and a real TS union is what
 * makes the web-side `formatElapsed` exhaustive-checkable with `never`.
 */
export const trainTraceElapsedSchema = z.union([
  trainTracePhaseElapsedSchema,
  trainTraceQueueWaitElapsedSchema,
  trainTraceFormingElapsedSchema,
  trainTraceSincePickupElapsedSchema,
  trainTraceNoElapsedSchema,
]);
export type TrainTraceElapsed = z.infer<typeof trainTraceElapsedSchema>;

// ─── The entry ────────────────────────────────────────────────────

/**
 * What the entry is about, resolved server-side. `name` is the human name — a
 * request's task title, else its branch, else "(removed)" — because a ULID
 * tells an operator nothing about what their train was doing. Enrichment is
 * done HERE and not in the browser: it is an N+1 join per entry, and a feed
 * merged from three arms cannot size its arms client-side anyway.
 */
export const trainTraceSubjectSchema = z.object({
  type: z.enum(TRAIN_TRACE_SUBJECT_TYPES),
  id: z.string(),
  name: z.string(),
});
export type TrainTraceSubject = z.infer<typeof trainTraceSubjectSchema>;

export const trainTraceActorSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/**
 * One entry in the lane's recent-event feed.
 *
 * `id` is COMPOSITE (`phase:<rowId>` / `audit:<rowId>` / `entity:<kind>:<id>`)
 * so two entries that share an instant across two sources can never collide as
 * React keys — the failure mode of a naive `id` here is a silently dropped row.
 *
 * `at` is when the entry HAPPENED, and for a phase entry that is its END
 * (started_at + duration_ms), not its start: P1 records a phase only once it
 * completes, so the sentence is "verify finished, took 26m". Ordering by start
 * would file a 39-minute verify above everything that happened during it.
 */
export const trainTraceEntrySchema = z.object({
  id: z.string(),
  source: z.enum(TRAIN_TRACE_SOURCES),
  kind: z.enum(TRAIN_TRACE_KINDS),
  at: z.string(),
  resource: z.string(),
  /** The phase — set iff `kind === "phase"`. */
  phase: z.enum(MERGE_PHASES).nullable(),
  /** The integrator's step label for a phase entry (null when it ran opaque). */
  label: z.string().nullable(),
  subject: trainTraceSubjectSchema,
  actor: trainTraceActorSchema.nullable(),
  /**
   * The operator's or integrator's stated reason, VERBATIM. Not redacted: the
   * per-request timeline (any authenticated user) already returns every audit
   * row's reason for the same events, so redacting here would buy no
   * confidentiality and would make two surfaces disagree about the same row.
   */
  reason: z.string().nullable(),
  /** True for the break-glass kinds — a human bypassed the normal path. */
  overridden: z.boolean(),
  /** One short discriminating fact: a landed sha, a reject category, an incident type. */
  detail: z.string().nullable(),
  /** ALWAYS present — "no duration" is `{ basis: "none" }`, never null, never 0. */
  elapsed: trainTraceElapsedSchema,
});
export type TrainTraceEntry = z.infer<typeof trainTraceEntrySchema>;
