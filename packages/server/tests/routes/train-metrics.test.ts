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
