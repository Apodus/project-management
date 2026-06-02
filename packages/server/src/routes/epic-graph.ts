import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { DEPENDENCY_TYPES } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as epicGraphService from "../services/epic-graph.service.js";

// ─── Route-local Zod-4 mirror of @pm/shared epicGraphSchema ───────
// Per the established split, the canonical Zod-3 schema lives in @pm/shared
// and is NOT imported into the route; the OpenAPI-registered mirror is
// re-declared here with `z` from @hono/zod-openapi. Constants
// (DEPENDENCY_TYPES) cross the version boundary fine — only schema OBJECTS
// must be re-declared.

const epicGraphTaskSummarySchema = z.object({
  total: z.number(),
  done: z.number(),
  byStatus: z.record(z.string(), z.number()),
});

const epicGraphNodeSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    name: z.string(),
    status: z.string(),
    priority: z.string(),
    target_date: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    taskSummary: epicGraphTaskSummarySchema,
  })
  .openapi("EpicGraphNode");

const epicGraphEdgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    dependency_type: z.enum(DEPENDENCY_TYPES),
    provenance: z.enum(["derived", "explicit"]),
  })
  .openapi("EpicGraphEdge");

const epicGraphSchema = z
  .object({
    nodes: z.array(epicGraphNodeSchema),
    edges: z.array(epicGraphEdgeSchema),
    hasCycle: z.boolean(),
    cycles: z.array(z.array(z.string())).optional(),
  })
  .openapi("EpicGraph");

const epicGraphEnvelope = z.object({ data: epicGraphSchema });

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

// ─── Route definition ─────────────────────────────────────────────

const getEpicGraphRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/epic-graph",
  tags: ["Epics"],
  summary: "Get epic graph",
  description:
    "Get the epic dependency graph for a project: nodes (epics + task summary) and " +
    "derived blocks edges rolled up from the task dependency graph.",
  request: {
    params: z.object({ projectId: projectIdParam }),
  },
  responses: {
    200: {
      description: "Epic graph",
      content: { "application/json": { schema: epicGraphEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createEpicGraphRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:projectId/epic-graph
  router.openapi(getEpicGraphRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = c.get("currentUser");
    const graph = epicGraphService.getGraph(
      projectId,
      user ? { id: user.id } : null,
    );

    return c.json({ data: graph }, 200);
  });

  return router;
}
