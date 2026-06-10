import { z } from "zod";
import { verifyStepResultSchema } from "./verify.js";

// ─── Enums ────────────────────────────────────────────────────────
// Status of a merge request through its full lifecycle. First element
// ("queued") matches the merge_requests.status column default in
// packages/server/src/db/schema.ts. Lifecycle state machine lives in
// docs/design/phase-7.1-design.md §5.1.
// "orphaned" is the Phase-7.3 grouped-inner outcome: the inner request
// landed on its remote but the group-land did not complete, so its commit
// is orphaned relative to the outer gitlink (docs/design/phase-7.3-design.md
// §3.4).
export const MERGE_REQUEST_STATUSES = [
  "queued",
  "integrating",
  "landed",
  "rejected",
  "abandoned",
  "orphaned",
] as const;
export type MergeRequestStatus = (typeof MERGE_REQUEST_STATUSES)[number];

// Status of a single rebase+verify cycle. A request can have many
// attempts; only the final attempt's outcome typically drives the
// request resolution (see §5.2).
export const MERGE_ATTEMPT_STATUSES = [
  "pending",
  "running",
  "passed",
  "failed",
  "cancelled",
] as const;
export type MergeAttemptStatus = (typeof MERGE_ATTEMPT_STATUSES)[number];

// Categorized failure reason. Same value-space everywhere:
//   merge_requests.rejectCategory
//   merge_attempts.failureCategory
//   SSE event payloads
//   merge_rejection auto-comment metadata
export const MERGE_REJECT_CATEGORIES = [
  "conflict",
  "build_failed",
  "test_failed",
  "lint_failed",
  "verify_timeout",
  "policy",
  "other",
] as const;
export type MergeRejectCategory = (typeof MERGE_REJECT_CATEGORIES)[number];

// ─── View shapes ──────────────────────────────────────────────────
// Full GET response shape for a merge_request row. Field names mirror
// the Drizzle TS property names (camelCase) from
// packages/server/src/db/schema.ts §mergeRequests.
export const mergeRequestSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  resource: z.string(),
  submittedBy: z.string(),
  taskId: z.string().nullable(),
  // Phase 7.6 lineage: on a resolved request this holds the origin request
  // id; null on every normal request (docs/design/phase-7.6-design.md §4.1).
  resolvedFrom: z.string().nullable(),
  // Inner-only groups (campaign 2026-06-10): true on the server-minted outer
  // member of a synthesizeOuter group — born with no branch/commit; the
  // integrator synthesizes the outer candidate at assembly. false elsewhere.
  synthetic: z.boolean(),
  branch: z.string().nullable(),
  commitSha: z.string().nullable(),
  verifyCmd: z.string().nullable(),
  worktreePath: z.string().nullable(),
  status: z.enum(MERGE_REQUEST_STATUSES),
  enqueuedAt: z.string(),
  pickedUpAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  landedSha: z.string().nullable(),
  rejectCategory: z.enum(MERGE_REJECT_CATEGORIES).nullable(),
  rejectReason: z.string().nullable(),
  failedFiles: z.array(z.string()).nullable(),
  logExcerpt: z.string().nullable(),
  logUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MergeRequestView = z.infer<typeof mergeRequestSchema>;

// Full view shape for a merge_attempts row.
export const mergeAttemptSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  attemptNumber: z.number().int(),
  baseSha: z.string(),
  treeSha: z.string().nullable(),
  status: z.enum(MERGE_ATTEMPT_STATUSES),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  verifyDurationMs: z.number().int().nullable(),
  failureCategory: z.enum(MERGE_REJECT_CATEGORIES).nullable(),
  failureReason: z.string().nullable(),
  failedFiles: z.array(z.string()).nullable(),
  logExcerpt: z.string().nullable(),
  logUrl: z.string().nullable(),
  steps: z.array(verifyStepResultSchema).nullable().optional(),
  createdAt: z.string(),
});
export type MergeAttemptView = z.infer<typeof mergeAttemptSchema>;

// ─── Request bodies ───────────────────────────────────────────────
// Body for POST /api/v1/projects/{projectId}/merge-requests
// (also the body of pm_request_merge MCP tool).
// submittedBy comes from auth; projectId comes from the URL.
// `resource` defaults to "main" — matches the DB column default.
export const mergeRequestSubmitSchema = z.object({
  resource: z.string().min(1).default("main"),
  taskId: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  verifyCmd: z.string().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
});
export type MergeRequestSubmit = z.infer<typeof mergeRequestSubmitSchema>;

// Body for POST /api/v1/merge-requests/{id}/cancel (any authenticated user).
// `reason` is optional (back-compat: pre-existing callers send no body). When
// supplied on an integrating-cancel it is persisted on the `cancel` audit row;
// on a queued-cancel it rides only on the emitted event.
export const mergeRequestCancelSchema = z.object({
  reason: z.string().min(1).max(2048).optional(),
});
export type MergeRequestCancel = z.infer<typeof mergeRequestCancelSchema>;

// Body for POST /api/v1/merge-requests/{id}/reject (integrator).
// `failedFiles`, `logExcerpt`, `logUrl` are optional at the schema layer.
// Integrator policy (Step 5) requires at least one log field in practice.
export const mergeRequestRejectSchema = z.object({
  category: z.enum(MERGE_REJECT_CATEGORIES),
  reason: z.string().min(1),
  failedFiles: z.array(z.string()).optional(),
  logExcerpt: z.string().optional(),
  logUrl: z.string().optional(),
});
export type MergeRequestReject = z.infer<typeof mergeRequestRejectSchema>;

// Body for POST /api/v1/merge-requests/{id}/land (integrator).
export const mergeRequestLandSchema = z.object({
  landedSha: z.string().min(1),
});
export type MergeRequestLand = z.infer<typeof mergeRequestLandSchema>;

// Body for POST /api/v1/merge-requests/{id}/attempts (integrator).
export const mergeAttemptStartSchema = z.object({
  baseSha: z.string().min(1),
});
export type MergeAttemptStart = z.infer<typeof mergeAttemptStartSchema>;

// Body for PATCH /api/v1/merge-attempts/{id} (integrator).
// Discriminated on status:
//   "passed"    requires treeSha; no failure fields.
//   "failed"    requires failureCategory + failureReason; optional log/files.
//   "cancelled" no required fields beyond status.
export const mergeAttemptCompleteSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("passed"),
    treeSha: z.string().min(1),
    steps: z.array(verifyStepResultSchema).optional(),
  }),
  z.object({
    status: z.literal("failed"),
    failureCategory: z.enum(MERGE_REJECT_CATEGORIES),
    failureReason: z.string().min(1),
    failedFiles: z.array(z.string()).optional(),
    logExcerpt: z.string().optional(),
    logUrl: z.string().optional(),
    steps: z.array(verifyStepResultSchema).optional(),
  }),
  z.object({
    status: z.literal("cancelled"),
  }),
]);
export type MergeAttemptComplete = z.infer<typeof mergeAttemptCompleteSchema>;
