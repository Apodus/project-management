import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestProject,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";

describe("Milestones API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── GET /api/v1/projects/:projectId/milestones ────────────────

  describe("GET /api/v1/projects/:projectId/milestones", () => {
    it("should return empty list when no milestones exist", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/milestones`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it("should return 404 for non-existent project", async () => {
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${createId()}/milestones`,
      );
      expect(res.status).toBe(404);
    });

    it("should list milestones for a project", async () => {
      const project = createTestProject(testApp.db);

      // Create two milestones
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/milestones`,
        { body: { name: "v1.0" } },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/milestones`,
        { body: { name: "v2.0" } },
      );

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/milestones`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.length).toBe(2);
      expect(body.pagination.total).toBe(2);
    });
  });

  // ── POST /api/v1/projects/:projectId/milestones ───────────────

  describe("POST /api/v1/projects/:projectId/milestones", () => {
    it("should create a milestone with required fields", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/milestones`,
        { body: { name: "Beta Release" } },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toBe("Beta Release");
      expect(body.data.projectId).toBe(project.id);
      expect(body.data.status).toBe("open");
      expect(body.data.description).toBeNull();
      expect(body.data.targetDate).toBeNull();
    });

    it("should create a milestone with all optional fields", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/milestones`,
        {
          body: {
            name: "GA Release",
            description: "General availability release",
            targetDate: "2026-06-15",
            status: "open",
            sortOrder: 1,
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toBe("GA Release");
      expect(body.data.description).toBe("General availability release");
      expect(body.data.targetDate).toBe("2026-06-15");
      expect(body.data.sortOrder).toBe(1);
    });

    it("should return 400 for missing name", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/milestones`,
        { body: {} },
      );
      expect(res.status).toBe(400);
    });

    it("should return 404 for non-existent project", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${createId()}/milestones`,
        { body: { name: "Orphan Milestone" } },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── PATCH /api/v1/milestones/:id ──────────────────────────────

  describe("PATCH /api/v1/milestones/:id", () => {
    it("should update milestone fields", async () => {
      const project = createTestProject(testApp.db);

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/milestones`,
        { body: { name: "Original Name" } },
      );
      const milestone = (await createRes.json()).data;

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/milestones/${milestone.id}`,
        {
          body: {
            name: "Updated Name",
            description: "Now with description",
            status: "closed",
          },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.name).toBe("Updated Name");
      expect(body.data.description).toBe("Now with description");
      expect(body.data.status).toBe("closed");
    });

    it("should return 404 for non-existent milestone", async () => {
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/milestones/${createId()}`,
        { body: { name: "Ghost" } },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /api/v1/milestones/:id ─────────────────────────────

  describe("DELETE /api/v1/milestones/:id", () => {
    it("should delete a milestone", async () => {
      const project = createTestProject(testApp.db);

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/milestones`,
        { body: { name: "Delete Me" } },
      );
      const milestone = (await createRes.json()).data;

      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/milestones/${milestone.id}`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.id).toBe(milestone.id);

      // Verify it's gone
      const listRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/milestones`,
      );
      const listBody = await listRes.json();
      expect(listBody.data.length).toBe(0);
    });

    it("should return 404 for non-existent milestone", async () => {
      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/milestones/${createId()}`,
      );
      expect(res.status).toBe(404);
    });
  });
});
