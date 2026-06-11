import { eq, and, desc } from "drizzle-orm";
import { createId } from "@pm/shared";
import type {
  CreateNote,
  ListNotesQuery,
  NoteKind,
  NoteStatus,
  NoteTriageOutcome,
  PatchNote,
  UserType,
} from "@pm/shared";
import { getDb, getRawDb, notes, projects } from "../db/index.js";
import { AppError } from "../types.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";
import { sanitizeFtsQuery, sanitizeFtsQueryOr } from "./search.service.js";
import * as proposalService from "./proposal.service.js";
import * as taskService from "./task.service.js";

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
 * Dismiss an OPEN note (Campaign C2 §P2) — a terminal triage with outcome
 * "dismissed". Anti-signal-burying authz: only the note's author OR a human
 * may dismiss (a non-author ai_agent gets 403). The authz check runs BEFORE
 * applyTriage's open-check so a forbidden actor gets 403 regardless of status;
 * applyTriage handles 404-on-reselect / 409-on-not-open.
 */
export function dismiss(id: string, actor: { id: string; type: UserType }, reason: string) {
  const db = getDb();
  const existing = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `Note not found: ${id}`);
  }
  // Anti-signal-burying: only the note's author OR a human may dismiss.
  if (actor.type !== "human" && existing.authorId !== actor.id) {
    throw new AppError(403, "FORBIDDEN", `User "${actor.id}" is not allowed to dismiss note ${id}`);
  }
  const row = applyTriage(id, { outcome: "dismissed", triagedBy: actor.id, triageReason: reason });
  getEventBus().emit(EVENT_NAMES.NOTE_DISMISSED, {
    entity: row,
    entityType: "note",
    entityId: id,
    projectId: row.projectId,
    actorId: actor.id,
    timestamp: row.triagedAt!,
  });
  return row;
}

/**
 * Promote an OPEN note to a proposal (Campaign C2 §P3) — a terminal triage with
 * outcome "promoted" that ALSO spawns a proposal carrying a `sourceNoteId`
 * back-pointer (bidirectional provenance: note.promotedProposalId ⇆
 * proposal.sourceNoteId).
 *
 * No authz gate (unlike dismiss): promote ELEVATES signal, so any authenticated
 * caller — human or ai_agent, author or not — may promote. This preserves the
 * proposal gate: a note feeds proposal creation, never auto-spawns epics/tasks.
 *
 * The open-guard runs BEFORE the proposal is created so a non-open note never
 * leaves an orphan proposal pointing at an already-triaged note.
 */
export function promoteToProposal(
  id: string,
  actor: { id: string; type: UserType },
  { title, description }: { title?: string; description?: string } = {},
) {
  const db = getDb();
  const note = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!note) {
    throw new AppError(404, "NOT_FOUND", `Note not found: ${id}`);
  }
  // Early open-guard BEFORE creating the proposal — prevents an orphan
  // proposal (sourceNoteId → already-triaged note) if the note isn't open.
  assertOpen(note);

  const finalTitle = title ?? note.title;
  let finalDescription: string | null;
  if (description !== undefined) {
    finalDescription = description; // caller-supplied, verbatim (no auto-provenance)
  } else {
    const parts = [note.body ?? "", `\n\nPromoted from note ${note.id} (${note.kind}).`];
    if (note.codeLocator) {
      const cl = note.codeLocator;
      parts.push(
        `\nLocation: ${cl.path}${cl.line ? ":" + cl.line : ""}${cl.commitSha ? " @ " + cl.commitSha : ""}`,
      );
    }
    const joined = parts.join("").trim();
    finalDescription = joined.length > 0 ? joined : null;
  }

  const proposal = proposalService.create(note.projectId, {
    title: finalTitle,
    description: finalDescription,
    createdBy: actor.id,
    sourceNoteId: note.id,
  });

  const updatedNote = applyTriage(id, {
    outcome: "promoted",
    triagedBy: actor.id,
    promotedProposalId: proposal.id,
  });

  getEventBus().emit(EVENT_NAMES.NOTE_PROMOTED, {
    entity: updatedNote,
    entityType: "note",
    entityId: id,
    projectId: updatedNote.projectId,
    actorId: actor.id,
    timestamp: updatedNote.triagedAt!,
  });

  return { note: updatedNote, proposal };
}

