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

describe("Git Refs API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── GET /api/v1/tasks/:taskId/git-refs ────────────────────────

  describe("GET /api/v1/tasks/:taskId/git-refs", () => {
    it("should return empty list when no git refs exist", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}/git-refs`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it("should return 404 for non-existent task", async () => {
      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${createId()}/git-refs`);
      expect(res.status).toBe(404);
    });

    it("should list git refs for a task", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      // Create two refs
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/git-refs`, {
        body: { refType: "branch", refValue: "feat/task-123" },
      });
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/git-refs`, {
        body: {
          refType: "pull_request",
          refValue: "456",
          url: "https://github.com/org/repo/pull/456",
          status: "open",
        },
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}/git-refs`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.length).toBe(2);
      expect(body.pagination.total).toBe(2);
    });
  });

  // ── POST /api/v1/tasks/:taskId/git-refs ───────────────────────

  describe("POST /api/v1/tasks/:taskId/git-refs", () => {
    it("should create a branch git ref", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/git-refs`, {
        body: { refType: "branch", refValue: "feat/implement-auth" },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.taskId).toBe(task.id);
      expect(body.data.refType).toBe("branch");
      expect(body.data.refValue).toBe("feat/implement-auth");
      expect(body.data.url).toBeNull();
      expect(body.data.status).toBeNull();
    });

    it("should create a pull_request git ref with all fields", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/git-refs`, {
        body: {
          refType: "pull_request",
          refValue: "42",
          url: "https://github.com/org/repo/pull/42",
          title: "Add authentication middleware",
          status: "open",
          metadata: { reviewers: ["alice", "bob"] },
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.refType).toBe("pull_request");
      expect(body.data.refValue).toBe("42");
      expect(body.data.url).toBe("https://github.com/org/repo/pull/42");
      expect(body.data.title).toBe("Add authentication middleware");
      expect(body.data.status).toBe("open");
    });

    it("should create a commit git ref", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/git-refs`, {
        body: {
          refType: "commit",
          refValue: "abc123def456",
          title: "feat: add auth middleware",
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.refType).toBe("commit");
      expect(body.data.refValue).toBe("abc123def456");
    });

    it("should return 404 for non-existent task", async () => {
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${createId()}/git-refs`, {
        body: { refType: "branch", refValue: "feat/orphan" },
      });
      expect(res.status).toBe(404);
    });

    it("should return 400 for missing required fields", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/git-refs`,
        { body: { refType: "branch" } }, // missing refValue
      );
      expect(res.status).toBe(400);
    });
  });

  // ── PATCH /api/v1/git-refs/:id ────────────────────────────────

  describe("PATCH /api/v1/git-refs/:id", () => {
    it("should update a git ref", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/git-refs`,
        {
          body: {
            refType: "pull_request",
            refValue: "99",
            status: "open",
          },
        },
      );
      const gitRef = (await createRes.json()).data;

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/git-refs/${gitRef.id}`, {
        body: {
          status: "merged",
          title: "Merged PR",
        },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("merged");
      expect(body.data.title).toBe("Merged PR");
    });

    it("should return 404 for non-existent git ref", async () => {
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/git-refs/${createId()}`, {
        body: { status: "closed" },
      });
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /api/v1/git-refs/:id ───────────────────────────────

  describe("DELETE /api/v1/git-refs/:id", () => {
    it("should delete a git ref", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/git-refs`,
        { body: { refType: "branch", refValue: "feat/delete-me" } },
      );
      const gitRef = (await createRes.json()).data;

      const res = await authRequest(testApp.app, "DELETE", `/api/v1/git-refs/${gitRef.id}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.id).toBe(gitRef.id);

      // Verify it's gone
      const listRes = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}/git-refs`);
      const listBody = await listRes.json();
      expect(listBody.data.length).toBe(0);
    });

    it("should return 404 for non-existent git ref", async () => {
      const res = await authRequest(testApp.app, "DELETE", `/api/v1/git-refs/${createId()}`);
      expect(res.status).toBe(404);
    });
  });
});
