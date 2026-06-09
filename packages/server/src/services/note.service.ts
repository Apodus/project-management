import { eq, and, desc } from "drizzle-orm";
import { createId } from "@pm/shared";
import type {
  CreateNote,
  ListNotesQuery,
  NoteKind,
  NoteStatus,
  NoteTriageOutcome,
  PatchNote,
} from "@pm/shared";
import { getDb, getRawDb, notes, projects } from "../db/index.js";
import { AppError } from "../types.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";
import { sanitizeFtsQuery } from "./search.service.js";

// ─── Notes service (Campaign C1 §P3) ──────────────────────────────
// Capture + read only. Notes are ownerless in C1 — no claim/lease logic.
// The open→triaged transition (and triage metadata) is deferred to C2; this
// service only creates open notes, reads them, and patches OPEN ones.
//
// Activity logging is NOT written here: the onAll listener
// (events/listeners.ts) maps NOTE_CREATED/NOTE_UPDATED → activity_log rows.

/**
 * Ensure a project exists, else 404. Mirrors proposal.service's project guard.
 */
function ensureProjectExists(projectId: string): void {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }
}

/**
 * Guard: only an OPEN note may be mutated or triaged. A triaged (terminal)
 * note is immutable. Shared by `update` (C1) and `applyTriage` (C2).
 */
function assertOpen(note: { id: string; status: NoteStatus }): void {
  if (note.status !== "open") {
    throw new AppError(409, "INVALID_STATUS", `Note ${note.id} is not open and cannot be edited`);
  }
}

/**
 * Create a new note (status defaults to "open"). The author is the caller —
 * never accepted from the request body.
 */
export function create(projectId: string, input: CreateNote, authorId: string) {
  ensureProjectExists(projectId);

  const db = getDb();
  const id = createId();
  const now = new Date().toISOString();

  db.insert(notes)
    .values({
      id,
      projectId,
      kind: input.kind,
      status: "open",
      title: input.title,
      body: input.body ?? null,
      anchorType: input.anchorType ?? null,
      anchorId: input.anchorId ?? null,
      codeLocator: input.codeLocator ?? null,
      severity: input.severity ?? null,
      authorId,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const row = db.select().from(notes).where(eq(notes.id, id)).get()!;

  getEventBus().emit(EVENT_NAMES.NOTE_CREATED, {
    entity: row,
    entityType: "note",
    entityId: id,
    projectId,
    actorId: authorId,
    timestamp: now,
  });

  return row;
}

/**
 * Get a single note by id. Throws 404 if not found.
 */
export function getById(id: string) {
  const db = getDb();
  const row = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Note not found: ${id}`);
  }
  return row;
}

/**
 * List notes for a project, newest first, with optional filters.
 */
export function list(projectId: string, filters: ListNotesQuery) {
  const db = getDb();
  const conditions = [eq(notes.projectId, projectId)];

  if (filters.status) conditions.push(eq(notes.status, filters.status));
  if (filters.kind) conditions.push(eq(notes.kind, filters.kind));
  if (filters.anchorType) conditions.push(eq(notes.anchorType, filters.anchorType));
  if (filters.anchorId) conditions.push(eq(notes.anchorId, filters.anchorId));
  if (filters.severity) conditions.push(eq(notes.severity, filters.severity));

  return db
    .select()
    .from(notes)
    .where(and(...conditions))
    .orderBy(desc(notes.createdAt))
    .all();
}

/**
 * Patch an OPEN note. A triaged (non-open) note is immutable in C1 — the
 * open→triaged transition + its metadata is deferred to C2. An explicit null
 * in the patch clears the field (covers kind/title/body/anchorType/anchorId/
 * codeLocator/severity); status is never patchable (no status field on PatchNote).
 */
export function update(id: string, patch: PatchNote, _actorId: string) {
  const db = getDb();

  const existing = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `Note not found: ${id}`);
  }

  assertOpen(existing);

  const now = new Date().toISOString();
  const values: Record<string, unknown> = { updatedAt: now };

  if (patch.kind !== undefined) values.kind = patch.kind;
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.body !== undefined) values.body = patch.body;
  if (patch.anchorType !== undefined) values.anchorType = patch.anchorType;
  if (patch.anchorId !== undefined) values.anchorId = patch.anchorId;
  if (patch.codeLocator !== undefined) values.codeLocator = patch.codeLocator;
  if (patch.severity !== undefined) values.severity = patch.severity;

  db.update(notes).set(values).where(eq(notes.id, id)).run();

  const row = db.select().from(notes).where(eq(notes.id, id)).get()!;

  getEventBus().emit(EVENT_NAMES.NOTE_UPDATED, {
    entity: row,
    entityType: "note",
    entityId: id,
    projectId: row.projectId,
    actorId: _actorId,
    timestamp: now,
  });

  return row;
}

/**
 * Apply a terminal triage to an OPEN note (Campaign C2 state-machine core).
 * Flips status open→triaged in ONE update and records the outcome + metadata.
 * Re-selects the note (404 if missing), asserts it is open (409 otherwise),
 * then sets the triage fields and returns the fresh row.
 *
 * This is the shared entry point for the P2 dismiss + P3-P4 promote endpoints.
 * It emits NO event in P1 — NOTE_DISMISSED / NOTE_PROMOTED arrive with their
 * endpoints in P2/P3.
 */
export function applyTriage(
  id: string,
  {
    outcome,
    triagedBy,
    triageReason,
    promotedProposalId,
    promotedTaskId,
  }: {
    outcome: NoteTriageOutcome;
    triagedBy: string;
    triageReason?: string | null;
    promotedProposalId?: string | null;
    promotedTaskId?: string | null;
  },
) {
  const db = getDb();

  const existing = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `Note not found: ${id}`);
  }

  assertOpen(existing);

  const now = new Date().toISOString();

  db.update(notes)
    .set({
      status: "triaged",
      triageOutcome: outcome,
      triagedAt: now,
      triagedBy,
      triageReason: triageReason ?? null,
      promotedProposalId: promotedProposalId ?? null,
      promotedTaskId: promotedTaskId ?? null,
      updatedAt: now,
    })
    .where(eq(notes.id, id))
    .run();

  return db.select().from(notes).where(eq(notes.id, id)).get()!;
}

/**
 * Advisory dedup: find OPEN notes in the same project whose title/body
 * fuzzily match the given text (FTS5 MATCH on notes_fts). Returns up to
 * `limit` candidates, best-ranked first. Identity-light shape ({id,title,kind})
 * for surfacing on the create response.
 *
 * Best-effort and fail-safe: an empty/whitespace query (which would make
 * `MATCH ''` throw) short-circuits to [], and any SQL throw also returns [] —
 * advisory dedup must NEVER break a note post.
 */
export function findSimilarOpenNotes(
  projectId: string,
  titleAndBody: string,
  limit = 5,
): Array<{ id: string; title: string; kind: NoteKind }> {
  const sanitized = sanitizeFtsQuery(titleAndBody);
  if (!sanitized) return [];

  try {
    const rawDb = getRawDb();
    const rows = rawDb
      .prepare(
        `
        SELECT n.id, n.title, n.kind, notes_fts.rank as rank
        FROM notes_fts
        JOIN notes n ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH ?
          AND n.project_id = ?
          AND n.status = 'open'
        ORDER BY rank LIMIT ?
        `,
      )
      .all(sanitized, projectId, limit) as Array<{
      id: string;
      title: string;
      kind: NoteKind;
      rank: number;
    }>;

    return rows.map((r) => ({ id: r.id, title: r.title, kind: r.kind }));
  } catch {
    return [];
  }
}
