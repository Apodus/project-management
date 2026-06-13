import { z } from "zod";
import { codeLocatorSchema } from "./note.js";

// ─── Escalation channel (Campaign C1) ─────────────────────────────
// A bidirectional cross-team escalation channel: a worker raises a
// bug_report/question/request/blocked against a project; a human (or
// another worker) holds, acknowledges, answers, and resolves it through
// an append-only message thread. P1 shipped the `escalations` +
// `escalation_messages` tables (migration 0029); this module is the
// @pm/shared schema (enums/view/DTOs) consumed by the P2 service.
//
// Field names mirror the Drizzle camelCase property names. Zod-3, no
// .openapi(); bare z.string() for ids/timestamps (note.ts / claim-lease
// precedent). `codeLocatorSchema` + `CodeLocator` are REUSED from
// ./note.js — not redefined.

// ─── Enums ────────────────────────────────────────────────────────
// The classification of an escalation. Plain text in the DB
// (escalations.kind), validated against this enum.
export const ESCALATION_KINDS = ["bug_report", "question", "request", "blocked"] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

// Lifecycle status. open → acknowledged → answered → resolved, with
// needs_human as a side-channel reachable from any non-terminal state.
export const ESCALATION_STATUSES = [
  "open",
  "acknowledged",
  "answered",
  "resolved",
  "needs_human",
] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

// Optional severity hint.
export const ESCALATION_SEVERITIES = ["low", "medium", "high"] as const;
export type EscalationSeverity = (typeof ESCALATION_SEVERITIES)[number];

// What an escalation can be anchored to. NO "none" value — a null
// anchorType is the single encoding for "no anchor".
export const ESCALATION_ANCHOR_TYPES = ["task", "epic", "proposal"] as const;
export type EscalationAnchorType = (typeof ESCALATION_ANCHOR_TYPES)[number];

// The classification of a thread message. Plain text in the DB
// (escalation_messages.message_type), validated against this enum.
export const ESCALATION_MESSAGE_TYPES = ["reply", "diagnosis", "instruction", "system"] as const;
export type EscalationMessageType = (typeof ESCALATION_MESSAGE_TYPES)[number];

// ─── View shapes ──────────────────────────────────────────────────
// Full GET response shape for an escalations row. Field names mirror the
// Drizzle TS property names (camelCase). severity/body/codeLocator/
// anchorType/anchorId/holderId/resolvedAt/resolvedBy are nullable; title
// is NOT NULL (an escalation needs a one-line handle). anchorType null ⇔
// no anchor (single encoding).
export const escalationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(ESCALATION_KINDS),
  status: z.enum(ESCALATION_STATUSES),
  severity: z.enum(ESCALATION_SEVERITIES).nullable(),
  title: z.string().min(1),
  body: z.string().nullable(),
  codeLocator: codeLocatorSchema.nullable(),
  anchorType: z.enum(ESCALATION_ANCHOR_TYPES).nullable(),
  anchorId: z.string().nullable(),
  originRepo: z.string(),
  originWorkerKey: z.string(),
  holderId: z.string().nullable(),
  authorId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
});
export type Escalation = z.infer<typeof escalationSchema>;

// A single append-only thread message under an escalation. seq is a
// 1-based, per-thread monotonic counter (UNIQUE(escalationId, seq) seals
// it). messageType/metadata are nullable.
export const escalationMessageSchema = z.object({
  id: z.string(),
  escalationId: z.string(),
  seq: z.number().int().nonnegative(),
  authorId: z.string(),
  body: z.string().min(1),
  messageType: z.enum(ESCALATION_MESSAGE_TYPES).nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
});
export type EscalationMessage = z.infer<typeof escalationMessageSchema>;

// Escalation + its full ordered thread (getById shape).
export const escalationWithThreadSchema = escalationSchema.extend({
  messages: z.array(escalationMessageSchema),
});
export type EscalationWithThread = z.infer<typeof escalationWithThreadSchema>;

// ─── DTOs ─────────────────────────────────────────────────────────
// Create body. Omits id/projectId/status/authorId/holderId/createdAt/
// updatedAt/resolvedAt/resolvedBy — all server/auth/URL-derived (status
// defaults "open" server-side). originRepo + originWorkerKey are REQUIRED
// (the cross-team provenance).
export const createEscalationSchema = z.object({
  kind: z.enum(ESCALATION_KINDS),
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  severity: z.enum(ESCALATION_SEVERITIES).nullable().optional(),
  codeLocator: codeLocatorSchema.nullable().optional(),
  anchorType: z.enum(ESCALATION_ANCHOR_TYPES).nullable().optional(),
  anchorId: z.string().nullable().optional(),
  originRepo: z.string().min(1),
  originWorkerKey: z.string().min(1),
});
export type CreateEscalation = z.infer<typeof createEscalationSchema>;

// Add a message (reply/diagnosis/instruction) to a thread. messageType is
// optional (the service classifies system messages itself).
export const createMessageSchema = z.object({
  body: z.string().min(1),
  messageType: z.enum(ESCALATION_MESSAGE_TYPES).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateEscalationMessage = z.infer<typeof createMessageSchema>;

// List/filter query — all optional.
export const listEscalationsQuerySchema = z.object({
  status: z.enum(ESCALATION_STATUSES).optional(),
  kind: z.enum(ESCALATION_KINDS).optional(),
  severity: z.enum(ESCALATION_SEVERITIES).optional(),
  originRepo: z.string().optional(),
  originWorkerKey: z.string().optional(),
  holderId: z.string().optional(),
});
export type ListEscalationsQuery = z.infer<typeof listEscalationsQuerySchema>;

// Answer body — an optional diagnosis message accompanies the
// acknowledged→answered transition.
export const answerEscalationSchema = z.object({
  body: z.string().optional(),
});
export type AnswerEscalation = z.infer<typeof answerEscalationSchema>;

// Resolve body — a reason is REQUIRED (recorded as a system message).
export const resolveEscalationSchema = z.object({
  reason: z.string().min(1),
});
export type ResolveEscalation = z.infer<typeof resolveEscalationSchema>;

// Escalate-to-human body — a reason is REQUIRED (recorded as a system
// message).
export const escalateToHumanSchema = z.object({
  reason: z.string().min(1),
});
export type EscalateToHuman = z.infer<typeof escalateToHumanSchema>;

// ─── C2 §P1: delivery cursor ──────────────────────────────────────
// An undelivered escalation: the escalation + the unread directed
// replies (non-origin-authored, seq > the origin's read cursor) +
// their count. Surfaced to the origin worker by listUndeliveredForWorker.
export const undeliveredEscalationSchema = z.object({
  escalation: escalationSchema,
  unreadMessages: z.array(escalationMessageSchema),
  unreadCount: z.number().int().nonnegative(),
});
export type UndeliveredEscalation = z.infer<typeof undeliveredEscalationSchema>;

// Query for the origin worker's undelivered escalations — workerKey is
// REQUIRED (the delivery identity), projectId optionally scopes it.
export const undeliveredQuerySchema = z.object({
  workerKey: z.string().min(1),
  projectId: z.string().optional(),
});
export type UndeliveredQuery = z.infer<typeof undeliveredQuerySchema>;

// Advance the delivery cursor — workerKey gates it (must match the
// escalation's originWorkerKey), uptoSeq is the watermark to advance to
// (forward-only, never decreases).
export const markDeliveredSchema = z.object({
  workerKey: z.string().min(1),
  uptoSeq: z.number().int().nonnegative(),
});
export type MarkDelivered = z.infer<typeof markDeliveredSchema>;
