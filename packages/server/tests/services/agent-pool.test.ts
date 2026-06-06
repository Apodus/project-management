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
    const res = await authRequest(testApp.app, "POST", `/api/v1/auth/agent-pools/${poolId}/agents`, {
      body: { count, ...(namePrefix ? { namePrefix } : {}) },
    });
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
      const res = await authRequest(testApp.app, "POST", `/api/v1/auth/agent-pools/${pool.id}/secret`, {
        body: { secret: "new-secret-456" },
      });
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
      const res = await authRequest(testApp.app, "POST", "/api/v1/auth/agent-pools/nonexistent/agents", {
        body: { count: 1 },
      });
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
      testApp.db.insert(agentClaims).values({
        id: "expired-claim-id",
        userId: agents[0].id,
        claimedAt: expiredTime,
        expiresAt: expiredTime,
        heartbeatAt: expiredTime,
      }).run();

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
      const releaseRes = await authRequest(testApp.app, "POST", "/api/v1/auth/agent-release", { token });
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

      const hbRes = await authRequest(testApp.app, "POST", "/api/v1/auth/agent-heartbeat", { token });
      expect(hbRes.status).toBe(200);

      // Verify claim still exists
      const claims = testApp.db.select().from(agentClaims)
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
      const detailRes = await authRequest(testApp.app, "GET", `/api/v1/auth/agent-pools/${pool.id}`);
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
      const rows = testApp.db
        .select()
        .from(agentClaims)
        .where(eq(agentClaims.userId, id))
        .all();
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
      const leaseRow = testApp.db.select().from(claimLeases).where(eq(claimLeases.id, leaseId)).get();
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

    it("[correction 1] a keyed-bound agent is NOT grabbable by a keyless claim, even after its claim TTL expires", async () => {
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

    it("[correction 1] a keyed-bound agent is NOT grabbable by another key's first-bind, even after expiry", async () => {
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
