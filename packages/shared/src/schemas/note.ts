import { z } from "zod";

// ─── Notes inbox (Campaign C1) ────────────────────────────────────
// Foundation for the notes inbox: a lightweight capture surface for bugs,
// questions, ideas, tech debt, and observations that an agent or human
// jots down mid-flow without committing to a full proposal/task. C1 shipped
// the schema + capture; campaign C2 lands the triage read-shape fields
// (triagedAt/triagedBy/triageOutcome/triageReason/promoted*) on noteSchema.
// These are server-driven (P2 dismiss / P3-P4 promote), never client-set.
//
// Field names mirror the eventual Drizzle camelCase property names (P2 will
// add the `notes` table to packages/server/src/db/schema.ts). Zod-3, no
// .openapi(); bare z.string() for ids/timestamps (claim-lease precedent).

// ─── Enums ────────────────────────────────────────────────────────
// The classification of a note. Plain text in the DB (notes.kind),
// validated against this enum.
export const NOTE_KINDS = ["bug", "question", "idea", "tech_debt", "wtf", "observation"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

// Lifecycle status. C1 only captures (open) and acknowledges a triaged
// terminal — the actual triage transition is C2. Stays exactly
// ["open","triaged"]; no triage-outcome values leak in here.
export const NOTE_STATUSES = ["open", "triaged"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

// What a note can be anchored to. NO "none" value — a null anchorType is
// the single encoding for "no anchor".
export const NOTE_ANCHOR_TYPES = ["task", "epic", "proposal"] as const;
export type NoteAnchorType = (typeof NOTE_ANCHOR_TYPES)[number];

// Optional severity hint (most meaningful for bug/tech_debt).
export const NOTE_SEVERITIES = ["low", "medium", "high"] as const;
export type NoteSeverity = (typeof NOTE_SEVERITIES)[number];

// ─── Triage outcomes (Campaign C2) ────────────────────────────────
// Terminal disposition of a triaged note; distinct from NOTE_STATUSES.
// Server-driven (P2 dismiss / P3-P4 promote), never client-set.
export const NOTE_TRIAGE_OUTCOMES = ["promoted", "dismissed"] as const;
export type NoteTriageOutcome = (typeof NOTE_TRIAGE_OUTCOMES)[number];

// ─── CodeLocator ──────────────────────────────────────────────────
// An optional pointer into the codebase a note refers to.
export const codeLocatorSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  commitSha: z.string().optional(),
});
export type CodeLocator = z.infer<typeof codeLocatorSchema>;

// ─── Anchor / promoted-target enrichment ref (Campaign C4) ────────
// Server-derived truth about a note's anchor or promoted target:
// `exists` is whether the referenced entity still exists; `title` is its
// current human-readable handle (task.title / epic.name / proposal.title),
// null when the target is gone. Optional on the wire — absent on
// non-enriched responses (create/patch), so old servers / mid-rollout
// clients keep working (additive).
export const noteAnchorRefSchema = z.object({
  exists: z.boolean(),
  title: z.string().nullable(),
});
export type NoteAnchorRef = z.infer<typeof noteAnchorRefSchema>;

// ─── View shape ───────────────────────────────────────────────────
// Full GET response shape for a notes row. Field names mirror the Drizzle
// TS property names (camelCase) that P2 will add. body/anchorType/anchorId/
// codeLocator/severity are nullable; title is NOT NULL (a note needs a
// one-line handle). anchorType null ⇔ no anchor (single encoding).
export const noteSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(NOTE_KINDS),
  status: z.enum(NOTE_STATUSES),
  title: z.string().min(1),
  body: z.string().nullable(),
  anchorType: z.enum(NOTE_ANCHOR_TYPES).nullable(),
  anchorId: z.string().nullable(),
  codeLocator: codeLocatorSchema.nullable(),
  severity: z.enum(NOTE_SEVERITIES).nullable(),
  authorId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // ─── Triage metadata (Campaign C2) — server-driven, all null until triaged.
  triagedAt: z.string().nullable(),
  triagedBy: z.string().nullable(),
  triageOutcome: z.enum(NOTE_TRIAGE_OUTCOMES).nullable(),
  triageReason: z.string().nullable(),
  promotedProposalId: z.string().nullable(),
  promotedTaskId: z.string().nullable(),
  // ─── Enrichment (Campaign C4) — server-derived, list/get only.
  // Optional: absent on non-enriched responses (create/patch). null ⇔ no
  // anchor / not promoted; { exists: false } ⇔ the target was deleted.
  anchor: noteAnchorRefSchema.nullable().optional(),
  promotedTarget: noteAnchorRefSchema.nullable().optional(),
});
export type Note = z.infer<typeof noteSchema>;

// ─── DTOs ─────────────────────────────────────────────────────────
// Create body. Omits id/projectId/status/authorId/createdAt/updatedAt —
// all server/auth/URL-derived (status defaults "open" server-side).
export const createNoteSchema = z.object({
  kind: z.enum(NOTE_KINDS),
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  anchorType: z.enum(NOTE_ANCHOR_TYPES).nullable().optional(),
  anchorId: z.string().nullable().optional(),
  codeLocator: codeLocatorSchema.nullable().optional(),
  severity: z.enum(NOTE_SEVERITIES).nullable().optional(),
});
export type CreateNote = z.infer<typeof createNoteSchema>;

// List/filter query.
export const listNotesSchema = z.object({
  kind: z.enum(NOTE_KINDS).optional(),
  status: z.enum(NOTE_STATUSES).optional(),
  anchorType: z.enum(NOTE_ANCHOR_TYPES).optional(),
  anchorId: z.string().optional(),
  severity: z.enum(NOTE_SEVERITIES).optional(),
});
export type ListNotesQuery = z.infer<typeof listNotesSchema>;

// Patch body. NO `status` field — status is read-only in C1 (the
// open→triaged transition + its metadata is campaign C2). title keeps
// .min(1) so an explicit empty title is rejected even in the partial.
export const patchNoteSchema = z
  .object({
    kind: z.enum(NOTE_KINDS),
    title: z.string().min(1),
    body: z.string().nullable(),
    anchorType: z.enum(NOTE_ANCHOR_TYPES).nullable(),
    anchorId: z.string().nullable(),
    codeLocator: codeLocatorSchema.nullable(),
    severity: z.enum(NOTE_SEVERITIES).nullable(),
  })
  .partial();
export type PatchNote = z.infer<typeof patchNoteSchema>;
