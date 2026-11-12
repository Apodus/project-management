import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  post: vi.fn(),
  patch: vi.fn(),
  get: vi.fn(),
  login: vi.fn(),
  handlers: new Map<string, Array<(...args: any[]) => void>>(),
}));
vi.mock("discord.js", async (original) => ({
  ...(await original<typeof import("discord.js")>()),
  Client: class {
    rest = { setToken: vi.fn(), post: mock.post, patch: mock.patch, get: mock.get };
    channels = { cache: new Map([["channel", { guildId: "guild" }]]) };
    on(event: string, handler: (...args: any[]) => void) {
      mock.handlers.set(event, [...(mock.handlers.get(event) ?? []), handler]);
    }
    removeAllListeners(event: string) {
      mock.handlers.delete(event);
    }
    login = mock.login;
    destroy = vi.fn();
  },
}));
import { DiscordBotTransport, transportError } from "../../src/services/discord-transport.js";
import { Events } from "discord.js";
const wire = {
  id: "provider-id",
  author: { id: "bot", bot: true },
  content: "hello",
  timestamp: "2026-11-12T10:00:00.000Z",
  attachments: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.handlers.clear();
  mock.post.mockResolvedValue(wire);
  mock.patch.mockResolvedValue(wire);
});
describe("Discord SDK adapter", () => {
  it("uses a stable enforced nonce and mentions only the configured human", async () => {
    const adapter = new DiscordBotTransport("test-token");
    await adapter.send("channel", {
      content: "hello @everyone",
      nonce: "stable",
      recipientId: "human",
      referenceId: "parent",
    });
    expect(mock.post).toHaveBeenCalledWith("/channels/channel/messages", {
      body: {
        content: "hello @everyone",
        nonce: "stable",
        enforce_nonce: true,
        allowed_mentions: { parse: [], users: ["human"], replied_user: false },
        message_reference: { message_id: "parent", fail_if_not_exists: false },
      },
    });
    await adapter.edit("channel", "receipt", "received");
    expect(mock.patch.mock.calls[0]![1].body.allowed_mentions).toEqual({
      parse: [],
      users: [],
      replied_user: false,
    });
  });
  it("paginates full history and distinguishes deleted references from unavailable Discord", async () => {
    const adapter = new DiscordBotTransport("test-token");
    mock.get.mockResolvedValueOnce([wire]);
    expect((await adapter.history("channel", "before-id"))[0]!.guildId).toBe("guild");
    expect(mock.get.mock.calls[0]![1].query.toString()).toBe("limit=100&before=before-id");
    mock.get.mockRejectedValueOnce({ status: 404 });
    expect(await adapter.message("channel", "deleted")).toBeNull();
    mock.get.mockRejectedValueOnce({ status: 503, requestBody: "secret" });
    await expect(adapter.message("channel", "unknown")).rejects.toThrow("DISCORD_UNAVAILABLE");
  });
  it("does not accumulate Gateway listeners when login is retried", async () => {
    const adapter = new DiscordBotTransport("test-token");
    const state = vi.fn();
    mock.login.mockRejectedValueOnce({ code: "TokenInvalid", token: "secret" });
    await expect(adapter.start(vi.fn(), state)).rejects.toThrow("INVALID_TOKEN");
    await adapter.start(vi.fn(), state);
    expect(mock.handlers.get(Events.MessageCreate)).toHaveLength(1);
    mock.handlers.get(Events.ShardDisconnect)![0]!({ code: 4014 });
    expect(state).toHaveBeenCalledWith({
      connected: false,
      errorCode: "MESSAGE_CONTENT_INTENT_REQUIRED",
    });
  });
  it("sanitizes provider errors including malformed failures", () => {
    expect(transportError(undefined).message).toBe("DISCORD_UNAVAILABLE");
    const error = transportError({
      name: "RateLimitError",
      retryAfter: 12000,
      global: true,
      requestBody: "secret",
    });
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(12000);
    expect(error.global).toBe(true);
    expect(JSON.stringify(error)).not.toContain("secret");
  });
});
