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
import { comments } from "../../src/db/index.js";
import { createId } from "@pm/shared";

describe("Search API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Helper to create a comment directly in the DB ──────────────
  function createTestComment(
    db: typeof testApp.db,
    overrides: {
      taskId?: string | null;
      proposalId?: string | null;
      authorId: string;
      body: string;
    },
  ) {
    const ts = new Date().toISOString();
    const id = createId();
    db.insert(comments)
      .values({
        id,
        taskId: overrides.taskId ?? null,
        proposalId: overrides.proposalId ?? null,
        authorId: overrides.authorId,
        body: overrides.body,
        commentType: "comment",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return { id, body: overrides.body };
  }

  // ── GET /api/v1/search ──────────────────────────────────────────

  describe("GET /api/v1/search", () => {
    it("should find tasks by title", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Implement authentication middleware",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/search?q=authentication",
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data[0].entityType).toBe("task");
      expect(body.data[0].title).toContain("authentication");
    });

    it("should find proposals by description", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        title: "Add a new feature",
        description: "We need to implement a blockchain integration module",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/search?q=blockchain",
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data[0].entityType).toBe("proposal");
    });

    it("should find comments by body", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Some task",
      });

      createTestComment(testApp.db, {
        taskId: task.id,
        authorId: user.id,
        body: "The refactoring of the database layer is complete",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/search?q=refactoring",
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data[0].entityType).toBe("comment");
    });

    it("should filter results by project_id", async () => {
      const project1 = createTestProject(testApp.db);
      const project2 = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project1.id,
        reporterId: user.id,
        title: "Searchable unique widget alpha",
      });
      createTestTask(testApp.db, {
        projectId: project2.id,
        reporterId: user.id,
        title: "Searchable unique widget beta",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/search?q=widget&project_id=${project1.id}`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.length).toBe(1);
      expect(body.data[0].projectId).toBe(project1.id);
      expect(body.data[0].title).toContain("alpha");
    });

    it("should filter results by entity_type", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Implement special feature zorplex",
      });
      createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        title: "Propose special feature zorplex",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/search?q=zorplex&entity_type=task",
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.length).toBe(1);
      expect(body.data[0].entityType).toBe("task");
    });

    it("should return empty results for no matches", async () => {
      const res = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/search?q=xyznonexistentquery123",
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it("should rank exact matches higher than partial matches", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      // Create a task with partial match in description only
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Some other task",
        description: "Contains optimization keyword here",
      });

      // Create a task with match in title
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Database optimization improvements",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/search?q=optimization",
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(2);
      // Both results should be found
      const titles = body.data.map((r: any) => r.title);
      expect(titles).toContain("Database optimization improvements");
    });

    it("should require a query parameter", async () => {
      const res = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/search",
      );
      expect(res.status).toBe(400);
    });
  });
});
