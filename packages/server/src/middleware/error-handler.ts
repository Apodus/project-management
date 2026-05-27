import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError } from "../types.js";

/**
 * Global error handler for the Hono app.
 * Catches all errors and returns a consistent JSON envelope:
 *   { error: { code, message } }
 *
 * Registered via app.onError().
 */
export function errorHandler(err: Error, c: Context): Response {
  // Known application errors (thrown by services/handlers)
  if (err instanceof AppError) {
    return c.json(
      { error: { code: err.code, message: err.message } },
      err.statusCode as ContentfulStatusCode,
    );
  }

  // Log unexpected errors
  console.error("Unhandled error:", err);

  return c.json(
    {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
      },
    },
    500,
  );
}

/**
 * 404 handler for routes that don't match.
 * Registered via app.notFound().
 */
export function notFoundHandler(c: Context): Response {
  return c.json(
    {
      error: {
        code: "NOT_FOUND",
        message: `Route not found: ${c.req.method} ${c.req.path}`,
      },
    },
    404,
  );
}
