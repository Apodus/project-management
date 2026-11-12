import { randomUUID } from "node:crypto";
import type {
  DiscordConversationDetail,
  DiscordConversationSummary,
  DiscordReplyInbox,
  DiscordSendInput,
  DiscordSendResult,
} from "@pm/shared";
import { apiRequest } from "./api-client.js";

const processSessionId = randomUUID();
export function getDiscordSessionId(): string {
  return process.env.PM_SESSION_ID?.trim() || processSessionId;
}
export function discordReconnectMode() {
  return process.env.PM_SESSION_ID?.trim() ? "launcher_session_id" : "explicit_resume_required";
}
function call<T>(method: "GET" | "POST", path: string, body?: unknown) {
  return apiRequest<T>(method, path, body, { "X-PM-Session-Id": getDiscordSessionId() });
}
export function sendDiscordMessage(projectId: string, input: DiscordSendInput) {
  return call<DiscordSendResult>(
    "POST",
    `/projects/${encodeURIComponent(projectId)}/agent-conversations/messages`,
    input,
  );
}
export function checkDiscordReplies(conversationId?: string, waitSeconds = 0, limit = 20) {
  const query = new URLSearchParams({
    waitSeconds: String(waitSeconds),
    limit: String(limit),
    ...(conversationId ? { conversationId } : {}),
  });
  return call<DiscordReplyInbox>("GET", `/agent-conversations/replies?${query}`);
}
export function ackDiscordReplies(
  conversationId: string,
  replyIds: string[],
  consumerGeneration: number,
) {
  return call<{ acknowledgedIds: string[] }>(
    "POST",
    `/agent-conversations/${encodeURIComponent(conversationId)}/ack`,
    { replyIds, consumerGeneration },
  );
}
export function getDiscordConversation(id: string, beforeSeq?: number, limit = 50) {
  const query = new URLSearchParams({
    limit: String(limit),
    ...(beforeSeq ? { beforeSeq: String(beforeSeq) } : {}),
  });
  return call<DiscordConversationDetail>(
    "GET",
    `/agent-conversations/${encodeURIComponent(id)}?${query}`,
  );
}
export function resumeDiscordConversation(id: string) {
  return call<DiscordConversationDetail>(
    "POST",
    `/agent-conversations/${encodeURIComponent(id)}/resume`,
  );
}
export function closeDiscordConversation(id: string) {
  return call<DiscordConversationSummary>(
    "POST",
    `/agent-conversations/${encodeURIComponent(id)}/close`,
  );
}
export function listOwnDiscordConversations() {
  return call<{ conversations: DiscordConversationSummary[]; nextCursor: string | null }>(
    "GET",
    "/agent-conversations",
  );
}
