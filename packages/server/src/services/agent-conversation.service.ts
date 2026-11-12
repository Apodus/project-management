import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  createId,
  discordSendSchema,
  discordRouteInputSchema,
  type AuditAction,
  type DiscordConversationSummary,
  type DiscordConversationDetail,
  type DiscordSendInput,
  type DiscordSendResult,
  type DiscordReplyInbox,
  type DiscordRouteInput,
  type DiscordRouteView,
} from "@pm/shared";
import {
  getDb,
  projects,
  users,
  auditLog,
  agentConversations as conversations,
  agentConversationMessages as messages,
  discordAgentRoutes as routes,
  discordDeliveryJobs as jobs,
  discordMessageLinks as links,
  discordInboundEvents as inbound,
  discordChannelState as channels,
} from "../db/index.js";
import { AppError, type AuthUser } from "../types.js";
import { discordHealth, discordTransport, type DiscordWireMessage } from "./discord-runtime.js";

export const discordEvents = new EventEmitter();
discordEvents.setMaxListeners(200);
export type Conversation = typeof conversations.$inferSelect;
export type DeliveryJob = typeof jobs.$inferSelect;
export type ConversationMessage = typeof messages.$inferSelect;
export const pendingStatuses = ["queued", "retry_wait", "sending"] as const;
const nowIso = () => new Date().toISOString();
const plus = (now: string, ms: number) => new Date(Date.parse(now) + ms).toISOString();
const publicCode = () => randomBytes(5).toString("hex").toUpperCase();
export function notifyConversation(id: string): void {
  try {
    discordEvents.emit("changed", id);
  } catch {
    /* Committed state remains readable. */
  }
}
export function requireHumanAdmin(actor: AuthUser): void {
  if (actor.type !== "human" || actor.role !== "admin")
    throw new AppError(403, "FORBIDDEN", "Human administrator required.");
}
function admin(actor: AuthUser) {
  return actor.type === "human" && actor.role === "admin";
}
function project(id: string) {
  const row = getDb().select().from(projects).where(eq(projects.id, id)).get();
  if (!row) throw new AppError(404, "NOT_FOUND", "Project not found.");
  return row;
}
export function conversationRow(id: string): Conversation {
  const row = getDb().select().from(conversations).where(eq(conversations.id, id)).get();
  if (!row) throw new AppError(404, "NOT_FOUND", "Conversation not found.");
  return row;
}
export function canReadConversation(c: Conversation, actor: AuthUser): boolean {
  return (
    c.ownerUserId === actor.id ||
    admin(actor) ||
    (actor.type === "human" && c.recipientUserId === actor.id)
  );
}
function readable(id: string, actor: AuthUser) {
  const c = conversationRow(id);
  if (!canReadConversation(c, actor))
    throw new AppError(404, "NOT_FOUND", "Conversation not found.");
  return c;
}
function bound(c: Conversation, actor: AuthUser, sessionId: string, generation?: number): void {
  if (c.ownerUserId !== actor.id)
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only the originating owner can consume this conversation.",
    );
  if (
    !sessionId ||
    c.sessionId !== sessionId ||
    (generation !== undefined && c.consumerGeneration !== generation)
  ) {
    throw new AppError(
      409,
      "SESSION_MISMATCH",
      "Explicitly resume the conversation before using this session. An old reply generation cannot be acknowledged.",
    );
  }
}
export function auditDiscord(
  projectId: string,
  actorId: string,
  action: AuditAction,
  targetId: string,
  metadata: Record<string, unknown>,
  reason?: string,
): void {
  getDb()
    .insert(auditLog)
    .values({
      id: createId(),
      projectId,
      actorId,
      action,
      targetType:
        action === "discord_route_updated"
          ? "discord_route"
          : action.startsWith("discord_delivery")
            ? "discord_delivery"
            : "agent_conversation",
      targetId,
      reason: reason ?? null,
      metadataBefore: null,
      metadataAfter: metadata,
      createdAt: nowIso(),
    })
    .run();
}
export function routeAllows(c: Conversation, now = nowIso()): boolean {
  const route = getDb().select().from(routes).where(eq(routes.projectId, c.projectId)).get();
  const human = getDb().select().from(users).where(eq(users.id, c.recipientUserId)).get();
  return (
    !!route &&
    !!human?.isActive &&
    human.type === "human" &&
    route.generation === c.routeGeneration &&
    (c.isTest ? !!route.testUntil && route.testUntil > now : route.enabled)
  );
}
function summary(c: Conversation): DiscordConversationSummary {
  const unreadCount = getDb()
    .select({ value: sql<number>`count(*)` })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, c.id),
        eq(messages.direction, "human"),
        isNull(messages.acknowledgedAt),
      ),
    )
    .get()!.value;
  return {
    id: c.id,
    code: c.code,
    projectId: c.projectId,
    sessionTitle: c.sessionTitle,
    ownerUserId: c.ownerUserId,
    sessionId: c.sessionId,
    consumerGeneration: c.consumerGeneration,
    status: c.status,
    suspended: !routeAllows(c),
    isTest: c.isTest,
    unreadCount,
    createdAt: c.createdAt,
    lastCheckedAt: c.lastCheckedAt,
  };
}
export function listConversations(
  actor: AuthUser,
  projectId?: string,
  cursor?: string,
  limit = 50,
) {
  const rows = getDb()
    .select()
    .from(conversations)
    .where(
      and(
        projectId ? eq(conversations.projectId, projectId) : undefined,
        cursor ? lt(conversations.id, cursor) : undefined,
        admin(actor) && projectId
          ? undefined
          : or(
              eq(conversations.ownerUserId, actor.id),
              actor.type === "human" && projectId
                ? eq(conversations.recipientUserId, actor.id)
                : undefined,
            ),
      ),
    )
    .orderBy(desc(conversations.id))
    .limit(limit + 1)
    .all();
  return {
    conversations: rows.slice(0, limit).map(summary),
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
  };
}
export function getConversation(
  id: string,
  actor: AuthUser,
  beforeSeq?: number,
  limit = 50,
): DiscordConversationDetail {
  const c = readable(id, actor);
  const rows = getDb()
    .select()
    .from(messages)
    .where(
      and(eq(messages.conversationId, id), beforeSeq ? lt(messages.seq, beforeSeq) : undefined),
    )
    .orderBy(desc(messages.seq))
    .limit(limit + 1)
    .all();
  return {
    conversation: summary(c),
    nextBeforeSeq: rows.length > limit ? rows[limit - 1]!.seq : null,
    messages: rows
      .slice(0, limit)
      .reverse()
      .map((m) => {
        const job = getDb()
          .select()
          .from(jobs)
          .where(eq(jobs.messageId, m.id))
          .orderBy(desc(jobs.createdAt), desc(jobs.id))
          .get();
        return {
          id: m.id,
          seq: m.seq,
          direction: m.direction,
          body: m.body,
          authorLabel: m.authorLabel,
          createdAt: m.createdAt,
          acknowledgedAt: m.acknowledgedAt,
          discordMessageId: m.discordMessageId,
          deliveryStatus: job?.status ?? null,
          deliveryUncertain: job?.uncertain ?? false,
          errorCode: job?.errorCode ?? null,
        };
      }),
  };
}
export async function saveRoute(
  projectId: string,
  raw: DiscordRouteInput,
  actor: AuthUser,
): Promise<DiscordRouteView> {
  requireHumanAdmin(actor);
  project(projectId);
  const input = discordRouteInputSchema.parse(raw);
  const current = getDb().select().from(routes).where(eq(routes.projectId, projectId)).get();
  const disablingExisting =
    !input.enabled &&
    current &&
    current.guildId === input.guildId &&
    current.channelId === input.channelId &&
    current.recipientUserId === input.recipientUserId &&
    current.recipientDiscordId === input.recipientDiscordId;
  const human = getDb().select().from(users).where(eq(users.id, input.recipientUserId)).get();
  if (!disablingExisting && (!human?.isActive || human.type !== "human"))
    throw new AppError(400, "INVALID_RECIPIENT", "Select an active PM human.");
  const transport = discordTransport();
  if (!disablingExisting && (!transport || !discordHealth().enabled))
    throw new AppError(
      409,
      "DISCORD_DISABLED",
      "Configure and enable the server Discord bridge first.",
    );
  // Operators must be able to stop traffic even while Discord is unavailable.
  const channel = disablingExisting
    ? { name: current.channelName }
    : await transport!.validateChannel(input.guildId, input.channelId);
  const now = nowIso();
  getDb().transaction(() => {
    const previous = getDb().select().from(routes).where(eq(routes.projectId, projectId)).get();
    if ((previous?.generation ?? 0) !== input.generation)
      throw new AppError(409, "CONFIG_CHANGED", "Reload the configuration before saving.");
    const unchanged =
      previous &&
      previous.guildId === input.guildId &&
      previous.channelId === input.channelId &&
      previous.recipientUserId === input.recipientUserId &&
      previous.recipientDiscordId === input.recipientDiscordId &&
      previous.enabled === input.enabled;
    const generation = unchanged ? previous.generation : input.generation + 1;
    getDb()
      .insert(routes)
      .values({
        ...input,
        projectId,
        generation,
        channelName: channel.name,
        activatedAt: now,
        verifiedAt: disablingExisting ? current.verifiedAt : now,
        updatedAt: now,
        updatedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: routes.projectId,
        set: {
          ...input,
          generation,
          channelName: channel.name,
          activatedAt: unchanged ? previous.activatedAt : now,
          verifiedAt: disablingExisting ? current.verifiedAt : now,
          updatedAt: now,
          updatedBy: actor.id,
          errorCode: null,
          testUntil: unchanged ? previous.testUntil : null,
        },
      })
      .run();
    if (!unchanged)
      getDb()
        .update(jobs)
        .set({ status: "cancelled", errorCode: "ROUTE_CHANGED" })
        .where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ["queued", "retry_wait"])))
        .run();
    // Discord snowflake immediately before activation. Never reset an existing channel cursor.
    const watermark = ((BigInt(Date.parse(now)) - 1420070400000n) << 22n).toString();
    getDb()
      .insert(channels)
      .values({ channelId: input.channelId, watermark })
      .onConflictDoNothing()
      .run();
    auditDiscord(projectId, actor.id, "discord_route_updated", projectId, {
      generation,
      enabled: input.enabled,
      channelId: input.channelId,
    });
  });
  return getRoute(projectId, actor);
}
export function getRoute(projectId: string, actor: AuthUser): DiscordRouteView {
  requireHumanAdmin(actor);
  project(projectId);
  const route = getDb().select().from(routes).where(eq(routes.projectId, projectId)).get();
  const projectJobs = getDb().select().from(jobs).where(eq(jobs.projectId, projectId)).all();
  const pending = projectJobs.filter((j) =>
    pendingStatuses.includes(j.status as (typeof pendingStatuses)[number]),
  );
  const humanMessages = getDb()
    .select({ message: messages })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.projectId, projectId), eq(messages.direction, "human")))
    .all()
    .map((r) => r.message);
  const state = route
    ? getDb().select().from(channels).where(eq(channels.channelId, route.channelId)).get()
    : undefined;
  return {
    route: route
      ? {
          guildId: route.guildId,
          channelId: route.channelId,
          recipientUserId: route.recipientUserId,
          recipientDiscordId: route.recipientDiscordId,
          enabled: route.enabled,
          generation: route.generation,
          channelName: route.channelName,
          verifiedAt: route.verifiedAt,
          testUntil: route.testUntil,
        }
      : null,
    bridge: { ...discordHealth(), errorCode: route?.errorCode ?? discordHealth().errorCode },
    pendingSends: pending.length,
    unreadReplies: humanMessages.filter((m) => !m.acknowledgedAt).length,
    oldestPendingAt: pending.map((j) => j.createdAt).sort()[0] ?? null,
    lastSentAt:
      projectJobs
        .flatMap((j) => (j.deliveredAt ? [j.deliveredAt] : []))
        .sort()
        .at(-1) ?? null,
    lastReplyAt:
      humanMessages
        .map((m) => m.createdAt)
        .sort()
        .at(-1) ?? null,
    lastHistorySyncAt: state?.lastSyncedAt ?? null,
    historyError: state?.errorCode ?? null,
    recentFailures: projectJobs
      .filter((j) => ["failed", "expired"].includes(j.status))
      .slice(-10)
      .map((j) => ({ messageId: j.messageId, code: j.errorCode, uncertain: j.uncertain })),
  };
}
export function appendMessage(
  c: Conversation,
  values: Pick<ConversationMessage, "direction" | "body" | "authorLabel"> &
    Partial<ConversationMessage>,
): ConversationMessage {
  const seq = getDb()
    .select({ value: sql<number>`coalesce(max(${messages.seq}), 0) + 1` })
    .from(messages)
    .where(eq(messages.conversationId, c.id))
    .get()!.value;
  return getDb()
    .insert(messages)
    .values({ id: createId(), conversationId: c.id, seq, createdAt: nowIso(), ...values })
    .returning()
    .get();
}
export function enqueueJob(
  c: Conversation,
  messageId: string,
  content: string,
  operation: DeliveryJob["operation"],
  operationKey: string,
  extra: Partial<DeliveryJob> = {},
): DeliveryJob {
  const now = nowIso();
  return getDb()
    .insert(jobs)
    .values({
      id: createId(),
      projectId: c.projectId,
      conversationId: c.id,
      messageId,
      ownerUserId: c.ownerUserId,
      content,
      operation,
      operationKey,
      reference: publicCode(),
      nonce: randomBytes(12).toString("hex"),
      routeGeneration: c.routeGeneration,
      createdAt: now,
      nextAttemptAt: now,
      expiresAt: plus(now, 3600_000),
      ...extra,
    })
    .returning()
    .get();
}
function label(value: string, max: number) {
  return value.replace(/[\r\n@*_`~<>\\]/g, " ").slice(0, max);
}
function sendResult(job: DeliveryJob, duplicate: boolean): DiscordSendResult {
  const c = conversationRow(job.conversationId);
  const m = getDb().select().from(messages).where(eq(messages.id, job.messageId)).get()!;
  return {
    conversationId: c.id,
    conversationCode: c.code,
    messageId: m.id,
    consumerGeneration: c.consumerGeneration,
    deliveryStatus: job.status,
    duplicate,
    replyRequested: m.kind !== "update",
  };
}
export function sendMessage(
  projectId: string,
  raw: DiscordSendInput,
  actor: AuthUser,
  sessionId: string,
  isTest = false,
): DiscordSendResult {
  const input = discordSendSchema.parse(raw);
  if (!sessionId || sessionId.length > 128)
    throw new AppError(400, "SESSION_REQUIRED", "Supply X-PM-Session-Id (1..128 characters).");
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ ...input, isTest }))
    .digest("hex");
  const result = getDb().transaction(() => {
    const existing = getDb()
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.projectId, projectId),
          eq(jobs.ownerUserId, actor.id),
          eq(jobs.idempotencyKey, input.idempotencyKey),
        ),
      )
      .get();
    if (existing) {
      readable(existing.conversationId, actor);
      if (existing.requestHash !== requestHash)
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This key already identifies a different logical message.",
        );
      return sendResult(existing, true);
    }
    const p = project(projectId);
    const health = discordHealth();
    if (!health.enabled || !health.tokenPresent)
      throw new AppError(
        409,
        "DISCORD_DISABLED",
        "The server Discord bridge is disabled or missing its token.",
      );
    if (health.errorCode === "INVALID_TOKEN")
      throw new AppError(409, "DISCORD_ROUTE_UNHEALTHY", "Repair the bot token before sending.");
    const route = getDb().select().from(routes).where(eq(routes.projectId, projectId)).get();
    if (!route)
      throw new AppError(
        409,
        "DISCORD_NOT_CONFIGURED",
        "A human admin must configure the project's agent channel.",
      );
    const now = nowIso();
    if (route.errorCode)
      throw new AppError(
        409,
        "DISCORD_ROUTE_UNHEALTHY",
        "Repair and save the Discord channel configuration before sending.",
      );
    if (isTest) {
      requireHumanAdmin(actor);
      getDb()
        .update(routes)
        .set({ testUntil: plus(now, 600_000) })
        .where(eq(routes.projectId, projectId))
        .run();
    } else if (!route.enabled)
      throw new AppError(
        409,
        "DISCORD_DISABLED",
        "Agent conversations are disabled for this project.",
      );
    let c: Conversation;
    if (input.conversationId) {
      c = readable(input.conversationId, actor);
      bound(c, actor, sessionId);
      if (c.projectId !== projectId)
        throw new AppError(400, "PROJECT_MISMATCH", "The conversation belongs to another project.");
      if (c.status !== "open")
        throw new AppError(409, "CONVERSATION_CLOSED", "Start a new conversation.");
      if (c.sessionTitle !== input.sessionTitle)
        throw new AppError(409, "TITLE_MISMATCH", "Use the conversation's original title.");
      if (c.isTest !== isTest || !routeAllows(c))
        throw new AppError(
          409,
          "DISCORD_DISABLED",
          "The conversation's route changed or its test expired. Start a new conversation.",
        );
    } else {
      c = getDb()
        .insert(conversations)
        .values({
          id: createId(),
          code: publicCode(),
          projectId,
          routeGeneration: route.generation,
          guildId: route.guildId,
          channelId: route.channelId,
          recipientUserId: route.recipientUserId,
          recipientDiscordId: route.recipientDiscordId,
          ownerUserId: actor.id,
          sessionId,
          sessionTitle: input.sessionTitle,
          isTest,
          createdAt: now,
        })
        .returning()
        .get();
    }
    if (!routeAllows(c))
      throw new AppError(409, "DISCORD_DISABLED", "The configured human is unavailable.");
    const projectCount = getDb()
      .select({ value: sql<number>`count(*)` })
      .from(jobs)
      .where(
        and(
          eq(jobs.projectId, projectId),
          eq(jobs.operation, "send"),
          gt(jobs.createdAt, plus(now, -3600_000)),
        ),
      )
      .get()!.value;
    const conversationCount = getDb()
      .select({ value: sql<number>`count(*)` })
      .from(jobs)
      .where(
        and(
          eq(jobs.conversationId, c.id),
          eq(jobs.operation, "send"),
          gt(jobs.createdAt, plus(now, -600_000)),
        ),
      )
      .get()!.value;
    const pendingCount = getDb()
      .select({ value: sql<number>`count(*)` })
      .from(jobs)
      .where(
        and(
          eq(jobs.projectId, projectId),
          eq(jobs.operation, "send"),
          inArray(jobs.status, pendingStatuses),
        ),
      )
      .get()!.value;
    const positiveLimit = (raw: string | undefined, fallback: number) =>
      raw && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : fallback;
    const projectLimited =
      projectCount >= positiveLimit(process.env.PM_DISCORD_PROJECT_HOURLY_LIMIT, 30);
    if (
      projectLimited ||
      conversationCount >= positiveLimit(process.env.PM_DISCORD_CONVERSATION_LIMIT, 5)
    ) {
      const seconds = projectLimited ? 3600 : 600;
      throw new AppError(
        429,
        "RATE_LIMITED",
        `Notification budget reached. Retry after ${seconds} seconds with the same key.`,
        seconds,
      );
    }
    if (pendingCount >= 100)
      throw new AppError(
        429,
        "QUEUE_FULL",
        "Pending delivery queue is full. Retry after 60 seconds.",
        60,
      );
    const m = appendMessage(c, {
      direction: "agent",
      body: input.message,
      authorLabel: actor.displayName,
      kind: input.kind,
    });
    const reference = publicCode();
    const content = `<@${c.recipientDiscordId}> ${isTest ? "TEST" : input.kind.toUpperCase()} · ${label(p.name, 60)} · ${label(c.sessionTitle, 100)} · ${c.code}\n\n${input.message}\n\nReply to this message to answer this agent conversation.\nPM message ${reference}`;
    if (content.length > 2000)
      throw new AppError(
        400,
        "MESSAGE_TOO_LONG",
        "The rendered message exceeds 2000 characters. Shorten the body.",
      );
    const job = enqueueJob(c, m.id, content, "send", `send:${m.id}`, {
      reference,
      requestHash,
      idempotencyKey: input.idempotencyKey,
    });
    return sendResult(job, false);
  });
  notifyConversation(result.conversationId);
  return result;
}
export function checkReplies(
  actor: AuthUser,
  sessionId: string,
  conversationId?: string,
  limit = 20,
): DiscordReplyInbox {
  if (!sessionId) throw new AppError(400, "SESSION_REQUIRED", "Supply X-PM-Session-Id.");
  if (conversationId) bound(readable(conversationId, actor), actor, sessionId);
  const rows = getDb()
    .select({ c: conversations, m: messages })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.ownerUserId, actor.id),
        eq(conversations.sessionId, sessionId),
        conversationId ? eq(conversations.id, conversationId) : undefined,
        eq(messages.direction, "human"),
        isNull(messages.acknowledgedAt),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.seq))
    .limit(limit + 1)
    .all();
  getDb()
    .update(conversations)
    .set({ lastCheckedAt: nowIso() })
    .where(and(eq(conversations.ownerUserId, actor.id), eq(conversations.sessionId, sessionId)))
    .run();
  return {
    hasMore: rows.length > limit,
    replies: rows.slice(0, limit).map(({ c, m }) => ({
      id: m.id,
      conversationId: c.id,
      conversationCode: c.code,
      sessionTitle: c.sessionTitle,
      consumerGeneration: c.consumerGeneration,
      body: m.body,
      authorLabel: m.authorLabel,
      createdAt: m.createdAt,
      conversationClosed: c.status === "closed",
    })),
  };
}
export function acknowledge(
  id: string,
  ids: string[],
  generation: number,
  actor: AuthUser,
  sessionId: string,
) {
  getDb().transaction(() => {
    const c = readable(id, actor);
    bound(c, actor, sessionId, generation);
    const rows = getDb()
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, id),
          inArray(messages.id, ids),
          eq(messages.direction, "human"),
        ),
      )
      .all();
    if (rows.length !== new Set(ids).size)
      throw new AppError(400, "INVALID_REPLY", "All reply IDs must belong to this conversation.");
    for (const m of rows) {
      if (m.acknowledgedAt) continue;
      getDb()
        .update(messages)
        .set({ acknowledgedAt: nowIso(), acknowledgedGeneration: generation })
        .where(eq(messages.id, m.id))
        .run();
      const receipt = getDb()
        .select()
        .from(messages)
        .where(and(eq(messages.replyToId, m.id), eq(messages.direction, "system")))
        .get();
      if (receipt)
        enqueueJob(
          c,
          receipt.id,
          c.isTest
            ? "Test acknowledgement verified."
            : "Received by the agent. This does not yet mean the requested work is done.",
          "receipt_edit",
          `ack:${m.id}`,
        );
    }
  });
  notifyConversation(id);
  return { acknowledgedIds: ids };
}
export function resume(id: string, actor: AuthUser, sessionId: string) {
  getDb().transaction(() => {
    const c = readable(id, actor);
    if (c.ownerUserId !== actor.id)
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only the owner can resume. Ask a human administrator to reassign it.",
      );
    if (c.sessionId !== sessionId) {
      getDb()
        .update(conversations)
        .set({ sessionId, consumerGeneration: c.consumerGeneration + 1 })
        .where(eq(conversations.id, id))
        .run();
      auditDiscord(c.projectId, actor.id, "discord_session_resumed", id, {
        consumerGeneration: c.consumerGeneration + 1,
      });
    }
  });
  notifyConversation(id);
  return getConversation(id, actor);
}
export function closeConversation(id: string, actor: AuthUser, sessionId: string) {
  const c = readable(id, actor);
  if (!admin(actor) && c.recipientUserId !== actor.id) bound(c, actor, sessionId);
  getDb().update(conversations).set({ status: "closed" }).where(eq(conversations.id, id)).run();
  notifyConversation(id);
  return summary(conversationRow(id));
}
export function reassign(
  id: string,
  ownerUserId: string,
  sessionId: string,
  reason: string,
  actor: AuthUser,
) {
  requireHumanAdmin(actor);
  getDb().transaction(() => {
    const c = conversationRow(id);
    const owner = getDb().select().from(users).where(eq(users.id, ownerUserId)).get();
    if (!owner?.isActive) throw new AppError(400, "INVALID_OWNER", "Select an active PM user.");
    getDb()
      .update(conversations)
      .set({ ownerUserId, sessionId, consumerGeneration: c.consumerGeneration + 1 })
      .where(eq(conversations.id, id))
      .run();
    auditDiscord(
      c.projectId,
      actor.id,
      "discord_conversation_reassigned",
      id,
      { previousOwnerId: c.ownerUserId, ownerUserId },
      reason,
    );
  });
  notifyConversation(id);
  return summary(conversationRow(id));
}
export function retryMessage(
  id: string,
  messageId: string,
  key: string,
  reason: string,
  actor: AuthUser,
) {
  requireHumanAdmin(actor);
  return getDb().transaction(() => {
    const c = conversationRow(id);
    if (!routeAllows(c))
      throw new AppError(
        409,
        "DISCORD_DISABLED",
        "Repair the existing route before retrying. Changed audiences require a new conversation.",
      );
    const operationKey = `retry:${messageId}:${key}`;
    const existing = getDb().select().from(jobs).where(eq(jobs.operationKey, operationKey)).get();
    if (existing) return { jobId: existing.id, status: existing.status };
    const old = getDb()
      .select()
      .from(jobs)
      .where(and(eq(jobs.messageId, messageId), eq(jobs.conversationId, id)))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .get();
    if (!old || !["failed", "expired"].includes(old.status))
      throw new AppError(409, "NOT_RETRYABLE", "Only a failed or expired message can be retried.");
    const job = enqueueJob(c, messageId, old.content, old.operation, operationKey, {
      uncertain: old.uncertain,
    });
    auditDiscord(
      c.projectId,
      actor.id,
      "discord_delivery_retried",
      job.id,
      { originalJobId: old.id },
      reason,
    );
    return { jobId: job.id, status: job.status };
  });
}

/** Accept only explicitly mapped, currently authorized human replies. Called inside bridge ingestion. */
export function acceptInbound(event: typeof inbound.$inferSelect): boolean {
  const link = event.referenceId
    ? getDb()
        .select()
        .from(links)
        .where(
          and(eq(links.channelId, event.channelId), eq(links.discordMessageId, event.referenceId)),
        )
        .get()
    : undefined;
  if (!link) return false;
  getDb().transaction(() => {
    const parent = getDb().select().from(messages).where(eq(messages.id, link.messageId)).get()!;
    const c = conversationRow(parent.conversationId);
    const current = getDb()
      .select()
      .from(inbound)
      .where(eq(inbound.discordMessageId, event.discordMessageId))
      .get();
    if (current?.status !== "pending") return;
    if (event.authorId !== c.recipientDiscordId || event.guildId !== c.guildId || !routeAllows(c)) {
      getDb()
        .update(inbound)
        .set({ status: "rejected", errorCode: "UNAUTHORIZED_REPLY" })
        .where(eq(inbound.discordMessageId, event.discordMessageId))
        .run();
      return;
    }
    if (!event.body.trim()) return;
    const human = getDb().select().from(users).where(eq(users.id, c.recipientUserId)).get()!;
    const m = appendMessage(c, {
      direction: "human",
      body: event.body,
      authorLabel: human.displayName,
      replyToId: parent.id,
      discordMessageId: event.discordMessageId,
      providerCreatedAt: event.providerCreatedAt,
    });
    getDb()
      .insert(links)
      .values({
        channelId: event.channelId,
        discordMessageId: event.discordMessageId,
        messageId: m.id,
      })
      .run();
    getDb()
      .update(inbound)
      .set({ status: "accepted", messageId: m.id })
      .where(eq(inbound.discordMessageId, event.discordMessageId))
      .run();
    const body = `${c.status === "closed" ? "This conversation is closed. Your reply was retained for review. " : ""}Saved for “${label(c.sessionTitle, 100)} · ${c.code}”. Waiting for the agent to check in.${event.hasAttachments ? " Attachments were not forwarded; please describe them in text." : ""}`;
    const receipt = appendMessage(c, {
      direction: "system",
      body,
      authorLabel: "PM",
      replyToId: m.id,
    });
    enqueueJob(c, receipt.id, body, "receipt_create", `receipt:${m.id}`);
  });
  const m = getDb().select().from(messages).where(eq(messages.id, link.messageId)).get()!;
  notifyConversation(m.conversationId);
  return true;
}
export function stageInbound(message: DiscordWireMessage): boolean {
  if (message.authorBot) return false;
  const allowed = getDb()
    .select()
    .from(routes)
    .where(
      and(
        eq(routes.channelId, message.channelId),
        eq(routes.guildId, message.guildId),
        eq(routes.recipientDiscordId, message.authorId),
      ),
    )
    .all()
    .some(
      (r) =>
        (r.enabled || (!!r.testUntil && r.testUntil > nowIso())) &&
        message.createdAt >= r.activatedAt,
    );
  if (!allowed) return false;
  getDb()
    .insert(inbound)
    .values({
      discordMessageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.authorId,
      referenceId: message.referenceId,
      body: message.content,
      hasAttachments: message.hasAttachments,
      providerCreatedAt: message.createdAt,
    })
    .onConflictDoNothing()
    .run();
  return true;
}
