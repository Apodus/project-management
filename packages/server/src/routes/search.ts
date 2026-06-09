import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables } from "../types.js";
import * as searchService from "../services/search.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const searchResultSchema = z
  .object({
    entityType: z.string(),
    entityId: z.string(),
    title: z.string(),
    excerpt: z.string(),
    rank: z.number(),
    projectId: z.string().nullable(),
  })
  .openapi("SearchResult");

const searchResultsEnvelope = z.object({
  data: z.array(searchResultSchema),
  pagination: z.object({
    total: z.number(),
  }),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Route definitions ────────────────────────────────────────────

const searchRoute = createRoute({
  method: "get",
  path: "/api/v1/search",
  tags: ["Search"],
  summary: "Full-text search",
  description:
    "Search across proposals, tasks, comments, and notes using FTS5 full-text search.",
  request: {
    query: z.object({
      q: z.string().min(1, "Search query is required"),
      project_id: z.string().optional(),
      entity_type: z.enum(["proposal", "task", "comment", "note"] as const).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Search results",
      content: { "application/json": { schema: searchResultsEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createSearchRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/search
  router.openapi(searchRoute, (c) => {
    const { q, project_id, entity_type, limit } = c.req.valid("query");
    const results = searchService.search(q, {
      projectId: project_id,
      entityType: entity_type,
      limit,
    });

    return c.json(
      {
        data: results,
        pagination: { total: results.length },
      },
      200,
    );
  });

  return router;
}
