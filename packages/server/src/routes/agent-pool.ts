import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables, AuthUser } from "../types.js";
import * as agentPoolService from "../services/agent-pool.service.js";
import * as authService from "../services/auth.service.js";

// ─── Response schemas ────────────────────────────────────────────

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

const poolStatusSchema = z.object({
  data: z.array(
    z.object({
      user: z.object({
        id: z.string(),
        username: z.string(),
        displayName: z.string(),
        type: z.string(),
        isActive: z.boolean(),
        poolMember: z.boolean(),
      }),
      claimed: z.boolean(),
      claimedAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
      heartbeatAt: z.string().nullable(),
    }),
  ),
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

const poolSecretStatusSchema = z.object({
  data: z.object({
    isSet: z.boolean(),
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
      poolMember: z.boolean(),
    }),
  ),
});

// ─── Request schemas ─────────────────────────────────────────────

const claimBody = z.object({
  poolSecret: z.string().min(1, "Pool secret is required"),
});

const setSecretBody = z.object({
  secret: z.string().min(1, "Secret is required"),
});

const createPoolBody = z.object({
  count: z.number().int().min(1).max(20),
  namePrefix: z.string().optional(),
});

const forceReleaseBody = z.object({
  userId: z.string().min(1, "User ID is required"),
});

// ─── Route definitions ──────────────────────────────────────────

const agentClaimRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/agent-claim",
  tags: ["Agent Pool"],
  summary: "Claim an agent from the pool",
  description:
    "Authenticate with the pool secret to claim an available AI agent. Returns user info and a fresh API token.",
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

const agentPoolStatusRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/agent-pool",
  tags: ["Agent Pool"],
  summary: "Get agent pool status",
  description: "Get the status of all AI agents in the pool. Requires admin role.",
  responses: {
    200: {
      description: "Pool status",
      content: { "application/json": { schema: poolStatusSchema } },
    },
    401: {
      description: "Not authenticated",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Not authorized (admin required)",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const setPoolSecretRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/agent-pool/secret",
  tags: ["Agent Pool"],
  summary: "Set pool secret",
  description: "Set or update the agent pool secret. Admin only.",
  request: {
    body: {
      content: { "application/json": { schema: setSecretBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Secret set",
      content: { "application/json": { schema: messageEnvelope } },
    },
    401: {
      description: "Not authenticated",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Not authorized (admin required)",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getPoolSecretStatusRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/agent-pool/secret/status",
  tags: ["Agent Pool"],
  summary: "Get pool secret status",
  description: "Check if a pool secret is configured. Admin only.",
  responses: {
    200: {
      description: "Secret status",
      content: { "application/json": { schema: poolSecretStatusSchema } },
    },
    401: {
      description: "Not authenticated",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Not authorized (admin required)",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const createAgentPoolRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/agent-pool/create",
  tags: ["Agent Pool"],
  summary: "Create agent pool",
  description: "Create N AI agent users as pool members. Admin only.",
  request: {
    body: {
      content: { "application/json": { schema: createPoolBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Agents created",
      content: { "application/json": { schema: agentListSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    401: {
      description: "Not authenticated",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Not authorized (admin required)",
      content: { "application/json": { schema: errorEnvelope } },
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
    401: {
      description: "Not authenticated",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Not authorized (admin required)",
      content: { "application/json": { schema: errorEnvelope } },
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

// ─── Router ─────────────────────────────────────────────────────

export function createAgentPoolRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // POST /api/v1/auth/agent-claim — PUBLIC (authenticated by pool secret)
  router.openapi(agentClaimRoute, async (c) => {
    const { poolSecret } = c.req.valid("json");

    const result = await agentPoolService.claimAgent(poolSecret);

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

  // GET /api/v1/auth/agent-pool — AUTHENTICATED + ADMIN
  router.openapi(agentPoolStatusRoute, async (c) => {
    const user = await resolveUser(c);
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Valid authentication required" } },
        401,
      );
    }
    if (user.role !== "admin") {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Admin role required" } },
        403,
      );
    }

    const status = agentPoolService.getPoolStatus();
    return c.json({ data: status }, 200);
  });

  // POST /api/v1/auth/agent-pool/secret — AUTHENTICATED + ADMIN
  router.openapi(setPoolSecretRoute, async (c) => {
    const user = await resolveUser(c);
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Valid authentication required" } },
        401,
      );
    }
    if (user.role !== "admin") {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Admin role required" } },
        403,
      );
    }

    const { secret } = c.req.valid("json");
    await agentPoolService.setPoolSecret(secret);
    return c.json({ data: { message: "Pool secret updated" } }, 200);
  });

  // GET /api/v1/auth/agent-pool/secret/status — AUTHENTICATED + ADMIN
  router.openapi(getPoolSecretStatusRoute, async (c) => {
    const user = await resolveUser(c);
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Valid authentication required" } },
        401,
      );
    }
    if (user.role !== "admin") {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Admin role required" } },
        403,
      );
    }

    const status = agentPoolService.getPoolSecretStatus();
    return c.json({ data: status }, 200);
  });

  // POST /api/v1/auth/agent-pool/create — AUTHENTICATED + ADMIN
  router.openapi(createAgentPoolRoute, async (c) => {
    const user = await resolveUser(c);
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Valid authentication required" } },
        401,
      );
    }
    if (user.role !== "admin") {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Admin role required" } },
        403,
      );
    }

    const { count, namePrefix } = c.req.valid("json");
    const agents = await agentPoolService.createAgentPool(count, namePrefix);
    return c.json({ data: agents }, 201);
  });

  // POST /api/v1/auth/agent-pool/force-release — AUTHENTICATED + ADMIN
  router.openapi(forceReleaseRoute, async (c) => {
    const user = await resolveUser(c);
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Valid authentication required" } },
        401,
      );
    }
    if (user.role !== "admin") {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Admin role required" } },
        403,
      );
    }

    const { userId } = c.req.valid("json");
    agentPoolService.forceReleaseAgent(userId);
    return c.json({ data: { message: "Agent claim released" } }, 200);
  });

  return router;
}
