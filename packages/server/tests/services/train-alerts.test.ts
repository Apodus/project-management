import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  createTestApp,
  createTestProject,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { mergeRequests, trainState } from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import * as metrics from "../../src/services/metrics.service.js";
import * as trainSvc from "../../src/services/train.service.js";
import type { Actor } from "../../src/services/merge-request.service.js";

// Fixed reference "now" so windows + ages are deterministic.
const NOW = "2026-05-30T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const HOUR = 3600_000;
const MIN = 60_000;

function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function adminActor(testApp: TestApp): Actor {
  return {
    id: testApp.testUser.id,
    role: testApp.testUser.role,
    type: testApp.testUser.type,
  };
}

function seedRequest(
  testApp: TestApp,
  args: {
    projectId: string;
    submittedBy: string;
    resource?: string;
    status: string;
    enqueuedAt?: string;
    resolvedAt?: string | null;
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
      groupId: null,
      status: args.status,
      enqueuedAt: args.enqueuedAt ?? ago(HOUR),
      pickedUpAt: null,
      resolvedAt: args.resolvedAt ?? null,
      landedSha: null,
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

function readLatch(testApp: TestApp, projectId: string) {
  return testApp.db
    .select()
    .from(trainState)
    .where(eq(trainState.projectId, projectId))
    .get();
}

describe("train on-read alerts (§7.3)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── STUCK: fire once, latch, reset on clear, re-fire ──────────────

  it("train.stuck fires ONCE, latches, resets on clear, and re-fires", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    // A queued request enqueued 11 min ago (> 10 min threshold), nothing
    // integrating, train running (lazy-created running).
    const reqId = seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "queued",
      enqueuedAt: ago(11 * MIN),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_STUCK, (p) => calls.push(p.entity));

    // First read → fires once + latches stuckNotified.
    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { oldestQueuedAgeMs: number }).oldestQueuedAgeMs).toBe(
      11 * MIN,
    );
    expect(readLatch(testApp, project.id)?.stuckNotified).toBe(true);

    // Second read while still stuck → latched, does NOT re-fire.
    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(1);

    // Drain the queue (land the request) → condition clears → latch resets.
    testApp.db
      .update(mergeRequests)
      .set({ status: "landed", resolvedAt: NOW })
      .where(eq(mergeRequests.id, reqId))
      .run();
    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(1); // no new fire
    expect(readLatch(testApp, project.id)?.stuckNotified).toBe(false);

    // Re-stick: a fresh old queued request → re-fires.
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "queued",
      enqueuedAt: ago(11 * MIN),
    });
    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(2);
    expect(readLatch(testApp, project.id)?.stuckNotified).toBe(true);
  });

  it("does NOT fire train.stuck when something is integrating (inFlight > 0)", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "queued",
      enqueuedAt: ago(11 * MIN),
    });
    // An integrating request → inFlight === 1 → the queue IS draining.
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
      enqueuedAt: ago(2 * MIN),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_STUCK, (p) => calls.push(p.entity));

    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(0);
    expect(readLatch(testApp, project.id)?.stuckNotified).toBe(false);
  });

  it("does NOT fire train.stuck when the oldest queued is younger than the threshold", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "queued",
      enqueuedAt: ago(5 * MIN), // < 10 min
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_STUCK, (p) => calls.push(p.entity));

    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(0);
  });

  // ── PAUSED guard (the folded recommendation) ──────────────────────

  it("does NOT fire train.stuck when the train is PAUSED (held, not stuck)", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "queued",
      enqueuedAt: ago(11 * MIN),
    });
    // Pause the lane — a deliberately held train is not stuck.
    trainSvc.pause(project.id, "main", adminActor(testApp), "draining");

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_STUCK, (p) => calls.push(p.entity));

    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(0);
    expect(readLatch(testApp, project.id)?.stuckNotified).toBe(false);
  });

  // ── The latch UPDATE touches ONLY the latch column (NOTE 1) ───────

  it("a metrics read that resets the stuck latch PRESERVES the pause state", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    // Stick the lane, fire + latch while running.
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "queued",
      enqueuedAt: ago(11 * MIN),
    });
    metrics.computeMetrics(project.id, "main", NOW);
    expect(readLatch(testApp, project.id)?.stuckNotified).toBe(true);

    // Now pause (writes state/changedBy/reason).
    trainSvc.pause(project.id, "main", adminActor(testApp), "draining");
    const paused = readLatch(testApp, project.id);
    expect(paused?.state).toBe("paused");
    expect(paused?.changedBy).toBe(testApp.testUser.id);
    expect(paused?.reason).toBe("draining");

    // A metrics read now: the paused guard means !fireStuck, so it resets the
    // stuck latch. That single-column UPDATE must NOT clobber the pause.
    metrics.computeMetrics(project.id, "main", NOW);
    const after = readLatch(testApp, project.id);
    expect(after?.stuckNotified).toBe(false); // latch reset
    expect(after?.state).toBe("paused"); // pause preserved
    expect(after?.changedBy).toBe(testApp.testUser.id);
    expect(after?.reason).toBe("draining");
  });

  // ── ABANDON: min-sample, fire once, reset ─────────────────────────

  it("train.abandon_rate_high fires ONCE when ratio > 0.3 with resolved >= 5", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    // 6 resolved within 24h: 3 abandoned, 2 landed, 1 rejected → ratio 3/6=0.5.
    const within = ago(2 * HOUR);
    for (let i = 0; i < 3; i++) {
      seedRequest(testApp, {
        projectId: project.id,
        submittedBy: user.id,
        status: "abandoned",
        resolvedAt: within,
      });
    }
    for (let i = 0; i < 2; i++) {
      seedRequest(testApp, {
        projectId: project.id,
        submittedBy: user.id,
        status: "landed",
        resolvedAt: within,
      });
    }
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "rejected",
      resolvedAt: within,
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_ABANDON_RATE_HIGH, (p) =>
      calls.push(p.entity),
    );

    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { resolved: number }).resolved).toBe(6);
    expect(readLatch(testApp, project.id)?.abandonNotified).toBe(true);

    // Second read → latched.
    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(1);
  });

  it("does NOT fire train.abandon_rate_high below the min sample (resolved < 5)", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    // 1 abandoned of 1 resolved → ratio 1.0 but sample 1 < 5.
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "abandoned",
      resolvedAt: ago(2 * HOUR),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_ABANDON_RATE_HIGH, (p) =>
      calls.push(p.entity),
    );

    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(0);
    expect(readLatch(testApp, project.id)?.abandonNotified).toBe(false);
  });

  it("resets the abandon latch when the ratio drops below the threshold", () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    const within = ago(2 * HOUR);
    const abandonedIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      abandonedIds.push(
        seedRequest(testApp, {
          projectId: project.id,
          submittedBy: user.id,
          status: "abandoned",
          resolvedAt: within,
        }),
      );
    }
    for (let i = 0; i < 3; i++) {
      seedRequest(testApp, {
        projectId: project.id,
        submittedBy: user.id,
        status: "landed",
        resolvedAt: within,
      });
    }

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_ABANDON_RATE_HIGH, (p) =>
      calls.push(p.entity),
    );

    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(1);
    expect(readLatch(testApp, project.id)?.abandonNotified).toBe(true);

    // Flip the abandoned to landed → ratio 0/6 → clears.
    for (const id of abandonedIds) {
      testApp.db
        .update(mergeRequests)
        .set({ status: "landed" })
        .where(eq(mergeRequests.id, id))
        .run();
    }
    metrics.computeMetrics(project.id, "main", NOW);
    expect(calls).toHaveLength(1); // no new fire
    expect(readLatch(testApp, project.id)?.abandonNotified).toBe(false);
  });
});

