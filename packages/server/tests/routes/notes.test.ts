import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestProject,
  createTestAiAgent,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";

describe("Notes API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── POST /api/v1/projects/:projectId/notes ───────────────────────
  describe("POST /api/v1/projects/:projectId/notes", () => {
    it("creates a note and returns a {data} envelope", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/notes`,
        { body: { kind: "bug", title: "Flicker", severity: "high" } },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.id).toBeTruthy();
      expect(body.data.kind).toBe("bug");
      expect(body.data.title).toBe("Flicker");
      expect(body.data.status).toBe("open");
      expect(body.data.severity).toBe("high");
    });

    it("attributes authorId to the caller, ignoring any authorId in the body", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/notes`,
        { body: { kind: "idea", title: "mine", authorId: "bogus-spoofed-id" } },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.authorId).toBe(testApp.testUser.id);
      expect(body.data.authorId).not.toBe("bogus-spoofed-id");
    });

    it("returns similar: [] when no open duplicate exists", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/notes`,
        { body: { kind: "bug", title: "Totally novel zorvex finding" } },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.similar).toEqual([]);
    });

    it("populates similar ({id,title,kind}) when a matching OPEN note pre-exists in the same project, still 201", async () => {
      const project = createTestProject(testApp.db);

      const first = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          body: { kind: "bug", title: "Cursor blinks on the widget panel" },
        })
      ).json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/notes`,
        { body: { kind: "bug", title: "Cursor blinks widget" } },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(Array.isArray(body.similar)).toBe(true);
      const hit = body.similar.find((s: { id: string }) => s.id === first.data.id);
      expect(hit).toBeDefined();
      expect(hit).toMatchObject({ id: first.data.id, title: first.data.title, kind: "bug" });
    });

    it("returns 404 when the project does not exist", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${createId()}/notes`,
        { body: { kind: "bug", title: "x" } },
      );
      expect(res.status).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
      const project = createTestProject(testApp.db);
      const res = await testApp.app.request(
        `/api/v1/projects/${project.id}/notes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "bug", title: "x" }),
        },
      );
      expect(res.status).toBe(401);
    });
  });

  // ── GET /api/v1/notes/:id ────────────────────────────────────────
  describe("GET /api/v1/notes/:id", () => {
    it("returns the note", async () => {
      const project = createTestProject(testApp.db);
      const created = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          body: { kind: "question", title: "why" },
        })
      ).json();

      const res = await authRequest(testApp.app, "GET", `/api/v1/notes/${created.data.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(created.data.id);
      expect(body.data.title).toBe("why");
    });

    it("returns 404 for a missing note", async () => {
      const res = await authRequest(testApp.app, "GET", `/api/v1/notes/${createId()}`);
      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/v1/projects/:projectId/notes ────────────────────────
  describe("GET /api/v1/projects/:projectId/notes", () => {
    it("returns a {data, pagination:{total}} envelope, project-scoped", async () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);

      await authRequest(testApp.app, "POST", `/api/v1/projects/${projectA.id}/notes`, {
        body: { kind: "bug", title: "a1" },
      });
      await authRequest(testApp.app, "POST", `/api/v1/projects/${projectA.id}/notes`, {
        body: { kind: "idea", title: "a2" },
      });
      await authRequest(testApp.app, "POST", `/api/v1/projects/${projectB.id}/notes`, {
        body: { kind: "bug", title: "b1" },
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${projectA.id}/notes`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination).toEqual({ total: 2 });
    });

    it("filters by kind", async () => {
      const project = createTestProject(testApp.db);
      await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
        body: { kind: "bug", title: "b" },
      });
      await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
        body: { kind: "idea", title: "i" },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/notes?kind=bug`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].kind).toBe("bug");
    });
  });

  // ── PATCH /api/v1/notes/:id ──────────────────────────────────────
  describe("PATCH /api/v1/notes/:id", () => {
    it("updates an open note (200)", async () => {
      const project = createTestProject(testApp.db);
      const created = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          body: { kind: "bug", title: "before" },
        })
      ).json();

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/notes/${created.data.id}`, {
        body: { title: "after" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.title).toBe("after");
    });

    it("returns 409 when the note is triaged", async () => {
      const project = createTestProject(testApp.db);
      const id = createId();
      const { notes } = await import("../../src/db/index.js");
      testApp.db
        .insert(notes)
        .values({
          id,
          projectId: project.id,
          kind: "bug",
          status: "triaged",
          title: "triaged",
          authorId: testApp.testUser.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/notes/${id}`, {
        body: { title: "nope" },
      });
      expect(res.status).toBe(409);
    });

    it("returns 404 for a missing note", async () => {
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/notes/${createId()}`, {
        body: { title: "x" },
      });
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/notes/:id/dismiss (C2 §P2) ──────────────────────
  describe("POST /api/v1/notes/:id/dismiss", () => {
    it("dismisses an open note (200, human dismiss)", async () => {
      const project = createTestProject(testApp.db);
      const created = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          body: { kind: "bug", title: "to dismiss" },
        })
      ).json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/notes/${created.data.id}/dismiss`,
        { body: { reason: "wontfix" } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("triaged");
      expect(body.data.triageOutcome).toBe("dismissed");
      expect(body.data.triageReason).toBe("wontfix");
      expect(body.data.triagedBy).toBe(testApp.testUser.id);
    });

    it("returns 400 for an empty reason", async () => {
      const project = createTestProject(testApp.db);
      const created = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          body: { kind: "bug", title: "needs reason" },
        })
      ).json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/notes/${created.data.id}/dismiss`,
        { body: { reason: "" } },
      );
      expect(res.status).toBe(400);
    });

    it("returns 403 when a different ai_agent tries to dismiss another agent's note", async () => {
      const project = createTestProject(testApp.db);
      const author = createTestAiAgent(testApp.db);
      const other = createTestAiAgent(testApp.db);

      const created = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          token: author.token,
          body: { kind: "bug", title: "agent-owned" },
        })
      ).json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/notes/${created.data.id}/dismiss`,
        { token: other.token, body: { reason: "sweep" } },
      );
      expect(res.status).toBe(403);
    });

    it("returns 404 for an unknown note id", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/notes/${createId()}/dismiss`,
        { body: { reason: "x" } },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/notes/:id/promote-to-proposal (C2 §P3) ──────────
  describe("POST /api/v1/notes/:id/promote-to-proposal", () => {
    it("promotes an open note to a proposal (200, provenance round-trip)", async () => {
      const project = createTestProject(testApp.db);
      const created = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          body: { kind: "bug", title: "to promote", body: "body text" },
        })
      ).json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/notes/${created.data.id}/promote-to-proposal`,
        { body: { title: "Fix the bug", description: "do the thing" } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("triaged");
      expect(body.data.triageOutcome).toBe("promoted");
      expect(body.data.promotedProposalId).toBe(body.proposal.id);
      expect(body.proposal.sourceNoteId).toBe(body.data.id);
      expect(body.proposal.createdBy).toBe(testApp.testUser.id);
    });

    it("derives default title/description from the note for an empty body {}", async () => {
      const project = createTestProject(testApp.db);
      const created = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          body: { kind: "idea", title: "default title", body: "default body" },
        })
      ).json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/notes/${created.data.id}/promote-to-proposal`,
        { body: {} },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.proposal.title).toBe("default title");
      expect(body.proposal.description).toContain("default body");
      expect(body.proposal.description).toContain(`Promoted from note ${created.data.id}`);
    });

    it("returns 404 for an unknown note id", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/notes/${createId()}/promote-to-proposal`,
        { body: {} },
      );
      expect(res.status).toBe(404);
    });

    it("returns 409 when promoting an already-triaged note", async () => {
      const project = createTestProject(testApp.db);
      const created = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          body: { kind: "bug", title: "promote twice" },
        })
      ).json();

      // First dismiss → terminal triaged; then promote must 409.
      await authRequest(testApp.app, "POST", `/api/v1/notes/${created.data.id}/dismiss`, {
        body: { reason: "wontfix" },
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/notes/${created.data.id}/promote-to-proposal`,
        { body: {} },
      );
      expect(res.status).toBe(409);
    });
  });

  // ── POST /api/v1/notes/:id/promote-to-task (C2 §P4, HUMAN-ONLY) ──
  describe("POST /api/v1/notes/:id/promote-to-task", () => {
    it("promotes an open note to a task (200, human, provenance round-trip)", async () => {
      const project = createTestProject(testApp.db);
      const created = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          body: { kind: "bug", title: "to taskify", body: "body text" },
        })
      ).json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/notes/${created.data.id}/promote-to-task`,
        { body: { title: "Do the work" } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("triaged");
      expect(body.data.triageOutcome).toBe("promoted");
      expect(body.data.promotedTaskId).toBe(body.task.id);
      expect(body.task.sourceNoteId).toBe(body.data.id);
      expect(body.task.reporterId).toBe(testApp.testUser.id);
    });

    it("returns 403 for an ai_agent token (human-only) and creates no task", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const created = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          token: agent.token,
          body: { kind: "bug", title: "agent-owned" },
        })
      ).json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/notes/${created.data.id}/promote-to-task`,
        { token: agent.token, body: {} },
      );
      expect(res.status).toBe(403);
    });

    it("returns 404 for an unknown note id", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/notes/${createId()}/promote-to-task`,
        { body: {} },
      );
      expect(res.status).toBe(404);
    });

    it("returns 409 when promoting an already-triaged note (dismiss-then-promote)", async () => {
      const project = createTestProject(testApp.db);
      const created = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          body: { kind: "bug", title: "triage twice" },
        })
      ).json();

      await authRequest(testApp.app, "POST", `/api/v1/notes/${created.data.id}/dismiss`, {
        body: { reason: "wontfix" },
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/notes/${created.data.id}/promote-to-task`,
        { body: {} },
      );
      expect(res.status).toBe(409);
    });
  });

  // ── activity-feed enrichment ─────────────────────────────────────
  describe("activity feed enrichment", () => {
    it("surfaces the note in the project activity feed with entityType 'note' and its title", async () => {
      const project = createTestProject(testApp.db);
      const created = await (
        await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
          body: { kind: "bug", title: "Enrich me" },
        })
      ).json();

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}/activity`);
      expect(res.status).toBe(200);
      const body = await res.json();

      const entry = body.data.find(
        (e: { entityType: string; entityId: string }) =>
          e.entityType === "note" && e.entityId === created.data.id,
      );
      expect(entry).toBeDefined();
      expect(entry.entityTitle).toBe("Enrich me");
    });
  });

  // ── GET /api/v1/projects/:projectId/notes/health (Campaign C2 §P5) ─
  describe("GET /api/v1/projects/:projectId/notes/health", () => {
    it("returns a {data:{open_count, oldest_untriaged_age_ms}} envelope", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/notes/health`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.open_count).toBe(0);
      expect(body.data.oldest_untriaged_age_ms).toBeNull();
    });

    it("counts open notes in the envelope", async () => {
      const project = createTestProject(testApp.db);
      await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/notes`, {
        body: { kind: "bug", title: "open one" },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/notes/health`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.open_count).toBe(1);
      expect(typeof body.data.oldest_untriaged_age_ms).toBe("number");
    });

    it("returns 404 when the project does not exist", async () => {
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${createId()}/notes/health`,
      );
      expect(res.status).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
      const project = createTestProject(testApp.db);
      const res = await testApp.app.request(`/api/v1/projects/${project.id}/notes/health`, {
        method: "GET",
      });
      expect(res.status).toBe(401);
    });
  });
});
