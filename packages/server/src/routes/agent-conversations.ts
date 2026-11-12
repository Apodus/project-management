import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { DISCORD_MESSAGE_KINDS, DISCORD_DELIVERY_STATUSES } from "@pm/shared";
import { AppError, type AppVariables, type AppContext } from "../types.js";
import * as service from "../services/agent-conversation.service.js";
import { DiscordTransportError } from "../services/discord-runtime.js";

// OpenAPI uses Zod 4; the canonical shared input schemas use Zod 3. Keep parity tests.
const sendBody = z
  .object({
    sessionTitle: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1500),
    idempotencyKey: z.string().min(1).max(128),
    kind: z.enum(DISCORD_MESSAGE_KINDS).default("update"),
    conversationId: z.string().min(1).optional(),
  })
  .strict()
  .openapi("DiscordSendInput");
const routeBody = z
  .object({
    guildId: z.string().regex(/^\d{17,20}$/),
    channelId: z.string().regex(/^\d{17,20}$/),
    recipientUserId: z.string().min(1),
    recipientDiscordId: z.string().regex(/^\d{17,20}$/),
    enabled: z.boolean(),
    generation: z.number().int().nonnegative(),
  })
  .strict()
  .openapi("DiscordRouteInput");
const summary = z
  .object({
    id: z.string(),
    code: z.string(),
    projectId: z.string(),
    sessionTitle: z.string(),
    ownerUserId: z.string(),
    sessionId: z.string(),
    consumerGeneration: z.number(),
    status: z.enum(["open", "closed"]),
    suspended: z.boolean(),
    isTest: z.boolean(),
    unreadCount: z.number(),
    createdAt: z.string(),
    lastCheckedAt: z.string().nullable(),
  })
  .openapi("DiscordConversationSummary");
const message = z
  .object({
    id: z.string(),
    seq: z.number(),
    direction: z.enum(["agent", "human", "system"]),
    body: z.string(),
    authorLabel: z.string(),
    createdAt: z.string(),
    acknowledgedAt: z.string().nullable(),
    deliveryStatus: z.enum(DISCORD_DELIVERY_STATUSES).nullable(),
    deliveryUncertain: z.boolean(),
    errorCode: z.string().nullable(),
    discordMessageId: z.string().nullable(),
  })
  .openapi("DiscordMessage");
const detail = z
  .object({
    conversation: summary,
    messages: z.array(message),
    nextBeforeSeq: z.number().nullable(),
  })
  .openapi("DiscordConversationDetail");
const sendResult = z
  .object({
    conversationId: z.string(),
    conversationCode: z.string(),
    messageId: z.string(),
    consumerGeneration: z.number(),
    deliveryStatus: z.enum(DISCORD_DELIVERY_STATUSES),
    duplicate: z.boolean(),
    replyRequested: z.boolean(),
  })
  .openapi("DiscordSendResult");
const reply = z.object({
  id: z.string(),
  conversationId: z.string(),
  conversationCode: z.string(),
  sessionTitle: z.string(),
  consumerGeneration: z.number(),
  body: z.string(),
  authorLabel: z.string(),
  createdAt: z.string(),
  conversationClosed: z.boolean(),
});
const inbox = z
  .object({ replies: z.array(reply), hasMore: z.boolean() })
  .openapi("DiscordReplyInbox");
const routeView = z
  .object({
    route: z
      .object({
        ...routeBody.shape,
        channelName: z.string(),
        verifiedAt: z.string(),
        testUntil: z.string().nullable(),
      })
      .nullable(),
    bridge: z.object({
      enabled: z.boolean(),
      tokenPresent: z.boolean(),
      connected: z.boolean(),
      botId: z.string().nullable(),
      botName: z.string().nullable(),
      errorCode: z.string().nullable(),
    }),
    pendingSends: z.number(),
    unreadReplies: z.number(),
    oldestPendingAt: z.string().nullable(),
    lastSentAt: z.string().nullable(),
    lastReplyAt: z.string().nullable(),
    lastHistorySyncAt: z.string().nullable(),
    historyError: z.string().nullable(),
    recentFailures: z.array(
      z.object({ messageId: z.string(), code: z.string().nullable(), uncertain: z.boolean() }),
    ),
  })
  .openapi("DiscordRouteView");
