import { test, expect } from "@playwright/test";
import { createProjectViaAPI, getCurrentUserId, login } from "./helpers";

test("agent channel setup is separate and disabled until the server bot is configured", async ({
  page,
}) => {
  await login(page, "admin", "password123");
  const project = await createProjectViaAPI(page, "Discord setup");
  await page.goto(`/projects/${project.id}/settings/notifications`);
  await expect(page.getByText("Agent conversations", { exact: true })).toBeVisible();
  await expect(page.getByText("Bot disconnected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save agent channel" })).toBeDisabled();
  await page.getByText("Bot and private channel setup").click();
  await expect(page.getByRole("link", { name: "Discord Developer Portal" })).toBeVisible();
  await expect(page.getByText("PM_DISCORD_BOT_TOKEN", { exact: true })).toBeVisible();
});

// The real Discord Gateway is replaced at the HTTP boundary for browser tests.
// The service/bridge integration suite separately drives actual SQLite + REST.
test("admin can configure a channel, send a test and acknowledge a phone reply", async ({
  page,
}, testInfo) => {
  await login(page, "admin", "password123");
  const project = await createProjectViaAPI(page, "Discord round trip");
  const userId = await getCurrentUserId(page);
  const routeInput = {
    guildId: "111111111111111111",
    channelId: "222222222222222222",
    recipientUserId: userId,
    recipientDiscordId: "333333333333333333",
    enabled: false,
    generation: 1,
  };
  let saved = false;
  let sent = false;
  let acknowledged = false;
  const conversation = {
    id: "test-conversation",
    code: "TEST123",
    projectId: project.id,
    sessionTitle: "Discord connection test",
    ownerUserId: userId,
    sessionId: `discord-test:${userId}`,
    consumerGeneration: 1,
    status: "open",
    suspended: false,
    isTest: true,
    unreadCount: 1,
    createdAt: new Date().toISOString(),
    lastCheckedAt: null,
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const fulfill = (data: unknown, status = 200) => route.fulfill({ status, json: { data } });
    if (path.endsWith("/discord-agent-route")) {
      if (request.method() === "PUT") {
        expect(request.postDataJSON()).toEqual({ ...routeInput, generation: 0 });
        saved = true;
      }
      return fulfill({
        route: saved
          ? {
              ...routeInput,
              channelName: "agent-inbox",
              verifiedAt: new Date().toISOString(),
              testUntil: null,
            }
          : null,
        bridge: {
          enabled: true,
          tokenPresent: true,
          connected: true,
          botId: "bot",
          botName: "PM Agent Inbox",
          errorCode: null,
        },
        pendingSends: 0,
        unreadReplies: sent && !acknowledged ? 1 : 0,
        oldestPendingAt: null,
        lastSentAt: null,
        lastReplyAt: null,
        lastHistorySyncAt: null,
        historyError: null,
        recentFailures: [],
      });
    }
    if (path.endsWith("/discord-agent-route/test")) {
      expect(request.postDataJSON().idempotencyKey).toBeTruthy();
      sent = true;
      return fulfill({ conversationId: conversation.id, deliveryStatus: "queued" }, 202);
    }
    if (path.endsWith("/agent-conversations"))
      return fulfill({ conversations: sent ? [conversation] : [], nextCursor: null });
    if (path.endsWith("/agent-conversations/test-conversation"))
      return fulfill({
        conversation,
        nextBeforeSeq: null,
        messages: [
          {
            id: "reply-1",
            seq: 2,
            direction: "human",
            body: "Reply from my phone",
            authorLabel: "Admin User",
            createdAt: new Date().toISOString(),
            acknowledgedAt: acknowledged ? new Date().toISOString() : null,
            deliveryStatus: null,
            deliveryUncertain: false,
            errorCode: null,
            discordMessageId: "phone-message",
          },
        ],
      });
    if (path.endsWith("/agent-conversations/test-conversation/ack")) {
      expect(request.headers()["x-pm-session-id"]).toBe(`discord-test:${userId}`);
      expect(request.postDataJSON()).toEqual({ replyIds: ["reply-1"], consumerGeneration: 1 });
      acknowledged = true;
      return fulfill({ acknowledgedIds: ["reply-1"] });
    }
    return route.continue();
  });
  await page.goto(`/projects/${project.id}/settings/notifications`);
  await page.getByLabel("Discord server ID", { exact: true }).fill(routeInput.guildId);
  await page.getByLabel("Private channel ID").fill(routeInput.channelId);
  await page.getByLabel("Recipient’s Discord user ID").fill(routeInput.recipientDiscordId);
  await page.getByRole("button", { name: "Save agent channel" }).click();
  await expect(page.getByText("Agent channel saved.")).toBeVisible();
  await page.getByRole("button", { name: "Send test", exact: true }).click();
  await expect(page.getByText("Reply from my phone")).toBeVisible();
  expect(acknowledged).toBe(false);
  await page.getByRole("button", { name: "Acknowledge test reply" }).click();
  await expect(page.getByText(/received by agent/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("discord-settings.png"), fullPage: true });
});
