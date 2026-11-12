import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, lt, lte, ne, or } from "drizzle-orm";
import {
  getDb,
  discordAgentRoutes as routes,
  discordBridgeLease as leases,
  discordDeliveryJobs as jobs,
  discordChannelState as channels,
  discordInboundEvents as inbound,
  discordMessageLinks as links,
  agentConversationMessages as messages,
  agentConversations as conversations,
} from "../db/index.js";
import {
  acceptInbound,
  auditDiscord,
  conversationRow,
  discordEvents,
  notifyConversation,
  routeAllows,
  stageInbound,
  type DeliveryJob,
} from "./agent-conversation.service.js";
import { DiscordBotTransport, transportError } from "./discord-transport.js";
import {
  discordHealth,
  setDiscordRuntime,
  updateDiscordHealth,
  type DiscordTransport,
  type DiscordWireMessage,
} from "./discord-runtime.js";

const timestamp = (ms: number) => new Date(ms).toISOString();
/** One bridge per SQLite database; all network work is outside database transactions. */
export class DiscordBridge {
  private holder = randomUUID();
  private stopped = false;
  private connecting = false;
  private started = false;
  private running: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private leaseTimer?: ReturnType<typeof setInterval>;
  private nextConnectAt = 0;
  private globalCooldown = 0;
  private needsCatchUp = true;
  constructor(
    private transport: DiscordTransport,
    private now: () => number = Date.now,
  ) {}
  private lease(): boolean {
    const now = timestamp(this.now());
    return getDb().transaction(() => {
      const row = getDb().select().from(leases).where(eq(leases.id, "discord")).get();
      if (row && row.holder !== this.holder && row.leaseUntil > now) return false;
      getDb()
        .insert(leases)
        .values({
          id: "discord",
          holder: this.holder,
          fence: (row?.fence ?? 0) + (row?.holder === this.holder ? 0 : 1),
          leaseUntil: timestamp(this.now() + 30_000),
        })
        .onConflictDoUpdate({
          target: leases.id,
          set: {
            holder: this.holder,
            fence: (row?.fence ?? 0) + (row?.holder === this.holder ? 0 : 1),
            leaseUntil: timestamp(this.now() + 30_000),
          },
        })
        .run();
      return true;
    });
  }
  private ownsLease() {
    const row = getDb().select().from(leases).where(eq(leases.id, "discord")).get();
    return !this.stopped && row?.holder === this.holder && row.leaseUntil > timestamp(this.now());
  }
  start(): void {
    const wake = () => {
      void this.tick();
    };
    discordEvents.on("changed", wake);
    this.timer = setInterval(wake, 1000);
    this.timer.unref();
    this.leaseTimer = setInterval(() => {
      if (this.stopped) return;
      try {
        if (!this.lease() && this.started) {
          this.started = false;
          void this.transport.stop();
          updateDiscordHealth({ connected: false, errorCode: "BRIDGE_OWNED_ELSEWHERE" });
        }
      } catch {
        updateDiscordHealth({ errorCode: "BRIDGE_STORAGE_ERROR" });
      }
    }, 5000);
    this.leaseTimer.unref();
    this.removeWake = () => discordEvents.off("changed", wake);
    wake();
  }
  private removeWake = () => {};
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.leaseTimer);
    this.removeWake();
    await this.transport.stop();
    if (this.running) await this.running;
    const released = getDb()
      .delete(leases)
      .where(and(eq(leases.id, "discord"), eq(leases.holder, this.holder)))
      .run();
    if (released.changes) setDiscordRuntime(null);
  }
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = this.runTick()
      .catch(() => updateDiscordHealth({ errorCode: "BRIDGE_STORAGE_ERROR" }))
      .finally(() => {
        this.running = null;
      });
    await this.running;
  }
  private async runTick() {
    if (!this.lease()) return;
    if (!this.started && !this.connecting && this.now() >= this.nextConnectAt) {
      this.connecting = true;
      setDiscordRuntime(this.transport, { connected: false });
      try {
        await this.transport.start(
          (m) => {
            if (this.ownsLease())
              void this.ingest(m).catch(() =>
                updateDiscordHealth({ errorCode: "INBOUND_RECOVERY_REQUIRED" }),
              );
          },
          (state) => {
            if (state.connected) this.needsCatchUp = true;
            updateDiscordHealth(state);
          },
        );
        this.started = true;
      } catch (e) {
        updateDiscordHealth({ connected: false, errorCode: transportError(e).code });
        this.nextConnectAt = this.now() + 30_000;
      } finally {
        this.connecting = false;
      }
    }
    if (!this.started || !this.ownsLease()) return;
    const now = timestamp(this.now());
    getDb()
      .update(jobs)
      .set({ status: "retry_wait", uncertain: true, nextAttemptAt: now, leaseUntil: null })
      .where(and(eq(jobs.status, "sending"), lte(jobs.leaseUntil, now)))
      .run();
    getDb()
      .update(jobs)
      .set({ status: "expired", errorCode: "DELIVERY_EXPIRED" })
      .where(and(inArray(jobs.status, ["queued", "retry_wait"]), lte(jobs.expiresAt, now)))
      .run();
    for (const job of getDb()
      .select()
      .from(jobs)
      .where(inArray(jobs.status, ["queued", "retry_wait"]))
      .all()) {
      if (!routeAllows(conversationRow(job.conversationId), now))
        getDb()
          .update(jobs)
          .set({ status: "cancelled", errorCode: "ROUTE_CHANGED" })
          .where(eq(jobs.id, job.id))
          .run();
    }
    if (this.now() < this.globalCooldown) return;
    const watched = getDb()
      .select()
      .from(routes)
      .where(or(eq(routes.enabled, true), gt(routes.testUntil, now)))
      .all();
    for (const channelId of new Set(watched.map((r) => r.channelId))) {
      if (!this.ownsLease() || this.now() < this.globalCooldown) return;
      const state = getDb().select().from(channels).where(eq(channels.channelId, channelId)).get();
      if (state?.cooldownUntil && state.cooldownUntil > now) continue;
      const uncertain = getDb()
        .select()
        .from(jobs)
        .innerJoin(conversations, eq(jobs.conversationId, conversations.id))
        .where(
          and(
            eq(conversations.channelId, channelId),
            eq(jobs.uncertain, true),
            inArray(jobs.status, ["queued", "retry_wait"]),
          ),
        )
        .get();
      if (
        state &&
        (this.needsCatchUp ||
          state.scanUpper ||
          state.errorCode ||
          !state.lastSyncedAt ||
          Date.parse(state.lastSyncedAt) <= this.now() - 60_000 ||
          uncertain)
      ) {
        try {
          await this.reconcileChannel(channelId);
        } catch (e) {
          const error = transportError(e);
          getDb()
            .update(channels)
            .set({ errorCode: error.code })
            .where(eq(channels.channelId, channelId))
            .run();
          this.cooldown(channelId, error);
          continue;
        }
      }
      try {
        await this.resolvePending(channelId);
      } catch (e) {
        const error = transportError(e);
        this.cooldown(channelId, error);
        getDb()
          .update(channels)
          .set({ errorCode: error.code })
          .where(eq(channels.channelId, channelId))
          .run();
        continue;
      }
      const due = getDb()
        .select({ job: jobs })
        .from(jobs)
        .innerJoin(conversations, eq(jobs.conversationId, conversations.id))
        .where(
          and(
            eq(conversations.channelId, channelId),
            inArray(jobs.status, ["queued", "retry_wait"]),
            lte(jobs.nextAttemptAt, now),
          ),
        )
        .orderBy(asc(jobs.createdAt), asc(jobs.id))
        .limit(20)
        .all();
      for (const { job } of due) {
        if (await this.dispatch(job)) break;
      }
    }
    this.needsCatchUp = false;
  }
  private cooldown(channelId: string, error: ReturnType<typeof transportError>) {
    if (error.status !== 429) return;
    const until = this.now() + error.retryAfterMs;
    if (error.global) this.globalCooldown = until;
    getDb()
      .update(channels)
      .set({ cooldownUntil: timestamp(until) })
      .where(eq(channels.channelId, channelId))
      .run();
  }
  private reconcileBotMessage(wire: DiscordWireMessage): boolean {
    if (!wire.authorBot || wire.authorId !== discordHealth().botId) return false;
    const candidates = getDb()
      .select({ job: jobs, c: conversations })
      .from(jobs)
      .innerJoin(conversations, eq(jobs.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.channelId, wire.channelId),
          or(eq(jobs.content, wire.content), wire.nonce ? eq(jobs.nonce, wire.nonce) : undefined),
        ),
      )
      .orderBy(asc(jobs.createdAt))
      .all();
    let found = false;
    for (const { job } of candidates) {
      // A nonce identifies our request, but never attach a mismatched body.
      if (job.content !== wire.content || job.operation === "receipt_edit") continue;
      getDb().transaction(() => {
        getDb()
          .insert(links)
          .values({
            channelId: wire.channelId,
            discordMessageId: wire.id,
            messageId: job.messageId,
            jobId: job.id,
          })
          .onConflictDoNothing()
          .run();
        getDb()
          .update(messages)
          .set({ discordMessageId: wire.id })
          .where(eq(messages.id, job.messageId))
          .run();
        if (job.status !== "delivered")
          getDb()
            .update(jobs)
            .set({
              status: "delivered",
              discordMessageId: wire.id,
              deliveredAt: timestamp(this.now()),
              leaseUntil: null,
              errorCode: null,
              uncertain: false,
            })
            .where(eq(jobs.id, job.id))
            .run();
      });
      found = true;
      notifyConversation(job.conversationId);
    }
    return found;
  }
  async ingest(wire: DiscordWireMessage): Promise<void> {
    if (this.stopped || !this.ownsLease()) return;
    if (wire.authorBot) {
      this.reconcileBotMessage(wire);
      return;
    }
    if (!stageInbound(wire)) return;
    const channelState = getDb()
      .select()
      .from(channels)
      .where(eq(channels.channelId, wire.channelId))
      .get();
    if (
      this.now() < this.globalCooldown ||
      (channelState?.cooldownUntil && channelState.cooldownUntil > timestamp(this.now()))
    )
      return;
    try {
      await this.resolvePending(wire.channelId);
    } catch (e) {
      const error = transportError(e);
      this.cooldown(wire.channelId, error);
      getDb()
        .update(channels)
        .set({ errorCode: error.code })
        .where(eq(channels.channelId, wire.channelId))
        .run();
    }
  }
  private async resolvePending(channelId: string) {
    // Two passes allow a reply to an earlier human reply to resolve after its parent.
    for (let pass = 0; pass < 2; pass++) {
      const pending = getDb()
        .select()
        .from(inbound)
        .where(and(eq(inbound.channelId, channelId), eq(inbound.status, "pending")))
        .orderBy(asc(inbound.providerCreatedAt), asc(inbound.discordMessageId))
        .limit(100)
        .all();
      for (const event of pending) {
        if (!this.ownsLease() || this.now() < this.globalCooldown) return;
        if (event.referenceId && event.body.trim() && acceptInbound(event)) continue;
        if (event.referenceId && event.body.trim()) {
          const parent = await this.transport.message(channelId, event.referenceId);
          if (parent?.authorBot && this.reconcileBotMessage(parent) && acceptInbound(event))
            continue;
          if (parent && !parent.authorBot && stageInbound(parent)) {
            const staged = getDb()
              .select()
              .from(inbound)
              .where(eq(inbound.discordMessageId, parent.id))
              .get();
            if (staged?.status === "pending") continue;
            if (acceptInbound(event)) continue;
          }
        }
        getDb()
          .update(inbound)
          .set({
            status: "rejected",
            errorCode: event.body.trim() ? "UNMAPPED_REPLY" : "TEXT_REQUIRED",
          })
          .where(
            and(
              eq(inbound.discordMessageId, event.discordMessageId),
              eq(inbound.status, "pending"),
            ),
          )
          .run();
        const state = getDb()
          .select()
          .from(channels)
          .where(eq(channels.channelId, channelId))
          .get();
        if (!state?.lastHintAt || Date.parse(state.lastHintAt) < this.now() - 60_000) {
          getDb()
            .update(channels)
            .set({ lastHintAt: timestamp(this.now()) })
            .where(eq(channels.channelId, channelId))
            .run();
          try {
            await this.transport.send(channelId, {
              content: event.body.trim()
                ? "Use Discord’s Reply action on a PM agent message to choose the conversation."
                : "Please send a text reply. Attachments and voice messages are not forwarded.",
              nonce: event.discordMessageId,
              referenceId: event.discordMessageId,
            });
          } catch (e) {
            this.cooldown(channelId, transportError(e));
          }
        }
      }
    }
  }
  private async reconcileChannel(channelId: string) {
    let state = getDb().select().from(channels).where(eq(channels.channelId, channelId)).get()!;
    for (let page = 0; page < 2; page++) {
      if (!this.ownsLease()) return;
      const batch = await this.transport.history(channelId, state.scanBefore ?? undefined);
      const upper = state.scanUpper ?? batch[0]?.id ?? state.watermark;
      const eligible = batch.filter(
        (m) => BigInt(m.id) > BigInt(state.watermark) && BigInt(m.id) <= BigInt(upper),
      );
      for (const wire of eligible) {
        if (wire.authorBot) this.reconcileBotMessage(wire);
        else stageInbound(wire);
      }
      const bottom = batch.at(-1)?.id;
      const complete = batch.length < 100 || !bottom || BigInt(bottom) <= BigInt(state.watermark);
      if (complete) {
        await this.resolvePending(channelId);
        const unresolved = getDb()
          .select()
          .from(inbound)
          .where(and(eq(inbound.channelId, channelId), eq(inbound.status, "pending")))
          .get();
        getDb()
          .update(channels)
          .set(
            unresolved
              ? { scanUpper: upper, scanBefore: null, errorCode: "UNRESOLVED_REPLIES" }
              : {
                  watermark: upper,
                  scanUpper: null,
                  scanBefore: null,
                  lastSyncedAt: timestamp(this.now()),
                  errorCode: null,
                },
          )
          .where(eq(channels.channelId, channelId))
          .run();
        return;
      }
      getDb()
        .update(channels)
        .set({ scanUpper: upper, scanBefore: bottom })
        .where(eq(channels.channelId, channelId))
        .run();
      state = getDb().select().from(channels).where(eq(channels.channelId, channelId)).get()!;
    }
  }
  private async dispatch(original: DeliveryJob): Promise<boolean> {
    if (!this.ownsLease() || this.now() < this.globalCooldown) return false;
    const c = conversationRow(original.conversationId);
    const channelState = getDb()
      .select()
      .from(channels)
      .where(eq(channels.channelId, c.channelId))
      .get();
    if (channelState?.cooldownUntil && channelState.cooldownUntil > timestamp(this.now()))
      return false;
    const route = getDb().select().from(routes).where(eq(routes.projectId, c.projectId)).get();
    if (route?.errorCode) return false;
    const now = timestamp(this.now());
    if (!routeAllows(c, now)) {
      getDb()
        .update(jobs)
        .set({ status: "cancelled", errorCode: "ROUTE_CHANGED" })
        .where(eq(jobs.id, original.id))
        .run();
      return false;
    }
    const message = getDb()
      .select()
      .from(messages)
      .where(eq(messages.id, original.messageId))
      .get()!;
    const previous = getDb()
      .select({ id: jobs.id })
      .from(jobs)
      .innerJoin(messages, eq(jobs.messageId, messages.id))
      .where(
        and(
          eq(jobs.conversationId, c.id),
          ne(jobs.id, original.id),
          or(
            lt(messages.seq, message.seq),
            original.operation === "receipt_edit"
              ? and(eq(jobs.messageId, message.id), eq(jobs.operation, "receipt_create"))
              : undefined,
          ),
          inArray(jobs.status, ["queued", "retry_wait", "sending"]),
        ),
      )
      .get();
    if (previous) return false;
    if (original.uncertain) {
      const state = getDb()
        .select()
        .from(channels)
        .where(eq(channels.channelId, c.channelId))
        .get();
      if (!state?.lastSyncedAt || state.lastSyncedAt < original.nextAttemptAt || state.scanUpper)
        return false;
      const recovered = getDb().select().from(jobs).where(eq(jobs.id, original.id)).get();
      if (recovered?.status === "delivered") return false;
    }
    if (original.operation === "receipt_edit" && !message.discordMessageId) return false;
    const job = getDb()
      .update(jobs)
      .set({
        status: "sending",
        fence: original.fence + 1,
        leaseUntil: timestamp(this.now() + 30_000),
        attempts: original.attempts + 1,
      })
      .where(
        and(
          eq(jobs.id, original.id),
          eq(jobs.fence, original.fence),
          inArray(jobs.status, ["queued", "retry_wait"]),
        ),
      )
      .returning()
      .get();
    if (!job) return false;
    try {
      const parent = message.replyToId
        ? getDb().select().from(messages).where(eq(messages.id, message.replyToId)).get()
        : getDb()
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.conversationId, c.id),
                eq(messages.direction, "agent"),
                ne(messages.id, message.id),
              ),
            )
            .orderBy(asc(messages.seq))
            .get();
      const wire =
        job.operation === "receipt_edit"
          ? await this.transport.edit(c.channelId, message.discordMessageId!, job.content)
          : await this.transport.send(c.channelId, {
              content: job.content,
              nonce: job.nonce,
              ...(job.operation === "send" ? { recipientId: c.recipientDiscordId } : {}),
              ...(parent?.discordMessageId ? { referenceId: parent.discordMessageId } : {}),
            });
      if (!wire.id || wire.channelId !== c.channelId) throw new Error("Invalid provider receipt");
      if (!this.ownsLease()) return true;
      getDb().transaction(() => {
        const current = getDb().select().from(jobs).where(eq(jobs.id, job.id)).get();
        if (current?.fence !== job.fence) return;
        getDb()
          .update(jobs)
          .set({
            status: "delivered",
            deliveredAt: timestamp(this.now()),
            discordMessageId: wire.id,
            uncertain: false,
            errorCode: null,
            leaseUntil: null,
          })
          .where(eq(jobs.id, job.id))
          .run();
        getDb()
          .update(messages)
          .set({
            discordMessageId: wire.id,
            ...(job.operation === "receipt_edit" ? { body: job.content } : {}),
          })
          .where(eq(messages.id, job.messageId))
          .run();
        getDb()
          .insert(links)
          .values({
            channelId: c.channelId,
            discordMessageId: wire.id,
            messageId: message.id,
            jobId: job.id,
          })
          .onConflictDoNothing()
          .run();
        auditDiscord(c.projectId, job.ownerUserId, "discord_delivery_attempt", job.id, {
          attempt: job.attempts,
          status: "delivered",
        });
      });
    } catch (e) {
      if (!this.ownsLease()) return true;
      const error = transportError(e);
      const retryable = error.status === 0 || error.status === 429 || error.status >= 500;
      const delay =
        error.status === 429
          ? error.retryAfterMs
          : Math.min(60_000, 2000 * 2 ** original.attempts) + Math.floor(Math.random() * 500);
      const status = !routeAllows(c)
        ? "cancelled"
        : retryable && (error.status === 429 || job.attempts < 8)
          ? "retry_wait"
          : "failed";
      getDb().transaction(() => {
        getDb()
          .update(jobs)
          .set({
            status,
            nextAttemptAt: timestamp(this.now() + delay),
            leaseUntil: null,
            errorCode: error.code,
            attempts: error.status === 429 ? original.attempts : job.attempts,
            uncertain: original.uncertain || error.status === 0 || error.status >= 500,
          })
          .where(and(eq(jobs.id, job.id), eq(jobs.fence, job.fence), eq(jobs.status, "sending")))
          .run();
        if ([401, 403, 404].includes(error.status))
          getDb()
            .update(routes)
            .set({ errorCode: error.code })
            .where(eq(routes.projectId, c.projectId))
            .run();
        if (error.status === 401)
          updateDiscordHealth({ errorCode: "INVALID_TOKEN", connected: false });
        auditDiscord(c.projectId, job.ownerUserId, "discord_delivery_attempt", job.id, {
          attempt: job.attempts,
          status,
          errorCode: error.code,
        });
      });
      this.cooldown(c.channelId, error);
    }
    notifyConversation(c.id);
    return true;
  }
}
export function startDiscordBridge(): () => Promise<void> {
  const token = process.env.PM_DISCORD_BOT_TOKEN?.trim();
  if (process.env.PM_DISCORD_AGENT_MESSAGING_ENABLED !== "true" || !token) return async () => {};
  const bridge = new DiscordBridge(new DiscordBotTransport(token));
  bridge.start();
  return () => bridge.stop();
}
