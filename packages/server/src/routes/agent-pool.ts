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

// ─── Request schemas ─────────────────────────────────────────────

const claimBody = z.object({
  poolSecret: z.string().min(1, "Pool secret is required"),
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
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Valid authentication required",
          },
        },
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
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Valid authentication required",
          },
        },
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
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Valid authentication required",
          },
        },
        401,
      );
    }

    if (user.role !== "admin") {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Admin role required",
          },
        },
        403,
      );
    }

    const status = agentPoolService.getPoolStatus();
    return c.json({ data: status }, 200);
  });

  return router;
}
