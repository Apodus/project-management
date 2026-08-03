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
  mergePhaseTimings,
  mergeRequestGroups,
  mergeRequests,
  mergeResolutions,
  tasks,
} from "../../src/db/index.js";
import type { MergeResolutionDetail } from "@pm/shared";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import * as metrics from "../../src/services/metrics.service.js";

// A fixed reference "now" so the 24h cutoff is deterministic.
const NOW = "2026-05-30T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

const HOUR = 3600_000;
const MIN = 60_000;

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
    taskId?: string | null;
    branch?: string | null;
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
      taskId: args.taskId ?? null,
      branch: args.branch ?? null,
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
    createdAt?: string;
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
      createdAt: args.createdAt ?? ago(HOUR),
      updatedAt: args.createdAt ?? ago(HOUR),
    })
    .run();
  return id;
}

/** A raw merge_phase_timings row (an OBSERVED phase, as the integrator ingests it). */
function seedPhase(
  testApp: TestApp,
  args: {
    projectId: string;
    resource?: string;
    phase: string;
    startedAt: string;
    durationMs: number;
    requestId?: string | null;
    groupId?: string | null;
    label?: string | null;
  },
): string {
  const id = createId();
  testApp.db
    .insert(mergePhaseTimings)
    .values({
      id,
      projectId: args.projectId,
      resource: args.resource ?? "main",
      requestId: args.requestId ?? null,
      groupId: args.groupId ?? null,
      attemptId: null,
      phase: args.phase,
      label: args.label ?? null,
      startedAt: args.startedAt,
      durationMs: args.durationMs,
      detail: null,
      recordedBy: null,
      createdAt: args.startedAt,
    })
    .run();
  return id;
}

