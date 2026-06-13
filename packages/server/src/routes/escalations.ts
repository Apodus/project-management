import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ESCALATION_KINDS,
  ESCALATION_STATUSES,
  ESCALATION_SEVERITIES,
  ESCALATION_ANCHOR_TYPES,
  ESCALATION_MESSAGE_TYPES,
} from "@pm/shared";
import type { UserType } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as escalationService from "../services/escalation.service.js";

// ─── Escalation routes (Campaign C1 §P3) ──────────────────────────
// Route-local Zod-4 schemas (via @hono/zod-openapi `z`), the established
// split from the canonical Zod-3 @pm/shared escalation schema. Thin
// pass-throughs: ALL authz/lifecycle lives in the P2 service, which throws
// AppError (404/403/409) surfaced via the app-level errorHandler. 400 is
// automatic from @hono/zod-openapi request validation.

// ─── Response schemas ─────────────────────────────────────────────

const codeLocatorSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  commitSha: z.string().optional(),
});

const escalationSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    kind: z.enum(ESCALATION_KINDS),
    status: z.enum(ESCALATION_STATUSES),
    severity: z.enum(ESCALATION_SEVERITIES).nullable(),
    title: z.string(),
    body: z.string().nullable(),
    codeLocator: codeLocatorSchema.nullable(),
    anchorType: z.enum(ESCALATION_ANCHOR_TYPES).nullable(),
    anchorId: z.string().nullable(),
    originRepo: z.string(),
    originWorkerKey: z.string(),
    holderId: z.string().nullable(),
    authorId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    resolvedAt: z.string().nullable(),
    resolvedBy: z.string().nullable(),
  })
  .openapi("Escalation");

const escalationMessageSchema = z
  .object({
    id: z.string(),
    escalationId: z.string(),
    seq: z.number().int().nonnegative(),
    authorId: z.string(),
    body: z.string(),
    messageType: z.enum(ESCALATION_MESSAGE_TYPES).nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
  })
  .openapi("EscalationMessage");

const escalationWithThreadSchema = escalationSchema
  .extend({
    messages: z.array(escalationMessageSchema),
  })
  .openapi("EscalationWithThread");

const escalationDataEnvelope = z.object({
  data: escalationSchema,
});

const escalationWithThreadEnvelope = z.object({
  data: escalationWithThreadSchema,
});

const escalationListEnvelope = z.object({
  data: z.array(escalationSchema),
  pagination: z.object({
    total: z.number(),
  }),
});

// ─── C2 §P1: delivery-cursor schemas ──────────────────────────────

const undeliveredEscalationSchema = z
  .object({
    escalation: escalationSchema,
    unreadMessages: z.array(escalationMessageSchema),
    unreadCount: z.number().int().nonnegative(),
  })
  .openapi("UndeliveredEscalation");

const undeliveredListEnvelope = z.object({
  data: z.array(undeliveredEscalationSchema),
});

const markDeliveredBody = z
  .object({
    workerKey: z.string().min(1),
    uptoSeq: z.number().int().nonnegative(),
  })
  .openapi("MarkDelivered");

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ──────────────────────────────────────────────

const createEscalationBody = z
  .object({
    kind: z.enum(ESCALATION_KINDS),
    title: z.string().min(1, "Title is required"),
    body: z.string().nullable().optional(),
    severity: z.enum(ESCALATION_SEVERITIES).nullable().optional(),
    codeLocator: codeLocatorSchema.nullable().optional(),
    anchorType: z.enum(ESCALATION_ANCHOR_TYPES).nullable().optional(),
    anchorId: z.string().nullable().optional(),
    originRepo: z.string().min(1),
    originWorkerKey: z.string().min(1),
  })
  .openapi("CreateEscalation");

