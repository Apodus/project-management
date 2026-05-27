import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { AppVariables } from "../types.js";

/**
 * Auth middleware stub.
 *
 * Extracts the auth token from either:
 *   1. Authorization: Bearer <token> header
 *   2. pm_session cookie
 *
 * Attaches the token to context. Does NOT validate yet —
 * actual validation will be added in a later step.
 * Sets currentUser to null for now.
 */
export const authMiddleware = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  let token: string | null = null;

  // Check Authorization header first
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  // Fall back to session cookie
  if (!token) {
    const sessionCookie = getCookie(c, "pm_session");
    if (sessionCookie) {
      token = sessionCookie;
    }
  }

  c.set("authToken", token);
  c.set("currentUser", null);

  await next();
});
