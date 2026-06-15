import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  MERGE_LOCK_ACQUIRE_STATUSES,
  MERGE_LOCK_HEARTBEAT_STATUSES,
  MERGE_LOCK_RELEASE_STATUSES,
  MERGE_LOCK_RESOURCE_PATTERN,
} from "@pm/shared";
import type { AppVariables, AuthUser } from "../types.js";
import { AppError } from "../types.js";
import * as mergeLockService from "../services/merge-lock.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const mergeLockSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    resource: z.string(),
    holder: z.enum(["you", "someone_else", "none"]),
    holderId: z.string().nullable(),
    acquiredAt: z.string().nullable(),
    heartbeatAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    landedSha: z.string().nullable(),
    landedAt: z.string().nullable(),
    taskId: z.string().nullable(),
    branch: z.string().nullable(),
    commitSha: z.string().nullable(),
    verifyCmd: z.string().nullable(),
    worktreePath: z.string().nullable(),
    abandonReason: z.string().nullable(),
    queueLength: z.number().int(),
    yourPosition: z.number().int().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("MergeLock");

const mergeLockDataEnvelope = z.object({ data: mergeLockSchema });
const mergeLockListEnvelope = z.object({
  data: z.array(mergeLockSchema),
  pagination: z.object({ total: z.number() }),
});

const acquireResultSchema = z
  .object({
    ok: z.boolean(),
    status: z.enum(MERGE_LOCK_ACQUIRE_STATUSES),
    position: z.number().int().nullable().optional(),
    expiresAt: z.string().nullable().optional(),
  })
  .openapi("MergeLockAcquireResult");

const heartbeatResultSchema = z
  .object({
    ok: z.boolean(),
    status: z.enum(MERGE_LOCK_HEARTBEAT_STATUSES),
    expiresAt: z.string().nullable().optional(),
  })
  .openapi("MergeLockHeartbeatResult");

const releaseResultSchema = z
  .object({
    ok: z.boolean(),
    status: z.enum(MERGE_LOCK_RELEASE_STATUSES),
    grantedTo: z.string().nullable().optional(),
  })
  .openapi("MergeLockReleaseResult");

const acquireEnvelope = z.object({ data: acquireResultSchema });
const heartbeatEnvelope = z.object({ data: heartbeatResultSchema });
const releaseEnvelope = z.object({ data: releaseResultSchema });

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// ─── Request schemas ──────────────────────────────────────────────

const projectIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "projectId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const resourceParam = z
  .string()
  .regex(MERGE_LOCK_RESOURCE_PATTERN, "Invalid resource name")
  .openapi({
    param: { name: "resource", in: "path" },
    example: "main",
  });

const landingIntentBody = z
  .object({
    taskId: z.string().min(1).nullable().optional(),
    branch: z.string().min(1).max(255).nullable().optional(),
    commitSha: z.string().min(1).max(128).nullable().optional(),
    verifyCmd: z.string().min(1).max(2048).nullable().optional(),
    worktreePath: z.string().min(1).max(1024).nullable().optional(),
  })
  .openapi("MergeLockAcquire");

const releaseBody = z
  .object({
    landedSha: z.string().min(1).max(128).nullable().optional().openapi({ example: "abc1234" }),
    reason: z.string().min(1).max(2048).nullable().optional().openapi({
      example: "verify failed: skinned_renderer.cpp API drift",
    }),
  })
  .openapi("MergeLockRelease");

// ─── Routes ───────────────────────────────────────────────────────

const acquireRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/merge-locks/{resource}/acquire",
  tags: ["Merge Locks"],
  summary: "Acquire merge lock",
  description:
    "Atomically acquire the named lock for the caller, or join the FIFO queue if held. Idempotent for the current holder. Optionally attach landing intent (taskId / branch / commitSha / verifyCmd / worktreePath) — all optional, used for observability while held or queued.",
  request: {
    params: z.object({ projectId: projectIdParam, resource: resourceParam }),
    body: {
      content: { "application/json": { schema: landingIntentBody } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Acquire outcome",
      content: { "application/json": { schema: acquireEnvelope } },
    },
    400: {
      description: "Validation error (e.g. taskId not in this project)",
      content: { "application/json": { schema: errorEnvelope } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project or referenced task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const heartbeatRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/merge-locks/{resource}/heartbeat",
  tags: ["Merge Locks"],
  summary: "Refresh merge lock lease",
  description:
    "Refresh the holder's lease. Returns not_holder if the caller doesn't currently hold the lock (e.g. lease already swept).",
  request: {
    params: z.object({ projectId: projectIdParam, resource: resourceParam }),
  },
  responses: {
    200: {
      description: "Heartbeat outcome",
      content: { "application/json": { schema: heartbeatEnvelope } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const releaseRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/merge-locks/{resource}/release",
  tags: ["Merge Locks"],
  summary: "Release merge lock",
  description:
    "Release the lock and promote the queue head. If landedSha is provided, the release event carries it as the 'main moved' announcement. If landedSha is omitted and a reason is given, the release is an abandon — the reason is stored on the lock so the next holder can see why main hasn't moved (e.g. 'verify failed: skinned_renderer.cpp API drift').",
  request: {
    params: z.object({ projectId: projectIdParam, resource: resourceParam }),
    body: {
      content: { "application/json": { schema: releaseBody } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Release outcome",
      content: { "application/json": { schema: releaseEnvelope } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getLockRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/merge-locks/{resource}",
  tags: ["Merge Locks"],
  summary: "Get merge lock state",
  description:
    "Return the current state of the lock. Holder identity is reported relative to the caller as 'you' / 'someone_else' / 'none'.",
  request: {
    params: z.object({ projectId: projectIdParam, resource: resourceParam }),
  },
  responses: {
    200: {
      description: "Current lock state",
      content: { "application/json": { schema: mergeLockDataEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const listLocksRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/merge-locks",
  tags: ["Merge Locks"],
  summary: "List merge locks",
  description: "List all known locks for a project (one per resource name).",
  request: { params: z.object({ projectId: projectIdParam }) },
  responses: {
    200: {
      description: "List of locks",
      content: { "application/json": { schema: mergeLockListEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

function requireUser(user: AuthUser | null): AuthUser {
  if (!user) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return user;
}

export function createMergeLockRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  router.openapi(acquireRoute, (c) => {
    const { projectId, resource } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    let intent: Record<string, string | null | undefined> = {};
    try {
      intent = c.req.valid("json") ?? {};
    } catch {
      // Body is optional.
    }
    const result = mergeLockService.acquire(projectId, resource, { id: user.id }, intent);
    return c.json({ data: result }, 200);
  });

  router.openapi(heartbeatRoute, (c) => {
    const { projectId, resource } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    const result = mergeLockService.heartbeat(projectId, resource, {
      id: user.id,
    });
    return c.json({ data: result }, 200);
  });

  router.openapi(releaseRoute, (c) => {
    const { projectId, resource } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    let body: { landedSha?: string | null; reason?: string | null } = {};
    try {
      body = c.req.valid("json");
    } catch {
      // Body is optional.
    }
    const result = mergeLockService.release(
      projectId,
      resource,
      { id: user.id },
      { landedSha: body.landedSha ?? null, reason: body.reason ?? null },
    );
    return c.json({ data: result }, 200);
  });

  router.openapi(getLockRoute, (c) => {
    const { projectId, resource } = c.req.valid("param");
    const user = c.get("currentUser") as AuthUser | null;
    const view = mergeLockService.getLock(projectId, resource, user ? { id: user.id } : null);
    return c.json({ data: view }, 200);
  });

  router.openapi(listLocksRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = c.get("currentUser") as AuthUser | null;
    const list = mergeLockService.listLocks(projectId, user ? { id: user.id } : null);
    return c.json({ data: list, pagination: { total: list.length } }, 200);
  });

  return router;
}