const createMessageBody = z
  .object({
    body: z.string().min(1),
    messageType: z.enum(ESCALATION_MESSAGE_TYPES).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("CreateEscalationMessage");

const answerBody = z
  .object({
    body: z.string().optional(),
  })
  .openapi("AnswerEscalation");

const resolveBody = z
  .object({
    reason: z.string().min(1),
  })
  .openapi("ResolveEscalation");

const escalateToHumanBody = z
  .object({
    reason: z.string().min(1),
  })
  .openapi("EscalateToHuman");

const listEscalationsQuery = z.object({
  status: z.enum(ESCALATION_STATUSES).optional(),
  kind: z.enum(ESCALATION_KINDS).optional(),
  severity: z.enum(ESCALATION_SEVERITIES).optional(),
  originRepo: z.string().optional(),
  originWorkerKey: z.string().optional(),
  holderId: z.string().optional(),
});

const undeliveredQuery = z.object({
  worker_key: z.string().min(1),
  project_id: z.string().optional(),
});

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const escalationIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

// ─── Route definitions ────────────────────────────────────────────

const createEscalationRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/escalations",
  tags: ["Escalations"],
  summary: "Raise escalation",
  description:
    "Raise a new escalation (bug_report/question/request/blocked) for a project. Any authenticated caller may raise; the author is the caller (never accepted from the body). Status defaults `open`.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: {
      content: { "application/json": { schema: createEscalationBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Escalation raised",
      content: { "application/json": { schema: escalationDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const listEscalationsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/escalations",
  tags: ["Escalations"],
  summary: "List escalations",
  description: "List escalations for a project, newest first, with optional filters.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: listEscalationsQuery,
  },
  responses: {
    200: {
      description: "List of escalations",
      content: { "application/json": { schema: escalationListEnvelope } },
    },
  },
});

const undeliveredRoute = createRoute({
  method: "get",
  path: "/api/v1/escalations/undelivered",
  tags: ["Escalations"],
  summary: "List undelivered escalations for a worker",
  description:
    "List the origin worker's escalations that carry unread directed replies (messages not authored by the origin author, with seq beyond the origin's advisory delivery cursor). `worker_key` is required; `project_id` optionally scopes it. Returns each escalation with its unread messages and their count.",
  request: {
    query: undeliveredQuery,
  },
  responses: {
    200: {
      description: "Undelivered escalations for the worker",
      content: { "application/json": { schema: undeliveredListEnvelope } },
    },
    400: {
      description: "Validation error (missing worker_key)",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const markDeliveredRoute = createRoute({
  method: "post",
  path: "/api/v1/escalations/{id}/mark-delivered",
  tags: ["Escalations"],
  summary: "Advance the delivery cursor",
  description:
    "Advance the origin worker's delivery cursor on an escalation to `uptoSeq` (forward-only — never decreases). `workerKey` must match the escalation's origin (else 403). The cursor is an ADVISORY delivery watermark, NOT token-bound: any authed caller presenting the matching worker_key can advance it — acceptable in the trusted pool, since messages are never destroyed and the full thread stays re-fetchable via GET by-id.",
  request: {
    params: z.object({ id: escalationIdParam }),
    body: {
      content: { "application/json": { schema: markDeliveredBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Cursor advanced; updated escalation returned",
      content: { "application/json": { schema: escalationDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "worker_key does not match the escalation's origin",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Escalation not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getEscalationRoute = createRoute({
  method: "get",
  path: "/api/v1/escalations/{id}",
  tags: ["Escalations"],
  summary: "Get escalation",
  description: "Get a single escalation by ID with its full ordered thread (messages asc by seq).",
  request: {
    params: z.object({ id: escalationIdParam }),
  },
  responses: {
    200: {
      description: "Escalation with thread",
      content: { "application/json": { schema: escalationWithThreadEnvelope } },
    },
    404: {
      description: "Escalation not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const addMessageRoute = createRoute({
  method: "post",
  path: "/api/v1/escalations/{id}/messages",
  tags: ["Escalations"],
  summary: "Add thread message",
  description:
    "Append a message (reply/diagnosis/instruction) to an escalation thread. Authz: a human OR the author OR the holder may reply; else 403. A resolved thread is append-frozen (409).",
  request: {
    params: z.object({ id: escalationIdParam }),
    body: {
      content: { "application/json": { schema: createMessageBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Message appended; updated escalation returned",
      content: { "application/json": { schema: escalationDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Caller is not allowed to reply to this escalation",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Escalation not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Escalation is resolved and append-frozen",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const acknowledgeRoute = createRoute({
  method: "post",
  path: "/api/v1/escalations/{id}/acknowledge",
  tags: ["Escalations"],
  summary: "Acknowledge escalation",
  description:
    "Acknowledge an open escalation (open → acknowledged) — the PM-side PICKUP. Authz: a human OR an unclaimed escalation OR the current holder; a different ai_agent on a held escalation gets 403. An ai_agent acknowledging an unclaimed escalation auto-claims it (becomes the holder).",
  request: {
    params: z.object({ id: escalationIdParam }),
  },
  responses: {
    200: {
      description: "Escalation acknowledged",
      content: { "application/json": { schema: escalationDataEnvelope } },
    },
    403: {
      description: "Caller is not allowed to acknowledge this escalation",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Escalation not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Escalation cannot transition to acknowledged",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const answerRoute = createRoute({
  method: "post",
  path: "/api/v1/escalations/{id}/answer",
  tags: ["Escalations"],
  summary: "Answer escalation",
  description:
    "Answer an acknowledged escalation (acknowledged → answered). Authz: a human OR the holder OR an unclaimed escalation; else 403. Self-claim-on-answer: an unheld escalation binds to the answerer. An optional `body` is appended as a `diagnosis` message.",
  request: {
    params: z.object({ id: escalationIdParam }),
    body: {
      content: { "application/json": { schema: answerBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Escalation answered",
      content: { "application/json": { schema: escalationDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Caller is not allowed to answer this escalation",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Escalation not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Escalation cannot transition to answered",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const resolveRoute = createRoute({
  method: "post",
  path: "/api/v1/escalations/{id}/resolve",
  tags: ["Escalations"],
  summary: "Resolve escalation",
  description:
    "Resolve an escalation (→ resolved, terminal). Authz: a human OR the author OR the holder; else 403. The origin author may withdraw from any non-terminal state; a non-author may resolve only from answered/needs_human. A reason is required and recorded as a `system` message.",
  request: {
    params: z.object({ id: escalationIdParam }),
    body: {
      content: { "application/json": { schema: resolveBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Escalation resolved",
      content: { "application/json": { schema: escalationDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Caller is not allowed to resolve this escalation",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Escalation not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Escalation cannot be resolved from its current state",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const escalateToHumanRoute = createRoute({
  method: "post",
  path: "/api/v1/escalations/{id}/escalate-to-human",
  tags: ["Escalations"],
  summary: "Escalate to human",
  description:
    "Escalate to a human (any non-terminal state → needs_human). Authz: a human OR the author OR the holder; else 403. A reason is required and recorded as a `system` message.",
  request: {
    params: z.object({ id: escalationIdParam }),
    body: {
      content: { "application/json": { schema: escalateToHumanBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Escalation marked needs_human",
      content: { "application/json": { schema: escalationDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Caller is not allowed to escalate this escalation to a human",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Escalation not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Escalation cannot transition to needs_human",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createEscalationRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // POST /api/v1/projects/:projectId/escalations
  router.openapi(createEscalationRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser")!;
    const escalation = escalationService.create(projectId, body, {
      id: user.id,
      type: user.type as UserType,
    });
    return c.json({ data: escalation }, 201);
  });

  // GET /api/v1/projects/:projectId/escalations
  router.openapi(listEscalationsRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const query = c.req.valid("query");
    const list = escalationService.list(projectId, query);
    return c.json({ data: list, pagination: { total: list.length } }, 200);
  });

  // GET /api/v1/escalations/undelivered (registered BEFORE /:id so the
  // literal segment is not shadowed by the {id} param route)
  router.openapi(undeliveredRoute, (c) => {
    const { worker_key, project_id } = c.req.valid("query");
    const data = escalationService.listUndeliveredForWorker(worker_key, project_id);
    return c.json({ data }, 200);
  });

  // GET /api/v1/escalations/:id
  router.openapi(getEscalationRoute, (c) => {
    const { id } = c.req.valid("param");
    return c.json({ data: escalationService.getById(id) }, 200);
  });

  // POST /api/v1/escalations/:id/mark-delivered
  router.openapi(markDeliveredRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const escalation = escalationService.markDelivered(id, body.uptoSeq, body.workerKey);
    return c.json({ data: escalation }, 200);
  });

  // POST /api/v1/escalations/:id/messages
  router.openapi(addMessageRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser")!;
    const escalation = escalationService.addMessage(id, body, {
      id: user.id,
      type: user.type as UserType,
    });
    return c.json({ data: escalation }, 201);
  });

  // POST /api/v1/escalations/:id/acknowledge
  router.openapi(acknowledgeRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser")!;
    const escalation = escalationService.acknowledge(id, {
      id: user.id,
      type: user.type as UserType,
    });
    return c.json({ data: escalation }, 200);
  });

  // POST /api/v1/escalations/:id/answer
  router.openapi(answerRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser")!;
    const escalation = escalationService.answer(id, body, {
      id: user.id,
      type: user.type as UserType,
    });
    return c.json({ data: escalation }, 200);
  });

  // POST /api/v1/escalations/:id/resolve
  router.openapi(resolveRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser")!;
    const escalation = escalationService.resolve(id, body, {
      id: user.id,
      type: user.type as UserType,
    });
    return c.json({ data: escalation }, 200);
  });

  // POST /api/v1/escalations/:id/escalate-to-human
  router.openapi(escalateToHumanRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser")!;
    const escalation = escalationService.escalateToHuman(id, body, {
      id: user.id,
      type: user.type as UserType,
    });
    return c.json({ data: escalation }, 200);
  });

  return router;
}
