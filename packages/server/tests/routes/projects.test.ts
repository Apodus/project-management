import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestProject,
  authRequest,
  type TestApp,
} from "../utils.js";
import { tasks, epics, proposals } from "../../src/db/index.js";
import { createId } from "@pm/shared";

describe("Projects API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── GET /api/v1/projects ──────────────────────────────────────────
  describe("GET /api/v1/projects", () => {
    it("should return empty list when no projects exist", async () => {
      const res = await authRequest(testApp.app, "GET", "/api/v1/projects");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({ total: 0 });
    });

    it("should return all projects", async () => {
      createTestProject(testApp.db);
      createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "GET", "/api/v1/projects");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });

    it("should filter by status", async () => {
      createTestProject(testApp.db, { status: "active" });
      createTestProject(testApp.db, { status: "paused" });
      createTestProject(testApp.db, { status: "active" });

      const res = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/projects?status=active",
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data.every((p: any) => p.status === "active")).toBe(true);
    });

    it("should return empty list for status filter with no matches", async () => {
      createTestProject(testApp.db, { status: "active" });

      const res = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/projects?status=paused",
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(0);
    });

    it("should have correct response envelope shape", async () => {
      createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "GET", "/api/v1/projects");
      const body = await res.json();

      // Verify envelope shape
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
      expect(body.pagination).toHaveProperty("total");
      expect(Array.isArray(body.data)).toBe(true);

      // Verify project shape
      const project = body.data[0];
      expect(project).toHaveProperty("id");
      expect(project).toHaveProperty("workspaceId");
      expect(project).toHaveProperty("name");
      expect(project).toHaveProperty("slug");
      expect(project).toHaveProperty("status");
      expect(project).toHaveProperty("createdAt");
      expect(project).toHaveProperty("updatedAt");
    });
  });

  // ── POST /api/v1/projects ─────────────────────────────────────────
  describe("POST /api/v1/projects", () => {
    it("should create a project with valid data", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "My New Project" },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toBe("My New Project");
      expect(body.data.slug).toBe("my-new-project");
      expect(body.data.status).toBe("active");
      expect(body.data.id).toBeDefined();
      expect(body.data.createdAt).toBeDefined();
      expect(body.data.updatedAt).toBeDefined();
    });

    it("should create a project with all fields", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: {
          name: "Full Project",
          description: "A complete project",
          gitRepoUrl: "https://github.com/test/repo",
          status: "paused",
          sortOrder: 5,
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toBe("Full Project");
      expect(body.data.description).toBe("A complete project");
      expect(body.data.gitRepoUrl).toBe("https://github.com/test/repo");
      expect(body.data.status).toBe("paused");
      expect(body.data.sortOrder).toBe(5);
    });

    it("should reject missing name", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: {},
      });
      // zod-openapi validation returns 400 for invalid input
      expect(res.status).toBe(400);
    });

    it("should reject empty name", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "" },
      });
      expect(res.status).toBe(400);
    });

    it("should return data envelope for created project", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "Envelope Test" },
      });

      const body = await res.json();
      expect(body).toHaveProperty("data");
      expect(body.data).toHaveProperty("id");
      expect(body.data).toHaveProperty("name");
    });

    // ── Slug generation ───────────────────────────────────────────
    it("should generate slug from name", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "My Awesome Project" },
      });
      const body = await res.json();
      expect(body.data.slug).toBe("my-awesome-project");
    });

    it("should handle special characters in slug", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "Project #1 (Alpha)" },
      });
      const body = await res.json();
      expect(body.data.slug).toBe("project-1-alpha");
    });

    it("should handle consecutive special characters in slug", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "Hello   World!!!" },
      });
      const body = await res.json();
      expect(body.data.slug).toBe("hello-world");
    });

    it("should deduplicate slugs within workspace", async () => {
      // Create first project
      const res1 = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/projects",
        { body: { name: "Duplicate Name" } },
      );
      const body1 = await res1.json();
      expect(body1.data.slug).toBe("duplicate-name");

      // Create second project with same name
      const res2 = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/projects",
        { body: { name: "Duplicate Name" } },
      );
      const body2 = await res2.json();
      expect(body2.data.slug).toBe("duplicate-name-2");

      // Create third project with same name
      const res3 = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/projects",
        { body: { name: "Duplicate Name" } },
      );
      const body3 = await res3.json();
      expect(body3.data.slug).toBe("duplicate-name-3");
    });
  });

  // ── GET /api/v1/projects/:id ──────────────────────────────────────
  describe("GET /api/v1/projects/:id", () => {
    it("should return a project by ID", async () => {
      const project = createTestProject(testApp.db, { name: "Found Me" });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.id).toBe(project.id);
      expect(body.data.name).toBe("Found Me");
    });

    it("should return 404 for non-existent project", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${fakeId}`,
      );
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("should return data envelope", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}`,
      );
      const body = await res.json();
      expect(body).toHaveProperty("data");
      expect(body.data.id).toBe(project.id);
    });
  });

  // ── PATCH /api/v1/projects/:id ────────────────────────────────────
  describe("PATCH /api/v1/projects/:id", () => {
    it("should update project name", async () => {
      const project = createTestProject(testApp.db, { name: "Original" });

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/projects/${project.id}`,
        { body: { name: "Updated Name" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.name).toBe("Updated Name");
      expect(body.data.slug).toBe("updated-name");
    });

    it("should update project description", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/projects/${project.id}`,
        { body: { description: "New description" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.description).toBe("New description");
    });

    it("should update the updatedAt timestamp", async () => {
      const project = createTestProject(testApp.db);

      // Get current state
      const before = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}`,
      );
      const beforeBody = await before.json();

      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 10));

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/projects/${project.id}`,
        { body: { description: "trigger update" } },
      );
      const afterBody = await res.json();

      expect(afterBody.data.updatedAt).not.toBe(beforeBody.data.updatedAt);
    });

    it("should return 404 for non-existent project", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/projects/${fakeId}`,
        { body: { name: "Nope" } },
      );
      expect(res.status).toBe(404);
    });

    it("should handle no-op update (empty body)", async () => {
      const project = createTestProject(testApp.db, { name: "NoOp" });

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/projects/${project.id}`,
        { body: {} },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.name).toBe("NoOp");
    });
  });

  // ── DELETE /api/v1/projects/:id ───────────────────────────────────
  describe("DELETE /api/v1/projects/:id", () => {
    it("should archive a project (set status to archived)", async () => {
      const project = createTestProject(testApp.db, { status: "active" });

      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/projects/${project.id}`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("archived");
      expect(body.data.id).toBe(project.id);
    });

    it("should return 404 for non-existent project", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/projects/${fakeId}`,
      );
      expect(res.status).toBe(404);
    });

    it("should persist the archived status", async () => {
      const project = createTestProject(testApp.db, { status: "active" });

      await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/projects/${project.id}`,
      );

      // Verify by fetching it again
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}`,
      );
      const body = await res.json();
      expect(body.data.status).toBe("archived");
    });
  });

  // ── GET /api/v1/projects/:id/stats ────────────────────────────────
  describe("GET /api/v1/projects/:id/stats", () => {
    it("should return zero counts for project with no tasks/epics/proposals", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/stats`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.totalTasks).toBe(0);
      expect(body.data.tasksByStatus).toEqual({});
      expect(body.data.epicCount).toBe(0);
      expect(body.data.proposalCount).toBe(0);
    });

    it("should return correct task counts by status", async () => {
      const user = createTestUser(testApp.db);
      const project = createTestProject(testApp.db, {
        createdBy: user.id,
      });
      const ts = new Date().toISOString();

      // Insert tasks with different statuses
      testApp.db
        .insert(tasks)
        .values([
          {
            id: createId(),
            projectId: project.id,
            title: "Task 1",
            status: "backlog",
            priority: "medium",
            type: "feature",
            reporterId: user.id,
            createdAt: ts,
            updatedAt: ts,
          },
          {
            id: createId(),
            projectId: project.id,
            title: "Task 2",
            status: "backlog",
            priority: "high",
            type: "feature",
            reporterId: user.id,
            createdAt: ts,
            updatedAt: ts,
          },
          {
            id: createId(),
            projectId: project.id,
            title: "Task 3",
            status: "in_progress",
            priority: "medium",
            type: "bug",
            reporterId: user.id,
            createdAt: ts,
            updatedAt: ts,
          },
          {
            id: createId(),
            projectId: project.id,
            title: "Task 4",
            status: "done",
            priority: "low",
            type: "chore",
            reporterId: user.id,
            createdAt: ts,
            updatedAt: ts,
          },
        ])
        .run();

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/stats`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.totalTasks).toBe(4);
      expect(body.data.tasksByStatus.backlog).toBe(2);
      expect(body.data.tasksByStatus.in_progress).toBe(1);
      expect(body.data.tasksByStatus.done).toBe(1);
    });

    it("should return correct epic and proposal counts", async () => {
      const user = createTestUser(testApp.db);
      const project = createTestProject(testApp.db, {
        createdBy: user.id,
      });
      const ts = new Date().toISOString();

      // Insert epics
      testApp.db
        .insert(epics)
        .values([
          {
            id: createId(),
            projectId: project.id,
            name: "Epic 1",
            status: "active",
            priority: "high",
            createdAt: ts,
            updatedAt: ts,
            createdBy: user.id,
          },
          {
            id: createId(),
            projectId: project.id,
            name: "Epic 2",
            status: "draft",
            priority: "medium",
            createdAt: ts,
            updatedAt: ts,
            createdBy: user.id,
          },
        ])
        .run();

      // Insert proposals
      testApp.db
        .insert(proposals)
        .values([
          {
            id: createId(),
            projectId: project.id,
            title: "Proposal 1",
            status: "open",
            createdBy: user.id,
            createdAt: ts,
            updatedAt: ts,
          },
          {
            id: createId(),
            projectId: project.id,
            title: "Proposal 2",
            status: "discussing",
            createdBy: user.id,
            createdAt: ts,
            updatedAt: ts,
          },
          {
            id: createId(),
            projectId: project.id,
            title: "Proposal 3",
            status: "accepted",
            createdBy: user.id,
            createdAt: ts,
            updatedAt: ts,
          },
        ])
        .run();

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/stats`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.epicCount).toBe(2);
      expect(body.data.proposalCount).toBe(3);
    });

    it("should return 404 for non-existent project", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${fakeId}/stats`,
      );
      expect(res.status).toBe(404);
    });

    it("should return data envelope", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/stats`,
      );
      const body = await res.json();

      expect(body).toHaveProperty("data");
      expect(body.data).toHaveProperty("tasksByStatus");
      expect(body.data).toHaveProperty("totalTasks");
      expect(body.data).toHaveProperty("epicCount");
      expect(body.data).toHaveProperty("proposalCount");
    });
  });

  // ── settings.integrator validation ────────────────────────────────
  describe("settings.integrator validation", () => {
    const validBaseSettings = {
      ai_autonomy: {
        can_self_assign: true,
        can_create_subtasks: true,
        can_create_tasks: false,
        can_change_priority: false,
        can_close_epics: false,
        max_concurrent_tasks: 3,
      },
      workflow: {
        statuses: ["backlog", "ready", "in_progress", "in_review", "done", "cancelled"],
      },
      git: {
        branch_prefix: "feat/",
        auto_link_branches: true,
      },
    };

    it("creates a project without an integrator block", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: {
          name: "P9-1",
          settings: validBaseSettings,
        },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.settings?.integrator).toBeUndefined();
    });

    it("accepts integrator.enabled = false and applies defaults", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: {
          name: "P9-2",
          settings: {
            ...validBaseSettings,
            integrator: { enabled: false },
          },
        },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.settings.integrator.enabled).toBe(false);
      expect(body.data.settings.integrator.verify_timeout_sec).toBe(600);
      expect(body.data.settings.integrator.git_remote).toBe("origin");
      expect(body.data.settings.integrator.git_main_branch).toBe("main");
      expect(body.data.settings.integrator.parallelism).toBe(1);
    });

    it("accepts a fully valid enabled integrator config and applies defaults", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/projects/${project.id}`,
        {
          body: {
            settings: {
              ...validBaseSettings,
              integrator: {
                enabled: true,
                verify_command: "pnpm test",
                worktree_root: "/tmp/wt",
              },
            },
          },
        },
      );
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      expect(body.data.settings.integrator.enabled).toBe(true);
      expect(body.data.settings.integrator.verify_command).toBe("pnpm test");
      expect(body.data.settings.integrator.worktree_root).toBe("/tmp/wt");
      expect(body.data.settings.integrator.verify_timeout_sec).toBe(600);
      expect(body.data.settings.integrator.git_remote).toBe("origin");
      expect(body.data.settings.integrator.git_main_branch).toBe("main");
    });

    it("rejects integrator.enabled = true without verify_command", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/projects/${project.id}`,
        {
          body: {
            settings: {
              ...validBaseSettings,
              integrator: { enabled: true, worktree_root: "/tmp/wt" },
            },
          },
        },
      );
      expect(res.status).toBe(400);
    });

    it("rejects integrator.enabled = true without worktree_root", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/projects/${project.id}`,
        {
          body: {
            settings: {
              ...validBaseSettings,
              integrator: { enabled: true, verify_command: "pnpm test" },
            },
          },
        },
      );
      expect(res.status).toBe(400);
    });

    it("round-trips a fully specified integrator config including non-default git fields", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/projects/${project.id}`,
        {
          body: {
            settings: {
              ...validBaseSettings,
              integrator: {
                enabled: true,
                verify_command: "make verify",
                verify_timeout_sec: 1200,
                worktree_root: "/var/wt",
                git_remote: "upstream",
                git_main_branch: "trunk",
                worktree_name: "game_one-int",
                parallelism: 3,
              },
            },
          },
        },
      );
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      const i = body.data.settings.integrator;
      expect(i.enabled).toBe(true);
      expect(i.verify_command).toBe("make verify");
      expect(i.verify_timeout_sec).toBe(1200);
      expect(i.worktree_root).toBe("/var/wt");
      expect(i.git_remote).toBe("upstream");
      expect(i.git_main_branch).toBe("trunk");
      expect(i.worktree_name).toBe("game_one-int");
      expect(i.parallelism).toBe(3);
    });

    it("rejects verify_timeout_sec < 1", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/projects/${project.id}`,
        {
          body: {
            settings: {
              ...validBaseSettings,
              integrator: {
                enabled: true,
                verify_command: "x",
                worktree_root: "/tmp",
                verify_timeout_sec: 0,
              },
            },
          },
        },
      );
      expect(res.status).toBe(400);
    });

    it("rejects parallelism < 1", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/projects/${project.id}`,
        {
          body: {
            settings: {
              ...validBaseSettings,
              integrator: {
                enabled: true,
                verify_command: "x",
                worktree_root: "/tmp",
                parallelism: 0,
              },
            },
          },
        },
      );
      expect(res.status).toBe(400);
    });
  });

  // ── OpenAPI spec ──────────────────────────────────────────────────
  describe("OpenAPI spec", () => {
    it("should include project endpoints in the spec", async () => {
      const res = await testApp.app.request("/api/v1/openapi.json");
      expect(res.status).toBe(200);

      const spec = await res.json();
      expect(spec.paths["/api/v1/projects"]).toBeDefined();
      expect(spec.paths["/api/v1/projects/{id}"]).toBeDefined();
      expect(spec.paths["/api/v1/projects/{id}/stats"]).toBeDefined();

      // Verify methods
      expect(spec.paths["/api/v1/projects"].get).toBeDefined();
      expect(spec.paths["/api/v1/projects"].post).toBeDefined();
      expect(spec.paths["/api/v1/projects/{id}"].get).toBeDefined();
      expect(spec.paths["/api/v1/projects/{id}"].patch).toBeDefined();
      expect(spec.paths["/api/v1/projects/{id}"].delete).toBeDefined();
      expect(spec.paths["/api/v1/projects/{id}/stats"].get).toBeDefined();
    });
  });
});
