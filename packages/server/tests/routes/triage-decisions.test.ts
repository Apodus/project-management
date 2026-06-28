import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestApp,
  createTestProject,
  createTestAiAgent,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";
import { notes, triageDecisions } from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import * as noteService from "../../src/services/note.service.js";

describe("Triage decisions API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── POST /api/v1/projects/:projectId/triage-decisions ────────────
  describe("POST /api/v1/projects/:projectId/triage-decisions", () => {
    it("records a decision and returns a {data} envelope (201)", async () => {
      const project = createTestProject(testApp.db);
      const note = noteService.create(
        project.id,
        { kind: "bug", title: "finding" },
        testApp.testUser.id,
      );

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/triage-decisions`,
        { body: { noteId: note.id, mode: "shadow", decision: "dismiss", rationale: "noise" } },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.id).toBeTruthy();
      expect(body.data.projectId).toBe(project.id);
      expect(body.data.noteId).toBe(note.id);
      expect(body.data.mode).toBe("shadow");
      expect(body.data.decision).toBe("dismiss");
      expect(body.data.rationale).toBe("noise");
      // actorId is the caller.
      expect(body.data.actorId).toBe(testApp.testUser.id);
    });

    it("attributes actorId to the caller, ignoring any actorId in the body", async () => {
      const project = createTestProject(testApp.db);
      const note = noteService.create(
        project.id,
        { kind: "bug", title: "forge" },
        testApp.testUser.id,
      );

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/triage-decisions`,
        {
          body: { noteId: note.id, mode: "on", decision: "needs_human", actorId: "spoofed-id" },
        },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.actorId).toBe(testApp.testUser.id);
      expect(body.data.actorId).not.toBe("spoofed-id");

      // projectId is derived from the URL.
      const reread = testApp.db
        .select()
        .from(triageDecisions)
        .where(eq(triageDecisions.id, body.data.id))
        .get()!;
      expect(reread.projectId).toBe(project.id);
      expect(reread.actorId).toBe(testApp.testUser.id);
    });

    it("NEVER mutates the note (the side-log invariant, via the wire)", async () => {
      const project = createTestProject(testApp.db);
      const note = noteService.create(
        project.id,
        { kind: "idea", title: "would promote" },
        testApp.testUser.id,
      );

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/triage-decisions`,
        { body: { noteId: note.id, mode: "shadow", decision: "promote_standard" } },
      );
      expect(res.status).toBe(201);

      const reread = testApp.db.select().from(notes).where(eq(notes.id, note.id)).get()!;
      expect(reread.status).toBe("open");
      expect(reread.triageOutcome).toBeNull();
    });

    it("404s on a nonexistent note", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/triage-decisions`,
        { body: { noteId: createId(), mode: "shadow", decision: "dismiss" } },
      );
      expect(res.status).toBe(404);
    });

    it("400s on an invalid decision", async () => {
      const project = createTestProject(testApp.db);
      const note = noteService.create(project.id, { kind: "bug", title: "n" }, testApp.testUser.id);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/triage-decisions`,
        { body: { noteId: note.id, mode: "shadow", decision: "promote" } },
      );
      expect(res.status).toBe(400);
    });

    it("emits TRIAGE_DECISION_RECORDED on the event bus", async () => {
      const project = createTestProject(testApp.db);
      const note = noteService.create(project.id, { kind: "bug", title: "n" }, testApp.testUser.id);
      const frames: unknown[] = [];
      getEventBus().on(EVENT_NAMES.TRIAGE_DECISION_RECORDED, (p) => frames.push(p.entity));

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/triage-decisions`,
        { body: { noteId: note.id, mode: "on", decision: "give_up" } },
      );
      expect(res.status).toBe(201);
      expect(frames.length).toBe(1);
    });
  });

  // ── GET /api/v1/projects/:projectId/triage-decisions ─────────────
  describe("GET /api/v1/projects/:projectId/triage-decisions", () => {
    it("lists a project's decisions with a {data, pagination} envelope", async () => {
      const project = createTestProject(testApp.db);
      const note = noteService.create(project.id, { kind: "bug", title: "n" }, testApp.testUser.id);

      await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/triage-decisions`, {
        body: { noteId: note.id, mode: "shadow", decision: "dismiss" },
      });
      await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/triage-decisions`, {
        body: { noteId: note.id, mode: "on", decision: "promote_standard" },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/triage-decisions`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBe(2);
      expect(body.pagination.total).toBe(2);
    });

    it("filters by mode and decision", async () => {
      const project = createTestProject(testApp.db);
      const note = noteService.create(project.id, { kind: "bug", title: "n" }, testApp.testUser.id);

      await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/triage-decisions`, {
        body: { noteId: note.id, mode: "shadow", decision: "dismiss" },
      });
      await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/triage-decisions`, {
        body: { noteId: note.id, mode: "on", decision: "dismiss" },
      });
      await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/triage-decisions`, {
        body: { noteId: note.id, mode: "on", decision: "promote_standard" },
      });

      const byMode = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/triage-decisions?mode=on`,
      );
      expect((await byMode.json()).data.length).toBe(2);

      const byDecision = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/triage-decisions?decision=dismiss`,
      );
      expect((await byDecision.json()).data.length).toBe(2);

      const combined = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/triage-decisions?mode=on&decision=promote_standard`,
      );
      expect((await combined.json()).data.length).toBe(1);
    });

    it("an ai_agent caller may also record (no extra gate — append-only audit)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const note = noteService.create(project.id, { kind: "bug", title: "n" }, agent.user.id);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/triage-decisions`,
        { token: agent.token, body: { noteId: note.id, mode: "shadow", decision: "needs_human" } },
      );
      expect(res.status).toBe(201);
      expect((await res.json()).data.actorId).toBe(agent.user.id);
    });
  });
});
