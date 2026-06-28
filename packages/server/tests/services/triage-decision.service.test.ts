import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestApp, createTestProject, createTestUser, type TestApp } from "../utils.js";
import { notes, proposals, tasks, triageDecisions } from "../../src/db/index.js";
import { AppError } from "../../src/types.js";
import * as noteService from "../../src/services/note.service.js";
import * as triageDecisionService from "../../src/services/triage-decision.service.js";

// ──────────────────────────────────────────────────────────────────
// T2·P1: the triage-decision side-log service. record() appends a decision row
// and NEVER mutates a note (the invariant T3 depends on). list() filters +
// orders newest-first.
// ──────────────────────────────────────────────────────────────────

describe("triage-decision service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── record ──────────────────────────────────────────────────────
  describe("record", () => {
    it("inserts a row and returns it", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      const note = noteService.create(project.id, { kind: "bug", title: "finding" }, actor.id);

      const row = triageDecisionService.record(
        project.id,
        { noteId: note.id, mode: "on", decision: "dismiss", rationale: "noise" },
        actor.id,
      );

      expect(row.id).toBeTruthy();
      expect(row.projectId).toBe(project.id);
      expect(row.noteId).toBe(note.id);
      expect(row.mode).toBe("on");
      expect(row.decision).toBe("dismiss");
      expect(row.rationale).toBe("noise");
      expect(row.confidence).toBeNull();
      expect(row.resultingProposalId).toBeNull();
      expect(row.resultingTaskId).toBeNull();
      expect(row.actorId).toBe(actor.id);

      const reread = testApp.db
        .select()
        .from(triageDecisions)
        .where(eq(triageDecisions.id, row.id))
        .get()!;
      expect(reread.decision).toBe("dismiss");
    });

    it("404s on a nonexistent project", () => {
      const actor = createTestUser(testApp.db);
      expect(() =>
        triageDecisionService.record(
          "nonexistent",
          { noteId: "x", mode: "shadow", decision: "dismiss" },
          actor.id,
        ),
      ).toThrow(AppError);
    });

    it("404s on a nonexistent note", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      try {
        triageDecisionService.record(
          project.id,
          { noteId: "nonexistent", mode: "shadow", decision: "dismiss" },
          actor.id,
        );
        expect.unreachable("should have thrown 404");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
      }
    });

    // THE INVARIANT — a shadow-mode record writes a row AND leaves the note open.
    it("INVARIANT: a shadow-mode record writes a row but NEVER mutates the note", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      const note = noteService.create(
        project.id,
        { kind: "idea", title: "would-promote in shadow" },
        actor.id,
      );

      const proposalsBefore = testApp.db.select().from(proposals).all().length;
      const tasksBefore = testApp.db.select().from(tasks).all().length;

      const row = triageDecisionService.record(
        project.id,
        { noteId: note.id, mode: "shadow", decision: "promote_standard", confidence: 0.9 },
        actor.id,
      );

      // A row WAS written.
      expect(row.mode).toBe("shadow");
      expect(testApp.db.select().from(triageDecisions).all().length).toBe(1);

      // The note is untouched: still open, no triage metadata, nothing minted.
      const reread = testApp.db.select().from(notes).where(eq(notes.id, note.id)).get()!;
      expect(reread.status).toBe("open");
      expect(reread.triageOutcome).toBeNull();
      expect(reread.triagedAt).toBeNull();
      expect(reread.promotedProposalId).toBeNull();
      expect(reread.promotedTaskId).toBeNull();
      expect(testApp.db.select().from(proposals).all().length).toBe(proposalsBefore);
      expect(testApp.db.select().from(tasks).all().length).toBe(tasksBefore);
    });
  });

  // ── list ────────────────────────────────────────────────────────
  describe("list", () => {
    it("filters by mode/decision/since and returns newest-first", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      const note = noteService.create(project.id, { kind: "bug", title: "n" }, actor.id);

      const r1 = triageDecisionService.record(
        project.id,
        { noteId: note.id, mode: "shadow", decision: "dismiss" },
        actor.id,
      );
      const r2 = triageDecisionService.record(
        project.id,
        { noteId: note.id, mode: "on", decision: "promote_standard" },
        actor.id,
      );
      const r3 = triageDecisionService.record(
        project.id,
        { noteId: note.id, mode: "on", decision: "dismiss" },
        actor.id,
      );

      // No filter → all three, newest-first (createdAt desc, ties broken by insert order via the rows themselves).
      const all = triageDecisionService.list(project.id, {});
      expect(all.length).toBe(3);
      // Newest-first: createdAt is desc; the last-inserted has the latest-or-equal stamp.
      expect(all.map((r) => r.id)).toContain(r1.id);
      expect(all.map((r) => r.id)).toContain(r2.id);
      expect(all.map((r) => r.id)).toContain(r3.id);

      // Filter by mode.
      const onMode = triageDecisionService.list(project.id, { mode: "on" });
      expect(onMode.map((r) => r.id).sort()).toEqual([r2.id, r3.id].sort());

      // Filter by decision.
      const dismissed = triageDecisionService.list(project.id, { decision: "dismiss" });
      expect(dismissed.map((r) => r.id).sort()).toEqual([r1.id, r3.id].sort());

      // Combined mode + decision.
      const onDismiss = triageDecisionService.list(project.id, { mode: "on", decision: "dismiss" });
      expect(onDismiss.map((r) => r.id)).toEqual([r3.id]);

      // since: a future lower bound excludes everything.
      const future = new Date(Date.now() + 60_000).toISOString();
      expect(triageDecisionService.list(project.id, { since: future })).toEqual([]);
      // since: an epoch lower bound includes everything.
      expect(
        triageDecisionService.list(project.id, { since: "1970-01-01T00:00:00.000Z" }).length,
      ).toBe(3);
    });

    it("is ordered strictly newest-first by createdAt", () => {
      const project = createTestProject(testApp.db);
      const actor = createTestUser(testApp.db);
      const note = noteService.create(project.id, { kind: "bug", title: "n" }, actor.id);

      // Insert rows with explicit, increasing createdAt to make the order deterministic.
      const base = Date.now();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const row = triageDecisionService.record(
          project.id,
          { noteId: note.id, mode: "shadow", decision: "dismiss" },
          actor.id,
        );
        // Force a distinct, increasing createdAt.
        const stamp = new Date(base + i * 1000).toISOString();
        testApp.db
          .update(triageDecisions)
          .set({ createdAt: stamp })
          .where(eq(triageDecisions.id, row.id))
          .run();
        ids.push(row.id);
      }

      const listed = triageDecisionService.list(project.id, {});
      // newest (largest createdAt) first → reverse of insertion order.
      expect(listed.map((r) => r.id)).toEqual([...ids].reverse());
    });
  });
});
