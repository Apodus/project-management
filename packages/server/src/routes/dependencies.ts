import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { DEPENDENCY_TYPES } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as dependencyService from "../services/dependency.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const dependencySchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    dependsOnTaskId: z.string(),
    dependencyType: z.string(),
    createdAt: z.string(),
  })
  .openapi("TaskDependency");

const dependencyDataEnvelope = z.object({
  data: dependencySchema,
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ──────────────────────────────────────────────

const addDependencyBody = z
  .object({
    dependsOnTaskId: z.string().min(1, "dependsOnTaskId is required"),
    type: z.enum(DEPENDENCY_TYPES).optional(),
  })
  .openapi("AddDependency");

const taskIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "id", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const depIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "depId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

// ─── Route definitions ────────────────────────────────────────────

const addDependencyRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/{id}/dependencies",
  tags: ["Dependencies"],
  summary: "Add dependency",
  description:
    "Add a dependency between tasks. Performs cycle detection to prevent circular dependencies.",
  request: {
    params: z.object({ id: taskIdParam }),
    body: {
      content: { "application/json": { schema: addDependencyBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Dependency created",
      content: { "application/json": { schema: dependencyDataEnvelope } },
    },
    400: {
      description: "Validation error or cycle detected",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Dependency already exists",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const removeDependencyRoute = createRoute({
  method: "delete",
  path: "/api/v1/tasks/{id}/dependencies/{depId}",
  tags: ["Dependencies"],
  summary: "Remove dependency",
  description: "Remove a dependency between tasks.",
  request: {
    params: z.object({ id: taskIdParam, depId: depIdParam }),
  },
  responses: {
    200: {
      description: "Dependency removed",
      content: { "application/json": { schema: dependencyDataEnvelope } },
    },
    404: {
      description: "Dependency not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createDependencyRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // POST /api/v1/tasks/:id/dependencies
  router.openapi(addDependencyRoute, (c) => {
    const { id } = c.req.valid("param");
    const { dependsOnTaskId, type } = c.req.valid("json");
    const dependency = dependencyService.addDependency(id, dependsOnTaskId, type ?? "blocks");

    return c.json({ data: dependency }, 201);
  });

  // DELETE /api/v1/tasks/:id/dependencies/:depId
  router.openapi(removeDependencyRoute, (c) => {
    const { depId } = c.req.valid("param");
    const dependency = dependencyService.removeDependency(depId);

    return c.json({ data: dependency }, 200);
  });

  return router;
}
