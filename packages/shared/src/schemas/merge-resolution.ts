import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────
// State of a merge resolution attempt. First element ("pending") matches
// the merge_resolutions.state column default in
// packages/server/src/db/schema.ts. Resolution state machine lives in
// docs/design/phase-7.6-design.md §4.3:
//   pending → resolving → resolved | escalated | failed
//
//   resolved   — the resolver produced a clean, locally-verified,
//                resubmitted change (resolved_request_id set; it now rides
//                the train and must still pass the real verify gate).
//   escalated  — verify-fail / budget / unresolvable → author, then human.
//   failed     — infra error (worktree/spawn/PM I/O); escalates too, but
//                tagged distinctly so operators can tell "model couldn't"
//                from "the resolver itself broke".
export const MERGE_RESOLUTION_STATES = [
  "pending",
  "resolving",
  "resolved",
  "escalated",
  "failed",
] as const;
export type MergeResolutionState = (typeof MERGE_RESOLUTION_STATES)[number];

// Where an escalated/failed resolution is routed. `author` hands the
// conflict back to the original submitter; `human` escalates to an operator.
// Null on a pending/resolving/resolved row (no escalation occurred).
export const MERGE_ESCALATION_TARGETS = ["author", "human"] as const;
export type MergeEscalationTarget = (typeof MERGE_ESCALATION_TARGETS)[number];

// ─── Detail ───────────────────────────────────────────────────────
// Structured detail payload stored on merge_resolutions.detail (JSON
// column). Null until the resolver runs. Records the resolver's resource
// consumption, the local verify verdict, the escalation reason, and a
// pointer to the full resolver log.
export const mergeResolutionDetailSchema = z.object({
  budgetConsumedSec: z.number().optional(),
  tokensConsumed: z.number().optional(),
  verifyVerdict: z.enum(["pass", "fail"]).optional(),
  escalationReason: z.string().optional(),
  logUrl: z.string().optional(),
});
export type MergeResolutionDetail = z.infer<typeof mergeResolutionDetailSchema>;

// ─── View shapes ──────────────────────────────────────────────────
// Full GET response shape for a merge_resolutions row. Field names mirror
// the Drizzle TS property names (camelCase) from
// packages/server/src/db/schema.ts §mergeResolutions.
export const mergeResolutionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  resource: z.string(),
  originRequestId: z.string().nullable(),
  resolvedRequestId: z.string().nullable(),
  state: z.enum(MERGE_RESOLUTION_STATES),
  conflictingFiles: z.array(z.string()).nullable(),
  attemptStartedAt: z.string().nullable(),
  attemptEndedAt: z.string().nullable(),
  escalationTarget: z.enum(MERGE_ESCALATION_TARGETS).nullable(),
  detail: mergeResolutionDetailSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MergeResolutionView = z.infer<typeof mergeResolutionSchema>;
