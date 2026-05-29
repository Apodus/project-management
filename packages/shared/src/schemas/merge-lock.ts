import { z } from "zod";

// ─── Acquire ──────────────────────────────────────────────────────

export const MERGE_LOCK_ACQUIRE_STATUSES = [
  "held",
  "queued",
  "already_held",
] as const;
export type MergeLockAcquireStatus =
  (typeof MERGE_LOCK_ACQUIRE_STATUSES)[number];

export const mergeLockAcquireResultSchema = z.object({
  ok: z.boolean(),
  status: z.enum(MERGE_LOCK_ACQUIRE_STATUSES),
  position: z.number().int().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
});
export type MergeLockAcquireResult = z.infer<
  typeof mergeLockAcquireResultSchema
>;

// ─── Heartbeat ────────────────────────────────────────────────────

export const MERGE_LOCK_HEARTBEAT_STATUSES = [
  "refreshed",
  "not_holder",
] as const;
export type MergeLockHeartbeatStatus =
  (typeof MERGE_LOCK_HEARTBEAT_STATUSES)[number];

export const mergeLockHeartbeatResultSchema = z.object({
  ok: z.boolean(),
  status: z.enum(MERGE_LOCK_HEARTBEAT_STATUSES),
  expiresAt: z.string().nullable().optional(),
});
export type MergeLockHeartbeatResult = z.infer<
  typeof mergeLockHeartbeatResultSchema
>;

// ─── Release ──────────────────────────────────────────────────────

export const MERGE_LOCK_RELEASE_STATUSES = [
  "released",
  "not_held",
  "not_holder",
] as const;
export type MergeLockReleaseStatus =
  (typeof MERGE_LOCK_RELEASE_STATUSES)[number];

export const mergeLockReleaseResultSchema = z.object({
  ok: z.boolean(),
  status: z.enum(MERGE_LOCK_RELEASE_STATUSES),
  grantedTo: z.string().nullable().optional(),
});
export type MergeLockReleaseResult = z.infer<
  typeof mergeLockReleaseResultSchema
>;

// ─── Landing intent ───────────────────────────────────────────────
// What the holder (or queued waiter) is trying to land. All fields are
// optional. The first four generalize across machines; worktreePath is
// per-host but useful when agents share a host.

export const mergeLockLandingIntentSchema = z.object({
  taskId: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  verifyCmd: z.string().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
});
export type MergeLockLandingIntent = z.infer<
  typeof mergeLockLandingIntentSchema
>;

// ─── Lock view ────────────────────────────────────────────────────
// The state returned by GET endpoints. Identity of the holder is
// surfaced as a relative flag so we don't leak other agents' IDs.

export const mergeLockHolderViewSchema = z.enum([
  "you",
  "someone_else",
  "none",
]);
export type MergeLockHolderView = z.infer<typeof mergeLockHolderViewSchema>;

export const mergeLockSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  resource: z.string(),
  holder: mergeLockHolderViewSchema,
  holderId: z.string().nullable(),
  acquiredAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  landedSha: z.string().nullable(),
  landedAt: z.string().nullable(),
  // Landing intent surfaced for observability. Null when no holder.
  taskId: z.string().nullable(),
  branch: z.string().nullable(),
  commitSha: z.string().nullable(),
  verifyCmd: z.string().nullable(),
  worktreePath: z.string().nullable(),
  // Last abandon reason — preserved across the abandon → next-acquire
  // gap so the next queue head can see why main hasn't moved.
  abandonReason: z.string().nullable(),
  queueLength: z.number().int(),
  yourPosition: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MergeLockView = z.infer<typeof mergeLockSchema>;

// ─── Resource name validation ─────────────────────────────────────
// Resource names are URL path segments. We restrict to a kebab-style
// slug to avoid path-traversal and ambiguity in OpenAPI.
export const MERGE_LOCK_RESOURCE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,62}$/;
