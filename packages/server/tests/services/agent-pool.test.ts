import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestAiAgent,
  createTestProject,
  createTestTask,
  createTestEpic,
  createTestUser,
  authRequest,
  type TestApp,
} from "../utils.js";
import { agentClaims, agentPools, claimLeases, tasks, users } from "../../src/db/index.js";
import { createId } from "@pm/shared";
import { eq } from "drizzle-orm";

const TEST_POOL_SECRET = "test-pool-secret-12345";

describe("Agent Pool", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    delete process.env.PM_POOL_SECRET;
    testApp.cleanup();
  });

  // ── Helper: create a pool via API ──────────────────────────────────

  async function createPoolViaAPI(
    name: string = "test-pool",
    secret: string = TEST_POOL_SECRET,
    description?: string,
  ) {
    const res = await authRequest(testApp.app, "POST", "/api/v1/auth/agent-pools", {
      body: { name, secret, ...(description ? { description } : {}) },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    return body.data as { id: string; name: string; description: string | null };
  }

  async function createPoolAgentsViaAPI(poolId: string, count: number, namePrefix?: string) {
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/auth/agent-pools/${poolId}/agents`,
      {
        body: { count, ...(namePrefix ? { namePrefix } : {}) },
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    return body.data as Array<{ id: string; username: string; displayName: string }>;
  }

  // ── Pool CRUD ─────────────────────────────────────────────────────

  describe("Pool CRUD", () => {
    it("should create a pool", async () => {
      const pool = await createPoolViaAPI("my-pool", "secret-12345", "A test pool");
      expect(pool.name).toBe("my-pool");
      expect(pool.description).toBe("A test pool");
    });

    it("should reject duplicate pool name", async () => {
      await createPoolViaAPI("dup-pool", "secret-12345");
      const res = await authRequest(testApp.app, "POST", "/api/v1/auth/agent-pools", {
        body: { name: "dup-pool", secret: "another-secret-123" },
      });
      expect(res.status).toBe(409);
    });

    it("should list pools with agent counts", async () => {
      const pool = await createPoolViaAPI("list-pool", "secret-12345");
      await createPoolAgentsViaAPI(pool.id, 3);

      const res = await authRequest(testApp.app, "GET", "/api/v1/auth/agent-pools");
      expect(res.status).toBe(200);
      const body = await res.json();
      const found = body.data.find((p: any) => p.id === pool.id);
      expect(found).toBeTruthy();
      expect(found.agentCount).toBe(3);
      expect(found.claimedCount).toBe(0);
      expect(found.availableCount).toBe(3);
    });

    it("should get pool details with agent list", async () => {
      const pool = await createPoolViaAPI("detail-pool", "secret-12345");
      await createPoolAgentsViaAPI(pool.id, 2);

      const res = await authRequest(testApp.app, "GET", `/api/v1/auth/agent-pools/${pool.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.pool.name).toBe("detail-pool");
      expect(body.data.agents.length).toBe(2);
    });

    it("should update pool name and description", async () => {
      const pool = await createPoolViaAPI("old-name", "secret-12345");

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/auth/agent-pools/${pool.id}`, {
        body: { name: "new-name", description: "Updated" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe("new-name");
      expect(body.data.description).toBe("Updated");
    });

    it("should delete pool and deactivate agents", async () => {
      const pool = await createPoolViaAPI("delete-pool", "secret-12345");
      const agents = await createPoolAgentsViaAPI(pool.id, 2);

      const res = await authRequest(testApp.app, "DELETE", `/api/v1/auth/agent-pools/${pool.id}`);
      expect(res.status).toBe(200);

      // Pool should be gone
      const listRes = await authRequest(testApp.app, "GET", "/api/v1/auth/agent-pools");
      const listBody = await listRes.json();
      expect(listBody.data.find((p: any) => p.id === pool.id)).toBeUndefined();

      // Agents should be deactivated
      for (const agent of agents) {
        const user = testApp.db.select().from(users).where(eq(users.id, agent.id)).get();
        expect(user?.isActive).toBe(false);
      }
    });

    it("should update pool secret", async () => {
      const pool = await createPoolViaAPI("secret-pool", "old-secret-123");
      await createPoolAgentsViaAPI(pool.id, 1);

      // Update secret
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/auth/agent-pools/${pool.id}/secret`,
        {
          body: { secret: "new-secret-456" },
        },
      );
      expect(res.status).toBe(200);

      // Old secret should fail
      const claimRes1 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "secret-pool", poolSecret: "old-secret-123" }),
      });
      expect(claimRes1.status).toBe(401);

      // New secret should work
      const claimRes2 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "secret-pool", poolSecret: "new-secret-456" }),
      });
      expect(claimRes2.status).toBe(200);
    });
  });

  // ── Multi-pool isolation ──────────────────────────────────────────

  describe("Multi-pool isolation", () => {
    it("should not claim agents across pools", async () => {
      const poolA = await createPoolViaAPI("pool-a", "secret-a-12345");
      const poolB = await createPoolViaAPI("pool-b", "secret-b-12345");
      await createPoolAgentsViaAPI(poolA.id, 1);
      await createPoolAgentsViaAPI(poolB.id, 1);

      // Claim from pool A
      const res1 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "pool-a", poolSecret: "secret-a-12345" }),
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();

      // Pool A should now be exhausted
      const res2 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "pool-a", poolSecret: "secret-a-12345" }),
      });
      expect(res2.status).toBe(503);

      // Pool B should still have agents available
      const res3 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "pool-b", poolSecret: "secret-b-12345" }),
      });
      expect(res3.status).toBe(200);
      const body3 = await res3.json();

      // Different agents
      expect(body1.data.user.id).not.toBe(body3.data.user.id);
    });

    it("should not accept wrong pool secret for a different pool", async () => {
      const poolA = await createPoolViaAPI("cross-a", "secret-for-a-123");
      const poolB = await createPoolViaAPI("cross-b", "secret-for-b-123");
      await createPoolAgentsViaAPI(poolA.id, 1);
      await createPoolAgentsViaAPI(poolB.id, 1);

      // Pool A's secret should not work for pool B
      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "cross-b", poolSecret: "secret-for-a-123" }),
      });
      expect(res.status).toBe(401);
    });
  });

  // ── Agent creation in specific pool ───────────────────────────────

  describe("Agent creation in pool", () => {
    it("should create agents in a specific pool", async () => {
      const pool = await createPoolViaAPI("agent-pool", "secret-12345");
      const agents = await createPoolAgentsViaAPI(pool.id, 3);
      expect(agents.length).toBe(3);
      for (const agent of agents) {
        expect(agent.poolId).toBe(pool.id);
      }
    });

    it("should reject agent creation for non-existent pool", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/auth/agent-pools/nonexistent/agents",
        {
          body: { count: 1 },
        },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── Backward compat: PM_POOL_SECRET auto-creates default pool ─────

  describe("Backward compat: PM_POOL_SECRET", () => {
    it("should auto-create default pool from PM_POOL_SECRET on first claim", async () => {
      process.env.PM_POOL_SECRET = TEST_POOL_SECRET;

      // Manually create an agent in the "default" pool that will be auto-created
      // First, the claim should trigger auto-creation of the pool
      const res1 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "default", poolSecret: TEST_POOL_SECRET }),
      });
      // Should return 503 (no agents) but the pool should now exist
      expect(res1.status).toBe(503);

      // Verify the pool was created
      const poolRes = await authRequest(testApp.app, "GET", "/api/v1/auth/agent-pools");
      const pools = await poolRes.json();
      const defaultPool = pools.data.find((p: any) => p.name === "default");
      expect(defaultPool).toBeTruthy();

      // Now add agents and claim
      await createPoolAgentsViaAPI(defaultPool.id, 1);
      const res2 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "default", poolSecret: TEST_POOL_SECRET }),
      });
      expect(res2.status).toBe(200);
    });

    it("should not auto-create if pools already exist", async () => {
      process.env.PM_POOL_SECRET = TEST_POOL_SECRET;
      await createPoolViaAPI("existing-pool", "other-secret-123");

      // Claim on "default" pool should fail with not found, not auto-create
      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "default", poolSecret: TEST_POOL_SECRET }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Claim / Release / Heartbeat ───────────────────────────────────

  describe("POST /api/v1/auth/agent-claim", () => {
    it("should claim an available AI agent", async () => {
      const pool = await createPoolViaAPI("claim-pool", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);

      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "claim-pool", poolSecret: TEST_POOL_SECRET }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.user.id).toBeTruthy();
      expect(body.data.token).toBeTruthy();
    });

    it("should return 503 when no agents are available", async () => {
      const pool = await createPoolViaAPI("empty-pool", TEST_POOL_SECRET);
      // No agents created

      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "empty-pool", poolSecret: TEST_POOL_SECRET }),
      });

      expect(res.status).toBe(503);
    });

    it("should reject invalid pool secret", async () => {
      const pool = await createPoolViaAPI("auth-pool", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);

      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "auth-pool", poolSecret: "wrong-secret" }),
      });

      expect(res.status).toBe(401);
    });

    it("should not double-assign the same agent", async () => {
      const pool = await createPoolViaAPI("solo-pool", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);

      const res1 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "solo-pool", poolSecret: TEST_POOL_SECRET }),
      });
      expect(res1.status).toBe(200);

      const res2 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "solo-pool", poolSecret: TEST_POOL_SECRET }),
      });
      expect(res2.status).toBe(503);
    });

    it("should claim different agents for consecutive requests", async () => {
      const pool = await createPoolViaAPI("multi-pool", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 2);

      const res1 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "multi-pool", poolSecret: TEST_POOL_SECRET }),
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();

      const res2 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "multi-pool", poolSecret: TEST_POOL_SECRET }),
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json();

      expect(body1.data.user.id).not.toBe(body2.data.user.id);
    });

    it("should reclaim an agent with an expired claim", async () => {
      const pool = await createPoolViaAPI("reclaim-pool", TEST_POOL_SECRET);
      const agents = await createPoolAgentsViaAPI(pool.id, 1);

      // Create an expired claim directly
      const expiredTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      testApp.db
        .insert(agentClaims)
        .values({
          id: "expired-claim-id",
          userId: agents[0].id,
          claimedAt: expiredTime,
          expiresAt: expiredTime,
          heartbeatAt: expiredTime,
        })
        .run();

      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "reclaim-pool", poolSecret: TEST_POOL_SECRET }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/v1/auth/agent-release", () => {
    it("should release a claimed agent", async () => {
      const pool = await createPoolViaAPI("release-pool", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);

      // Claim
      const claimRes = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "release-pool", poolSecret: TEST_POOL_SECRET }),
      });
      const claimBody = await claimRes.json();
      const token = claimBody.data.token;

      // Release
      const releaseRes = await authRequest(testApp.app, "POST", "/api/v1/auth/agent-release", {
        token,
      });
      expect(releaseRes.status).toBe(200);

      // Should be claimable again
      const reclaimRes = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "release-pool", poolSecret: TEST_POOL_SECRET }),
      });
      expect(reclaimRes.status).toBe(200);
    });
  });

  describe("POST /api/v1/auth/agent-heartbeat", () => {
    it("should extend claim TTL", async () => {
      const pool = await createPoolViaAPI("hb-pool", TEST_POOL_SECRET);
      const agents = await createPoolAgentsViaAPI(pool.id, 1);

      const claimRes = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "hb-pool", poolSecret: TEST_POOL_SECRET }),
      });
      const claimBody = await claimRes.json();
      const token = claimBody.data.token;

      const hbRes = await authRequest(testApp.app, "POST", "/api/v1/auth/agent-heartbeat", {
        token,
      });
      expect(hbRes.status).toBe(200);

      // Verify claim still exists
      const claims = testApp.db
        .select()
        .from(agentClaims)
        .where(eq(agentClaims.userId, agents[0].id))
        .all();
      expect(claims.length).toBe(1);
      expect(claims[0].heartbeatAt).toBeTruthy();
    });

    it("should return 404 for user with no claim", async () => {
      const hbRes = await authRequest(testApp.app, "POST", "/api/v1/auth/agent-heartbeat");
      expect(hbRes.status).toBe(404);
    });
  });

  // ── Remove agent from pool ───────────────────────────────────────

  describe("DELETE /api/v1/auth/agent-pools/:id/agents/:userId", () => {
    it("should hard-delete an agent with no activity", async () => {
      const pool = await createPoolViaAPI("remove-pool", "secret-12345");
      const agents = await createPoolAgentsViaAPI(pool.id, 2);
      const targetId = agents[0].id;

      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/auth/agent-pools/${pool.id}/agents/${targetId}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.deleted).toBe(true);
      expect(body.data.deactivated).toBe(false);

      // User should no longer exist
      const user = testApp.db.select().from(users).where(eq(users.id, targetId)).get();
      expect(user).toBeUndefined();

      // Other agent should still be there
      const otherUser = testApp.db.select().from(users).where(eq(users.id, agents[1].id)).get();
      expect(otherUser).toBeTruthy();
      expect(otherUser?.isActive).toBe(true);
    });

    it("should release claim before deleting", async () => {
      const pool = await createPoolViaAPI("remove-claimed-pool", TEST_POOL_SECRET);
      const agents = await createPoolAgentsViaAPI(pool.id, 1);
      const targetId = agents[0].id;

      // Claim the agent
      const claimRes = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "remove-claimed-pool", poolSecret: TEST_POOL_SECRET }),
      });
      expect(claimRes.status).toBe(200);

      // Now remove (should release claim first, then delete)
      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/auth/agent-pools/${pool.id}/agents/${targetId}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.deleted).toBe(true);

      // Claims should be gone
      const claims = testApp.db
        .select()
        .from(agentClaims)
        .where(eq(agentClaims.userId, targetId))
        .all();
      expect(claims.length).toBe(0);
    });

    it("should return 404 for non-existent user", async () => {
      const pool = await createPoolViaAPI("remove-404-pool", "secret-12345");

      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/auth/agent-pools/${pool.id}/agents/nonexistent`,
      );
      expect(res.status).toBe(404);
    });

    it("should return 400 if agent does not belong to the pool", async () => {
      const poolA = await createPoolViaAPI("pool-a-rm", "secret-a-12345");
      const poolB = await createPoolViaAPI("pool-b-rm", "secret-b-12345");
      const agentsB = await createPoolAgentsViaAPI(poolB.id, 1);

      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/auth/agent-pools/${poolA.id}/agents/${agentsB[0].id}`,
      );
      expect(res.status).toBe(400);
    });

    it("should update pool agent count after removal", async () => {
      const pool = await createPoolViaAPI("count-pool", "secret-12345");
      const agents = await createPoolAgentsViaAPI(pool.id, 3);

      // Remove one
      await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/auth/agent-pools/${pool.id}/agents/${agents[0].id}`,
      );

      // Check pool detail
      const detailRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/auth/agent-pools/${pool.id}`,
      );
      const detail = await detailRes.json();
      expect(detail.data.agents.length).toBe(2);
    });
  });

  // ── Stable worker binding (C1) ───────────────────────────────────

  describe("Stable worker binding", () => {
    async function claim(
      poolName: string,
      poolSecret: string,
      workerKey?: string,
    ): Promise<{ status: number; body: any }> {
      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          poolName,
          poolSecret,
          ...(workerKey ? { workerKey } : {}),
        }),
      });
      const body = res.status === 200 ? await res.json() : await res.json().catch(() => ({}));
      return { status: res.status, body };
    }

    it("resolves the same (pool, key) to the same userId across binds, with a stable bindHandle", async () => {
      const pool = await createPoolViaAPI("bind-stable", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 3);

      const r1 = await claim("bind-stable", TEST_POOL_SECRET, "worker-1");
      const r2 = await claim("bind-stable", TEST_POOL_SECRET, "worker-1");
      const r3 = await claim("bind-stable", TEST_POOL_SECRET, "worker-1");

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);

      const id = r1.body.data.user.id;
      expect(r2.body.data.user.id).toBe(id);
      expect(r3.body.data.user.id).toBe(id);

      expect(r1.body.data.bindHandle).toBeTruthy();
      expect(r2.body.data.bindHandle).toBe(r1.body.data.bindHandle);
      expect(r3.body.data.bindHandle).toBe(r1.body.data.bindHandle);

      // Exactly one binding row for this user.
      const rows = testApp.db.select().from(agentClaims).where(eq(agentClaims.userId, id)).all();
      expect(rows.length).toBe(1);
      expect(rows[0].workerKey).toBe("worker-1");
      expect(rows[0].workerKeyPoolId).toBe(pool.id);
    });

    it("resolves distinct keys to distinct userIds", async () => {
      const pool = await createPoolViaAPI("bind-distinct", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 3);

      const a = await claim("bind-distinct", TEST_POOL_SECRET, "key-a");
      const b = await claim("bind-distinct", TEST_POOL_SECRET, "key-b");

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.data.user.id).not.toBe(b.body.data.user.id);
    });

    it("preserves in-flight work (task assignee + lease holder) across a rebind", async () => {
      const pool = await createPoolViaAPI("bind-inflight", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 3);

      const first = await claim("bind-inflight", TEST_POOL_SECRET, "worker-x");
      expect(first.status).toBe(200);
      const userId = first.body.data.user.id;

      // Assign a task to U + open a claim_leases row held by U.
      const project = createTestProject(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        assigneeId: userId,
        status: "in_progress",
      });
      const ts = new Date().toISOString();
      const leaseId = createId();
      testApp.db
        .insert(claimLeases)
        .values({
          id: leaseId,
          entityType: "task",
          entityId: task.id,
          holderId: userId,
          claimedAt: ts,
          heartbeatAt: ts,
          expiresAt: ts,
          lastActivityAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      // Reconnect with the SAME key.
      const second = await claim("bind-inflight", TEST_POOL_SECRET, "worker-x");
      expect(second.status).toBe(200);
      expect(second.body.data.user.id).toBe(userId);

      // The assignee and lease holder must still be U — nothing stranded.
      const taskRow = testApp.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
      expect(taskRow?.assigneeId).toBe(userId);
      const leaseRow = testApp.db
        .select()
        .from(claimLeases)
        .where(eq(claimLeases.id, leaseId))
        .get();
      expect(leaseRow?.holderId).toBe(userId);

      // Exactly one agent_claims row for U.
      const rows = testApp.db
        .select()
        .from(agentClaims)
        .where(eq(agentClaims.userId, userId))
        .all();
      expect(rows.length).toBe(1);
    });

    it("rejects a wrong secret + key with 401 and creates no binding row", async () => {
      const pool = await createPoolViaAPI("bind-authz", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 2);

      const res = await claim("bind-authz", "wrong-secret", "worker-evil");
      expect(res.status).toBe(401);

      const rows = testApp.db
        .select()
        .from(agentClaims)
        .where(eq(agentClaims.workerKeyPoolId, pool.id))
        .all();
      expect(rows.length).toBe(0);
    });

    it("isolates the same key across different pools (distinct userIds)", async () => {
      const poolA = await createPoolViaAPI("bind-iso-a", "secret-a-12345");
      const poolB = await createPoolViaAPI("bind-iso-b", "secret-b-12345");
      await createPoolAgentsViaAPI(poolA.id, 2);
      await createPoolAgentsViaAPI(poolB.id, 2);

      const a = await claim("bind-iso-a", "secret-a-12345", "shared-key");
      const b = await claim("bind-iso-b", "secret-b-12345", "shared-key");

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.data.user.id).not.toBe(b.body.data.user.id);
    });

    it("[correction 1] a keyed-bound agent is NOT grabbable by a keyless claim, even after its claim TTL expires (within the reservation grace)", async () => {
      const pool = await createPoolViaAPI("bind-noshare-keyless", TEST_POOL_SECRET);
      // 2 agents total: one will be keyed-bound, one stays free.
      await createPoolAgentsViaAPI(pool.id, 2);

      const bound = await claim("bind-noshare-keyless", TEST_POOL_SECRET, "worker-bound");
      expect(bound.status).toBe(200);
      const boundId = bound.body.data.user.id;

      // Force the keyed binding's claim to be far in the past.
      const past = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
      testApp.db
        .update(agentClaims)
        .set({ expiresAt: past, heartbeatAt: past, claimedAt: past })
        .where(eq(agentClaims.userId, boundId))
        .run();

      // A keyless claim must NOT return the keyed-bound agent.
      const keyless1 = await claim("bind-noshare-keyless", TEST_POOL_SECRET);
      expect(keyless1.status).toBe(200);
      expect(keyless1.body.data.user.id).not.toBe(boundId);

      // The pool's only other free agent is now taken → next keyless = 503,
      // proving the expired-but-keyed agent was never offered.
      const keyless2 = await claim("bind-noshare-keyless", TEST_POOL_SECRET);
      expect(keyless2.status).toBe(503);
    });

    it("[correction 1] a keyed-bound agent is NOT grabbable by another key's first-bind, even after expiry (within the reservation grace)", async () => {
      const pool = await createPoolViaAPI("bind-noshare-keyed", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 2);

      const bound = await claim("bind-noshare-keyed", TEST_POOL_SECRET, "worker-1");
      expect(bound.status).toBe(200);
      const boundId = bound.body.data.user.id;

      const past = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
      testApp.db
        .update(agentClaims)
        .set({ expiresAt: past, heartbeatAt: past, claimedAt: past })
        .where(eq(agentClaims.userId, boundId))
        .run();

      // A DIFFERENT key's first-bind must take the other free agent, not U.
      const other = await claim("bind-noshare-keyed", TEST_POOL_SECRET, "worker-2");
      expect(other.status).toBe(200);
      expect(other.body.data.user.id).not.toBe(boundId);

      // No remaining free agent → a third key's first-bind = 503.
      const third = await claim("bind-noshare-keyed", TEST_POOL_SECRET, "worker-3");
      expect(third.status).toBe(503);
    });

    it("does not over-report available_count when an agent is keyed-bound", async () => {
      const pool = await createPoolViaAPI("bind-count", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 3);

      await claim("bind-count", TEST_POOL_SECRET, "worker-1");

      const res = await authRequest(testApp.app, "GET", "/api/v1/auth/agent-pools");
      const body = await res.json();
      const found = body.data.find((p: any) => p.id === pool.id);
      expect(found.agentCount).toBe(3);
      expect(found.claimedCount).toBe(1);
      expect(found.availableCount).toBe(2);
    });

    it("shared host: two distinct keys get two distinct identities, each stable across an interleaved rebind", async () => {
      const pool = await createPoolViaAPI("bind-shared-host", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 3);

      // First-bind both keys.
      const firstA = await claim("bind-shared-host", TEST_POOL_SECRET, "host-worker-a");
      const firstB = await claim("bind-shared-host", TEST_POOL_SECRET, "host-worker-b");
      expect(firstA.status).toBe(200);
      expect(firstB.status).toBe(200);

      const idA = firstA.body.data.user.id;
      const idB = firstB.body.data.user.id;
      expect(idA).not.toBe(idB);

      const handleA = firstA.body.data.bindHandle;
      const handleB = firstB.body.data.bindHandle;
      expect(handleA).toBeTruthy();
      expect(handleB).toBeTruthy();
      expect(handleA).not.toBe(handleB);

      // Interleaved rebinds a, b, a, b — each key must keep returning its own
      // original identity (A never sees idB, B never sees idA) and its own handle.
      const rebindA1 = await claim("bind-shared-host", TEST_POOL_SECRET, "host-worker-a");
      const rebindB1 = await claim("bind-shared-host", TEST_POOL_SECRET, "host-worker-b");
      const rebindA2 = await claim("bind-shared-host", TEST_POOL_SECRET, "host-worker-a");
      const rebindB2 = await claim("bind-shared-host", TEST_POOL_SECRET, "host-worker-b");

      for (const r of [rebindA1, rebindB1, rebindA2, rebindB2]) {
        expect(r.status).toBe(200);
      }

      expect(rebindA1.body.data.user.id).toBe(idA);
      expect(rebindA2.body.data.user.id).toBe(idA);
      expect(rebindB1.body.data.user.id).toBe(idB);
      expect(rebindB2.body.data.user.id).toBe(idB);

      // A's handle is constant across its binds; B's constant; A's != B's.
      expect(rebindA1.body.data.bindHandle).toBe(handleA);
      expect(rebindA2.body.data.bindHandle).toBe(handleA);
      expect(rebindB1.body.data.bindHandle).toBe(handleB);
      expect(rebindB2.body.data.bindHandle).toBe(handleB);

      // Exactly one agent_claims row per user.
      const rowsA = testApp.db.select().from(agentClaims).where(eq(agentClaims.userId, idA)).all();
      expect(rowsA.length).toBe(1);
      expect(rowsA[0].workerKey).toBe("host-worker-a");
      expect(rowsA[0].workerKeyPoolId).toBe(pool.id);

      const rowsB = testApp.db.select().from(agentClaims).where(eq(agentClaims.userId, idB)).all();
      expect(rowsB.length).toBe(1);
      expect(rowsB[0].workerKey).toBe("host-worker-b");
      expect(rowsB[0].workerKeyPoolId).toBe(pool.id);
    });
  });

  // ── Reservation grace + lazy reclamation ─────────────────────────
  //
  // A keyed binding reserves its identity past its TTL (C1, above). Without a
  // bound on that reservation, a deployment that mints a fresh worker key per
  // task leaks one identity per session until the pool reads empty — which is
  // exactly what drained a live 35-agent pool to zero over seven weeks.

  describe("Reservation grace + reclamation", () => {
    async function claim(
      poolName: string,
      poolSecret: string,
      workerKey?: string,
    ): Promise<{ status: number; body: any }> {
      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName, poolSecret, ...(workerKey ? { workerKey } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }

    /** Age a user's claim row so it lapsed `hoursAgo` hours ago. */
    function lapseClaim(userId: string, hoursAgo: number) {
      const past = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
      testApp.db
        .update(agentClaims)
        .set({ expiresAt: past, heartbeatAt: past, claimedAt: past })
        .where(eq(agentClaims.userId, userId))
        .run();
    }

    afterEach(() => {
      delete process.env.PM_AGENT_BIND_GRACE_SEC;
    });

    it("recycles a beyond-grace reservation when the pool is otherwise exhausted", async () => {
      const pool = await createPoolViaAPI("reclaim-basic", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);

      const first = await claim("reclaim-basic", TEST_POOL_SECRET, "dead-worker");
      expect(first.status).toBe(200);
      const id = first.body.data.user.id;

      // Two days dead, default grace is 24h.
      lapseClaim(id, 48);

      const second = await claim("reclaim-basic", TEST_POOL_SECRET, "fresh-worker");
      expect(second.status).toBe(200);
      expect(second.body.data.user.id).toBe(id);

      // The reservation changed hands outright — exactly one binding row, and
      // it belongs to the new key.
      const rows = testApp.db.select().from(agentClaims).where(eq(agentClaims.userId, id)).all();
      expect(rows.length).toBe(1);
      expect(rows[0].workerKey).toBe("fresh-worker");
    });

    it("prefers a genuinely free agent over recycling, even when one is past the grace", async () => {
      const pool = await createPoolViaAPI("reclaim-lazy", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 2);

      const bound = await claim("reclaim-lazy", TEST_POOL_SECRET, "dead-worker");
      const boundId = bound.body.data.user.id;
      lapseClaim(boundId, 72);

      // A free agent remains, so the cold reservation must be left alone.
      const next = await claim("reclaim-lazy", TEST_POOL_SECRET, "new-worker");
      expect(next.status).toBe(200);
      expect(next.body.data.user.id).not.toBe(boundId);

      const rows = testApp.db
        .select()
        .from(agentClaims)
        .where(eq(agentClaims.userId, boundId))
        .all();
      expect(rows[0].workerKey).toBe("dead-worker");
    });

    it("recycles the COLDEST reservation first", async () => {
      const pool = await createPoolViaAPI("reclaim-order", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 3);

      const a = await claim("reclaim-order", TEST_POOL_SECRET, "worker-a");
      const b = await claim("reclaim-order", TEST_POOL_SECRET, "worker-b");
      const c = await claim("reclaim-order", TEST_POOL_SECRET, "worker-c");
      lapseClaim(a.body.data.user.id, 30);
      lapseClaim(b.body.data.user.id, 200); // coldest
      lapseClaim(c.body.data.user.id, 50);

      const fresh = await claim("reclaim-order", TEST_POOL_SECRET, "worker-d");
      expect(fresh.status).toBe(200);
      expect(fresh.body.data.user.id).toBe(b.body.data.user.id);
    });

    it("does not recycle a reservation still inside the grace", async () => {
      const pool = await createPoolViaAPI("reclaim-within", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);

      const bound = await claim("reclaim-within", TEST_POOL_SECRET, "recent-worker");
      lapseClaim(bound.body.data.user.id, 2); // 2h dead, 24h grace

      const other = await claim("reclaim-within", TEST_POOL_SECRET, "other-worker");
      expect(other.status).toBe(503);
    });

    it("honours PM_AGENT_BIND_GRACE_SEC=off (reserved forever)", async () => {
      process.env.PM_AGENT_BIND_GRACE_SEC = "off";
      const pool = await createPoolViaAPI("reclaim-off", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);

      const bound = await claim("reclaim-off", TEST_POOL_SECRET, "dead-worker");
      lapseClaim(bound.body.data.user.id, 24 * 365);

      const other = await claim("reclaim-off", TEST_POOL_SECRET, "other-worker");
      expect(other.status).toBe(503);
    });

    it("honours a custom grace", async () => {
      process.env.PM_AGENT_BIND_GRACE_SEC = "3600"; // 1h
      const pool = await createPoolViaAPI("reclaim-custom", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);

      const bound = await claim("reclaim-custom", TEST_POOL_SECRET, "dead-worker");
      const id = bound.body.data.user.id;
      lapseClaim(id, 2); // 2h dead > 1h grace

      const other = await claim("reclaim-custom", TEST_POOL_SECRET, "other-worker");
      expect(other.status).toBe(200);
      expect(other.body.data.user.id).toBe(id);
    });

    it("invalidates the previous worker's token when its identity is recycled", async () => {
      const pool = await createPoolViaAPI("reclaim-token", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);

      const first = await claim("reclaim-token", TEST_POOL_SECRET, "dead-worker");
      const oldToken = first.body.data.token;
      lapseClaim(first.body.data.user.id, 48);

      const second = await claim("reclaim-token", TEST_POOL_SECRET, "fresh-worker");
      expect(second.body.data.token).not.toBe(oldToken);

      // The displaced worker must not be able to keep acting as that identity —
      // this is what makes recycling safe rather than identity-sharing.
      const zombie = await testApp.app.request("/api/v1/projects", {
        headers: { Authorization: `Bearer ${oldToken}` },
      });
      expect(zombie.status).toBe(401);
    });

    it("a keyless claim can also recycle a beyond-grace reservation", async () => {
      const pool = await createPoolViaAPI("reclaim-keyless", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);

      const bound = await claim("reclaim-keyless", TEST_POOL_SECRET, "dead-worker");
      const id = bound.body.data.user.id;
      lapseClaim(id, 48);

      const keyless = await claim("reclaim-keyless", TEST_POOL_SECRET);
      expect(keyless.status).toBe(200);
      expect(keyless.body.data.user.id).toBe(id);
    });

    it("a returning worker inside the grace still gets its OWN identity back", async () => {
      const pool = await createPoolViaAPI("reclaim-rebind", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);

      const first = await claim("reclaim-rebind", TEST_POOL_SECRET, "worker-1");
      const id = first.body.data.user.id;
      lapseClaim(id, 200); // even far past the grace…

      // …a rebind by the SAME key resolves before any reclamation is considered.
      const again = await claim("reclaim-rebind", TEST_POOL_SECRET, "worker-1");
      expect(again.status).toBe(200);
      expect(again.body.data.user.id).toBe(id);
    });
  });

  // ── Pool state accounting ────────────────────────────────────────

  describe("Pool state accounting", () => {
    async function claim(poolName: string, workerKey?: string) {
      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          poolName,
          poolSecret: TEST_POOL_SECRET,
          ...(workerKey ? { workerKey } : {}),
        }),
      });
      return await res.json();
    }

    it("reports a lapsed keyed binding as `reserved`, never `available`", async () => {
      const pool = await createPoolViaAPI("state-reserved", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 2);

      const bound = await claim("state-reserved", "worker-1");
      const boundId = bound.data.user.id;
      const past = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
      testApp.db
        .update(agentClaims)
        .set({ expiresAt: past, heartbeatAt: past, claimedAt: past })
        .where(eq(agentClaims.userId, boundId))
        .run();

      const res = await authRequest(testApp.app, "GET", `/api/v1/auth/agent-pools/${pool.id}`);
      const body = await res.json();
      const row = body.data.agents.find((a: any) => a.user.id === boundId);

      // The pre-2026-09 bug in one assertion: this row read `claimed: false`,
      // and the UI had no third state, so it rendered a green "Available" badge
      // for an identity nobody could claim.
      expect(row.claimed).toBe(false);
      expect(row.state).toBe("reserved");
      expect(row.workerKey).toBe("worker-1");
      expect(row.reclaimableAt).not.toBeNull();
      // Lapsed 10h ago + 24h grace ⇒ recyclable ~14h from now, not yet.
      expect(Date.parse(row.reclaimableAt)).toBeGreaterThan(Date.now());
    });

    it("surfaces the lapsed claim's timestamps on a reserved row", async () => {
      const pool = await createPoolViaAPI("state-times", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);
      const bound = await claim("state-times", "worker-1");
      const past = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
      testApp.db
        .update(agentClaims)
        .set({ expiresAt: past, heartbeatAt: past, claimedAt: past })
        .where(eq(agentClaims.userId, bound.data.user.id))
        .run();

      const res = await authRequest(testApp.app, "GET", `/api/v1/auth/agent-pools/${pool.id}`);
      const body = await res.json();
      // How long the reservation has been dead IS the finding; blanking these
      // was half of why the state was invisible.
      expect(body.data.agents[0].expiresAt).toBe(past);
      expect(body.data.agents[0].heartbeatAt).toBe(past);
    });

    it("counts reserved / inactive as named buckets that sum to agentCount", async () => {
      const pool = await createPoolViaAPI("state-counts", TEST_POOL_SECRET);
      const agents = await createPoolAgentsViaAPI(pool.id, 5);

      // 1 live claim, 2 reserved (one past grace, one within), 1 deactivated,
      // 1 genuinely free.
      await claim("state-counts", "live-worker");
      const r1 = await claim("state-counts", "cold-worker");
      const r2 = await claim("state-counts", "warm-worker");
      const setLapse = (id: string, hours: number) => {
        const past = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        testApp.db
          .update(agentClaims)
          .set({ expiresAt: past, heartbeatAt: past, claimedAt: past })
          .where(eq(agentClaims.userId, id))
          .run();
      };
      setLapse(r1.data.user.id, 100); // past the 24h grace
      setLapse(r2.data.user.id, 3); // within it

      const spare = agents.find((a: any) => ![r1.data.user.id, r2.data.user.id].includes(a.id));
      const toDeactivate = agents.filter(
        (a: any) => ![r1.data.user.id, r2.data.user.id].includes(a.id),
      )[0];
      testApp.db.update(users).set({ isActive: false }).where(eq(users.id, toDeactivate.id)).run();
      expect(spare).toBeDefined();

      const res = await authRequest(testApp.app, "GET", "/api/v1/auth/agent-pools");
      const body = await res.json();
      const found = body.data.find((p: any) => p.id === pool.id);

      expect(found.agentCount).toBe(5);
      expect(found.reservedCount).toBe(2);
      expect(found.reclaimableCount).toBe(1);
      expect(found.inactiveCount).toBe(1);
      // The buckets are disjoint and exhaustive — no residual left over to be
      // mislabelled "inactive" by subtraction in the UI.
      expect(
        found.claimedCount + found.availableCount + found.reservedCount + found.inactiveCount,
      ).toBe(found.agentCount);
    });

    it("names the reserved bucket in the 503 when a pool is drained", async () => {
      const pool = await createPoolViaAPI("state-503", TEST_POOL_SECRET);
      await createPoolAgentsViaAPI(pool.id, 1);
      const bound = await claim("state-503", "worker-1");
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      testApp.db
        .update(agentClaims)
        .set({ expiresAt: past, heartbeatAt: past, claimedAt: past })
        .where(eq(agentClaims.userId, bound.data.user.id))
        .run();

      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          poolName: "state-503",
          poolSecret: TEST_POOL_SECRET,
          workerKey: "worker-2",
        }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.message).toMatch(/reserved by a worker key/);
    });
  });

  // ── Legacy endpoint ──────────────────────────────────────────────

  describe("GET /api/v1/auth/agent-pool (legacy)", () => {
    it("should return all pools", async () => {
      await createPoolViaAPI("legacy-pool-a", "secret-a-12345");
      await createPoolViaAPI("legacy-pool-b", "secret-b-12345");

      const res = await authRequest(testApp.app, "GET", "/api/v1/auth/agent-pool");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBe(2);
    });

    it("should return 403 for non-admin", async () => {
      const pool = await createPoolViaAPI("forbidden-pool", "secret-12345");
      const agents = await createPoolAgentsViaAPI(pool.id, 1);

      // Claim to get a non-admin token
      const claimRes = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolName: "forbidden-pool", poolSecret: "secret-12345" }),
      });
      const claimBody = await claimRes.json();
      const agentToken = claimBody.data.token;

      const res = await authRequest(testApp.app, "GET", "/api/v1/auth/agent-pool", {
        token: agentToken,
      });
      expect(res.status).toBe(403);
    });
  });
});
