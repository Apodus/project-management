import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createId } from "@pm/shared";
import {
  createTestApp,
  createTestAiAgent,
  createTestProject,
  createTestUser,
  type TestApp,
} from "../utils.js";
import {
  integratorHealth,
  mergeAttempts,
  mergeRequestGroups,
  mergeRequests,
} from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import * as metrics from "../../src/services/metrics.service.js";

// A fixed reference "now" so the 24h cutoff is deterministic.
const NOW = "2026-05-30T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

const HOUR = 3600_000;

// ── Seed helpers ─────────────────────────────────────────────────

function seedRequest(
  testApp: TestApp,
  args: {
    projectId: string;
    submittedBy: string;
    resource?: string;
    status: string;
    enqueuedAt?: string;
    resolvedAt?: string | null;
    landedSha?: string | null;
    groupId?: string | null;
    pickedUpAt?: string | null;
  },
): string {
  const id = createId();
  testApp.db
    .insert(mergeRequests)
    .values({
      id,
      projectId: args.projectId,
      resource: args.resource ?? "main",
      submittedBy: args.submittedBy,
      taskId: null,
      branch: null,
      commitSha: null,
      verifyCmd: null,
      worktreePath: null,
      groupId: args.groupId ?? null,
      status: args.status,
      enqueuedAt: args.enqueuedAt ?? ago(HOUR),
      pickedUpAt: args.pickedUpAt ?? null,
      resolvedAt: args.resolvedAt ?? null,
      landedSha: args.landedSha ?? null,
      rejectCategory: null,
      rejectReason: null,
      failedFiles: null,
      logExcerpt: null,
      logUrl: null,
      createdAt: args.enqueuedAt ?? ago(HOUR),
      updatedAt: args.resolvedAt ?? args.enqueuedAt ?? ago(HOUR),
    })
    .run();
  return id;
}

function seedAttempt(
  testApp: TestApp,
  args: {
    requestId: string;
    attemptNumber?: number;
    status: string;
    completedAt?: string | null;
    baseSha?: string;
    treeSha?: string | null;
    startedAt?: string | null;
  },
): string {
  const id = createId();
  testApp.db
    .insert(mergeAttempts)
    .values({
      id,
      requestId: args.requestId,
      attemptNumber: args.attemptNumber ?? 1,
      baseSha: args.baseSha ?? "base0001",
      treeSha: args.treeSha ?? null,
      status: args.status,
      startedAt: args.startedAt ?? ago(HOUR),
      completedAt: args.completedAt ?? null,
      verifyDurationMs: null,
      failureCategory: null,
      failureReason: null,
      failedFiles: null,
      logExcerpt: null,
      logUrl: null,
      createdAt: ago(HOUR),
    })
    .run();
  return id;
}

function seedHealth(
  testApp: TestApp,
  args: {
    projectId: string;
    resource?: string;
    integratorId: string;
    poolSize?: number | null;
    poolLeased?: number | null;
    lastSeenAt: string;
    unhealthyNotified?: boolean;
  },
): void {
  testApp.db
    .insert(integratorHealth)
    .values({
      id: createId(),
      projectId: args.projectId,
      resource: args.resource ?? "main",
      integratorId: args.integratorId,
      status: "idle",
      poolSize: args.poolSize ?? null,
      poolLeased: args.poolLeased ?? null,
      inFlightRequests: 0,
      inFlightBatches: 0,
      inFlightGroups: 0,
      version: "0.0.0",
      lastSeenAt: args.lastSeenAt,
      unhealthyNotified: args.unhealthyNotified ?? false,
      createdAt: args.lastSeenAt,
      updatedAt: args.lastSeenAt,
    })
    .run();
}

