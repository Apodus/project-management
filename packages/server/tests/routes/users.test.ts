import { describe, it, expect, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import { createTestApp, createTestUser, authRequest, type TestApp } from "../utils.js";
import { users } from "../../src/db/index.js";
import { eq } from "drizzle-orm";

describe("User routes", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Helper: create a non-admin user with a token ─────────────────

  function createMemberToken(): { userId: string; token: string } {
    const member = createTestUser(testApp.db, {
      username: "member-user",
      role: "member",
    });
    const rawToken = "member-token-value";
    const hash = bcrypt.hashSync(rawToken, 10);
    testApp.db.update(users).set({ apiTokenHash: hash }).where(eq(users.id, member.id)).run();
    return { userId: member.id, token: rawToken };
  }

  // ── GET /api/v1/users ─────────────────────────────────────────────

  describe("GET /api/v1/users", () => {
    it("should list all users for admin", async () => {
      // Create an additional user
      createTestUser(testApp.db, { username: "extra-user" });

      const res = await authRequest(testApp.app, "GET", "/api/v1/users");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(2);

      // Should not include sensitive fields
      for (const user of body.data) {
        expect(user.passwordHash).toBeUndefined();
        expect(user.apiTokenHash).toBeUndefined();
        expect(user.id).toBeDefined();
        expect(user.username).toBeDefined();
      }
    });

    it("should return 403 for non-admin users", async () => {
      const { token } = createMemberToken();
      const res = await authRequest(testApp.app, "GET", "/api/v1/users", {
        token,
      });
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("should return 401 for unauthenticated requests", async () => {
      const res = await testApp.app.request("/api/v1/users");
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/v1/users ────────────────────────────────────────────

  describe("POST /api/v1/users", () => {
    it("should create a human user with password", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/users", {
        body: {
          username: "new-human",
          displayName: "New Human",
          email: "human@example.com",
          password: "securepassword",
          role: "member",
          type: "human",
        },
      });

      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.username).toBe("new-human");
      expect(body.data.displayName).toBe("New Human");
      expect(body.data.email).toBe("human@example.com");
      expect(body.data.role).toBe("member");
      expect(body.data.type).toBe("human");
      expect(body.data.isActive).toBe(true);
      // Human users should NOT have apiToken in response
      expect(body.data.apiToken).toBeUndefined();
      // Should not expose sensitive fields
      expect(body.data.passwordHash).toBeUndefined();
      expect(body.data.apiTokenHash).toBeUndefined();
    });

    it("should create an AI agent user and return api_token", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/users", {
        body: {
          username: "ai-agent-1",
          displayName: "AI Agent 1",
          role: "member",
          type: "ai_agent",
        },
      });

      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.username).toBe("ai-agent-1");
      expect(body.data.type).toBe("ai_agent");
      // AI agent should have apiToken returned
      expect(body.data.apiToken).toBeDefined();
      expect(typeof body.data.apiToken).toBe("string");
      expect(body.data.apiToken.length).toBe(64); // 32 bytes hex
    });

    it("should fail with 409 for duplicate username", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/users", {
        body: {
          username: testApp.testUser.username, // Already exists
          displayName: "Duplicate",
          password: "password123",
          role: "member",
          type: "human",
        },
      });

      expect(res.status).toBe(409);

      const body = await res.json();
      expect(body.error.code).toBe("DUPLICATE_USERNAME");
    });

    it("should fail with 400 if human user has no password", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/users", {
        body: {
          username: "no-password-human",
          displayName: "No Password",
          role: "member",
          type: "human",
        },
      });

      expect(res.status).toBe(400);
    });

    it("should fail with 403 for non-admin users", async () => {
      const { token } = createMemberToken();
      const res = await authRequest(testApp.app, "POST", "/api/v1/users", {
        token,
        body: {
          username: "forbidden-user",
          displayName: "Forbidden",
          password: "password123",
          role: "member",
          type: "human",
        },
      });

      expect(res.status).toBe(403);
    });
  });

  // ── PATCH /api/v1/users/:id ───────────────────────────────────────

  describe("PATCH /api/v1/users/:id", () => {
    it("should update user fields", async () => {
      const user = createTestUser(testApp.db, {
        username: "update-target",
        displayName: "Original Name",
      });

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/users/${user.id}`, {
        body: {
          displayName: "Updated Name",
          email: "updated@example.com",
        },
      });

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.displayName).toBe("Updated Name");
      expect(body.data.email).toBe("updated@example.com");
      expect(body.data.username).toBe("update-target"); // Unchanged
    });

    it("should return 404 for non-existent user", async () => {
      const res = await authRequest(testApp.app, "PATCH", "/api/v1/users/nonexistent-id", {
        body: {
          displayName: "Ghost User",
        },
      });

      expect(res.status).toBe(404);
    });

    it("should return 409 for duplicate username on update", async () => {
      const user = createTestUser(testApp.db, {
        username: "user-to-rename",
      });

      const res = await authRequest(testApp.app, "PATCH", `/api/v1/users/${user.id}`, {
        body: {
          username: testApp.testUser.username, // Already taken
        },
      });

      expect(res.status).toBe(409);
    });
  });

  // ── POST /api/v1/users/:id/rotate-token ───────────────────────────

  describe("POST /api/v1/users/:id/rotate-token", () => {
    it("should return a new token and invalidate the old one", async () => {
      // Create an AI agent user with a token
      const createRes = await authRequest(testApp.app, "POST", "/api/v1/users", {
        body: {
          username: "rotate-agent",
          displayName: "Rotate Agent",
          role: "member",
          type: "ai_agent",
        },
      });
      expect(createRes.status).toBe(201);

      const createBody = await createRes.json();
      const userId = createBody.data.id;
      const oldToken = createBody.data.apiToken;

      // Verify old token works
      const verifyOld = await authRequest(testApp.app, "GET", "/api/v1/projects", {
        token: oldToken,
      });
      expect(verifyOld.status).toBe(200);

      // Rotate the token
      const rotateRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/users/${userId}/rotate-token`,
      );
      expect(rotateRes.status).toBe(200);

      const rotateBody = await rotateRes.json();
      const newToken = rotateBody.data.apiToken;

      expect(newToken).toBeDefined();
      expect(typeof newToken).toBe("string");
      expect(newToken.length).toBe(64);
      expect(newToken).not.toBe(oldToken);

      // Verify new token works
      const verifyNew = await authRequest(testApp.app, "GET", "/api/v1/projects", {
        token: newToken,
      });
      expect(verifyNew.status).toBe(200);

      // Verify old token no longer works
      const verifyOldAgain = await authRequest(testApp.app, "GET", "/api/v1/projects", {
        token: oldToken,
      });
      expect(verifyOldAgain.status).toBe(401);
    });

    it("should return 404 for non-existent user", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/users/nonexistent-id/rotate-token",
      );

      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/users/:id/deactivate ─────────────────────────────

  describe("POST /api/v1/users/:id/deactivate", () => {
    it("should deactivate a user", async () => {
      const user = createTestUser(testApp.db, {
        username: "deactivate-me",
      });

      const res = await authRequest(testApp.app, "POST", `/api/v1/users/${user.id}/deactivate`);

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.isActive).toBe(false);
    });

    it("should return 404 for non-existent user", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/users/nonexistent-id/deactivate");

      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/v1/users/:id/activate ───────────────────────────────

  describe("POST /api/v1/users/:id/activate", () => {
    it("should activate a deactivated user", async () => {
      const user = createTestUser(testApp.db, {
        username: "activate-me",
      });

      // Deactivate first
      testApp.db.update(users).set({ isActive: false }).where(eq(users.id, user.id)).run();

      const res = await authRequest(testApp.app, "POST", `/api/v1/users/${user.id}/activate`);

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.isActive).toBe(true);
    });

    it("should return 404 for non-existent user", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/users/nonexistent-id/activate");

      expect(res.status).toBe(404);
    });
  });
});
