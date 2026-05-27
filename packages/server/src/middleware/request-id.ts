import { createMiddleware } from "hono/factory";
import { createId } from "@pm/shared";
import type { AppVariables } from "../types.js";

/**
 * Generates a ULID request ID for every incoming request.
 * Sets it in the context variables and in the X-Request-Id response header.
 */
export const requestIdMiddleware = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  const requestId = createId();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  await next();
});