// ── Discord outbound listener (half (b)) ────────────────────────────

describe("webhook alert listener (Discord, §7.2)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    // createTestApp() boots the app, which registers the webhook alert
    // listener via initializeEventListeners — no manual registration needed.
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function baseSettings(webhooks: Record<string, unknown>) {
    return {
      ai_autonomy: {
        can_self_assign: true,
        can_create_subtasks: true,
        can_create_tasks: true,
        can_change_priority: true,
        can_close_epics: true,
        max_concurrent_tasks: 3,
      },
      workflow: { statuses: ["backlog", "done"] },
      git: { branch_prefix: "feat/", auto_link_branches: true },
      webhooks,
    };
  }

  it("POSTs to the discord_url with a { content } body on a train alert", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const url = "https://discord.com/api/webhooks/1/abc";
    const project = createTestProject(testApp.db, {
      settings: baseSettings({ discord_url: url, alerts_enabled: true }),
    });

    getEventBus().emit(EVENT_NAMES.TRAIN_STUCK, {
      entity: { resource: "main", oldestQueuedAgeMs: 11 * MIN, queueDepth: 1 },
      entityType: "train",
      entityId: "main",
      projectId: project.id,
      actorId: null,
      timestamp: NOW,
    });

    // Let the un-awaited delivery promise settle.
    await new Promise((r) => setImmediate(r));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, opts] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(url);
    const body = JSON.parse((opts as { body: string }).body);
    expect(typeof body.content).toBe("string");
    expect(body.content).toContain("stuck");
  });

  it("does NOT POST when alerts_enabled === false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const project = createTestProject(testApp.db, {
      settings: baseSettings({
        discord_url: "https://discord.com/api/webhooks/1/abc",
        alerts_enabled: false,
      }),
    });

    getEventBus().emit(EVENT_NAMES.TRAIN_ABANDON_RATE_HIGH, {
      entity: { resource: "main", ratio: 0.5, resolved: 6 },
      entityType: "train",
      entityId: "main",
      projectId: project.id,
      actorId: null,
      timestamp: NOW,
    });
    await new Promise((r) => setImmediate(r));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT POST when there is no discord_url configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const project = createTestProject(testApp.db, {
      settings: baseSettings({ alerts_enabled: true }),
    });

    getEventBus().emit(EVENT_NAMES.TRAIN_STUCK, {
      entity: { resource: "main", oldestQueuedAgeMs: 11 * MIN, queueDepth: 1 },
      entityType: "train",
      entityId: "main",
      projectId: project.id,
      actorId: null,
      timestamp: NOW,
    });
    await new Promise((r) => setImmediate(r));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a Discord POST failure — emit does not throw, no unhandled rejection", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = createTestProject(testApp.db, {
      settings: baseSettings({
        discord_url: "https://discord.com/api/webhooks/1/abc",
        alerts_enabled: true,
      }),
    });

    // The emit itself must NOT throw despite the fetch rejecting.
    expect(() =>
      getEventBus().emit(EVENT_NAMES.TRAIN_STUCK, {
        entity: { resource: "main", oldestQueuedAgeMs: 11 * MIN, queueDepth: 1 },
        entityType: "train",
        entityId: "main",
        projectId: project.id,
        actorId: null,
        timestamp: NOW,
      }),
    ).not.toThrow();

    // Allow the rejected promise + .catch to settle (no unhandled rejection).
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("computeMetrics returns normally even when the Discord POST rejects (on-read path stays alive)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = createTestProject(testApp.db, {
      settings: baseSettings({
        discord_url: "https://discord.com/api/webhooks/1/abc",
        alerts_enabled: true,
      }),
    });
    const user = createTestUser(testApp.db);
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "queued",
      enqueuedAt: ago(11 * MIN),
    });

    const bundle = metrics.computeMetrics(project.id, "main", NOW);
    expect(bundle.queueDepth).toBe(1);
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1); // the stuck alert tried to POST
  });
});
