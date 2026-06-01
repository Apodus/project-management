import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  type TestApp,
} from "../utils.js";
import { mergeResolutions } from "../../src/db/index.js";

describe("Merge Resolutions API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── helpers ─────────────────────────────────────────────────────

  /** Submit a merge request via the agent token → returns its id (FK-valid). */
  async function makeRequest(
    projectId: string,
    token: string,
    branch = "feat-a",
  ): Promise<string> {
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${projectId}/merge-requests`,
      { token, body: { resource: "main", branch } },
    );
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  }

  /** Open a resolution (pending) → returns its id. */
  async function openResolution(
    projectId: string,
    token: string,
    originRequestId: string,
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${projectId}/merge-resolutions`,
      {
        token,
        body: { originRequestId, conflictingFiles: ["a.ts"], ...body },
      },
    );
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  }

  /** Walk a resolution to "resolving" so escalate/resolved are legal. */
  async function startResolution(id: string, token: string): Promise<void> {
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/merge-resolutions/${id}/start`,
      { token },
    );
    expect(res.status).toBe(200);
  }

  // ─── A. POST open ────────────────────────────────────────────────
  describe("POST /api/v1/projects/:projectId/merge-resolutions", () => {
    it("201 when ai_agent opens (state pending)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);

      const id = await openResolution(project.id, agent.token, originId);
      const row = testApp.db
        .select()
        .from(mergeResolutions)
        .where(eq(mergeResolutions.id, id))
        .get();
      expect(row?.state).toBe("pending");
      expect(row?.originRequestId).toBe(originId);
      expect(row?.conflictingFiles).toEqual(["a.ts"]);
    });

    it("403 when non-ai_agent (human admin) opens", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-resolutions`,
        { token: testApp.testToken, body: { originRequestId: originId } },
      );
      expect(res.status).toBe(403);
    });
  });

  // ─── B. POST start ───────────────────────────────────────────────
  describe("POST /api/v1/merge-resolutions/:id/start", () => {
    it("200 pending → resolving (sets attemptStartedAt)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);
      const id = await openResolution(project.id, agent.token, originId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-resolutions/${id}/start`,
        { token: agent.token },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("resolving");
      expect(json.data.attemptStartedAt).toBeTruthy();
    });

    it("403 when non-ai_agent starts", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);
      const id = await openResolution(project.id, agent.token, originId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-resolutions/${id}/start`,
        { token: testApp.testToken },
      );
      expect(res.status).toBe(403);
    });

    it("409 when starting a row that is not pending", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);
      const id = await openResolution(project.id, agent.token, originId);
      await startResolution(id, agent.token);
      // Drive to resolved, then start again → illegal.
      const resolvedId = await makeRequest(project.id, agent.token, "feat-b");
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-resolutions/${id}/resolved`,
        { token: agent.token, body: { resolvedRequestId: resolvedId } },
      );

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-resolutions/${id}/start`,
        { token: agent.token },
      );
      expect(res.status).toBe(409);
    });
  });

  // ─── C. POST resolved ────────────────────────────────────────────
  describe("POST /api/v1/merge-resolutions/:id/resolved", () => {
    it("200 resolving → resolved (sets resolvedRequestId + attemptEndedAt)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);
      const id = await openResolution(project.id, agent.token, originId);
      await startResolution(id, agent.token);
      const resolvedId = await makeRequest(project.id, agent.token, "feat-b");

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-resolutions/${id}/resolved`,
        {
          token: agent.token,
          body: { resolvedRequestId: resolvedId, detail: { verifyVerdict: "pass" } },
        },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("resolved");
      expect(json.data.resolvedRequestId).toBe(resolvedId);
      expect(json.data.attemptEndedAt).toBeTruthy();
      expect(json.data.detail.verifyVerdict).toBe("pass");
    });

    it("403 when non-ai_agent records resolved", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);
      const id = await openResolution(project.id, agent.token, originId);
      await startResolution(id, agent.token);
      const resolvedId = await makeRequest(project.id, agent.token, "feat-b");

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-resolutions/${id}/resolved`,
        { token: testApp.testToken, body: { resolvedRequestId: resolvedId } },
      );
      expect(res.status).toBe(403);
    });

    it("409 when recording resolved on a pending (not resolving) row", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);
      const id = await openResolution(project.id, agent.token, originId);
      const resolvedId = await makeRequest(project.id, agent.token, "feat-b");

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-resolutions/${id}/resolved`,
        { token: agent.token, body: { resolvedRequestId: resolvedId } },
      );
      expect(res.status).toBe(409);
    });
  });

  // ─── D. POST escalate ────────────────────────────────────────────
  describe("POST /api/v1/merge-resolutions/:id/escalate", () => {
    it("200 resolving → escalated (default state, sets target + reason)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);
      const id = await openResolution(project.id, agent.token, originId);
      await startResolution(id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-resolutions/${id}/escalate`,
        { token: agent.token, body: { target: "author", reason: "verify failed" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("escalated");
      expect(json.data.escalationTarget).toBe("author");
      expect(json.data.attemptEndedAt).toBeTruthy();
      expect(json.data.detail.escalationReason).toBe("verify failed");
    });

    it("200 resolving → failed (explicit state)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);
      const id = await openResolution(project.id, agent.token, originId);
      await startResolution(id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-resolutions/${id}/escalate`,
        {
          token: agent.token,
          body: { state: "failed", target: "human", reason: "worktree build failed" },
        },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.state).toBe("failed");
      expect(json.data.escalationTarget).toBe("human");
    });

    it("403 when non-ai_agent escalates", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);
      const id = await openResolution(project.id, agent.token, originId);
      await startResolution(id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-resolutions/${id}/escalate`,
        { token: testApp.testToken, body: { target: "author", reason: "x" } },
      );
      expect(res.status).toBe(403);
    });

    it("409 when escalating a pending (not resolving) row", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);
      const id = await openResolution(project.id, agent.token, originId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-resolutions/${id}/escalate`,
        { token: agent.token, body: { target: "author", reason: "x" } },
      );
      expect(res.status).toBe(409);
    });
  });

  // ─── E. GET by id ────────────────────────────────────────────────
  describe("GET /api/v1/merge-resolutions/:id", () => {
    it("200 (human admin)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);
      const id = await openResolution(project.id, agent.token, originId);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-resolutions/${id}`,
        { token: testApp.testToken },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe(id);
      expect(json.data.resolvedRequestId).toBeNull();
    });

    it("404 when unknown", async () => {
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-resolutions/01HNONEXISTENTRES00000`,
        { token: testApp.testToken },
      );
      expect(res.status).toBe(404);
    });
  });

  // ─── F. GET list ─────────────────────────────────────────────────
  describe("GET /api/v1/projects/:projectId/merge-resolutions", () => {
    it("200 filtered by state/resource (human admin)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const originId = await makeRequest(project.id, agent.token);
      const id = await openResolution(project.id, agent.token, originId);

      const all = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-resolutions`,
        { token: testApp.testToken },
      );
      expect(all.status).toBe(200);
      const allJson = await all.json();
      expect(allJson.data).toHaveLength(1);
      expect(allJson.data[0].id).toBe(id);

      const byState = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-resolutions?state=pending&resource=main`,
        { token: testApp.testToken },
      );
      const byStateJson = await byState.json();
      expect(byStateJson.data).toHaveLength(1);

      const none = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-resolutions?state=resolved`,
        { token: testApp.testToken },
      );
      const noneJson = await none.json();
      expect(noneJson.data).toHaveLength(0);

      const otherResource = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-resolutions?resource=release`,
        { token: testApp.testToken },
      );
      const otherJson = await otherResource.json();
      expect(otherJson.data).toHaveLength(0);
    });
  });

  // ─── G. 401 ──────────────────────────────────────────────────────
  it("401 when unauthenticated", async () => {
    const project = createTestProject(testApp.db);
    const res = await testApp.app.request(
      `/api/v1/projects/${project.id}/merge-resolutions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ originRequestId: "x" }),
      },
    );
    expect(res.status).toBe(401);
  });
});
