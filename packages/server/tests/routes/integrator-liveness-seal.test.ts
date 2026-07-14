import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  type TestApp,
} from "../utils.js";
import * as healthSvc from "../../src/services/health.service.js";

/**
 * P4 end-to-end SEAL: the integrator-liveness block must survive the full HTTP
 * read path (route handler + envelope serialization), not just the service layer
 * that P1/P2 unit-test. These assertions fail if the route wiring regresses —
 * e.g. a handler that drops `integrator` from the merge-lock view, or strips the
 * envelope sibling off the merge-request list/detail reads.
 *
 * getLock / merge-request reads derive liveness with the REAL wall clock (no
 * injectable `now` at the route level), so staleness is driven by the heartbeat's
 * STORED timestamp: a long-past beat is unambiguously stale/down; a just-now beat
 * (posted through the HTTP heartbeat route) is fresh.
 */
const LONG_AGO = "2020-01-01T00:00:00.000Z";

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

async function submitRequest(testApp: TestApp, projectId: string, token: string, branch: string) {
  const res = await authRequest(
    testApp.app,
    "POST",
    `/api/v1/projects/${projectId}/merge-requests`,
    { token, body: { branch } },
  );
  expect(res.status).toBe(201);
  return res;
}

async function getLock(testApp: TestApp, projectId: string, token: string) {
  const res = await authRequest(
    testApp.app,
    "GET",
    `/api/v1/projects/${projectId}/merge-locks/main`,
    { token },
  );
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

describe("SEAL: integrator liveness on the merge-lock read (HTTP route)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("(a) absent heartbeat + queued 0-attempt request → data.integrator.stall = integrator_down", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    // A stuck queue with no integrator ever seen.
    await submitRequest(testApp, project.id, agent.token, "feat/stuck");

    const view = await getLock(testApp, project.id, agent.token);
    expect(view.integrator).toBeDefined();
    expect(view.integrator.status).toBe("down");
    expect(view.integrator.stall).toBe("integrator_down");
  });

  it("(a') stale heartbeat (long-past) + queued 0-attempt request → stall = integrator_down", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    // A beat that landed long ago → stale by stored timestamp.
    healthSvc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      {
        status: "idle",
        poolSize: 3,
        poolLeased: 1,
        inFlightRequests: 0,
        inFlightBatches: 0,
        inFlightGroups: 0,
        version: "1.0.0",
      },
      LONG_AGO,
    );
    await submitRequest(testApp, project.id, agent.token, "feat/stuck");

    const view = await getLock(testApp, project.id, agent.token);
    expect(view.integrator.status).toBe("stale");
    expect(view.integrator.stall).toBe("integrator_down");
    expect(view.integrator.last_heartbeat_age_sec).toBeGreaterThan(90);
  });

  it("(b) fresh heartbeat (via HTTP) + integrating lane → status alive, stall null", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    // Post a live beat through the actual heartbeat route (real now → fresh).
    const beat = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/integrator/heartbeat`,
      { token: agent.token, body: heartbeatBody({ status: "integrating", version: "9.9.9" }) },
    );
    expect(beat.status).toBe(200);
    // A request is in flight, but the lane is actively integrating → not a stall.
    await submitRequest(testApp, project.id, agent.token, "feat/inflight");

    const view = await getLock(testApp, project.id, agent.token);
    expect(view.integrator.status).toBe("alive");
    expect(view.integrator.lane_status).toBe("integrating");
    expect(view.integrator.version).toBe("9.9.9");
    expect(view.integrator.stall).toBeNull();
  });

  it("(c) alive + empty queue → stall null (no false positive)", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const beat = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/integrator/heartbeat`,
      { token: agent.token, body: heartbeatBody({ status: "idle" }) },
    );
    expect(beat.status).toBe(200);

    const view = await getLock(testApp, project.id, agent.token);
    expect(view.integrator.status).toBe("alive");
    expect(view.integrator.stall).toBeNull();
  });
});

describe("SEAL: integrator liveness envelope sibling on the merge-request list read (HTTP route)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("stale heartbeat + queued 0-attempt request → body.integrator.stall = integrator_down, rows carry no integrator", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    healthSvc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      {
        status: "idle",
        poolSize: 3,
        poolLeased: 1,
        inFlightRequests: 0,
        inFlightBatches: 0,
        inFlightGroups: 0,
        version: "1.0.0",
      },
      LONG_AGO,
    );
    await submitRequest(testApp, project.id, agent.token, "feat/stuck");

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/merge-requests`,
      { token: agent.token },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Envelope sibling — carried alongside `data`, not on any row.
    expect(body.integrator).toBeDefined();
    expect(body.integrator.status).toBe("stale");
    expect(body.integrator.stall).toBe("integrator_down");
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) expect(row).not.toHaveProperty("integrator");
  });
});
