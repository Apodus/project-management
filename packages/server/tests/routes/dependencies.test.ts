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

describe("Dependencies API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── POST /api/v1/tasks/:id/dependencies ───────────────────────────
  describe("POST /api/v1/tasks/:id/dependencies", () => {
    it("should add a blocks dependency", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const taskA = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Task A",
      });
      const taskB = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Task B",
      });

      // A depends on B (B blocks A)
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${taskA.id}/dependencies`, {
        body: {
          dependsOnTaskId: taskB.id,
          type: "blocks",
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.taskId).toBe(taskA.id);
      expect(body.data.dependsOnTaskId).toBe(taskB.id);
      expect(body.data.dependencyType).toBe("blocks");
      expect(body.data.id).toBeDefined();
      expect(body.data.createdAt).toBeDefined();
    });

    it("should add a relates_to dependency", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const taskA = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });
      const taskB = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${taskA.id}/dependencies`, {
        body: {
          dependsOnTaskId: taskB.id,
          type: "relates_to",
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.dependencyType).toBe("relates_to");
    });

    it("should default to blocks type when not specified", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const taskA = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });
      const taskB = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${taskA.id}/dependencies`, {
        body: {
          dependsOnTaskId: taskB.id,
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.dependencyType).toBe("blocks");
    });

    it("should reject self-dependency", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/dependencies`, {
        body: {
          dependsOnTaskId: task.id,
        },
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("SELF_DEPENDENCY");
    });

    it("should detect simple cycle: A->B->A", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const taskA = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "A",
      });
      const taskB = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "B",
      });

      // A depends on B
      const res1 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${taskA.id}/dependencies`,
        { body: { dependsOnTaskId: taskB.id } },
      );
      expect(res1.status).toBe(201);

      // B depends on A — should fail (cycle)
      const res2 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${taskB.id}/dependencies`,
        { body: { dependsOnTaskId: taskA.id } },
      );
      expect(res2.status).toBe(400);

      const body = await res2.json();
      expect(body.error.code).toBe("CYCLE_DETECTED");
    });

    it("should detect triangle cycle: A->B->C->A", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const taskA = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "A",
      });
      const taskB = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "B",
      });
      const taskC = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "C",
      });

      // A depends on B
      const res1 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${taskA.id}/dependencies`,
        { body: { dependsOnTaskId: taskB.id } },
      );
      expect(res1.status).toBe(201);

      // B depends on C
      const res2 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${taskB.id}/dependencies`,
        { body: { dependsOnTaskId: taskC.id } },
      );
      expect(res2.status).toBe(201);

      // C depends on A — should fail (cycle: A->B->C->A)
      const res3 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${taskC.id}/dependencies`,
        { body: { dependsOnTaskId: taskA.id } },
      );
      expect(res3.status).toBe(400);

      const body = await res3.json();
      expect(body.error.code).toBe("CYCLE_DETECTED");
    });

    it("should detect deep chain cycle", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      // Create a chain: A -> B -> C -> D -> E
      const taskA = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "A",
      });
      const taskB = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "B",
      });
      const taskC = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "C",
      });
      const taskD = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "D",
      });
      const taskE = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "E",
      });

      // Build the chain
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${taskA.id}/dependencies`, {
        body: { dependsOnTaskId: taskB.id },
      });
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${taskB.id}/dependencies`, {
        body: { dependsOnTaskId: taskC.id },
      });
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${taskC.id}/dependencies`, {
        body: { dependsOnTaskId: taskD.id },
      });
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${taskD.id}/dependencies`, {
        body: { dependsOnTaskId: taskE.id },
      });

      // E depends on A — should fail (cycle: A->B->C->D->E->A)
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${taskE.id}/dependencies`, {
        body: { dependsOnTaskId: taskA.id },
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("CYCLE_DETECTED");
    });

    it("should allow non-cyclic chain", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const taskA = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "A",
      });
      const taskB = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "B",
      });
      const taskC = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "C",
      });

      // A depends on B
      const res1 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${taskA.id}/dependencies`,
        { body: { dependsOnTaskId: taskB.id } },
      );
      expect(res1.status).toBe(201);

      // A also depends on C (fan-out, not cycle)
      const res2 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${taskA.id}/dependencies`,
        { body: { dependsOnTaskId: taskC.id } },
      );
      expect(res2.status).toBe(201);

      // B depends on C (diamond, not cycle)
      const res3 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${taskB.id}/dependencies`,
        { body: { dependsOnTaskId: taskC.id } },
      );
      expect(res3.status).toBe(201);
    });

    it("should reject duplicate dependency", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const taskA = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });
      const taskB = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/tasks/${taskA.id}/dependencies`, {
        body: { dependsOnTaskId: taskB.id },
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${taskA.id}/dependencies`, {
        body: { dependsOnTaskId: taskB.id },
      });
      expect(res.status).toBe(409);
    });

    it("should return 404 for non-existent task", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });
      const fakeId = createId();

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/dependencies`, {
        body: { dependsOnTaskId: fakeId },
      });
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /api/v1/tasks/:id/dependencies/:depId ──────────────────
  describe("DELETE /api/v1/tasks/:id/dependencies/:depId", () => {
    it("should remove a dependency", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const taskA = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });
      const taskB = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${taskA.id}/dependencies`,
        { body: { dependsOnTaskId: taskB.id } },
      );
      const created = await createRes.json();

      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/tasks/${taskA.id}/dependencies/${created.data.id}`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.id).toBe(created.data.id);
    });

    it("should return 404 for non-existent dependency", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });
      const fakeId = createId();

      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/tasks/${task.id}/dependencies/${fakeId}`,
      );
      expect(res.status).toBe(404);
    });
  });

  // ── is_blocked computation ────────────────────────────────────────
  describe("is_blocked computation", () => {
    it("should show task as blocked when dependency is not done", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const blockerTask = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Blocker",
        status: "in_progress",
      });
      const blockedTask = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Blocked",
        status: "backlog",
      });

      // blockedTask depends on blockerTask
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${blockedTask.id}/dependencies`, {
        body: { dependsOnTaskId: blockerTask.id },
      });

      // Filter for blocked tasks
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?is_blocked=true`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(blockedTask.id);
    });

    it("should show task as unblocked when dependency is done", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const blockerTask = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Blocker",
        status: "done",
      });
      const blockedTask = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Blocked",
        status: "backlog",
      });

      // blockedTask depends on blockerTask (which is done)
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${blockedTask.id}/dependencies`, {
        body: { dependsOnTaskId: blockerTask.id },
      });

      // Filter for blocked tasks — should be empty since blocker is done
      const resBlocked = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?is_blocked=true`,
      );
      const blockedBody = await resBlocked.json();
      expect(blockedBody.data).toHaveLength(0);

      // Both tasks should be in is_blocked=false
      const resUnblocked = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?is_blocked=false`,
      );
      const unblockedBody = await resUnblocked.json();
      expect(unblockedBody.data).toHaveLength(2);
    });

    it("should correctly filter is_blocked=false for tasks without dependencies", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Independent task",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?is_blocked=false`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe("Independent task");
    });

    it("should only consider blocks type, not relates_to for is_blocked", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const taskA = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Task A",
        status: "in_progress",
      });
      const taskB = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Task B",
        status: "backlog",
      });

      // B relates_to A (not a "blocks" dependency)
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${taskB.id}/dependencies`, {
        body: { dependsOnTaskId: taskA.id, type: "relates_to" },
      });

      // B should NOT be blocked (relates_to doesn't block)
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?is_blocked=true`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(0);
    });
  });

  // ── label filter on task list ─────────────────────────────────────
  describe("Task list label filter", () => {
    it("should filter tasks by label", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task1 = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Labeled task",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Unlabeled task",
      });

      // Create label and attach to task1
      const labelRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug" } },
      );
      const label = await labelRes.json();

      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task1.id}/labels`, {
        body: { labelId: label.data.id },
      });

      // Filter by label
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?label=${label.data.id}`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe("Labeled task");
    });
  });
});
