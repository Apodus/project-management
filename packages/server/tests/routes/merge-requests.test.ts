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
import { comments, gitRefs, mergeRequests } from "../../src/db/index.js";

describe("Merge Requests API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── helpers ─────────────────────────────────────────────────────

  /**
   * Submit a queued request via the API as the given ai_agent and return its id.
   */
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
   * Force the request to integrating via direct DB update.
   * The plan documents this is intentional: there is no pickup endpoint.
   */
  function forceIntegrating(requestId: string): void {
    testApp.db
      .update(mergeRequests)
      .set({
        status: "integrating",
        pickedUpAt: new Date().toISOString(),
      })
      .where(eq(mergeRequests.id, requestId))
      .run();
  }

  function forceLanded(requestId: string): void {
    testApp.db
      .update(mergeRequests)
      .set({
        status: "landed",
        resolvedAt: new Date().toISOString(),
        landedSha: "deadbeef",
      })
      .where(eq(mergeRequests.id, requestId))
      .run();
  }

  // ─── A. POST submit ──────────────────────────────────────────────
  describe("POST /api/v1/projects/:projectId/merge-requests", () => {
    it("happy path: creates a queued request with submittedBy=caller", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests`,
        {
          token: agent.token,
          body: {
            resource: "main",
            branch: "feature/foo",
            commitSha: "abc1234",
          },
        },
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.status).toBe("queued");
      expect(json.data.submittedBy).toBe(agent.user.id);
      expect(json.data.projectId).toBe(project.id);

      const row = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, json.data.id))
        .get();
      expect(row).toBeTruthy();
      expect(row?.submittedBy).toBe(agent.user.id);
      expect(row?.status).toBe("queued");
    });

    it("401 when unauthenticated", async () => {
      const project = createTestProject(testApp.db);
      const res = await testApp.app.request(
        `/api/v1/projects/${project.id}/merge-requests`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resource: "main" }),
        },
      );
      expect(res.status).toBe(401);
    });

    it("404 when project does not exist", async () => {
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/01HNONEXISTENTPROJECT00/merge-requests`,
        { token: agent.token, body: { resource: "main" } },
      );
      expect(res.status).toBe(404);
    });

    it("400 when taskId belongs to a different project", async () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const otherTask = createTestTask(testApp.db, { projectId: projectB.id });
      const agent = createTestAiAgent(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${projectA.id}/merge-requests`,
        {
          token: agent.token,
          body: { resource: "main", taskId: otherTask.id },
        },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ─── B. GET list ─────────────────────────────────────────────────
  describe("GET /api/v1/projects/:projectId/merge-requests", () => {
    it("returns all requests with pagination total", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      for (let i = 0; i < 3; i++) {
        await submitRequest(project.id, agent.token, {
          branch: `feature/${i}`,
        });
      }

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-requests`,
        { token: agent.token },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(3);
      expect(json.pagination.total).toBe(3);
    });

    it("filters by ?status=queued", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const queuedId = await submitRequest(project.id, agent.token);
      const integratingId = await submitRequest(project.id, agent.token);
      forceIntegrating(integratingId);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-requests?status=queued`,
        { token: agent.token },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe(queuedId);
      expect(json.data[0].status).toBe("queued");
    });
  });

  // ─── C. GET by id ────────────────────────────────────────────────
  describe("GET /api/v1/merge-requests/:id", () => {
    it("returns the request with its attempts", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);

      // Start an attempt via the API.
      const startRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/attempts`,
        { token: agent.token, body: { baseSha: "base1234" } },
      );
      expect(startRes.status).toBe(201);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-requests/${requestId}`,
        { token: agent.token },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe(requestId);
      expect(json.data.attempts).toHaveLength(1);
      expect(json.data.attempts[0].baseSha).toBe("base1234");
      expect(json.data.attempts[0].status).toBe("running");
    });

    it("404 when request does not exist", async () => {
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-requests/01HNONEXISTENTREQ00000`,
        { token: agent.token },
      );
      expect(res.status).toBe(404);
    });
  });

  // ─── C2. GET timeline ────────────────────────────────────────────
  describe("GET /api/v1/merge-requests/:id/timeline", () => {
    it("200 with auth: returns the request + ordered events", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/attempts`,
        { token: agent.token, body: { baseSha: "base1234" } },
      );

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-requests/${requestId}/timeline`,
        { token: agent.token },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.request.id).toBe(requestId);
      expect(Array.isArray(json.data.events)).toBe(true);
      const kinds = json.data.events.map((e: { kind: string }) => e.kind);
      expect(kinds).toContain("queued");
      expect(kinds).toContain("integrating");
      expect(kinds).toContain("attempt");
      // ascending by `at`
      const ats = json.data.events.map((e: { at: string }) => e.at);
      const sorted = [...ats].sort();
      expect(ats).toEqual(sorted);
    });

    it("404 when request does not exist", async () => {
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-requests/01HNONEXISTENTREQ00000/timeline`,
        { token: agent.token },
      );
      expect(res.status).toBe(404);
    });

    it("401 when unauthenticated", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      const res = await testApp.app.request(
        `/api/v1/merge-requests/${requestId}/timeline`,
        { method: "GET" },
      );
      expect(res.status).toBe(401);
    });
  });

  // ─── D. POST cancel ──────────────────────────────────────────────
  describe("POST /api/v1/merge-requests/:id/cancel", () => {
    it("200 when called by the submitter", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/cancel`,
        { token: agent.token },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("abandoned");
    });

    it("200 when called by an admin (not the submitter)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/cancel`,
        { token: testApp.testToken },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("abandoned");
    });

    it("403 when called by a stranger ai_agent", async () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestAiAgent(testApp.db);
      const stranger = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, submitter.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/cancel`,
        { token: stranger.token },
      );
      expect(res.status).toBe(403);
    });

    it("409 when the request is already in a terminal state (landed)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceLanded(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/cancel`,
        { token: agent.token },
      );
      expect(res.status).toBe(409);
    });

    it("401 when unauthenticated", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);

      const res = await testApp.app.request(
        `/api/v1/merge-requests/${requestId}/cancel`,
        { method: "POST" },
      );
      expect(res.status).toBe(401);
    });
  });

  // ─── D2. POST pickup ─────────────────────────────────────────────
  describe("POST /api/v1/merge-requests/:id/pickup", () => {
    it("200 when ai_agent picks up a queued request", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/pickup`,
        { token: agent.token },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("integrating");
      expect(json.data.pickedUpAt).toBeTruthy();
    });

    it("403 when human (admin) attempts pickup", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/pickup`,
        { token: testApp.testToken },
      );
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe("FORBIDDEN");
    });

    it("409 when picking up an already integrating request", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/pickup`,
        { token: agent.token },
      );
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe("INVALID_TRANSITION");
    });

    it("404 when request id unknown", async () => {
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/01HNONEXISTENTREQ00000/pickup`,
        { token: agent.token },
      );
      expect(res.status).toBe(404);
    });

    it("401 when unauthenticated", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);

      const res = await testApp.app.request(
        `/api/v1/merge-requests/${requestId}/pickup`,
        { method: "POST" },
      );
      expect(res.status).toBe(401);
    });
  });

  // ─── E. POST force-cancel ───────────────────────────────────────
  describe("POST /api/v1/merge-requests/:id/force-cancel", () => {
    it("200 when admin force-cancels an integrating request", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/force-cancel`,
        { token: testApp.testToken, body: { reason: "stuck" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("abandoned");
    });

    it("403 when a non-admin (ai_agent) attempts force-cancel", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/force-cancel`,
        { token: agent.token, body: { reason: "mine" } },
      );
      expect(res.status).toBe(403);
    });

    it("200 with empty body (reason optional)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/force-cancel`,
        { token: testApp.testToken },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("abandoned");
    });
  });

  // ─── F. POST start attempt ──────────────────────────────────────
  describe("POST /api/v1/merge-requests/:id/attempts", () => {
    it("201 when integrator starts an attempt on an integrating request", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/attempts`,
        { token: agent.token, body: { baseSha: "base0001" } },
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.status).toBe("running");
      expect(json.data.baseSha).toBe("base0001");
      expect(json.data.attemptNumber).toBe(1);
    });

    it("403 when non-integrator (human admin) starts an attempt", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/attempts`,
        { token: testApp.testToken, body: { baseSha: "base0001" } },
      );
      expect(res.status).toBe(403);
    });

    it("409 when request is still in queued state", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/attempts`,
        { token: agent.token, body: { baseSha: "base0001" } },
      );
      expect(res.status).toBe(409);
    });

    it("404 when request does not exist", async () => {
      const agent = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/01HNONEXISTENTREQ00000/attempts`,
        { token: agent.token, body: { baseSha: "base0001" } },
      );
      expect(res.status).toBe(404);
    });
  });

  // ─── G. PATCH complete attempt ──────────────────────────────────
  describe("PATCH /api/v1/merge-attempts/:id", () => {
    async function setupRunningAttempt(): Promise<{
      attemptId: string;
      agent: { user: { id: string }; token: string };
    }> {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);
      const startRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/attempts`,
        { token: agent.token, body: { baseSha: "base0001" } },
      );
      const startJson = await startRes.json();
      return { attemptId: startJson.data.id, agent };
    }

    it("200 when completing with status=passed + treeSha", async () => {
      const { attemptId, agent } = await setupRunningAttempt();
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/merge-attempts/${attemptId}`,
        {
          token: agent.token,
          body: { status: "passed", treeSha: "tree1234" },
        },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("passed");
      expect(json.data.treeSha).toBe("tree1234");
    });

    it("400 when status=passed is missing treeSha", async () => {
      const { attemptId, agent } = await setupRunningAttempt();
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/merge-attempts/${attemptId}`,
        { token: agent.token, body: { status: "passed" } },
      );
      expect(res.status).toBe(400);
    });

    it("403 when non-integrator (human admin) completes", async () => {
      const { attemptId } = await setupRunningAttempt();
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/merge-attempts/${attemptId}`,
        {
          token: testApp.testToken,
          body: { status: "passed", treeSha: "tree1234" },
        },
      );
      expect(res.status).toBe(403);
    });
  });

  // ─── H. POST land ───────────────────────────────────────────────
  describe("POST /api/v1/merge-requests/:id/land", () => {
    it("200 + git_refs row inserted (request linked to a task)", async () => {
      const project = createTestProject(testApp.db);
      const reporter = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: reporter.id,
      });
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token, {
        taskId: task.id,
        branch: "feature/x",
      });
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/land`,
        { token: agent.token, body: { landedSha: "landed999" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("landed");
      expect(json.data.landedSha).toBe("landed999");

      const refs = testApp.db
        .select()
        .from(gitRefs)
        .where(eq(gitRefs.taskId, task.id))
        .all();
      const landedRef = refs.find(
        (r) => r.refType === "landed_sha" && r.refValue === "landed999",
      );
      expect(landedRef).toBeTruthy();
    });

    it("409 when landing a queued request", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/land`,
        { token: agent.token, body: { landedSha: "landed999" } },
      );
      expect(res.status).toBe(409);
    });

    it("403 when non-integrator (human admin) lands", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/land`,
        { token: testApp.testToken, body: { landedSha: "landed999" } },
      );
      expect(res.status).toBe(403);
    });

    // ── G1 guard: a grouped member cannot land independently ──────────
    it("409 GROUPED_MEMBER when landing a grouped member independently", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const a = await submitRequest(project.id, agent.token, { branch: "a" });
      const b = await submitRequest(project.id, agent.token, { branch: "b" });

      // Bind a + b into a group, then flip one member to integrating.
      const groupRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        { token: agent.token, body: { resource: "main", memberRequestIds: [a, b] } },
      );
      expect(groupRes.status).toBe(201);
      forceIntegrating(a);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${a}/land`,
        { token: agent.token, body: { landedSha: "landed999" } },
      );
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe("GROUPED_MEMBER");
    });
  });

  // ─── I. POST reject ─────────────────────────────────────────────
  describe("POST /api/v1/merge-requests/:id/reject", () => {
    it("200 + merge_rejection comment row with structured metadata", async () => {
      const project = createTestProject(testApp.db);
      const reporter = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: reporter.id,
      });
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token, {
        taskId: task.id,
      });
      forceIntegrating(requestId);
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/attempts`,
        { token: agent.token, body: { baseSha: "base0001" } },
      );

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/reject`,
        {
          token: agent.token,
          body: {
            category: "build_failed",
            reason: "TS2304",
            failedFiles: ["src/foo.ts"],
            logUrl: "https://example.com/log",
          },
        },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("rejected");
      expect(json.data.rejectCategory).toBe("build_failed");

      const commentRows = testApp.db
        .select()
        .from(comments)
        .where(eq(comments.taskId, task.id))
        .all();
      const rejectionComment = commentRows.find(
        (c) => c.commentType === "merge_rejection",
      );
      expect(rejectionComment).toBeTruthy();
      const meta = rejectionComment?.metadata as Record<string, unknown>;
      expect(meta.mergeRequestId).toBe(requestId);
      expect(meta.category).toBe("build_failed");
      expect(meta.reason).toBe("TS2304");
      expect(meta.failedFiles).toEqual(["src/foo.ts"]);
    });

    it("403 when non-integrator (human admin) rejects", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/reject`,
        {
          token: testApp.testToken,
          body: { category: "policy", reason: "no" },
        },
      );
      expect(res.status).toBe(403);
    });

    it("409 when rejecting a queued request", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/reject`,
        {
          token: agent.token,
          body: { category: "policy", reason: "no" },
        },
      );
      expect(res.status).toBe(409);
    });
  });
});
