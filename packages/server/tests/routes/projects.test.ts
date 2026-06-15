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

      const res = await authRequest(testApp.app, "GET", "/api/v1/projects?status=active");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data.every((p: any) => p.status === "active")).toBe(true);
    });

    it("should return empty list for status filter with no matches", async () => {
      createTestProject(testApp.db, { status: "active" });

      const res = await authRequest(testApp.app, "GET", "/api/v1/projects?status=paused");
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
      const res1 = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "Duplicate Name" },
      });
      const body1 = await res1.json();
      expect(body1.data.slug).toBe("duplicate-name");

      // Create second project with same name
      const res2 = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "Duplicate Name" },
      });
      const body2 = await res2.json();
      expect(body2.data.slug).toBe("duplicate-name-2");

      // Create third project with same name
      const res3 = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "Duplicate Name" },
      });
      const body3 = await res3.json();
      expect(body3.data.slug).toBe("duplicate-name-3");
    });
  });

  // ── GET /api/v1/projects/:id ──────────────────────────────────────
  describe("GET /api/v1/projects/:id", () => {
    it("should return a project by ID", async () => {
      const project = createTestProject(testApp.db, { name: "Found Me" });

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.id).toBe(project.id);
      expect(body.data.name).toBe("Found Me");
    });

    it("should return 404 for non-existent project", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${fakeId}`);
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("should return data envelope", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await res.json();
      expect(body).toHaveProperty("data");
      expect(body.data.id).toBe(project.id);
    });
  });

  // ── PATCH /api/v1/projects/:id ────────────────────────────────────
  describe("PATCH /api/v1/projects/:id", () => {
    it("should update project name", async () => {
      const project = createTestProject(testApp.db, { name: "Original" });

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: { name: "Updated Name" },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.name).toBe("Updated Name");
      expect(body.data.slug).toBe("updated-name");
    });

    it("should update project description", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: { description: "New description" },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.description).toBe("New description");
    });

    it("should update the updatedAt timestamp", async () => {
      const project = createTestProject(testApp.db);

      // Get current state
      const before = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const beforeBody = await before.json();

      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 10));

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: { description: "trigger update" },
      });
      const afterBody = await res.json();

      expect(afterBody.data.updatedAt).not.toBe(beforeBody.data.updatedAt);
    });

    it("should return 404 for non-existent project", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${fakeId}`, {
        body: { name: "Nope" },
      });
      expect(res.status).toBe(404);
    });

    it("should handle no-op update (empty body)", async () => {
      const project = createTestProject(testApp.db, { name: "NoOp" });

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {},
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.name).toBe("NoOp");
    });
  });

  // ── PATCH verify-cache guardrail warnings (C2) ────────────────────
  describe("PATCH verify-cache config guardrail (C2)", () => {
    function integratorSettings(overrides: Record<string, unknown> = {}) {
      return {
        settings: {
          integrator: {
            enabled: false,
            ...overrides,
          },
        },
      };
    }

    it("cache_enabled + cache_mode on + steps lacking cache_key_inputs → 200 WITH warnings naming each step", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: integratorSettings({
          cache_enabled: true,
          cache_mode: "on",
          verify_steps: [
            { id: "lint", command: "pnpm lint" },
            { id: "test", command: "pnpm test", cache_key_inputs: ["node -v"] },
            { id: "build", command: "pnpm build", depends_on: ["lint"] },
          ],
        }),
      });
      expect(res.status).toBe(200); // NEVER a 400 — advisory only.
      const body = await res.json();
      expect(body.warnings).toHaveLength(1);
      const warning = body.warnings[0] as string;
      // Names exactly the offending steps (test has inputs → not named).
      expect(warning).toContain('"lint"');
      expect(warning).toContain('"build"');
      expect(warning).not.toContain('"test"');
      // Cites the false-pass precondition + the shadow-first discipline.
      expect(warning).toContain("§16.2");
      expect(warning).toContain("false-pass");
      expect(warning).toContain("shadow");
    });

    it("cache on + EMPTY verify_steps → warns on the synthetic verify_command step", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: integratorSettings({ cache_enabled: true, cache_mode: "on" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0]).toContain("synthetic verify_command step");
    });

    it("all steps declare cache_key_inputs → NO warnings key", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: integratorSettings({
          cache_enabled: true,
          cache_mode: "on",
          verify_steps: [{ id: "verify", command: "pnpm verify", cache_key_inputs: ["node -v"] }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect("warnings" in body).toBe(false); // omitted, never []
    });

    it("cache_mode shadow → NO warnings key (shadow always runs the real step)", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: integratorSettings({
          cache_enabled: true,
          cache_mode: "shadow",
          verify_steps: [{ id: "lint", command: "pnpm lint" }],
        }),
      });
      const body = await res.json();
      expect("warnings" in body).toBe(false);
    });

    it("cache_enabled false (mode on but kill-switch off) → NO warnings key", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: integratorSettings({
          cache_enabled: false,
          cache_mode: "on",
          verify_steps: [{ id: "lint", command: "pnpm lint" }],
        }),
      });
      const body = await res.json();
      expect("warnings" in body).toBe(false);
    });

    it("warnings derive from the PERSISTED settings — a later non-settings PATCH on a dangerous stored config still warns", async () => {
      const project = createTestProject(testApp.db);
      await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: integratorSettings({ cache_enabled: true, cache_mode: "on" }),
      });
      // PATCH only the name; the stored cache config is unchanged-dangerous.
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: { name: "Renamed" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe("Renamed");
      expect(body.warnings).toHaveLength(1);
    });

    it("plain PATCH with no integrator settings stored → NO warnings key (byte-identical envelope)", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: { name: "Plain" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect("warnings" in body).toBe(false);
    });
  });

  // ── DELETE /api/v1/projects/:id ───────────────────────────────────
  describe("DELETE /api/v1/projects/:id", () => {
    it("should archive a project (set status to archived)", async () => {
      const project = createTestProject(testApp.db, { status: "active" });

      const res = await authRequest(testApp.app, "DELETE", `/api/v1/projects/${project.id}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("archived");
      expect(body.data.id).toBe(project.id);
    });

    it("should return 404 for non-existent project", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "DELETE", `/api/v1/projects/${fakeId}`);
      expect(res.status).toBe(404);
    });

    it("should persist the archived status", async () => {
      const project = createTestProject(testApp.db, { status: "active" });

      await authRequest(testApp.app, "DELETE", `/api/v1/projects/${project.id}`);

      // Verify by fetching it again
      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await res.json();
      expect(body.data.status).toBe("archived");
    });
  });

  // ── GET /api/v1/projects/:id/stats ────────────────────────────────
  describe("GET /api/v1/projects/:id/stats", () => {
    it("should return zero counts for project with no tasks/epics/proposals", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}/stats`);
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

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}/stats`);
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

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}/stats`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.epicCount).toBe(2);
      expect(body.data.proposalCount).toBe(3);
    });

    it("should return 404 for non-existent project", async () => {
      const fakeId = createId();
      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${fakeId}/stats`);
      expect(res.status).toBe(404);
    });

    it("should return data envelope", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}/stats`);
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

    it("accepts a PARTIAL settings PATCH that omits ai_autonomy/workflow/git", async () => {
      // Regression: a project whose stored settings are null/partial (created via
      // the API or MCP without a full seed) must still be able to save a single
      // settings sub-block. The web settings pages each read-merge-write one block,
      // so requiring the three core blocks made every settings page un-saveable.
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            // A PARTIAL ai_autonomy block (only one of its six fields) — exactly what
            // the web settings pages preserve when a project's stored settings were
            // seeded partially. The block, and its inner fields, must both be optional.
            ai_autonomy: { can_create_tasks: true },
            integrator: {
              resolver: { enabled: true, max_concurrent: 1, time_budget_sec: 600 },
            },
          },
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.settings.integrator.resolver.enabled).toBe(true);
      expect(body.data.settings.ai_autonomy).toEqual({ can_create_tasks: true });
      expect(body.data.settings.workflow).toBeUndefined();
      expect(body.data.settings.git).toBeUndefined();
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
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
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
      });
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
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            integrator: { enabled: true, worktree_root: "/tmp/wt" },
          },
        },
      });
      expect(res.status).toBe(400);
    });

    it("rejects integrator.enabled = true without worktree_root", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            integrator: { enabled: true, verify_command: "pnpm test" },
          },
        },
      });
      expect(res.status).toBe(400);
    });

    it("round-trips a fully specified integrator config including non-default git fields", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
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
      });
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
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
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
      });
      expect(res.status).toBe(400);
    });

    it("rejects parallelism < 1", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
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
      });
      expect(res.status).toBe(400);
    });

    it("defaults linked_repos to [] when integrator config omits it", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
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
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      expect(body.data.settings.integrator.linked_repos).toEqual([]);
    });

    it("round-trips a valid 2-entry linked_repos config", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            integrator: {
              enabled: true,
              verify_command: "pnpm test",
              worktree_root: "/tmp/wt",
              linked_repos: [
                {
                  name: "rynx-inner",
                  path: "engine",
                  role: "inner",
                  gitlink_parent: "game_one",
                  gitlink_path: "vendor/rynx",
                },
                {
                  name: "game_one",
                  path: ".",
                  role: "outer",
                },
              ],
            },
          },
        },
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      const repos = body.data.settings.integrator.linked_repos;
      expect(repos).toHaveLength(2);
      expect(repos[0]).toEqual({
        name: "rynx-inner",
        path: "engine",
        role: "inner",
        gitlink_parent: "game_one",
        gitlink_path: "vendor/rynx",
      });
      expect(repos[1]).toEqual({
        name: "game_one",
        path: ".",
        role: "outer",
      });
    });

    it("defaults clean_keep to [] when integrator config omits it", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
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
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      expect(body.data.settings.integrator.clean_keep).toEqual([]);
    });

    it("round-trips a non-empty clean_keep config", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            integrator: {
              enabled: true,
              verify_command: "pnpm test",
              worktree_root: "/tmp/wt",
              clean_keep: ["node_modules", ".cache"],
            },
          },
        },
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      expect(body.data.settings.integrator.clean_keep).toEqual(["node_modules", ".cache"]);
    });

    it("rejects linked_repos with an invalid role", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            integrator: {
              enabled: true,
              verify_command: "x",
              worktree_root: "/tmp",
              linked_repos: [{ name: "rynx", path: "engine", role: "sideways" }],
            },
          },
        },
      });
      expect(res.status).toBe(400);
    });

    // ── slo + heartbeat_interval_sec (Phase 7.4 §6.1) ──────────────
    it("accepts a fully specified slo block and round-trips it", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            integrator: {
              enabled: true,
              verify_command: "pnpm test",
              worktree_root: "/tmp/wt",
              slo: {
                target_p95_time_to_land_sec: 600,
                target_verify_success_rate: 0.9,
                target_abandon_rate: 0.1,
              },
            },
          },
        },
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      expect(body.data.settings.integrator.slo).toEqual({
        target_p95_time_to_land_sec: 600,
        target_verify_success_rate: 0.9,
        target_abandon_rate: 0.1,
      });
    });

    it("defaults slo to undefined and heartbeat_interval_sec to 30 when omitted", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
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
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      expect(body.data.settings.integrator.slo).toBeUndefined();
      expect(body.data.settings.integrator.heartbeat_interval_sec).toBe(30);
    });

    it("rejects slo.target_verify_success_rate > 1 (proves the Zod-4 mirror validates)", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            integrator: {
              enabled: true,
              verify_command: "pnpm test",
              worktree_root: "/tmp/wt",
              slo: { target_verify_success_rate: 1.5 },
            },
          },
        },
      });
      expect(res.status).toBe(400);
    });

    it("rejects slo.target_abandon_rate < 0", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            integrator: {
              enabled: true,
              verify_command: "pnpm test",
              worktree_root: "/tmp/wt",
              slo: { target_abandon_rate: -0.1 },
            },
          },
        },
      });
      expect(res.status).toBe(400);
    });

    it("rejects heartbeat_interval_sec < 5", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            integrator: {
              enabled: true,
              verify_command: "pnpm test",
              worktree_root: "/tmp/wt",
              heartbeat_interval_sec: 1,
            },
          },
        },
      });
      expect(res.status).toBe(400);
    });

    // ── Phase 7.5 verify_steps DAG + cache config (design §2.1/§8.1) ──
    const patchIntegrator = (project: { id: string }, integrator: unknown) =>
      authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: { settings: { ...validBaseSettings, integrator } },
      });

    it("accepts a valid DAG + cache config (200) and round-trips it with defaults applied", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm verify",
        worktree_root: "/tmp/wt",
        cache_enabled: true,
        cache_mode: "shadow",
        verify_steps: [
          { id: "format", command: "pnpm format:check" },
          { id: "lint", command: "pnpm lint", depends_on: ["format"] },
          { id: "typecheck", command: "pnpm typecheck", depends_on: ["format"] },
          { id: "unit", command: "pnpm test", depends_on: ["lint", "typecheck"] },
        ],
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      const i = body.data.settings.integrator;
      expect(i.cache_enabled).toBe(true);
      expect(i.cache_mode).toBe("shadow");
      expect(i.verify_steps).toHaveLength(4);
      expect(i.verify_steps[3]).toEqual({
        id: "unit",
        command: "pnpm test",
        depends_on: ["lint", "typecheck"],
        cache_key_inputs: [],
      });
    });

    it("defaults verify_steps to [], cache_enabled false, cache_mode off when omitted", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      const i = body.data.settings.integrator;
      expect(i.verify_steps).toEqual([]);
      expect(i.cache_enabled).toBe(false);
      expect(i.cache_mode).toBe("off");
    });

    it("backward-compat: enabled + verify_command only (no steps) still passes (200)", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
      });
      expect(res.status).toBe(200);
    });

    it("extended refine: enabled + verify_steps (no verify_command) now passes (200)", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        worktree_root: "/tmp/wt",
        verify_steps: [{ id: "unit", command: "pnpm test" }],
      });
      expect(res.status).toBe(200);
    });

    it("rejects a 2-cycle (a->b, b->a) with 400 (proves the Zod-4 mirror validates)", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
        verify_steps: [
          { id: "a", command: "x", depends_on: ["b"] },
          { id: "b", command: "y", depends_on: ["a"] },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects a 3-cycle (a->b->c->a) with 400", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
        verify_steps: [
          { id: "a", command: "x", depends_on: ["c"] },
          { id: "b", command: "y", depends_on: ["a"] },
          { id: "c", command: "z", depends_on: ["b"] },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects a self-loop (a->a) with 400", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
        verify_steps: [{ id: "a", command: "x", depends_on: ["a"] }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects a dangling depends_on reference with 400", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
        verify_steps: [{ id: "a", command: "x", depends_on: ["ghost"] }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects a duplicate verify_steps id with 400", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
        verify_steps: [
          { id: "a", command: "x" },
          { id: "a", command: "y" },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects an invalid cache_mode with 400", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
        cache_mode: "maybe",
      });
      expect(res.status).toBe(400);
    });

    // ── Phase 7.6 resolver config (design §3) ──
    it("accepts a full resolver block (200) and round-trips it via PATCH→GET", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm verify",
        worktree_root: "/tmp/wt",
        resolver: {
          enabled: true,
          max_concurrent: 3,
          time_budget_sec: 900,
          token_budget: 50000,
          command: "claude -p",
        },
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      expect(body.data.settings.integrator.resolver).toEqual({
        enabled: true,
        max_concurrent: 3,
        time_budget_sec: 900,
        token_budget: 50000,
        command: "claude -p",
      });
    });

    it("applies resolver field defaults on PATCH when only enabled is given", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
        resolver: { enabled: true },
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      const r = body.data.settings.integrator.resolver;
      expect(r.enabled).toBe(true);
      expect(r.max_concurrent).toBe(1);
      expect(r.time_budget_sec).toBe(3600);
    });

    // The absent-block test proves the Zod-4 mirror's `.prefault({})` form yields
    // the full inert object (not a literal `{}`) on the route side, matching the
    // Zod-3 canonical `.default({})`.
    it("treats an absent resolver block as the full inert default through the route", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: false,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      expect(body.data.settings.integrator.resolver).toEqual({
        enabled: false,
        max_concurrent: 1,
        time_budget_sec: 3600,
      });
    });

    it("treats an empty resolver block as the full inert default through the route", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: false,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
        resolver: {},
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      expect(body.data.settings.integrator.resolver).toEqual({
        enabled: false,
        max_concurrent: 1,
        time_budget_sec: 3600,
      });
    });

    it("rejects resolver.max_concurrent = 0 with 400", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
        resolver: { max_concurrent: 0 },
      });
      expect(res.status).toBe(400);
    });

    it("rejects resolver.time_budget_sec = 0 with 400", async () => {
      const project = createTestProject(testApp.db);
      const res = await patchIntegrator(project, {
        enabled: true,
        verify_command: "pnpm test",
        worktree_root: "/tmp/wt",
        resolver: { time_budget_sec: 0 },
      });
      expect(res.status).toBe(400);
    });
  });

  // ── settings.webhooks validation (Phase 7.4 §7.2 — the Zod-4 mirror) ──
  describe("settings.webhooks validation", () => {
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
      git: { branch_prefix: "feat/", auto_link_branches: true },
    };

    it("round-trips a valid discord_url + alerts_enabled through PATCH → GET", async () => {
      const project = createTestProject(testApp.db);
      const url = "https://discord.com/api/webhooks/123456/abcdef";
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            webhooks: { discord_url: url, alerts_enabled: true },
          },
        },
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      // Proves the mirror does NOT strip discord_url.
      expect(body.data.settings.webhooks.discord_url).toBe(url);
      expect(body.data.settings.webhooks.alerts_enabled).toBe(true);
    });

    it("rejects a non-URL discord_url with 400 (the Zod-4 mirror validates)", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            webhooks: { discord_url: "not-a-url" },
          },
        },
      });
      expect(res.status).toBe(400);
    });
  });

  // ── settings.autoImplement validation (the Zod-4 mirror — lockstep proof) ──
  describe("settings.autoImplement validation", () => {
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
      git: { branch_prefix: "feat/", auto_link_branches: true },
    };

    it("round-trips a full autoImplement block through PATCH → GET (mirror does not strip it)", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            autoImplement: { enabled: true, mode: "on" },
          },
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // Proves the mirror does NOT strip autoImplement (the lockstep proof).
      expect(body.data.settings.autoImplement).toEqual({ enabled: true, mode: "on" });
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const getBody = await get.json();
      expect(getBody.data.settings.autoImplement).toEqual({ enabled: true, mode: "on" });
    });

    it("fills the mode default (shadow) for a partial autoImplement block", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            autoImplement: { enabled: true },
          },
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.settings.autoImplement).toEqual({ enabled: true, mode: "shadow" });
    });

    it("reads a project with no autoImplement block as undefined (tolerant off, byte-identical)", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/projects", {
        body: { name: "AI-off", settings: validBaseSettings },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.settings?.autoImplement).toBeUndefined();
    });

    it("rejects an invalid autoImplement mode with 400 (the Zod-4 mirror validates)", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            autoImplement: { mode: "bogus" },
          },
        },
      });
      expect(res.status).toBe(400);
    });
  });

  // ── settings.epic_categories validation (the Zod-4 mirror) ──
  describe("settings.epic_categories validation", () => {
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
      git: { branch_prefix: "feat/", auto_link_branches: true },
    };

    it("round-trips a valid epic_categories array through PATCH → GET", async () => {
      const project = createTestProject(testApp.db);
      const epic_categories = [
        { name: "Backend", color: "#FF0000", sort_order: 0 },
        { name: "Frontend", color: "#00FF00", sort_order: 1 },
      ];
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: { settings: { ...validBaseSettings, epic_categories } },
      });
      expect(res.status).toBe(200);
      const get = await authRequest(testApp.app, "GET", `/api/v1/projects/${project.id}`);
      const body = await get.json();
      // Proves the mirror does NOT strip epic_categories.
      expect(body.data.settings.epic_categories).toEqual(epic_categories);
    });

    it("rejects an epic_categories entry with an empty name with 400", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            epic_categories: [{ name: "", color: "#FF0000", sort_order: 0 }],
          },
        },
      });
      expect(res.status).toBe(400);
    });

    it("rejects an epic_categories entry missing sort_order with 400", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/projects/${project.id}`, {
        body: {
          settings: {
            ...validBaseSettings,
            epic_categories: [{ name: "Backend", color: "#FF0000" }],
          },
        },
      });
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
