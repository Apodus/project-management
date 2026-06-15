import { createMiddleware } from "hono/factory";
import type { AppVariables } from "../types.js";

/**
 * Logs each request: method, path, status, and duration in milliseconds.
 * Uses console.log for now — can be replaced with a structured logger later.
 */
export const loggerMiddleware = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  const start = performance.now();
  const method = c.req.method;
  const path = c.req.path;

  await next();

  const duration = (performance.now() - start).toFixed(1);
  const status = c.res.status;
  const requestId = c.get("requestId") ?? "-";

  console.log(`[${requestId}] ${method} ${path} → ${status} (${duration}ms)`);
});
