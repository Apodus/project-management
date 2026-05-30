import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────
// The audit action taxonomy (design §2.3). The five break-glass overrides
// plus the two natural integrator actions are the complete set. This is the
// CANONICAL home (Step 8 hoist) — audit.service.ts re-exports these for
// back-compat. Copied byte-for-byte (same order) from the prior local defs;
// the DB column is plain `text` validated against this enum, so adding a
// future action means editing this one array (no migration).
export const AUDIT_ACTIONS = [
  // ── Break-glass overrides (HUMAN operator actions, §4) ──
  "pause",
  "resume",
  "force_release_lock",
  "force_land",
  "force_reject",
  // ── Natural train actions (ai_agent integrator actions, §2.5) ──
  "land",
  "reject",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// What the action targeted. "train" targets carry targetId = the resource name
// (e.g. "main"); the others carry a row id.
export const AUDIT_TARGET_TYPES = [
  "merge_request",
  "merge_group",
  "merge_lock",
  "train",
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

// ─── View shapes ──────────────────────────────────────────────────
// Full GET response shape for an audit_log row (design §2.4). Field names
// mirror the Drizzle TS property names (camelCase) from
// packages/server/src/db/schema.ts §auditLog. `action`/`targetType` are
// validated against the enums above. There is deliberately no `updatedAt` —
// the audit log is append-only.
export const auditLogSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  actorId: z.string(),
  action: z.enum(AUDIT_ACTIONS),
  targetType: z.enum(AUDIT_TARGET_TYPES),
  targetId: z.string(),
  reason: z.string().nullable(),
  metadataBefore: z.record(z.string(), z.unknown()).nullable(),
  metadataAfter: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});
export type AuditLogView = z.infer<typeof auditLogSchema>;
