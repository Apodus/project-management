import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createId, NOTES_BACKLOG_THRESHOLD_MS } from "@pm/shared";
import { createTestApp, createTestProject, createTestUser, type TestApp } from "../utils.js";
import { notes, notesAlertState } from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import * as notesHealth from "../../src/services/notes-health.service.js";
import * as triageMetrics from "../../src/services/triage-metrics.service.js";

// Fixed reference "now" so ages are deterministic.
const NOW = new Date("2026-06-09T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR = 3600_000;
const THRESHOLD = NOTES_BACKLOG_THRESHOLD_MS;

function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

/**
 * Seed an OPEN note for a project with a controllable createdAt (its age drives
 * the backlog alert). Returns the note id.
 */
function seedNote(
  testApp: TestApp,
  args: { projectId: string; authorId: string; createdAt: string; status?: string },
): string {
  const id = createId();
  testApp.db
    .insert(notes)
    .values({
      id,
      projectId: args.projectId,
      kind: "bug",
      status: (args.status ?? "open") as "open",
      title: "a finding",
      authorId: args.authorId,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    })
    .run();
  return id;
}

function readLatch(testApp: TestApp, projectId: string) {
  return testApp.db
    .select()
    .from(notesAlertState)
    .where(eq(notesAlertState.projectId, projectId))
    .get();
}

describe("notes on-read backlog-age alert (Campaign C2 §P5)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Fire once, latch, reset on clear, re-fire (edge re-arm) ────────

  it("note.backlog_alert fires ONCE, latches, resets on clear, and re-fires", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db);

    // An open note created well past the backlog threshold → backlog.
    const noteId = seedNote(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 2 * HOUR),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.NOTE_BACKLOG_ALERT, (p) => calls.push(p.entity));

    // First read → fires once + latches.
    const first = notesHealth.computeNotesHealth(project.id, NOW);
    expect(first.openCount).toBe(1);
    expect(first.oldestUntriagedAgeMs).toBe(THRESHOLD + 2 * HOUR);
    expect(calls).toHaveLength(1);
    expect(readLatch(testApp, project.id)?.backlogNotified).toBe(true);

    // Second read while still backlogged → latched, does NOT re-fire.
    notesHealth.computeNotesHealth(project.id, NOW);
    expect(calls).toHaveLength(1);

    // Resolve: triage the note → openCount 0, latch resets, no fire.
    testApp.db.update(notes).set({ status: "triaged" }).where(eq(notes.id, noteId)).run();
    const cleared = notesHealth.computeNotesHealth(project.id, NOW);
    expect(cleared.openCount).toBe(0);
    expect(calls).toHaveLength(1); // no new fire
    expect(readLatch(testApp, project.id)?.backlogNotified).toBe(false);

    // Re-introduce backlog (a NEW stale open note) → re-fires (edge re-arm).
    seedNote(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 2 * HOUR),
    });
    notesHealth.computeNotesHealth(project.id, NOW);
    expect(calls).toHaveLength(2);
    expect(readLatch(testApp, project.id)?.backlogNotified).toBe(true);
  });

  // ── No open notes → no fire ───────────────────────────────────────

  it("does NOT fire when there are no open notes", () => {
    const project = createTestProject(testApp.db);

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.NOTE_BACKLOG_ALERT, (p) => calls.push(p.entity));

    const health = notesHealth.computeNotesHealth(project.id, NOW);
    expect(health.openCount).toBe(0);
    expect(health.oldestUntriagedAgeMs).toBeNull();
    expect(calls).toHaveLength(0);
    expect(readLatch(testApp, project.id)?.backlogNotified).toBe(false);
  });

  // ── Open note but within threshold → no fire (notes-specific) ──────

  it("does NOT fire when an open note is younger than the backlog threshold", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db);

    // Open but created INSIDE the threshold window → not yet a backlog.
    seedNote(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD - HOUR),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.NOTE_BACKLOG_ALERT, (p) => calls.push(p.entity));

    const health = notesHealth.computeNotesHealth(project.id, NOW);
    expect(health.openCount).toBe(1);
    expect(calls).toHaveLength(0);
    expect(readLatch(testApp, project.id)?.backlogNotified).toBe(false);
  });

  // ── Latch UPDATE touches ONLY the latch column ────────────────────

  it("the latch UPDATE touches only backlog_notified + updated_at", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db);
    seedNote(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 2 * HOUR),
    });

    // First read lazily creates the row + latches true.
    notesHealth.computeNotesHealth(project.id, NOW);
    const after = readLatch(testApp, project.id);
    expect(after).toBeDefined();
    expect(after!.backlogNotified).toBe(true);
    // The id + projectId + createdAt are preserved (not clobbered) by the
    // single-column latch UPDATE.
    expect(after!.projectId).toBe(project.id);
    expect(after!.id).toBeTruthy();
    expect(after!.createdAt).toBeTruthy();
  });

  // ── Identity masking: payload carries NO note id ──────────────────

  it("the emitted payload carries NO note id (identity-masked)", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db);
    const noteId = seedNote(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 2 * HOUR),
    });

    let captured: Record<string, unknown> | null = null;
    getEventBus().on(EVENT_NAMES.NOTE_BACKLOG_ALERT, (p) => {
      captured = p.entity as Record<string, unknown>;
    });

    notesHealth.computeNotesHealth(project.id, NOW);
    expect(captured).not.toBeNull();
    const payload = captured!;
    // The aggregate fields are present...
    expect(payload.openCount).toBe(1);
    expect(payload.projectId).toBe(project.id);
    // ...and NO note id leaks.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(noteId);
    expect(Object.values(payload)).not.toContain(noteId);
  });

  // ── Reuse: the backlog alert ALSO fires from the triage-metrics read ──

  it("note.backlog_alert fires from the triage-metrics read path too (computeTriageMetrics → computeNotesHealth)", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db);
    seedNote(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 2 * HOUR),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.NOTE_BACKLOG_ALERT, (p) => calls.push(p.entity));

    // Driving the TRIAGE metrics read (not computeNotesHealth directly) must
    // still fire the latched backlog alert + set the backlog latch.
    triageMetrics.computeTriageMetrics(project.id, { now: NOW.toISOString() });
    expect(calls).toHaveLength(1);
    expect(readLatch(testApp, project.id)?.backlogNotified).toBe(true);

    // Latched — a second triage read does NOT re-fire.
    triageMetrics.computeTriageMetrics(project.id, { now: NOW.toISOString() });
    expect(calls).toHaveLength(1);
  });

  // ── Webhook-failure resilience (mirror the claims test) ────────────

  it("computeNotesHealth returns normally even when the Discord POST rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // A project with a configured Discord webhook so the listener tries to POST.
    const project = createTestProject(testApp.db, {
      settings: {
        ai_autonomy: {
          can_self_assign: true,
          can_create_subtasks: true,
          can_create_tasks: true,
          can_change_priority: true,
          can_close_epics: true,
          max_concurrent_tasks: 3,
        },
        workflow: { statuses: ["backlog", "done"] },
        git: { branch_prefix: "feat/", auto_link_branches: true },
        webhooks: {
          discord_url: "https://discord.com/api/webhooks/1/abc",
          alerts_enabled: true,
        },
      },
    });
    const author = createTestUser(testApp.db);
    const noteId = seedNote(testApp, {
      projectId: project.id,
      authorId: author.id,
      createdAt: ago(THRESHOLD + 2 * HOUR),
    });

    const health = notesHealth.computeNotesHealth(project.id, NOW);
    expect(health.openCount).toBe(1);
    await new Promise((r) => setImmediate(r));
    // The backlog alert tried to POST a masked message to Discord.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.content).toContain("Note backlog");
    // The masked message must NOT contain the note id.
    expect(body.content).not.toContain(noteId);

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
