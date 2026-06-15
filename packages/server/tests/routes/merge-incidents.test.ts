import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { comments, mergeIncidents } from "../../src/db/index.js";

describe("Merge Incidents API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── helpers ─────────────────────────────────────────────────────

  async function openIncident(
    projectId: string,
    token: string,
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${projectId}/merge-incidents`,
      {
        token,
        body: {
          innerRepo: "inner",
          orphanedSha: "orphan99",
          outerRepo: "outer",
          ...body,
        },
      },
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    return json.data.id as string;
  }

  // ─── A. POST open ────────────────────────────────────────────────
  describe("POST /api/v1/projects/:projectId/merge-incidents", () => {
    it("403 when non-ai_agent (human admin) opens", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-incidents`,
        {
          token: testApp.testToken,
          body: { innerRepo: "inner", orphanedSha: "x", outerRepo: "outer" },
        },
      );
      expect(res.status).toBe(403);
    });

    it("201 when ai_agent opens + merge_incident comment when taskId set", async () => {
      const project = createTestProject(testApp.db);
      const reporter = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: reporter.id,
      });
      const agent = createTestAiAgent(testApp.db);

      const incidentId = await openIncident(project.id, agent.token, {
        taskId: task.id,
      });

      const row = testApp.db
        .select()
        .from(mergeIncidents)
        .where(eq(mergeIncidents.id, incidentId))
        .get();
      expect(row?.state).toBe("open");

      const commentRows = testApp.db
        .select()
        .from(comments)
        .where(eq(comments.taskId, task.id))
        .all();
      const incidentComment = commentRows.find((c) => c.commentType === "merge_incident");
      expect(incidentComment).toBeTruthy();
      const meta = incidentComment?.metadata as Record<string, unknown>;
      expect(meta.incidentId).toBe(incidentId);
    });
  });

  // ─── B. GET by id ────────────────────────────────────────────────
  describe("GET /api/v1/merge-incidents/:id", () => {
    it("200 (worker)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const incidentId = await openIncident(project.id, agent.token);

      const res = await authRequest(testApp.app, "GET", `/api/v1/merge-incidents/${incidentId}`, {
        token: agent.token,
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe(incidentId);
      expect(json.data.resolution).toBeNull();
    });

    it("404 when unknown", async () => {
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-incidents/01HNONEXISTENTINC0000`,
        { token: agent.token },
      );
      expect(res.status).toBe(404);
    });
  });

  // ─── C. GET list ─────────────────────────────────────────────────
  describe("GET /api/v1/projects/:projectId/merge-incidents", () => {
    it("200 filtered by state/type/groupId (worker)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      // groupId has a FK to merge_request_groups — bind a real group first.
      const a = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests`,
        { token: agent.token, body: { resource: "main", branch: "a" } },
      );
      const b = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests`,
        { token: agent.token, body: { resource: "main", branch: "b" } },
      );
      const aId = (await a.json()).data.id as string;
      const bId = (await b.json()).data.id as string;
      const groupRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        { token: agent.token, body: { resource: "main", memberRequestIds: [aId, bId] } },
      );
      const realGroupId = (await groupRes.json()).data.id as string;

      const incidentId = await openIncident(project.id, agent.token, {
        groupId: realGroupId,
      });

      const byState = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-incidents?state=open&type=orphaned_inner`,
        { token: agent.token },
      );
      expect(byState.status).toBe(200);
      const byStateJson = await byState.json();
      expect(byStateJson.data).toHaveLength(1);
      expect(byStateJson.data[0].id).toBe(incidentId);

      const byGroup = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-incidents?groupId=${realGroupId}`,
        { token: agent.token },
      );
      const byGroupJson = await byGroup.json();
      expect(byGroupJson.data).toHaveLength(1);

      const none = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-incidents?state=human_resolved`,
        { token: agent.token },
      );
      const noneJson = await none.json();
      expect(noneJson.data).toHaveLength(0);
    });
  });

  // ─── D. POST resolve — authz SPLIT both directions ───────────────
  describe("POST /api/v1/merge-incidents/:id/resolve", () => {
    it("auto_rollforward: admin → 403, ai_agent → 200", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);

      // admin CANNOT auto-resolve.
      const adminId = await openIncident(project.id, agent.token);
      const adminRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-incidents/${adminId}/resolve`,
        { token: testApp.testToken, body: { mode: "auto_rollforward", outerLandedSha: "z" } },
      );
      expect(adminRes.status).toBe(403);

      // ai_agent CAN auto-resolve.
      const agentRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-incidents/${adminId}/resolve`,
        { token: agent.token, body: { mode: "auto_rollforward", outerLandedSha: "z" } },
      );
      expect(agentRes.status).toBe(200);
      const json = await agentRes.json();
      expect(json.data.state).toBe("auto_resolved");
    });

    it("human: ai_agent → 403, admin → 200", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const incidentId = await openIncident(project.id, agent.token);

      // ai_agent CANNOT human-resolve.
      const agentRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-incidents/${incidentId}/resolve`,
        { token: agent.token, body: { mode: "human", note: "fixed manually" } },
      );
      expect(agentRes.status).toBe(403);

      // admin CAN human-resolve.
      const adminRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-incidents/${incidentId}/resolve`,
        { token: testApp.testToken, body: { mode: "human", note: "fixed manually" } },
      );
      expect(adminRes.status).toBe(200);
      const json = await adminRes.json();
      expect(json.data.state).toBe("human_resolved");
    });
  });

  // ─── E. 401 ──────────────────────────────────────────────────────
  it("401 when unauthenticated", async () => {
    const project = createTestProject(testApp.db);
    const res = await testApp.app.request(`/api/v1/projects/${project.id}/merge-incidents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ innerRepo: "i", orphanedSha: "s", outerRepo: "o" }),
    });
    expect(res.status).toBe(401);
  });
});
