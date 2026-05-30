import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  type TestApp,
} from "../utils.js";
import { mergeRequestGroups, mergeRequests } from "../../src/db/index.js";

describe("Merge Groups API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── helpers ─────────────────────────────────────────────────────

  async function submitRequest(
    projectId: string,
    token: string,
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${projectId}/merge-requests`,
      { token, body: { resource: "main", ...body } },
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    return json.data.id as string;
  }

  /**
   * Submit `count` queued requests and bind them into a group.
   * Returns the group id + the member ids.
   */
  async function createGroup(
    projectId: string,
    token: string,
    count = 2,
  ): Promise<{ groupId: string; memberIds: string[] }> {
    const memberIds: string[] = [];
    for (let i = 0; i < count; i++) {
      memberIds.push(
        await submitRequest(projectId, token, { branch: `feature/${i}` }),
      );
    }
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${projectId}/merge-groups`,
      { token, body: { resource: "main", memberRequestIds: memberIds } },
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    return { groupId: json.data.id as string, memberIds };
  }

  // ─── A. POST create ──────────────────────────────────────────────
  describe("POST /api/v1/projects/:projectId/merge-groups", () => {
    it("201 forming group with members claimed (worker)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const a = await submitRequest(project.id, agent.token, { branch: "a" });
      const b = await submitRequest(project.id, agent.token, { branch: "b" });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        { token: agent.token, body: { resource: "main", memberRequestIds: [a, b] } },
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.state).toBe("forming");
      expect(json.data.submittedBy).toBe(agent.user.id);
      expect(json.data.members).toHaveLength(2);

      // Members atomically claimed (group_id set).
      const rowA = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, a))
        .get();
      expect(rowA?.groupId).toBe(json.data.id);
    });

    it("400 when fewer than 2 members", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const a = await submitRequest(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        { token: agent.token, body: { resource: "main", memberRequestIds: [a] } },
      );
      expect(res.status).toBe(400);
    });

    it("409 when a member is not queued", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const a = await submitRequest(project.id, agent.token);
      const b = await submitRequest(project.id, agent.token);
      // Force a out of queued.
      testApp.db
        .update(mergeRequests)
        .set({ status: "integrating" })
        .where(eq(mergeRequests.id, a))
        .run();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        { token: agent.token, body: { resource: "main", memberRequestIds: [a, b] } },
      );
      expect(res.status).toBe(409);
    });

    it("409 when a member is already grouped", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { memberIds } = await createGroup(project.id, agent.token);
      const fresh = await submitRequest(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          token: agent.token,
          body: { resource: "main", memberRequestIds: [memberIds[0], fresh] },
        },
      );
      expect(res.status).toBe(409);
    });

    it("401 when unauthenticated", async () => {
      const project = createTestProject(testApp.db);
      const res = await testApp.app.request(
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resource: "main", memberRequestIds: ["x", "y"] }),
        },
      );
      expect(res.status).toBe(401);
    });
  });

  // ─── B. GET by id ────────────────────────────────────────────────
  describe("GET /api/v1/merge-groups/:id", () => {
    it("200 with members (worker)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId } = await createGroup(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-groups/${groupId}`,
        { token: agent.token },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe(groupId);
      expect(json.data.members).toHaveLength(2);
    });

    it("404 when group does not exist", async () => {
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-groups/01HNONEXISTENTGROUP00`,
        { token: agent.token },
      );
      expect(res.status).toBe(404);
    });
  });

  // ─── C. GET list ─────────────────────────────────────────────────
  describe("GET /api/v1/projects/:projectId/merge-groups", () => {
    it("200 filtered by state + resource (worker)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId } = await createGroup(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-groups?state=forming&resource=main`,
        { token: agent.token },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe(groupId);

      const none = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-groups?state=landed`,
        { token: agent.token },
      );
      const noneJson = await none.json();
      expect(noneJson.data).toHaveLength(0);
    });
  });

  // ─── D. Integrator ops — worker (human) 403, ai_agent 200 ────────
  describe("POST /api/v1/merge-groups/:id/pickup", () => {
    it("403 when human (admin) attempts pickup", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId } = await createGroup(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-groups/${groupId}/pickup`,
        { token: testApp.testToken },
      );
      expect(res.status).toBe(403);
    });

    it("200 when ai_agent picks up a forming group", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId, memberIds } = await createGroup(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-groups/${groupId}/pickup`,
        { token: agent.token },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("integrating");
      // Every member flipped to integrating in one txn.
      const m = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, memberIds[0]))
        .get();
      expect(m?.status).toBe("integrating");
    });
  });

  describe("POST /api/v1/merge-groups/:id/land", () => {
    it("403 when human (admin) lands", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId, memberIds } = await createGroup(project.id, agent.token);
      await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/pickup`, {
        token: agent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-groups/${groupId}/land`,
        {
          token: testApp.testToken,
          body: {
            members: memberIds.map((id) => ({ requestId: id, landedSha: `sha-${id}` })),
          },
        },
      );
      expect(res.status).toBe(403);
    });

    it("200 when ai_agent atomically lands the group", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId, memberIds } = await createGroup(project.id, agent.token);
      await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/pickup`, {
        token: agent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-groups/${groupId}/land`,
        {
          token: agent.token,
          body: {
            members: memberIds.map((id) => ({ requestId: id, landedSha: `sha-${id}` })),
          },
        },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("landed");
      expect(json.data.members.every((m: { status: string }) => m.status === "landed")).toBe(
        true,
      );
    });
  });

  describe("POST /api/v1/merge-groups/:id/reject", () => {
    it("403 when a stranger ai_agent (non-submitter) rejects... actually allowed for integrator", async () => {
      // Integrator (any ai_agent) may reject — this asserts ai_agent → 200.
      const project = createTestProject(testApp.db);
      const submitter = createTestAiAgent(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const { groupId } = await createGroup(project.id, submitter.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-groups/${groupId}/reject`,
        { token: integrator.token, body: { reason: "abandon" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("rejected");
    });

    it("200 when the submitter rejects (forming → rejected)", async () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestAiAgent(testApp.db, { role: "member" });
      const { groupId } = await createGroup(project.id, submitter.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-groups/${groupId}/reject`,
        { token: submitter.token, body: { reason: "changed my mind" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("rejected");
    });

    it("200 when an admin rejects", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId } = await createGroup(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-groups/${groupId}/reject`,
        { token: testApp.testToken, body: { reason: "policy" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("rejected");
    });
  });

  describe("POST /api/v1/merge-groups/:id/partially-land", () => {
    it("403 when human (admin) marks partially landed", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId } = await createGroup(project.id, agent.token);
      await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/pickup`, {
        token: agent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-groups/${groupId}/partially-land`,
        { token: testApp.testToken, body: { reason: "outer push failed" } },
      );
      expect(res.status).toBe(403);
    });

    it("200 when ai_agent marks integrating group partially landed", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId } = await createGroup(project.id, agent.token);
      await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/pickup`, {
        token: agent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-groups/${groupId}/partially-land`,
        { token: agent.token, body: { reason: "outer push failed" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("partially_landed");
    });
  });

  describe("POST /api/v1/merge-requests/:id/orphan", () => {
    it("403 when human (admin) orphans an inner member", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId, memberIds } = await createGroup(project.id, agent.token);
      await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/pickup`, {
        token: agent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${memberIds[0]}/orphan`,
        { token: testApp.testToken, body: { orphanedSha: "orphan99" } },
      );
      expect(res.status).toBe(403);
    });

    it("200 when ai_agent orphans an integrating member", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId, memberIds } = await createGroup(project.id, agent.token);
      await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/pickup`, {
        token: agent.token,
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${memberIds[0]}/orphan`,
        { token: agent.token, body: { orphanedSha: "orphan99" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("orphaned");
      expect(json.data.landedSha).toBe("orphan99");
    });
  });
});
