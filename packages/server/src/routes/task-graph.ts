import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { DEPENDENCY_TYPES } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as taskGraphService from "../services/task-graph.service.js";

// ─── Route-local Zod-4 mirror of @pm/shared taskGraphSchema ───────
// Per the established split, the canonical Zod-3 schema lives in @pm/shared
// and is NOT imported into the route; the OpenAPI-registered mirror is
// re-declared here with `z` from @hono/zod-openapi. Constants
// (DEPENDENCY_TYPES) cross the version boundary fine — only schema OBJECTS
// must be re-declared.

const taskGraphNodeSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    priority: z.string(),
    type: z.string(),
    assignee_id: z.string().nullable(),
    done: z.boolean(),
  })
  .openapi("TaskGraphNode");

const taskGraphEdgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    dependency_type: z.enum(DEPENDENCY_TYPES),
    provenance: z.enum(["derived", "explicit"]),
  })
  .openapi("TaskGraphEdge");

const taskGraphSchema = z
  .object({
    nodes: z.array(taskGraphNodeSchema),
    edges: z.array(taskGraphEdgeSchema),
    hasCycle: z.boolean(),
    cycles: z.array(z.array(z.string())).optional(),
  })
  .openapi("TaskGraph");

const taskGraphEnvelope = z.object({ data: taskGraphSchema });

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const epicIdParam = z.string().min(1).openapi({
  param: { name: "epicId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

// ─── Route definition ─────────────────────────────────────────────

const getTaskGraphRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/epics/{epicId}/task-graph",
  tags: ["Epics"],
  summary: "Get task graph",
  description:
    "Get the intra-epic task dependency graph for an epic: nodes (the epic's " +
    "tasks) and edges (their internal task dependencies, cross-epic deps excluded).",
  request: {
    params: z.object({ projectId: projectIdParam, epicId: epicIdParam }),
  },
  responses: {
    200: {
      description: "Task graph",
      content: { "application/json": { schema: taskGraphEnvelope } },
    },
    404: {
      description: "Epic not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createTaskGraphRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:projectId/epics/:epicId/task-graph
  router.openapi(getTaskGraphRoute, (c) => {
    const { projectId, epicId } = c.req.valid("param");
    const user = c.get("currentUser");
    const graph = taskGraphService.getTaskGraph(
      projectId,
      epicId,
      user ? { id: user.id } : null,
    );

    return c.json({ data: graph }, 200);
  });

  return router;
}
