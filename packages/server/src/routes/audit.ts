import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables, AuthUser } from "../types.js";
import { AppError } from "../types.js";
import * as auditService from "../services/audit.service.js";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from "../services/audit.service.js";

// ─── Param + query schemas ────────────────────────────────────────

const projectIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "projectId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

// The audit-log query filters (§8.4) — every filter optional. Maps 1:1 onto
// auditService.list's ListArgs. action/targetType are constrained to the audit
// enums; page/perPage are coerced (query strings → numbers).
const auditQuery = z.object({
  userId: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: "userId", in: "query" },
    }),
  action: z
    .enum(AUDIT_ACTIONS)
    .optional()
    .openapi({ param: { name: "action", in: "query" } }),
  targetType: z
    .enum(AUDIT_TARGET_TYPES)
    .optional()
    .openapi({ param: { name: "targetType", in: "query" } }),
  targetId: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: "targetId", in: "query" },
    }),
  from: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: "from", in: "query" },
      example: "2026-05-29T00:00:00.000Z",
    }),
  to: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: "to", in: "query" },
      example: "2026-05-30T00:00:00.000Z",
    }),
  page: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .openapi({
      param: { name: "page", in: "query" },
    }),
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .openapi({
      param: { name: "perPage", in: "query" },
    }),
});

// ─── Response schema (Zod-4 LOCAL mirror of @pm/shared auditLogSchema) ──
// camelCase audit row (the @pm/shared AuditLogView structure, declared locally
// in Zod-4 per the createRoute/.openapi() split — never import the Zod-3 shared
// schema into a route). There is deliberately no `updatedAt` (append-only).

const auditRowSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    actorId: z.string(),
    action: z.string(),
    targetType: z.string(),
    targetId: z.string(),
    reason: z.string().nullable(),
    metadataBefore: z.record(z.string(), z.unknown()).nullable(),
    metadataAfter: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
  })
  .openapi("AuditLogEntry");

const auditListEnvelope = z
  .object({
    data: z.array(auditRowSchema),
    pagination: z.object({
      total: z.number(),
      page: z.number(),
      perPage: z.number(),
    }),
  })
  .openapi("AuditLogList");

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// ─── Routes ───────────────────────────────────────────────────────

const listAuditRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/audit-log",
  tags: ["Merge Train"],
  summary: "Query the break-glass audit log (admin-only)",
  description:
    "Returns the project's append-only audit log — who did what to the train and why (design §2 / §8.4). Filterable by actor (userId), action, targetType, targetId, and a from/to createdAt window; ordered newest-first, paginated (page/perPage, default 1/50, max 200). Admin-only: audit records operator/admin-tier accountability data.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: auditQuery,
  },
  responses: {
    200: {
      description: "The audit log page",
      content: { "application/json": { schema: auditListEnvelope } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Admin only",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Helpers ──────────────────────────────────────────────────────

function requireUser(user: AuthUser | null): AuthUser {
  if (!user) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return user;
}

/**
 * Admin gate — the audit log is admin-read (§8.4 / §11): it records who did
 * what to the train, which is operator/admin-tier accountability data.
 */
function requireAdmin(user: AuthUser): void {
  if (user.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "Admin role required to read the audit log.");
  }
}

// ─── Router factory ───────────────────────────────────────────────

export function createAuditRoutes(): OpenAPIHono<{ Variables: AppVariables }> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  router.openapi(listAuditRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const user = requireUser(c.get("currentUser") as AuthUser | null);
    requireAdmin(user);
    const q = c.req.valid("query");

    const result = auditService.list({
      projectId,
      userId: q.userId,
      action: q.action,
      targetType: q.targetType,
      targetId: q.targetId,
      from: q.from,
      to: q.to,
      page: q.page,
      perPage: q.perPage,
    });

    return c.json(result, 200);
  });

  return router;
}
