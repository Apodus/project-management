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
import { auditLog, mergeRequests } from "../../src/db/index.js";

describe("POST /api/v1/merge-requests/:id/outer-gitlink-normalized", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  async function submitRequest(projectId: string, token: string): Promise<string> {
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

  it("200: ai_agent writes exactly one `outer_gitlink_normalized` audit row, NO status change", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const requestId = await submitRequest(project.id, agent.token);
    forceIntegrating(requestId);

    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/merge-requests/${requestId}/outer-gitlink-normalized`,
      {
        token: agent.token,
        body: { reason: "stale-but-reachable gitlink stripped — source applied on live main" },
      },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // The request view comes back UNCHANGED — no lifecycle transition.
    expect(json.data.status).toBe("integrating");

    const row = testApp.db
      .select()
      .from(mergeRequests)
      .where(eq(mergeRequests.id, requestId))
      .get();
    expect(row?.status).toBe("integrating");

    const audits = testApp.db.select().from(auditLog).where(eq(auditLog.targetId, requestId)).all();
    const normalized = audits.filter((a) => a.action === "outer_gitlink_normalized");
    expect(normalized.length).toBe(1);
    expect(normalized[0].targetType).toBe("merge_request");
    expect(normalized[0].actorId).toBe(agent.user.id);
    expect(normalized[0].reason).toBe(
      "stale-but-reachable gitlink stripped — source applied on live main",
    );
    expect(normalized[0].metadataBefore).toBeNull();
    expect(normalized[0].metadataAfter).toEqual({ normalized: true });
  });

  it("403: human (non-ai_agent) is forbidden", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const requestId = await submitRequest(project.id, agent.token);
    forceIntegrating(requestId);

    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/merge-requests/${requestId}/outer-gitlink-normalized`,
      { token: testApp.testToken, body: { reason: "i am human" } },
    );
    expect(res.status).toBe(403);

    const audits = testApp.db.select().from(auditLog).where(eq(auditLog.targetId, requestId)).all();
    expect(audits.filter((a) => a.action === "outer_gitlink_normalized").length).toBe(0);
  });

  it("404: missing request", async () => {
    const agent = createTestAiAgent(testApp.db);
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/merge-requests/${createId()}/outer-gitlink-normalized`,
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
      `/api/v1/merge-requests/${requestId}/outer-gitlink-normalized`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "x" }),
      },
    );
    expect(res.status).toBe(401);
  });
});
