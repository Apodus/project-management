import { z } from "zod";

export const DISCORD_MESSAGE_KINDS = ["question", "blocked", "update"] as const;
export const DISCORD_DELIVERY_STATUSES = [
  "queued",
  "sending",
  "retry_wait",
  "delivered",
  "failed",
  "expired",
  "cancelled",
] as const;
export const discordSendSchema = z
  .object({
    sessionTitle: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1500),
    idempotencyKey: z.string().min(1).max(128),
    kind: z.enum(DISCORD_MESSAGE_KINDS).default("update"),
    conversationId: z.string().min(1).optional(),
  })
  .strict();
export const discordRouteInputSchema = z
  .object({
    guildId: z.string().regex(/^\d{17,20}$/),
    channelId: z.string().regex(/^\d{17,20}$/),
    recipientUserId: z.string().min(1),
    recipientDiscordId: z.string().regex(/^\d{17,20}$/),
    enabled: z.boolean(),
    generation: z.number().int().nonnegative(),
  })
  .strict();
export type DiscordSendInput = z.infer<typeof discordSendSchema>;
export type DiscordRouteInput = z.infer<typeof discordRouteInputSchema>;
export type DiscordMessageKind = (typeof DISCORD_MESSAGE_KINDS)[number];
export type DiscordDeliveryStatus = (typeof DISCORD_DELIVERY_STATUSES)[number];

export interface DiscordConversationSummary {
  id: string;
  code: string;
  projectId: string;
  sessionTitle: string;
  ownerUserId: string;
  sessionId: string;
  consumerGeneration: number;
  status: "open" | "closed";
  suspended: boolean;
  isTest: boolean;
  unreadCount: number;
  createdAt: string;
  lastCheckedAt: string | null;
}
export interface DiscordMessageView {
  id: string;
  seq: number;
  direction: "agent" | "human" | "system";
  body: string;
  authorLabel: string;
  createdAt: string;
  acknowledgedAt: string | null;
  deliveryStatus: DiscordDeliveryStatus | null;
  deliveryUncertain: boolean;
  errorCode: string | null;
  discordMessageId: string | null;
}
export interface DiscordConversationDetail {
  conversation: DiscordConversationSummary;
  messages: DiscordMessageView[];
  nextBeforeSeq: number | null;
}
export interface DiscordSendResult {
  conversationId: string;
  conversationCode: string;
  messageId: string;
  consumerGeneration: number;
  deliveryStatus: DiscordDeliveryStatus;
  duplicate: boolean;
  replyRequested: boolean;
}
export interface DiscordReply {
  id: string;
  conversationId: string;
  conversationCode: string;
  sessionTitle: string;
  consumerGeneration: number;
  body: string;
  authorLabel: string;
  createdAt: string;
  conversationClosed: boolean;
}
export interface DiscordReplyInbox {
  replies: DiscordReply[];
  hasMore: boolean;
}
export interface DiscordBridgeHealth {
  enabled: boolean;
  tokenPresent: boolean;
  connected: boolean;
  botId: string | null;
  botName: string | null;
  errorCode: string | null;
}
export interface DiscordRouteView {
  route:
    | (DiscordRouteInput & { channelName: string; verifiedAt: string; testUntil: string | null })
    | null;
  bridge: DiscordBridgeHealth;
  pendingSends: number;
  unreadReplies: number;
  oldestPendingAt: string | null;
  lastSentAt: string | null;
  lastReplyAt: string | null;
  lastHistorySyncAt: string | null;
  historyError: string | null;
  recentFailures: Array<{ messageId: string; code: string | null; uncertain: boolean }>;
}
