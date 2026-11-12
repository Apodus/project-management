import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "@/lib/api-types";
import { apiFetch, getUsers } from "@/lib/api";
import { useCurrentUser } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const key = ["discord-conversations"] as const;
type DiscordConversationDetail = components["schemas"]["DiscordConversationDetail"];
type DiscordConversationSummary = components["schemas"]["DiscordConversationSummary"];
type DiscordRouteInput = components["schemas"]["DiscordRouteInput"];
type DiscordRouteView = components["schemas"]["DiscordRouteView"];
type DiscordSendResult = components["schemas"]["DiscordSendResult"];
function editableRoute(route: DiscordRouteInput): DiscordRouteInput {
  return {
    guildId: route.guildId,
    channelId: route.channelId,
    recipientUserId: route.recipientUserId,
    recipientDiscordId: route.recipientDiscordId,
    enabled: route.enabled,
    generation: route.generation,
  };
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed. Please retry.";
const post = <T,>(path: string, body?: unknown, sessionId?: string) =>
  apiFetch<T>(path, {
    method: "POST",
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(sessionId ? { headers: { "X-PM-Session-Id": sessionId } } : {}),
  });

export function DiscordConversationsSettings({ projectId }: { projectId: string }) {
  const user = useCurrentUser();
  if (!user.data) return null;
  if (user.data.type !== "human" || user.data.role !== "admin")
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agent conversations</CardTitle>
          <CardDescription>
            A human administrator can configure the private Discord channel.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  return <DiscordAdminSettings key={projectId} projectId={projectId} userId={user.data.id} />;
}

function DiscordAdminSettings({ projectId, userId }: { projectId: string; userId: string }) {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: key });
  };
  const [form, setForm] = useState<DiscordRouteInput | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [beforeSeq, setBeforeSeq] = useState<number>();
  const [cursor, setCursor] = useState<string>();
  const [reason, setReason] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newSession, setNewSession] = useState("");
  const testKey = useRef<string | null>(null);
  const retryKeys = useRef(new Map<string, string>());
  const route = useQuery({
    queryKey: [...key, "route", projectId],
    queryFn: () => apiFetch<DiscordRouteView>(`/projects/${projectId}/discord-agent-route`),
    refetchInterval: 5000,
  });
  const users = useQuery({ queryKey: ["users", "list"], queryFn: getUsers });
  const list = useQuery({
    queryKey: [...key, "list", projectId, cursor],
    queryFn: () =>
      apiFetch<{ conversations: DiscordConversationSummary[]; nextCursor: string | null }>(
        `/projects/${projectId}/agent-conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    refetchInterval: 5000,
  });
  const detail = useQuery({
    queryKey: [...key, "detail", selectedId, beforeSeq],
    queryFn: () =>
      apiFetch<DiscordConversationDetail>(
        `/agent-conversations/${selectedId}${beforeSeq ? `?beforeSeq=${beforeSeq}` : ""}`,
      ),
    enabled: !!selectedId,
    refetchInterval: 3000,
  });
  useEffect(() => {
    if (!route.data || form) return;
    const current = route.data.route;
    setForm(
      current
        ? {
            guildId: current.guildId,
            channelId: current.channelId,
            recipientUserId: current.recipientUserId,
            recipientDiscordId: current.recipientDiscordId,
            enabled: current.enabled,
            generation: current.generation,
          }
        : {
            guildId: "",
            channelId: "",
            recipientDiscordId: "",
            recipientUserId: userId,
            enabled: false,
            generation: 0,
          },
    );
  }, [route.data, form, userId]);
  const save = useMutation({
    mutationFn: () =>
      apiFetch<DiscordRouteView>(`/projects/${projectId}/discord-agent-route`, {
        method: "PUT",
        body: JSON.stringify(form),
      }),
    onSuccess: (data) => {
      if (data.route) setForm(editableRoute(data.route));
      refresh();
    },
  });
  const test = useMutation({
    mutationFn: () => {
      testKey.current ??= crypto.randomUUID();
      return post<DiscordSendResult>(`/projects/${projectId}/discord-agent-route/test`, {
        idempotencyKey: testKey.current,
      });
    },
    onSuccess: (result) => {
      testKey.current = null;
      setSelectedId(result.conversationId);
      setBeforeSeq(undefined);
      refresh();
    },
  });
  const ack = useMutation({
    mutationFn: () => {
      const current = detail.data!;
      return post(
        `/agent-conversations/${current.conversation.id}/ack`,
        {
          replyIds: current.messages
            .filter((m) => m.direction === "human" && !m.acknowledgedAt)
            .map((m) => m.id),
          consumerGeneration: current.conversation.consumerGeneration,
        },
        `discord-test:${userId}`,
      );
    },
    onSuccess: refresh,
  });
  const close = useMutation({
    mutationFn: () => post(`/agent-conversations/${selectedId}/close`),
    onSuccess: refresh,
  });
  const reassign = useMutation({
    mutationFn: () =>
      post(`/agent-conversations/${selectedId}/reassign`, {
        ownerUserId: newOwner,
        sessionId: newSession,
        reason,
      }),
    onSuccess: refresh,
  });
  const retry = useMutation({
    mutationFn: (messageId: string) => {
      if (!retryKeys.current.has(messageId)) retryKeys.current.set(messageId, crypto.randomUUID());
      return post(`/agent-conversations/${selectedId}/messages/${messageId}/retry`, {
        reason,
        idempotencyKey: retryKeys.current.get(messageId),
      });
    },
    onSuccess: (_data, messageId) => {
      retryKeys.current.delete(messageId);
      refresh();
    },
  });
  const error =
    route.error ??
    save.error ??
    test.error ??
    ack.error ??
    close.error ??
    reassign.error ??
    retry.error ??
    detail.error ??
    list.error;
  const health = route.data?.bridge;
  const change = <K extends keyof DiscordRouteInput>(field: K, value: DiscordRouteInput[K]) =>
    setForm((previous) => (previous ? { ...previous, [field]: value } : previous));
  const conversation = detail.data?.conversation;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent conversations</CardTitle>
        <CardDescription>
          Important agent messages and your Discord replies, in a separate private channel. Each
          answer returns to its originating conversation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {errorText(error)}
          </p>
        )}
        {route.isPending && <p>Loading Discord configuration…</p>}
        {health && (
          <div className="rounded-md border p-3 text-sm" aria-live="polite">
            <p>
              <strong>
                {health.connected
                  ? `Connected as ${health.botName ?? "PM bot"}`
                  : "Bot disconnected"}
              </strong>
              {health.errorCode ? ` · ${health.errorCode}` : ""}
            </p>
            <p>
              Server bridge: {health.enabled ? "enabled" : "disabled"} · Bot token:{" "}
              {health.tokenPresent ? "configured" : "missing"}
            </p>
            {(!health.enabled || !health.tokenPresent) && (
              <p className="mt-2">
                Configure <code>PM_DISCORD_BOT_TOKEN</code> and{" "}
                <code>PM_DISCORD_AGENT_MESSAGING_ENABLED=true</code> in the server environment, then
                restart PM. The token stays on the server.
              </p>
            )}
          </div>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Bot and private channel setup</summary>
          <ol className="mt-2 list-decimal space-y-2 pl-5">
            <li>
              Create a bot in the{" "}
              <a
                className="underline"
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noreferrer"
              >
                Discord Developer Portal
              </a>{" "}
              and enable its Message Content Intent.
            </li>
            <li>
              Invite it to your server. In the private text channel, grant View Channel, Send
              Messages, and Read Message History.
            </li>
            <li>
              Enable Discord Developer Mode to copy the server, channel, and your user IDs. Enter
              those below.
            </li>
            <li>
              Save with agent messaging disabled, send a test, reply from your phone, and
              acknowledge the test here. Then enable agent messaging.
            </li>
          </ol>
          <p className="mt-2">
            Use Discord’s Reply action on a PM message. Messages are text-only; send a new reply for
            corrections. Phone notifications also depend on your Discord and phone settings.
          </p>
        </details>
        {form && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="discord-guild">Discord server ID</Label>
                <Input
                  id="discord-guild"
                  value={form.guildId}
                  onChange={(e) => change("guildId", e.target.value)}
                  required
                  pattern="[0-9]{17,20}"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="discord-channel">Private channel ID</Label>
                <Input
                  id="discord-channel"
                  value={form.channelId}
                  onChange={(e) => change("channelId", e.target.value)}
                  required
                  pattern="[0-9]{17,20}"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="discord-human">PM recipient</Label>
                <select
                  className="bg-background h-9 w-full rounded-md border px-3"
                  id="discord-human"
                  value={form.recipientUserId}
                  onChange={(e) => change("recipientUserId", e.target.value)}
                >
                  {users.data
                    ?.filter((u) => u.type === "human" && u.isActive)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName}
                      </option>
                    ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="discord-recipient">Recipient’s Discord user ID</Label>
                <Input
                  id="discord-recipient"
                  value={form.recipientDiscordId}
                  onChange={(e) => change("recipientDiscordId", e.target.value)}
                  required
                  pattern="[0-9]{17,20}"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="discord-agent-enabled"
                checked={form.enabled}
                onCheckedChange={(checked) => change("enabled", checked)}
              />
              <Label htmlFor="discord-agent-enabled">Enable agent messages</Label>
            </div>
            <p className="text-muted-foreground text-xs">
              Changing the channel, recipient, or enabled state suspends existing conversations and
              cancels their unsent messages. Old history stays with its original recipient.
            </p>
            {route.data?.route && route.data.route.generation !== form.generation && (
              <p role="alert">
                Configuration changed elsewhere.{" "}
                <button type="button" className="underline" onClick={() => setForm(null)}>
                  Reload configuration
                </button>{" "}
                before saving.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={
                  save.isPending || (!health?.connected && (form.enabled || !route.data?.route))
                }
              >
                {save.isPending ? "Saving…" : "Save agent channel"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => test.mutate()}
                disabled={test.isPending || !route.data?.route || !health?.connected}
              >
                {test.isPending ? "Queuing test…" : "Send test"}
              </Button>
            </div>
            {save.isSuccess && (
              <p className="text-sm" role="status">
                Agent channel saved.
              </p>
            )}
          </form>
        )}
        {route.data && (
          <div className="grid gap-2 border-t pt-4 text-sm sm:grid-cols-2">
            <p>Pending deliveries: {route.data.pendingSends}</p>
            <p>Unread human replies: {route.data.unreadReplies}</p>
            <p>Oldest pending: {route.data.oldestPendingAt ?? "none"}</p>
            <p>Last sent: {route.data.lastSentAt ?? "none"}</p>
            <p>Last reply: {route.data.lastReplyAt ?? "none"}</p>
            <p>
              History recovery:{" "}
              {route.data.historyError ?? route.data.lastHistorySyncAt ?? "not yet checked"}
            </p>
            {route.data.recentFailures.map((f) => (
              <p key={f.messageId} className="text-destructive">
                Delivery {f.messageId}: {f.code}
                {f.uncertain ? " (delivery uncertain)" : ""}
              </p>
            ))}
          </div>
        )}
        <div className="space-y-2 border-t pt-4">
          <p className="font-medium">Recent conversations</p>
          {list.data?.conversations.length === 0 && (
            <p className="text-muted-foreground text-sm">No conversations yet.</p>
          )}
          {list.data?.conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              className="hover:bg-muted block w-full rounded border p-2 text-left text-sm"
              onClick={() => {
                setSelectedId(c.id);
                setBeforeSeq(undefined);
              }}
            >
              {c.isTest ? "Test · " : ""}
              {c.sessionTitle} · {c.code} — {c.unreadCount} unread
              {c.suspended ? " · suspended" : ` · ${c.status}`}
            </button>
          ))}
          {list.data?.nextCursor && (
            <Button variant="outline" size="sm" onClick={() => setCursor(list.data!.nextCursor!)}>
              Older conversations
            </Button>
          )}
          {cursor && (
            <Button variant="outline" size="sm" onClick={() => setCursor(undefined)}>
              Latest conversations
            </Button>
          )}
        </div>
        {conversation && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="font-medium">
              {conversation.sessionTitle} · {conversation.code}
            </p>
            {detail.data!.messages.map((m) => (
              <div key={m.id} className="border-l-2 pl-3 text-sm">
                <p className="text-muted-foreground">
                  {m.authorLabel} · {m.direction} ·{" "}
                  {m.deliveryStatus ?? (m.acknowledgedAt ? "received by agent" : "reply saved")}
                  {m.deliveryUncertain ? " · delivery uncertain" : ""}
                </p>
                <p className="whitespace-pre-wrap">{m.body}</p>
                {m.errorCode && <p className="text-destructive">{m.errorCode}</p>}
                {["failed", "expired"].includes(m.deliveryStatus ?? "") && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!reason.trim() || retry.isPending}
                    onClick={() => retry.mutate(m.id)}
                  >
                    Retry delivery
                  </Button>
                )}
              </div>
            ))}
            {detail.data?.nextBeforeSeq && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBeforeSeq(detail.data!.nextBeforeSeq!)}
              >
                Older messages
              </Button>
            )}
            {beforeSeq && (
              <Button size="sm" variant="outline" onClick={() => setBeforeSeq(undefined)}>
                Latest messages
              </Button>
            )}
            {conversation.isTest &&
              conversation.ownerUserId === userId &&
              detail.data!.messages.some((m) => m.direction === "human" && !m.acknowledgedAt) && (
                <Button onClick={() => ack.mutate()} disabled={ack.isPending}>
                  Acknowledge test reply
                </Button>
              )}
            {conversation.isTest && (
              <p className="text-muted-foreground text-xs">
                A Discord receipt verifies API delivery. Confirm the phone notification yourself;
                the acknowledgement button verifies the return path.
              </p>
            )}
            {conversation.status === "open" && (
              <Button
                size="sm"
                variant="outline"
                disabled={close.isPending}
                onClick={() => close.mutate()}
              >
                Close conversation
              </Button>
            )}
            <details>
              <summary className="cursor-pointer text-sm">Recovery controls</summary>
              <div className="mt-3 space-y-2">
                <Label htmlFor="discord-recovery-reason">Reason for retry or reassignment</Label>
                <Input
                  id="discord-recovery-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <Label htmlFor="discord-owner">New owner</Label>
                <select
                  className="bg-background h-9 w-full rounded-md border px-3"
                  id="discord-owner"
                  value={newOwner}
                  onChange={(e) => setNewOwner(e.target.value)}
                >
                  <option value="">Select an owner</option>
                  {users.data
                    ?.filter((u) => u.isActive)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName}
                      </option>
                    ))}
                </select>
                <Label htmlFor="discord-session">New agent session ID</Label>
                <Input
                  id="discord-session"
                  value={newSession}
                  onChange={(e) => setNewSession(e.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={!newOwner || !newSession.trim() || !reason.trim() || reassign.isPending}
                  onClick={() => reassign.mutate()}
                >
                  Reassign conversation
                </Button>
              </div>
            </details>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
