import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestAiAgent,
  createTestProject,
  createTestProposal,
  createTestEpic,
  createTestTask,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";

describe("Epics API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── GET /api/v1/projects/:projectId/epics ──────────────────────────
  describe("GET /api/v1/projects/:projectId/epics", () => {
    it("should return empty list when no epics exist", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/epics`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({ total: 0 });
    });

    it("should return all epics for a project", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
      });
      createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/epics`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });

    it("should include task summary for each epic", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
      });

      // Add tasks to the epic
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        epicId: epic.id,
        status: "backlog",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        epicId: epic.id,
        status: "done",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/epics`,
      );
      const body = await res.json();

      expect(body.data[0].taskSummary).toBeDefined();
      expect(body.data[0].taskSummary.total).toBe(2);
      expect(body.data[0].taskSummary.done).toBe(1);
      expect(body.data[0].taskSummary.byStatus.backlog).toBe(1);
      expect(body.data[0].taskSummary.byStatus.done).toBe(1);
    });

    it("should filter by status", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        status: "active",
      });
      createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        status: "draft",
      });
      createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        status: "active",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/epics?status=active`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data.every((e: any) => e.status === "active")).toBe(true);
    });

    it("should not return epics from other projects", async () => {
      const project1 = createTestProject(testApp.db);
      const project2 = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      createTestEpic(testApp.db, {
        projectId: project1.id,
        createdBy: user.id,
      });
      createTestEpic(testApp.db, {
        projectId: project2.id,
        createdBy: user.id,
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project1.id}/epics`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });
  });

  // ── POST /api/v1/projects/:projectId/epics ─────────────────────────
  describe("POST /api/v1/projects/:projectId/epics", () => {
    it("should create an epic with valid data", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/epics`,
        { body: { name: "My New Epic" } },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toBe("My New Epic");
      expect(body.data.status).toBe("draft");
      expect(body.data.priority).toBe("medium");
      expect(body.data.projectId).toBe(project.id);
      expect(body.data.id).toBeDefined();
      expect(body.data.createdAt).toBeDefined();
      expect(body.data.updatedAt).toBeDefined();
      expect(body.data.taskSummary).toEqual({
        total: 0,
        done: 0,
        byStatus: {},
      });
    });

    it("should create an epic with all fields", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/epics`,
        {
          body: {
            name: "Full Epic",
            description: "A complete epic",
            status: "active",
            priority: "high",
            targetDate: "2026-12-31",
            sortOrder: 5,
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toBe("Full Epic");
      expect(body.data.description).toBe("A complete epic");
      expect(body.data.status).toBe("active");
      expect(body.data.priority).toBe("high");
      expect(body.data.targetDate).toBe("2026-12-31");
      expect(body.data.sortOrder).toBe(5);
    });

    it("should echo a category on create", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/epics`,
        { body: { name: "Categorized Epic", category: "Backend" } },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.category).toBe("Backend");
    });

    it("should default category to null when omitted", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/epics`,
        { body: { name: "Uncategorized Epic" } },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.category).toBeNull();
    });

    it("should reject missing name", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/epics`,
        { body: {} },
      );
      expect(res.status).toBe(400);
    });

    it("should reject empty name", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/epics`,
        { body: { name: "" } },
      );
      expect(res.status).toBe(400);
    });

    it("should allow creating an epic linked to a proposal in any non-terminal state", async () => {
      const project = createTestProject(testApp.db);
      for (const status of ["open", "discussing", "accepted", "in_progress"]) {
        const proposal = createTestProposal(testApp.db, {
          projectId: project.id,
          createdBy: testApp.testUser.id,
          status,
        });

        const res = await authRequest(
          testApp.app,
          "POST",
          `/api/v1/projects/${project.id}/epics`,
          { body: { name: `Epic for ${status}`, proposalId: proposal.id } },
        );
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.proposalId).toBe(proposal.id);
      }
    });

    it("should 404 when linking to a non-existent proposal", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/epics`,
        { body: { name: "Orphan", proposalId: createId() } },
      );
      expect(res.status).toBe(404);
    });

    it("should 409 when AI agent creates an epic on a proposal claimed by another agent", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: testApp.testUser.id,
        status: "discussing",
      });

      // Agent A claims
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: agentA.token,
      });

      // Agent B tries to add an epic
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/epics`,
        {
          token: agentB.token,
          body: { name: "Stealing work", proposalId: proposal.id },
        },
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("CLAIM_DENIED");
    });

    it("should allow an AI agent to create an epic on a proposal they hold", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        projectId: project.id,
        createdBy: testApp.testUser.id,
        status: "discussing",
      });

      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: agent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/epics`,
        {
          token: agent.token,
          body: { name: "Legit work", proposalId: proposal.id },
        },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.createdBy).toBe(agent.user.id);
    });

    it("should derive createdBy from authenticated caller", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/epics`,
        { body: { name: "Self-attributed" } },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.createdBy).toBe(testApp.testUser.id);
    });
  });

  // ── GET /api/v1/epics/:id ──────────────────────────────────────────
  describe("GET /api/v1/epics/:id", () => {
    it("should return an epic by ID with task summary", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);

      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        name: "Found Me",
      });

      // Add tasks
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        epicId: epic.id,
        status: "done",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        epicId: epic.id,
        status: "in_progress",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        epicId: epic.id,
        status: "done",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/epics/${epic.id}`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.id).toBe(epic.id);
      expect(body.data.name).toBe("Found Me");
      expect(body.data.taskSummary.total).toBe(3);
      expect(body.data.taskSummary.done).toBe(2);
      expect(body.data.taskSummary.byStatus.done).toBe(2);
      expect(body.data.taskSummary.byStatus.in_progress).toBe(1);
    });

    it("should return the epic's category", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        category: "Infra",
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/epics/${epic.id}`,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data.category).toBe("Infra");
    });

    it("should return 404 for non-existent epic", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/epics/${fakeId}`,
      );
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  // ── PATCH /api/v1/epics/:id ────────────────────────────────────────
  describe("PATCH /api/v1/epics/:id", () => {
    it("should update epic name", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        name: "Original",
      });

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/epics/${epic.id}`,
        { body: { name: "Updated Name" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.name).toBe("Updated Name");
    });

    it("should update epic status", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        status: "draft",
      });

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/epics/${epic.id}`,
        { body: { status: "active" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("active");
    });

    it("should update the updatedAt timestamp", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
      });

      const before = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/epics/${epic.id}`,
      );
      const beforeBody = await before.json();

      await new Promise((r) => setTimeout(r, 10));

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/epics/${epic.id}`,
        { body: { description: "trigger update" } },
      );
      const afterBody = await res.json();

      expect(afterBody.data.updatedAt).not.toBe(beforeBody.data.updatedAt);
    });

    it("should set then clear (null) the category", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
      });

      const setRes = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/epics/${epic.id}`,
        { body: { category: "Frontend" } },
      );
      expect(setRes.status).toBe(200);
      expect((await setRes.json()).data.category).toBe("Frontend");

      const clearRes = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/epics/${epic.id}`,
        { body: { category: null } },
      );
      expect(clearRes.status).toBe(200);
      expect((await clearRes.json()).data.category).toBeNull();
    });

    it("should return 404 for non-existent epic", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/epics/${fakeId}`,
        { body: { name: "Nope" } },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /api/v1/epics/:id ───────────────────────────────────────
  describe("DELETE /api/v1/epics/:id", () => {
    it("should archive an epic (set status to cancelled)", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        status: "active",
      });

      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/epics/${epic.id}`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.status).toBe("cancelled");
      expect(body.data.id).toBe(epic.id);
    });

    it("should return 404 for non-existent epic", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/epics/${fakeId}`,
      );
      expect(res.status).toBe(404);
    });

    it("should persist the cancelled status", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        createdBy: user.id,
        status: "active",
      });

      await authRequest(testApp.app, "DELETE", `/api/v1/epics/${epic.id}`);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/epics/${epic.id}`,
      );
      const body = await res.json();
      expect(body.data.status).toBe("cancelled");
    });
  });
});
