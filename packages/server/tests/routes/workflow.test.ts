import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestProject,
  createTestTask,
  createTestAiAgent,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";
import { taskDependencies } from "../../src/db/index.js";

describe("Task Workflow API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── POST /api/v1/tasks/:id/transitions ─────────────────────────────

  describe("POST /api/v1/tasks/:id/transitions", () => {
    it("should transition backlog → ready", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "backlog",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "ready" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("ready");
    });

    it("should transition ready → in_progress", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "in_progress" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("in_progress");
    });

    it("should transition in_progress → in_review", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "in_progress",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "in_review" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("in_review");
    });

    it("should transition in_review → done", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "in_review",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "done" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("done");
    });

    it("should auto-chain backlog → ready → in_progress → done", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "backlog",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "done" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("done");
      expect(body.data.startedAt).toBeTruthy();
      expect(body.data.completedAt).toBeTruthy();
    });

    it("should reject invalid reverse transition done → backlog", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "done",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "backlog" } },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TRANSITION");
    });

    it("should reject invalid transition cancelled → ready", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "cancelled",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "ready" } },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TRANSITION");
    });

    it("should set started_at on transition to in_progress", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "in_progress" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.startedAt).toBeDefined();
      expect(body.data.startedAt).not.toBeNull();
    });

    it("should not overwrite started_at if already set", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
      });

      // First transition to in_progress
      const res1 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "in_progress" } },
      );
      const firstStartedAt = (await res1.json()).data.startedAt;

      // Transition back to in_review then to in_progress
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "in_review" } },
      );

      await new Promise((r) => setTimeout(r, 10));

      const res2 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "in_progress" } },
      );
      const secondStartedAt = (await res2.json()).data.startedAt;

      expect(secondStartedAt).toBe(firstStartedAt);
    });

    it("should set completed_at on transition to done", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "in_review",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "done" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.completedAt).toBeDefined();
      expect(body.data.completedAt).not.toBeNull();
    });

    it("should auto-assign task to actor on transition to in_progress", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        assigneeId: null,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "in_progress" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      // Assigned to the authenticated test user
      expect(body.data.assigneeId).toBe(testApp.testUser.id);
    });

    it("should create a comment when transition includes comment", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "backlog",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { body: { to_status: "ready", comment: "Ready for development" } },
      );
      expect(res.status).toBe(200);

      // Verify the comment was created
      const commentsRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/tasks/${task.id}/comments`,
      );
      const commentsBody = await commentsRes.json();
      expect(commentsBody.data).toHaveLength(1);
      expect(commentsBody.data[0].body).toBe("Ready for development");
    });

    it("should return 404 for non-existent task", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${fakeId}/transitions`,
        { body: { to_status: "ready" } },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/tasks/pick-next ───────────────────────────────────

  describe("POST /api/v1/tasks/pick-next", () => {
    it("should return the highest priority ready task", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "low",
        title: "Low priority",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "critical",
        title: "Critical priority",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "high",
        title: "High priority",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: {} },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.title).toBe("Critical priority");
      expect(body.data.status).toBe("in_progress");
      expect(body.data.assigneeId).toBe(testApp.testUser.id);
    });

    it("should skip blocked tasks", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      // Create a blocking task that is not done
      const blocker = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "in_progress",
        priority: "medium",
        title: "Blocker",
      });

      // Create a blocked task (high priority, but blocked)
      const blockedTask = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "critical",
        title: "Blocked task",
      });

      // Add blocking dependency
      const depId = createId();
      testApp.db
        .insert(taskDependencies)
        .values({
          id: depId,
          taskId: blockedTask.id,
          dependsOnTaskId: blocker.id,
          dependencyType: "blocks",
          createdAt: new Date().toISOString(),
        })
        .run();

      // Create an unblocked lower-priority task
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "low",
        title: "Unblocked task",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: {} },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.title).toBe("Unblocked task");
    });

    it("should skip assigned tasks", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const otherUser = createTestUser(testApp.db);

      // Create a ready task that is already assigned
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "critical",
        title: "Already assigned",
        assigneeId: otherUser.id,
      });

      // Create an unassigned ready task
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "low",
        title: "Unassigned task",
        assigneeId: null,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: {} },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.title).toBe("Unassigned task");
    });

    it("should respect projectId filter", async () => {
      const project1 = createTestProject(testApp.db);
      const project2 = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project1.id,
        reporterId: user.id,
        status: "ready",
        priority: "low",
        title: "Project 1 task",
      });
      createTestTask(testApp.db, {
        projectId: project2.id,
        reporterId: user.id,
        status: "ready",
        priority: "critical",
        title: "Project 2 task",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: { project_id: project1.id } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.title).toBe("Project 1 task");
    });

    it("should respect taskTypes filter", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "critical",
        type: "feature",
        title: "Feature task",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "low",
        type: "bug",
        title: "Bug task",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: { task_types: ["bug"] } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.title).toBe("Bug task");
    });

    it("should respect maxEffort filter", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "critical",
        estimatedEffort: "xl",
        title: "XL task",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "high",
        estimatedEffort: "s",
        title: "Small task",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "low",
        estimatedEffort: null,
        title: "No effort estimate",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: { max_effort: "m" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      // Should pick the highest priority eligible task
      // "XL task" is excluded, "Small task" (high) is eligible, "No effort estimate" (low) is also eligible
      expect(body.data.title).toBe("Small task");
    });

    it("should include tasks with null effort when maxEffort is set", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "critical",
        estimatedEffort: null,
        title: "No effort",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: { max_effort: "xs" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.title).toBe("No effort");
    });

    it("should return 404 when nothing available", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: {} },
      );
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("should atomically assign (no double-claim with sequential calls)", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      // Create a single ready task
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "critical",
        title: "Only task",
      });

      // First pick should succeed
      const res1 = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: {} },
      );
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.data.title).toBe("Only task");

      // Second pick should find nothing
      const res2 = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: {} },
      );
      expect(res2.status).toBe(404);
    });

    it("should enforce max_concurrent_tasks for AI agents", async () => {
      const project = createTestProject(testApp.db, {
        settings: {
          ai_autonomy: {
            can_self_assign: true,
            max_concurrent_tasks: 1,
          },
        },
      });
      const { user: agent, token: agentToken } = createTestAiAgent(testApp.db);

      // Create task already in_progress for this agent
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: agent.id,
        status: "in_progress",
        assigneeId: agent.id,
        title: "Already working",
      });

      // Create another ready task
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: agent.id,
        status: "ready",
        title: "Available task",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { token: agentToken, body: { project_id: project.id } },
      );
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("MAX_CONCURRENT_TASKS");
    });

    it("should set started_at on picked task", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        title: "Ready task",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: {} },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.startedAt).toBeDefined();
      expect(body.data.startedAt).not.toBeNull();
    });

    it("should order by priority then created_at", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      // Create two tasks with same priority
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "high",
        title: "First created",
      });
      await new Promise((r) => setTimeout(r, 10));
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "ready",
        priority: "high",
        title: "Second created",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: {} },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      // Should pick the first created task (older)
      expect(body.data.title).toBe("First created");
    });
  });

  // ── Autonomy guardrails ────────────────────────────────────────────

  describe("Autonomy guardrails", () => {
    it("should block AI agent from self-assigning when can_self_assign=false", async () => {
      const project = createTestProject(testApp.db, {
        settings: {
          ai_autonomy: {
            can_self_assign: false,
          },
        },
      });
      const { user: agent, token: agentToken } = createTestAiAgent(testApp.db);

      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: agent.id,
        status: "ready",
        title: "Available task",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { token: agentToken, body: { project_id: project.id } },
      );
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("GUARDRAIL_BLOCKED");
      expect(body.error.message).toContain("self-assign");
    });

    it("should block AI agent from creating tasks when can_create_tasks is explicitly disabled", async () => {
      const project = createTestProject(testApp.db, {
        settings: {
          ai_autonomy: {
            can_create_tasks: false,
          },
        },
      });
      const { user: agent, token: agentToken } = createTestAiAgent(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        {
          token: agentToken,
          body: {
            title: "AI created task",
            reporterId: agent.id,
          },
        },
      );
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("GUARDRAIL_BLOCKED");
      expect(body.error.message).toContain("create tasks");
    });

    it("should allow AI agent to create tasks by default (symmetric with epic and subtask creation)", async () => {
      const project = createTestProject(testApp.db);
      const { user: agent, token: agentToken } = createTestAiAgent(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        {
          token: agentToken,
          body: {
            title: "AI created task",
            reporterId: agent.id,
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.title).toBe("AI created task");
    });

    it("should block AI agent from changing priority when can_change_priority=false (default)", async () => {
      const project = createTestProject(testApp.db);
      const { user: agent, token: agentToken } = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: agent.id,
        priority: "medium",
      });

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/tasks/${task.id}`,
        {
          token: agentToken,
          body: { priority: "critical" },
        },
      );
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("GUARDRAIL_BLOCKED");
      expect(body.error.message).toContain("change task priority");
    });

    it("should allow AI agent to change priority when can_change_priority=true", async () => {
      const project = createTestProject(testApp.db, {
        settings: {
          ai_autonomy: {
            can_change_priority: true,
          },
        },
      });
      const { user: agent, token: agentToken } = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: agent.id,
        priority: "medium",
      });

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/tasks/${task.id}`,
        {
          token: agentToken,
          body: { priority: "critical" },
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.priority).toBe("critical");
    });

    it("should block AI agent from creating subtasks when can_create_subtasks=false", async () => {
      const project = createTestProject(testApp.db, {
        settings: {
          ai_autonomy: {
            can_create_subtasks: false,
          },
        },
      });
      const { user: agent, token: agentToken } = createTestAiAgent(testApp.db);
      const parentTask = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: agent.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${parentTask.id}/subtasks`,
        {
          token: agentToken,
          body: {
            title: "AI subtask",
            reporterId: agent.id,
          },
        },
      );
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("GUARDRAIL_BLOCKED");
      expect(body.error.message).toContain("create subtasks");
    });

    it("should not constrain humans with autonomy guardrails", async () => {
      const project = createTestProject(testApp.db, {
        settings: {
          ai_autonomy: {
            can_create_tasks: false,
            can_change_priority: false,
            can_self_assign: false,
            can_create_subtasks: false,
          },
        },
      });

      // Human can still create tasks even when AI is blocked
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/tasks`,
        {
          body: {
            title: "Human created task",
            reporterId: testApp.testUser.id,
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      const taskId = body.data.id;

      // Human can change priority
      const patchRes = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/tasks/${taskId}`,
        { body: { priority: "critical" } },
      );
      expect(patchRes.status).toBe(200);

      // Human can pick-next
      const task2 = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: testApp.testUser.id,
        status: "ready",
      });
      const pickRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { body: {} },
      );
      expect(pickRes.status).toBe(200);
    });

    it("should use default guardrails when project has no settings", async () => {
      const project = createTestProject(testApp.db);
      const { user: agent, token: agentToken } = createTestAiAgent(testApp.db);

      // Default: can_self_assign=true, so pick-next should work
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: agent.id,
        status: "ready",
        title: "Ready task",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/tasks/pick-next",
        { token: agentToken, body: { project_id: project.id } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.title).toBe("Ready task");
    });
  });

  // ── PATCH /api/v1/tasks/:id rejects status changes ────────────────

  describe("PATCH /api/v1/tasks/:id status rejection", () => {
    it("should not change status via PATCH (status field stripped by schema)", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        status: "backlog",
      });

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/tasks/${task.id}`,
        { body: { status: "done" } },
      );
      // Status is stripped from the body by Zod, so PATCH succeeds but status is unchanged
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("backlog");
    });
  });
});
