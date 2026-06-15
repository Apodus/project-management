import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  comments,
  escalationMessages,
  escalations,
  gitRefs,
  mergeRequests,
} from "../../src/db/index.js";
import * as escalationService from "../../src/services/escalation.service.js";
import { createId } from "@pm/shared";

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

    it("persists resolvedFrom and round-trips it on the view (Phase 7.6 Step 7)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);

      // An origin request to point resolvedFrom at.
      const originId = await submitRequest(project.id, agent.token, {
        branch: "feature/origin",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests`,
        {
          token: agent.token,
          body: {
            resource: "main",
            branch: "pm/resolution-res-1",
            resolvedFrom: originId,
          },
        },
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.resolvedFrom).toBe(originId);

      // Persisted on the row.
      const row = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, json.data.id))
        .get();
      expect(row?.resolvedFrom).toBe(originId);

      // Round-trips on the GET view.
      const getRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-requests/${json.data.id}`,
        { token: agent.token },
      );
      const getJson = await getRes.json();
      expect(getJson.data.resolvedFrom).toBe(originId);
    });

    // ── Campaign A2 §P1: escalationId provenance link ──────────────
    function insertEscalation(projectId: string, authorId: string): string {
      const id = createId();
      const ts = new Date().toISOString();
      testApp.db
        .insert(escalations)
        .values({
          id,
          projectId,
          kind: "bug_report",
          title: "auto-implement me",
          originRepo: "game_one",
          originWorkerKey: "worker-1",
          authorId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      return id;
    }

    it("persists escalationId and round-trips it on the view (A2 §P1)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const escId = insertEscalation(project.id, agent.user.id);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests`,
        {
          token: agent.token,
          body: {
            resource: "main",
            branch: "pm/escalation-e1",
            escalationId: escId,
          },
        },
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.escalationId).toBe(escId);

      const row = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, json.data.id))
        .get();
      expect(row?.escalationId).toBe(escId);

      const getRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-requests/${json.data.id}`,
        { token: agent.token },
      );
      const getJson = await getRes.json();
      expect(getJson.data.escalationId).toBe(escId);
    });

    it("escalationId is null when omitted (byte-identical to pre-A2)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);

      const id = await submitRequest(project.id, agent.token, { branch: "feature/no-esc" });
      const getRes = await authRequest(testApp.app, "GET", `/api/v1/merge-requests/${id}`, {
        token: agent.token,
      });
      const getJson = await getRes.json();
      expect(getJson.data.escalationId).toBeNull();

      const row = testApp.db.select().from(mergeRequests).where(eq(mergeRequests.id, id)).get();
      expect(row?.escalationId).toBeNull();
    });

    it("400 when escalationId belongs to a different project", async () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const otherEsc = insertEscalation(projectB.id, agent.user.id);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${projectA.id}/merge-requests`,
        {
          token: agent.token,
          body: { resource: "main", escalationId: otherEsc },
        },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    it("404 when escalationId does not exist", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests`,
        {
          token: agent.token,
          body: { resource: "main", escalationId: "01HNONEXISTENTESC000000" },
        },
      );
      expect(res.status).toBe(404);
    });

    it("401 when unauthenticated", async () => {
      const project = createTestProject(testApp.db);
      const res = await testApp.app.request(`/api/v1/projects/${project.id}/merge-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "main" }),
      });
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

    it("filters by ?resolvedFrom=<origin> — NARROWS to only the resubmission (7.6.1)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      // An origin request, a resubmission pointing at it, and an unrelated one.
      const originId = await submitRequest(project.id, agent.token, {
        branch: "feature/origin",
      });
      const resubId = await submitRequest(project.id, agent.token, {
        branch: "pm/resolution-1",
        resolvedFrom: originId,
      });
      await submitRequest(project.id, agent.token, { branch: "feature/unrelated" });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-requests?resolvedFrom=${originId}`,
        { token: agent.token },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      // The filter MUST narrow — exactly the resubmission, NOT all 3 requests.
      // (The camelCase-key trap: a mismatched key is silently dropped by the
      // non-strict listQuery and would return all requests.)
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe(resubId);
      expect(json.data[0].resolvedFrom).toBe(originId);
      expect(json.pagination.total).toBe(1);
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

      const res = await authRequest(testApp.app, "GET", `/api/v1/merge-requests/${requestId}`, {
        token: agent.token,
      });
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
      await authRequest(testApp.app, "POST", `/api/v1/merge-requests/${requestId}/attempts`, {
        token: agent.token,
        body: { baseSha: "base1234" },
      });

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

    it("Phase 7.5: per-step results surface under the attempt event", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);
      const startRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/attempts`,
        { token: agent.token, body: { baseSha: "base1234" } },
      );
      const attemptId = (await startRes.json()).data.id;
      const steps = [
        {
          stepId: "unit",
          outcome: "fail",
          cached: false,
          durationMs: 42300,
          treeSha: "tree9",
          stepConfigSha: "cfg-unit",
        },
      ];
      await authRequest(testApp.app, "PATCH", `/api/v1/merge-attempts/${attemptId}`, {
        token: agent.token,
        body: {
          status: "failed",
          failureCategory: "test_failed",
          failureReason: "unit failed",
          steps,
        },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-requests/${requestId}/timeline`,
        { token: agent.token },
      );
      const json = await res.json();
      const attempt = json.data.events.find((e: { kind: string }) => e.kind === "attempt");
      expect(attempt.steps).toEqual(steps);
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
      const res = await testApp.app.request(`/api/v1/merge-requests/${requestId}/timeline`, {
        method: "GET",
      });
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

    it("200 when a non-submitter cancels an integrating request (no ownership gate)", async () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestAiAgent(testApp.db);
      const stranger = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, submitter.token);
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/cancel`,
        { token: stranger.token },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("abandoned");
    });

    it("200 + reason body accepted on an integrating-cancel", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const requestId = await submitRequest(project.id, agent.token);
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/cancel`,
        { token: agent.token, body: { reason: "superseded" } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("abandoned");
    });

    it("409 GROUPED_MEMBER when cancelling a grouped member independently", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const a = await submitRequest(project.id, agent.token, { branch: "a" });
      const b = await submitRequest(project.id, agent.token, { branch: "b" });

      const groupRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-groups`,
        { token: agent.token, body: { resource: "main", memberRequestIds: [a, b] } },
      );
      expect(groupRes.status).toBe(201);

      const res = await authRequest(testApp.app, "POST", `/api/v1/merge-requests/${a}/cancel`, {
        token: agent.token,
      });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe("GROUPED_MEMBER");
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

      const res = await testApp.app.request(`/api/v1/merge-requests/${requestId}/cancel`, {
        method: "POST",
      });
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

      const res = await testApp.app.request(`/api/v1/merge-requests/${requestId}/pickup`, {
        method: "POST",
      });
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
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/merge-attempts/${attemptId}`, {
        token: agent.token,
        body: { status: "passed", treeSha: "tree1234" },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("passed");
      expect(json.data.treeSha).toBe("tree1234");
    });

    it("Phase 7.5: passed + steps[] round-trips through the detail GET", async () => {
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
      const attemptId = (await startRes.json()).data.id;
      const steps = [
        {
          stepId: "lint",
          outcome: "pass",
          cached: true,
          durationMs: 0,
          treeSha: "tree1234",
          stepConfigSha: "cfg-lint",
        },
      ];
      const completeRes = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/merge-attempts/${attemptId}`,
        { token: agent.token, body: { status: "passed", treeSha: "tree1234", steps } },
      );
      expect(completeRes.status).toBe(200);
      expect((await completeRes.json()).data.steps).toEqual(steps);

      // FOLDED-FIX C3: the detail response must surface the persisted steps.
      const detailRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/merge-requests/${requestId}`,
        { token: agent.token },
      );
      const detail = await detailRes.json();
      expect(detail.data.attempts[0].steps).toEqual(steps);
    });

    it("400 when status=passed is missing treeSha", async () => {
      const { attemptId, agent } = await setupRunningAttempt();
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/merge-attempts/${attemptId}`, {
        token: agent.token,
        body: { status: "passed" },
      });
      expect(res.status).toBe(400);
    });

    it("403 when non-integrator (human admin) completes", async () => {
      const { attemptId } = await setupRunningAttempt();
      const res = await authRequest(testApp.app, "PATCH", `/api/v1/merge-attempts/${attemptId}`, {
        token: testApp.testToken,
        body: { status: "passed", treeSha: "tree1234" },
      });
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

      const refs = testApp.db.select().from(gitRefs).where(eq(gitRefs.taskId, task.id)).all();
      const landedRef = refs.find((r) => r.refType === "landed_sha" && r.refValue === "landed999");
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

      const res = await authRequest(testApp.app, "POST", `/api/v1/merge-requests/${a}/land`, {
        token: agent.token,
        body: { landedSha: "landed999" },
      });
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
      await authRequest(testApp.app, "POST", `/api/v1/merge-requests/${requestId}/attempts`, {
        token: agent.token,
        body: { baseSha: "base0001" },
      });

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
      const rejectionComment = commentRows.find((c) => c.commentType === "merge_rejection");
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

  // ─── J. Campaign A2 §P2+P3: escalation post-back ─────────────────
  //
  // A landed escalationId-linked merge request resolves its escalation as
  // the HOLDER (answer→resolve), so the origin auto-notices the landed_sha
  // via C2; a rejected one escalates the escalation to needs_human with the
  // structured reject reason, the branch (MR row) preserved. The post-back
  // runs after the land/reject commit + event, guarded on escalationId, and
  // is best-effort (never breaks the land/reject).
  describe("escalation post-back (A2 §P2+P3)", () => {
    /**
     * Seed an `acknowledged` escalation held by a RESPONDER ai_agent, with a
     * DISTINCT origin author (so resolve() is not an author-withdrawal and
     * the holder-authored message surfaces to the origin via C2). Returns the
     * escalation id + the holder id + the origin worker key.
     */
    function seedHeldEscalation(
      projectId: string,
      holderId: string,
      originAuthorId: string,
      originWorkerKey = "origin-worker-1",
    ): string {
      const id = createId();
      const ts = new Date().toISOString();
      testApp.db
        .insert(escalations)
        .values({
          id,
          projectId,
          kind: "bug_report",
          status: "acknowledged",
          title: "auto-implement me",
          originRepo: "game_one",
          originWorkerKey,
          holderId,
          authorId: originAuthorId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      return id;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("land resolves the escalation as holder + origin auto-notices the sha", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db); // the responder
      const origin = createTestUser(testApp.db); // a DIFFERENT user
      const escId = seedHeldEscalation(project.id, holder.user.id, origin.id);

      const requestId = await submitRequest(project.id, integrator.token, {
        branch: "pm/escalation-land",
        escalationId: escId,
      });
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/land`,
        {
          token: integrator.token,
          body: { landedSha: "landedABC" },
        },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("landed");

      // Escalation resolved, by the holder.
      const escRow = testApp.db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(escRow?.status).toBe("resolved");
      expect(escRow?.resolvedBy).toBe(holder.user.id);

      // A message row carries the landed sha + the MR id.
      const msgs = testApp.db
        .select()
        .from(escalationMessages)
        .where(eq(escalationMessages.escalationId, escId))
        .all();
      const landedMsg = msgs.find(
        (m) => m.body.includes("landedABC") && m.body.includes(requestId),
      );
      expect(landedMsg).toBeTruthy();

      // The origin auto-notices via C2: holder-authored message surfaces.
      const undelivered = escalationService.listUndeliveredForWorker("origin-worker-1", project.id);
      const entry = undelivered.find((u) => u.escalation.id === escId);
      expect(entry).toBeTruthy();
      expect(entry!.unreadCount).toBeGreaterThanOrEqual(1);
      expect(entry!.unreadMessages.some((m) => m.body.includes("landedABC"))).toBe(true);
    });

    it("reject escalates to needs_human + branch (MR row) preserved", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db);
      const origin = createTestUser(testApp.db);
      const escId = seedHeldEscalation(project.id, holder.user.id, origin.id);

      const requestId = await submitRequest(project.id, integrator.token, {
        branch: "pm/escalation-reject",
        escalationId: escId,
      });
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/reject`,
        {
          token: integrator.token,
          body: { category: "build_failed", reason: "TS2304 boom", logUrl: "https://ex/log" },
        },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("rejected");

      // Escalation now needs_human.
      const escRow = testApp.db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(escRow?.status).toBe("needs_human");

      // A system message carries the reject reason.
      const msgs = testApp.db
        .select()
        .from(escalationMessages)
        .where(eq(escalationMessages.escalationId, escId))
        .all();
      const rejectMsg = msgs.find(
        (m) => m.messageType === "system" && m.body.includes("TS2304 boom"),
      );
      expect(rejectMsg).toBeTruthy();

      // The MR row still exists with its branch intact (work preserved).
      const mrRow = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, requestId))
        .get();
      expect(mrRow).toBeTruthy();
      expect(mrRow?.branch).toBe("pm/escalation-reject");
    });

    it("no-escalationId land/reject leave escalations untouched (byte-identical)", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db);
      const origin = createTestUser(testApp.db);
      // An UNRELATED held escalation that must NOT be mutated.
      const escId = seedHeldEscalation(project.id, holder.user.id, origin.id);

      // Land with no escalationId.
      const landReq = await submitRequest(project.id, integrator.token, {
        branch: "feature/plain-land",
      });
      forceIntegrating(landReq);
      const landRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${landReq}/land`,
        {
          token: integrator.token,
          body: { landedSha: "plainland" },
        },
      );
      expect(landRes.status).toBe(200);

      // Reject with no escalationId.
      const rejReq = await submitRequest(project.id, integrator.token, {
        branch: "feature/plain-rej",
      });
      forceIntegrating(rejReq);
      const rejRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${rejReq}/reject`,
        {
          token: integrator.token,
          body: { category: "policy", reason: "nope" },
        },
      );
      expect(rejRes.status).toBe(200);

      // The unrelated escalation is untouched + no messages were appended.
      const escRow = testApp.db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(escRow?.status).toBe("acknowledged");
      const msgs = testApp.db
        .select()
        .from(escalationMessages)
        .where(eq(escalationMessages.escalationId, escId))
        .all();
      expect(msgs.length).toBe(0);
    });

    // ── A3 P2 (Directive 1): the post-back is gated on taskId === null. A
    // task-LINKED escalation MR is a campaign PHASE of an autonomous arc — its
    // land must NOT resolve the root and its reject must NOT drive needs_human
    // (only advanceArc drives arc completion/partial from server-observed land
    // status). A task-LESS escalation MR (the A1 bounded-fix shape) keeps the
    // A2 invariant: land resolves, reject → needs_human.
    it("task-LINKED escalation MR land does NOT resolve the escalation (A3 P2 phase gate)", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db);
      const origin = createTestUser(testApp.db);
      const escId = seedHeldEscalation(project.id, holder.user.id, origin.id);
      const task = createTestTask(testApp.db, { projectId: project.id });

      const requestId = await submitRequest(project.id, integrator.token, {
        branch: "pm/escalation-e1-task-1",
        escalationId: escId,
        taskId: task.id,
      });
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/land`,
        {
          token: integrator.token,
          body: { landedSha: "phaseSHA" },
        },
      );
      expect(res.status).toBe(200);

      // The escalation STAYS acknowledged — NOT resolved by a phase land.
      const escRow = testApp.db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(escRow?.status).toBe("acknowledged");
      // No post-back message appended.
      const msgs = testApp.db
        .select()
        .from(escalationMessages)
        .where(eq(escalationMessages.escalationId, escId))
        .all();
      expect(msgs.length).toBe(0);
    });

    it("task-LINKED escalation MR reject does NOT drive needs_human (A3 P2 phase gate)", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db);
      const origin = createTestUser(testApp.db);
      const escId = seedHeldEscalation(project.id, holder.user.id, origin.id);
      const task = createTestTask(testApp.db, { projectId: project.id });

      const requestId = await submitRequest(project.id, integrator.token, {
        branch: "pm/escalation-e1-task-2",
        escalationId: escId,
        taskId: task.id,
      });
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/reject`,
        {
          token: integrator.token,
          body: { category: "build_failed", reason: "phase boom" },
        },
      );
      expect(res.status).toBe(200);

      // The escalation STAYS acknowledged — a phase reject does NOT drive needs_human.
      const escRow = testApp.db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(escRow?.status).toBe("acknowledged");
      const msgs = testApp.db
        .select()
        .from(escalationMessages)
        .where(eq(escalationMessages.escalationId, escId))
        .all();
      expect(msgs.length).toBe(0);
    });

    it("task-LESS escalation MR still resolves on land + needs_human on reject (A2 invariant preserved)", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db);
      const origin = createTestUser(testApp.db);

      // Land (task-LESS) → resolved.
      const escLand = seedHeldEscalation(project.id, holder.user.id, origin.id, "wk-land");
      const landReq = await submitRequest(project.id, integrator.token, {
        branch: "pm/escalation-bounded-land",
        escalationId: escLand,
        taskId: null,
      });
      forceIntegrating(landReq);
      const landRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${landReq}/land`,
        {
          token: integrator.token,
          body: { landedSha: "boundedSHA" },
        },
      );
      expect(landRes.status).toBe(200);
      const landEsc = testApp.db
        .select()
        .from(escalations)
        .where(eq(escalations.id, escLand))
        .get();
      expect(landEsc?.status).toBe("resolved");

      // Reject (task-LESS) → needs_human.
      const escRej = seedHeldEscalation(project.id, holder.user.id, origin.id, "wk-rej");
      const rejReq = await submitRequest(project.id, integrator.token, {
        branch: "pm/escalation-bounded-rej",
        escalationId: escRej,
        taskId: null,
      });
      forceIntegrating(rejReq);
      const rejRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${rejReq}/reject`,
        {
          token: integrator.token,
          body: { category: "build_failed", reason: "bounded boom" },
        },
      );
      expect(rejRes.status).toBe(200);
      const rejEsc = testApp.db.select().from(escalations).where(eq(escalations.id, escRej)).get();
      expect(rejEsc?.status).toBe("needs_human");
    });

    it("land post-back is non-fatal: holderId=null skips, land still 200", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const origin = createTestUser(testApp.db);
      // Holder-less escalation (no actor to assert) — seed with null holder.
      const escId = createId();
      const ts = new Date().toISOString();
      testApp.db
        .insert(escalations)
        .values({
          id: escId,
          projectId: project.id,
          kind: "bug_report",
          status: "acknowledged",
          title: "no holder",
          originRepo: "game_one",
          originWorkerKey: "origin-worker-1",
          authorId: origin.id,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const requestId = await submitRequest(project.id, integrator.token, {
        branch: "pm/escalation-noholder",
        escalationId: escId,
      });
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/land`,
        {
          token: integrator.token,
          body: { landedSha: "landedNH" },
        },
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data.status).toBe("landed");

      // Skip path: escalation NOT resolved.
      const escRow = testApp.db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(escRow?.status).toBe("acknowledged");
    });

    it("land post-back is non-fatal: an induced throw is caught, land still 200", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db);
      const origin = createTestUser(testApp.db);
      const escId = seedHeldEscalation(project.id, holder.user.id, origin.id);

      vi.spyOn(escalationService, "resolve").mockImplementation(() => {
        throw new Error("boom");
      });

      const requestId = await submitRequest(project.id, integrator.token, {
        branch: "pm/escalation-throw",
        escalationId: escId,
      });
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/land`,
        {
          token: integrator.token,
          body: { landedSha: "landedThrow" },
        },
      );
      // Land still succeeds — the post-back throw is swallowed.
      expect(res.status).toBe(200);
      expect((await res.json()).data.status).toBe("landed");
    });

    // A2 §P4: the 7.6 resolver reconciles a responder MR. The RESUBMISSION
    // carries BOTH resolvedFrom (no-recursion seal) AND escalationId (the
    // post-back link, propagated from the origin) — so landing the RESOLUTION
    // (not the origin) still fires the post-back: the escalation resolves and
    // the landed_sha summary lands on the thread. This proves the propagated
    // escalationId is load-bearing on the resolution's land.
    it("resubmission (resolvedFrom + propagated escalationId) lands ⇒ post-back fires on the resolution", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db); // the responder
      const origin = createTestUser(testApp.db); // a DIFFERENT user
      const escId = seedHeldEscalation(
        project.id,
        holder.user.id,
        origin.id,
        "origin-worker-resub",
      );

      // The origin responder MR (escalationId-linked) — the resolver's input.
      const originReqId = await submitRequest(project.id, integrator.token, {
        branch: "pm/escalation-origin",
        escalationId: escId,
      });

      // The resolver resubmits: a NEW MR carrying resolvedFrom = origin AND the
      // propagated escalationId (both coexist).
      const resubId = await submitRequest(project.id, integrator.token, {
        branch: "pm/resolution-resub",
        resolvedFrom: originReqId,
        escalationId: escId,
      });
      const resubRow = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, resubId))
        .get();
      expect(resubRow?.resolvedFrom).toBe(originReqId);
      expect(resubRow?.escalationId).toBe(escId);

      // Land the RESOLUTION (not the origin).
      forceIntegrating(resubId);
      const res = await authRequest(testApp.app, "POST", `/api/v1/merge-requests/${resubId}/land`, {
        token: integrator.token,
        body: { landedSha: "resubLANDED" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).data.status).toBe("landed");

      // The escalation resolves (post-back fired off the RESOLUTION's land).
      const escRow = testApp.db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(escRow?.status).toBe("resolved");
      expect(escRow?.resolvedBy).toBe(holder.user.id);

      // The landed_sha summary references the resolution MR + its sha.
      const msgs = testApp.db
        .select()
        .from(escalationMessages)
        .where(eq(escalationMessages.escalationId, escId))
        .all();
      const landedMsg = msgs.find(
        (m) => m.body.includes("resubLANDED") && m.body.includes(resubId),
      );
      expect(landedMsg).toBeTruthy();

      // The origin auto-notices via C2 (holder-authored message surfaces).
      const undelivered = escalationService.listUndeliveredForWorker(
        "origin-worker-resub",
        project.id,
      );
      const entry = undelivered.find((u) => u.escalation.id === escId);
      expect(entry).toBeTruthy();
      expect(entry!.unreadMessages.some((m) => m.body.includes("resubLANDED"))).toBe(true);
    });

    it("reject post-back is non-fatal: an induced throw is caught, reject still 200", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db);
      const origin = createTestUser(testApp.db);
      const escId = seedHeldEscalation(project.id, holder.user.id, origin.id);

      vi.spyOn(escalationService, "escalateToHuman").mockImplementation(() => {
        throw new Error("boom");
      });

      const requestId = await submitRequest(project.id, integrator.token, {
        branch: "pm/escalation-reject-throw",
        escalationId: escId,
      });
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/reject`,
        {
          token: integrator.token,
          body: { category: "build_failed", reason: "boom reason" },
        },
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data.status).toBe("rejected");
    });
  });

  // ─── K. Campaign A4 P2: fast revert path ─────────────────────────
  //
  // POST /merge-requests/revert records a task-less, branchless, revertOf-set
  // queued MR (the integrator materializes `git revert <sha>` at pickup). It
  // copies an existing landed MR's verifyCmd; threads escalationId; the
  // revertOf list filter narrows to revert MRs; a landed/rejected revert fires
  // the A2 post-back exactly like any escalationId-linked task-less MR.
  describe("revert (A4 P2)", () => {
    function seedHeldEscalation(
      projectId: string,
      holderId: string,
      originAuthorId: string,
    ): string {
      const id = createId();
      const ts = new Date().toISOString();
      testApp.db
        .insert(escalations)
        .values({
          id,
          projectId,
          kind: "bug_report",
          status: "acknowledged",
          title: "revert me",
          originRepo: "game_one",
          originWorkerKey: "origin-worker-revert",
          holderId,
          authorId: originAuthorId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      return id;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("creates a queued, task-less, branchless, revertOf-set MR + emits QUEUED", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests/revert`,
        { token: agent.token, body: { landedSha: "badc0ffee" } },
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.status).toBe("queued");
      expect(json.data.revertOf).toBe("badc0ffee");
      expect(json.data.taskId).toBeNull();
      expect(json.data.branch).toBeNull();
      expect(json.data.submittedBy).toBe(agent.user.id);

      const row = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, json.data.id))
        .get();
      expect(row?.revertOf).toBe("badc0ffee");
      expect(row?.taskId).toBeNull();
      expect(row?.branch).toBeNull();
    });

    it("copies an existing landed MR's verifyCmd for the same sha", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);

      // A landed MR for the sha, carrying a non-default verifyCmd.
      const landedId = await submitRequest(project.id, agent.token, {
        branch: "feature/orig",
        verifyCmd: "pnpm verify:special",
      });
      forceIntegrating(landedId);
      await authRequest(testApp.app, "POST", `/api/v1/merge-requests/${landedId}/land`, {
        token: agent.token,
        body: { landedSha: "sha-to-revert" },
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests/revert`,
        { token: agent.token, body: { landedSha: "sha-to-revert" } },
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.verifyCmd).toBe("pnpm verify:special");
    });

    it("verifyCmd is null when no landed MR exists for the sha (project-default fallback)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests/revert`,
        { token: agent.token, body: { landedSha: "out-of-band-sha" } },
      );
      expect(res.status).toBe(201);
      expect((await res.json()).data.verifyCmd).toBeNull();
    });

    it("revertOf list filter returns only revert MRs", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);

      // A normal MR + a revert MR.
      await submitRequest(project.id, agent.token, { branch: "feature/normal" });
      const revertRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests/revert`,
        { token: agent.token, body: { landedSha: "revert-target" } },
      );
      const revertId = (await revertRes.json()).data.id;

      const listRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-requests?revertOf=revert-target`,
        { token: agent.token },
      );
      expect(listRes.status).toBe(200);
      const list = await listRes.json();
      expect(list.data).toHaveLength(1);
      expect(list.data[0].id).toBe(revertId);
      expect(list.data[0].revertOf).toBe("revert-target");
    });

    it("a normal MR view carries revertOf: null (byte-identical additive field)", async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const id = await submitRequest(project.id, agent.token, { branch: "feature/plain" });
      const getRes = await authRequest(testApp.app, "GET", `/api/v1/merge-requests/${id}`, {
        token: agent.token,
      });
      expect((await getRes.json()).data.revertOf).toBeNull();
    });

    it("400 when escalationId belongs to a different project", async () => {
      const project = createTestProject(testApp.db);
      const otherProject = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db);
      const origin = createTestUser(testApp.db);
      const otherEsc = seedHeldEscalation(otherProject.id, holder.user.id, origin.id);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests/revert`,
        { token: agent.token, body: { landedSha: "x", escalationId: otherEsc } },
      );
      expect(res.status).toBe(400);
    });

    it("a landed escalationId-linked revert fires the A2 post-back (resolves the escalation)", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db);
      const origin = createTestUser(testApp.db);
      const escId = seedHeldEscalation(project.id, holder.user.id, origin.id);

      const revertRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests/revert`,
        { token: integrator.token, body: { landedSha: "wrong-sha", escalationId: escId } },
      );
      const requestId = (await revertRes.json()).data.id;
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/land`,
        {
          token: integrator.token,
          body: { landedSha: "revertLandedSha" },
        },
      );
      expect(res.status).toBe(200);

      const escRow = testApp.db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(escRow?.status).toBe("resolved");
      expect(escRow?.resolvedBy).toBe(holder.user.id);
    });

    it("a rejected escalationId-linked revert escalates to needs_human", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db);
      const origin = createTestUser(testApp.db);
      const escId = seedHeldEscalation(project.id, holder.user.id, origin.id);

      const revertRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests/revert`,
        { token: integrator.token, body: { landedSha: "wrong-sha-2", escalationId: escId } },
      );
      const requestId = (await revertRes.json()).data.id;
      forceIntegrating(requestId);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/merge-requests/${requestId}/reject`,
        {
          token: integrator.token,
          body: { category: "test_failed", reason: "revert broke a test" },
        },
      );
      expect(res.status).toBe(200);

      const escRow = testApp.db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(escRow?.status).toBe("needs_human");
    });

    it("a revert with NO escalationId leaves escalations untouched (byte-identical)", async () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const holder = createTestAiAgent(testApp.db);
      const origin = createTestUser(testApp.db);
      const escId = seedHeldEscalation(project.id, holder.user.id, origin.id);

      const revertRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-requests/revert`,
        { token: integrator.token, body: { landedSha: "plain-revert" } },
      );
      const requestId = (await revertRes.json()).data.id;
      forceIntegrating(requestId);
      await authRequest(testApp.app, "POST", `/api/v1/merge-requests/${requestId}/land`, {
        token: integrator.token,
        body: { landedSha: "plainRevertLanded" },
      });

      const escRow = testApp.db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(escRow?.status).toBe("acknowledged");
    });
  });
});
