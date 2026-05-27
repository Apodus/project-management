import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { AppVariables } from "../types.js";
import * as authService from "../services/auth.service.js";

/**
 * Routes that do not require authentication.
 * - /health is the health check endpoint
 * - /api/v1/auth/* covers login, setup, etc.
 * - /api/v1/openapi.json and /api/v1/docs are API documentation
 */
function isPublicRoute(path: string): boolean {
  if (path === "/health") return true;
  if (path.startsWith("/api/v1/auth/")) return true;
  if (path === "/api/v1/auth") return true;
  if (path === "/api/v1/openapi.json") return true;
  if (path === "/api/v1/docs") return true;
  if (path.startsWith("/api/v1/webhooks/")) return true;
  return false;
}

/**
 * Auth middleware.
 *
 * Validates the auth token from either:
 *   1. Authorization: Bearer <token> header (API token)
 *   2. pm_session cookie (session token)
 *
 * Public routes are exempt from authentication.
 * For protected routes, returns 401 if no valid auth is found.
 */
export const authMiddleware = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  const path = new URL(c.req.url).pathname;

  // Public routes skip auth
  if (isPublicRoute(path)) {
    c.set("authToken", null);
    c.set("currentUser", null);
    await next();
    return;
  }

  let token: string | null = null;

  // Check Authorization header first
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  // Try API token validation
  if (token) {
    const user = await authService.validateApiToken(token);
    if (user) {
      c.set("authToken", token);
      c.set("currentUser", user);
      await next();
      return;
    }
  }

  // Fall back to session cookie
  const sessionCookie = getCookie(c, "pm_session");
  if (sessionCookie) {
    const user = await authService.validateSession(sessionCookie);
    if (user) {
      c.set("authToken", sessionCookie);
      c.set("currentUser", user);
      await next();
      return;
    }
  }

  // If we had a token from the header but it didn't match API tokens,
  // also try it as a session token (for flexibility)
  if (token && !sessionCookie) {
    const user = await authService.validateSession(token);
    if (user) {
      c.set("authToken", token);
      c.set("currentUser", user);
      await next();
      return;
    }
  }

  // No valid auth found
  return c.json(
    {
      error: {
        code: "UNAUTHORIZED",
        message: "Valid authentication required",
      },
    },
    401,
  );
});
