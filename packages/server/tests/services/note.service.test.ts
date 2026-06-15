import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import Database from "better-sqlite3";
import { createId } from "@pm/shared";
import {
  createTestApp,
  createTestProject,
  createTestTask,
  createTestEpic,
  createTestProposal,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { activityLog, getRawDb, notes, proposals, tasks } from "../../src/db/index.js";
import { AppError } from "../../src/types.js";
import * as noteService from "../../src/services/note.service.js";

// ──────────────────────────────────────────────────────────────────
// Campaign C1 (notes/findings inbox §P3): the note service — capture +
// read + the open-only PATCH guard. Notes are ownerless in C1 (no
// claim/lease). Activity rows are written by the onAll listener (wired
// via createApp/initializeEventListeners) → assert via activity_log.
// ──────────────────────────────────────────────────────────────────

describe("note service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  function activityRows(entityId: string) {
    return testApp.db.select().from(activityLog).where(eq(activityLog.entityId, entityId)).all();
  }

  // ── create ──────────────────────────────────────────────────────
  describe("create", () => {
    it("creates an open note with a generated id and the given author", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);

      const note = noteService.create(
        project.id,
        { kind: "bug", title: "Login flickers", body: "Repro on Safari", severity: "high" },
        author.id,
      );

      expect(note.id).toBeTruthy();
      expect(note.status).toBe("open");
      expect(note.kind).toBe("bug");
      expect(note.title).toBe("Login flickers");
      expect(note.body).toBe("Repro on Safari");
      expect(note.severity).toBe("high");
      expect(note.authorId).toBe(author.id);
      expect(note.projectId).toBe(project.id);
      // Defaults for the optional anchor fields.
      expect(note.anchorType).toBeNull();
      expect(note.anchorId).toBeNull();
      expect(note.codeLocator).toBeNull();
    });

    it("throws 404 when the project does not exist", () => {
      const author = createTestUser(testApp.db);
      try {
        noteService.create(createId(), { kind: "idea", title: "nope" }, author.id);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
      }
    });
  });

  // ── getById ─────────────────────────────────────────────────────
  describe("getById", () => {
    it("returns the note when it exists", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const created = noteService.create(
        project.id,
        { kind: "question", title: "Why FTS5?" },
        author.id,
      );

      const fetched = noteService.getById(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.title).toBe("Why FTS5?");
    });

    it("throws 404 for a missing note", () => {
      try {
        noteService.getById(createId());
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
      }
    });
  });

  // ── list ────────────────────────────────────────────────────────
  describe("list", () => {
    it("is project-scoped and ordered newest-first", () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);

      // Insert with explicit increasing createdAt to make ordering deterministic.
      const older = createId();
      const newer = createId();
      testApp.db
        .insert(notes)
        .values({
          id: older,
          projectId: projectA.id,
          kind: "bug",
          status: "open",
          title: "older",
          authorId: author.id,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })
        .run();
      testApp.db
        .insert(notes)
        .values({
          id: newer,
          projectId: projectA.id,
          kind: "idea",
          status: "open",
          title: "newer",
          authorId: author.id,
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        })
        .run();
      // A note in another project must NOT appear.
      noteService.create(projectB.id, { kind: "wtf", title: "other project" }, author.id);

      const list = noteService.list(projectA.id, {});
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(newer);
      expect(list[1].id).toBe(older);
    });

    it("filters by kind", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      noteService.create(project.id, { kind: "bug", title: "b" }, author.id);
      noteService.create(project.id, { kind: "idea", title: "i" }, author.id);

      const list = noteService.list(project.id, { kind: "bug" });
      expect(list).toHaveLength(1);
      expect(list[0].kind).toBe("bug");
    });

    it("filters by status", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      noteService.create(project.id, { kind: "bug", title: "open one" }, author.id);
      testApp.db
        .insert(notes)
        .values({
          id: createId(),
          projectId: project.id,
          kind: "bug",
          status: "triaged",
          title: "triaged one",
          authorId: author.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();

      expect(noteService.list(project.id, { status: "open" })).toHaveLength(1);
      expect(noteService.list(project.id, { status: "triaged" })).toHaveLength(1);
    });

    it("filters by anchorType", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      noteService.create(
        project.id,
        { kind: "bug", title: "anchored", anchorType: "task", anchorId: "t1" },
        author.id,
      );
      noteService.create(project.id, { kind: "bug", title: "unanchored" }, author.id);

      const list = noteService.list(project.id, { anchorType: "task" });
      expect(list).toHaveLength(1);
      expect(list[0].anchorType).toBe("task");
    });

    it("filters by anchorId", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      noteService.create(
        project.id,
        { kind: "bug", title: "a", anchorType: "epic", anchorId: "epic-42" },
        author.id,
      );
      noteService.create(
        project.id,
        { kind: "bug", title: "b", anchorType: "epic", anchorId: "epic-99" },
        author.id,
      );

      const list = noteService.list(project.id, { anchorId: "epic-42" });
      expect(list).toHaveLength(1);
      expect(list[0].anchorId).toBe("epic-42");
    });

    it("filters by severity", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      noteService.create(project.id, { kind: "bug", title: "hi", severity: "high" }, author.id);
      noteService.create(project.id, { kind: "bug", title: "lo", severity: "low" }, author.id);

      const list = noteService.list(project.id, { severity: "high" });
      expect(list).toHaveLength(1);
      expect(list[0].severity).toBe("high");
    });
  });

  // ── update ──────────────────────────────────────────────────────
  describe("update", () => {
    it("mutates an open note and bumps updatedAt", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "before", body: "old" },
        author.id,
      );

      // Force updatedAt to differ deterministically.
      testApp.db
        .update(notes)
        .set({ updatedAt: "2020-01-01T00:00:00.000Z" })
        .where(eq(notes.id, created.id))
        .run();

      const updated = noteService.update(
        created.id,
        { title: "after", body: null, severity: "medium" },
        author.id,
      );

      expect(updated.title).toBe("after");
      expect(updated.body).toBeNull(); // explicit null clears
      expect(updated.severity).toBe("medium");
      expect(updated.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
    });

    it("throws 409 INVALID_STATUS when the note is not open (triaged)", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const id = createId();
      testApp.db
        .insert(notes)
        .values({
          id,
          projectId: project.id,
          kind: "bug",
          status: "triaged",
          title: "already triaged",
          authorId: author.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();

      try {
        noteService.update(id, { title: "nope" }, author.id);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).code).toBe("INVALID_STATUS");
      }
    });

    it("throws 404 for a missing note", () => {
      const author = createTestUser(testApp.db);
      try {
        noteService.update(createId(), { title: "x" }, author.id);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
      }
    });
  });

  // ── applyTriage (state-machine core, C2 §P1) ────────────────────
  describe("applyTriage", () => {
    it("flips an open note to triaged and records outcome/metadata", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      // A real task so the promoted_task_id FK is satisfied.
      const task = createTestTask(testApp.db, { projectId: project.id, reporterId: author.id });
      const created = noteService.create(project.id, { kind: "bug", title: "real bug" }, author.id);

      const triaged = noteService.applyTriage(created.id, {
        outcome: "promoted",
        triagedBy: author.id,
        triageReason: "worth a task",
        promotedTaskId: task.id,
      });

      expect(triaged.status).toBe("triaged");
      expect(triaged.triageOutcome).toBe("promoted");
      expect(triaged.triagedBy).toBe(author.id);
      expect(triaged.triagedAt).toBeTruthy();
      expect(triaged.triageReason).toBe("worth a task");
      expect(triaged.promotedTaskId).toBe(task.id);
      expect(triaged.promotedProposalId).toBeNull();
    });

    it("defaults the optional pointers/reason to null", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const created = noteService.create(project.id, { kind: "idea", title: "meh" }, author.id);

      const triaged = noteService.applyTriage(created.id, {
        outcome: "dismissed",
        triagedBy: author.id,
      });

      expect(triaged.status).toBe("triaged");
      expect(triaged.triageOutcome).toBe("dismissed");
      expect(triaged.triageReason).toBeNull();
      expect(triaged.promotedProposalId).toBeNull();
      expect(triaged.promotedTaskId).toBeNull();
    });

    it("throws 409 INVALID_STATUS on a second triage of an already-triaged note", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "triage once" },
        author.id,
      );
      noteService.applyTriage(created.id, { outcome: "dismissed", triagedBy: author.id });

      try {
        noteService.applyTriage(created.id, { outcome: "promoted", triagedBy: author.id });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).code).toBe("INVALID_STATUS");
      }
    });

    it("throws 404 for a missing note", () => {
      const author = createTestUser(testApp.db);
      try {
        noteService.applyTriage(createId(), { outcome: "dismissed", triagedBy: author.id });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
      }
    });

    it("emits NO triage activity row in P1 (only the create row exists)", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "no event yet" },
        author.id,
      );

      // create wrote exactly one 'created' row.
      expect(activityRows(created.id)).toHaveLength(1);

      noteService.applyTriage(created.id, { outcome: "dismissed", triagedBy: author.id });

      // applyTriage emits NO event in P1 → still exactly the one create row.
      const rows = activityRows(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("created");
    });
  });

  // ── dismiss (C2 §P2 — terminal triage + author-or-human authz) ──
  describe("dismiss", () => {
    it("lets the author dismiss an open note (status triaged, outcome dismissed, metadata set)", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db, { type: "ai_agent" });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "author can dismiss" },
        author.id,
      );

      const dismissed = noteService.dismiss(
        created.id,
        { id: author.id, type: "ai_agent" },
        "not reproducible",
      );

      expect(dismissed.status).toBe("triaged");
      expect(dismissed.triageOutcome).toBe("dismissed");
      expect(dismissed.triageReason).toBe("not reproducible");
      expect(dismissed.triagedBy).toBe(author.id);
      expect(dismissed.triagedAt).toBeTruthy();
    });

    it("lets a human (non-author) dismiss another agent's note", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db, { type: "ai_agent" });
      const human = createTestUser(testApp.db, { type: "human" });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "human can dismiss" },
        author.id,
      );

      const dismissed = noteService.dismiss(created.id, { id: human.id, type: "human" }, "wontfix");

      expect(dismissed.status).toBe("triaged");
      expect(dismissed.triageOutcome).toBe("dismissed");
      expect(dismissed.triagedBy).toBe(human.id);
    });

    it("throws 403 FORBIDDEN when a DIFFERENT ai_agent tries to dismiss (anti-signal-burying)", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db, { type: "ai_agent" });
      const other = createTestUser(testApp.db, { type: "ai_agent" });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "not yours" },
        author.id,
      );

      try {
        noteService.dismiss(created.id, { id: other.id, type: "ai_agent" }, "sweep it");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(403);
        expect((err as AppError).code).toBe("FORBIDDEN");
      }
    });

    it("throws 409 INVALID_STATUS when dismissing an already-triaged note", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db, { type: "ai_agent" });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "dismiss twice" },
        author.id,
      );
      noteService.dismiss(created.id, { id: author.id, type: "ai_agent" }, "first");

      try {
        noteService.dismiss(created.id, { id: author.id, type: "ai_agent" }, "second");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).code).toBe("INVALID_STATUS");
      }
    });

    it("throws 404 for a missing note", () => {
      const human = createTestUser(testApp.db, { type: "human" });
      try {
        noteService.dismiss(createId(), { id: human.id, type: "human" }, "x");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
      }
    });

    it("emits NOTE_DISMISSED → a 'dismissed' activity row for the note", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db, { type: "ai_agent" });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "emits event" },
        author.id,
      );

      noteService.dismiss(created.id, { id: author.id, type: "ai_agent" }, "done");

      const rows = activityRows(created.id);
      const dismissed = rows.find((r) => r.action === "dismissed");
      expect(dismissed).toBeDefined();
      expect(dismissed!.entityType).toBe("note");
      expect(dismissed!.actorId).toBe(author.id);
      expect(dismissed!.projectId).toBe(project.id);
    });
  });

  // ── promoteToProposal (C2 §P3 — terminal triage + proposal + provenance) ──
  describe("promoteToProposal", () => {
    it("promotes an OPEN note to a proposal with bidirectional provenance", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db, { type: "ai_agent" });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "needs a proposal", body: "some context" },
        author.id,
      );

      const { note, proposal } = noteService.promoteToProposal(created.id, {
        id: author.id,
        type: "ai_agent",
      });

      // Provenance round-trip.
      expect(proposal.sourceNoteId).toBe(note.id);
      expect(note.promotedProposalId).toBe(proposal.id);

      // Note is terminally triaged with outcome "promoted".
      expect(note.status).toBe("triaged");
      expect(note.triageOutcome).toBe("promoted");
      expect(note.triagedBy).toBe(author.id);
      expect(note.triagedAt).toBeTruthy();
      expect(note.promotedTaskId).toBeNull();

      // Proposal shape.
      expect(proposal.createdBy).toBe(author.id);
      expect(proposal.status).toBe("open");
      expect(proposal.projectId).toBe(project.id);
    });

    it("derives the default title/description from the note (incl. provenance line)", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const created = noteService.create(
        project.id,
        { kind: "idea", title: "title from note", body: "the body text" },
        author.id,
      );

      const { proposal } = noteService.promoteToProposal(created.id, {
        id: author.id,
        type: "human",
      });

      expect(proposal.title).toBe("title from note");
      expect(proposal.description).toContain("the body text");
      expect(proposal.description).toContain(`Promoted from note ${created.id}`);
    });

    it("includes a Location line when the note has a codeLocator", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const created = noteService.create(
        project.id,
        {
          kind: "bug",
          title: "located bug",
          codeLocator: { path: "src/foo.ts", line: 42, commitSha: "abc123" },
        },
        author.id,
      );

      const { proposal } = noteService.promoteToProposal(created.id, {
        id: author.id,
        type: "human",
      });

      expect(proposal.description).toContain("Location: src/foo.ts:42 @ abc123");
    });

    it("shortens a pathologically-long title to a topic and carries the full content into the description", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const longTitle =
        "The rendering pipeline silently drops the second draw call whenever the depth buffer is cleared mid-frame and this only reproduces on the integrated GPU";
      const created = noteService.create(
        project.id,
        { kind: "bug", title: longTitle, body: "repro steps here" },
        author.id,
      );

      const { proposal } = noteService.promoteToProposal(created.id, {
        id: author.id,
        type: "human",
      });

      // Short topic, not the bloated full title.
      expect(proposal.title.length).toBeLessThan(longTitle.length);
      expect(proposal.title.endsWith("…")).toBe(true);
      // Nothing lost: full original title + body + provenance all present.
      expect(proposal.description).toContain(longTitle);
      expect(proposal.description).toContain("repro steps here");
      expect(proposal.description).toContain(`Promoted from note ${created.id}`);
    });

    it("uses caller-supplied title/description verbatim (no provenance append)", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "note title", body: "note body" },
        author.id,
      );

      const { proposal } = noteService.promoteToProposal(
        created.id,
        { id: author.id, type: "human" },
        { title: "explicit title", description: "explicit description" },
      );

      expect(proposal.title).toBe("explicit title");
      expect(proposal.description).toBe("explicit description");
      expect(proposal.description).not.toContain("Promoted from note");
    });

    it("throws 409 INVALID_STATUS on an already-triaged note AND creates no orphan proposal", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "promote twice" },
        author.id,
      );
      noteService.promoteToProposal(created.id, { id: author.id, type: "human" });

      const before = testApp.db.select().from(proposals).all().length;

      try {
        noteService.promoteToProposal(created.id, { id: author.id, type: "human" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).code).toBe("INVALID_STATUS");
      }

      const after = testApp.db.select().from(proposals).all().length;
      expect(after).toBe(before); // no orphan proposal
    });

    it("throws 404 for a missing note", () => {
      const author = createTestUser(testApp.db);
      try {
        noteService.promoteToProposal(createId(), { id: author.id, type: "human" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
      }
    });

    it("lets a non-author ai_agent promote (contrast with dismiss)", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db, { type: "ai_agent" });
      const other = createTestUser(testApp.db, { type: "ai_agent" });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "not author but can promote" },
        author.id,
      );

      const { note, proposal } = noteService.promoteToProposal(created.id, {
        id: other.id,
        type: "ai_agent",
      });

      expect(note.status).toBe("triaged");
      expect(note.triagedBy).toBe(other.id);
      expect(proposal.createdBy).toBe(other.id);
    });

    it("emits NOTE_PROMOTED → 'promoted' note row AND a 'created' proposal row", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "emits promote events" },
        author.id,
      );

      const { proposal } = noteService.promoteToProposal(created.id, {
        id: author.id,
        type: "human",
      });

      const noteRows = activityRows(created.id);
      const promoted = noteRows.find((r) => r.action === "promoted");
      expect(promoted).toBeDefined();
      expect(promoted!.entityType).toBe("note");
      expect(promoted!.actorId).toBe(author.id);
      expect(promoted!.projectId).toBe(project.id);

      const proposalRows = activityRows(proposal.id);
      const proposalCreated = proposalRows.find((r) => r.action === "created");
      expect(proposalCreated).toBeDefined();
      expect(proposalCreated!.entityType).toBe("proposal");
    });
  });

  // ── promoteToTask (C2 §P4 — HUMAN-ONLY escape hatch + provenance) ──
  describe("promoteToTask", () => {
    function taskById(id: string) {
      return testApp.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
    }

    it("promotes an OPEN note to a task with provenance + defaults (feature/medium/backlog)", () => {
      const project = createTestProject(testApp.db);
      const human = createTestUser(testApp.db, { type: "human" });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "needs a task" },
        human.id,
      );

      const { note, task } = noteService.promoteToTask(created.id, {
        id: human.id,
        type: "human",
      });

      // Task shape + provenance + reporter.
      expect(task.sourceNoteId).toBe(note.id);
      expect(task.reporterId).toBe(human.id);
      expect(task.projectId).toBe(project.id);
      expect(task.type).toBe("feature");
      expect(task.priority).toBe("medium");
      expect(task.status).toBe("backlog");

      // Note terminally triaged with the promoted-task back-pointer.
      expect(note.status).toBe("triaged");
      expect(note.triageOutcome).toBe("promoted");
      expect(note.triagedBy).toBe(human.id);
      expect(note.triagedAt).toBeTruthy();
      expect(note.promotedTaskId).toBe(task.id);
      expect(note.promotedProposalId).toBeNull();
    });

    it("derives default title/description from the note (incl. provenance line)", () => {
      const project = createTestProject(testApp.db);
      const human = createTestUser(testApp.db, { type: "human" });
      const created = noteService.create(
        project.id,
        { kind: "idea", title: "title from note", body: "the body text" },
        human.id,
      );

      const { task } = noteService.promoteToTask(created.id, { id: human.id, type: "human" });

      expect(task.title).toBe("title from note");
      expect(task.description).toContain("the body text");
      expect(task.description).toContain(`Promoted from note ${created.id}`);
    });

    it("includes a Location line when the note has a codeLocator", () => {
      const project = createTestProject(testApp.db);
      const human = createTestUser(testApp.db, { type: "human" });
      const created = noteService.create(
        project.id,
        {
          kind: "bug",
          title: "located bug",
          codeLocator: { path: "src/foo.ts", line: 42, commitSha: "abc123" },
        },
        human.id,
      );

      const { task } = noteService.promoteToTask(created.id, { id: human.id, type: "human" });
      expect(task.description).toContain("Location: src/foo.ts:42 @ abc123");
    });

    it("shortens a pathologically-long title to a topic and carries the full content into the description", () => {
      const project = createTestProject(testApp.db);
      const human = createTestUser(testApp.db, { type: "human" });
      const longTitle =
        "The rendering pipeline silently drops the second draw call whenever the depth buffer is cleared mid-frame and this only reproduces on the integrated GPU";
      const created = noteService.create(
        project.id,
        { kind: "bug", title: longTitle, body: "repro steps here" },
        human.id,
      );

      const { task } = noteService.promoteToTask(created.id, { id: human.id, type: "human" });

      expect(task.title.length).toBeLessThan(longTitle.length);
      expect(task.title.endsWith("…")).toBe(true);
      expect(task.description).toContain(longTitle);
      expect(task.description).toContain("repro steps here");
      expect(task.description).toContain(`Promoted from note ${created.id}`);
    });

    it("uses caller-supplied title/description verbatim (no provenance append)", () => {
      const project = createTestProject(testApp.db);
      const human = createTestUser(testApp.db, { type: "human" });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "note title", body: "note body" },
        human.id,
      );

      const { task } = noteService.promoteToTask(
        created.id,
        { id: human.id, type: "human" },
        { title: "explicit title", description: "explicit description" },
      );

      expect(task.title).toBe("explicit title");
      expect(task.description).toBe("explicit description");
      expect(task.description).not.toContain("Promoted from note");
    });

    it("links the task to a given epicId", () => {
      const project = createTestProject(testApp.db);
      const human = createTestUser(testApp.db, { type: "human" });
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "epic-linked" },
        human.id,
      );

      const { task } = noteService.promoteToTask(
        created.id,
        { id: human.id, type: "human" },
        { epicId: epic.id },
      );

      expect(task.epicId).toBe(epic.id);
    });

    it("throws 403 FORBIDDEN for an ai_agent AND creates no orphan task (note stays open)", () => {
      const project = createTestProject(testApp.db);
      const agent = createTestUser(testApp.db, { type: "ai_agent" });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "not for AI" },
        agent.id,
      );

      const before = testApp.db.select().from(tasks).all().length;

      try {
        noteService.promoteToTask(created.id, { id: agent.id, type: "ai_agent" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(403);
        expect((err as AppError).code).toBe("FORBIDDEN");
      }

      expect(testApp.db.select().from(tasks).all().length).toBe(before);
      expect(noteService.getById(created.id).status).toBe("open");
    });

    it("throws 409 INVALID_STATUS on an already-triaged note AND creates no orphan task", () => {
      const project = createTestProject(testApp.db);
      const human = createTestUser(testApp.db, { type: "human" });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "promote twice" },
        human.id,
      );
      noteService.promoteToTask(created.id, { id: human.id, type: "human" });

      const before = testApp.db.select().from(tasks).all().length;

      try {
        noteService.promoteToTask(created.id, { id: human.id, type: "human" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).code).toBe("INVALID_STATUS");
      }

      expect(testApp.db.select().from(tasks).all().length).toBe(before);
    });

    it("throws 404 for a missing note", () => {
      const human = createTestUser(testApp.db, { type: "human" });
      try {
        noteService.promoteToTask(createId(), { id: human.id, type: "human" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
      }
    });

    it("emits NOTE_PROMOTED → 'promoted' note row AND a 'created' task row", () => {
      const project = createTestProject(testApp.db);
      const human = createTestUser(testApp.db, { type: "human" });
      const created = noteService.create(
        project.id,
        { kind: "bug", title: "emits promote-to-task events" },
        human.id,
      );

      const { task } = noteService.promoteToTask(created.id, { id: human.id, type: "human" });

      const noteRows = activityRows(created.id);
      const promoted = noteRows.find((r) => r.action === "promoted");
      expect(promoted).toBeDefined();
      expect(promoted!.entityType).toBe("note");
      expect(promoted!.actorId).toBe(human.id);
      expect(promoted!.projectId).toBe(project.id);

      const taskRows = activityRows(task.id);
      const taskCreated = taskRows.find((r) => r.action === "created");
      expect(taskCreated).toBeDefined();
      expect(taskCreated!.entityType).toBe("task");

      // sanity: provenance persisted on the task row.
      expect(taskById(task.id).sourceNoteId).toBe(created.id);
    });
  });

  // ── findSimilarOpenNotes (advisory dedup, §P4) ──────────────────
  describe("findSimilarOpenNotes", () => {
    it("surfaces a near-duplicate OPEN note sharing a distinctive title term", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const existing = noteService.create(
        project.id,
        { kind: "bug", title: "Login flickers on the dashboard" },
        author.id,
      );

      const hits = noteService.findSimilarOpenNotes(project.id, "Login flickers");
      expect(hits.some((h) => h.id === existing.id)).toBe(true);
      const hit = hits.find((h) => h.id === existing.id)!;
      expect(hit).toMatchObject({ id: existing.id, title: existing.title, kind: "bug" });
    });

    it("does not surface a distinct (non-matching) note", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      noteService.create(
        project.id,
        { kind: "idea", title: "Completely unrelated zebra topic" },
        author.id,
      );

      const hits = noteService.findSimilarOpenNotes(project.id, "Login flickers");
      expect(hits).toHaveLength(0);
    });

    it("excludes a triaged near-duplicate (status != open)", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      testApp.db
        .insert(notes)
        .values({
          id: createId(),
          projectId: project.id,
          kind: "bug",
          status: "triaged",
          title: "Login flickers on the dashboard",
          authorId: author.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();

      const hits = noteService.findSimilarOpenNotes(project.id, "Login flickers");
      expect(hits).toHaveLength(0);
    });

    it("excludes a near-duplicate in another project", () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      noteService.create(
        projectB.id,
        { kind: "bug", title: "Login flickers on the dashboard" },
        author.id,
      );

      const hits = noteService.findSimilarOpenNotes(projectA.id, "Login flickers");
      expect(hits).toHaveLength(0);
    });

    it("returns [] for empty/whitespace input", () => {
      const project = createTestProject(testApp.db);
      expect(noteService.findSimilarOpenNotes(project.id, "")).toEqual([]);
      expect(noteService.findSimilarOpenNotes(project.id, "   ")).toEqual([]);
    });

    it("a throwing FTS query → [] AND a console.warn (C2 de-silence: never silent)", () => {
      const project = createTestProject(testApp.db);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        // Break the FTS table so the MATCH query throws inside the try.
        getRawDb().exec("DROP TABLE notes_fts");
        const hits = noteService.findSimilarOpenNotes(project.id, "anything here");
        expect(hits).toEqual([]); // advisory fallback unchanged
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toContain("[notes-dedup]");
        expect(String(warnSpy.mock.calls[0][0])).toContain("advisory");
      } finally {
        warnSpy.mockRestore();
      }
    });

    // ── P3: dedup two-pass OR-fallback ──────────────────────────────
    it("with an AND-hit present, the OR fallback does NOT fire", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);

      // Note containing ALL query tokens → the AND pass hits.
      const full = noteService.create(
        project.id,
        { kind: "bug", title: "alpha bravo charlie delta echo" },
        author.id,
      );
      // Notes sharing only SOME tokens → must NOT surface while AND hits.
      const partialA = noteService.create(
        project.id,
        { kind: "idea", title: "alpha bravo zulu" },
        author.id,
      );
      const partialB = noteService.create(
        project.id,
        { kind: "idea", title: "charlie delta yankee" },
        author.id,
      );

      const hits = noteService.findSimilarOpenNotes(project.id, "alpha bravo charlie delta echo");
      const ids = hits.map((h) => h.id);
      expect(ids).toContain(full.id);
      expect(ids).not.toContain(partialA.id);
      expect(ids).not.toContain(partialB.id);
    });

    it("with zero AND-hits, the OR fallback surfaces a partial overlap", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);

      // Shares ~2 of 5 query words; no note contains all five → AND = 0.
      const partial = noteService.create(
        project.id,
        { kind: "bug", title: "alpha bravo unrelated topic here" },
        author.id,
      );

      const hits = noteService.findSimilarOpenNotes(project.id, "alpha bravo charlie delta echo");
      expect(hits.some((h) => h.id === partial.id)).toBe(true);
    });

    it("caps the OR fallback at top-3", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);

      // Five partial-overlap open notes, each sharing some-but-not-all
      // query tokens → AND = 0, OR fires.
      for (const word of ["alpha", "bravo", "charlie", "delta", "echo"]) {
        noteService.create(
          project.id,
          { kind: "idea", title: `${word} solo overlap line` },
          author.id,
        );
      }

      const hits = noteService.findSimilarOpenNotes(project.id, "alpha bravo charlie delta echo");
      expect(hits.length).toBeLessThanOrEqual(3);
    });

    it("excludes a triaged partial overlap from the OR fallback", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      testApp.db
        .insert(notes)
        .values({
          id: createId(),
          projectId: project.id,
          kind: "bug",
          status: "triaged",
          title: "alpha bravo unrelated topic here",
          authorId: author.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();

      const hits = noteService.findSimilarOpenNotes(project.id, "alpha bravo charlie delta echo");
      expect(hits).toHaveLength(0);
    });

    it("excludes an other-project partial overlap from the OR fallback", () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      noteService.create(
        projectB.id,
        { kind: "bug", title: "alpha bravo unrelated topic here" },
        author.id,
      );

      const hits = noteService.findSimilarOpenNotes(projectA.id, "alpha bravo charlie delta echo");
      expect(hits).toHaveLength(0);
    });

    it("handles a token-flood body (>15 tokens) without throwing, cap applies", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const partial = noteService.create(
        project.id,
        { kind: "bug", title: "alpha bravo unrelated topic here" },
        author.id,
      );

      // 20 distinct tokens; only the first few overlap the partial note,
      // none combine into an AND hit.
      const floodTokens = ["alpha", "bravo", ...Array.from({ length: 18 }, (_, i) => `tok${i}`)];
      const hits = noteService.findSimilarOpenNotes(project.id, floodTokens.join(" "));
      expect(hits.length).toBeLessThanOrEqual(3);
      // sanity: the OR fallback still surfaces the partial overlap.
      expect(hits.some((h) => h.id === partial.id)).toBe(true);
    });
  });

  // ── enrichment (Campaign C4) ────────────────────────────────────
  describe("enrichment (anchor / promotedTarget)", () => {
    it("anchors to EXISTING targets carry {exists:true, title} for all three types", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: author.id,
        title: "anchored task",
      });
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: author.id,
        name: "anchored epic",
      });
      const proposal = createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: author.id,
        title: "anchored proposal",
      });

      const onTask = noteService.create(
        project.id,
        { kind: "bug", title: "on task", anchorType: "task", anchorId: task.id },
        author.id,
      );
      const onEpic = noteService.create(
        project.id,
        { kind: "idea", title: "on epic", anchorType: "epic", anchorId: epic.id },
        author.id,
      );
      const onProposal = noteService.create(
        project.id,
        { kind: "question", title: "on proposal", anchorType: "proposal", anchorId: proposal.id },
        author.id,
      );

      const list = noteService.list(project.id, {});
      const byId = new Map(list.map((n) => [n.id, n]));
      expect(byId.get(onTask.id)!.anchor).toEqual({ exists: true, title: "anchored task" });
      expect(byId.get(onEpic.id)!.anchor).toEqual({ exists: true, title: "anchored epic" });
      expect(byId.get(onProposal.id)!.anchor).toEqual({
        exists: true,
        title: "anchored proposal",
      });
    });

    it("DANGLING anchors read {exists:false, title:null} for all three types (no FK on anchors)", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);

      const onTask = noteService.create(
        project.id,
        { kind: "bug", title: "gone task", anchorType: "task", anchorId: createId() },
        author.id,
      );
      const onEpic = noteService.create(
        project.id,
        { kind: "idea", title: "gone epic", anchorType: "epic", anchorId: createId() },
        author.id,
      );
      const onProposal = noteService.create(
        project.id,
        { kind: "wtf", title: "gone proposal", anchorType: "proposal", anchorId: createId() },
        author.id,
      );

      const list = noteService.list(project.id, {});
      const byId = new Map(list.map((n) => [n.id, n]));
      for (const id of [onTask.id, onEpic.id, onProposal.id]) {
        expect(byId.get(id)!.anchor).toEqual({ exists: false, title: null });
      }
    });

    it("mixed existing + dangling anchors in one list are each decorated truthfully", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: author.id,
        title: "still here",
      });

      const live = noteService.create(
        project.id,
        { kind: "bug", title: "live anchor", anchorType: "task", anchorId: task.id },
        author.id,
      );
      const dangling = noteService.create(
        project.id,
        { kind: "bug", title: "dead anchor", anchorType: "task", anchorId: createId() },
        author.id,
      );

      const list = noteService.list(project.id, {});
      const byId = new Map(list.map((n) => [n.id, n]));
      expect(byId.get(live.id)!.anchor).toEqual({ exists: true, title: "still here" });
      expect(byId.get(dangling.id)!.anchor).toEqual({ exists: false, title: null });
    });

    it("an unanchored, unpromoted note reads anchor:null and promotedTarget:null", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const note = noteService.create(
        project.id,
        { kind: "observation", title: "free" },
        author.id,
      );

      const fetched = noteService.getById(note.id);
      expect(fetched.anchor).toBeNull();
      expect(fetched.promotedTarget).toBeNull();
    });

    it("a promoted-to-proposal note carries promotedTarget {exists:true, title} (list + getById)", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);
      const note = noteService.create(project.id, { kind: "idea", title: "promote me" }, author.id);

      const { proposal } = noteService.promoteToProposal(note.id, {
        id: author.id,
        type: "human",
      });

      const fetched = noteService.getById(note.id);
      expect(fetched.promotedTarget).toEqual({ exists: true, title: proposal.title });

      const listed = noteService.list(project.id, {}).find((n) => n.id === note.id)!;
      expect(listed.promotedTarget).toEqual({ exists: true, title: proposal.title });
    });

    it("a promoted-to-task note carries promotedTarget {exists:true, title}", () => {
      const project = createTestProject(testApp.db);
      const human = createTestUser(testApp.db, { type: "human" });
      const note = noteService.create(project.id, { kind: "bug", title: "task me" }, human.id);

      const { task } = noteService.promoteToTask(note.id, { id: human.id, type: "human" });

      const fetched = noteService.getById(note.id);
      expect(fetched.promotedTarget).toEqual({ exists: true, title: task.title });
    });

    it("a DANGLING promoted target reads {exists:false, title:null} (forged — FKs make it unrepresentable normally)", () => {
      // promotedTaskId/promotedProposalId are real FKs with onDelete:"set null"
      // under PRAGMA foreign_keys=ON, so a dangling promoted target cannot be
      // produced via normal writes. Forge the rows with foreign_keys=OFF —
      // NEVER weaken the schema to make this representable.
      const project = createTestProject(testApp.db);
      const human = createTestUser(testApp.db, { type: "human" });
      const viaTask = noteService.create(project.id, { kind: "bug", title: "t" }, human.id);
      const viaProposal = noteService.create(project.id, { kind: "idea", title: "p" }, human.id);
      noteService.promoteToTask(viaTask.id, { id: human.id, type: "human" });
      noteService.promoteToProposal(viaProposal.id, { id: human.id, type: "human" });

      const raw = getRawDb();
      raw.pragma("foreign_keys = OFF");
      try {
        raw
          .prepare("UPDATE notes SET promoted_task_id = ? WHERE id = ?")
          .run(createId(), viaTask.id);
        raw
          .prepare("UPDATE notes SET promoted_proposal_id = ? WHERE id = ?")
          .run(createId(), viaProposal.id);
      } finally {
        raw.pragma("foreign_keys = ON");
      }

      const list = noteService.list(project.id, {});
      const byId = new Map(list.map((n) => [n.id, n]));
      expect(byId.get(viaTask.id)!.promotedTarget).toEqual({ exists: false, title: null });
      expect(byId.get(viaProposal.id)!.promotedTarget).toEqual({ exists: false, title: null });
    });

    it("issues the SAME number of prepared statements for 5 notes as for 50 (batched inArray, no N+1)", () => {
      const author = createTestUser(testApp.db);
      const seed = (count: number) => {
        const project = createTestProject(testApp.db);
        for (let i = 0; i < count; i++) {
          // Mixed anchor types so all three enrichment lookups are exercised.
          const anchor =
            i % 3 === 0
              ? {
                  anchorType: "task" as const,
                  anchorId: createTestTask(testApp.db, {
                    projectId: project.id,
                    reporterId: author.id,
                  }).id,
                }
              : i % 3 === 1
                ? {
                    anchorType: "epic" as const,
                    anchorId: createTestEpic(testApp.db, {
                      projectId: project.id,
                      createdBy: author.id,
                    }).id,
                  }
                : {
                    anchorType: "proposal" as const,
                    anchorId: createTestProposal(testApp.db, {
                      projectId: project.id,
                      createdBy: author.id,
                    }).id,
                  };
          noteService.create(project.id, { kind: "bug", title: `note ${i}`, ...anchor }, author.id);
        }
        return project.id;
      };

      const projectWith5 = seed(5);
      const projectWith50 = seed(50);

      const spy = vi.spyOn(Database.prototype, "prepare");
      try {
        noteService.list(projectWith5, {});
        const preparesFor5 = spy.mock.calls.length;
        spy.mockClear();
        noteService.list(projectWith50, {});
        const preparesFor50 = spy.mock.calls.length;

        // EQUALITY — the statement count is a function of the number of
        // referenced entity TYPES (1 notes select + ≤3 enrichment selects),
        // never of the number of notes.
        expect(preparesFor50).toBe(preparesFor5);
        expect(preparesFor5).toBeLessThanOrEqual(4);
        expect(preparesFor5).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── activity integration ────────────────────────────────────────
  describe("activity_log integration", () => {
    it("writes a 'created' activity row on create and 'updated' on update", () => {
      const project = createTestProject(testApp.db);
      const author = createTestUser(testApp.db);

      const note = noteService.create(
        project.id,
        { kind: "bug", title: "needs a log row" },
        author.id,
      );

      let rows = activityRows(note.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe("note");
      expect(rows[0].action).toBe("created");
      expect(rows[0].projectId).toBe(project.id);
      expect(rows[0].actorId).toBe(author.id);

      noteService.update(note.id, { title: "updated title" }, author.id);

      rows = testApp.db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityId, note.id), eq(activityLog.action, "updated")))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe("note");
    });
  });
});
