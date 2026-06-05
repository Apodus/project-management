import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────
// The audit action taxonomy (design §2.3). The break-glass overrides plus the
// two natural integrator actions are the complete set. This is the CANONICAL
// home (Step 8 hoist) — audit.service.ts re-exports these for back-compat. The
// DB column is plain `text` validated against this enum, so adding a future
// action means editing this one array (no migration).
export const AUDIT_ACTIONS = [
  // ── Break-glass overrides (HUMAN operator actions, §4) ──
  "pause",
  "resume",
  "force_release_lock",
  "force_land",
  "force_reject",
  // force_cancel: admin abandon of a stuck queued|integrating request (the
  // queued-state escape hatch force_reject/force_land cannot reach).
  "force_cancel",
  // ── Natural train actions (ai_agent integrator actions, §2.5) ──
  "land",
  "reject",
  // cancel: self-service abandon of a queued|integrating request by ANY
  // authenticated user (collaborative env — no ownership gate). The
  // queued path is non-audited (back-compat); the integrating path writes
  // this audit row (no `overridden` flag — that distinguishes it from the
  // admin break-glass `force_cancel`).
  "cancel",
  // ── Force-claim (reason-required claim takeover) ──
  "force_claim",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// What the action targeted. "train" targets carry targetId = the resource name
// (e.g. "main"); the others carry a row id.
export const AUDIT_TARGET_TYPES = [
  "merge_request",
  "merge_group",
  "merge_lock",
  "train",
  // ── Force-claim targets (claim takeover) ──
  "task",
  "epic",
  "proposal",
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
