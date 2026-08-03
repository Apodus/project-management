import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createId } from "@pm/shared";
import { createTestAiAgent, createTestApp, createTestProject, type TestApp } from "../utils.js";
import { mergeAttempts } from "../../src/db/index.js";
import * as healthSvc from "../../src/services/health.service.js";
import * as mergeRequestSvc from "../../src/services/merge-request.service.js";
import * as lockSvc from "../../src/services/merge-lock.service.js";
import { deriveLiveness } from "../../src/services/integrator-liveness.service.js";

function makePayload(
  overrides: Partial<healthSvc.HeartbeatPayload> = {},
): healthSvc.HeartbeatPayload {
  return {
    status: "idle",
    poolSize: 3,
    poolLeased: 1,
    inFlightRequests: 0,
    inFlightBatches: 0,
    inFlightGroups: 0,
    version: "1.2.3",
    ...overrides,
  };
}

/** Insert a raw merge_attempts row (bypasses the integrating-state guard). */
function insertAttempt(testApp: TestApp, requestId: string, status: string, attemptNumber: number) {
  const now = new Date().toISOString();
  testApp.db
    .insert(mergeAttempts)
    .values({
      id: createId(),
      requestId,
      attemptNumber,
      baseSha: "base000",
      treeSha: null,
      status,
      startedAt: now,
      completedAt: status === "running" ? null : now,
      verifyDurationMs: null,
      failureCategory: null,
      failureReason: null,
      failedFiles: null,
      logExcerpt: null,
      logUrl: null,
      steps: null,
      createdAt: now,
    })
    .run();
}

describe("integrator liveness — deriveLiveness", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("fresh heartbeat + integrating → alive, lane_status integrating, no stall", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const now = "2026-07-14T12:00:00.000Z";
    healthSvc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      makePayload({ status: "integrating", version: "9.9.9" }),
      now,
    );

    const live = deriveLiveness(project.id, "main", now);
    expect(live.status).toBe("alive");
    expect(live.lane_status).toBe("integrating");
    expect(live.last_heartbeat_age_sec).toBe(0);
    expect(live.version).toBe("9.9.9");
    expect(live.stall).toBeNull();
  });

  it("stale heartbeat (>90s) + queued 0-attempt request → stale + integrator_down stall", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const t0 = "2026-07-14T12:00:00.000Z";
    healthSvc.recordHeartbeat(project.id, "main", agent.user.id, makePayload(), t0);

    mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "feat/stuck",
    });

    // 91s later — beyond HEALTH_STALE_MS (90s).
    const now = "2026-07-14T12:01:31.000Z";
    const live = deriveLiveness(project.id, "main", now);
    expect(live.status).toBe("stale");
    expect(live.last_heartbeat_age_sec).toBe(91);
    expect(live.stall).toBe("integrator_down");
  });

  it("no health row (never seen) + queued 0-attempt request → down + integrator_down stall", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "feat/stuck",
    });

    const now = "2026-07-14T12:00:00.000Z";
    const live = deriveLiveness(project.id, "main", now);
    expect(live.status).toBe("down");
    expect(live.lane_status).toBeNull();
    expect(live.last_heartbeat_age_sec).toBeNull();
    expect(live.version).toBeNull();
    expect(live.stall).toBe("integrator_down");
  });

  it("stale heartbeat + EMPTY queue → no stall (no false positive)", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const t0 = "2026-07-14T12:00:00.000Z";
    healthSvc.recordHeartbeat(project.id, "main", agent.user.id, makePayload(), t0);

    const now = "2026-07-14T12:01:31.000Z";
    const live = deriveLiveness(project.id, "main", now);
    expect(live.status).toBe("stale");
    expect(live.stall).toBeNull();
  });

  it("never-seen + EMPTY queue → down but no stall", () => {
    const project = createTestProject(testApp.db);
    const now = "2026-07-14T12:00:00.000Z";
    const live = deriveLiveness(project.id, "main", now);
    expect(live.status).toBe("down");
    expect(live.stall).toBeNull();
  });

  it("re-queued request (cancelled attempt rows) + stale heartbeat → no stall (counts ALL attempts)", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const t0 = "2026-07-14T12:00:00.000Z";
    healthSvc.recordHeartbeat(project.id, "main", agent.user.id, makePayload(), t0);

    // A request that was attempted, failed, and re-queued: it is back at
    // status "queued" but retains a CANCELLED attempt row.
    const req = mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "feat/requeued",
    });
    insertAttempt(testApp, req.id, "cancelled", 1);

    const now = "2026-07-14T12:01:31.000Z";
    const live = deriveLiveness(project.id, "main", now);
    expect(live.status).toBe("stale");
    // The only queued request has an attempt row → not "unattempted" → no stall.
    expect(live.stall).toBeNull();
  });

  it("alive + idle + empty queue → alive, no stall", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const now = "2026-07-14T12:00:00.000Z";
    healthSvc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      makePayload({ status: "idle" }),
      now,
    );

    const live = deriveLiveness(project.id, "main", now);
    expect(live.status).toBe("alive");
    expect(live.lane_status).toBe("idle");
    expect(live.stall).toBeNull();
  });

  it("resource-scoped: a queued request on another resource does not stall 'main'", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    // 'main' is fresh + idle; a different lane has the stuck queue.
    const now = "2026-07-14T12:00:00.000Z";
    healthSvc.recordHeartbeat(project.id, "main", agent.user.id, makePayload(), now);
    mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      resource: "release",
      branch: "feat/other-lane",
    });

    const live = deriveLiveness(project.id, "main", now);
    expect(live.stall).toBeNull();
  });
});

