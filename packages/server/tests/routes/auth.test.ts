import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  type TestApp,
} from "../utils.js";
import { users } from "../../src/db/index.js";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

describe("Auth routes", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Setup status ─────────────────────────────────────────────────

  describe("GET /api/v1/auth/setup/status", () => {
    it("should return needsSetup=false when users exist", async () => {
      // createTestApp already creates a user
      const res = await testApp.app.request("/api/v1/auth/setup/status");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.needsSetup).toBe(false);
    });

    it("should return needsSetup=true when no users exist", async () => {
      // Delete all users
      testApp.db.delete(users).run();

      const res = await testApp.app.request("/api/v1/auth/setup/status");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.needsSetup).toBe(true);
    });

    it("should not require authentication", async () => {
      const res = await testApp.app.request("/api/v1/auth/setup/status");
      expect(res.status).toBe(200);
    });
  });

  // ── Setup ────────────────────────────────────────────────────────

  describe("POST /api/v1/auth/setup", () => {
    it("should create admin user and return user data + cookie when no users exist", async () => {
      // Delete all users first
      testApp.db.delete(users).run();

      const res = await testApp.app.request("/api/v1/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          displayName: "Admin User",
          password: "securepassword123",
        }),
      });

      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.username).toBe("admin");
      expect(body.data.displayName).toBe("Admin User");
      expect(body.data.role).toBe("admin");
      expect(body.data.type).toBe("human");
      expect(body.data.isActive).toBe(true);
      // Should not expose sensitive fields
      expect(body.data.passwordHash).toBeUndefined();
      expect(body.data.apiTokenHash).toBeUndefined();

      // Should set session cookie
      const setCookieHeader = res.headers.get("set-cookie");
      expect(setCookieHeader).toBeDefined();
      expect(setCookieHeader).toContain("pm_session=");
      expect(setCookieHeader).toContain("HttpOnly");
      expect(setCookieHeader).toContain("SameSite=Strict");
    });

    it("should fail with 409 if users already exist", async () => {
      // createTestApp already created a user
      const res = await testApp.app.request("/api/v1/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin2",
          displayName: "Admin 2",
          password: "password123",
        }),
      });

      expect(res.status).toBe(409);

      const body = await res.json();
      expect(body.error.code).toBe("SETUP_COMPLETE");
    });

    it("should not require authentication", async () => {
      testApp.db.delete(users).run();

      const res = await testApp.app.request("/api/v1/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          displayName: "Admin User",
          password: "password",
        }),
      });

      // Should succeed, not return 401
      expect(res.status).toBe(201);
    });
  });

  // ── Login ────────────────────────────────────────────────────────

  describe("POST /api/v1/auth/login", () => {
    it("should login with valid credentials and return user + cookie", async () => {
      // Create a user with a known password
      const passwordHash = bcrypt.hashSync("mypassword", 10);
      testApp.db
        .update(users)
        .set({ passwordHash })
        .where(eq(users.id, testApp.testUser.id))
        .run();

      const res = await testApp.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: testApp.testUser.username,
          password: "mypassword",
        }),
      });

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.username).toBe(testApp.testUser.username);
      expect(body.data.id).toBe(testApp.testUser.id);

      // Should set session cookie
      const setCookieHeader = res.headers.get("set-cookie");
      expect(setCookieHeader).toBeDefined();
      expect(setCookieHeader).toContain("pm_session=");
    });

    it("should reject invalid password with 401", async () => {
      const passwordHash = bcrypt.hashSync("correctpassword", 10);
      testApp.db
        .update(users)
        .set({ passwordHash })
        .where(eq(users.id, testApp.testUser.id))
        .run();

      const res = await testApp.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: testApp.testUser.username,
          password: "wrongpassword",
        }),
      });

      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("should reject nonexistent user with 401", async () => {
      const res = await testApp.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "doesnotexist",
          password: "somepassword",
        }),
      });

      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("should reject inactive user with 401", async () => {
      const passwordHash = bcrypt.hashSync("password123", 10);
      testApp.db
        .update(users)
        .set({ passwordHash, isActive: false })
        .where(eq(users.id, testApp.testUser.id))
        .run();

      const res = await testApp.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: testApp.testUser.username,
          password: "password123",
        }),
      });

      expect(res.status).toBe(401);
    });
  });

  // ── Logout ───────────────────────────────────────────────────────

  describe("POST /api/v1/auth/logout", () => {
    it("should clear session and cookie", async () => {
      // First login to get a session
      const passwordHash = bcrypt.hashSync("logouttest", 10);
      testApp.db
        .update(users)
        .set({ passwordHash })
        .where(eq(users.id, testApp.testUser.id))
        .run();

      const loginRes = await testApp.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: testApp.testUser.username,
          password: "logouttest",
        }),
      });
      expect(loginRes.status).toBe(200);

      // Extract the session cookie
      const setCookieHeader = loginRes.headers.get("set-cookie")!;
      const sessionToken = setCookieHeader
        .split("pm_session=")[1]
        .split(";")[0];

      // Logout using the cookie
      const logoutRes = await testApp.app.request("/api/v1/auth/logout", {
        method: "POST",
        headers: {
          Cookie: `pm_session=${sessionToken}`,
        },
      });

      expect(logoutRes.status).toBe(200);

      const body = await logoutRes.json();
      expect(body.data.message).toBe("Logged out successfully");

      // Session should be invalid now
      const meRes = await testApp.app.request("/api/v1/auth/me", {
        headers: {
          Cookie: `pm_session=${sessionToken}`,
        },
      });
      expect(meRes.status).toBe(401);
    });

    it("should return 401 when not authenticated", async () => {
      const res = await testApp.app.request("/api/v1/auth/logout", {
        method: "POST",
      });

      expect(res.status).toBe(401);
    });
  });

  // ── Me ───────────────────────────────────────────────────────────

  describe("GET /api/v1/auth/me", () => {
    it("should return current user when authenticated via Bearer token", async () => {
      const res = await testApp.app.request("/api/v1/auth/me", {
        headers: {
          Authorization: `Bearer ${testApp.testToken}`,
        },
      });

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.id).toBe(testApp.testUser.id);
      expect(body.data.username).toBe(testApp.testUser.username);
      expect(body.data.displayName).toBe(testApp.testUser.displayName);
      expect(body.data.role).toBe("admin");
      expect(body.data.type).toBe("human");
      // Should not have sensitive fields
      expect(body.data.passwordHash).toBeUndefined();
      expect(body.data.apiTokenHash).toBeUndefined();
    });

    it("should return current user when authenticated via session cookie", async () => {
      // Create a session
      const passwordHash = bcrypt.hashSync("metest", 10);
      testApp.db
        .update(users)
        .set({ passwordHash })
        .where(eq(users.id, testApp.testUser.id))
        .run();

      const loginRes = await testApp.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: testApp.testUser.username,
          password: "metest",
        }),
      });
      const setCookieHeader = loginRes.headers.get("set-cookie")!;
      const sessionToken = setCookieHeader
        .split("pm_session=")[1]
        .split(";")[0];

      const res = await testApp.app.request("/api/v1/auth/me", {
        headers: {
          Cookie: `pm_session=${sessionToken}`,
        },
      });

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.id).toBe(testApp.testUser.id);
    });

    it("should return 401 when not authenticated", async () => {
      const res = await testApp.app.request("/api/v1/auth/me");
      expect(res.status).toBe(401);
    });
  });
});
