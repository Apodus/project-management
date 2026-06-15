import { describe, it, expect, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import { createTestApp, createTestUser, authRequest, type TestApp } from "./utils.js";
import { users, sessions } from "../src/db/index.js";
import { eq } from "drizzle-orm";
import { createId } from "@pm/shared";
import * as authService from "../src/services/auth.service.js";

describe("Auth", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── API Token auth ────────────────────────────────────────────────
  describe("API token authentication", () => {
    it("should authenticate with a valid API token", async () => {
      const res = await authRequest(testApp.app, "GET", "/api/v1/projects");
      expect(res.status).toBe(200);
    });

    it("should reject requests with an invalid API token", async () => {
      const res = await authRequest(testApp.app, "GET", "/api/v1/projects", {
        token: "completely-invalid-token",
      });
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(body.error.message).toBe("Valid authentication required");
    });

    it("should reject requests with no auth at all", async () => {
      const res = await testApp.app.request("/api/v1/projects");
      expect(res.status).toBe(401);
    });

    it("should reject tokens for inactive users", async () => {
      // Create an inactive user with a known token
      const inactiveUser = createTestUser(testApp.db, {
        username: "inactive-user",
      });
      const rawToken = "inactive-user-token-value";
      const hash = bcrypt.hashSync(rawToken, 10);

      testApp.db
        .update(users)
        .set({ apiTokenHash: hash, isActive: false })
        .where(eq(users.id, inactiveUser.id))
        .run();

      const res = await authRequest(testApp.app, "GET", "/api/v1/projects", {
        token: rawToken,
      });
      expect(res.status).toBe(401);
    });
  });

  // ── Session auth ──────────────────────────────────────────────────
  describe("Session authentication", () => {
    it("should authenticate with a valid session cookie", async () => {
      // Create a session for the test user
      const session = await authService.createSession(testApp.testUser.id);

      const res = await testApp.app.request("/api/v1/projects", {
        headers: {
          Cookie: `pm_session=${session.token}`,
        },
      });
      expect(res.status).toBe(200);
    });

    it("should reject expired sessions", async () => {
      // Directly insert an expired session
      const rawToken = "expired-session-token";
      const hash = bcrypt.hashSync(rawToken, 10);
      const pastDate = new Date(Date.now() - 1000).toISOString();

      testApp.db
        .insert(sessions)
        .values({
          id: createId(),
          userId: testApp.testUser.id,
          tokenHash: hash,
          expiresAt: pastDate,
          createdAt: new Date().toISOString(),
        })
        .run();

      const res = await testApp.app.request("/api/v1/projects", {
        headers: {
          Cookie: `pm_session=${rawToken}`,
        },
      });
      expect(res.status).toBe(401);
    });

    it("should reject invalid session tokens", async () => {
      const res = await testApp.app.request("/api/v1/projects", {
        headers: {
          Cookie: "pm_session=invalid-session-token",
        },
      });
      expect(res.status).toBe(401);
    });
  });

  // ── Public routes ─────────────────────────────────────────────────
  describe("Public routes", () => {
    it("/health should not require authentication", async () => {
      const res = await testApp.app.request("/health");
      expect(res.status).toBe(200);
    });

    it("/api/v1/openapi.json should not require authentication", async () => {
      const res = await testApp.app.request("/api/v1/openapi.json");
      expect(res.status).toBe(200);
    });

    it("/api/v1/docs should not require authentication", async () => {
      const res = await testApp.app.request("/api/v1/docs");
      expect(res.status).toBe(200);
    });

    it("/api/v1/auth/* routes should not require authentication", async () => {
      // These routes don't exist yet but the middleware should skip auth
      const res = await testApp.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      // Should not be 401 — will be 404 since route isn't implemented yet
      expect(res.status).not.toBe(401);
    });
  });

  // ── Auth service unit tests ───────────────────────────────────────
  describe("Auth service", () => {
    it("generateToken should return a 64-char hex string", () => {
      const token = authService.generateToken();
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("hashToken and compareToken should work together", async () => {
      const raw = "my-secret-token";
      const hash = await authService.hashToken(raw);
      expect(hash).not.toBe(raw);
      expect(await authService.compareToken(raw, hash)).toBe(true);
      expect(await authService.compareToken("wrong-token", hash)).toBe(false);
    });

    it("createApiToken should store hash and return raw token", async () => {
      const user = createTestUser(testApp.db, { username: "api-token-user" });
      const token = await authService.createApiToken(user.id);

      expect(token).toHaveLength(64);

      // Verify hash is stored in DB
      const dbUser = testApp.db.select().from(users).where(eq(users.id, user.id)).get();
      expect(dbUser?.apiTokenHash).toBeDefined();
      expect(dbUser?.apiTokenHash).not.toBe(token);

      // Verify the stored hash matches the raw token
      const matches = await authService.compareToken(token, dbUser!.apiTokenHash!);
      expect(matches).toBe(true);
    });

    it("validateApiToken should return user for valid token", async () => {
      const user = createTestUser(testApp.db, { username: "validate-user" });
      const token = await authService.createApiToken(user.id);

      const result = await authService.validateApiToken(token);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(user.id);
      expect(result!.username).toBe(user.username);
    });

    it("validateApiToken should return null for invalid token", async () => {
      const result = await authService.validateApiToken("nonexistent-token");
      expect(result).toBeNull();
    });

    it("createSession should return token and expiry", async () => {
      const session = await authService.createSession(testApp.testUser.id);
      expect(session.token).toHaveLength(64);
      expect(session.expiresAt).toBeDefined();

      // Expiry should be ~7 days from now
      const expiresAt = new Date(session.expiresAt);
      const now = new Date();
      const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(6.9);
      expect(diffDays).toBeLessThan(7.1);
    });

    it("validateSession should return user for valid session", async () => {
      const session = await authService.createSession(testApp.testUser.id);
      const user = await authService.validateSession(session.token);

      expect(user).not.toBeNull();
      expect(user!.id).toBe(testApp.testUser.id);
    });

    it("validateSession should return null for invalid token", async () => {
      const user = await authService.validateSession("nonexistent-session");
      expect(user).toBeNull();
    });

    it("deleteSession should remove the session", async () => {
      const session = await authService.createSession(testApp.testUser.id);

      // Verify session works first
      const userBefore = await authService.validateSession(session.token);
      expect(userBefore).not.toBeNull();

      // Delete it
      await authService.deleteSession(session.token);

      // Verify session no longer works
      const userAfter = await authService.validateSession(session.token);
      expect(userAfter).toBeNull();
    });

    it("cleanExpiredSessions should remove expired sessions", async () => {
      // Insert an expired session directly
      const hash = bcrypt.hashSync("expired-token", 10);
      testApp.db
        .insert(sessions)
        .values({
          id: createId(),
          userId: testApp.testUser.id,
          tokenHash: hash,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          createdAt: new Date().toISOString(),
        })
        .run();

      // Insert a valid session
      const validSession = await authService.createSession(testApp.testUser.id);

      // Count sessions before cleanup
      const before = testApp.db.select().from(sessions).all();
      expect(before.length).toBe(2);

      // Clean up
      authService.cleanExpiredSessions();

      // Only the valid session should remain
      const after = testApp.db.select().from(sessions).all();
      expect(after.length).toBe(1);

      // The valid session should still work
      const user = await authService.validateSession(validSession.token);
      expect(user).not.toBeNull();
    });
  });
});
