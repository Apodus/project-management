import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { createId } from "@pm/shared";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestUser,
  type TestApp,
} from "../utils.js";
import {
  integratorHealth,
  mergeRequests,
  users,
  verifyCache,
} from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";

// ── Helpers ───────────────────────────────────────────────────────

function createMemberToken(testApp: TestApp): string {
  const ts = new Date().toISOString();
  const id = createId();
  const token = `member-token-${id}`;
  testApp.db
    .insert(users)
    .values({
      id,
      username: `member-${id.slice(-6)}`,
      displayName: "Member",
      role: "member",
      type: "human",
      apiTokenHash: bcrypt.hashSync(token, 10),
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return token;
}

function seedRequest(
  testApp: TestApp,
  args: { projectId: string; submittedBy: string; status: string; groupId?: string | null },
): string {
  const id = createId();
  const ts = new Date().toISOString();
  testApp.db
    .insert(mergeRequests)
    .values({
      id,
      projectId: args.projectId,
      resource: "main",
      submittedBy: args.submittedBy,
      taskId: null,
      branch: null,
      commitSha: null,
      verifyCmd: null,
      worktreePath: null,
      groupId: args.groupId ?? null,
      status: args.status,
      enqueuedAt: ts,
      pickedUpAt: null,
      resolvedAt: null,
      landedSha: null,
      rejectCategory: null,
      rejectReason: null,
      failedFiles: null,
      logExcerpt: null,
      logUrl: null,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return id;
}

describe("Train metrics + in-flight routes", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("GET /train/metrics returns 200 for any authenticated (non-admin) user", async () => {
    const project = createTestProject(testApp.db);
    const memberToken = createMemberToken(testApp);

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/train/metrics`,
      { token: memberToken },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.resource).toBe("main");
    expect(body.data.queue_depth).toBe(0);
    expect(body.data.window_hours).toBe(24);
    // snake_case bundle shape.
    expect(body.data).toHaveProperty("verify_success_rate");
    expect(body.data).toHaveProperty("pool_utilization");
    expect(body.data).toHaveProperty("health");
  });

  it("GET /train/metrics requires authentication (401 without token)", async () => {
    const project = createTestProject(testApp.db);
    const res = await testApp.app.request(
      `/api/v1/projects/${project.id}/train/metrics`,
      { method: "GET" },
    );
    expect(res.status).toBe(401);
  });

  it("GET /train/metrics embeds health and fires the stale edge once", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    // Stale heartbeat: 10 minutes old → > 90s, not yet notified.
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    testApp.db
      .insert(integratorHealth)
      .values({
        id: createId(),
        projectId: project.id,
        resource: "main",
        integratorId: agent.user.id,
        status: "idle",
        poolSize: 3,
        poolLeased: 2,
        inFlightRequests: 0,
        inFlightBatches: 0,
        inFlightGroups: 0,
        version: "0.0.0",
        lastSeenAt: stale,
        unhealthyNotified: false,
        createdAt: stale,
        updatedAt: stale,
      })
      .run();

    const calls: string[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_INTEGRATOR_UNHEALTHY, (p) => {
      calls.push(p.entityId as string);
    });

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/train/metrics`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { health: { healthy: boolean }; pool_utilization: { ratio: number } };
    };
    // Health embedded.
    expect(body.data.health.healthy).toBe(false);
    expect(body.data.pool_utilization.ratio).toBeCloseTo(2 / 3, 10);
    // The metrics read fired the stale edge via getHealth.
    expect(calls).toHaveLength(1);

    // A second metrics read does NOT re-fire (latched).
    await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/train/metrics`,
    );
    expect(calls).toHaveLength(1);
  });

  it("GET /train/metrics fires train.stuck on-read for a stuck lane", async () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);

    // A queued request enqueued 11 min ago (> 10 min stuck threshold), nothing
    // integrating, train running → the lane is stuck.
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    testApp.db
      .insert(mergeRequests)
      .values({
        id: createId(),
        projectId: project.id,
        resource: "main",
        submittedBy: user.id,
        taskId: null,
        branch: null,
        commitSha: null,
        verifyCmd: null,
        worktreePath: null,
        groupId: null,
        status: "queued",
        enqueuedAt: old,
        pickedUpAt: null,
        resolvedAt: null,
        landedSha: null,
        rejectCategory: null,
        rejectReason: null,
        failedFiles: null,
        logExcerpt: null,
        logUrl: null,
        createdAt: old,
        updatedAt: old,
      })
      .run();

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.TRAIN_STUCK, (p) => calls.push(p.entity));

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/train/metrics`,
    );
    expect(res.status).toBe(200);
    // The GET fired the stuck alert as a side effect of the on-read evaluation.
    expect(calls).toHaveLength(1);
  });

  it("GET /train/metrics carries the verify block additively (defaults off, existing fields unchanged)", async () => {
    const project = createTestProject(testApp.db);

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/train/metrics`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };

    // The verify block is present with the backward-compat defaults (§10).
    const verify = body.data.verify as {
      cache_enabled: boolean;
      cache_mode: string;
      cache_hit_rate: { ratio: number | null; hits: number; lookups: number };
      time_saved_ms: number;
      per_step: unknown[];
      cache_mismatches: number;
    };
    expect(verify.cache_enabled).toBe(false);
    expect(verify.cache_mode).toBe("off");
    expect(verify.cache_hit_rate.ratio).toBeNull();
    expect(verify.cache_hit_rate.hits).toBe(0);
    expect(verify.cache_hit_rate.lookups).toBe(0);
    expect(verify.time_saved_ms).toBe(0);
    expect(verify.per_step).toEqual([]);
    expect(verify.cache_mismatches).toBe(0);

    // ADDITIVE: every existing 7.4 field is unchanged.
    expect(body.data.resource).toBe("main");
    expect(body.data.queue_depth).toBe(0);
    expect(body.data.window_hours).toBe(24);
    expect(body.data).toHaveProperty("verify_success_rate");
    expect(body.data).toHaveProperty("pool_utilization");
    expect(body.data).toHaveProperty("health");
    expect(body.data).toHaveProperty("slo");
  });

  it("GET /train/metrics derives the verify block from seeded cache rows + settings", async () => {
    const now = new Date().toISOString();
    const project = createTestProject(testApp.db, {
      settings: { integrator: { cache_enabled: true, cache_mode: "on" } },
    });

    function seedCache(o: {
      treeSha: string;
      stepId: string;
      result: "pass" | "fail";
      durationMs: number;
      hitCount: number;
    }) {
      testApp.db
        .insert(verifyCache)
        .values({
          id: createId(),
          projectId: project.id,
          resource: "main",
          treeSha: o.treeSha,
          stepId: o.stepId,
          stepConfigSha: `cfg-${o.treeSha}`,
          result: o.result,
          durationMs: o.durationMs,
          logExcerpt: null,
          logUrl: null,
          // created_at + last_hit_at inside the 24h window (now).
          createdAt: now,
          lastHitAt: now,
          hitCount: o.hitCount,
          updatedAt: now,
        })
        .run();
    }

    // lint: 1 row, 4000ms, 3 hits. unit: 1 row (fail), 9000ms, 2 hits.
    seedCache({ treeSha: "a", stepId: "lint", result: "pass", durationMs: 4000, hitCount: 3 });
    seedCache({ treeSha: "b", stepId: "unit", result: "fail", durationMs: 9000, hitCount: 2 });

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/train/metrics`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        verify: {
          cache_enabled: boolean;
          cache_mode: string;
          cache_hit_rate: { ratio: number; hits: number; lookups: number };
          time_saved_ms: number;
          per_step: {
            step_id: string;
            runs: number;
            cached: number;
            pass_rate: number | null;
            avg_duration_ms: number | null;
            fail_count: number;
          }[];
          cache_mismatches: number;
        };
      };
    };
    const verify = body.data.verify;
    // Settings read off projects.settings.integrator.
    expect(verify.cache_enabled).toBe(true);
    expect(verify.cache_mode).toBe("on");
    // hits = 3 + 2 = 5; misses = 2 rows created in-window → lookups 7.
    expect(verify.cache_hit_rate.hits).toBe(5);
    expect(verify.cache_hit_rate.lookups).toBe(7);
    expect(verify.cache_hit_rate.ratio).toBeCloseTo(5 / 7, 10);
    // time_saved = 3×4000 + 2×9000 = 30000.
    expect(verify.time_saved_ms).toBe(30000);
    // per_step ordered by step_id.
    expect(verify.per_step.map((s) => s.step_id)).toEqual(["lint", "unit"]);
    expect(verify.per_step[0]).toMatchObject({
      step_id: "lint",
      runs: 1,
      cached: 3,
      avg_duration_ms: 4000,
      fail_count: 0,
    });
    expect(verify.per_step[1]).toMatchObject({
      step_id: "unit",
      runs: 1,
      cached: 2,
      fail_count: 1,
    });
    // cache_mismatches surfaced 0 (the non-persisted relay, §9).
    expect(verify.cache_mismatches).toBe(0);
  });

  it("GET /train/in-flight returns { groups, members }", async () => {
    const project = createTestProject(testApp.db);
    const user = createTestUser(testApp.db);
    seedRequest(testApp, {
      projectId: project.id,
      submittedBy: user.id,
      status: "integrating",
    });

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/train/in-flight`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { groups: unknown[]; members: { id: string; group_id: string | null }[] };
    };
    expect(Array.isArray(body.data.groups)).toBe(true);
    expect(body.data.members).toHaveLength(1);
    expect(body.data.members[0].group_id).toBeNull();
  });
});
