import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  type TestApp,
} from "../utils.js";
import { mergeAttempts, mergeRequests } from "../../src/db/index.js";

describe("POST /api/v1/merge-requests/:id/reset-to-queued", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  async function submitRequest(
    projectId: string,
    token: string,
  ): Promise<string> {
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${projectId}/merge-requests`,
      { token, body: { resource: "main", branch: "feature/x" } },
    );
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  }

  function forceIntegrating(requestId: string): void {
    testApp.db
      .update(mergeRequests)
      .set({ status: "integrating", pickedUpAt: new Date().toISOString() })
      .where(eq(mergeRequests.id, requestId))
      .run();
  }

  function insertRunningAttempt(requestId: string): string {
    const id = createId();
    const ts = new Date().toISOString();
    testApp.db
      .insert(mergeAttempts)
      .values({
        id,
        requestId,
        attemptNumber: 1,
        baseSha: "base0001",
        treeSha: null,
        status: "running",
        startedAt: ts,
        completedAt: null,
        verifyDurationMs: null,
        failureCategory: null,
        failureReason: null,
        failedFiles: null,
        logExcerpt: null,
        logUrl: null,
        createdAt: ts,
      })
      .run();
    return id;
  }

  it("200: ai_agent resets an integrating request to queued and cancels open attempts", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const requestId = await submitRequest(project.id, agent.token);
    forceIntegrating(requestId);
    const attemptId = insertRunningAttempt(requestId);

    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/merge-requests/${requestId}/reset-to-queued`,
      { token: agent.token, body: { reason: "push race; main moved" } },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("queued");
    expect(json.data.pickedUpAt).toBeNull();

    const row = testApp.db
      .select()
      .from(mergeRequests)
      .where(eq(mergeRequests.id, requestId))
      .get();
    expect(row?.status).toBe("queued");

    const att = testApp.db
      .select()
      .from(mergeAttempts)
      .where(eq(mergeAttempts.id, attemptId))
      .get();
    expect(att?.status).toBe("cancelled");
  });

  it("409: resetting a queued request (wrong state)", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const requestId = await submitRequest(project.id, agent.token);

    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/merge-requests/${requestId}/reset-to-queued`,
      { token: agent.token, body: { reason: "nope" } },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_TRANSITION");
  });

  it("403: human (non-ai_agent) is forbidden", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const requestId = await submitRequest(project.id, agent.token);
    forceIntegrating(requestId);

    // Default test token is an admin human.
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/merge-requests/${requestId}/reset-to-queued`,
      { token: testApp.testToken, body: { reason: "i am human" } },
    );
    expect(res.status).toBe(403);
  });

  it("404: missing request", async () => {
    const agent = createTestAiAgent(testApp.db);
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/merge-requests/${createId()}/reset-to-queued`,
      { token: agent.token, body: { reason: "ghost" } },
    );
    expect(res.status).toBe(404);
  });

  it("401: unauthenticated", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const requestId = await submitRequest(project.id, agent.token);
    forceIntegrating(requestId);

    const res = await testApp.app.request(
      `/api/v1/merge-requests/${requestId}/reset-to-queued`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "x" }),
      },
    );
    expect(res.status).toBe(401);
  });
});
