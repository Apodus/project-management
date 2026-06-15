import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestAiAgent,
  createTestProject,
  createTestEpic,
  createTestTask,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";
import { labels, taskLabels } from "../../src/db/index.js";

describe("Tasks API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── GET /api/v1/projects/:projectId/tasks ──────────────────────────
  describe("GET /api/v1/projects/:projectId/tasks", () => {
    it("should return empty list when no tasks exist", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}/tasks`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.perPage).toBe(50);
      expect(body.pagination.totalPages).toBe(0);
    });

    it("should return all tasks for a project", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}/tasks`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
      // C3.P1: every list-view row carries claimState (unclaimed here).
      expect(body.data[0].claimState).toBe("unclaimed");
    });

    it("should not return tasks from other projects", async () => {
      const project1 = createTestProject(testApp.db);
      const project2 = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project1.id,
        reporterId: user.id,
      });
      createTestTask(testApp.db, {
        projectId: project2.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project1.id}/tasks`);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    // ── Filtering ────────────────────────────────────────────────
    it("should filter by single status", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "backlog",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "in_progress",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "backlog",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?status=backlog`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data.every((t: any) => t.status === "backlog")).toBe(true);
    });

    it("should filter by comma-separated statuses", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "backlog",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "in_progress",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "done",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?status=backlog,in_progress`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(
        body.data.every((t: any) => t.status === "backlog" || t.status === "in_progress"),
      ).toBe(true);
    });

    it("should filter by priority", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        priority: "high",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        priority: "low",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?priority=high`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].priority).toBe("high");
    });

    it("should filter by type", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        type: "bug",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        type: "feature",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?type=bug`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].type).toBe("bug");
    });

    it("should filter by assignee", async () => {
      const project = createTestProject(testApp.db);
      const user1 = createTestUser(testApp.db);
      const user2 = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user1.id,
        assigneeId: user1.id,
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user1.id,
        assigneeId: user2.id,
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?assignee=${user1.id}`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].assigneeId).toBe(user1.id);
    });

    it("should filter by 'unassigned' assignee", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        assigneeId: user.id,
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        assigneeId: null,
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?assignee=unassigned`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].assigneeId).toBeNull();
    });

    it("should filter by epic", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
      });

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        epicId: epic.id,
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        epicId: null,
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?epic=${epic.id}`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].epicId).toBe(epic.id);
    });

    it("should filter by 'none' epic (tasks without epic)", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
      });

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        epicId: epic.id,
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        epicId: null,
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?epic=none`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].epicId).toBeNull();
    });

    it("should search by title (LIKE)", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Fix the login bug",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Add user profile page",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Fix the logout bug",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?search=Fix`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data.every((t: any) => t.title.includes("Fix"))).toBe(true);
    });

    // ── Sorting ─────────────────────────────────────────────────
    it("should sort by created_at desc by default", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "First",
      });
      await new Promise((r) => setTimeout(r, 10));
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Second",
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}/tasks`);
      const body = await res.json();
      expect(body.data[0].title).toBe("Second");
      expect(body.data[1].title).toBe("First");
    });

    it("should sort by created_at asc", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "First",
      });
      await new Promise((r) => setTimeout(r, 10));
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Second",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?sortBy=created_at&order=asc`,
      );
      const body = await res.json();
      expect(body.data[0].title).toBe("First");
      expect(body.data[1].title).toBe("Second");
    });

    it("should sort by priority", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        priority: "low",
        title: "Low",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        priority: "critical",
        title: "Critical",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        priority: "high",
        title: "High",
      });

      // Ascending: critical first
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?sortBy=priority&order=asc`,
      );
      const body = await res.json();
      expect(body.data[0].priority).toBe("critical");
      expect(body.data[1].priority).toBe("high");
      expect(body.data[2].priority).toBe("low");
    });

    it("should sort by sort_order", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        sortOrder: 3,
        title: "Third",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        sortOrder: 1,
        title: "First",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        sortOrder: 2,
        title: "Second",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?sortBy=sort_order&order=asc`,
      );
      const body = await res.json();
      expect(body.data[0].title).toBe("First");
      expect(body.data[1].title).toBe("Second");
      expect(body.data[2].title).toBe("Third");
    });

    // ── Pagination ──────────────────────────────────────────────
    it("should paginate results", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      // Create 5 tasks
      for (let i = 0; i < 5; i++) {
        createTestTask(testApp.db, {
          projectId: project.id,
          reporterId: user.id,
          title: `Task ${i + 1}`,
          sortOrder: i,
        });
      }

      // Page 1, 2 per page
      const res1 = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?page=1&perPage=2&sortBy=sort_order&order=asc`,
      );
      const body1 = await res1.json();
      expect(body1.data).toHaveLength(2);
      expect(body1.pagination.page).toBe(1);
      expect(body1.pagination.perPage).toBe(2);
      expect(body1.pagination.total).toBe(5);
      expect(body1.pagination.totalPages).toBe(3);

      // Page 2
      const res2 = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?page=2&perPage=2&sortBy=sort_order&order=asc`,
      );
      const body2 = await res2.json();
      expect(body2.data).toHaveLength(2);
      expect(body2.pagination.page).toBe(2);

      // Page 3 (last page, partial)
      const res3 = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?page=3&perPage=2&sortBy=sort_order&order=asc`,
      );
      const body3 = await res3.json();
      expect(body3.data).toHaveLength(1);
    });

    it("should return empty data for page beyond range", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?page=99&perPage=10`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(0);
      expect(body.pagination.total).toBe(1);
    });
  });

  // ── POST /api/v1/projects/:projectId/tasks ─────────────────────────
  describe("POST /api/v1/projects/:projectId/tasks", () => {
    it("should create a task with valid data", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const res = await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/tasks`, {
        body: {
          title: "My New Task",
          reporterId: user.id,
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.title).toBe("My New Task");
      expect(body.data.status).toBe("backlog");
      expect(body.data.priority).toBe("medium");
      expect(body.data.type).toBe("feature");
      expect(body.data.projectId).toBe(project.id);
      expect(body.data.reporterId).toBe(user.id);
      expect(body.data.id).toBeDefined();
      expect(body.data.createdAt).toBeDefined();
      expect(body.data.updatedAt).toBeDefined();
    });

    it("should create a task with all fields", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/tasks`, {
        body: {
          title: "Full Task",
          description: "A complete task",
          status: "ready",
          priority: "high",
          type: "bug",
          assigneeId: user.id,
          reporterId: user.id,
          epicId: epic.id,
          estimatedEffort: "m",
          dueDate: "2026-12-31",
          sortOrder: 5,
          context: {
            relevant_files: ["src/app.ts"],
            notes: "Check this",
          },
          gitBranch: "fix/my-bug",
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.title).toBe("Full Task");
      expect(body.data.description).toBe("A complete task");
      expect(body.data.status).toBe("ready");
      expect(body.data.priority).toBe("high");
      expect(body.data.type).toBe("bug");
      expect(body.data.assigneeId).toBe(user.id);
      expect(body.data.epicId).toBe(epic.id);
      expect(body.data.estimatedEffort).toBe("m");
      expect(body.data.dueDate).toBe("2026-12-31");
      expect(body.data.sortOrder).toBe(5);
      expect(body.data.context).toEqual({
        relevant_files: ["src/app.ts"],
        notes: "Check this",
      });
      expect(body.data.gitBranch).toBe("fix/my-bug");
    });

    it("should reject missing title", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const res = await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/tasks`, {
        body: { reporterId: user.id },
      });
      expect(res.status).toBe(400);
    });

    it("should reject empty title", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const res = await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/tasks`, {
        body: { title: "", reporterId: user.id },
      });
      expect(res.status).toBe(400);
    });

    it("should derive reporterId from the authenticated caller when omitted", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/tasks`, {
        body: { title: "Reporter derived from auth" },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      // Default test user is the authenticated caller — should be reporter
      expect(body.data.reporterId).toBe(testApp.testUser.id);
    });

    it("should force reporterId to the AI agent's own ID (ignores body value)", async () => {
      const aiAgent = createTestAiAgent(testApp.db);
      const otherUser = createTestUser(testApp.db);
      // Enable AI task creation for this project so we can exercise the
      // identity-derivation path (autonomy default denies AI top-level creates).
      const project = createTestProject(testApp.db, {
        settings: { ai_autonomy: { can_create_tasks: true } },
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/tasks`, {
        token: aiAgent.token,
        body: { title: "Agent task", reporterId: otherUser.id },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.reporterId).toBe(aiAgent.user.id);
    });

    it("should respect human-supplied reporterId (create on behalf of)", async () => {
      const project = createTestProject(testApp.db);
      const otherUser = createTestUser(testApp.db);

      const res = await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/tasks`, {
        body: { title: "On behalf", reporterId: otherUser.id },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.reporterId).toBe(otherUser.id);
    });
  });

  // ── GET /api/v1/tasks/:id ──────────────────────────────────────────
  describe("GET /api/v1/tasks/:id", () => {
    it("should return a task by ID", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Found Me",
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.id).toBe(task.id);
      expect(body.data.title).toBe("Found Me");
    });

    it("should return 404 for non-existent task", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${fakeId}`);
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  // ── PATCH /api/v1/tasks/:id ────────────────────────────────────────
  describe("PATCH /api/v1/tasks/:id", () => {
    it("should update task title", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Original",
      });

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${task.id}`, {
        body: { title: "Updated Title" },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.title).toBe("Updated Title");
    });

    it("should reject status changes via PATCH (use transitions endpoint)", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "backlog",
      });

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${task.id}`, {
        body: { status: "in_progress" },
      });
      // Status field is no longer accepted in PATCH body — Zod strips unknown fields
      // so this should succeed but not change the status
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("backlog"); // Status unchanged
    });

    it("should update the updatedAt timestamp", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const before = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}`);
      const beforeBody = await before.json();

      await new Promise((r) => setTimeout(r, 10));

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${task.id}`, {
        body: { description: "trigger update" },
      });
      const afterBody = await res.json();

      expect(afterBody.data.updatedAt).not.toBe(beforeBody.data.updatedAt);
    });

    it("should return 404 for non-existent task", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${fakeId}`, {
        body: { title: "Nope" },
      });
      expect(res.status).toBe(404);
    });

    // ── Context JSON merge ──────────────────────────────────────
    it("should store context JSON on creation and return it", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const res = await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/tasks`, {
        body: {
          title: "Context Task",
          reporterId: user.id,
          context: {
            relevant_files: ["src/index.ts"],
            notes: "Initial note",
          },
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.context).toEqual({
        relevant_files: ["src/index.ts"],
        notes: "Initial note",
      });
    });

    it("should merge context JSON on update (partial merge)", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        context: {
          relevant_files: ["src/index.ts"],
          notes: "Initial note",
        },
      });

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${task.id}`, {
        body: {
          context: {
            codebase_areas: ["backend"],
            notes: "Updated note",
          },
        },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      // Merged: relevant_files preserved, notes overwritten, codebase_areas added
      expect(body.data.context).toEqual({
        relevant_files: ["src/index.ts"],
        codebase_areas: ["backend"],
        notes: "Updated note",
      });
    });

    it("should set context to null when explicitly set to null", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        context: { notes: "Has context" },
      });

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${task.id}`, {
        body: { context: null },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.context).toBeNull();
    });
  });

  // ── DELETE /api/v1/tasks/:id ───────────────────────────────────────
  describe("DELETE /api/v1/tasks/:id", () => {
    it("should archive a task (set status to cancelled)", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "backlog",
      });

      const res = await authRequest(testApp.app, "DELETE", `/api/v1/tasks/${task.id}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("cancelled");
      expect(body.data.id).toBe(task.id);
    });

    it("should return 404 for non-existent task", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "DELETE", `/api/v1/tasks/${fakeId}`);
      expect(res.status).toBe(404);
    });

    it("should persist the cancelled status", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "backlog",
      });

      await authRequest(testApp.app, "DELETE", `/api/v1/tasks/${task.id}`);

      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}`);
      const body = await res.json();
      expect(body.data.status).toBe("cancelled");
    });
  });

  // ── POST /api/v1/tasks/:id/subtasks ────────────────────────────────
  describe("POST /api/v1/tasks/:id/subtasks", () => {
    it("should create a subtask of a parent task", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const parentTask = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Parent Task",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${parentTask.id}/subtasks`,
        {
          body: {
            title: "Child Task",
            reporterId: user.id,
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.title).toBe("Child Task");
      expect(body.data.parentTaskId).toBe(parentTask.id);
      expect(body.data.projectId).toBe(project.id);
    });

    it("should return 404 when parent task does not exist", async () => {
      const fakeId = createId();
      const user = createTestUser(testApp.db);

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${fakeId}/subtasks`, {
        body: {
          title: "Orphan",
          reporterId: user.id,
        },
      });
      expect(res.status).toBe(404);
    });

    it("should inherit parent's project for subtask", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const parentTask = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${parentTask.id}/subtasks`,
        {
          body: {
            title: "Subtask",
            reporterId: user.id,
            priority: "high",
          },
        },
      );

      const body = await res.json();
      expect(body.data.projectId).toBe(project.id);
      expect(body.data.priority).toBe("high");
    });
  });

  // ── GET /api/v1/tasks/:id/subtasks ─────────────────────────────────
  describe("GET /api/v1/tasks/:id/subtasks", () => {
    it("should list subtasks of a task", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const parentTask = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Parent",
      });

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        parentTaskId: parentTask.id,
        title: "Sub 1",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        parentTaskId: parentTask.id,
        title: "Sub 2",
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${parentTask.id}/subtasks`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
      expect(body.data.every((t: any) => t.parentTaskId === parentTask.id)).toBe(true);
    });

    it("should return empty list when task has no subtasks", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}/subtasks`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it("should return 404 when parent task does not exist", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${fakeId}/subtasks`);
      expect(res.status).toBe(404);
    });

    it("should not include non-child tasks", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const parentTask = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Parent",
      });

      // A subtask of parent
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        parentTaskId: parentTask.id,
        title: "Child",
      });

      // An unrelated task (no parent)
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Unrelated",
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/tasks/${parentTask.id}/subtasks`);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe("Child");
    });
  });

  // ── Task with parent_task_id self-reference ────────────────────────
  describe("Task with parent_task_id self-reference", () => {
    it("should correctly store and retrieve parent_task_id", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      // Create parent via API
      const parentRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        {
          body: {
            title: "Parent Task",
            reporterId: user.id,
          },
        },
      );
      const parentBody = await parentRes.json();
      const parentId = parentBody.data.id;

      // Create subtask via API
      const childRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${parentId}/subtasks`,
        {
          body: {
            title: "Child Task",
            reporterId: user.id,
          },
        },
      );
      const childBody = await childRes.json();

      expect(childBody.data.parentTaskId).toBe(parentId);

      // Verify by direct GET
      const getRes = await authRequest(testApp.app, "GET", `/api/v1/tasks/${childBody.data.id}`);
      const getBody = await getRes.json();
      expect(getBody.data.parentTaskId).toBe(parentId);
    });
  });

  // ── Claim / release ──────────────────────────────────────────────
  describe("POST /api/v1/tasks/:id/claim and /release", () => {
    it("claims an unassigned task and sets claimStatus to claimed_by_you", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/claim`, {
        token: a.token,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("claimed_by_you");

      const get = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}`, {
        token: a.token,
      });
      const got = await get.json();
      expect(got.data.assigneeId).toBe(a.user.id);
      expect(got.data.claimStatus).toBe("claimed_by_you");
      // C3.P1: the holder sees claimState "yours".
      expect(got.data.claimState).toBe("yours");

      // Another caller sees claimState "live" (held, lease fresh, fail-safe ok).
      const b = createTestAiAgent(testApp.db);
      const getOther = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}`, {
        token: b.token,
      });
      const gotOther = await getOther.json();
      expect(gotOther.data.claimStatus).toBe("claimed_by_other");
      expect(gotOther.data.claimState).toBe("live");
    });

    it("an unclaimed task reads claimState 'unclaimed' (C3.P1)", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
        // assigneeId omitted — unclaimed
      });
      const get = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}`, {
        token: a.token,
      });
      const got = await get.json();
      expect(got.data.claimStatus).toBe("unclaimed");
      expect(got.data.claimState).toBe("unclaimed");
    });

    it("is idempotent for the holder", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
      });
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/claim`, {
        token: a.token,
      });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/claim`, {
        token: a.token,
      });
      const body = await res.json();
      expect(body.data.status).toBe("already_claimed_by_you");
    });

    it("returns claimed_by_another_agent for a racer", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
      });
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/claim`, {
        token: a.token,
      });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/claim`, {
        token: b.token,
      });
      const body = await res.json();
      expect(body.data.ok).toBe(false);
      expect(body.data.status).toBe("claimed_by_another_agent");
    });

    it("rejects AI-agent PATCH on a task they don't hold (CLAIM_DENIED)", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
        // assigneeId omitted — unclaimed
      });
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${task.id}`, {
        token: a.token,
        body: { title: "renamed" },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("CLAIM_DENIED");
    });

    it("allows AI-agent PATCH after claiming", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
      });
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/claim`, {
        token: a.token,
      });
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${task.id}`, {
        token: a.token,
        body: { title: "renamed" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.title).toBe("renamed");
    });

    it("humans can write to unclaimed tasks without claiming", async () => {
      const project = createTestProject(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: testApp.testUser.id,
      });
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/tasks/${task.id}`, {
        body: { title: "renamed by human" },
      });
      expect(res.status).toBe(200);
    });

    it("release frees the slot for the holder", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
      });
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/claim`, {
        token: a.token,
      });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/release`, {
        token: a.token,
      });
      const body = await res.json();
      expect(body.data.status).toBe("released");
    });

    it("AI agent cannot release another agent's claim", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
        assigneeId: a.user.id,
      });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/release`, {
        token: b.token,
      });
      const body = await res.json();
      expect(body.data.ok).toBe(false);
      expect(body.data.status).toBe("claimed_by_another_agent");
    });

    it("claim returns closed for terminal-status tasks", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
        status: "done",
      });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/claim`, {
        token: a.token,
      });
      const body = await res.json();
      expect(body.data.status).toBe("closed");
    });
  });

  // ── claim filter on list ─────────────────────────────────────────
  describe("GET /api/v1/projects/:projectId/tasks?claim=", () => {
    it("'mine' returns only tasks claimed by caller", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
        assigneeId: a.user.id,
        title: "mine",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: b.user.id,
        assigneeId: b.user.id,
        title: "theirs",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
        title: "unassigned",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?claim=mine`,
        { token: a.token },
      );
      const body = await res.json();
      expect(body.data.map((t: { title: string }) => t.title)).toEqual(["mine"]);
    });

    it("'available' returns unassigned OR claimed by caller", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
        assigneeId: a.user.id,
        title: "mine",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: b.user.id,
        assigneeId: b.user.id,
        title: "theirs",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
        title: "free",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?claim=available`,
        { token: a.token },
      );
      const body = await res.json();
      const titles = body.data.map((t: { title: string }) => t.title).sort();
      expect(titles).toEqual(["free", "mine"]);
    });
  });

  // ── label-by-name filter ─────────────────────────────────────────
  describe("GET /api/v1/projects/:projectId/tasks?label_name=", () => {
    it("resolves label name to id within the project", async () => {
      const project = createTestProject(testApp.db);
      // Create a label and a labeled task
      const labelId = createId();
      testApp.db
        .insert(labels)
        .values({
          id: labelId,
          projectId: project.id,
          name: "renderer",
          color: null,
          description: null,
        })
        .run();
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: testApp.testUser.id,
        title: "labeled",
      });
      testApp.db.insert(taskLabels).values({ taskId: task.id, labelId }).run();
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: testApp.testUser.id,
        title: "unlabeled",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?label_name=renderer`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe("labeled");
    });

    it("returns empty for an unknown label name (no cross-project leak)", async () => {
      const project = createTestProject(testApp.db);
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: testApp.testUser.id,
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/tasks?label_name=nonexistent`,
      );
      const body = await res.json();
      expect(body.data).toEqual([]);
    });
  });
});