/**
 * Promote an OPEN note to a task (Campaign C2 §P4) — the HUMAN-ONLY escape
 * hatch. This is the only path from a note to a task, and it is deliberately
 * NOT exposed via MCP: NO ai-reachable path mints a task from a note (the
 * proposal gate — a note feeds proposal creation for AI, never auto-spawns a
 * task/epic). A human reviewer flips the note into a task directly.
 *
 * The human-only gate runs BEFORE assertOpen so a non-human gets 403 regardless
 * of status, with zero writes (no orphan task, note untouched).
 */
export function promoteToTask(
  id: string,
  actor: { id: string; type: UserType },
  { title, description, epicId }: { title?: string; description?: string; epicId?: string } = {},
) {
  const db = getDb();
  const note = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!note) throw new AppError(404, "NOT_FOUND", `Note not found: ${id}`);
  // HUMAN-ONLY escape hatch (the proposal gate): NO ai-reachable path mints a
  // task from a note. Gate runs BEFORE assertOpen so a non-human gets 403
  // regardless of status, with zero writes.
  if (actor.type !== "human") {
    throw new AppError(
      403,
      "FORBIDDEN",
      `User "${actor.id}" is not allowed to promote note ${id} to a task (human-only)`,
    );
  }
  assertOpen(note);

  const finalTitle = title ?? note.title;
  let finalDescription: string | null;
  if (description !== undefined) {
    finalDescription = description;
  } else {
    const parts = [note.body ?? "", `\n\nPromoted from note ${note.id} (${note.kind}).`];
    if (note.codeLocator) {
      const cl = note.codeLocator;
      parts.push(
        `\nLocation: ${cl.path}${cl.line ? ":" + cl.line : ""}${cl.commitSha ? " @ " + cl.commitSha : ""}`,
      );
    }
    const joined = parts.join("").trim();
    finalDescription = joined.length > 0 ? joined : null;
  }

  // No `actor` 2nd arg → skip the AI autonomy guardrail (the human already
  // passed the human-only gate); provenance/TASK_CREATED actor = reporterId.
  const task = taskService.create({
    projectId: note.projectId,
    title: finalTitle,
    description: finalDescription,
    reporterId: actor.id,
    epicId: epicId ?? null,
    sourceNoteId: note.id,
  });

  const updatedNote = applyTriage(id, {
    outcome: "promoted",
    triagedBy: actor.id,
    promotedTaskId: task.id,
  });

  getEventBus().emit(EVENT_NAMES.NOTE_PROMOTED, {
    entity: updatedNote,
    entityType: "note",
    entityId: id,
    projectId: updatedNote.projectId,
    actorId: actor.id,
    timestamp: updatedNote.triagedAt!,
  });

  return { note: updatedNote, task };
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
    const sql = `
        SELECT n.id, n.title, n.kind, notes_fts.rank as rank
        FROM notes_fts
        JOIN notes n ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH ?
          AND n.project_id = ?
          AND n.status = 'open'
        ORDER BY rank LIMIT ?
        `;
    type Row = { id: string; title: string; kind: NoteKind; rank: number };

    // Pass 1: implicit-AND (precise). If it hits, return those — no top-up.
    const rows = rawDb.prepare(sql).all(sanitized, projectId, limit) as Row[];
    if (rows.length > 0) {
      return rows.map((r) => ({ id: r.id, title: r.title, kind: r.kind }));
    }

    // Pass 2: OR fallback — the recall floor for the zero-AND-hit case
    // (advisory-only). Top-3 by rank, independent of the limit param.
    const orSanitized = sanitizeFtsQueryOr(titleAndBody);
    if (!orSanitized) return [];
    const orRows = rawDb.prepare(sql).all(orSanitized, projectId, 3) as Row[];
    return orRows.map((r) => ({ id: r.id, title: r.title, kind: r.kind }));
  } catch (err) {
    // C2 de-silence: the [] fallback is correct (advisory dedup must never
    // break a note post), but a throwing FTS query (dropped/corrupt notes_fts,
    // SQL error) was previously invisible — dedup would just silently stop
    // working. Warn so the operator can see the cause.
    console.warn(
      `[notes-dedup] findSimilarOpenNotes failed (advisory, returning []): ${err}`,
    );
    return [];
  }
}
