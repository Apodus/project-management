import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { createId } from "@pm/shared";
import {
  authRequest,
  createTestAiAgent,
  createTestProject,
  createTestApp,
  type TestApp,
} from "../utils.js";
import { users, verifyCache } from "../../src/db/index.js";
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

function seedRow(
  testApp: TestApp,
  o: {
    projectId: string;
    resource?: string;
    treeSha: string;
    stepId?: string;
    stepConfigSha?: string;
    result?: "pass" | "fail";
    createdAt: string;
  },
): void {
  testApp.db
    .insert(verifyCache)
    .values({
      id: createId(),
      projectId: o.projectId,
      resource: o.resource ?? "main",
      treeSha: o.treeSha,
      stepId: o.stepId ?? "lint",
      stepConfigSha: o.stepConfigSha ?? "cfg",
      result: o.result ?? "pass",
      durationMs: 1000,
      logExcerpt: null,
      logUrl: null,
      createdAt: o.createdAt,
      lastHitAt: null,
      hitCount: 0,
      updatedAt: o.createdAt,
    })
    .run();
}

describe("Verify-cache routes", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Debug GET (requireAuth) ──────────────────────────────────────

  it("GET /verify-cache returns 200 for any authenticated (non-admin) member", async () => {
    const project = createTestProject(testApp.db);
    const memberToken = createMemberToken(testApp);
    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/verify-cache`,
      { token: memberToken },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      pagination: { total: number; page: number; perPage: number };
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination.total).toBe(0);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.perPage).toBe(50);
  });

  it("GET /verify-cache requires authentication (401 without token)", async () => {
    const project = createTestProject(testApp.db);
    const res = await testApp.app.request(`/api/v1/projects/${project.id}/verify-cache`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });

  it("GET /verify-cache returns newest-first, honors filters + pagination", async () => {
    const project = createTestProject(testApp.db);
    seedRow(testApp, {
      projectId: project.id,
      treeSha: "t-old",
      stepId: "lint",
      result: "pass",
      createdAt: "2026-05-30T10:00:00.000Z",
    });
    seedRow(testApp, {
      projectId: project.id,
      treeSha: "t-new",
      stepId: "unit",
      result: "fail",
      createdAt: "2026-05-30T12:00:00.000Z",
    });
    seedRow(testApp, {
      projectId: project.id,
      treeSha: "t-hotfix",
      resource: "hotfix",
      createdAt: "2026-05-30T11:00:00.000Z",
    });

    // Newest-first (t-new before t-old), all 3 rows.
    const all = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/verify-cache`,
    );
    const allBody = (await all.json()) as {
      data: { treeSha: string }[];
      pagination: { total: number };
    };
    expect(allBody.pagination.total).toBe(3);
    expect(allBody.data[0].treeSha).toBe("t-new");
    expect(allBody.data[1].treeSha).toBe("t-hotfix");
    expect(allBody.data[2].treeSha).toBe("t-old");

    // Filter by resource.
    const main = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/verify-cache?resource=main`,
    );
    const mainBody = (await main.json()) as { pagination: { total: number } };
    expect(mainBody.pagination.total).toBe(2);

    // Filter by step_id + result.
    const filtered = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/verify-cache?step_id=unit&result=fail`,
    );
    const filteredBody = (await filtered.json()) as {
      data: { treeSha: string }[];
      pagination: { total: number };
    };
    expect(filteredBody.pagination.total).toBe(1);
    expect(filteredBody.data[0].treeSha).toBe("t-new");

    // Pagination: perPage=1, page=2 → the second-newest row.
    const page2 = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/verify-cache?perPage=1&page=2`,
    );
    const page2Body = (await page2.json()) as {
      data: { treeSha: string }[];
      pagination: { total: number; page: number; perPage: number };
    };
    expect(page2Body.pagination.total).toBe(3);
    expect(page2Body.pagination.page).toBe(2);
    expect(page2Body.pagination.perPage).toBe(1);
    expect(page2Body.data).toHaveLength(1);
    expect(page2Body.data[0].treeSha).toBe("t-hotfix");
  });

  // ── lookup (ai_agent-gated) ──────────────────────────────────────

  it("POST /verify-cache/lookup MISS returns data:null for an unseeded key", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/verify-cache/lookup`,
      {
        token: agent.token,
        body: { treeSha: "t-x", stepId: "lint", stepConfigSha: "cfg-1" },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    expect(body.data).toBeNull();
  });

  it("POST /verify-cache/lookup HIT returns the row + bumps hit_count server-side", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    // Record first.
    const rec = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/verify-cache/record`,
      {
        token: agent.token,
        body: {
          treeSha: "t-hit",
          stepId: "lint",
          stepConfigSha: "cfg-1",
          result: "pass",
          durationMs: 4200,
        },
      },
    );
    expect(rec.status).toBe(200);

    // Lookup → HIT, hit_count bumped to 1.
    const hit = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/verify-cache/lookup`,
      {
        token: agent.token,
        body: { treeSha: "t-hit", stepId: "lint", stepConfigSha: "cfg-1" },
      },
    );
    const hitBody = (await hit.json()) as {
      data: { result: string; durationMs: number; hitCount: number };
    };
    expect(hitBody.data).not.toBeNull();
    expect(hitBody.data.result).toBe("pass");
    expect(hitBody.data.durationMs).toBe(4200);
    expect(hitBody.data.hitCount).toBe(1);

    // A second lookup → hit_count 2 (server-side bump observable).
    const hit2 = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/verify-cache/lookup`,
      {
        token: agent.token,
        body: { treeSha: "t-hit", stepId: "lint", stepConfigSha: "cfg-1" },
      },
    );
    const hit2Body = (await hit2.json()) as { data: { hitCount: number } };
    expect(hit2Body.data.hitCount).toBe(2);
  });

  it("POST /verify-cache/lookup returns 403 for a non-ai_agent caller", async () => {
    const project = createTestProject(testApp.db);
    const memberToken = createMemberToken(testApp);
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/verify-cache/lookup`,
      {
        token: memberToken,
        body: { treeSha: "t", stepId: "lint", stepConfigSha: "cfg" },
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  // ── record (ai_agent-gated) ──────────────────────────────────────

  it("POST /verify-cache/record writes a verdict a subsequent lookup returns", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    const rec = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/verify-cache/record`,
      {
        token: agent.token,
        body: {
          treeSha: "t-rec",
          stepId: "unit",
          stepConfigSha: "cfg-9",
          result: "fail",
          durationMs: 9000,
          logExcerpt: "boom",
        },
      },
    );
    expect(rec.status).toBe(200);
    const recBody = (await rec.json()) as { data: { result: string } };
    expect(recBody.data.result).toBe("fail");

    const hit = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/verify-cache/lookup`,
      {
        token: agent.token,
        body: { treeSha: "t-rec", stepId: "unit", stepConfigSha: "cfg-9" },
      },
    );
    const hitBody = (await hit.json()) as {
      data: { result: string; durationMs: number; logExcerpt: string };
    };
    expect(hitBody.data.result).toBe("fail");
    expect(hitBody.data.durationMs).toBe(9000);
    expect(hitBody.data.logExcerpt).toBe("boom");
  });

  it("POST /verify-cache/record returns 403 for a non-ai_agent caller", async () => {
    const project = createTestProject(testApp.db);
    const memberToken = createMemberToken(testApp);
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/verify-cache/record`,
      {
        token: memberToken,
        body: {
          treeSha: "t",
          stepId: "lint",
          stepConfigSha: "cfg",
          result: "pass",
        },
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  // ── mismatch relay (ai_agent-gated, non-persisted) ───────────────

  it("POST /verify-cache/mismatch returns 202 and fires VERIFY_CACHE_MISMATCH", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);

    const events: unknown[] = [];
    getEventBus().on(EVENT_NAMES.VERIFY_CACHE_MISMATCH, (p) => events.push(p.entity));

    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/verify-cache/mismatch`,
      {
        token: agent.token,
        body: {
          treeSha: "t-mm",
          stepId: "unit",
          stepConfigSha: "cfg-1",
          cachedResult: "pass",
          realResult: "fail",
          requestId: "req-1",
          attemptId: "att-1",
        },
      },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { ok: boolean } };
    expect(body.data.ok).toBe(true);

    // The relay re-emitted VERIFY_CACHE_MISMATCH with the key/result fields.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      treeSha: "t-mm",
      stepId: "unit",
      cachedResult: "pass",
      realResult: "fail",
    });

    // NON-persisted: no verify_cache row was written by the relay.
    const rows = testApp.db.select().from(verifyCache).all();
    expect(rows).toHaveLength(0);
  });

  it("POST /verify-cache/mismatch returns 403 for a non-ai_agent caller", async () => {
    const project = createTestProject(testApp.db);
    const memberToken = createMemberToken(testApp);
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/verify-cache/mismatch`,
      {
        token: memberToken,
        body: {
          treeSha: "t",
          stepId: "lint",
          stepConfigSha: "cfg",
          cachedResult: "pass",
          realResult: "fail",
        },
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });
});
