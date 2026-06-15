import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { DEPENDENCY_TYPES, EPIC_HEALTHS, CLAIM_STATES } from "@pm/shared";
import type { AppVariables, AuthUser } from "../types.js";
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
    category: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    taskSummary: epicGraphTaskSummarySchema,
    // C3.P4: claim liveness (mirrors @pm/shared epicGraphNodeSchema).
    claimState: z.enum(CLAIM_STATES),
    // P4 enrichment — required (mirrors @pm/shared epicGraphNodeSchema).
    health: z.enum(EPIC_HEALTHS),
    activity_recency: z.string(),
    time_window: z.object({ start: z.string(), end: z.string().nullable() }),
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

// ─── Explicit epic-dependency row mirror + request body ───────────

const epicDependencySchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    epicId: z.string(),
    dependsOnEpicId: z.string(),
    dependencyType: z.string(),
    createdAt: z.string(),
    createdBy: z.string().nullable(),
  })
  .openapi("EpicDependency");

const epicDependencyEnvelope = z.object({ data: epicDependencySchema });

const addEpicDependencyBody = z
  .object({
    dependsOnEpicId: z.string().min(1),
    dependencyType: z.enum(DEPENDENCY_TYPES).optional(),
  })
  .openapi("AddEpicDependency");

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const projectIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "projectId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const epicIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "epicId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const depIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "depId", in: "path" },
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

const addEpicDependencyRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/epics/{epicId}/dependencies",
  tags: ["Epics"],
  summary: "Add explicit epic dependency",
  description:
    "Add an explicit planning-time dependency: epicId depends on dependsOnEpicId. " +
    "Both epics must belong to the project. Self-dependencies and duplicates are rejected.",
  request: {
    params: z.object({ projectId: projectIdParam, epicId: epicIdParam }),
    body: {
      content: { "application/json": { schema: addEpicDependencyBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Epic dependency created",
      content: { "application/json": { schema: epicDependencyEnvelope } },
    },
    400: {
      description: "Validation error, self-dependency, or cross-project",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Epic not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Epic dependency already exists",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const removeEpicDependencyRoute = createRoute({
  method: "delete",
  path: "/api/v1/projects/{projectId}/epics/{epicId}/dependencies/{depId}",
  tags: ["Epics"],
  summary: "Remove explicit epic dependency",
  description: "Remove an explicit epic dependency by its ID.",
  request: {
    params: z.object({
      projectId: projectIdParam,
      epicId: epicIdParam,
      depId: depIdParam,
    }),
  },
  responses: {
    200: {
      description: "Epic dependency removed",
      content: { "application/json": { schema: epicDependencyEnvelope } },
    },
    404: {
      description: "Epic dependency not found",
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
    const graph = epicGraphService.getGraph(projectId, user ? { id: user.id } : null);

    return c.json({ data: graph }, 200);
  });

  // POST /api/v1/projects/:projectId/epics/:epicId/dependencies
  router.openapi(addEpicDependencyRoute, (c) => {
    const { projectId, epicId } = c.req.valid("param");
    const { dependsOnEpicId, dependencyType } = c.req.valid("json");
    const user = c.get("currentUser") as AuthUser | null;

    const dependency = epicGraphService.createDependency({
      projectId,
      epicId,
      dependsOnEpicId,
      dependencyType,
      createdBy: user?.id ?? null,
    });

    return c.json({ data: dependency }, 201);
  });

  // DELETE /api/v1/projects/:projectId/epics/:epicId/dependencies/:depId
  router.openapi(removeEpicDependencyRoute, (c) => {
    const { depId } = c.req.valid("param");
    const dependency = epicGraphService.deleteDependency(depId);

    return c.json({ data: dependency }, 200);
  });

  return router;
}
