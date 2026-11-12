import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  Routes,
  type APIMessage,
  type Message,
} from "discord.js";
import type { DiscordBridgeHealth } from "@pm/shared";
import {
  DiscordTransportError,
  type DiscordTransport,
  type DiscordWireMessage,
  type DiscordSendPayload,
} from "./discord-runtime.js";

/** Never retain or stringify SDK errors: they can contain the authorization/request body. */
export function transportError(error: unknown): DiscordTransportError {
  if (error instanceof DiscordTransportError) return error;
  const e = (error ?? {}) as {
    status?: number;
    code?: number | string;
    retryAfter?: number;
    global?: boolean;
    name?: string;
  };
  if (e.name === "RateLimitError" || e.status === 429)
    return new DiscordTransportError(
      "RATE_LIMITED",
      429,
      Math.max(1000, e.retryAfter ?? 1000),
      !!e.global,
    );
  const status = e.status ?? (e.code === "TokenInvalid" ? 401 : 0);
  return new DiscordTransportError(
    status === 401
      ? "INVALID_TOKEN"
      : status === 403
        ? "MISSING_PERMISSIONS"
        : status === 404
          ? "DESTINATION_REMOVED"
          : status === 400
            ? "INVALID_MESSAGE"
            : "DISCORD_UNAVAILABLE",
    status,
  );
}
function incoming(m: Message): DiscordWireMessage {
  return {
    id: m.id,
    guildId: m.guildId ?? "",
    channelId: m.channelId,
    authorId: m.author.id,
    authorBot: m.author.bot || !!m.webhookId,
    content: m.content,
    referenceId: m.reference?.messageId ?? null,
    createdAt: m.createdAt.toISOString(),
    hasAttachments: m.attachments.size > 0 || m.stickers.size > 0,
    nonce: m.nonce == null ? null : String(m.nonce),
  };
}
export class DiscordBotTransport implements DiscordTransport {
  private client: Client;
  constructor(private token: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      rest: { timeout: 10_000, retries: 0, rejectOnRateLimit: () => true },
    });
    this.client.rest.setToken(token);
  }
  async start(
    onMessage: (message: DiscordWireMessage) => void,
    onState: (state: Partial<DiscordBridgeHealth>) => void,
  ) {
    // A failed login may be retried on this adapter. Replace our listeners so
    // retries do not deliver every Gateway event multiple times.
    for (const event of [
      Events.MessageCreate,
      Events.ClientReady,
      Events.ShardDisconnect,
      Events.ShardResume,
      Events.Error,
    ] as const)
      this.client.removeAllListeners(event);
    this.client.on(Events.MessageCreate, (m) => onMessage(incoming(m)));
    this.client.on(Events.ClientReady, (c) =>
      onState({ connected: true, botId: c.user.id, botName: c.user.username, errorCode: null }),
    );
    this.client.on(Events.ShardDisconnect, (event) =>
      onState({
        connected: false,
        errorCode:
          event.code === 4014
            ? "MESSAGE_CONTENT_INTENT_REQUIRED"
            : event.code === 4004
              ? "INVALID_TOKEN"
              : "GATEWAY_DISCONNECTED",
      }),
    );
    this.client.on(Events.ShardResume, () => onState({ connected: true, errorCode: null }));
    this.client.on(Events.Error, () => onState({ errorCode: "DISCORD_UNAVAILABLE" }));
    try {
      await this.client.login(this.token);
    } catch (e) {
      throw transportError(e);
    }
  }
  async stop() {
    await this.client.destroy();
  }
  async validateChannel(guildId: string, channelId: string) {
    try {
      if (!this.client.user || !this.client.isReady())
        throw new DiscordTransportError("DISCORD_NOT_READY");
      const c = await this.client.channels.fetch(channelId, { force: true });
      if (!c || c.type !== ChannelType.GuildText || c.guildId !== guildId)
        throw new DiscordTransportError("INVALID_TEXT_CHANNEL", 400);
      if (
        !c
          .permissionsFor(this.client.user)
          ?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ])
      )
        throw new DiscordTransportError("MISSING_PERMISSIONS", 403);
      return { name: c.name };
    } catch (e) {
      throw transportError(e);
    }
  }
  private wire(m: APIMessage, channelId: string): DiscordWireMessage {
    const channel = this.client.channels.cache.get(channelId);
    return {
      id: m.id,
      guildId: channel && "guildId" in channel ? channel.guildId : "",
      channelId,
      authorId: m.author.id,
      authorBot: !!m.author.bot || !!m.webhook_id,
      content: m.content,
      referenceId: m.message_reference?.message_id ?? null,
      createdAt: m.timestamp,
      hasAttachments: m.attachments.length > 0 || !!m.sticker_items?.length,
      nonce: m.nonce == null ? null : String(m.nonce),
    };
  }
  async send(channelId: string, payload: DiscordSendPayload) {
    try {
      const result = (await this.client.rest.post(Routes.channelMessages(channelId), {
        body: {
          content: payload.content,
          nonce: payload.nonce,
          enforce_nonce: true,
          allowed_mentions: {
            parse: [],
            users: payload.recipientId ? [payload.recipientId] : [],
            replied_user: false,
          },
          ...(payload.referenceId
            ? { message_reference: { message_id: payload.referenceId, fail_if_not_exists: false } }
            : {}),
        },
      })) as APIMessage;
      return this.wire(result, channelId);
    } catch (e) {
      throw transportError(e);
    }
  }
  async edit(channelId: string, messageId: string, content: string) {
    try {
      return this.wire(
        (await this.client.rest.patch(Routes.channelMessage(channelId, messageId), {
          body: { content, allowed_mentions: { parse: [], users: [], replied_user: false } },
        })) as APIMessage,
        channelId,
      );
    } catch (e) {
      throw transportError(e);
    }
  }
  async history(channelId: string, before?: string) {
    try {
      const query = new URLSearchParams({ limit: "100", ...(before ? { before } : {}) });
      return (
        (await this.client.rest.get(Routes.channelMessages(channelId), { query })) as APIMessage[]
      ).map((m) => this.wire(m, channelId));
    } catch (e) {
      throw transportError(e);
    }
  }
  async message(channelId: string, id: string) {
    try {
      return this.wire(
        (await this.client.rest.get(Routes.channelMessage(channelId, id))) as APIMessage,
        channelId,
      );
    } catch (e) {
      const error = transportError(e);
      if (error.status === 404) return null;
      throw error;
    }
  }
}