const errorBody = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      retry_after_seconds: z.number().optional(),
    }),
  })
  .openapi("DiscordError");
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 503].map((status) => [
    status,
    {
      description: "Request failed",
      content: {
        "application/json": {
          schema: errorBody,
        },
      },
    },
  ]),
);
const response = <T extends z.ZodType>(schema: T) => ({
  description: "Success",
  content: { "application/json": { schema: z.object({ data: schema }) } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});
const projectParam = z.object({ projectId: z.string().min(1) });
const idParam = z.object({ id: z.string().min(1) });
const headers = z.object({ "x-pm-session-id": z.string().min(1).max(128) });
const tags = ["Agent conversations"];
function actor(c: AppContext) {
  const user = c.get("currentUser");
  if (!user) throw new AppError(401, "UNAUTHORIZED", "Authentication required.");
  return user;
}
function session(c: AppContext) {
  return c.req.header("x-pm-session-id") ?? "";
}

export function createAgentConversationRoutes() {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();
  router.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/discord-agent-route",
      tags,
      request: { params: projectParam },
      responses: { 200: response(routeView), ...errors },
    }),
    (c) => c.json({ data: service.getRoute(c.req.valid("param").projectId, actor(c)) }, 200),
  );
  router.openapi(
    createRoute({
      method: "put",
      path: "/api/v1/projects/{projectId}/discord-agent-route",
      tags,
      request: { params: projectParam, body: body(routeBody) },
      responses: { 200: response(routeView), ...errors },
    }),
    async (c) => {
      try {
        return c.json(
          {
            data: await service.saveRoute(
              c.req.valid("param").projectId,
              c.req.valid("json"),
              actor(c),
            ),
          },
          200,
        );
      } catch (e) {
        if (e instanceof DiscordTransportError)
          throw new AppError(
            409,
            e.code,
            "Discord channel validation failed. Check bot connection, channel type and permissions.",
          );
        throw e;
      }
    },
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/discord-agent-route/test",
      tags,
      request: {
        params: projectParam,
        body: body(z.object({ idempotencyKey: z.string().min(1).max(128) }).strict()),
      },
      responses: { 202: response(sendResult), ...errors },
    }),
    (c) => {
      service.requireHumanAdmin(actor(c));
      return c.json(
        {
          data: service.sendMessage(
            c.req.valid("param").projectId,
            {
              sessionTitle: "Discord connection test",
              message:
                "This is the PM Discord connection test. Reply here with a short text message, then acknowledge it in PM to verify both directions.",
              kind: "question",
              idempotencyKey: c.req.valid("json").idempotencyKey,
            },
            actor(c),
            `discord-test:${actor(c).id}`,
            true,
          ),
        },
        202,
      );
    },
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/agent-conversations/messages",
      tags,
      request: { params: projectParam, headers, body: body(sendBody) },
      responses: { 200: response(sendResult), 202: response(sendResult), ...errors },
    }),
    (c) => {
      const result = service.sendMessage(
        c.req.valid("param").projectId,
        c.req.valid("json"),
        actor(c),
        session(c),
      );
      return c.json({ data: result }, result.duplicate ? 200 : 202);
    },
  );
  const listResponse = z.object({
    conversations: z.array(summary),
    nextCursor: z.string().nullable(),
  });
  const listQuery = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });
  router.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/agent-conversations",
      tags,
      request: { params: projectParam, query: listQuery },
      responses: { 200: response(listResponse), ...errors },
    }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(
        {
          data: service.listConversations(
            actor(c),
            c.req.valid("param").projectId,
            q.cursor,
            q.limit,
          ),
        },
        200,
      );
    },
  );
  router.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/agent-conversations",
      tags,
      request: { query: listQuery },
      responses: { 200: response(listResponse), ...errors },
    }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(
        { data: service.listConversations(actor(c), undefined, q.cursor, q.limit) },
        200,
      );
    },
  );
  router.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/agent-conversations/replies",
      tags,
      request: {
        headers,
        query: z.object({
          conversationId: z.string().optional(),
          waitSeconds: z.coerce.number().int().min(0).max(25).default(0),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
      },
      responses: { 200: response(inbox), ...errors },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const deadline = Date.now() + q.waitSeconds * 1000;
      let result = service.checkReplies(actor(c), session(c), q.conversationId, q.limit);
      while (!result.replies.length && Date.now() < deadline && !c.req.raw.signal.aborted) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            service.discordEvents.off("changed", done);
            c.req.raw.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, Math.min(1000, deadline - Date.now()));
          service.discordEvents.once("changed", done);
          c.req.raw.signal.addEventListener("abort", done, { once: true });
        });
        result = service.checkReplies(actor(c), session(c), q.conversationId, q.limit);
      }
      return c.json({ data: result }, 200);
    },
  );
  router.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/agent-conversations/{id}",
      tags,
      request: {
        params: idParam,
        query: z.object({
          beforeSeq: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: response(detail), ...errors },
    }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(
        { data: service.getConversation(c.req.valid("param").id, actor(c), q.beforeSeq, q.limit) },
        200,
      );
    },
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/agent-conversations/{id}/ack",
      tags,
      request: {
        params: idParam,
        headers,
        body: body(
          z
            .object({
              replyIds: z.array(z.string().min(1)).min(1).max(50),
              consumerGeneration: z.number().int().positive(),
            })
            .strict(),
        ),
      },
      responses: { 200: response(z.object({ acknowledgedIds: z.array(z.string()) })), ...errors },
    }),
    (c) => {
      const b = c.req.valid("json");
      return c.json(
        {
          data: service.acknowledge(
            c.req.valid("param").id,
            b.replyIds,
            b.consumerGeneration,
            actor(c),
            session(c),
          ),
        },
        200,
      );
    },
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/agent-conversations/{id}/resume",
      tags,
      request: { params: idParam, headers },
      responses: { 200: response(detail), ...errors },
    }),
    (c) => c.json({ data: service.resume(c.req.valid("param").id, actor(c), session(c)) }, 200),
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/agent-conversations/{id}/close",
      tags,
      request: { params: idParam },
      responses: { 200: response(summary), ...errors },
    }),
    (c) =>
      c.json(
        { data: service.closeConversation(c.req.valid("param").id, actor(c), session(c)) },
        200,
      ),
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/agent-conversations/{id}/reassign",
      tags,
      request: {
        params: idParam,
        body: body(
          z
            .object({
              ownerUserId: z.string().min(1),
              sessionId: z.string().min(1).max(128),
              reason: z.string().trim().min(1).max(1000),
            })
            .strict(),
        ),
      },
      responses: { 200: response(summary), ...errors },
    }),
    (c) => {
      const b = c.req.valid("json");
      return c.json(
        {
          data: service.reassign(
            c.req.valid("param").id,
            b.ownerUserId,
            b.sessionId,
            b.reason,
            actor(c),
          ),
        },
        200,
      );
    },
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/agent-conversations/{id}/messages/{messageId}/retry",
      tags,
      request: {
        params: idParam.extend({ messageId: z.string().min(1) }),
        body: body(
          z
            .object({
              idempotencyKey: z.string().min(1).max(128),
              reason: z.string().trim().min(1).max(1000),
            })
            .strict(),
        ),
      },
      responses: {
        202: response(z.object({ jobId: z.string(), status: z.enum(DISCORD_DELIVERY_STATUSES) })),
        ...errors,
      },
    }),
    (c) => {
      const b = c.req.valid("json"),
        p = c.req.valid("param");
      return c.json(
        { data: service.retryMessage(p.id, p.messageId, b.idempotencyKey, b.reason, actor(c)) },
        202,
      );
    },
  );
  return router;
}
