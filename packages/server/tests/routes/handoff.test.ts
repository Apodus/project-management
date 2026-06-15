import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createTestApp,
  createTestAiAgent,
  createTestProject,
  createTestEpic,
  createTestTask,
  createTestProposal,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId, LEASE_GRACE_MS_DEFAULT, LEASE_TTL_MS_DEFAULT } from "@pm/shared";
import * as auditService from "../../src/services/audit.service.js";

// ──────────────────────────────────────────────────────────────────
// Campaign C3 §P5b — the handoff REST endpoints: release-to +
// request-takeover, mirroring the force-claim route shape (authz +
// error envelopes). request-takeover is stomp-safe.
// ──────────────────────────────────────────────────────────────────

describe("Handoff endpoints (release-to + request-takeover)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    vi.useRealTimers();
    testApp.cleanup();
  });

  async function claimAs(entity: "tasks" | "epics" | "proposals", id: string, token: string) {
    const res = await authRequest(testApp.app, "POST", `/api/v1/${entity}/${id}/claim`, {
      token,
    });
    expect(res.status).toBe(200);
  }

  // ── release-to ────────────────────────────────────────────────────
  describe("POST /api/v1/tasks/:id/release-to", () => {
    it("happy path: holder (AI) hands off to another worker → 200, one audit row", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id, status: "ready" });
      await claimAs("tasks", task.id, agentA.token);

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/release-to`, {
        token: agentA.token,
        body: { reason: "handing off to B", targetId: agentB.user.id },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("force_claimed");
      expect(json.data.newHolder).toBe(agentB.user.id);

      const get = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}`);
      expect((await get.json()).data.assigneeId).toBe(agentB.user.id);

      const audit = auditService.list({ projectId: project.id, action: "force_claim" });
      expect(audit.data).toHaveLength(1);
    });

    it("empty reason → 400", async () => {
      const project = createTestProject(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id, status: "ready" });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/release-to`, {
        body: { reason: "", targetId: agentB.user.id },
      });
      expect(res.status).toBe(400);
    });

    it("missing target → 400", async () => {
      const project = createTestProject(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id, status: "ready" });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/release-to`, {
        body: { reason: "no target" },
      });
      expect(res.status).toBe(400);
    });

    it("unknown target user → 404", async () => {
      const project = createTestProject(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id, status: "ready" });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/release-to`, {
        body: { reason: "ghost", targetId: createId() },
      });
      expect(res.status).toBe(404);
    });

    it("non-holder AI agent → 403", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const intruder = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id, status: "ready" });
      await claimAs("tasks", task.id, agentA.token);

      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/release-to`, {
        token: intruder.token,
        body: { reason: "not mine", targetId: agentB.user.id },
      });
      expect(res.status).toBe(403);
    });

    it("unknown task id → 404", async () => {
      const agentB = createTestAiAgent(testApp.db);
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${createId()}/release-to`, {
        body: { reason: "nope", targetId: agentB.user.id },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/v1/epics/:id/release-to + /api/v1/proposals/:id/release-to", () => {
    it("epic: holder hands off → 200", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      await claimAs("epics", epic.id, agentA.token);
      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/release-to`, {
        token: agentA.token,
        body: { reason: "handing off epic", targetId: agentB.user.id },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).data.newHolder).toBe(agentB.user.id);
    });

    it("proposal: holder hands off → 200", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, { projectId: project.id, status: "open" });
      await claimAs("proposals", proposal.id, agentA.token);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/release-to`,
        { token: agentA.token, body: { reason: "handing off", targetId: agentB.user.id } },
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data.newHolder).toBe(agentB.user.id);
    });
  });

  // ── request-takeover ──────────────────────────────────────────────
  describe("POST /api/v1/tasks/:id/request-takeover", () => {
    it("LIVE claim → 200 notified_holder, nothing mutated", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id, status: "ready" });
      await claimAs("tasks", task.id, agentA.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/request-takeover`,
        { token: agentB.token, body: { reason: "may I have it" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.ok).toBe(false);
      expect(json.data.status).toBe("notified_holder");

      const get = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}`);
      expect((await get.json()).data.assigneeId).toBe(agentA.user.id);
      expect(auditService.list({ projectId: project.id, action: "force_claim" }).data).toHaveLength(
        0,
      );
    });

    it("STALE claim → 200 force_claimed, holder flips to requester", async () => {
      const t0 = new Date("2026-06-06T10:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(t0);

      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id, status: "ready" });
      await claimAs("tasks", task.id, agentA.token);

      vi.setSystemTime(
        new Date(t0.getTime() + LEASE_TTL_MS_DEFAULT + LEASE_GRACE_MS_DEFAULT + 60_000),
      );

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/request-takeover`,
        { token: agentB.token, body: { reason: "holder went dark" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("force_claimed");

      const get = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}`);
      expect((await get.json()).data.assigneeId).toBe(agentB.user.id);
    });

    it("empty reason → 400", async () => {
      const project = createTestProject(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id, status: "ready" });
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/request-takeover`,
        { body: { reason: "" } },
      );
      expect(res.status).toBe(400);
    });

    it("unknown task id → 404", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${createId()}/request-takeover`,
        { body: { reason: "nope" } },
      );
      expect(res.status).toBe(404);
    });

    it("epic + proposal request-takeover on a live claim → notified_holder", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      const proposal = createTestProposal(testApp.db, { projectId: project.id, status: "open" });
      await claimAs("epics", epic.id, agentA.token);
      await claimAs("proposals", proposal.id, agentA.token);

      const epicRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/epics/${epic.id}/request-takeover`,
        { token: agentB.token, body: { reason: "epic please" } },
      );
      expect(epicRes.status).toBe(200);
      expect((await epicRes.json()).data.status).toBe("notified_holder");

      const propRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/request-takeover`,
        { token: agentB.token, body: { reason: "proposal please" } },
      );
      expect(propRes.status).toBe(200);
      expect((await propRes.json()).data.status).toBe("notified_holder");
    });
  });
});
