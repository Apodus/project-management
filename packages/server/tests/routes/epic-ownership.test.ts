import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestProject,
  createTestEpic,
  createTestTask,
  createTestAiAgent,
  authRequest,
  type TestApp,
} from "../utils.js";

describe("Epic Ownership", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── POST /api/v1/epics/:id/claim ──────────────────────────────

  describe("POST /api/v1/epics/:id/claim", () => {
    it("should claim an unowned epic", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/epics/${epic.id}/claim`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.assigneeId).toBe(testApp.testUser.id);
    });

    it("should allow re-claiming your own epic", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      // Claim first time
      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`);

      // Claim again — should succeed (same user)
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/epics/${epic.id}/claim`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.assigneeId).toBe(testApp.testUser.id);
    });

    it("should return 409 if claimed by another user", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      // First user claims
      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`);

      // Second user tries to claim
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/epics/${epic.id}/claim`,
        { token: agent.token },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("ALREADY_CLAIMED");
    });

    it("should return 404 for nonexistent epic", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/epics/nonexistent/claim",
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/epics/:id/release ────────────────────────────

  describe("POST /api/v1/epics/:id/release", () => {
    it("should release a claimed epic", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      // Claim first
      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`);

      // Release
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/epics/${epic.id}/release`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.assigneeId).toBeNull();
    });

    it("should be idempotent for unclaimed epics", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/epics/${epic.id}/release`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.assigneeId).toBeNull();
    });
  });

  // ── Epic data includes assigneeId ─────────────────────────────

  describe("GET /api/v1/epics/:id", () => {
    it("should include assigneeId in epic response", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      // Before claiming
      const res1 = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/epics/${epic.id}`,
      );
      const body1 = await res1.json();
      expect(body1.data.assigneeId).toBeNull();

      // After claiming
      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`);
      const res2 = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/epics/${epic.id}`,
      );
      const body2 = await res2.json();
      expect(body2.data.assigneeId).toBe(testApp.testUser.id);
    });
  });

  // ── pickNextTask with epic_id filter ──────────────────────────

  describe("POST /api/v1/tasks/pick-next with epic_id", () => {
    it("should only pick tasks within the specified epic", async () => {
      const project = createTestProject(testApp.db);
      const epic1 = createTestEpic(testApp.db, {
        projectId: project.id,
        name: "Epic A",
      });
      const epic2 = createTestEpic(testApp.db, {
        projectId: project.id,
        name: "Epic B",
      });

      // Create tasks in different epics
      createTestTask(testApp.db, {
        projectId: project.id,
        epicId: epic1.id,
        status: "ready",
        priority: "critical",
        title: "Task in Epic A",
        reporterId: testApp.testUser.id,
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        epicId: epic2.id,
        status: "ready",
        priority: "critical",
        title: "Task in Epic B",
        reporterId: testApp.testUser.id,
      });

      // Pick next with epic_id filter
      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: { epic_id: epic1.id } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.epicId).toBe(epic1.id);
      expect(body.data.title).toBe("Task in Epic A");
    });

    it("should return 404 when no tasks in the specified epic", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: { epic_id: epic.id } },
      );
      expect(res.status).toBe(404);
    });
  });
});
