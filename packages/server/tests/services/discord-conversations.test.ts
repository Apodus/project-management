import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  type TestApp,
} from "../utils.js";
import {
  discordDeliveryJobs as jobs,
  agentConversations,
  agentConversationMessages,
  discordAgentRoutes,
  discordChannelState,
  discordMessageLinks,
} from "../../src/db/index.js";
import * as service from "../../src/services/agent-conversation.service.js";
import { DiscordBridge } from "../../src/services/discord-bridge.service.js";
import {
  DiscordTransportError,
  setDiscordRuntime,
  type DiscordTransport,
  type DiscordWireMessage,
  type DiscordSendPayload,
} from "../../src/services/discord-runtime.js";
import type { AuthUser } from "../../src/types.js";
import { discordSendSchema, type DiscordBridgeHealth } from "@pm/shared";

const guildId = "111111111111111111",
  channelId = "222222222222222222",
  recipientId = "333333333333333333",
  botId = "444444444444444444";
class FakeDiscord implements DiscordTransport {
  rows: DiscordWireMessage[] = [];
  sent: DiscordSendPayload[] = [];
  failure: DiscordTransportError | null = null;
  acceptThenFail = false;
  clock = Date.now() + 1000;
  serial = 1n;
  historyCalls = 0;
  make(
    content: string,
    authorId = recipientId,
    referenceId: string | null = null,
  ): DiscordWireMessage {
    const id = (((BigInt(this.clock++) - 1420070400000n) << 22n) + this.serial++).toString();
    return {
      id,
      guildId,
      channelId,
      authorId,
      authorBot: authorId === botId,
      content,
      referenceId,
      createdAt: new Date(this.clock).toISOString(),
      hasAttachments: false,
    };
  }
  async start(
    _onMessage: (m: DiscordWireMessage) => void,
    onState: (s: Partial<DiscordBridgeHealth>) => void,
  ) {
    onState({ connected: true, botId, botName: "PM test" });
  }
  async stop() {}
  async validateChannel() {
    return { name: "agent-inbox" };
  }
  async send(_channel: string, payload: DiscordSendPayload) {
    this.sent.push(payload);
    if (this.failure) throw this.failure;
    const row = { ...this.make(payload.content, botId, payload.referenceId), nonce: payload.nonce };
    this.rows.push(row);
    if (this.acceptThenFail) {
      this.acceptThenFail = false;
      throw new DiscordTransportError("DISCORD_UNAVAILABLE");
    }
    return row;
  }
  async edit(_channel: string, id: string, content: string) {
    const row = this.rows.find((m) => m.id === id)!;
    row.content = content;
    return row;
  }
  async history(_channel: string, before?: string) {
    this.historyCalls++;
    return this.rows
      .filter((m) => !before || BigInt(m.id) < BigInt(before))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))
      .slice(0, 100);
  }
  async message(_channel: string, id: string) {
    return this.rows.find((m) => m.id === id) ?? null;
  }
}
describe("Discord conversations", () => {
  let app: TestApp,
    discord: FakeDiscord,
    bridge: DiscordBridge,
    projectId: string,
    agent: AuthUser,
    token: string;
  beforeEach(async () => {
    vi.stubEnv("PM_DISCORD_AGENT_MESSAGING_ENABLED", "true");
    vi.stubEnv("PM_DISCORD_BOT_TOKEN", "test-only-token");
    app = createTestApp();
    projectId = createTestProject(app.db).id;
    const identity = createTestAiAgent(app.db);
    agent = identity.user;
    token = identity.token;
    discord = new FakeDiscord();
    setDiscordRuntime(discord, { connected: true, botId });
    await service.saveRoute(
      projectId,
      {
        guildId,
        channelId,
        recipientUserId: app.testUser.id,
        recipientDiscordId: recipientId,
        enabled: true,
        generation: 0,
      },
      app.testUser,
    );
    bridge = new DiscordBridge(discord, () => discord.clock);
  });
  afterEach(async () => {
    await bridge.stop();
    service.discordEvents.removeAllListeners();
    app.cleanup();
    vi.unstubAllEnvs();
  });
  const body = (key = "first") => ({
    sessionTitle: "Audio routing",
    message: "Should piano be local?",
    idempotencyKey: key,
    kind: "question" as const,
  });
  function send(key = "first", session = "session-a") {
    return service.sendMessage(projectId, body(key), agent, session);
  }
  async function replyTo(messageId: string, content = "Keep it local.") {
    const sent = app.db
      .select()
      .from(agentConversationMessages)
      .where(eq(agentConversationMessages.id, messageId))
      .get()!;
    const wire = discord.make(content, recipientId, sent.discordMessageId);
    discord.rows.push(wire);
    await bridge.ingest(wire);
    return wire;
  }
  it("round trips a phone reply without consuming it on read, then edits the acknowledgement receipt", async () => {
    const sent = send();
    await bridge.tick();
    expect(service.getConversation(sent.conversationId, agent).messages[0]!.deliveryStatus).toBe(
      "delivered",
    );
    expect(discord.sent[0]!.recipientId).toBe(recipientId);
    await replyTo(sent.messageId);
    await bridge.tick();
    const inbox = service.checkReplies(agent, "session-a");
    expect(inbox.replies).toHaveLength(1);
    expect(inbox.replies[0]!.body).toBe("Keep it local.");
    expect(service.checkReplies(agent, "session-a").replies).toHaveLength(1);
    expect(discord.sent[1]!.recipientId).toBeUndefined();
    service.acknowledge(
      sent.conversationId,
      [inbox.replies[0]!.id],
      sent.consumerGeneration,
      agent,
      "session-a",
    );
    await bridge.tick();
    expect(service.checkReplies(agent, "session-a").replies).toEqual([]);
    expect(discord.rows.some((m) => m.content.startsWith("Received by the agent"))).toBe(true);
    expect(
      service
        .getConversation(sent.conversationId, agent)
        .messages.find((m) => m.direction === "system")!.body,
    ).toMatch(/^Received by the agent/);
    expect(
      service
        .getConversation(sent.conversationId, agent)
        .messages.filter((m) => m.direction === "human"),
    ).toHaveLength(1);
  });
  it("deduplicates initial sends and rejects key reuse before creating orphan conversations", () => {
    const sent = send();
    expect(send().conversationId).toBe(sent.conversationId);
    expect(send().duplicate).toBe(true);
    expect(() =>
      service.sendMessage(projectId, { ...body(), message: "Different" }, agent, "session-a"),
    ).toThrow("different logical message");
    expect(app.db.select().from(agentConversations).all()).toHaveLength(1);
  });
  it("isolates sessions and fences a stale acknowledgement after explicit resume", async () => {
    const a = send();
    const b = send("second", "session-b");
    await bridge.tick();
    await bridge.tick();
    await replyTo(a.messageId);
    const old = service.checkReplies(agent, "session-a").replies[0]!;
    expect(service.checkReplies(agent, "session-b").replies).toEqual([]);
    expect(() => service.checkReplies(agent, "session-b", a.conversationId)).toThrow(
      "Explicitly resume",
    );
    service.resume(a.conversationId, agent, "session-b");
    expect(() =>
      service.acknowledge(a.conversationId, [old.id], old.consumerGeneration, agent, "session-b"),
    ).toThrow("Explicitly resume");
    expect(service.checkReplies(agent, "session-b").replies[0]!.consumerGeneration).toBe(2);
    expect(service.getConversation(b.conversationId, agent).conversation.consumerGeneration).toBe(
      1,
    );
  });
  it("rejects cross-owner access and non-human configuration changes", async () => {
    const other = createTestAiAgent(app.db, { role: "admin" });
    const sent = send();
    expect(() => service.getConversation(sent.conversationId, other.user)).toThrow("not found");
    const res = await authRequest(
      app.app,
      "GET",
      `/api/v1/projects/${projectId}/discord-agent-route`,
      { token: other.token },
    );
    expect(res.status).toBe(403);
    const normal = await authRequest(app.app, "GET", `/api/v1/projects/${projectId}`);
    expect(JSON.stringify(await normal.json())).not.toContain(recipientId);
  });
  it("recovers a provider-accepted send after a timeout without posting twice", async () => {
    const sent = send();
    discord.acceptThenFail = true;
    await bridge.tick();
    expect(service.getConversation(sent.conversationId, agent).messages[0]!.deliveryUncertain).toBe(
      true,
    );
    discord.clock += 65_000;
    await bridge.tick();
    expect(discord.sent).toHaveLength(1);
    expect(service.getConversation(sent.conversationId, agent).messages[0]!.deliveryStatus).toBe(
      "delivered",
    );
  });
  it("survives bridge restart and catches up more than one page without accepting duplicate replies", async () => {
    const sent = send();
    await bridge.tick();
    await bridge.stop();
    const sentWire = discord.rows[0]!;
    for (let i = 0; i < 220; i++)
      discord.rows.push(discord.make(`unrelated ${i}`, "999999999999999999"));
    const reply = discord.make("Reply while PM was offline", recipientId, sentWire.id);
    discord.rows.push(reply);
    bridge = new DiscordBridge(discord, () => discord.clock);
    await bridge.tick();
    await bridge.tick();
    await bridge.ingest(reply);
    expect(discord.historyCalls).toBeGreaterThanOrEqual(3);
    expect(service.checkReplies(agent, "session-a").replies).toHaveLength(1);
    expect(app.db.select().from(discordChannelState).get()!.scanUpper).toBeNull();
    expect(
      service
        .getConversation(sent.conversationId, agent)
        .messages.filter((m) => m.direction === "human"),
    ).toHaveLength(1);
  });
  it("honors provider cooldown and retains attempts on 429", async () => {
    send();
    discord.failure = new DiscordTransportError("RATE_LIMITED", 429, 30_000, true);
    await bridge.tick();
    const job = app.db.select().from(jobs).get()!;
    expect(job.status).toBe("retry_wait");
    expect(job.attempts).toBe(0);
    await bridge.tick();
    expect(discord.sent).toHaveLength(1);
    discord.failure = null;
    discord.clock += 31_000;
    await bridge.tick();
    expect(discord.sent).toHaveLength(2);
  });
  it("cancels unsent messages when routing changes and does not reveal history to the replacement recipient", async () => {
    const sent = send();
    const other = createTestAiAgent(app.db);
    app.db
      .update(discordAgentRoutes)
      .set({ enabled: false, generation: 2 })
      .where(eq(discordAgentRoutes.projectId, projectId))
      .run();
    await bridge.tick();
    expect(discord.sent).toEqual([]);
    expect(service.getConversation(sent.conversationId, agent).conversation.suspended).toBe(true);
    expect(() => service.getConversation(sent.conversationId, other.user)).toThrow();
  });
  it("ignores strangers and webhook/bot messages even when a reference is valid", async () => {
    const sent = send();
    await bridge.tick();
    const root = discord.rows[0]!;
    await bridge.ingest({ ...discord.make("Injected", "999999999999999999", root.id) });
    await bridge.ingest({ ...discord.make("Injected", recipientId, root.id), authorBot: true });
    expect(service.checkReplies(agent, "session-a").replies).toEqual([]);
    expect(app.db.select().from(discordMessageLinks).all()).toHaveLength(1);
    expect(sent.conversationId).toBeTruthy();
  });
  it("exposes authenticated REST send/read/ack and rejects unknown routing fields", async () => {
    const path = `/api/v1/projects/${projectId}/agent-conversations/messages`;
    const invalid = await authRequest(app.app, "POST", path, {
      token,
      headers: { "X-PM-Session-Id": "api-session" },
      body: { ...body(), channelId },
    });
    expect(invalid.status).toBe(400);
    const res = await authRequest(app.app, "POST", path, {
      token,
      headers: { "X-PM-Session-Id": "api-session" },
      body: body(),
    });
    expect(res.status).toBe(202);
    const sent = (await res.json()).data;
    await bridge.tick();
    await replyTo(sent.messageId);
    const read = await authRequest(app.app, "GET", "/api/v1/agent-conversations/replies", {
      token,
      headers: { "X-PM-Session-Id": "api-session" },
    });
    expect(read.status).toBe(200);
    const reply = (await read.json()).data.replies[0];
    const ack = await authRequest(
      app.app,
      "POST",
      `/api/v1/agent-conversations/${sent.conversationId}/ack`,
      {
        token,
        headers: { "X-PM-Session-Id": "api-session" },
        body: { replyIds: [reply.id], consumerGeneration: reply.consumerGeneration },
      },
    );
    expect(ack.status).toBe(200);
  });
  it("allows only one active bridge and lets a new process recover after shutdown", async () => {
    send();
    await bridge.tick();
    const standbyTransport = new FakeDiscord();
    const standby = new DiscordBridge(standbyTransport, () => discord.clock);
    try {
      send("second");
      await standby.tick();
      expect(standbyTransport.sent).toEqual([]);
      await bridge.stop();
      await standby.tick();
      expect(standbyTransport.sent).toHaveLength(1);
    } finally {
      await standby.stop();
    }
  });
  it("resolves a reply to a human reply even when Gateway delivers the child first", async () => {
    send();
    await bridge.tick();
    const parent = discord.make("First answer", recipientId, discord.rows[0]!.id);
    const child = discord.make("One more detail", recipientId, parent.id);
    discord.rows.push(parent, child);
    await bridge.ingest(child);
    await bridge.ingest(parent);
    expect(service.checkReplies(agent, "session-a").replies.map((r) => r.body)).toEqual([
      "First answer",
      "One more detail",
    ]);
  });
  it("keeps failed sends visible, pauses a broken route and retries only after repair", async () => {
    const sent = send();
    discord.failure = new DiscordTransportError("MISSING_PERMISSIONS", 403);
    await bridge.tick();
    expect(service.getConversation(sent.conversationId, agent).messages[0]!.deliveryStatus).toBe(
      "failed",
    );
    expect(() => send("another")).toThrow("Repair and save");
    discord.failure = null;
    // The admin UI submits only editable fields, never the health projection.
    await service.saveRoute(
      projectId,
      {
        guildId,
        channelId,
        recipientDiscordId: recipientId,
        recipientUserId: app.testUser.id,
        enabled: true,
        generation: 1,
      },
      app.testUser,
    );
    const retry = service.retryMessage(
      sent.conversationId,
      sent.messageId,
      "manual",
      "Permissions repaired",
      app.testUser,
    );
    expect(
      service.retryMessage(
        sent.conversationId,
        sent.messageId,
        "manual",
        "Permissions repaired",
        app.testUser,
      ).jobId,
    ).toBe(retry.jobId);
    await bridge.tick();
    expect(service.getConversation(sent.conversationId, agent).messages[0]!.deliveryStatus).toBe(
      "delivered",
    );
  });
  it("retains late replies to a closed conversation and never calls them completed", async () => {
    const sent = send();
    await bridge.tick();
    service.closeConversation(sent.conversationId, agent, "session-a");
    await replyTo(sent.messageId, "Late decision");
    await bridge.tick();
    expect(service.checkReplies(agent, "session-a").replies[0]!.conversationClosed).toBe(true);
    expect(discord.sent.at(-1)!.content).toContain("retained for review");
  });
  it("returns retry guidance and rolls back quota-rejected conversation creation", async () => {
    vi.stubEnv("PM_DISCORD_PROJECT_HOURLY_LIMIT", "1");
    const first = send();
    const result = await authRequest(
      app.app,
      "POST",
      `/api/v1/projects/${projectId}/agent-conversations/messages`,
      {
        token,
        headers: { "X-PM-Session-Id": "session-a" },
        body: body("second"),
      },
    );
    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("3600");
    expect((await result.json()).error.retry_after_seconds).toBe(3600);
    expect(app.db.select().from(agentConversations).all()).toHaveLength(1);
    expect(send().conversationId).toBe(first.conversationId);
  });
  it("expires queued work instead of sending stale notifications", async () => {
    const sent = send();
    discord.clock += 3600_001;
    await bridge.tick();
    expect(discord.sent).toEqual([]);
    expect(service.getConversation(sent.conversationId, agent).messages[0]!.deliveryStatus).toBe(
      "expired",
    );
  });
  it("keeps shared and HTTP send validation aligned", async () => {
    const inputs = [
      { ...body("default"), kind: undefined, sessionTitle: "  Audio  " },
      { ...body(), message: " " },
      { ...body(), kind: "urgent" },
      { ...body(), message: "x".repeat(1501) },
      { ...body(), webhookUrl: "https://example.com" },
      { ...body(), sessionTitle: "x".repeat(101) },
    ];
    for (const input of inputs) {
      const result = await authRequest(
        app.app,
        "POST",
        `/api/v1/projects/${projectId}/agent-conversations/messages`,
        {
          token,
          headers: { "X-PM-Session-Id": "session-a" },
          body: input,
        },
      );
      expect(result.status).toBe(discordSendSchema.safeParse(input).success ? 202 : 400);
    }
  });
  it("can disable an existing channel while Discord is disconnected", async () => {
    send();
    setDiscordRuntime(null);
    const updated = await service.saveRoute(
      projectId,
      {
        guildId,
        channelId,
        recipientUserId: app.testUser.id,
        recipientDiscordId: recipientId,
        enabled: false,
        generation: 1,
      },
      app.testUser,
    );
    expect(updated.route!.enabled).toBe(false);
    expect(updated.route!.generation).toBe(2);
    expect(app.db.select().from(jobs).get()!.status).toBe("cancelled");
  });
  it("creates a receipt before editing it even when same-millisecond job IDs sort backwards", async () => {
    const sent = send();
    await bridge.tick();
    await replyTo(sent.messageId);
    const reply = service.checkReplies(agent, "session-a").replies[0]!;
    service.acknowledge(
      sent.conversationId,
      [reply.id],
      reply.consumerGeneration,
      agent,
      "session-a",
    );
    app.db
      .update(jobs)
      .set({ id: "ZZZ-create-receipt" })
      .where(eq(jobs.operation, "receipt_create"))
      .run();
    app.db
      .update(jobs)
      .set({ id: "AAA-edit-receipt" })
      .where(eq(jobs.operation, "receipt_edit"))
      .run();
    await bridge.tick();
    await bridge.tick();
    expect(discord.rows).toHaveLength(3); // agent, human, one edited receipt
    expect(discord.rows.at(-1)!.content).toMatch(/^Received by the agent/);
  });
});