function seedResolution(
  testApp: TestApp,
  args: {
    projectId: string;
    resource?: string;
    state: string;
    originRequestId?: string | null;
    resolvedRequestId?: string | null;
    attemptStartedAt?: string | null;
    attemptEndedAt?: string | null;
    escalationTarget?: string | null;
    detail?: MergeResolutionDetail | null;
    createdAt?: string;
  },
): string {
  const id = createId();
  testApp.db
    .insert(mergeResolutions)
    .values({
      id,
      projectId: args.projectId,
      resource: args.resource ?? "main",
      originRequestId: args.originRequestId ?? null,
      resolvedRequestId: args.resolvedRequestId ?? null,
      state: args.state,
      conflictingFiles: null,
      attemptStartedAt: args.attemptStartedAt ?? null,
      attemptEndedAt: args.attemptEndedAt ?? null,
      escalationTarget: args.escalationTarget ?? null,
      detail: args.detail ?? null,
      createdAt: args.createdAt ?? ago(HOUR),
      updatedAt: args.createdAt ?? ago(HOUR),
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
      const enqueuedAt = new Date(Date.parse(resolvedAt) - k * 60_000).toISOString();
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

  it("getInFlight carries the naming inputs (task title / branch) so the dashboard can say what is integrating", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const taskId = createId();
    const ts = new Date().toISOString();
    testApp.db
      .insert(tasks)
      .values({
        id: taskId,
        projectId: project.id,
        title: "Fix grass placement drift",
        reporterId: user.id,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const named = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
      taskId,
      branch: "fix/grass",
    });
    // Task-less: the branch is the name.
    const branchOnly = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
      branch: "chore/no-task",
    });
    // Neither: a synthetic member. The renderer falls back to the id.
    const bare = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
    });

    const inflight = metrics.getInFlight(project.id, "main");
    const byId = new Map(inflight.members.map((m) => [m.id, m]));

    expect(byId.get(named)).toMatchObject({
      taskId,
      taskTitle: "Fix grass placement drift",
      branch: "fix/grass",
    });
    expect(byId.get(branchOnly)).toMatchObject({
      taskId: null,
      taskTitle: null,
      branch: "chore/no-task",
    });
    expect(byId.get(bare)).toMatchObject({ taskId: null, taskTitle: null, branch: null });
  });

  it("a task-less member still appears in flight (the LEFT JOIN must not drop it)", () => {
    // The FK is ON DELETE SET NULL, so a request whose task was deleted
    // mid-flight has taskId null — an inner join here would make it vanish from
    // the dashboard exactly when someone is looking for it.
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
    });

    expect(metrics.getInFlight(project.id, "main").members).toHaveLength(1);
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

  // ── Resolution sub-block (Phase 7.6 §7) ──────────────────────────

  it("computeResolution: attempts, auto-resolve-success, escalation, mean wall-clock, budget utilization against settings", () => {
    // PRECISION NOTE 1 — the budget is read from
    // settings.integrator.resolver.time_budget_sec. A wrong path → the default
    // 600 would still be returned, so we set 600 explicitly AND assert the
    // utilization ratio derived from it (0.5) to prove the read.
    const project = createTestProject(testApp.db, {
      settings: { integrator: { resolver: { time_budget_sec: 600 } } },
    });
    const user = createTestUser(testApp.db);

    // A LANDED request that resolution A points at (counts toward success).
    const landedReq = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "landed",
      resolvedAt: ago(HOUR),
      landedSha: "landedaaa",
    });
    // A NON-landed (rejected) request that resolution B points at.
    const rejectedReq = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "rejected",
      resolvedAt: ago(HOUR),
    });

    // Controlled wall-clocks: 100s, 200s, 300s, 400s → mean 250000ms.
    const mkWindow = (durationMs: number) => {
      const start = ago(2 * HOUR);
      const end = new Date(Date.parse(start) + durationMs).toISOString();
      return { attemptStartedAt: start, attemptEndedAt: end };
    };

    // A: resolved → LANDED request (the one success), 100s, budget 120s.
    seedResolution(testApp, {
      projectId: project.id,
      state: "resolved",
      resolvedRequestId: landedReq,
      ...mkWindow(100_000),
      detail: { budgetConsumedSec: 120 },
    });
    // B: resolved → rejected request (NOT a success), 200s, budget 240s.
    seedResolution(testApp, {
      projectId: project.id,
      state: "resolved",
      resolvedRequestId: rejectedReq,
      ...mkWindow(200_000),
      detail: { budgetConsumedSec: 240 },
    });
    // C: escalated, 300s, budget 360s.
    seedResolution(testApp, {
      projectId: project.id,
      state: "escalated",
      escalationTarget: "author",
      ...mkWindow(300_000),
      detail: { budgetConsumedSec: 360 },
    });
    // D: failed BY THE RECLAIM SWEEP (session_died_or_timeout), 400s, budget
    // 480s. This is the one row reclaimed_count must count.
    seedResolution(testApp, {
      projectId: project.id,
      state: "failed",
      escalationTarget: "human",
      ...mkWindow(400_000),
      detail: { budgetConsumedSec: 480, escalationReason: "session_died_or_timeout" },
    });
    // E: NEGATIVE CONTROL — escalated, but a DIFFERENT escalationReason (a normal
    // verify-fail escalation, NOT a reclaim). Must NOT count toward
    // reclaimed_count. Null timestamps / no budget so it doesn't perturb the
    // wall-clock or budget means (only attempts + escalation counts).
    seedResolution(testApp, {
      projectId: project.id,
      state: "escalated",
      escalationTarget: "author",
      attemptStartedAt: null,
      attemptEndedAt: null,
      detail: { escalationReason: "verify_failed" },
    });

    const m = metrics.computeMetrics(project.id, "main", NOW);
    const r = m.resolution;

    expect(r.attempts).toBe(5);

    // auto-resolve success: only A resolved AND landed → 1/5 = 0.2.
    expect(r.autoResolveSuccessRate.resolvedAndLanded).toBe(1);
    expect(r.autoResolveSuccessRate.attempts).toBe(5);
    expect(r.autoResolveSuccessRate.ratio).toBeCloseTo(0.2, 10);

    // escalation: C + D + E → 3/5 = 0.6.
    expect(r.escalationRate.escalated).toBe(3);
    expect(r.escalationRate.ratio).toBeCloseTo(0.6, 10);

    // mean wall-clock = (100+200+300+400)s / 4 = 250000ms (E excluded: null ts).
    expect(r.meanWallClockMs).toBe(250_000);
    // meanSessionSec = the seconds view of the same wall-clock = 250s.
    expect(r.meanSessionSec).toBe(250);

    // reclaimed_count = exactly D (state failed + session_died_or_timeout). The
    // negative control E (different escalationReason) is NOT counted.
    expect(r.reclaimedCount).toBe(1);

    // budget: mean consumed (120+240+360+480)/4 = 300s; budget 600s → 0.5
    // (E excluded: no budgetConsumedSec).
    expect(r.budgetUtilization.budgetSec).toBe(600);
    expect(r.budgetUtilization.meanConsumedSec).toBe(300);
    expect(r.budgetUtilization.ratio).toBeCloseTo(0.5, 10);
  });

  it("computeResolution: inert (zeros/nulls) when there are no resolutions", () => {
    const project = createTestProject(testApp.db);
    const m = metrics.computeMetrics(project.id, "main", NOW);
    const r = m.resolution;

    expect(r.attempts).toBe(0);
    expect(r.autoResolveSuccessRate.ratio).toBeNull();
    expect(r.escalationRate.ratio).toBeNull();
    expect(r.meanWallClockMs).toBeNull();
    expect(r.meanSessionSec).toBeNull();
    expect(r.reclaimedCount).toBe(0);
    expect(r.budgetUtilization.meanConsumedSec).toBeNull();
    expect(r.budgetUtilization.ratio).toBeNull();
    // Default budget when unset (the shared-schema default).
    expect(r.budgetUtilization.budgetSec).toBe(3600);
  });

  // ── Phase timing (campaign 2026-08-03 §P3) ───────────────────────
  //
  // The through-line: ABSENT ≠ ZERO. Every case below asks either "is the
  // number right" or "is a phase we never measured correctly MISSING rather
  // than rendered as an instant 0 ms bar".

  it("computePhaseTiming: nearest-rank percentiles over a pinned dataset", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    // pickedUpAt stays null so NO derived queue_wait joins the block — this
    // case is about the stored side's arithmetic alone.
    const req = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
    });
    // 10 verify samples of 1..10 minutes.
    for (let k = 1; k <= 10; k++) {
      seedPhase(testApp, {
        projectId: project.id,
        phase: "verify",
        startedAt: ago(2 * HOUR),
        durationMs: k * MIN,
        requestId: req,
      });
    }

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    expect(w.phases).toHaveLength(1);
    const verify = w.phases[0];
    expect(verify.phase).toBe("verify");
    expect(verify.count).toBe(10);
    // nearest-rank n=10 (the SAME helper as time-to-land): p50 idx 4 → 5min,
    // p95 idx 9 → 10min.
    expect(verify.p50Ms).toBe(5 * MIN);
    expect(verify.p95Ms).toBe(10 * MIN);
    expect(verify.maxMs).toBe(10 * MIN);
    expect(verify.totalMs).toBe(55 * MIN);
    expect(w.totalMeasuredMs).toBe(55 * MIN);
    expect(w.sampleSize).toBe(10);
    expect(w.entityCount).toBe(1);
    // Sole phase ⇒ the whole share.
    expect(verify.share).toBe(1);
  });

  it("computePhaseTiming: excludes a phase started 25h ago, includes one started 23h ago", () => {
    const project = createTestProject(testApp.db);
    seedPhase(testApp, {
      projectId: project.id,
      phase: "verify",
      startedAt: ago(25 * HOUR),
      durationMs: 9 * MIN,
    });
    seedPhase(testApp, {
      projectId: project.id,
      phase: "verify",
      startedAt: ago(23 * HOUR),
      durationMs: 3 * MIN,
    });

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    expect(w.sampleSize).toBe(1);
    expect(w.phases[0].totalMs).toBe(3 * MIN);
  });

  it("computePhaseTiming: a phase that SPANS the cutoff is excluded (start-in-window, not end)", () => {
    // Started 25h ago, ran 2h, therefore ENDED inside the window. P1's rule is
    // start-in-window — deliberately UNLIKE computeTimeToLand, which windows on
    // resolvedAt. Pinned here so the two rules can't be "unified" by accident:
    // a phase is attributed to when the work began, so a long verify does not
    // teleport into the window it finished in.
    const project = createTestProject(testApp.db);
    seedPhase(testApp, {
      projectId: project.id,
      phase: "verify",
      startedAt: ago(25 * HOUR),
      durationMs: 2 * HOUR,
    });

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    expect(w.phases).toEqual([]);
    expect(w.sampleSize).toBe(0);
  });

  it("computePhaseTiming: a phase started AFTER now is excluded (skewed daemon clock)", () => {
    const project = createTestProject(testApp.db);
    seedPhase(testApp, {
      projectId: project.id,
      phase: "verify",
      startedAt: new Date(NOW_MS + 5 * MIN).toISOString(),
      durationMs: MIN,
    });
    seedPhase(testApp, {
      projectId: project.id,
      phase: "verify",
      startedAt: ago(MIN),
      durationMs: 2 * MIN,
    });

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    expect(w.sampleSize).toBe(1);
    expect(w.totalMeasuredMs).toBe(2 * MIN);
  });

  it("computePhaseTiming: scopes to the lane", () => {
    const project = createTestProject(testApp.db);
    seedPhase(testApp, {
      projectId: project.id,
      resource: "release",
      phase: "verify",
      startedAt: ago(MIN),
      durationMs: 7 * MIN,
    });

    expect(metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window.phases).toEqual([]);
    const release = metrics.computeMetrics(project.id, "release", NOW).phaseTiming.window;
    expect(release.phases).toHaveLength(1);
    expect(release.totalMeasuredMs).toBe(7 * MIN);
  });

  it("computePhaseTiming: degrades honestly to an EMPTY block with no data", () => {
    const project = createTestProject(testApp.db);
    const pt = metrics.computeMetrics(project.id, "main", NOW).phaseTiming;
    // `phases: []` + sample_size 0 IS the "no data yet" predicate — no
    // zero-filled skeleton of seven phases that would read as instant work.
    expect(pt.window.phases).toHaveLength(0);
    expect(pt.window.totalMeasuredMs).toBe(0);
    expect(pt.window.sampleSize).toBe(0);
    expect(pt.window.entityCount).toBe(0);
    expect(pt.recent).toEqual(pt.window);
    expect(pt.recentLimit).toBeGreaterThan(0);
  });

  it("computePhaseTiming: day one (P2 not deployed) shows ONLY the derived phases", () => {
    // Real traffic, zero stored rows. The honest shape is [forming, queue_wait]
    // with the five OBSERVED phases absent — their absence is the signal that
    // the integrator isn't instrumented yet, the opposite of five 0 ms bars.
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const group = seedGroup(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      state: "integrating",
      createdAt: ago(2 * HOUR),
    });
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
      groupId: group,
      enqueuedAt: ago(2 * HOUR),
      pickedUpAt: ago(HOUR),
    });

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    expect(w.phases.map((p) => p.phase)).toEqual(["forming", "queue_wait"]);
    for (const observed of ["assemble", "materialize", "rebase", "verify", "land"]) {
      expect(w.phases.some((p) => p.phase === observed)).toBe(false);
    }
  });

  it("computePhaseTiming: one opaque verify step yields ONE stat with NO label breakdown", () => {
    // game_one today: a single pm-verify.bat. PM cannot see inside one shell
    // command, so no generate/build/test split exists ANYWHERE in the payload.
    const project = createTestProject(testApp.db);
    for (const d of [10 * MIN, 30 * MIN]) {
      seedPhase(testApp, {
        projectId: project.id,
        phase: "verify",
        startedAt: ago(HOUR),
        durationMs: d,
      });
    }

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    expect(w.phases).toHaveLength(1);
    expect(w.phases[0].labels).toEqual([]);
    expect(w.phases[0].totalMs).toBe(40 * MIN);
  });

  it("computePhaseTiming: labelled verify steps split by label, biggest first, summing exactly", () => {
    const project = createTestProject(testApp.db);
    const steps: Array<[string, number]> = [
      ["generate", 1 * MIN],
      ["build", 18 * MIN],
      ["test", 7 * MIN],
    ];
    for (const [label, durationMs] of steps) {
      seedPhase(testApp, {
        projectId: project.id,
        phase: "verify",
        startedAt: ago(HOUR),
        durationMs,
        label,
      });
    }

    const verify = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window.phases[0];
    expect(verify.labels.map((l) => l.label)).toEqual(["build", "test", "generate"]);
    // The EXACT invariant is on integers; shares are floating point and are
    // asserted approximately (Σ of exactly-equal shares is famously ≠ 1).
    expect(verify.labels.reduce((s, l) => s + l.totalMs, 0)).toBe(verify.totalMs);
    expect(verify.labels.reduce((s, l) => s + (l.share ?? 0), 0)).toBeCloseTo(1, 10);
    expect(verify.labels[0].share).toBeCloseTo(18 / 26, 10);
  });

  it("computePhaseTiming: MIXED labelling keeps the integer sum invariant via a null bucket", () => {
    const project = createTestProject(testApp.db);
    seedPhase(testApp, {
      projectId: project.id,
      phase: "verify",
      startedAt: ago(HOUR),
      durationMs: 4 * MIN,
      label: "build",
    });
    seedPhase(testApp, {
      projectId: project.id,
      phase: "verify",
      startedAt: ago(HOUR),
      durationMs: 6 * MIN,
    });

    const verify = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window.phases[0];
    // The unlabelled remainder is its OWN bucket, so the split still accounts
    // for the whole phase; it sorts last so a real step never hides behind it.
    expect(verify.labels.map((l) => l.label)).toEqual([null, "build"]);
    expect(verify.labels.reduce((s, l) => s + l.totalMs, 0)).toBe(verify.totalMs);
  });

  it("computePhaseTiming: share is totalMs / totalMeasuredMs, and sums to ~1", () => {
    const project = createTestProject(testApp.db);
    seedPhase(testApp, {
      projectId: project.id,
      phase: "assemble",
      startedAt: ago(HOUR),
      durationMs: 3 * MIN,
    });
    seedPhase(testApp, {
      projectId: project.id,
      phase: "verify",
      startedAt: ago(HOUR),
      durationMs: 9 * MIN,
    });

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    expect(w.totalMeasuredMs).toBe(12 * MIN);
    expect(w.phases.reduce((s, p) => s + p.totalMs, 0)).toBe(w.totalMeasuredMs);
    expect(w.phases.find((p) => p.phase === "assemble")!.share).toBeCloseTo(0.25, 10);
    expect(w.phases.find((p) => p.phase === "verify")!.share).toBeCloseTo(0.75, 10);
    expect(w.phases.reduce((s, p) => s + (p.share ?? 0), 0)).toBeCloseTo(1, 10);
  });

  it("computePhaseTiming: the group forming/queue_wait overlap is DELIBERATE, not double-counting to fix", () => {
    // Group created 30m ago, members picked up 25m and 20m ago. The pre-pickup
    // interval [-30m, -25m] is covered by forming AND by BOTH queue_waits — i.e.
    // 1 + memberCount times, by construction. That is the honest answer to two
    // DIFFERENT questions ("how long until the train touched this group" vs "how
    // long did THIS member wait"), so totalMeasuredMs is summed measured phase
    // time, NOT elapsed wall clock (which is only 10m here). An interval union
    // would delete one of the two answers.
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const group = seedGroup(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      state: "integrating",
      createdAt: ago(30 * MIN),
    });
    for (const pickup of [25, 20]) {
      seedRequest(testApp, {
        projectId: project.id,
        submittedBy: user.id,
        status: "integrating",
        groupId: group,
        enqueuedAt: ago(30 * MIN),
        pickedUpAt: ago(pickup * MIN),
      });
    }

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    const forming = w.phases.find((p) => p.phase === "forming")!;
    const queue = w.phases.find((p) => p.phase === "queue_wait")!;
    expect(forming.count).toBe(1);
    expect(forming.totalMs).toBe(5 * MIN);
    expect(queue.count).toBe(2);
    expect(queue.totalMs).toBe(15 * MIN); // 5m + 10m
    // 20m of measured phase time over 10m of wall clock — deliberate.
    expect(w.totalMeasuredMs).toBe(20 * MIN);
    // …and the group + its two members are ONE trip.
    expect(w.entityCount).toBe(1);
  });

  it("computePhaseTiming: concurrent verifies are BOTH counted in full", () => {
    // The second overlap source: at parallelism > 1 (or across a group's two
    // repos) two verifies really do run at once. Each is charged in full — the
    // question "how long does verify take" is about the work, not the clock.
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const group = seedGroup(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      state: "integrating",
      createdAt: ago(2 * HOUR),
    });
    for (const label of ["inner", "outer"]) {
      seedPhase(testApp, {
        projectId: project.id,
        phase: "verify",
        startedAt: ago(HOUR),
        durationMs: 26 * MIN,
        groupId: group,
        label,
      });
    }

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    expect(w.phases[0].count).toBe(2);
    expect(w.phases[0].maxMs).toBe(26 * MIN);
    expect(w.totalMeasuredMs).toBe(52 * MIN);
  });

  it("computePhaseTiming: all-zero durations keep the phases PRESENT with a null share", () => {
    // The pathological case that would make absent-vs-zero ambiguous if a phase
    // with no samples were zero-filled: real observations that each took ~0ms.
    // They are present with count > 0; share is null (the repo's
    // ratio-with-zero-denominator idiom), never a 0/0 NaN.
    const project = createTestProject(testApp.db);
    seedPhase(testApp, {
      projectId: project.id,
      phase: "land",
      startedAt: ago(MIN),
      durationMs: 0,
    });
    seedPhase(testApp, {
      projectId: project.id,
      phase: "rebase",
      startedAt: ago(MIN),
      durationMs: 0,
    });

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    expect(w.phases.map((p) => p.phase)).toEqual(["rebase", "land"]);
    expect(w.phases.every((p) => p.count === 1 && p.totalMs === 0)).toBe(true);
    expect(w.phases.every((p) => p.share === null)).toBe(true);
    expect(w.totalMeasuredMs).toBe(0);
  });

  it("computePhaseTiming: derived + stored CONCATENATE, and no phase appears twice", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const req = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
      enqueuedAt: ago(2 * HOUR),
      pickedUpAt: ago(90 * MIN),
    });
    seedPhase(testApp, {
      projectId: project.id,
      phase: "verify",
      startedAt: ago(80 * MIN),
      durationMs: 12 * MIN,
      requestId: req,
    });

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    expect(w.phases.map((p) => p.phase)).toEqual(["queue_wait", "verify"]);
    expect(new Set(w.phases.map((p) => p.phase)).size).toBe(w.phases.length);
    expect(w.phases[0].totalMs).toBe(30 * MIN); // the queue segment
    expect(w.sampleSize).toBe(2);
    // The request is ONE trip, whichever source its samples came from.
    expect(w.entityCount).toBe(1);
  });

  it("computePhaseTiming: a requeued queue_wait aggregates the LAST segment, not the origin span", () => {
    // Submit 44m ago → a prior integration ended 5m ago → picked up now. The
    // honest queue segment is 5m; originDurationMs (44m) is DELIBERATELY not
    // aggregated — it would fold the prior 39-minute verify back into "queue
    // wait", the exact dishonesty this campaign removes.
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const req = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
      enqueuedAt: ago(44 * MIN),
      pickedUpAt: NOW,
    });
    seedAttempt(testApp, {
      requestId: req,
      status: "failed",
      startedAt: ago(44 * MIN),
      completedAt: ago(5 * MIN),
    });

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    const queue = w.phases.find((p) => p.phase === "queue_wait")!;
    expect(queue.totalMs).toBe(5 * MIN);
    expect(queue.maxMs).toBe(5 * MIN);
  });

  it("computePhaseTiming: renders in PIPELINE order regardless of seed order", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const group = seedGroup(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      state: "integrating",
      createdAt: ago(3 * HOUR),
    });
    const req = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
      groupId: group,
      enqueuedAt: ago(3 * HOUR),
      pickedUpAt: ago(2 * HOUR),
    });
    // Scrambled on purpose — and deliberately NOT alphabetical either way.
    for (const phase of ["land", "verify", "rebase", "materialize", "assemble"]) {
      seedPhase(testApp, {
        projectId: project.id,
        phase,
        startedAt: ago(HOUR),
        durationMs: MIN,
        requestId: req,
      });
    }

    const w = metrics.computeMetrics(project.id, "main", NOW).phaseTiming.window;
    expect(w.phases.map((p) => p.phase)).toEqual([
      "forming",
      "queue_wait",
      "assemble",
      "materialize",
      "rebase",
      "verify",
      "land",
    ]);
  });

  it("computePhaseTiming: `recent` counts TRIPS — a 2-member group is ONE", () => {
    // 20 solo requests + one 2-member group = 21 TRIPS but 22 request entities.
    // Keyed on the entity, `recent` would report 20 subjects / 20 samples and a
    // cross-repo lane's "last 20" would silently be ~10 real merges.
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    for (let k = 1; k <= 20; k++) {
      const solo = seedRequest(testApp, {
        projectId: project.id,
        submittedBy: user.id,
        status: "integrating",
        enqueuedAt: ago(k * HOUR),
      });
      seedPhase(testApp, {
        projectId: project.id,
        phase: "verify",
        startedAt: ago(k * HOUR),
        durationMs: MIN,
        requestId: solo,
      });
    }
    // The newest trip: a group whose TWO members each recorded a verify.
    const group = seedGroup(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      state: "integrating",
      createdAt: ago(20 * MIN),
    });
    for (let i = 0; i < 2; i++) {
      const member = seedRequest(testApp, {
        projectId: project.id,
        submittedBy: user.id,
        status: "integrating",
        groupId: group,
        enqueuedAt: ago(20 * MIN),
      });
      seedPhase(testApp, {
        projectId: project.id,
        phase: "verify",
        startedAt: ago(10 * MIN),
        durationMs: MIN,
        requestId: member,
      });
    }

    const pt = metrics.computeMetrics(project.id, "main", NOW).phaseTiming;
    expect(pt.recentLimit).toBe(20);
    expect(pt.window.entityCount).toBe(21);
    expect(pt.window.sampleSize).toBe(22);
    // The newest 20 trips = the group (1) + the 19 newest solos; the 20h-old
    // solo falls off. The group contributes ONE subject and TWO samples — the
    // proof the fold happened.
    expect(pt.recent.entityCount).toBe(20);
    expect(pt.recent.sampleSize).toBe(21);
  });

  it("computePhaseTiming: below the limit, `recent` IS the window", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    const req = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
      enqueuedAt: ago(2 * HOUR),
      pickedUpAt: ago(HOUR),
    });
    seedPhase(testApp, {
      projectId: project.id,
      phase: "verify",
      startedAt: ago(30 * MIN),
      durationMs: 8 * MIN,
      requestId: req,
    });

    const pt = metrics.computeMetrics(project.id, "main", NOW).phaseTiming;
    expect(pt.recent).toEqual(pt.window);
  });
});
