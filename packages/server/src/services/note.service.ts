import { eq, and, desc, inArray } from "drizzle-orm";
import {
  createId,
  deriveNotePromotion,
  isMutableNoteStatus,
  isReopenableNoteStatus,
} from "@pm/shared";
import type {
  CreateNote,
  ListNotesQuery,
  NoteAnchorRef,
  NoteKind,
  NoteStatus,
  NoteTriageOutcome,
  PatchNote,
  ProposalKind,
  UserType,
} from "@pm/shared";
import { getDb, getRawDb, notes, projects, tasks, epics, proposals } from "../db/index.js";
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
 * Guard: only a note in a MUTABLE lane (open|needs_human) may be mutated or
 * triaged. A triaged note is terminal/immutable. Shared by `update`,
 * `applyTriage`, `promoteToProposal`, and `promoteToTask`.
 */
function assertMutable(note: { id: string; status: NoteStatus }): void {
  if (!isMutableNoteStatus(note.status)) {
    throw new AppError(
      409,
      "INVALID_STATUS",
      `Note ${note.id} is terminal (triaged) and cannot be modified`,
    );
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
 * Anchor + promoted-target enrichment (Campaign C4). Decorates note rows
 * with server-derived truth about their references:
 *   anchor:         { exists, title } for (anchorType, anchorId), null when unanchored
 *   promotedTarget: { exists, title } for promotedTaskId/promotedProposalId, null when not promoted
 * `exists: false` + `title: null` means the target was deleted (anchors carry
 * no FK, so a dangling anchorId is representable; promoted targets are FK
 * `onDelete: "set null"`, so dangling is near-impossible but handled).
 *
 * Mirrors the enrichActivityEntries precedent: ≤3 batched `inArray` selects
 * (one per referenced entity type, skipped when that type's id set is empty)
 * — never N+1 in the number of notes.
 */
export function enrichNotes<
  T extends {
    anchorType: string | null;
    anchorId: string | null;
    promotedProposalId: string | null;
    promotedTaskId: string | null;
  },
>(rows: T[]): (T & { anchor: NoteAnchorRef | null; promotedTarget: NoteAnchorRef | null })[] {
  if (rows.length === 0) return [];

  const db = getDb();

  // 1. Collect unique ids per entity type (anchors ∪ promoted targets).
  const taskIds = new Set<string>();
  const epicIds = new Set<string>();
  const proposalIds = new Set<string>();
  for (const r of rows) {
    if (r.anchorType && r.anchorId) {
      if (r.anchorType === "task") taskIds.add(r.anchorId);
      else if (r.anchorType === "epic") epicIds.add(r.anchorId);
      else if (r.anchorType === "proposal") proposalIds.add(r.anchorId);
    }
    if (r.promotedTaskId) taskIds.add(r.promotedTaskId);
    if (r.promotedProposalId) proposalIds.add(r.promotedProposalId);
  }

  // 2. Batched lookups — one select per entity type, skipped when empty.
  const taskTitles = new Map<string, string>();
  if (taskIds.size > 0) {
    const found = db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(inArray(tasks.id, [...taskIds]))
      .all();
    for (const t of found) taskTitles.set(t.id, t.title);
  }
  const epicTitles = new Map<string, string>();
  if (epicIds.size > 0) {
    const found = db
      .select({ id: epics.id, title: epics.name })
      .from(epics)
      .where(inArray(epics.id, [...epicIds]))
      .all();
    for (const e of found) epicTitles.set(e.id, e.title);
  }
  const proposalTitles = new Map<string, string>();
  if (proposalIds.size > 0) {
    const found = db
      .select({ id: proposals.id, title: proposals.title })
      .from(proposals)
      .where(inArray(proposals.id, [...proposalIds]))
      .all();
    for (const p of found) proposalTitles.set(p.id, p.title);
  }

  const titlesFor = (type: string): Map<string, string> =>
    type === "task" ? taskTitles : type === "epic" ? epicTitles : proposalTitles;

  // 3. Decorate.
  return rows.map((r) => {
    let anchor: NoteAnchorRef | null = null;
    if (r.anchorType && r.anchorId) {
      const titles = titlesFor(r.anchorType);
      anchor = { exists: titles.has(r.anchorId), title: titles.get(r.anchorId) ?? null };
    }
    let promotedTarget: NoteAnchorRef | null = null;
    if (r.promotedTaskId) {
      promotedTarget = {
        exists: taskTitles.has(r.promotedTaskId),
        title: taskTitles.get(r.promotedTaskId) ?? null,
      };
    } else if (r.promotedProposalId) {
      promotedTarget = {
        exists: proposalTitles.has(r.promotedProposalId),
        title: proposalTitles.get(r.promotedProposalId) ?? null,
      };
    }
    return { ...r, anchor, promotedTarget };
  });
}

/**
 * Get a single note by id, enriched (C4: anchor/promotedTarget truth).
 * Throws 404 if not found.
 */
export function getById(id: string) {
  const db = getDb();
  const row = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Note not found: ${id}`);
  }
  return enrichNotes([row])[0]!;
}

/**
 * List notes for a project, newest first, with optional filters.
 * Enriched (C4: anchor/promotedTarget truth — batched, never N+1).
 */
export function list(projectId: string, filters: ListNotesQuery) {
  const db = getDb();
  const conditions = [eq(notes.projectId, projectId)];

  if (filters.status) conditions.push(eq(notes.status, filters.status));
  if (filters.kind) conditions.push(eq(notes.kind, filters.kind));
  if (filters.anchorType) conditions.push(eq(notes.anchorType, filters.anchorType));
  if (filters.anchorId) conditions.push(eq(notes.anchorId, filters.anchorId));
  if (filters.severity) conditions.push(eq(notes.severity, filters.severity));

  const rows = db
    .select()
    .from(notes)
    .where(and(...conditions))
    .orderBy(desc(notes.createdAt))
    .all();

  return enrichNotes(rows);
}

/**
 * Patch a MUTABLE note (open|needs_human). A triaged note is terminal/immutable
 * (409). An explicit null in the patch clears the field (covers kind/title/body/
 * anchorType/anchorId/codeLocator/severity); status is never patchable (no status
 * field on PatchNote — flag/reopen own the status transitions).
 */
export function update(id: string, patch: PatchNote, _actorId: string) {
  const db = getDb();

  const existing = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `Note not found: ${id}`);
  }

  assertMutable(existing);

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
 * Flag an OPEN note as needs_human (T1 — the needs_human lane). An agent that
 * triaged a note but cannot resolve it punts it to a human by raising its
 * signal: open → needs_human. Sets NO triage* fields (it is NOT a terminal
 * triage — the note stays mutable/triageable in the needs_human lane).
 *
 * Source MUST be exactly "open": re-flagging a needs_human note (already
 * flagged) or a triaged note (terminal) is a 409. No authz gate — like
 * promoteToProposal, flag ELEVATES signal, so any authenticated caller (human
 * or ai_agent, author or not) may flag.
 */
export function flagNeedsHuman(id: string, actor: { id: string; type: UserType }) {
  const db = getDb();
  const note = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!note) {
    throw new AppError(404, "NOT_FOUND", `Note not found: ${id}`);
  }
  if (note.status !== "open") {
    throw new AppError(
      409,
      "INVALID_STATUS",
      `Note ${id} is not open and cannot be flagged needs_human`,
    );
  }

  const now = new Date().toISOString();
  db.update(notes).set({ status: "needs_human", updatedAt: now }).where(eq(notes.id, id)).run();

  const row = db.select().from(notes).where(eq(notes.id, id)).get()!;

  getEventBus().emit(EVENT_NAMES.NOTE_NEEDS_HUMAN, {
    entity: row,
    entityType: "note",
    entityId: id,
    projectId: row.projectId,
    actorId: actor.id,
    timestamp: now,
  });

  return row;
}

/**
 * Reopen a needs_human/triaged note back to OPEN (T1 — the human-only escape).
 * HUMAN-ONLY (mirrors promoteToTask): the gate runs FIRST so a non-human gets
 * 403 with zero writes. Source must be reopenable (needs_human|triaged) else
 * 409 — an already-open note is not reopenable.
 *
 * Reopen clears only the NOTE's disposition: status → open and ALL SIX triage
 * fields are nulled (triagedAt/triagedBy/triageOutcome/triageReason/
 * promotedProposalId/promotedTaskId). It DOES NOT delete any proposal/task that
 * a prior promote spawned — that entity stays independently reviewable, and
 * re-promoting later mints a FRESH target. The resulting back-pointer asymmetry
 * (the spawned proposal.sourceNoteId still points here while this note no longer
 * points back) is INTENTIONAL: reopen never destroys proven downstream work.
 */
export function reopen(id: string, actor: { id: string; type: UserType }) {
  const db = getDb();
  const note = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!note) {
    throw new AppError(404, "NOT_FOUND", `Note not found: ${id}`);
  }
  // HUMAN-ONLY gate FIRST — a non-human gets 403 regardless of status, with
  // zero writes.
  if (actor.type !== "human") {
    throw new AppError(
      403,
      "FORBIDDEN",
      `User "${actor.id}" is not allowed to reopen note ${id} (human-only)`,
    );
  }
  if (!isReopenableNoteStatus(note.status)) {
    throw new AppError(409, "INVALID_STATUS", `Note ${id} is open and is not reopenable`);
  }

  const priorStatus = note.status;
  const priorOutcome = note.triageOutcome;
  const now = new Date().toISOString();

  db.update(notes)
    .set({
      status: "open",
      triagedAt: null,
      triagedBy: null,
      triageOutcome: null,
      triageReason: null,
      promotedProposalId: null,
      promotedTaskId: null,
      updatedAt: now,
    })
    .where(eq(notes.id, id))
    .run();

  const row = db.select().from(notes).where(eq(notes.id, id)).get()!;

  getEventBus().emit(EVENT_NAMES.NOTE_REOPENED, {
    entity: row,
    entityType: "note",
    entityId: id,
    projectId: row.projectId,
    actorId: actor.id,
    timestamp: now,
    changes: {
      status: { from: priorStatus, to: "open" },
      triageOutcome: { from: priorOutcome, to: null },
    },
  });

  return row;
}

/**
 * Apply a terminal triage to a MUTABLE note (Campaign C2 state-machine core).
 * Flips status (open|needs_human)→triaged in ONE update and records the outcome
 * + metadata. Re-selects the note (404 if missing), asserts it is mutable (409
 * if already triaged), then sets the triage fields and returns the fresh row.
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

  assertMutable(existing);

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
 * Dismiss a MUTABLE note (open|needs_human) (Campaign C2 §P2) — a terminal
 * triage with outcome "dismissed". Anti-signal-burying authz: only the note's
 * author OR a human may dismiss (a non-author ai_agent gets 403). The authz
 * check runs BEFORE applyTriage's mutable-check so a forbidden actor gets 403
 * regardless of status; applyTriage handles 404-on-reselect / 409-if-terminal.
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
 * Accepts a MUTABLE note (open|needs_human). The mutable-guard runs BEFORE the
 * proposal is created so a terminal note never leaves an orphan proposal.
 */
export function promoteToProposal(
  id: string,
  actor: { id: string; type: UserType },
  {
    title,
    description,
    proposalKind,
  }: { title?: string; description?: string; proposalKind?: ProposalKind } = {},
) {
  const db = getDb();
  const note = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!note) {
    throw new AppError(404, "NOT_FOUND", `Note not found: ${id}`);
  }
  // Early mutable-guard BEFORE creating the proposal — prevents an orphan
  // proposal (sourceNoteId → terminal note) if the note isn't mutable.
  assertMutable(note);

  const derived = deriveNotePromotion(note);
  const finalTitle = title ?? derived.title;
  let finalDescription: string | null;
  if (description !== undefined) {
    finalDescription = description; // caller-supplied, verbatim (no auto-provenance)
  } else {
    const parts = [derived.description ?? "", `\n\nPromoted from note ${note.id} (${note.kind}).`];
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
    proposalKind,
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
 * Promote a MUTABLE note (open|needs_human) to a task (Campaign C2 §P4) — the
 * HUMAN-ONLY escape hatch. This is the only path from a note to a task, and it is deliberately
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
  // task from a note. Gate runs BEFORE assertMutable so a non-human gets 403
  // regardless of status, with zero writes.
  if (actor.type !== "human") {
    throw new AppError(
      403,
      "FORBIDDEN",
      `User "${actor.id}" is not allowed to promote note ${id} to a task (human-only)`,
    );
  }
  assertMutable(note);

  const derived = deriveNotePromotion(note);
  const finalTitle = title ?? derived.title;
  let finalDescription: string | null;
  if (description !== undefined) {
    finalDescription = description;
  } else {
    const parts = [derived.description ?? "", `\n\nPromoted from note ${note.id} (${note.kind}).`];
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
    console.warn(`[notes-dedup] findSimilarOpenNotes failed (advisory, returning []): ${err}`);
    return [];
  }
}
