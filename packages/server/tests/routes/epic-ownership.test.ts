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
    it("should claim an unowned epic and return claimed_by_you", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual({ ok: true, status: "claimed_by_you" });

      // Verify assigneeId was set
      const epicRes = await authRequest(testApp.app, "GET", `/api/v1/epics/${epic.id}`);
      const epicBody = await epicRes.json();
      expect(epicBody.data.assigneeId).toBe(testApp.testUser.id);
    });

    it("should return already_claimed_by_you when re-claiming your own epic", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`);

      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({ ok: true, status: "already_claimed_by_you" });
    });

    it("should return claimed_by_another_agent without leaking claimant ID", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      // First user claims
      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`);

      // Second user tries to claim
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`, {
        token: agent.token,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({
        ok: false,
        status: "claimed_by_another_agent",
      });
      // Should NOT leak the claimant's identity
      expect(JSON.stringify(body)).not.toContain(testApp.testUser.id);
    });

    it("should return closed for terminal epics", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, {
        projectId: project.id,
        status: "completed",
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({ ok: false, status: "closed" });
    });

    it("should return 404 for nonexistent epic", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/epics/nonexistent/claim");
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/epics/:id/release ────────────────────────────

  describe("POST /api/v1/epics/:id/release", () => {
    it("should release a claimed epic and return released", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`);

      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/release`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({ ok: true, status: "released" });

      // Verify assigneeId is cleared
      const epicRes = await authRequest(testApp.app, "GET", `/api/v1/epics/${epic.id}`);
      const epicBody = await epicRes.json();
      expect(epicBody.data.assigneeId).toBeNull();
    });

    it("should return not_held for an unclaimed epic", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/release`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({ ok: false, status: "not_held" });
    });

    it("should let humans release a claim held by another agent", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      const agent = createTestAiAgent(testApp.db);

      // Agent claims
      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`, {
        token: agent.token,
      });

      // Human (testUser) releases
      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/release`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({ ok: true, status: "released" });
    });

    it("should block AI agents from releasing another agent's claim", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);

      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`, {
        token: agentA.token,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/release`, {
        token: agentB.token,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({
        ok: false,
        status: "claimed_by_another_agent",
      });
    });
  });

  // ── Epic data includes assigneeId and claim_status ────────────

  describe("GET /api/v1/epics/:id", () => {
    it("should include assigneeId and claimStatus in epic response", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      // Before claiming
      const res1 = await authRequest(testApp.app, "GET", `/api/v1/epics/${epic.id}`);
      const body1 = await res1.json();
      expect(body1.data.assigneeId).toBeNull();
      expect(body1.data.claimStatus).toBe("unclaimed");
      // C3.P1: claim_state alongside claim_status.
      expect(body1.data.claimState).toBe("unclaimed");

      // After claiming
      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`);
      const res2 = await authRequest(testApp.app, "GET", `/api/v1/epics/${epic.id}`);
      const body2 = await res2.json();
      expect(body2.data.assigneeId).toBe(testApp.testUser.id);
      expect(body2.data.claimStatus).toBe("claimed_by_you");
      expect(body2.data.claimState).toBe("yours");
    });

    it("should show claimed_by_other to a different caller", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      const agent = createTestAiAgent(testApp.db);

      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`);

      const res = await authRequest(testApp.app, "GET", `/api/v1/epics/${epic.id}`, {
        token: agent.token,
      });
      const body = await res.json();
      expect(body.data.claimStatus).toBe("claimed_by_other");
      // C3.P1: another caller sees claimState "live" (held, no lease → fail-safe).
      expect(body.data.claimState).toBe("live");
    });
  });

  // ── Claim filter on epic list ─────────────────────────────────

  describe("GET /api/v1/projects/:projectId/epics?claim=...", () => {
    it("?claim=available excludes epics claimed by other agents", async () => {
      const project = createTestProject(testApp.db);
      const epicMine = createTestEpic(testApp.db, {
        projectId: project.id,
        name: "Mine",
      });
      const epicOther = createTestEpic(testApp.db, {
        projectId: project.id,
        name: "Other",
      });
      const epicUnclaimed = createTestEpic(testApp.db, {
        projectId: project.id,
        name: "Free",
      });

      const agent = createTestAiAgent(testApp.db);

      // testUser claims one, agent claims another
      await authRequest(testApp.app, "POST", `/api/v1/epics/${epicMine.id}/claim`);
      await authRequest(testApp.app, "POST", `/api/v1/epics/${epicOther.id}/claim`, {
        token: agent.token,
      });

      // testUser asks for "available"
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/epics?claim=available`,
      );
      const body = await res.json();
      const names = body.data.map((e: { name: string }) => e.name).sort();
      expect(names).toEqual(["Free", "Mine"]);
    });

    it("?claim=mine returns only epics claimed by caller", async () => {
      const project = createTestProject(testApp.db);
      const epicMine = createTestEpic(testApp.db, {
        projectId: project.id,
        name: "Mine",
      });
      createTestEpic(testApp.db, { projectId: project.id, name: "Free" });

      await authRequest(testApp.app, "POST", `/api/v1/epics/${epicMine.id}/claim`);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/epics?claim=mine`,
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe("Mine");
      // C3.P1: list-view rows carry claimState (the caller holds this one).
      expect(body.data[0].claimState).toBe("yours");
    });
  });

  // ── Claim gating on writes ────────────────────────────────────

  describe("Claim gating on writes", () => {
    it("AI agent without claim cannot update an epic (409)", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      const agent = createTestAiAgent(testApp.db);

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/epics/${epic.id}`, {
        token: agent.token,
        body: { name: "Renamed" },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("CLAIM_DENIED");
    });

    it("AI agent with claim can update an epic", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      const agent = createTestAiAgent(testApp.db);

      // Claim first
      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`, {
        token: agent.token,
      });

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/epics/${epic.id}`, {
        token: agent.token,
        body: { name: "Renamed" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe("Renamed");
    });

    it("Humans can always update an epic without claiming", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/epics/${epic.id}`, {
        body: { name: "Human edit" },
      });
      expect(res.status).toBe(200);
    });

    it("Transitioning to a terminal status clears the claim", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      const agent = createTestAiAgent(testApp.db);

      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`, {
        token: agent.token,
      });

      // Complete via update
      await authRequest(testApp.app, "PATCH", `/api/v1/epics/${epic.id}`, {
        token: agent.token,
        body: { status: "completed" },
      });

      const res = await authRequest(testApp.app, "GET", `/api/v1/epics/${epic.id}`);
      const body = await res.json();
      expect(body.data.assigneeId).toBeNull();
      expect(body.data.status).toBe("completed");
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
      const res = await authRequest(testApp.app, "POST", "/api/v1/tasks/pick-next", {
        body: { epic_id: epic1.id },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.epicId).toBe(epic1.id);
      expect(body.data.title).toBe("Task in Epic A");
    });

    it("should return 404 when no tasks in the specified epic", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });

      const res = await authRequest(testApp.app, "POST", "/api/v1/tasks/pick-next", {
        body: { epic_id: epic.id },
      });
      expect(res.status).toBe(404);
    });
  });
});
