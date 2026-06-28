import { eq, and, desc, gte } from "drizzle-orm";
import { createId } from "@pm/shared";
import type { NotesTriageMode, TriageDecisionKind } from "@pm/shared";
import { getDb, triageDecisions, notes, projects } from "../db/index.js";
import { AppError } from "../types.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";

// ─── Triage-decision side-log service (T2·P1) ─────────────────────
// A uniform, append-only decision log that BOTH shadow- and on-mode triage
// write via this decoupled record(). The cardinal contract: record() NEVER
// mutates a note — it only inserts an audit row attributing a decision to a
// caller. The daemon (T2·P4) calls record() in BOTH shadow (record only) and on
// (record + the real action + backlink). This is the contract T3 reads.
//
// Activity logging is NOT written here: the onAll listener (events/listeners.ts)
// maps TRIAGE_DECISION_RECORDED → an activity_log row.

/**
 * Ensure a project exists, else 404. Mirrors note.service's project guard.
 */
function ensureProjectExists(projectId: string): void {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }
}

/**
 * Record a triage decision (T2·P1). Inserts ONE append-only row attributing the
 * decision to `actorId`; it NEVER touches the notes table (that is the invariant
 * T3 depends on — a shadow-mode record leaves the note exactly as it was). The
 * project must exist (404) and the note must exist (404). resulting* / rationale
 * / confidence are null-coalesced (a shadow-mode or give_up row carries none).
 * Returns the freshly re-selected row.
 */
export function record(
  projectId: string,
  input: {
    noteId: string;
    mode: NotesTriageMode;
    decision: TriageDecisionKind;
    rationale?: string | null;
    confidence?: number | null;
    resultingProposalId?: string | null;
    resultingTaskId?: string | null;
  },
  actorId: string,
) {
  ensureProjectExists(projectId);

  const db = getDb();
  const note = db.select().from(notes).where(eq(notes.id, input.noteId)).get();
  if (!note) {
    throw new AppError(404, "NOT_FOUND", `Note not found: ${input.noteId}`);
  }

  const id = createId();
  const now = new Date().toISOString();

  db.insert(triageDecisions)
    .values({
      id,
      projectId,
      noteId: input.noteId,
      mode: input.mode,
      decision: input.decision,
      rationale: input.rationale ?? null,
      confidence: input.confidence ?? null,
      resultingProposalId: input.resultingProposalId ?? null,
      resultingTaskId: input.resultingTaskId ?? null,
      actorId,
      createdAt: now,
    })
    .run();

  const row = db.select().from(triageDecisions).where(eq(triageDecisions.id, id)).get()!;

  getEventBus().emit(EVENT_NAMES.TRIAGE_DECISION_RECORDED, {
    entity: row,
    entityType: "triage_decision",
    entityId: id,
    projectId,
    actorId,
    timestamp: now,
  });

  return row;
}

/**
 * List triage decisions for a project, newest first, with optional filters
 * (mode / decision / since — inclusive lower bound on createdAt). No enrichment
 * (deferred to T3).
 */
export function list(
  projectId: string,
  filters: { mode?: NotesTriageMode; decision?: TriageDecisionKind; since?: string },
) {
  const db = getDb();
  const conditions = [eq(triageDecisions.projectId, projectId)];

  if (filters.mode) conditions.push(eq(triageDecisions.mode, filters.mode));
  if (filters.decision) conditions.push(eq(triageDecisions.decision, filters.decision));
  if (filters.since) conditions.push(gte(triageDecisions.createdAt, filters.since));

  return db
    .select()
    .from(triageDecisions)
    .where(and(...conditions))
    .orderBy(desc(triageDecisions.createdAt))
    .all();
}
