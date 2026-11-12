import type { DiscordBridgeHealth } from "@pm/shared";

export interface DiscordWireMessage {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorBot: boolean;
  content: string;
  referenceId: string | null;
  createdAt: string;
  hasAttachments: boolean;
  nonce?: string | null;
}
export interface DiscordSendPayload {
  content: string;
  nonce: string;
  recipientId?: string;
  referenceId?: string;
}
export interface DiscordTransport {
  start(
    onMessage: (message: DiscordWireMessage) => void,
    onState: (state: Partial<DiscordBridgeHealth>) => void,
  ): Promise<void>;
  stop(): Promise<void>;
  validateChannel(guildId: string, channelId: string): Promise<{ name: string }>;
  send(channelId: string, payload: DiscordSendPayload): Promise<DiscordWireMessage>;
  edit(channelId: string, messageId: string, content: string): Promise<DiscordWireMessage>;
  history(channelId: string, before?: string): Promise<DiscordWireMessage[]>;
  message(channelId: string, messageId: string): Promise<DiscordWireMessage | null>;
}
export class DiscordTransportError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
    public readonly retryAfterMs = 0,
    public readonly global = false,
  ) {
    super(code);
  }
}
let transport: DiscordTransport | null = null;
let state: Partial<DiscordBridgeHealth> = {};
export function setDiscordRuntime(
  next: DiscordTransport | null,
  health: Partial<DiscordBridgeHealth> = {},
): void {
  transport = next;
  state = health;
}
export function updateDiscordHealth(health: Partial<DiscordBridgeHealth>): void {
  state = { ...state, ...health };
}
export function discordHealth(): DiscordBridgeHealth {
  return {
    enabled: process.env.PM_DISCORD_AGENT_MESSAGING_ENABLED === "true",
    tokenPresent: !!process.env.PM_DISCORD_BOT_TOKEN?.trim(),
    connected: false,
    botId: null,
    botName: null,
    errorCode: null,
    ...state,
  };
}
export function discordTransport(): DiscordTransport | null {
  return transport;
}
