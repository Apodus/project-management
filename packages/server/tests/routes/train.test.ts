import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createId } from "@pm/shared";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  createTestUser,
  type TestApp,
  type TestProject,
} from "../utils.js";
import { mergeIncidents, mergeRequests, mergeRequestGroups, users } from "../../src/db/index.js";
import * as requestSvc from "../../src/services/merge-request.service.js";
import * as mergeLockService from "../../src/services/merge-lock.service.js";

// ── Helpers ───────────────────────────────────────────────────────

/** A member (non-admin) human user with a known API token. */
function createMemberToken(testApp: TestApp): string {
  const ts = new Date().toISOString();
  const id = createId();
  const token = `member-token-${id}`;
  testApp.db
    .insert(users)
    .values({
      id,
      username: `member-${id.slice(-6)}`,
      displayName: "Member",
      role: "member",
      type: "human",
      apiTokenHash: bcrypt.hashSync(token, 10),
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return token;
}

function integratingRequestId(testApp: TestApp, project: TestProject): string {
  const submitter = createTestUser(testApp.db);
  const taskId = createTestTask(testApp.db, { projectId: project.id }).id;
  const r = requestSvc.submit({
    projectId: project.id,
    submittedBy: submitter.id,
    taskId,
    branch: "feat/x",
  });
  const agent = createTestAiAgent(testApp.db);
  requestSvc.transitionToIntegrating(r.id, {
    id: agent.user.id,
    role: agent.user.role,
    type: agent.user.type,
  });
  return r.id;
}

describe("Train + break-glass routes", () => {
  let testApp: TestApp;
  let memberToken: string;

  beforeEach(() => {
    testApp = createTestApp();
    memberToken = createMemberToken(testApp);
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── pause ────────────────────────────────────────────────────────

  describe("POST /train/pause", () => {
    it("admin → 200, lane paused", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/train/pause`,
        { body: { reason: "draining" } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.state).toBe("paused");
    });

    it("member (non-admin) → 403", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/train/pause`,
        { token: memberToken, body: {} },
      );
      expect(res.status).toBe(403);
    });
  });

  // ── resume ───────────────────────────────────────────────────────

  describe("POST /train/resume", () => {
    it("admin → 200, lane running", async () => {
      const project = createTestProject(testApp.db);
      await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/train/pause`, {
        body: {},
      });
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/train/resume`,
        { body: {} },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.state).toBe("running");
    });

    it("member → 403", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/train/resume`,
        { token: memberToken, body: {} },
      );
      expect(res.status).toBe(403);
    });
  });

  // ── force-release ────────────────────────────────────────────────

  describe("POST /merge-locks/{resource}/force-release", () => {
    it("admin → 200, lock cleared", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      mergeLockService.acquire(project.id, "main", { id: agent.user.id });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/force-release`,
        { body: { reason: "dead integrator" } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.ok).toBe(true);
      expect(body.data.priorHolderId).toBe(agent.user.id);
    });

    it("member → 403", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/force-release`,
        { token: memberToken, body: {} },
      );
      expect(res.status).toBe(403);
    });
  });

  // ── force-land ───────────────────────────────────────────────────

  describe("POST /merge-requests/{id}/force-land", () => {
    it("admin → 200, request landed", async () => {
      const project = createTestProject(testApp.db);
      const reqId = integratingRequestId(testApp, project);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${reqId}/force-land`,
        { body: { landedSha: "ff00ba5", reason: "hotfix" } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("landed");
      expect(body.data.landedSha).toBe("ff00ba5");
    });

    it("member → 403 on the same request", async () => {
      const project = createTestProject(testApp.db);
      const reqId = integratingRequestId(testApp, project);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${reqId}/force-land`,
        { token: memberToken, body: { landedSha: "ff00ba5", reason: "hotfix" } },
      );
      expect(res.status).toBe(403);
      // The request must not have landed.
      const row = testApp.db.select().from(mergeRequests).where(eq(mergeRequests.id, reqId)).get();
      expect(row!.status).toBe("integrating");
    });

    it("missing reason → 400 (z.min(1))", async () => {
      const project = createTestProject(testApp.db);
      const reqId = integratingRequestId(testApp, project);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${reqId}/force-land`,
        { body: { landedSha: "ff00ba5" } },
      );
      expect(res.status).toBe(400);
    });

    it("empty reason → 400", async () => {
      const project = createTestProject(testApp.db);
      const reqId = integratingRequestId(testApp, project);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${reqId}/force-land`,
        { body: { landedSha: "ff00ba5", reason: "" } },
      );
      expect(res.status).toBe(400);
    });

    it("grouped member → 409", async () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const ts = new Date().toISOString();
      const groupId = createId();
      testApp.db
        .insert(mergeRequestGroups)
        .values({
          id: groupId,
          projectId: project.id,
          submittedBy: submitter.id,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      const reqId = createId();
      testApp.db
        .insert(mergeRequests)
        .values({
          id: reqId,
          projectId: project.id,
          submittedBy: submitter.id,
          groupId,
          status: "integrating",
          enqueuedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${reqId}/force-land`,
        { body: { landedSha: "x", reason: "y" } },
      );
      expect(res.status).toBe(409);
    });

    // ── group-state-aware matrix (C2) ─────────────────────────────

    /** Insert a group in `groupState` with one member in `memberStatus`. */
    function groupedMember(
      project: TestProject,
      groupState: string,
      memberStatus: string,
      opts: { landedSha?: string | null; incidentState?: string } = {},
    ): { reqId: string; groupId: string; incidentId: string | null } {
      const submitter = createTestUser(testApp.db);
      const ts = new Date().toISOString();
      const groupId = createId();
      testApp.db
        .insert(mergeRequestGroups)
        .values({
          id: groupId,
          projectId: project.id,
          state: groupState,
          submittedBy: submitter.id,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      const reqId = createId();
      testApp.db
        .insert(mergeRequests)
        .values({
          id: reqId,
          projectId: project.id,
          submittedBy: submitter.id,
          groupId,
          status: memberStatus,
          landedSha: opts.landedSha ?? null,
          enqueuedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      let incidentId: string | null = null;
      if (opts.incidentState) {
        incidentId = createId();
        testApp.db
          .insert(mergeIncidents)
          .values({
            id: incidentId,
            projectId: project.id,
            groupId,
            type: "orphaned_inner",
            innerRepo: "rynx",
            orphanedSha: "inner-sha",
            outerRepo: "game",
            state: opts.incidentState,
            openedAt: ts,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }
      return { reqId, groupId, incidentId };
    }

    it("member of a LANDED group already landed → 200 idempotent no-op", async () => {
      const project = createTestProject(testApp.db);
      const { reqId } = groupedMember(project, "landed", "landed", {
        landedSha: "g1",
      });
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${reqId}/force-land`,
        { body: { landedSha: "other", reason: "noop" } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.landedSha).toBe("g1"); // unchanged
    });

    it("non-landed member of a LANDED group → 409 GROUPED_MEMBER", async () => {
      const project = createTestProject(testApp.db);
      const { reqId } = groupedMember(project, "landed", "rejected");
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${reqId}/force-land`,
        { body: { landedSha: "x", reason: "y" } },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("GROUPED_MEMBER");
    });

    it("rejected member of a PARTIALLY_LANDED group → 200 lands + open incident auto-resolves human_resolved", async () => {
      const project = createTestProject(testApp.db);
      const { reqId, incidentId } = groupedMember(project, "partially_landed", "rejected", {
        incidentState: "open",
      });
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${reqId}/force-land`,
        { body: { landedSha: "outer-final", reason: "manual recovery" } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("landed");
      expect(body.data.landedSha).toBe("outer-final");
      const incident = testApp.db
        .select()
        .from(mergeIncidents)
        .where(eq(mergeIncidents.id, incidentId!))
        .get()!;
      expect(incident.state).toBe("human_resolved");
    });

    it("orphaned member of a PARTIALLY_LANDED group → 409 INVALID_TRANSITION", async () => {
      const project = createTestProject(testApp.db);
      const { reqId } = groupedMember(project, "partially_landed", "orphaned", {
        landedSha: "inner-sha",
      });
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${reqId}/force-land`,
        { body: { landedSha: "x", reason: "y" } },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TRANSITION");
    });
  });

  // ── force-reject ─────────────────────────────────────────────────

  describe("POST /merge-requests/{id}/force-reject", () => {
    it("admin → 200, request rejected", async () => {
      const project = createTestProject(testApp.db);
      const reqId = integratingRequestId(testApp, project);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${reqId}/force-reject`,
        { body: { reason: "obsoleted" } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("rejected");
      expect(body.data.rejectCategory).toBe("policy");
    });

    it("member → 403", async () => {
      const project = createTestProject(testApp.db);
      const reqId = integratingRequestId(testApp, project);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${reqId}/force-reject`,
        { token: memberToken, body: { reason: "x" } },
      );
      expect(res.status).toBe(403);
    });

    it("missing reason → 400", async () => {
      const project = createTestProject(testApp.db);
      const reqId = integratingRequestId(testApp, project);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${reqId}/force-reject`,
        { body: {} },
      );
      expect(res.status).toBe(400);
    });
  });

  // ── GET train state ──────────────────────────────────────────────

  describe("GET /train/state", () => {
    it("any authed user → 200", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/train/state`,
        { token: memberToken },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.state).toBe("running");
    });
  });
});
