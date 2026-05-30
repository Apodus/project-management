import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestApp,
  createTestAiAgent,
  createTestProject,
  type TestApp,
} from "../utils.js";
import { integratorHealth } from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import * as svc from "../../src/services/health.service.js";

function makePayload(
  overrides: Partial<svc.HeartbeatPayload> = {},
): svc.HeartbeatPayload {
  return {
    status: "idle",
    poolSize: 3,
    poolLeased: 1,
    inFlightRequests: 0,
    inFlightBatches: 0,
    inFlightGroups: 0,
    version: "0.0.0",
    ...overrides,
  };
}

function rowsFor(testApp: TestApp, projectId: string) {
  return testApp.db
    .select()
    .from(integratorHealth)
    .where(eq(integratorHealth.projectId, projectId))
    .all();
}

describe("health service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Heartbeat upsert ─────────────────────────────────────────────

  it("first heartbeat INSERTs a row; second for the same lane UPDATEs it (count stays 1)", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    expect(rowsFor(testApp, project.id)).toHaveLength(0);

    const t1 = "2026-05-30T12:00:00.000Z";
    const v1 = svc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      makePayload({ status: "idle", poolLeased: 1 }),
      t1,
    );
    expect(rowsFor(testApp, project.id)).toHaveLength(1);
    expect(v1.lastSeenAt).toBe(t1);
    expect(v1.status).toBe("idle");

    const t2 = "2026-05-30T12:00:30.000Z";
    const v2 = svc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      makePayload({ status: "integrating", poolLeased: 2, inFlightRequests: 1 }),
      t2,
    );
    // Same (project, main) → UPDATE, not a new row.
    expect(rowsFor(testApp, project.id)).toHaveLength(1);
    // lastSeenAt advanced + payload denormalized.
    expect(v2.lastSeenAt).toBe(t2);
    expect(v2.status).toBe("integrating");
    expect(v2.poolLeased).toBe(2);
    expect(v2.inFlightRequests).toBe(1);
  });

  // ── getHealth freshness ──────────────────────────────────────────

  it("getHealth reports healthy with small staleness for a fresh heartbeat", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    const now = "2026-05-30T12:00:00.000Z";
    svc.recordHeartbeat(project.id, "main", agent.user.id, makePayload(), now);

    const view = svc.getHealth(project.id, "main", now);
    expect(view.healthy).toBe(true);
    expect(view.stalenessMs).toBe(0);
    expect(view.status).toBe("idle");
  });

  it("getHealth reports ~10s staleness still healthy when lastSeenAt = now-10s", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    const seen = "2026-05-30T12:00:00.000Z";
    svc.recordHeartbeat(project.id, "main", agent.user.id, makePayload(), seen);

    const now = "2026-05-30T12:00:10.000Z";
    const view = svc.getHealth(project.id, "main", now);
    expect(view.stalenessMs).toBe(10_000);
    expect(view.healthy).toBe(true);
  });

  it("getHealth reports never_seen / unhealthy / null last_seen when no row exists", () => {
    const project = createTestProject(testApp.db);

    const view = svc.getHealth(project.id, "main");
    expect(view.status).toBe("never_seen");
    expect(view.healthy).toBe(false);
    expect(view.lastSeenAt).toBeNull();
    expect(view.stalenessMs).toBeNull();
  });

  // ── Edge-trigger fires ONCE per stale episode ────────────────────

  it("getHealth fires train.integrator_unhealthy EXACTLY ONCE on the stale edge (latched)", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    // Seed a stale heartbeat: lastSeenAt = now - 120s, unhealthyNotified=false.
    const seen = "2026-05-30T12:00:00.000Z";
    svc.recordHeartbeat(project.id, "main", agent.user.id, makePayload(), seen);

    const calls: string[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_INTEGRATOR_UNHEALTHY, (p) => {
      calls.push(p.entityId as string);
    });

    const now = "2026-05-30T12:02:00.000Z"; // 120s later → stale (> 90s).
    const v1 = svc.getHealth(project.id, "main", now);
    expect(v1.healthy).toBe(false);
    expect(calls).toHaveLength(1);

    // Latch: unhealthyNotified flipped true.
    const row = rowsFor(testApp, project.id)[0];
    expect(row.unhealthyNotified).toBe(true);

    // Reading AGAIN while still stale must NOT re-fire (edge, not level).
    const later = "2026-05-30T12:03:00.000Z";
    svc.getHealth(project.id, "main", later);
    expect(calls).toHaveLength(1);
  });

  // ── Recovery re-arms the edge ────────────────────────────────────

  it("a fresh heartbeat re-arms the edge so the next stale episode fires again", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    const seen = "2026-05-30T12:00:00.000Z";
    svc.recordHeartbeat(project.id, "main", agent.user.id, makePayload(), seen);

    const calls: string[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_INTEGRATOR_UNHEALTHY, () => {
      calls.push("fired");
    });

    // First stale episode → fires once.
    svc.getHealth(project.id, "main", "2026-05-30T12:02:00.000Z");
    expect(calls).toHaveLength(1);

    // Recovery: a fresh heartbeat clears the latch + reports healthy.
    const recovered = svc.recordHeartbeat(
      project.id,
      "main",
      agent.user.id,
      makePayload(),
      "2026-05-30T12:02:30.000Z",
    );
    expect(recovered.healthy).toBe(true);
    const row = rowsFor(testApp, project.id)[0];
    expect(row.unhealthyNotified).toBe(false);

    // Second stale episode (now - 120s from the recovered beat) → fires again.
    svc.getHealth(project.id, "main", "2026-05-30T12:04:30.000Z");
    expect(calls).toHaveLength(2);
  });
});
