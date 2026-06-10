import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { CLAIM_STATES, LEASE_ENTITY_TYPES, USER_TYPES } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as claimsHealthService from "../services/claims-health.service.js";

// ─── Project claims aggregate (Campaign C3 — claims panel) ────────
// GET /projects/{projectId}/claims — every ACTIVE claim (task/epic/proposal
// with a non-null holder + non-terminal status) with its identity-masked
// claim_state, the holder resolved to {id, name, type} (the entity's
// human-facing assigneeId/claimedBy pointer — NEVER the lease's holderId), and
// the nullable lease-layer claimedAt age basis. Route-local Zod-4 schemas (via
// @hono/zod-openapi `z`), the established split from the canonical Zod-3
// @pm/shared schemas. PURE READ — never touches the stale-claim alert latch.

// ─── Response schemas ─────────────────────────────────────────────

const claimHolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(USER_TYPES),
});

const projectClaimItemSchema = z.object({
  entityType: z.enum(LEASE_ENTITY_TYPES),
  id: z.string(),
  title: z.string(),
  status: z.string(),
  claimState: z.enum(CLAIM_STATES),
  holder: claimHolderSchema,
  // Lease-layer acquisition time; null for legacy pre-C2 claims (no lease row).
  claimedAt: z.string().nullable(),
  updatedAt: z.string(),
});

const projectClaimsSchema = z
  .object({
    items: z.array(projectClaimItemSchema),
    total: z.number(),
  })
  .openapi("ProjectClaims");

const projectClaimsEnvelope = z.object({ data: projectClaimsSchema });

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

const listProjectClaimsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/claims",
  tags: ["Claims"],
  summary: "List active claims",
  description:
    "List every ACTIVE claim in the project (tasks/epics/proposals with a holder and a non-terminal status), each with its identity-masked claim_state (relative to the caller), the holder (id/name/type), and the nullable lease-layer claimedAt. Pure read — no alert side effect.",
  request: {
    params: z.object({ projectId: projectIdParam }),
  },
  responses: {
    200: {
      description: "Active claims for the project",
      content: { "application/json": { schema: projectClaimsEnvelope } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createClaimRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:projectId/claims
  router.openapi(listProjectClaimsRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = c.get("currentUser")!;
    const claims = claimsHealthService.listProjectClaims(projectId, { id: user.id });
    return c.json({ data: claims }, 200);
  });

  return router;
}
