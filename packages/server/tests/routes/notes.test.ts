import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestProject,
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
});
