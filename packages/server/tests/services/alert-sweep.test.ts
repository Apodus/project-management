import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAiAgent, createTestApp, createTestProject, type TestApp } from "../utils.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import * as healthSvc from "../../src/services/health.service.js";
import * as mergeRequestSvc from "../../src/services/merge-request.service.js";
import {
  listAlertSweepLanes,
  startAlertSweep,
  sweepAlertsOnce,
} from "../../src/services/alert-sweep.service.js";

// ─── Periodic train-alert sweep ───────────────────────────────────
//
// Phase 7.4 evaluates train alerts ON READ. On 2026-08-02 a wedged lane sat
// with `train.stuck` TRUE for nine and a half hours and never alerted, because
// nobody opened the dashboard. These tests pin the sweep that removes the
// "somebody has to be looking" precondition — and pin that it changes nothing
// else: same events, same edge-triggered latches, same one-per-episode.

const QUIET = { warn: () => {}, info: () => {} };

function heartbeat(
  testApp: TestApp,
  projectId: string,
  at: string,
  overrides: Partial<healthSvc.HeartbeatPayload> = {},
): void {
  const agent = createTestAiAgent(testApp.db);
  healthSvc.recordHeartbeat(
    projectId,
    "main",
    agent.user.id,
    {
      status: "idle",
      poolSize: 1,
      poolLeased: 0,
      inFlightRequests: 0,
      inFlightBatches: 0,
      inFlightGroups: 0,
      version: "0.1.0",
      ...overrides,
    },
    at,
  );
}

describe("alert sweep", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    testApp.cleanup();
  });

  // ── Lane enumeration ───────────────────────────────────────────

  it("sweeps lanes with a deployed integrator AND lanes with live work", () => {
    const withDaemon = createTestProject(testApp.db);
    heartbeat(testApp, withDaemon.id, new Date().toISOString());

    const withWork = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    mergeRequestSvc.submit({
      projectId: withWork.id,
      submittedBy: agent.user.id,
      branch: "feat/queued",
    });

    // A project with neither is not a train lane at all.
    createTestProject(testApp.db);

    const lanes = listAlertSweepLanes();
    const ids = lanes.map((l) => l.projectId);
    expect(ids).toContain(withDaemon.id);
    expect(ids).toContain(withWork.id);
    expect(lanes).toHaveLength(2);
    expect(lanes.every((l) => l.resource === "main")).toBe(true);
  });

  it("dedupes a lane that has BOTH an integrator and queued work", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    heartbeat(testApp, project.id, new Date().toISOString());
    mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "feat/x",
    });

    expect(listAlertSweepLanes()).toHaveLength(1);
  });

  // ── The alert that never fired ─────────────────────────────────

  it("fires train.stuck for a wedged lane with nobody reading the dashboard", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    // The 2026-08-02 shape: work queued long ago, nothing in flight, train
    // running, integrator heartbeating happily.
    const req = mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "codex/build-throughput",
    });
    testApp.db.run(
      `update merge_requests set enqueued_at = '2026-08-02T18:56:56.013Z' where id = '${req.id}'` as never,
    );
    heartbeat(testApp, project.id, new Date().toISOString(), { poolLeased: 1 });

    const fired: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_STUCK, (p) => fired.push(p.entity));

    expect(sweepAlertsOnce(QUIET)).toBe(1);
    expect(fired).toHaveLength(1);

    // Latched exactly as an on-read evaluation is: a 5-minute sweep must not
    // re-alert every 5 minutes for the same episode.
    sweepAlertsOnce(QUIET);
    sweepAlertsOnce(QUIET);
    expect(fired).toHaveLength(1);
  });

  it("a healthy lane sweeps silently", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "feat/just-submitted",
    });
    heartbeat(testApp, project.id, new Date().toISOString());

    const fired: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_STUCK, (p) => fired.push(p.entity));
    getEventBus().on(EVENT_NAMES.TRAIN_INTEGRATOR_UNHEALTHY, (p) => fired.push(p.entity));

    expect(sweepAlertsOnce(QUIET)).toBe(1);
    expect(fired).toEqual([]);
  });

  it("fires integrator_unhealthy for a lane whose daemon went silent", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "feat/orphaned",
    });
    // Last heartbeat well beyond HEALTH_STALE_MS.
    heartbeat(testApp, project.id, new Date(Date.now() - 3_600_000).toISOString());

    const fired: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_INTEGRATOR_UNHEALTHY, (p) => fired.push(p.entity));

    sweepAlertsOnce(QUIET);
    expect(fired).toHaveLength(1);
  });

  // ── Resilience: this runs on a timer with no caller to catch it ──

  it("one failing lane is caught, logged, and never stops the others", () => {
    const a = createTestProject(testApp.db);
    const b = createTestProject(testApp.db);
    const c = createTestProject(testApp.db);
    for (const p of [a, b, c]) heartbeat(testApp, p.id, new Date().toISOString());

    const warn = vi.fn();
    const seen: string[] = [];
    const swept = sweepAlertsOnce({ warn }, (projectId) => {
      seen.push(projectId);
      if (projectId === b.id) throw new Error("lane exploded");
      return null;
    });

    // Every lane was attempted; only the exploding one was lost.
    expect(seen).toHaveLength(3);
    expect(swept).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(b.id);
  });

  it("sweepAlertsOnce swallows a lane-enumeration failure", () => {
    testApp.cleanup(); // DB closed underneath the sweep
    const warn = vi.fn();
    expect(() => sweepAlertsOnce({ warn })).not.toThrow();
    expect(sweepAlertsOnce({ warn })).toBe(0);
    expect(warn).toHaveBeenCalled();
    testApp = createTestApp(); // restore for afterEach
  });

  // ── Wiring ──────────────────────────────────────────────────────

  it("PM_ALERT_SWEEP_SEC=0 disables the timer (on-read evaluation unchanged)", () => {
    const info = vi.fn();
    const stop = startAlertSweep({ intervalSec: 0, logger: { warn: () => {}, info } });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("disabled"));
    stop();
  });

  it("startAlertSweep evaluates on its interval and stops cleanly", () => {
    vi.useFakeTimers();
    const project = createTestProject(testApp.db);
    heartbeat(testApp, project.id, new Date(Date.now() - 3_600_000).toISOString());
    const agent = createTestAiAgent(testApp.db);
    mergeRequestSvc.submit({
      projectId: project.id,
      submittedBy: agent.user.id,
      branch: "feat/orphaned",
    });

    const fired: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_INTEGRATOR_UNHEALTHY, (p) => fired.push(p.entity));

    const stop = startAlertSweep({ intervalSec: 30, logger: QUIET });
    expect(fired).toHaveLength(0); // no boot sweep — the first tick is on the interval
    vi.advanceTimersByTime(30_000);
    expect(fired).toHaveLength(1);

    stop();
    vi.advanceTimersByTime(120_000);
    expect(fired).toHaveLength(1); // stopped means stopped
  });
});
