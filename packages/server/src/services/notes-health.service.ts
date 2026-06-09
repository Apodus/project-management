import { and, count, eq, min } from "drizzle-orm";
import { createId, NOTES_BACKLOG_THRESHOLD_MS } from "@pm/shared";
import { getDb, notes, notesAlertState, projects } from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";

// ─── Notes backlog-age alert (Campaign C2 §P5) ────────────────────
//
// The on-read, edge-triggered backlog-age alert. It mirrors the C3 stale-claim
// alert (claims-health.service) PRECISELY: detection is a side effect of an
// on-read aggregate (computeNotesHealth), the alert fires exactly ONCE per
// backlog episode (latched on notes_alert_state.backlog_notified), and re-arms
// when the backlog clears. There is NO sweep / scheduler here — this module
// only READS the notes (the latch boolean is the sole write).

// ─── Types ────────────────────────────────────────────────────────

export interface NotesHealth {
  openCount: number;
  oldestUntriagedAgeMs: number | null;
}

/**
 * The notes_alert_state latch row (camelCase Drizzle property names). Mirrors
 * claims-health.ClaimsAlertLatchRow — id + the single edge-trigger flag.
 */
export interface NotesAlertLatchRow {
  id: string;
  backlogNotified: boolean;
}

// ─── Internal helpers ─────────────────────────────────────────────

function ensureProjectExists(projectId: string): void {
  const db = getDb();
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }
}

// ─── Alert latch surface ──────────────────────────────────────────
//
// The backlog edge-trigger flag lives on the per-project notes_alert_state row.
// These thin helpers expose the latch read (lazy-creating the row) + a
// single-column set, mirroring claims-health.readClaimsAlertLatch /
// setClaimsAlertLatch: the set touches ONLY the latch boolean + updatedAt, so a
// detection read can never clobber unrelated state, and the lazy-create INSERT
// is race-guarded by the unique (project_id) index.

function readNotesAlertStateRow(projectId: string): NotesAlertLatchRow | undefined {
  const db = getDb();
  const row = db
    .select({ id: notesAlertState.id, backlogNotified: notesAlertState.backlogNotified })
    .from(notesAlertState)
    .where(eq(notesAlertState.projectId, projectId))
    .get();
  return (row as NotesAlertLatchRow | undefined) ?? undefined;
}

/**
 * Read (lazily creating) the project's notes_alert_state latch row. Returns the
 * row id + the current backlog latch. The INSERT is guarded by try/catch for
 * the unique-index race (two concurrent first reads) — on rejection we re-read.
 */
export function readNotesAlertLatch(projectId: string): NotesAlertLatchRow {
  const existing = readNotesAlertStateRow(projectId);
  if (existing) return existing;

  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.insert(notesAlertState)
      .values({
        id: createId(),
        projectId,
        backlogNotified: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch {
    // Race: another caller inserted the same project between our SELECT and
    // INSERT. The unique index rejected us — re-read below.
  }
  return readNotesAlertStateRow(projectId)!;
}

/**
 * Single-COLUMN autocommit UPDATE of the backlog latch by row id. Touches ONLY
 * the latch boolean + updatedAt — no clobber of any other column. Mirrors
 * claims-health.setClaimsAlertLatch.
 */
export function setNotesAlertLatch(rowId: string, value: boolean, now: string): void {
  getDb()
    .update(notesAlertState)
    .set({ backlogNotified: value, updatedAt: now })
    .where(eq(notesAlertState.id, rowId))
    .run();
}

// ─── Open-notes aggregate ─────────────────────────────────────────

/**
 * Count the project's OPEN notes + the age of its oldest open note.
 *
 * min(createdAt) over the open notes returns the ISO string of the OLDEST open
 * note (or null when there are none). The age is computed here from that
 * string, NaN-guarded — `now − oldest.createdAt` is the basis for the
 * backlog-age alert message (analogous to oldestStaleAgeMs).
 */
function aggregateOpenNotes(projectId: string, now: Date): NotesHealth {
  const db = getDb();
  const row = db
    .select({ openCount: count(), oldest: min(notes.createdAt) })
    .from(notes)
    .where(and(eq(notes.projectId, projectId), eq(notes.status, "open")))
    .get();
  const openCount = row?.openCount ?? 0;
  // REVISION 1 — age transform: min() returns the ISO string (or null); compute
  // age here, NaN-guarded.
  let oldestUntriagedAgeMs: number | null = null;
  if (row?.oldest) {
    const ms = Date.parse(row.oldest);
    if (!Number.isNaN(ms)) oldestUntriagedAgeMs = now.getTime() - ms;
  }
  return { openCount, oldestUntriagedAgeMs };
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Compute the project's notes-backlog health AND fire the edge-triggered
 * backlog-age alert as a side effect (Campaign C2 §P5). Mirrors
 * claims-health.computeClaimsHealth PRECISELY:
 *
 *   - read the aggregate (openCount + oldestUntriagedAgeMs),
 *   - fire when there is an open note older than NOTES_BACKLOG_THRESHOLD_MS,
 *   - edge-trigger on the per-project latch: emit + latch true on the rising
 *     edge, reset the latch on the falling edge — so the alert fires exactly
 *     ONCE per backlog episode and re-arms when the backlog clears.
 *
 * The emit is IDENTITY-MASKED: the payload carries NO note id, only an
 * aggregate count + the oldest-open age. All emission is post-latch-write and
 * fire-and-forget — the alerts-listener guards its own failures, so a webhook
 * failure can never throw out of this read path.
 *
 * Returns the aggregate for the read endpoint.
 */
export function computeNotesHealth(projectId: string, now: Date = new Date()): NotesHealth {
  ensureProjectExists(projectId);

  const health = aggregateOpenNotes(projectId, now);
  const nowIso = now.toISOString();

  const fire =
    health.openCount > 0 &&
    health.oldestUntriagedAgeMs != null &&
    health.oldestUntriagedAgeMs > NOTES_BACKLOG_THRESHOLD_MS;
  const latch = readNotesAlertLatch(projectId);

  if (fire && !latch.backlogNotified) {
    setNotesAlertLatch(latch.id, true, nowIso);
    getEventBus().emit(EVENT_NAMES.NOTE_BACKLOG_ALERT, {
      // Identity-masked — aggregate only, NO note id.
      entity: {
        projectId,
        openCount: health.openCount,
        oldestUntriagedAgeMs: health.oldestUntriagedAgeMs,
      },
      entityType: "project",
      entityId: projectId,
      projectId,
      actorId: null,
      timestamp: nowIso,
    });
  } else if (!fire && latch.backlogNotified) {
    // Backlog cleared — reset the latch so the NEXT backlog episode re-fires.
    setNotesAlertLatch(latch.id, false, nowIso);
  }

  return health;
}
