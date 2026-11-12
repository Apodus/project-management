import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDiscordTools } from "../src/tools/discord.js";
import * as api from "../src/discord-client.js";
vi.mock("../src/discord-client.js", () => ({
  sendDiscordMessage: vi.fn(),
  checkDiscordReplies: vi.fn(),
  ackDiscordReplies: vi.fn(),
  getDiscordConversation: vi.fn(),
  resumeDiscordConversation: vi.fn(),
  closeDiscordConversation: vi.fn(),
  discordReconnectMode: () => "explicit_resume_required",
}));

describe("Discord MCP conversation tools", () => {
  let server: McpServer, client: Client;
  beforeEach(async () => {
    vi.clearAllMocks();
    server = new McpServer({ name: "test", version: "1" });
    registerDiscordTools(server);
    client = new Client({ name: "agent", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
  });
  afterEach(async () => {
    await client.close();
    await server.close();
  });
  it("exposes the six tools and sends only the fixed project route inputs", async () => {
    expect((await client.listTools()).tools).toHaveLength(6);
    vi.mocked(api.sendDiscordMessage).mockResolvedValue({
      conversationId: "c",
      conversationCode: "CODE",
      messageId: "m",
      consumerGeneration: 1,
      deliveryStatus: "queued",
      duplicate: false,
      replyRequested: true,
    });
    const result = await client.callTool({
      name: "pm_send_discord_message",
      arguments: {
        project_id: "p",
        session_title: "Audio",
        message: "Question?",
        kind: "question",
        idempotency_key: "retry-stable",
      },
    });
    expect(api.sendDiscordMessage).toHaveBeenCalledWith("p", {
      sessionTitle: "Audio",
      message: "Question?",
      kind: "question",
      idempotencyKey: "retry-stable",
      conversationId: undefined,
    });
    expect(JSON.stringify(result)).toContain("queued");
    expect(JSON.stringify(result)).toContain("explicit_resume_required");
  });
  it("never acknowledges from a read and refuses unknown reply IDs", async () => {
    const unknown = await client.callTool({
      name: "pm_ack_discord_replies",
      arguments: { conversation_id: "c", reply_ids: ["r"] },
    });
    expect(unknown.isError).toBe(true);
    expect(api.ackDiscordReplies).not.toHaveBeenCalled();
    vi.mocked(api.checkDiscordReplies).mockResolvedValue({
      hasMore: false,
      replies: [
        {
          id: "r",
          conversationId: "c",
          conversationCode: "CODE",
          sessionTitle: "Audio",
          consumerGeneration: 7,
          body: "Keep it local.",
          authorLabel: "Human",
          createdAt: "now",
          conversationClosed: false,
        },
      ],
    });
    await client.callTool({ name: "pm_check_discord_replies", arguments: { wait_seconds: 25 } });
    expect(api.checkDiscordReplies).toHaveBeenCalledWith(undefined, 25, undefined);
    expect(api.ackDiscordReplies).not.toHaveBeenCalled();
    vi.mocked(api.ackDiscordReplies).mockResolvedValue({ acknowledgedIds: ["r"] });
    await client.callTool({
      name: "pm_ack_discord_replies",
      arguments: { conversation_id: "c", reply_ids: ["r"] },
    });
    expect(api.ackDiscordReplies).toHaveBeenCalledWith("c", ["r"], 7);
  });
  it("does not refresh old acknowledgement generations after resume", async () => {
    vi.mocked(api.checkDiscordReplies).mockResolvedValue({
      hasMore: false,
      replies: [
        {
          id: "r",
          conversationId: "c",
          conversationCode: "CODE",
          sessionTitle: "Audio",
          consumerGeneration: 1,
          body: "Answer",
          authorLabel: "Human",
          createdAt: "now",
          conversationClosed: false,
        },
      ],
    });
    await client.callTool({ name: "pm_check_discord_replies", arguments: {} });
    vi.mocked(api.resumeDiscordConversation).mockResolvedValue({
      conversation: { id: "c", consumerGeneration: 2 },
    } as Awaited<ReturnType<typeof api.resumeDiscordConversation>>);
    await client.callTool({
      name: "pm_resume_discord_conversation",
      arguments: { conversation_id: "c" },
    });
    vi.mocked(api.ackDiscordReplies).mockRejectedValue(new Error("SESSION_MISMATCH"));
    const result = await client.callTool({
      name: "pm_ack_discord_replies",
      arguments: { conversation_id: "c", reply_ids: ["r"] },
    });
    expect(api.ackDiscordReplies).toHaveBeenCalledWith("c", ["r"], 1);
    expect(result.isError).toBe(true);
  });
});
