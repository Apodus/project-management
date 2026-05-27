import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables, AuthUser } from "../types.js";
import * as agentPoolService from "../services/agent-pool.service.js";
import * as authService from "../services/auth.service.js";

// ─── Response schemas ────────────────────────────────────────────

const poolSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string().nullable(),
});

const poolSummarySchema = poolSchema.extend({
  agentCount: z.number(),
  claimedCount: z.number(),
  availableCount: z.number(),
});

const claimResponseSchema = z.object({
  data: z.object({
    user: z.object({
      id: z.string(),
      username: z.string(),
      displayName: z.string(),
      role: z.string(),
      type: z.string(),
    }),
    token: z.string(),
  }),
});

const poolAgentStatusSchema = z.object({
  user: z.object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    type: z.string(),
    isActive: z.boolean(),
    poolId: z.string().nullable(),
  }),
  claimed: z.boolean(),
  claimedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
});

const messageEnvelope = z.object({
  data: z.object({ message: z.string() }),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const agentListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      username: z.string(),
      displayName: z.string(),
      role: z.string(),
      type: z.string(),
      poolId: z.string(),
    }),
  ),
});

// ─── Request schemas ─────────────────────────────────────────────

const claimBody = z.object({
  poolName: z.string().min(1, "Pool name is required"),
  poolSecret: z.string().min(1, "Pool secret is required"),
});

const createPoolBody = z.object({
  name: z.string().min(1, "Pool name is required"),
  secret: z.string().min(1, "Secret is required"),
  description: z.string().optional(),
});

const updatePoolBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
});

const updatePoolSecretBody = z.object({
  secret: z.string().min(1, "Secret is required"),
});

const createAgentsBody = z.object({
  count: z.number().int().min(1).max(20),
  namePrefix: z.string().optional(),
});

const forceReleaseBody = z.object({
  userId: z.string().min(1, "User ID is required"),
});

const poolIdParam = z.object({
  id: z.string().min(1),
});

const poolAgentParams = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
});

const removeAgentResponseSchema = z.object({
  data: z.object({
    deleted: z.boolean(),
    deactivated: z.boolean(),
    reason: z.string().optional(),
  }),
});

// ─── Route definitions ──────────────────────────────────────────

const createPoolRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/agent-pools",
  tags: ["Agent Pool"],
  summary: "Create a new agent pool",
  description: "Create a named agent pool with its own secret. Admin only.",
  request: {
    body: {
      content: { "application/json": { schema: createPoolBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Pool created",
      content: { "application/json": { schema: z.object({ data: poolSchema }) } },
    },
    409: {
      description: "Pool name already exists",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const listPoolsRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/agent-pools",
  tags: ["Agent Pool"],
  summary: "List all agent pools",
  description: "List all pools with summary (agent count, claimed count). Admin only.",
  responses: {
    200: {
      description: "Pool list",
      content: { "application/json": { schema: z.object({ data: z.array(poolSummarySchema) }) } },
    },
  },
});

const getPoolRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/agent-pools/{id}",
  tags: ["Agent Pool"],
  summary: "Get pool details with agent list",
  description: "Get pool details with full agent list. Admin only.",
  request: {
    params: poolIdParam,
  },
  responses: {
    200: {
      description: "Pool details",
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              pool: poolSchema,
              agents: z.array(poolAgentStatusSchema),
            }),
          }),
        },
      },
    },
    404: {
      description: "Pool not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updatePoolRoute = createRoute({
  method: "patch",
  path: "/api/v1/auth/agent-pools/{id}",
  tags: ["Agent Pool"],
  summary: "Update pool name/description",
  description: "Update pool name and/or description. Admin only.",
  request: {
    params: poolIdParam,
    body: {
      content: { "application/json": { schema: updatePoolBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Pool updated",
      content: { "application/json": { schema: z.object({ data: poolSchema }) } },
    },
    404: {
      description: "Pool not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deletePoolRoute = createRoute({
  method: "delete",
  path: "/api/v1/auth/agent-pools/{id}",
  tags: ["Agent Pool"],
  summary: "Delete a pool",
  description: "Delete pool and deactivate its agents. Admin only.",
  request: {
    params: poolIdParam,
  },
  responses: {
    200: {
      description: "Pool deleted",
      content: { "application/json": { schema: messageEnvelope } },
    },
    404: {
      description: "Pool not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updatePoolSecretRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/agent-pools/{id}/secret",
  tags: ["Agent Pool"],
  summary: "Update pool secret",
  description: "Update the secret for a specific pool. Admin only.",
  request: {
    params: poolIdParam,
    body: {
      content: { "application/json": { schema: updatePoolSecretBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Secret updated",
      content: { "application/json": { schema: messageEnvelope } },
    },
    404: {
      description: "Pool not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const createPoolAgentsRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/agent-pools/{id}/agents",
  tags: ["Agent Pool"],
  summary: "Create agents in a pool",
  description: "Create N AI agent users in a specific pool. Admin only.",
  request: {
    params: poolIdParam,
    body: {
      content: { "application/json": { schema: createAgentsBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Agents created",
      content: { "application/json": { schema: agentListSchema } },
    },
    404: {
      description: "Pool not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const removePoolAgentRoute = createRoute({
  method: "delete",
  path: "/api/v1/auth/agent-pools/{id}/agents/{userId}",
  tags: ["Agent Pool"],
  summary: "Remove agent from pool",
  description:
    "Remove an agent from a pool. If the agent has existing activity (comments, tasks, etc.), it will be deactivated and removed from the pool instead of deleted. Admin only.",
  request: {
    params: poolAgentParams,
  },
  responses: {
    200: {
      description: "Agent removed or deactivated",
      content: { "application/json": { schema: removeAgentResponseSchema } },
    },
    400: {
      description: "Agent does not belong to this pool",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const agentClaimRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/agent-claim",
  tags: ["Agent Pool"],
  summary: "Claim an agent from a pool",
  description:
    "Authenticate with pool name and secret to claim an available AI agent. Returns user info and a fresh API token.",
  request: {
    body: {
      content: { "application/json": { schema: claimBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Agent claimed",
      content: { "application/json": { schema: claimResponseSchema } },
    },
    401: {
      description: "Invalid pool secret",
      content: { "application/json": { schema: errorEnvelope } },
    },
    503: {
      description: "No agents available or pool not configured",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const agentReleaseRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/agent-release",
  tags: ["Agent Pool"],
  summary: "Release agent claim",
  description: "Release the current user's agent claim, making them available for others.",
  responses: {
    200: {
      description: "Agent released",
      content: { "application/json": { schema: messageEnvelope } },
    },
    401: {
      description: "Not authenticated",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const agentHeartbeatRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/agent-heartbeat",
  tags: ["Agent Pool"],
  summary: "Heartbeat for agent claim",
  description: "Extend the TTL of the current user's agent claim.",
  responses: {
    200: {
      description: "Heartbeat acknowledged",
      content: { "application/json": { schema: messageEnvelope } },
    },
    401: {
      description: "Not authenticated",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "No active claim",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// Backward compat: GET /api/v1/auth/agent-pool returns all pools
const legacyPoolStatusRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/agent-pool",
  tags: ["Agent Pool"],
  summary: "Get all pools (backward compat)",
  description: "Get all pools with summary. Admin only. Redirects to list.",
  responses: {
    200: {
      description: "Pool list",
      content: { "application/json": { schema: z.object({ data: z.array(poolSummarySchema) }) } },
    },
  },
});

const forceReleaseRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/agent-pool/force-release",
  tags: ["Agent Pool"],
  summary: "Force release an agent claim",
  description: "Force-release an agent's claim by admin. Takes the agent user ID.",
  request: {
    body: {
      content: { "application/json": { schema: forceReleaseBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Agent released",
      content: { "application/json": { schema: messageEnvelope } },
    },
  },
});

// ─── Auth helper ────────────────────────────────────────────────

/**
 * Manually validate auth for agent-pool routes.
 * Since these routes are under /api/v1/auth/*, the auth middleware skips them.
 * We need to validate the bearer token ourselves.
 */
async function resolveUser(c: any): Promise<AuthUser | null> {
  // Check if middleware already resolved the user
  const existing = c.get("currentUser");
  if (existing) return existing;

  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const user = await authService.validateApiToken(token);
    if (user) return user;
    const sessionUser = await authService.validateSession(token);
    if (sessionUser) return sessionUser;
  }

  // Check cookie
  const cookie = c.req.header("Cookie");
  if (cookie) {
    const match = cookie.match(/pm_session=([^;]+)/);
    if (match) {
      const sessionUser = await authService.validateSession(match[1]);
      if (sessionUser) return sessionUser;
    }
  }

  return null;
}

function requireAuth(user: AuthUser | null, c: any): Response | null {
  if (!user) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Valid authentication required" } },
      401,
    );
  }
  return null;
}

function requireAdminRole(user: AuthUser, c: any): Response | null {
  if (user.role !== "admin") {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Admin role required" } },
      403,
    );
  }
  return null;
}

// ─── Router ─────────────────────────────────────────────────────

export function createAgentPoolRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // POST /api/v1/auth/agent-pools — ADMIN. Create a new pool.
  router.openapi(createPoolRoute, async (c) => {
    const user = await resolveUser(c);
    const authErr = requireAuth(user, c);
    if (authErr) return authErr as any;
    const adminErr = requireAdminRole(user!, c);
    if (adminErr) return adminErr as any;

    const { name, secret, description } = c.req.valid("json");
    const pool = await agentPoolService.createPool(name, secret, description, user!.id);
    return c.json({ data: pool }, 201);
  });

  // GET /api/v1/auth/agent-pools — ADMIN. List all pools.
  router.openapi(listPoolsRoute, async (c) => {
    const user = await resolveUser(c);
    const authErr = requireAuth(user, c);
    if (authErr) return authErr as any;
    const adminErr = requireAdminRole(user!, c);
    if (adminErr) return adminErr as any;

    const pools = agentPoolService.listPools();
    return c.json({ data: pools }, 200);
  });

  // GET /api/v1/auth/agent-pools/:id — ADMIN. Get pool details.
  router.openapi(getPoolRoute, async (c) => {
    const user = await resolveUser(c);
    const authErr = requireAuth(user, c);
    if (authErr) return authErr as any;
    const adminErr = requireAdminRole(user!, c);
    if (adminErr) return adminErr as any;

    const { id } = c.req.valid("param");
    const pool = agentPoolService.getPool(id);
    if (!pool) {
      return c.json(
        { error: { code: "POOL_NOT_FOUND", message: "Pool not found" } },
        404,
      );
    }

    const agents = agentPoolService.getPoolStatus(id);
    return c.json({ data: { pool, agents } }, 200);
  });

  // PATCH /api/v1/auth/agent-pools/:id — ADMIN. Update pool name/description.
  router.openapi(updatePoolRoute, async (c) => {
    const user = await resolveUser(c);
    const authErr = requireAuth(user, c);
    if (authErr) return authErr as any;
    const adminErr = requireAdminRole(user!, c);
    if (adminErr) return adminErr as any;

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const pool = agentPoolService.updatePool(id, body);
    return c.json({ data: pool }, 200);
  });

  // DELETE /api/v1/auth/agent-pools/:id — ADMIN. Delete pool.
  router.openapi(deletePoolRoute, async (c) => {
    const user = await resolveUser(c);
    const authErr = requireAuth(user, c);
    if (authErr) return authErr as any;
    const adminErr = requireAdminRole(user!, c);
    if (adminErr) return adminErr as any;

    const { id } = c.req.valid("param");
    agentPoolService.deletePool(id);
    return c.json({ data: { message: "Pool deleted" } }, 200);
  });

  // POST /api/v1/auth/agent-pools/:id/secret — ADMIN. Update pool secret.
  router.openapi(updatePoolSecretRoute, async (c) => {
    const user = await resolveUser(c);
    const authErr = requireAuth(user, c);
    if (authErr) return authErr as any;
    const adminErr = requireAdminRole(user!, c);
    if (adminErr) return adminErr as any;

    const { id } = c.req.valid("param");
    const { secret } = c.req.valid("json");
    await agentPoolService.updatePoolSecret(id, secret);
    return c.json({ data: { message: "Pool secret updated" } }, 200);
  });

  // POST /api/v1/auth/agent-pools/:id/agents — ADMIN. Create agents in pool.
  router.openapi(createPoolAgentsRoute, async (c) => {
    const user = await resolveUser(c);
    const authErr = requireAuth(user, c);
    if (authErr) return authErr as any;
    const adminErr = requireAdminRole(user!, c);
    if (adminErr) return adminErr as any;

    const { id } = c.req.valid("param");
    const { count, namePrefix } = c.req.valid("json");
    const agents = await agentPoolService.createAgentPool(id, count, namePrefix);
    return c.json({ data: agents }, 201);
  });

  // DELETE /api/v1/auth/agent-pools/:id/agents/:userId — ADMIN. Remove agent from pool.
  router.openapi(removePoolAgentRoute, async (c) => {
    const user = await resolveUser(c);
    const authErr = requireAuth(user, c);
    if (authErr) return authErr as any;
    const adminErr = requireAdminRole(user!, c);
    if (adminErr) return adminErr as any;

    const { id, userId } = c.req.valid("param");
    const result = agentPoolService.removeAgentFromPool(id, userId);
    return c.json({ data: result }, 200);
  });

  // POST /api/v1/auth/agent-claim — PUBLIC (authenticated by pool secret)
  router.openapi(agentClaimRoute, async (c) => {
    const { poolName, poolSecret } = c.req.valid("json");

    const result = await agentPoolService.claimAgent(poolName, poolSecret);

    if (!result) {
      return c.json(
        {
          error: {
            code: "NO_AGENTS_AVAILABLE",
            message:
              "No AI agents are available in the pool. All agents are currently claimed or inactive.",
          },
        },
        503,
      );
    }

    return c.json({ data: result }, 200);
  });

  // POST /api/v1/auth/agent-release — AUTHENTICATED
  router.openapi(agentReleaseRoute, async (c) => {
    const user = await resolveUser(c);
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Valid authentication required" } },
        401,
      );
    }

    agentPoolService.releaseAgent(user.id);
    return c.json({ data: { message: "Agent released" } }, 200);
  });

  // POST /api/v1/auth/agent-heartbeat — AUTHENTICATED
  router.openapi(agentHeartbeatRoute, async (c) => {
    const user = await resolveUser(c);
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Valid authentication required" } },
        401,
      );
    }

    agentPoolService.heartbeat(user.id);
    return c.json({ data: { message: "Heartbeat acknowledged" } }, 200);
  });

  // GET /api/v1/auth/agent-pool — ADMIN. Backward compat: returns all pools.
  router.openapi(legacyPoolStatusRoute, async (c) => {
    const user = await resolveUser(c);
    const authErr = requireAuth(user, c);
    if (authErr) return authErr as any;
    const adminErr = requireAdminRole(user!, c);
    if (adminErr) return adminErr as any;

    const pools = agentPoolService.listPools();
    return c.json({ data: pools }, 200);
  });

  // POST /api/v1/auth/agent-pool/force-release — AUTHENTICATED + ADMIN
  router.openapi(forceReleaseRoute, async (c) => {
    const user = await resolveUser(c);
    const authErr = requireAuth(user, c);
    if (authErr) return authErr as any;
    const adminErr = requireAdminRole(user!, c);
    if (adminErr) return adminErr as any;

    const { userId } = c.req.valid("json");
    agentPoolService.forceReleaseAgent(userId);
    return c.json({ data: { message: "Agent claim released" } }, 200);
  });

  return router;
}
