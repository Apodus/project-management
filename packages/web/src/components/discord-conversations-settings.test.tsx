import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordConversationsSettings } from "./discord-conversations-settings";
const mock = vi.hoisted(() => ({ apiFetch: vi.fn(), getUsers: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mock.apiFetch, getUsers: mock.getUsers }));
vi.mock("@/hooks/use-auth", () => ({ useCurrentUser: mock.user }));
const routeInput = {
  guildId: "111111111111111111",
  channelId: "222222222222222222",
  recipientUserId: "human",
  recipientDiscordId: "333333333333333333",
  enabled: false,
  generation: 1,
};
const view = {
  route: { ...routeInput, channelName: "agent-inbox", verifiedAt: "now", testUntil: null },
  bridge: {
    enabled: true,
    tokenPresent: true,
    connected: true,
    botId: "bot",
    botName: "PM",
    errorCode: null,
  },
  pendingSends: 0,
  unreadReplies: 0,
  oldestPendingAt: null,
  lastSentAt: null,
  lastReplyAt: null,
  lastHistorySyncAt: null,
  historyError: null,
  recentFailures: [],
};
let queryClient: QueryClient;
function mount() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <DiscordConversationsSettings projectId="project" />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.user.mockReturnValue({ data: { id: "human", type: "human", role: "admin" } });
  mock.getUsers.mockResolvedValue([
    { id: "human", type: "human", isActive: true, displayName: "Human" },
  ]);
  mock.apiFetch.mockImplementation(async (path: string) =>
    path.endsWith("discord-agent-route") ? view : { conversations: [], nextCursor: null },
  );
});
afterEach(() => {
  cleanup();
  queryClient?.clear();
});
describe("Discord settings", () => {
  it("writes only the dedicated route fields, including after repeated saves", async () => {
    mount();
    const channel = await screen.findByLabelText("Private channel ID");
    fireEvent.change(channel, { target: { value: "555555555555555555" } });
    fireEvent.click(screen.getByRole("button", { name: "Save agent channel" }));
    await waitFor(() =>
      expect(mock.apiFetch).toHaveBeenCalledWith(
        "/projects/project/discord-agent-route",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const first = mock.apiFetch.mock.calls.find((c) => c[1]?.method === "PUT")!;
    expect(JSON.parse(first[1].body)).toEqual({ ...routeInput, channelId: "555555555555555555" });
    await screen.findByText("Agent channel saved.");
    fireEvent.click(screen.getByRole("button", { name: "Save agent channel" }));
    await waitFor(() =>
      expect(mock.apiFetch.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(2),
    );
    expect(
      JSON.parse(mock.apiFetch.mock.calls.filter((c) => c[1]?.method === "PUT")[1]![1].body),
    ).toEqual(routeInput);
    expect(mock.apiFetch.mock.calls.some((c) => c[0] === "/projects/project")).toBe(false);
  });
  it("uses the durable test endpoint and requires an explicit test acknowledgement", async () => {
    mock.apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/test"))
        return { conversationId: "test-conversation", deliveryStatus: "queued" };
      if (path === "/agent-conversations/test-conversation")
        return {
          conversation: {
            id: "test-conversation",
            sessionTitle: "Test",
            code: "CODE",
            isTest: true,
            ownerUserId: "human",
            consumerGeneration: 3,
            status: "open",
          },
          messages: [
            {
              id: "reply",
              direction: "human",
              body: "Phone reply",
              acknowledgedAt: null,
              authorLabel: "Human",
            },
          ],
          nextBeforeSeq: null,
        };
      return path.endsWith("discord-agent-route") ? view : { conversations: [], nextCursor: null };
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Send test" }));
    await screen.findByText("Phone reply");
    expect(mock.apiFetch.mock.calls.some((c) => c[0].endsWith("/ack"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge test reply" }));
    await waitFor(() =>
      expect(mock.apiFetch).toHaveBeenCalledWith("/agent-conversations/test-conversation/ack", {
        method: "POST",
        headers: { "X-PM-Session-Id": "discord-test:human" },
        body: JSON.stringify({ replyIds: ["reply"], consumerGeneration: 3 }),
      }),
    );
  });
  it("shows configuration access only to human admins", () => {
    mock.user.mockReturnValue({ data: { id: "agent", type: "ai_agent", role: "admin" } });
    mount();
    expect(screen.getByText(/A human administrator can configure/)).toBeInTheDocument();
    expect(mock.apiFetch).not.toHaveBeenCalled();
  });
});