describe("integrator liveness — attached to the merge-lock read", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("getLock carries the integrator block (never-seen fail-safe, no crash)", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const view = lockSvc.getLock(project.id, "main", { id: agent.user.id });
    expect(view.integrator).toBeDefined();
    expect(view.integrator?.status).toBe("down");
  });

  it("listLocks carries the integrator block on each lane", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const now = new Date().toISOString();
    healthSvc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      makePayload({ status: "integrating" }),
      now,
    );
    // Materialize the lock row.
    lockSvc.getLock(project.id, "main", { id: agent.user.id });

    const list = lockSvc.listLocks(project.id, { id: agent.user.id });
    expect(list).toHaveLength(1);
    expect(list[0].integrator?.status).toBe("alive");
    expect(list[0].integrator?.lane_status).toBe("integrating");
  });
});

describe("integrator liveness — attached to the merge-request reads", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // The merge-request service derives liveness with the REAL wall clock (no
  // injectable `now` on list/getById), so staleness is driven by the heartbeat's
  // STORED timestamp: a long-past heartbeat is unambiguously stale; a just-now
  // heartbeat is fresh.
  const LONG_AGO = "2020-01-01T00:00:00.000Z";

  it("LIST: stale heartbeat + queued 0-attempt request → integrator sibling stall=integrator_down", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    healthSvc.recordHeartbeat(project.id, "main", agent.user.id, makePayload(), LONG_AGO);
    mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "feat/stuck",
    });

    const result = mergeRequestSvc.list(project.id, {});
    expect(result.integrator).toBeDefined();
    expect(result.integrator.status).toBe("stale");
    expect(result.integrator.stall).toBe("integrator_down");
    // Envelope sibling — no row in `data` carries an integrator field.
    expect(result.data.length).toBeGreaterThan(0);
    for (const row of result.data) expect(row).not.toHaveProperty("integrator");
  });

  // ── pool_stranded: the ALIVE stall (2026-08-02 lane wedge) ────────
  //
  // The daemon heartbeats on time and the lane reads idle, so every liveness
  // signal says "healthy, be patient" — while it holds every verify worktree
  // with nothing in flight and can admit nothing. Nine hours of that is what
  // this stall shape exists to name.

  it("alive + every slot leased + nothing in flight + queued 0-attempt → pool_stranded", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const now = "2026-08-03T04:30:00.000Z";
    healthSvc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      makePayload({ status: "idle", poolSize: 1, poolLeased: 1 }),
      now,
    );
    mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "codex/build-throughput",
    });

    const live = deriveLiveness(project.id, "main", now);
    // Liveness itself is healthy — that is the whole trap.
    expect(live.status).toBe("alive");
    expect(live.lane_status).toBe("idle");
    // …but the queue cannot move. Say so.
    expect(live.stall).toBe("pool_stranded");
  });

  it("a pool fully leased DURING a batch is not a stall (in-flight work owns the slots)", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const now = "2026-08-03T04:30:00.000Z";
    healthSvc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      makePayload({
        status: "integrating",
        poolSize: 1,
        poolLeased: 1,
        inFlightRequests: 1,
        inFlightBatches: 1,
      }),
      now,
    );
    mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "feat/waiting-its-turn",
    });

    expect(deriveLiveness(project.id, "main", now).stall).toBeNull();
  });

  it("a saturated pool with NOTHING queued is not a stall", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const now = "2026-08-03T04:30:00.000Z";
    healthSvc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      makePayload({ status: "idle", poolSize: 1, poolLeased: 1 }),
      now,
    );

    expect(deriveLiveness(project.id, "main", now).stall).toBeNull();
  });

  it("a stale heartbeat reports integrator_down even when the pool also looks stranded", () => {
    // Precedence: a dead daemon's pool numbers describe a process that is
    // already gone — "restart it" is the same advice, but DOWN is the honest
    // reason, so it must win.
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const t0 = "2026-08-03T04:00:00.000Z";
    healthSvc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      makePayload({ status: "idle", poolSize: 1, poolLeased: 1 }),
      t0,
    );
    mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "feat/stuck",
    });

    const live = deriveLiveness(project.id, "main", "2026-08-03T04:10:00.000Z");
    expect(live.status).toBe("stale");
    expect(live.stall).toBe("integrator_down");
  });

  it("LIST: alive + integrating → integrator.status alive, stall null", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    healthSvc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      makePayload({ status: "integrating" }),
      new Date().toISOString(),
    );

    const result = mergeRequestSvc.list(project.id, {});
    expect(result.integrator.status).toBe("alive");
    expect(result.integrator.lane_status).toBe("integrating");
    expect(result.integrator.stall).toBeNull();
  });

  it("GET/detail: liveness sibling present + correct; base request row has no integrator field", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    healthSvc.recordHeartbeat(project.id, "main", agent.user.id, makePayload(), LONG_AGO);
    const req = mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "feat/stuck",
    });

    const detail = mergeRequestSvc.getById(req.id);
    // Sibling present + correct (stale + queued 0-attempt → stall).
    expect(detail.integrator).toBeDefined();
    expect(detail.integrator.status).toBe("stale");
    expect(detail.integrator.stall).toBe("integrator_down");
    // Base request row is byte-identical: integrator is NOT a field on it.
    expect(detail.data.id).toBe(req.id);
    expect(detail.data).not.toHaveProperty("integrator");
    expect(detail.data.attempts).toEqual([]);
  });
});
