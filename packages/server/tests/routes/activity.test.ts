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

  // ── Escalation lifecycle → activity feed (Campaign C1 §P5) ────

  describe("Escalation activity logging", () => {
    it("logs opened + acknowledged for a raise→acknowledge transition", async () => {
      const project = createTestProject(testApp.db);

      // Raise (open) then acknowledge — each emits one event → one activity row.
      const raiseRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/escalations`,
        {
          body: {
            kind: "bug_report",
            title: "Activity-logged escalation",
            originRepo: "game_one",
            originWorkerKey: "worker-1",
          },
        },
      );
      expect(raiseRes.status).toBe(201);
      const esc = (await raiseRes.json()).data;

      const ackRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/escalations/${esc.id}/acknowledge`,
      );
      expect(ackRes.status).toBe(200);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/activity`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      const opened = body.data.find(
        (a: any) => a.entityType === "escalation" && a.action === "opened",
      );
      expect(opened).toBeDefined();
      expect(opened.entityId).toBe(esc.id);

      const acknowledged = body.data.find(
        (a: any) => a.entityType === "escalation" && a.action === "acknowledged",
      );
      expect(acknowledged).toBeDefined();
      expect(acknowledged.entityId).toBe(esc.id);
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

  // ── since filter on project activity endpoint ────────────────────

  describe("since and exclude_actor filters", () => {
    it("should filter activity by since timestamp", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      // Create two tasks at different times (activity is logged automatically)
      const createRes1 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        { body: { title: "Early task", reporterId: user.id } },
      );
      expect(createRes1.status).toBe(201);

      // Capture a timestamp between the two creations
      const midpoint = new Date().toISOString();

      // Tiny delay to ensure different timestamps
      const createRes2 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        { body: { title: "Later task", reporterId: user.id } },
      );
      expect(createRes2.status).toBe(201);

      // Query with since=midpoint — should only get the later task's activity
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/activity?since=${encodeURIComponent(midpoint)}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      // All returned entries should have createdAt > midpoint
      for (const entry of body.data) {
        expect(entry.createdAt > midpoint).toBe(true);
      }
    });

    it("should filter activity by exclude_actor", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      // Create a task (activity logged with the authenticated user's actorId)
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        { body: { title: "Actor filter task", reporterId: user.id } },
      );

      // Exclude the test user from activity results
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/activity?exclude_actor=${testApp.testUser.id}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      // No entries should have the excluded actor
      for (const entry of body.data) {
        expect(entry.actorId).not.toBe(testApp.testUser.id);
      }
    });
  });

  // ── GET /api/v1/activity/updates ────────────────────────────────

  describe("GET /api/v1/activity/updates", () => {
    it("should return has_updates false when no new activity", async () => {
      const futureTimestamp = "2099-01-01T00:00:00Z";
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/activity/updates?since=${encodeURIComponent(futureTimestamp)}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.has_updates).toBe(false);
      expect(body.count).toBe(0);
      expect(body.data).toEqual([]);
    });

    it("should return updates excluding the current user's activity", async () => {
      const project = createTestProject(testApp.db);
      const otherUser = createTestUser(testApp.db);

      const pastTimestamp = "2000-01-01T00:00:00Z";

      // Create task as the default test user (this will be excluded)
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        { body: { title: "Own task", reporterId: otherUser.id } },
      );

      // The updates endpoint should exclude the authenticated user's own activity
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/activity/updates?since=${encodeURIComponent(pastTimestamp)}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      // All returned entries should NOT have the test user's actorId
      for (const entry of body.data) {
        expect(entry.actorId).not.toBe(testApp.testUser.id);
      }
    });

    it("should scope updates to a specific project", async () => {
      const project1 = createTestProject(testApp.db);
      const project2 = createTestProject(testApp.db);
      const otherUser = createTestUser(testApp.db);

      const pastTimestamp = "2000-01-01T00:00:00Z";

      // Create tasks in both projects
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project1.id}/tasks`,
        { body: { title: "P1 task", reporterId: otherUser.id } },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project2.id}/tasks`,
        { body: { title: "P2 task", reporterId: otherUser.id } },
      );

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/activity/updates?since=${encodeURIComponent(pastTimestamp)}&project_id=${project1.id}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      // All returned entries should be for project1 only
      for (const entry of body.data) {
        expect(entry.projectId).toBe(project1.id);
      }
    });

    it("should include count and has_updates fields", async () => {
      const pastTimestamp = "2000-01-01T00:00:00Z";

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/activity/updates?since=${encodeURIComponent(pastTimestamp)}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(typeof body.has_updates).toBe("boolean");
      expect(typeof body.count).toBe("number");
      expect(Array.isArray(body.data)).toBe(true);
    });
  });
});