function seedGroup(
  testApp: TestApp,
  args: {
    projectId: string;
    submittedBy: string;
    resource?: string;
    state: string;
  },
): string {
  const id = createId();
  testApp.db
    .insert(mergeRequestGroups)
    .values({
      id,
      projectId: args.projectId,
      resource: args.resource ?? "main",
      state: args.state,
      submittedBy: args.submittedBy,
      integratorId: null,
      resolvedAt: null,
      resolutionReason: null,
      createdAt: ago(HOUR),
      updatedAt: ago(HOUR),
    })
    .run();
  return id;
}

describe("metrics service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Percentiles (nearest-rank, pinned expected) ──────────────────

  it("computes p50/p95/p99 via nearest-rank over a known dataset", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    // 10 landed requests with time-to-land = 1..10 minutes. Each enqueued
    // (k minutes) before its resolvedAt, all resolved within the window.
    // durations sorted asc: [1,2,...,10] minutes.
    for (let k = 1; k <= 10; k++) {
      const resolvedAt = ago(2 * HOUR); // well within 24h
      const enqueuedAt = new Date(
        Date.parse(resolvedAt) - k * 60_000,
      ).toISOString();
      seedRequest(testApp, {
        projectId: project.id,
        submittedBy: user.id,
        status: "landed",
        enqueuedAt,
        resolvedAt,
        landedSha: `sha${k}`,
      });
    }

    const m = metrics.computeMetrics(project.id, "main", NOW);
    expect(m.timeToLand.sampleSize).toBe(10);
    // nearest-rank n=10: p50 idx = ceil(0.5*10)-1 = 4 → 5min; p95 idx =
    // ceil(0.95*10)-1 = 9 → 10min; p99 idx = ceil(0.99*10)-1 = 9 → 10min.
    expect(m.timeToLand.p50Ms).toBe(5 * 60_000);
    expect(m.timeToLand.p95Ms).toBe(10 * 60_000);
    expect(m.timeToLand.p99Ms).toBe(10 * 60_000);
  });

  // ── 24h window: JS-ISO cutoff (the bug-class test) ───────────────

  it("excludes a request resolved 25h ago and includes one resolved 23h ago", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    // 25h ago — OUTSIDE the window.
    const out = ago(25 * HOUR);
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "landed",
      enqueuedAt: new Date(Date.parse(out) - 60_000).toISOString(),
      resolvedAt: out,
      landedSha: "old",
    });
    // 23h ago — INSIDE the window.
    const inWin = ago(23 * HOUR);
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "landed",
      enqueuedAt: new Date(Date.parse(inWin) - 120_000).toISOString(),
      resolvedAt: inWin,
      landedSha: "new",
    });

    const m = metrics.computeMetrics(project.id, "main", NOW);
    // Only the 23h-old request counts.
    expect(m.timeToLand.sampleSize).toBe(1);
    expect(m.timeToLand.p50Ms).toBe(120_000);
    // Abandon-rate's resolved denominator is also windowed: only the in-window
    // landed counts as resolved.
    expect(m.abandonRate.resolved).toBe(1);
  });

  // ── Verify success rate (cancelled excluded) ─────────────────────

  it("computes verify success rate with cancelled excluded and window applied", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const req = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
    });

    // 2 passed, 1 failed, 1 cancelled — all in-window; 1 passed out-of-window.
    seedAttempt(testApp, {
      requestId: req,
      attemptNumber: 1,
      status: "passed",
      completedAt: ago(HOUR),
    });
    seedAttempt(testApp, {
      requestId: req,
      attemptNumber: 2,
      status: "passed",
      completedAt: ago(2 * HOUR),
    });
    seedAttempt(testApp, {
      requestId: req,
      attemptNumber: 3,
      status: "failed",
      completedAt: ago(3 * HOUR),
    });
    seedAttempt(testApp, {
      requestId: req,
      attemptNumber: 4,
      status: "cancelled",
      completedAt: ago(4 * HOUR),
    });
    // out-of-window passed → excluded entirely.
    seedAttempt(testApp, {
      requestId: req,
      attemptNumber: 5,
      status: "passed",
      completedAt: ago(30 * HOUR),
    });

    const m = metrics.computeMetrics(project.id, "main", NOW);
    // passed=2, total(passed+failed)=3 → ratio 2/3. cancelled NOT counted.
    expect(m.verifySuccessRate.passed).toBe(2);
    expect(m.verifySuccessRate.total).toBe(3);
    expect(m.verifySuccessRate.ratio).toBeCloseTo(2 / 3, 10);
  });

  // ── Abandon rate ─────────────────────────────────────────────────

  it("computes abandon rate over the 24h window", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    // 1 abandoned, 2 landed, 1 rejected — all in-window. resolved = 4.
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "abandoned",
      resolvedAt: ago(HOUR),
    });
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "landed",
      resolvedAt: ago(2 * HOUR),
      landedSha: "a",
    });
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "landed",
      resolvedAt: ago(3 * HOUR),
      landedSha: "b",
    });
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "rejected",
      resolvedAt: ago(4 * HOUR),
    });

    const m = metrics.computeMetrics(project.id, "main", NOW);
    expect(m.abandonRate.abandoned).toBe(1);
    expect(m.abandonRate.resolved).toBe(4);
    expect(m.abandonRate.ratio).toBeCloseTo(0.25, 10);
  });

  // ── Pool utilization ─────────────────────────────────────────────

  it("computes pool utilization from the heartbeat row (3/1 → ~0.333)", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    seedHealth(testApp, {
      projectId: project.id,
      integratorId: agent.user.id,
      poolSize: 3,
      poolLeased: 1,
      lastSeenAt: ago(10_000),
    });

    const m = metrics.computeMetrics(project.id, "main", NOW);
    expect(m.poolUtilization.size).toBe(3);
    expect(m.poolUtilization.leased).toBe(1);
    expect(m.poolUtilization.ratio).toBeCloseTo(1 / 3, 10);
  });

  it("pool utilization is null with no heartbeat row", () => {
    const project = createTestProject(testApp.db);
    const m = metrics.computeMetrics(project.id, "main", NOW);
    expect(m.poolUtilization.size).toBeNull();
    expect(m.poolUtilization.leased).toBeNull();
    expect(m.poolUtilization.ratio).toBeNull();
  });

  // ── Empty-data edge (null, NOT NaN) ──────────────────────────────

  it("empty data: queue/in_flight 0, percentiles null + sample 0, rates null, slo overall null", () => {
    const project = createTestProject(testApp.db);
    const m = metrics.computeMetrics(project.id, "main", NOW);

    expect(m.queueDepth).toBe(0);
    expect(m.inFlight).toBe(0);
    expect(m.timeToLand.sampleSize).toBe(0);
    expect(m.timeToLand.p50Ms).toBeNull();
    expect(m.timeToLand.p95Ms).toBeNull();
    expect(m.timeToLand.p99Ms).toBeNull();
    // Divide-by-zero guards: ratio null, not NaN.
    expect(m.verifySuccessRate.ratio).toBeNull();
    expect(m.verifySuccessRate.ratio).not.toBeNaN();
    expect(m.abandonRate.ratio).toBeNull();
    expect(m.abandonRate.ratio).not.toBeNaN();
    expect(m.slo.overallCompliant).toBeNull();
  });

  // ── Queue depth + in-flight counts ───────────────────────────────

  it("counts queue depth and in-flight by status", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    seedRequest(testApp, { projectId: project.id, submittedBy: user.id, status: "queued" });
    seedRequest(testApp, { projectId: project.id, submittedBy: user.id, status: "queued" });
    seedRequest(testApp, { projectId: project.id, submittedBy: user.id, status: "integrating" });

    const m = metrics.computeMetrics(project.id, "main", NOW);
    expect(m.queueDepth).toBe(2);
    expect(m.inFlight).toBe(1);
  });

  // ── SLO compliance from settings ─────────────────────────────────

  it("computes SLO compliance from project settings, omitting null-measured dims", () => {
    const user = createTestUser(testApp.db);
    const project = createTestProject(testApp.db, {
      createdBy: user.id,
      settings: {
        integrator: {
          slo: {
            target_p95_time_to_land_sec: 600, // 10 min
            target_verify_success_rate: 0.9,
            target_abandon_rate: 0.1,
          },
        },
      },
    });

    // One landed request, time-to-land = 5 min → p95 = 5min <= 600s → compliant.
    const resolvedAt = ago(HOUR);
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "landed",
      enqueuedAt: new Date(Date.parse(resolvedAt) - 5 * 60_000).toISOString(),
      resolvedAt,
      landedSha: "x",
    });
    // verify_success_rate has NO completed attempts → measured null → dim omitted.
    // abandon: resolved=1, abandoned=0 → 0 <= 0.1 → compliant.

    const m = metrics.computeMetrics(project.id, "main", NOW);
    expect(m.slo.p95TimeToLand?.compliant).toBe(true);
    expect(m.slo.verifySuccessRate).toBeUndefined(); // omitted, no false red
    expect(m.slo.abandonRate?.compliant).toBe(true);
    expect(m.slo.overallCompliant).toBe(true);
  });

  // ── In-flight composition ────────────────────────────────────────

  it("getInFlight returns integrating members with latest attempt + groupId, plus active groups", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    const formingGroup = seedGroup(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      state: "forming",
    });
    const landedGroup = seedGroup(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      state: "landed", // terminal → excluded
    });

    // ungrouped integrating member with two attempts (latest = #2).
    const ungrouped = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
      pickedUpAt: ago(10 * 60_000),
    });
    seedAttempt(testApp, {
      requestId: ungrouped,
      attemptNumber: 1,
      status: "failed",
      baseSha: "old",
    });
    seedAttempt(testApp, {
      requestId: ungrouped,
      attemptNumber: 2,
      status: "running",
      baseSha: "newbase",
      treeSha: "tree2",
      startedAt: ago(60_000),
    });
    // grouped integrating member (carries groupId).
    const grouped = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
      groupId: formingGroup,
    });
    // a queued request — NOT in-flight.
    seedRequest(testApp, { projectId: project.id, submittedBy: user.id, status: "queued" });

    const inflight = metrics.getInFlight(project.id, "main");

    expect(inflight.members).toHaveLength(2);
    const um = inflight.members.find((m) => m.id === ungrouped)!;
    expect(um.groupId).toBeNull();
    // latest attempt is #2.
    expect(um.attempt?.status).toBe("running");
    expect(um.attempt?.baseSha).toBe("newbase");
    expect(um.attempt?.treeSha).toBe("tree2");

    const gm = inflight.members.find((m) => m.id === grouped)!;
    expect(gm.groupId).toBe(formingGroup);
    expect(gm.attempt).toBeNull(); // no attempt seeded

    // groups: only forming/integrating, NOT the landed one.
    expect(inflight.groups.map((g) => g.id)).toEqual([formingGroup]);
    expect(inflight.groups.map((g) => g.id)).not.toContain(landedGroup);
  });

  // ── STALE EDGE fires via the metrics read (proves getHealth reuse) ─

  it("computeMetrics fires train.integrator_unhealthy ONCE on the stale edge", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    // Stale heartbeat: lastSeenAt = NOW - 120s (> 90s), not yet notified.
    seedHealth(testApp, {
      projectId: project.id,
      integratorId: agent.user.id,
      poolSize: 3,
      poolLeased: 1,
      lastSeenAt: ago(120_000),
      unhealthyNotified: false,
    });

    const calls: string[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_INTEGRATOR_UNHEALTHY, (p) => {
      calls.push(p.entityId as string);
    });

    const m1 = metrics.computeMetrics(project.id, "main", NOW);
    expect(m1.health.healthy).toBe(false);
    expect(calls).toHaveLength(1);

    // Second read while still stale → latched, does NOT re-fire.
    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(1);
  });
});
