import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestApp,
  createTestAiAgent,
  createTestProject,
  authRequest,
  type TestApp,
} from "../utils.js";

function heartbeatBody(overrides: Record<string, unknown> = {}) {
  return {
    resource: "main",
    status: "idle",
    pool_utilization: { size: 3, leased: 1 },
    in_flight: { requests: 0, batches: 0, groups: 0 },
    version: "0.0.0",
    ...overrides,
  };
}

describe("Integrator health endpoints", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── ai_agent gate on the heartbeat POST ──────────────────────────

  it("returns 403 FORBIDDEN when a human posts a heartbeat", async () => {
    const project = createTestProject(testApp.db);
    // Default test user is a human admin.
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/integrator/heartbeat`,
      { body: heartbeatBody() },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 401 with no token", async () => {
    const project = createTestProject(testApp.db);
    const res = await testApp.app.request(
      `/api/v1/projects/${project.id}/integrator/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(heartbeatBody()),
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with the health view when an ai_agent posts a heartbeat", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/integrator/heartbeat`,
      {
        token: agent.token,
        body: heartbeatBody({
          status: "integrating",
          pool_utilization: { size: 3, leased: 2 },
          in_flight: { requests: 1, batches: 1, groups: 0 },
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.healthy).toBe(true);
    expect(body.data.status).toBe("integrating");
    expect(body.data.pool_leased).toBe(2);
    expect(body.data.in_flight_requests).toBe(1);
    expect(body.data.staleness_ms).toBeLessThanOrEqual(90_000);
    expect(body.data.last_seen_at).toBeTruthy();
  });

  // ── GET health is open to any authed user ────────────────────────

  it("GET health returns 200 with never_seen before any heartbeat for any authed user", async () => {
    const project = createTestProject(testApp.db);
    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/integrator/health?resource=main`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("never_seen");
    expect(body.data.healthy).toBe(false);
    expect(body.data.last_seen_at).toBeNull();
    expect(body.data.staleness_ms).toBeNull();
  });

  it("GET health returns the derived freshness after a heartbeat", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/integrator/heartbeat`,
      { token: agent.token, body: heartbeatBody() },
    );

    // Read as the default human user — any authed user may view.
    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/integrator/health`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.healthy).toBe(true);
    expect(typeof body.data.staleness_ms).toBe("number");
    expect(body.data.pool_size).toBe(3);
  });
});
