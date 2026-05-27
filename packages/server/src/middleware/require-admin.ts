import { createMiddleware } from "hono/factory";
import type { AppVariables } from "../types.js";

/**
 * Middleware that requires the authenticated user to have the "admin" role.
 * Must be used AFTER the auth middleware (which sets currentUser).
 * Returns 403 Forbidden if the user is not an admin.
 */
export const requireAdmin = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  const user = c.get("currentUser");

  if (!user) {
    return c.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Valid authentication required",
        },
      },
      401,
    );
  }

  if (user.role !== "admin") {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Admin access required",
        },
      },
      403,
    );
  }

  await next();
});
