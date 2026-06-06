import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { createId } from "@pm/shared";
import { proposals } from "../../src/db/index.js";
import * as auditService from "../../src/services/audit.service.js";
import * as proposalService from "../../src/services/proposal.service.js";

describe("Force-claim (reason-required claim takeover)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Tasks ──────────────────────────────────────────────────────
  describe("POST /api/v1/tasks/:id/force-claim", () => {
    it("the headline scenario: B takes over A's claim and then completes the task (no CLAIM_DENIED)", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        status: "in_progress",
        assigneeId: agentA.user.id,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/force-claim`,
        { token: agentB.token, body: { reason: "my session identity flipped" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        ok: true,
        status: "force_claimed",
        previousHolder: agentA.user.id,
        newHolder: agentB.user.id,
      });

      // GET shows holder = B.
      const get = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}`);
      const getJson = await get.json();
      expect(getJson.data.assigneeId).toBe(agentB.user.id);

      // END-TO-END: B can now transition the task — proving the stranded
      // agent is unblocked (no 409 CLAIM_DENIED).
      const done = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { token: agentB.token, body: { to_status: "done" } },
      );
      expect(done.status).toBe(200);
    });

    it("writes one force_claim audit row with before/after holders", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        status: "in_progress",
        assigneeId: agentA.user.id,
      });

      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/force-claim`, {
        token: agentB.token,
        body: { reason: "recovering my stranded task" },
      });

      const audit = auditService.list({ projectId: project.id, action: "force_claim" });
      expect(audit.data).toHaveLength(1);
      const row = audit.data[0];
      expect(row.action).toBe("force_claim");
      expect(row.targetType).toBe("task");
      expect(row.targetId).toBe(task.id);
      expect(row.reason).toBe("recovering my stranded task");
      expect(row.metadataBefore).toEqual({ assignee_id: agentA.user.id });
      expect(row.metadataAfter).toEqual({ assignee_id: agentB.user.id });
    });

    it("rejects an empty reason with 400", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        status: "in_progress",
        assigneeId: agentA.user.id,
      });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/force-claim`, {
        body: { reason: "" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects a whitespace-only reason with 400", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        status: "in_progress",
        assigneeId: agentA.user.id,
      });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/force-claim`, {
        body: { reason: "   " },
      });
      expect(res.status).toBe(400);
    });

    it("rejects a missing reason with 400", async () => {
      const project = createTestProject(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/force-claim`, {
        body: {},
      });
      expect(res.status).toBe(400);
    });

    it("forbids an ai_agent targeting ANOTHER agent with 403", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        status: "in_progress",
        assigneeId: agentA.user.id,
      });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/force-claim`, {
        token: agentB.token,
        body: { reason: "trying to assign someone else", newAssigneeId: agentA.user.id },
      });
      expect(res.status).toBe(403);
    });

    it("lets a human target a specified agent (200, holder flips)", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        status: "in_progress",
        assigneeId: agentA.user.id,
      });
      // default test user is a human admin.
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/force-claim`, {
        body: { reason: "reassigning to agent B", newAssigneeId: agentB.user.id },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.newHolder).toBe(agentB.user.id);
      expect(json.data.previousHolder).toBe(agentA.user.id);
    });

    it("refuses a terminal (done) task with 409", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        status: "done",
        assigneeId: agentA.user.id,
      });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/force-claim`, {
        token: agentB.token,
        body: { reason: "too late" },
      });
      expect(res.status).toBe(409);
    });

    it("returns 404 for an unknown task id", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${createId()}/force-claim`,
        { body: { reason: "nope" } },
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 for an unknown newAssigneeId", async () => {
      const project = createTestProject(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id });
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/force-claim`, {
        body: { reason: "target missing", newAssigneeId: createId() },
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Epics ──────────────────────────────────────────────────────
  describe("POST /api/v1/epics/:id/force-claim", () => {
    it("the headline scenario: B takes over and then updates the epic (no CLAIM_DENIED)", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      // Seed the holder directly (epic factory has no assigneeId override).
      const claimRes = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`, {
        token: agentA.token,
      });
      expect(claimRes.status).toBe(200);

      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/force-claim`, {
        token: agentB.token,
        body: { reason: "session identity flipped" },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        ok: true,
        status: "force_claimed",
        previousHolder: agentA.user.id,
        newHolder: agentB.user.id,
      });

      const get = await authRequest(testApp.app, "GET", `/api/v1/epics/${epic.id}`);
      const getJson = await get.json();
      expect(getJson.data.assigneeId).toBe(agentB.user.id);

      // END-TO-END: B can now update the epic (claim-gated for ai_agent).
      const upd = await authRequest(testApp.app, "PATCH", `/api/v1/epics/${epic.id}`, {
        token: agentB.token,
        body: { description: "now owned by B" },
      });
      expect(upd.status).toBe(200);
    });

    it("writes one force_claim audit row (epic)", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/claim`, {
        token: agentA.token,
      });
      await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/force-claim`, {
        token: agentB.token,
        body: { reason: "epic takeover" },
      });
      const audit = auditService.list({ projectId: project.id, action: "force_claim" });
      expect(audit.data).toHaveLength(1);
      expect(audit.data[0].targetType).toBe("epic");
      expect(audit.data[0].metadataBefore).toEqual({ assignee_id: agentA.user.id });
      expect(audit.data[0].metadataAfter).toEqual({ assignee_id: agentB.user.id });
    });

    it("rejects empty/missing reason with 400", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      const empty = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/force-claim`, {
        body: { reason: "" },
      });
      expect(empty.status).toBe(400);
      const missing = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/force-claim`, {
        body: {},
      });
      expect(missing.status).toBe(400);
    });

    it("forbids an ai_agent targeting another agent with 403", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/force-claim`, {
        token: agentB.token,
        body: { reason: "assigning to A", newAssigneeId: agentA.user.id },
      });
      expect(res.status).toBe(403);
    });

    it("lets a human target a specified agent (200)", async () => {
      const project = createTestProject(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/force-claim`, {
        body: { reason: "assign to B", newAssigneeId: agentB.user.id },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.newHolder).toBe(agentB.user.id);
    });

    it("refuses a terminal (completed) epic with 409", async () => {
      const project = createTestProject(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id, status: "completed" });
      const res = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/force-claim`, {
        token: agentB.token,
        body: { reason: "closed" },
      });
      expect(res.status).toBe(409);
    });

    it("returns 404 for unknown epic and unknown newAssigneeId", async () => {
      const project = createTestProject(testApp.db);
      const epic = createTestEpic(testApp.db, { projectId: project.id });
      const noEpic = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/epics/${createId()}/force-claim`,
        { body: { reason: "nope" } },
      );
      expect(noEpic.status).toBe(404);
      const noUser = await authRequest(testApp.app, "POST", `/api/v1/epics/${epic.id}/force-claim`, {
        body: { reason: "missing target", newAssigneeId: createId() },
      });
      expect(noUser.status).toBe(404);
    });
  });

  // ── Proposals ──────────────────────────────────────────────────
  describe("POST /api/v1/proposals/:id/force-claim", () => {
    it("the headline scenario: B takes over and then transitions the proposal (no CLAIM_DENIED)", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, { projectId: project.id, status: "open" });
      const claimRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/claim`,
        { token: agentA.token },
      );
      expect(claimRes.status).toBe(200);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/force-claim`,
        { token: agentB.token, body: { reason: "session identity flipped" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        ok: true,
        status: "force_claimed",
        previousHolder: agentA.user.id,
        newHolder: agentB.user.id,
      });

      const get = await authRequest(testApp.app, "GET", `/api/v1/proposals/${proposal.id}`);
      const getJson = await get.json();
      expect(getJson.data.claimedBy).toBe(agentB.user.id);

      // END-TO-END: B can now transition the proposal (claim-gated for ai_agent).
      const trans = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/transitions`,
        { token: agentB.token, body: { toStatus: "in_progress" } },
      );
      expect(trans.status).toBe(200);
    });

    it("writes one force_claim audit row (proposal — claimed_by keys)", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, { projectId: project.id, status: "open" });
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/claim`, {
        token: agentA.token,
      });
      await authRequest(testApp.app, "POST", `/api/v1/proposals/${proposal.id}/force-claim`, {
        token: agentB.token,
        body: { reason: "proposal takeover" },
      });
      const audit = auditService.list({ projectId: project.id, action: "force_claim" });
      expect(audit.data).toHaveLength(1);
      expect(audit.data[0].targetType).toBe("proposal");
      expect(audit.data[0].metadataBefore).toEqual({ claimed_by: agentA.user.id });
      expect(audit.data[0].metadataAfter).toEqual({ claimed_by: agentB.user.id });
    });

    it("rejects empty/missing reason with 400", async () => {
      const project = createTestProject(testApp.db);
      const proposal = createTestProposal(testApp.db, { projectId: project.id });
      const empty = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/force-claim`,
        { body: { reason: "" } },
      );
      expect(empty.status).toBe(400);
      const missing = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/force-claim`,
        { body: {} },
      );
      expect(missing.status).toBe(400);
    });

    it("forbids an ai_agent targeting another agent with 403", async () => {
      const project = createTestProject(testApp.db);
      const agentA = createTestAiAgent(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, { projectId: project.id, status: "open" });
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/force-claim`,
        { token: agentB.token, body: { reason: "assign A", newAssigneeId: agentA.user.id } },
      );
      expect(res.status).toBe(403);
    });

    it("lets a human target a specified agent (200)", async () => {
      const project = createTestProject(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, { projectId: project.id, status: "open" });
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/force-claim`,
        { body: { reason: "assign to B", newAssigneeId: agentB.user.id } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.newHolder).toBe(agentB.user.id);
    });

    it("refuses a terminal (rejected) proposal with 409", async () => {
      const project = createTestProject(testApp.db);
      const agentB = createTestAiAgent(testApp.db);
      const proposal = createTestProposal(testApp.db, {
        projectId: project.id,
        status: "rejected",
      });
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/force-claim`,
        { token: agentB.token, body: { reason: "closed" } },
      );
      expect(res.status).toBe(409);
    });

    it("returns 404 for unknown proposal and unknown newAssigneeId", async () => {
      const project = createTestProject(testApp.db);
      const proposal = createTestProposal(testApp.db, { projectId: project.id });
      const noProp = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${createId()}/force-claim`,
        { body: { reason: "nope" } },
      );
      expect(noProp.status).toBe(404);
      const noUser = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/proposals/${proposal.id}/force-claim`,
        { body: { reason: "missing target", newAssigneeId: createId() } },
      );
      expect(noUser.status).toBe(404);
    });

    // FOLDED-FIX 1: a proposal with a null projectId → 409 NO_PROJECT, never a
    // 500 (audit_log.projectId is NOT NULL). The factory always sets a project,
    // so we insert a null-projectId row directly and call the service.
    it("returns 409 NO_PROJECT for a proposal with a null projectId", async () => {
      const ts = new Date().toISOString();
      const id = createId();
      testApp.db
        .insert(proposals)
        .values({
          id,
          projectId: null,
          title: "orphan proposal",
          description: null,
          status: "open",
          createdBy: testApp.testUser.id,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      expect(() =>
        proposalService.forceClaim(
          id,
          { id: testApp.testUser.id, type: "human" },
          { reason: "trying to take over an orphan" },
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "NO_PROJECT" }),
      );
    });
  });

  // ── Composition with stable worker identity (C1 seal) ──────────
  describe("Force-claim composes with keyed-stable identity (C1 seal)", () => {
    const POOL_SECRET = "seal-pool-secret-12345";

    async function createPool(name: string, secret: string) {
      const res = await authRequest(testApp.app, "POST", "/api/v1/auth/agent-pools", {
        body: { name, secret },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      return body.data as { id: string };
    }

    async function createPoolAgents(poolId: string, count: number) {
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/auth/agent-pools/${poolId}/agents`,
        { body: { count } },
      );
      expect(res.status).toBe(201);
    }

    async function keyedClaim(poolName: string, workerKey: string) {
      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName, poolSecret: POOL_SECRET, workerKey }),
      });
      const body = await res.json();
      return { status: res.status, body };
    }

    it("a human/other agent can force-claim a task held by a keyed-stable worker; identity survives, displaced worker no longer holds it", async () => {
      const project = createTestProject(testApp.db);

      const pool = await createPool("seal-host", POOL_SECRET);
      await createPoolAgents(pool.id, 3);

      // The keyed-stable worker binds and holds a task.
      const bind = await keyedClaim("seal-host", "stable-holder");
      expect(bind.status).toBe(200);
      const holderId = bind.body.data.user.id as string;

      const agentB = createTestAiAgent(testApp.db);

      const task = createTestTask(testApp.db, {
        projectId: project.id,
        status: "in_progress",
        assigneeId: holderId,
      });

      // agentB force-claims the task away from the keyed-stable worker.
      const res = await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/force-claim`, {
        token: agentB.token,
        body: { reason: "taking over a stranded stable worker's task" },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.previousHolder).toBe(holderId);
      expect(json.data.newHolder).toBe(agentB.user.id);

      // Exactly one force_claim audit row, before=holder, after=B.
      const audit = auditService.list({ projectId: project.id, action: "force_claim" });
      expect(audit.data).toHaveLength(1);
      expect(audit.data[0].targetType).toBe("task");
      expect(audit.data[0].targetId).toBe(task.id);
      expect(audit.data[0].metadataBefore).toEqual({ assignee_id: holderId });
      expect(audit.data[0].metadataAfter).toEqual({ assignee_id: agentB.user.id });

      // ── Composition seal ──────────────────────────────────────
      // 1. The displaced worker re-binds with the SAME key → SAME identity
      //    (the takeover did not strand or re-mint it).
      const rebind = await keyedClaim("seal-host", "stable-holder");
      expect(rebind.status).toBe(200);
      expect(rebind.body.data.user.id).toBe(holderId);

      // 2. The task is now held by B (the displaced worker no longer holds it).
      const get = await authRequest(testApp.app, "GET", `/api/v1/tasks/${task.id}`);
      const getJson = await get.json();
      expect(getJson.data.assigneeId).toBe(agentB.user.id);

      // 3. A write by the displaced stable worker (with its fresh rebind token)
      //    is rejected — force-claim's gate still bites the stable-but-displaced
      //    identity.
      const displacedToken = rebind.body.data.token as string;
      const blocked = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/transitions`,
        { token: displacedToken, body: { to_status: "done" } },
      );
      expect(blocked.status).toBe(409);
      const blockedJson = await blocked.json();
      expect(blockedJson.error.code).toBe("CLAIM_DENIED");
    });
  });
});
