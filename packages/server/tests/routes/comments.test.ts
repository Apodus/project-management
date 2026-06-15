import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestProject,
  createTestTask,
  createTestProposal,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";

describe("Comments API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── GET /api/v1/tasks/:taskId/comments ────────────────────────────
  describe("GET /api/v1/tasks/:taskId/comments", () => {
    it("should return empty list when no comments exist", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}/comments`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it("should return comments for a task", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      // Create comments via API
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/comments`, {
        body: { body: "First comment" },
      });
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/comments`, {
        body: { body: "Second comment" },
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}/comments`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });

    it("should return comments in chronological order", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/comments`, {
        body: { body: "First" },
      });
      await new Promise((r) => setTimeout(r, 10));
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/comments`, {
        body: { body: "Second" },
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}/comments`);
      const body = await res.json();
      expect(body.data[0].body).toBe("First");
      expect(body.data[1].body).toBe("Second");
    });

    it("should return 404 for non-existent task", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${fakeId}/comments`);
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/tasks/:taskId/comments ───────────────────────────
  describe("POST /api/v1/tasks/:taskId/comments", () => {
    it("should create a task comment with valid data", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/comments`, {
        body: {
          body: "This is a comment",
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.body).toBe("This is a comment");
      expect(body.data.taskId).toBe(task.id);
      expect(body.data.proposalId).toBeNull();
      expect(body.data.authorId).toBe(testApp.testUser.id);
      expect(body.data.commentType).toBe("comment");
      expect(body.data.id).toBeDefined();
      expect(body.data.createdAt).toBeDefined();
    });

    it("should reject missing body", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/comments`, {
        body: {},
      });
      expect(res.status).toBe(400);
    });

    it("should reject invalid comment_type", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/comments`, {
        body: {
          body: "Some comment",
          commentType: "invalid_type",
        },
      });
      expect(res.status).toBe(400);
    });

    it("should create comment with specific comment_type", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/comments`, {
        body: {
          body: "Progress report",
          commentType: "progress_update",
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.commentType).toBe("progress_update");
    });

    it("should return 404 for non-existent task", async () => {
      const user = createTestUser(testApp.db);
      const fakeId = createId();

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${fakeId}/comments`, {
        body: { body: "Comment on nothing" },
      });
      expect(res.status).toBe(404);
    });

    it("should set taskId from the URL path (polymorphism enforcement)", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/comments`, {
        body: {
          body: "Task comment via route",
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.taskId).toBe(task.id);
      expect(body.data.proposalId).toBeNull();
    });
  });

  // ── Typed comment metadata ────────────────────────────────────────
  describe("Typed comment metadata", () => {
    it("should store progress_update metadata", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const metadata = {
        completion_pct: 75,
        files_changed: ["src/app.ts", "src/utils.ts"],
        summary: "Good progress on the feature",
      };

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/comments`, {
        body: {
          body: "Progress update",
          commentType: "progress_update",
          metadata,
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.commentType).toBe("progress_update");
      expect(body.data.metadata).toEqual(metadata);
    });

    it("should store decision metadata", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const metadata = {
        decision: "Use React Query for data fetching",
        rationale: "Better caching and refetching behavior",
        alternatives_considered: ["SWR", "Apollo Client"],
      };

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/comments`, {
        body: {
          body: "Decision made",
          commentType: "decision",
          metadata,
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.commentType).toBe("decision");
      expect(body.data.metadata).toEqual(metadata);
    });

    it("should store handoff metadata", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const metadata = {
        summary: "Completed the API layer, frontend still needs work",
        files_changed: ["src/routes/api.ts"],
        open_questions: ["Should we add rate limiting?"],
        test_results: "All 42 tests passing",
      };

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/comments`, {
        body: {
          body: "Handoff notes",
          commentType: "handoff",
          metadata,
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.commentType).toBe("handoff");
      expect(body.data.metadata).toEqual(metadata);
    });
  });

  // ── PATCH /api/v1/comments/:id ────────────────────────────────────
  describe("PATCH /api/v1/comments/:id", () => {
    it("should update comment body", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/comments`,
        {
          body: { body: "Original body" },
        },
      );
      const created = await createRes.json();

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/comments/${created.data.id}`, {
        body: { body: "Updated body" },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.body).toBe("Updated body");
    });

    it("should update comment metadata", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/comments`,
        {
          body: {
            body: "Comment with metadata",
            commentType: "progress_update",
            metadata: { completion_pct: 50 },
          },
        },
      );
      const created = await createRes.json();

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/comments/${created.data.id}`, {
        body: { metadata: { completion_pct: 80, summary: "Almost done" } },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.metadata).toEqual({
        completion_pct: 80,
        summary: "Almost done",
      });
    });

    it("should return 404 for non-existent comment", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/comments/${fakeId}`, {
        body: { body: "Nope" },
      });
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /api/v1/comments/:id ───────────────────────────────────
  describe("DELETE /api/v1/comments/:id", () => {
    it("should delete a comment", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/comments`,
        {
          body: { body: "To be deleted" },
        },
      );
      const created = await createRes.json();

      const res = await authRequest(testApp.app, "DELETE", `/api/v1/comments/${created.data.id}`);
      expect(res.status).toBe(200);

      // Verify it's actually gone
      const listRes = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}/comments`);
      const listBody = await listRes.json();
      expect(listBody.data).toHaveLength(0);
    });

    it("should return 404 for non-existent comment", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "DELETE", `/api/v1/comments/${fakeId}`);
      expect(res.status).toBe(404);
    });
  });
});
