import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestProject,
  authRequest,
  type TestApp,
} from "./utils.js";
import { AppError } from "../src/types.js";

describe("App foundation", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Health endpoint ───────────────────────────────────────────────
  describe("GET /health", () => {
    it("should return 200 with status ok", async () => {
      const res = await testApp.app.request("/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeDefined();
      // Verify it's a valid ISO date
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    });
  });

  // ── Request ID middleware ──────────────────────────────────────────
  describe("Request ID middleware", () => {
    it("should set X-Request-Id header on response", async () => {
      const res = await testApp.app.request("/health");
      const requestId = res.headers.get("X-Request-Id");
      expect(requestId).toBeDefined();
      expect(requestId!.length).toBeGreaterThan(0);
      // ULIDs are 26 chars
      expect(requestId!.length).toBe(26);
    });

    it("should generate unique request IDs for each request", async () => {
      const res1 = await testApp.app.request("/health");
      const res2 = await testApp.app.request("/health");
      const id1 = res1.headers.get("X-Request-Id");
      const id2 = res2.headers.get("X-Request-Id");
      expect(id1).not.toBe(id2);
    });
  });

  // ── Error handling ────────────────────────────────────────────────
  describe("Error handling", () => {
    it("should return structured error for AppError thrown in a handler", async () => {
      // Register a test route that throws an AppError
      testApp.app.get("/test-error", () => {
        throw new AppError(422, "VALIDATION_ERROR", "Name is required");
      });

      const res = await testApp.app.request("/test-error");
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("Name is required");
    });

    it("should return 500 for unexpected errors thrown in a handler", async () => {
      testApp.app.get("/test-unexpected-error", () => {
        throw new Error("Something broke");
      });

      const res = await testApp.app.request("/test-unexpected-error");
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
      expect(body.error.message).toBe("An unexpected error occurred");
    });

    it("should return 404 with error envelope for unknown routes", async () => {
      const res = await testApp.app.request("/nonexistent");
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toContain("Route not found");
      expect(body.error.message).toContain("/nonexistent");
    });

    it("should return 404 for unknown API routes", async () => {
      const res = await authRequest(testApp.app, "GET", "/api/v1/nonexistent");
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("should include request ID in error responses", async () => {
      const res = await testApp.app.request("/nonexistent");
      expect(res.headers.get("X-Request-Id")).toBeDefined();
    });
  });

  // ── CORS ──────────────────────────────────────────────────────────
  describe("CORS", () => {
    it("should include CORS headers for allowed origins", async () => {
      const res = await testApp.app.request("/health", {
        headers: { Origin: "http://localhost:5173" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:5173",
      );
    });

    it("should expose X-Request-Id header via CORS", async () => {
      const res = await testApp.app.request("/health", {
        headers: { Origin: "http://localhost:5173" },
      });
      const exposed = res.headers.get("Access-Control-Expose-Headers");
      expect(exposed).toContain("X-Request-Id");
    });

    it("should handle preflight OPTIONS requests", async () => {
      const res = await testApp.app.request("/api/v1/anything", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type, Authorization",
        },
      });
      // CORS middleware should return 204 for preflight
      expect(res.status).toBeLessThanOrEqual(204);
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    });
  });

  // ── Auth middleware ────────────────────────────────────────────────
  describe("Auth middleware", () => {
    it("should accept requests without auth on public routes", async () => {
      const res = await testApp.app.request("/health");
      expect(res.status).toBe(200);
    });

    it("should accept requests with valid Bearer token on API routes", async () => {
      const res = await authRequest(testApp.app, "GET", "/api/v1/test-route");
      // 404 because the route doesn't exist, but NOT 401
      expect(res.status).toBe(404);
    });

    it("should return 401 for unauthenticated API requests", async () => {
      const res = await testApp.app.request("/api/v1/projects");
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(body.error.message).toBe("Valid authentication required");
    });

    it("should return 401 for invalid Bearer token", async () => {
      const res = await authRequest(testApp.app, "GET", "/api/v1/projects", {
        token: "invalid-token-that-does-not-exist",
      });
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("should allow /health without auth", async () => {
      const res = await testApp.app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    });

    it("should allow /api/v1/openapi.json without auth", async () => {
      const res = await testApp.app.request("/api/v1/openapi.json");
      expect(res.status).toBe(200);
    });

    it("should allow /api/v1/docs without auth", async () => {
      const res = await testApp.app.request("/api/v1/docs");
      expect(res.status).toBe(200);
    });
  });

  // ── OpenAPI spec ──────────────────────────────────────────────────
  describe("GET /api/v1/openapi.json", () => {
    it("should return valid OpenAPI JSON", async () => {
      const res = await testApp.app.request("/api/v1/openapi.json");
      expect(res.status).toBe(200);

      const spec = await res.json();
      expect(spec.openapi).toBe("3.1.0");
      expect(spec.info).toBeDefined();
      expect(spec.info.title).toBe("Project Management API");
      expect(spec.info.version).toBe("0.1.0");
    });

    it("should include the /health path in the spec", async () => {
      const res = await testApp.app.request("/api/v1/openapi.json");
      const spec = await res.json();
      expect(spec.paths).toBeDefined();
      expect(spec.paths["/health"]).toBeDefined();
    });
  });

  // ── OpenAPI docs UI ───────────────────────────────────────────────
  describe("GET /api/v1/docs", () => {
    it("should return HTML for the API docs page", async () => {
      const res = await testApp.app.request("/api/v1/docs");
      expect(res.status).toBe(200);
      const contentType = res.headers.get("Content-Type");
      expect(contentType).toContain("text/html");

      const html = await res.text();
      expect(html).toContain("</html>");
    });
  });

  // ── Test utilities ────────────────────────────────────────────────
  describe("Test utilities", () => {
    it("createTestUser should insert a user into the database", () => {
      const user = createTestUser(testApp.db);
      expect(user.id).toBeDefined();
      expect(user.username).toBeDefined();
      expect(user.displayName).toBeDefined();
      expect(user.role).toBe("admin");
      expect(user.type).toBe("human");
    });

    it("createTestUser should accept overrides", () => {
      const user = createTestUser(testApp.db, {
        username: "alice",
        displayName: "Alice",
        role: "member",
        type: "ai_agent",
      });
      expect(user.username).toBe("alice");
      expect(user.displayName).toBe("Alice");
      expect(user.role).toBe("member");
      expect(user.type).toBe("ai_agent");
    });

    it("createTestProject should insert a project into the database", () => {
      const project = createTestProject(testApp.db);
      expect(project.id).toBeDefined();
      expect(project.workspaceId).toBeDefined();
      expect(project.name).toBeDefined();
      expect(project.slug).toBeDefined();
      expect(project.status).toBe("active");
    });

    it("createTestProject should accept overrides", () => {
      const user = createTestUser(testApp.db);
      const project = createTestProject(testApp.db, {
        name: "Custom Project",
        slug: "custom-project",
        status: "paused",
        createdBy: user.id,
      });
      expect(project.name).toBe("Custom Project");
      expect(project.slug).toBe("custom-project");
      expect(project.status).toBe("paused");
    });

    it("authRequest should set the Authorization header", async () => {
      const res = await authRequest(testApp.app, "GET", "/health", {
        token: "my-token",
      });
      expect(res.status).toBe(200);
    });
  });
});
