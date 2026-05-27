import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestProject,
  createTestTask,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";

describe("Activity API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Activity logged automatically ─────────────────────────────

  describe("Automatic activity logging", () => {
    it("should log activity on project create", async () => {
      // Create a project via the API
      const createRes = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "Activity Test Project" },
      });
      expect(createRes.status).toBe(201);
      const project = (await createRes.json()).data;

      // Check activity feed
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/activity`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      const createActivity = body.data.find(
        (a: any) => a.action === "created" && a.entityType === "project",
      );
      expect(createActivity).toBeDefined();
      expect(createActivity.entityId).toBe(project.id);
    });

    it("should log activity on project update", async () => {
      const createRes = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "Project Before Update" },
      });
      const project = (await createRes.json()).data;

      // Update the project
      await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: { name: "Project After Update" },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/activity`,
      );
      const body = await res.json();

      const updateActivity = body.data.find(
        (a: any) => a.action === "updated" && a.entityType === "project",
      );
      expect(updateActivity).toBeDefined();
    });

    it("should log activity on task create via API", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        { body: { title: "Activity logged task", reporterId: user.id } },
      );
      expect(createRes.status).toBe(201);
      const task = (await createRes.json()).data;

      // Check task activity
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/tasks/${task.id}/activity`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.data.length).toBeGreaterThanOrEqual(1);
      const createActivity = body.data.find(
        (a: any) => a.action === "created" && a.entityType === "task",
      );
      expect(createActivity).toBeDefined();
      expect(createActivity.entityId).toBe(task.id);
    });

    it("should log activity on task status change", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        { body: { title: "Status change task", reporterId: user.id, status: "ready" } },
      );
      const task = (await createRes.json()).data;

      // Transition status via workflow endpoint (ready→in_progress)
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/transitions`, {
        body: { to_status: "in_progress" },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/tasks/${task.id}/activity`,
      );
      const body = await res.json();

      const statusActivity = body.data.find(
        (a: any) => a.action === "status_changed",
      );
      expect(statusActivity).toBeDefined();
      expect(statusActivity.changes).toBeDefined();

      // Parse changes - could be string or object depending on how drizzle returns JSON
      const changes =
        typeof statusActivity.changes === "string"
          ? JSON.parse(statusActivity.changes)
          : statusActivity.changes;
      expect(changes.status.from).toBe("ready");
      expect(changes.status.to).toBe("in_progress");
    });

    it("should log activity on task update (non-status)", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        { body: { title: "Original title", reporterId: user.id } },
      );
      const task = (await createRes.json()).data;

      // Update title
      await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${task.id}`, {
        body: { title: "Updated title" },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/tasks/${task.id}/activity`,
      );
      const body = await res.json();

      const updateActivity = body.data.find(
        (a: any) => a.action === "updated",
      );
      expect(updateActivity).toBeDefined();
    });
  });

  // ── GET /api/v1/projects/:projectId/activity ──────────────────

  describe("GET /api/v1/projects/:projectId/activity", () => {
    it("should return paginated activity feed", async () => {
      const createRes = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "Paginated Activity Project" },
      });
      const project = (await createRes.json()).data;

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/activity?page=1&per_page=10`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.pagination).toBeDefined();
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.perPage).toBe(10);
      expect(body.pagination.total).toBeGreaterThanOrEqual(1);
    });

    it("should filter by entity_type", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      // Create a task (which logs activity for both project create + task create)
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        { body: { title: "Filter test task", reporterId: user.id } },
      );

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/activity?entity_type=task`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      for (const entry of body.data) {
        expect(entry.entityType).toBe("task");
      }
    });
  });

  // ── GET /api/v1/tasks/:taskId/activity ────────────────────────

  describe("GET /api/v1/tasks/:taskId/activity", () => {
    it("should return activity history for a task", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        { body: { title: "History task", reporterId: user.id } },
      );
      const task = (await createRes.json()).data;

      // Do some updates to generate history
      await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${task.id}`, {
        body: { priority: "high" },
      });
      await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${task.id}`, {
        body: { status: "in_progress" },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/tasks/${task.id}/activity`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      // Should have at least 3 entries: created, updated, status_changed
      expect(body.data.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Changes diff recorded correctly ───────────────────────────

  describe("Changes diff", () => {
    it("should record field-level diff correctly", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        {
          body: {
            title: "Diff test task",
            reporterId: user.id,
            priority: "low",
          },
        },
      );
      const task = (await createRes.json()).data;

      // Change multiple fields
      await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${task.id}`, {
        body: { title: "Updated diff test task", priority: "critical" },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/tasks/${task.id}/activity`,
      );
      const body = await res.json();

      const updateEntry = body.data.find((a: any) => a.action === "updated");
      expect(updateEntry).toBeDefined();

      const changes =
        typeof updateEntry.changes === "string"
          ? JSON.parse(updateEntry.changes)
          : updateEntry.changes;
      expect(changes.title.from).toBe("Diff test task");
      expect(changes.title.to).toBe("Updated diff test task");
      expect(changes.priority.from).toBe("low");
      expect(changes.priority.to).toBe("critical");
    });
  });
});
