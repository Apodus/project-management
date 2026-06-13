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
      memberIds.push(await submitRequest(projectId, token, { branch: `feature/${i}` }));
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
      const rowA = testApp.db.select().from(mergeRequests).where(eq(mergeRequests.id, a)).get();
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

    it("201 atomic members form → forming + members born group-bound + queued", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          token: agent.token,
          body: {
            resource: "main",
            members: [{ branch: "feat/inner" }, { commitSha: "abc1234" }],
          },
        },
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.state).toBe("forming");
      expect(json.data.members).toHaveLength(2);
      expect(json.data.members.every((m: { status: string }) => m.status === "queued")).toBe(true);

      // Members written with groupId === the new group + queued.
      const rows = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.groupId, json.data.id))
        .all();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === "queued")).toBe(true);
      expect(rows.some((r) => r.branch === "feat/inner")).toBe(true);
      expect(rows.some((r) => r.commitSha === "abc1234")).toBe(true);
    });

    it("400 atomic members form with a spec missing branch+commitSha", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          token: agent.token,
          body: {
            resource: "main",
            members: [{ branch: "feat/inner" }, { verifyCmd: "pnpm test" }],
          },
        },
      );
      expect(res.status).toBe(400);
    });

    it("400 when BOTH memberRequestIds and members are provided", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const a = await submitRequest(project.id, agent.token, { branch: "a" });
      const b = await submitRequest(project.id, agent.token, { branch: "b" });
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          token: agent.token,
          body: {
            resource: "main",
            memberRequestIds: [a, b],
            members: [{ branch: "feat/inner" }, { branch: "feat/outer" }],
          },
        },
      );
      expect(res.status).toBe(400);
    });

    it("400 when NEITHER memberRequestIds nor members are provided", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        { token: agent.token, body: { resource: "main" } },
      );
      expect(res.status).toBe(400);
    });

    it("400 atomic members form with fewer than 2 members", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          token: agent.token,
          body: { resource: "main", members: [{ branch: "feat/inner" }] },
        },
      );
      expect(res.status).toBe(400);
    });

    it("401 when unauthenticated", async () => {
      const project = createTestProject(testApp.db);
      const res = await testApp.app.request(`/api/v1/projects/${project.id}/merge-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "main", memberRequestIds: ["x", "y"] }),
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── A2. POST create — inner-only synthesizeOuter form ────────────
  describe("POST /api/v1/projects/:projectId/merge-groups (inner-only synthesizeOuter form)", () => {
    // Exactly one inner + one outer declared — the valid topology.
    const XREPO_SETTINGS = {
      integrator: {
        linked_repos: [
          { name: "rynx", path: "../rynx", role: "inner" },
          { name: "game", path: ".", role: "outer", gitlink_path: "rynx" },
        ],
      },
    };

    it("201 inner-only form: real inner member + synthetic outer member on the wire", async () => {
      const project = createTestProject(testApp.db, { settings: XREPO_SETTINGS });
      const agent = createTestAiAgent(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          token: agent.token,
          body: {
            resource: "main",
            members: [{ branch: "feat/inner" }],
            synthesizeOuter: true,
          },
        },
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.state).toBe("forming");
      expect(json.data.members).toHaveLength(2);

      const real = json.data.members.find((m: { synthetic: boolean }) => !m.synthetic);
      expect(real.branch).toBe("feat/inner");
      expect(real.status).toBe("queued");

      // The synthetic member's full wire shape: ref-less, task-less, flagged.
      const synthetic = json.data.members.find((m: { synthetic: boolean }) => m.synthetic);
      expect(synthetic).toMatchObject({
        branch: null,
        commitSha: null,
        taskId: null,
        verifyCmd: null,
        synthetic: true,
        status: "queued",
      });
    });

    it("400 (Zod tier) when the flag rides with 2 members", async () => {
      const project = createTestProject(testApp.db, { settings: XREPO_SETTINGS });
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          token: agent.token,
          body: {
            resource: "main",
            members: [{ branch: "feat/a" }, { branch: "feat/b" }],
            synthesizeOuter: true,
          },
        },
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("synthesizeOuter requires exactly one member spec");
    });

    it("400 (Zod tier) when the flag rides with memberRequestIds", async () => {
      const project = createTestProject(testApp.db, { settings: XREPO_SETTINGS });
      const agent = createTestAiAgent(testApp.db);
      const a = await submitRequest(project.id, agent.token, { branch: "a" });
      const b = await submitRequest(project.id, agent.token, { branch: "b" });
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          token: agent.token,
          body: {
            resource: "main",
            memberRequestIds: [a, b],
            synthesizeOuter: true,
          },
        },
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(
        "synthesizeOuter cannot be combined with memberRequestIds",
      );
    });

    it("400 (Zod tier) when ONE member is sent without the flag", async () => {
      const project = createTestProject(testApp.db, { settings: XREPO_SETTINGS });
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          token: agent.token,
          body: { resource: "main", members: [{ branch: "feat/inner" }] },
        },
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(
        "A merge group requires at least 2 member specs (or exactly one with synthesizeOuter: true).",
      );
    });

    it("400 (service tier) when the project declares no inner/outer topology", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          token: agent.token,
          body: {
            resource: "main",
            members: [{ branch: "feat/inner" }],
            synthesizeOuter: true,
          },
        },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toContain("exactly one inner and one outer repo");
    });

    it("GET /merge-groups/:id renders synthetic: true on the member", async () => {
      const project = createTestProject(testApp.db, { settings: XREPO_SETTINGS });
      const agent = createTestAiAgent(testApp.db);
      const create = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          token: agent.token,
          body: {
            resource: "main",
            members: [{ branch: "feat/inner" }],
            synthesizeOuter: true,
          },
        },
      );
      const groupId = (await create.json()).data.id as string;

      const res = await authRequest(testApp.app, "GET", `/api/v1/merge-groups/${groupId}`, {
        token: agent.token,
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      const flags = json.data.members.map((m: { synthetic: boolean }) => m.synthetic).sort();
      expect(flags).toEqual([false, true]);
    });

    it("legacy byte-identity seal: both legacy forms 201 with the pinned member key set + synthetic === false", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);

      // The pre-campaign wire keys ∪ {"synthetic"} — pinned so an accidental
      // legacy-shape change (key added/dropped/renamed) fails loudly.
      const PINNED_KEYS = [
        "branch",
        "commitSha",
        "createdAt",
        "enqueuedAt",
        "escalationId",
        "failedFiles",
        "id",
        "landedSha",
        "logExcerpt",
        "logUrl",
        "pickedUpAt",
        "projectId",
        "rejectCategory",
        "rejectReason",
        "resolvedAt",
        "resolvedFrom",
        "resource",
        "revertOf",
        "status",
        "submittedBy",
        "synthetic",
        "taskId",
        "updatedAt",
        "verifyCmd",
        "worktreePath",
      ];

      // (a) ids arm.
      const a = await submitRequest(project.id, agent.token, { branch: "a" });
      const b = await submitRequest(project.id, agent.token, { branch: "b" });
      const idsRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        { token: agent.token, body: { resource: "main", memberRequestIds: [a, b] } },
      );
      expect(idsRes.status).toBe(201);

      // (b) atomic >=2 members arm.
      const atomicRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        {
          token: agent.token,
          body: {
            resource: "main",
            members: [{ branch: "feat/a" }, { branch: "feat/b" }],
          },
        },
      );
      expect(atomicRes.status).toBe(201);

      for (const res of [idsRes, atomicRes]) {
        const json = await res.json();
        for (const m of json.data.members) {
          expect(m.synthetic).toBe(false);
          expect(Object.keys(m).sort()).toEqual(PINNED_KEYS);
        }
      }
    });
  });

  // ─── B. GET by id ────────────────────────────────────────────────
  describe("GET /api/v1/merge-groups/:id", () => {
    it("200 with members (worker)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId } = await createGroup(project.id, agent.token);

      const res = await authRequest(testApp.app, "GET", `/api/v1/merge-groups/${groupId}`, {
        token: agent.token,
      });
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

      const res = await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/pickup`, {
        token: testApp.testToken,
      });
      expect(res.status).toBe(403);
    });

    it("200 when ai_agent picks up a forming group", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId, memberIds } = await createGroup(project.id, agent.token);

      const res = await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/pickup`, {
        token: agent.token,
      });
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

      const res = await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/land`, {
        token: testApp.testToken,
        body: {
          members: memberIds.map((id) => ({ requestId: id, landedSha: `sha-${id}` })),
        },
      });
      expect(res.status).toBe(403);
    });

    it("200 when ai_agent atomically lands the group", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId, memberIds } = await createGroup(project.id, agent.token);
      await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/pickup`, {
        token: agent.token,
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/land`, {
        token: agent.token,
        body: {
          members: memberIds.map((id) => ({ requestId: id, landedSha: `sha-${id}` })),
        },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("landed");
      expect(json.data.members.every((m: { status: string }) => m.status === "landed")).toBe(true);
    });
  });

  describe("POST /api/v1/merge-groups/:id/reject", () => {
    it("403 when a stranger ai_agent (non-submitter) rejects... actually allowed for integrator", async () => {
      // Integrator (any ai_agent) may reject — this asserts ai_agent → 200.
      const project = createTestProject(testApp.db);
      const submitter = createTestAiAgent(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const { groupId } = await createGroup(project.id, submitter.token);

      const res = await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/reject`, {
        token: integrator.token,
        body: { reason: "abandon" },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("rejected");
    });

    it("200 when the submitter rejects (forming → rejected)", async () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestAiAgent(testApp.db, { role: "member" });
      const { groupId } = await createGroup(project.id, submitter.token);

      const res = await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/reject`, {
        token: submitter.token,
        body: { reason: "changed my mind" },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("rejected");
    });

    it("200 when an admin rejects", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const { groupId } = await createGroup(project.id, agent.token);

      const res = await authRequest(testApp.app, "POST", `/api/v1/merge-groups/${groupId}/reject`, {
        token: testApp.testToken,
        body: { reason: "policy" },
      });
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
