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
import { agentClaims } from "../../src/db/index.js";
import { eq } from "drizzle-orm";

// Set the pool secret env var for tests
const TEST_POOL_SECRET = "test-pool-secret-12345";

describe("Agent Pool", () => {
  let testApp: TestApp;

  beforeEach(() => {
    process.env.PM_POOL_SECRET = TEST_POOL_SECRET;
    testApp = createTestApp();
  });

  afterEach(() => {
    delete process.env.PM_POOL_SECRET;
    testApp.cleanup();
  });

  // ── POST /api/v1/auth/agent-claim ──────────────────────────────

  describe("POST /api/v1/auth/agent-claim", () => {
    it("should claim an available AI agent", async () => {
      // Create an AI agent in the pool
      const agent = createTestAiAgent(testApp.db, { username: "agent-alpha" });

      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: TEST_POOL_SECRET }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.user.id).toBe(agent.user.id);
      expect(body.data.user.username).toBe("agent-alpha");
      expect(body.data.token).toBeTruthy();
      expect(typeof body.data.token).toBe("string");
    });

    it("should return 503 when no agents are available", async () => {
      // No AI agents created
      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: TEST_POOL_SECRET }),
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe("NO_AGENTS_AVAILABLE");
    });

    it("should reject invalid pool secret", async () => {
      createTestAiAgent(testApp.db);

      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: "wrong-secret" }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_POOL_SECRET");
    });

    it("should not double-assign the same agent", async () => {
      const agent = createTestAiAgent(testApp.db, { username: "agent-solo" });

      // First claim
      const res1 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: TEST_POOL_SECRET }),
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.data.user.id).toBe(agent.user.id);

      // Second claim should fail (no more agents)
      const res2 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: TEST_POOL_SECRET }),
      });
      expect(res2.status).toBe(503);
    });

    it("should claim different agents for concurrent requests", async () => {
      createTestAiAgent(testApp.db, { username: "agent-alpha" });
      createTestAiAgent(testApp.db, { username: "agent-beta" });

      // Claim first
      const res1 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: TEST_POOL_SECRET }),
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();

      // Claim second
      const res2 = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: TEST_POOL_SECRET }),
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json();

      // Should be different agents
      expect(body1.data.user.id).not.toBe(body2.data.user.id);
    });

    it("should reclaim an agent with an expired claim", async () => {
      const agent = createTestAiAgent(testApp.db, { username: "agent-reclaim" });

      // Create an expired claim directly in the database
      const expiredTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
      testApp.db.insert(agentClaims).values({
        id: "expired-claim-id",
        userId: agent.user.id,
        claimedAt: expiredTime,
        expiresAt: expiredTime,
        heartbeatAt: expiredTime,
      }).run();

      // Should be able to claim since the existing claim is expired
      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: TEST_POOL_SECRET }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.user.id).toBe(agent.user.id);
    });

    it("should not claim inactive agents", async () => {
      const agent = createTestAiAgent(testApp.db, { username: "agent-inactive" });
      // Deactivate the agent
      testApp.db.update(
        (await import("../../src/db/index.js")).users,
      ).set({ isActive: false }).where(
        eq((await import("../../src/db/index.js")).users.id, agent.user.id),
      ).run();

      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: TEST_POOL_SECRET }),
      });
      expect(res.status).toBe(503);
    });

    it("should return 503 when PM_POOL_SECRET is not configured", async () => {
      delete process.env.PM_POOL_SECRET;
      createTestAiAgent(testApp.db);

      const res = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: "anything" }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe("POOL_NOT_CONFIGURED");
    });
  });

  // ── POST /api/v1/auth/agent-release ────────────────────────────

  describe("POST /api/v1/auth/agent-release", () => {
    it("should release a claimed agent", async () => {
      const agent = createTestAiAgent(testApp.db, { username: "agent-release" });

      // Claim the agent
      const claimRes = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: TEST_POOL_SECRET }),
      });
      expect(claimRes.status).toBe(200);
      const claimBody = await claimRes.json();
      const token = claimBody.data.token;

      // Release the agent
      const releaseRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/auth/agent-release",
        { token },
      );
      expect(releaseRes.status).toBe(200);

      // Agent should now be available again
      const reclaimRes = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: TEST_POOL_SECRET }),
      });
      expect(reclaimRes.status).toBe(200);
      const reclaimBody = await reclaimRes.json();
      expect(reclaimBody.data.user.id).toBe(agent.user.id);
    });
  });

  // ── POST /api/v1/auth/agent-heartbeat ──────────────────────────

  describe("POST /api/v1/auth/agent-heartbeat", () => {
    it("should extend claim TTL", async () => {
      const agent = createTestAiAgent(testApp.db, { username: "agent-hb" });

      // Claim
      const claimRes = await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: TEST_POOL_SECRET }),
      });
      const claimBody = await claimRes.json();
      const token = claimBody.data.token;

      // Heartbeat
      const hbRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/auth/agent-heartbeat",
        { token },
      );
      expect(hbRes.status).toBe(200);

      // Verify claim still exists
      const claims = testApp.db.select().from(agentClaims)
        .where(eq(agentClaims.userId, agent.user.id))
        .all();
      expect(claims.length).toBe(1);
      // Heartbeat should have updated the timestamps
      expect(claims[0].heartbeatAt).toBeTruthy();
    });

    it("should return 404 for user with no claim", async () => {
      // Use the default test admin user (who has no claim)
      const hbRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/auth/agent-heartbeat",
      );
      expect(hbRes.status).toBe(404);
    });
  });

  // ── GET /api/v1/auth/agent-pool ────────────────────────────────

  describe("GET /api/v1/auth/agent-pool", () => {
    it("should return pool status for admin", async () => {
      createTestAiAgent(testApp.db, { username: "agent-alpha" });
      createTestAiAgent(testApp.db, { username: "agent-beta" });

      // Claim one
      await testApp.app.request("/api/v1/auth/agent-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolSecret: TEST_POOL_SECRET }),
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/auth/agent-pool",
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBe(2);

      const claimed = body.data.filter((a: any) => a.claimed);
      const available = body.data.filter((a: any) => !a.claimed);
      expect(claimed.length).toBe(1);
      expect(available.length).toBe(1);
    });

    it("should return 403 for non-admin", async () => {
      const agent = createTestAiAgent(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/auth/agent-pool",
        { token: agent.token },
      );
      expect(res.status).toBe(403);
    });
  });
});
