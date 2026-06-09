import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  createTestApp,
  createTestProject,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { activityLog, notes } from "../../src/db/index.js";
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
    return testApp.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, entityId))
      .all();
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
        noteService.create(
          createId(),
          { kind: "idea", title: "nope" },
          author.id,
        );
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
