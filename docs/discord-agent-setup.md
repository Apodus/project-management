# Discord agent conversations: setup and operation

PM agents can send important standalone messages to a private Discord text channel and receive your replies through the client MCP. This uses a dedicated bot and project route. The existing notification/integrator webhook remains independent.

## 1. Create the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), choose **New Application**, and name it **PM Agent Inbox** (or another recognizable name).
2. Open **Bot**. Under **Privileged Gateway Intents**, enable **Message Content Intent**. The bridge requests Guilds, Guild Messages, and Message Content; it does not need Members or Presence intents.
3. Create/reset the bot token and save it directly in the PM server's private environment or secret store. Do not paste the token in an agent conversation, PM settings, or the client MCP configuration.
4. Under **Installation**, enable **Guild Install**, use the Discord provided install link, and include the `bot` scope. Grant **View Channels**, **Send Messages**, and **Read Message History**. Invite the bot to the server containing your private channel. The OAuth2 URL Generator with the `bot` scope and these permissions is also suitable. Slash commands and a public interactions URL are not required.
5. In your private ordinary text channel (for example `#agent-inbox`), explicitly allow the bot to **View Channel**, **Send Messages**, and **Read Message History**. Keep access restricted to you and the bot. Administrator permission is unnecessary. Forum channels, threads, voice channels and DMs are not supported in this version.
6. In Discord **User Settings → Advanced**, enable **Developer Mode**. Copy the server ID, channel ID, and your Discord user ID for the PM form. These are numeric IDs, not names or an application/client ID.

Discord's current [installation guide](https://github.com/discord/discord-api-docs/blob/main/developers/quick-start/getting-started.mdx) and [Gateway intent documentation](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx) describe these controls.

## 2. Run the updated PM server

The feature ships disabled. Set these variables on the **server process**, then restart it:

```dotenv
PM_DISCORD_AGENT_MESSAGING_ENABLED=true
PM_DISCORD_BOT_TOKEN=<your-private-bot-token>
```

PM does not automatically load arbitrary `.env` files. The local Windows `run.bat` launcher loads `.env.discord.local` when it exists, so the bot configuration survives ordinary restarts. For other launchers/services, supply variables explicitly or use Node's `--env-file` option with that ignored local file. Preserve your existing database path, host, port and other server settings. Never start two different databases with the same bot and channel.

For a local build, after stopping the existing PM server:

```powershell
pnpm install
pnpm build
node --env-file=.env.discord.local packages/server/dist/index.js
```

Include `NODE_ENV=production` in that private environment file to serve the built web app. The normal production launcher uses a pinned deployment snapshot instead: run `pnpm deploy:server` to refresh it, and have your launcher supply the two variables before `pnpm start:prod`. Building alone does not update `packages/server/.deploy`.

The bridge uses outbound HTTPS and Discord's outbound Gateway WebSocket. No inbound port forwarding, webhook endpoint, or public PM URL is necessary. Keep the PM server running to receive replies promptly. If it stops, saved Discord history is recovered when it reconnects, subject to Discord retaining those messages and the bot retaining channel access.

The SDK is pinned to `discord.js@14.25.1`; its published package engines support PM's Node 22 baseline. The bot token is never returned by the API or stored in project settings. Delivery payloads are stored in PM's SQLite database as conversation history.

## 3. Configure and test the private channel

As a PM **human administrator**, open the project → **Settings → Notifications → Agent conversations**.

1. Confirm **Connected as PM Agent Inbox**, server bridge **enabled**, and token **configured**.
2. Enter the server ID, private channel ID, your PM human user, and your Discord user ID. Leave **Enable agent messages** off initially.
3. Click **Save agent channel**. PM validates the bot's channel access and permissions.
4. Click **Send test**. This creates a durable test conversation and permits test traffic for ten minutes without enabling normal agent sends.
5. Check that the test message appears in the private channel and that you receive a phone notification. Use Discord's **Reply** action on that message to send a short text such as “Received on my phone”.
6. Discord should show a quiet receipt saying the reply was saved. In PM, the test conversation should show your text. Click **Acknowledge test reply**; the Discord receipt should change to **Test acknowledgement verified**.
7. Enable **Enable agent messages** and save. This changes the route generation; start a fresh agent conversation after enabling.

PM confirms Discord API delivery; it cannot confirm a phone displayed a notification. Enable the server's **Mobile Push Notifications**, allow Discord notifications in your phone OS, and check channel/server muting and Do Not Disturb. Test away from the active desktop as well. See Discord's [notification settings guide](https://support.discord.com/hc/en-us/articles/215253258-Notifications-Settings-101).

The message mentions only the configured recipient. Agent-supplied `@everyone`, role mentions and other user mentions cannot trigger extra pings. Saved/received receipts are quiet.

## 4. Use from the client MCP

Build/restart the MCP client so its tool list includes the new tools. For this checkout, use `node D:/code/project-management/packages/mcp-server/dist/index.js` with the normal `PM_API_URL` and agent credentials. A previously published npm version does not gain these tools until a new release is published.

`PM_WORKER_KEY` identifies a stable pooled worker. The optional `PM_SESSION_ID` identifies one agent conversation/session: use a distinct value for each simultaneous session, and reuse it only when resuming that same session. Without it, the MCP process generates a UUID; a replacement process must explicitly resume old conversations.

Example initial tool input:

```json
{
  "project_id": "<PM project ID>",
  "session_title": "Audio routing implementation",
  "kind": "question",
  "message": "Should piano audio remain local, or should it be sent to the shared mix? I can finish the routing once you choose.",
  "idempotency_key": "audio-routing-question-1"
}
```

Call `pm_send_discord_message` with that input. The returned conversation ID routes follow-ups. Reuse the same idempotency key when retrying the same logical send; use a new key for a new message. A `queued` result means PM saved the request, not that Discord has delivered it. `pm_get_discord_conversation` exposes delivery status.

Use `kind: question`, `blocked`, or `update`. Keep the session title stable and the message useful without PM links. Send important decisions, blockers and results, rather than routine progress.

While waiting, call `pm_check_discord_replies` with the conversation ID and `wait_seconds: 25`. After reading and processing the human answer, call `pm_ack_discord_replies` with that conversation ID and the specific reply IDs. Reading alone does not acknowledge anything. Continue checking while waiting; normal PM tool calls also include a small unread-reply notice. The receipt says “Received by the agent”; that is not a completion claim.

The agent runtime still controls when tools execute. PM does **not** automatically launch a stopped CLI or inject a turn into an idle agent. Replies remain pending. On restart, `pm_get_my_work` lists owned conversations; call `pm_resume_discord_conversation` and then check replies. Resume invalidates the previous session's acknowledgement generation. A different worker identity needs an administrator to reassign the conversation.

When finished, call `pm_close_discord_conversation`. Later replies are retained for review and get a closed-conversation receipt. Close does not delete history.

## 5. Recovery and limits

| Symptom | Action |
| --- | --- |
| Bridge disabled / token missing | Set server environment and restart the updated server. |
| `MESSAGE_CONTENT_INTENT_REQUIRED` | Enable Message Content Intent in the bot portal, then restart PM. |
| `INVALID_TOKEN` | Replace the server token and restart PM. |
| Missing channel permissions / destination removed | Restore access to the same channel and save the channel form to revalidate. Retry failed deliveries with a reason in Recovery controls. |
| Queued or retrying | Check history recovery and pending-delivery health. PM respects Discord rate limits and retries transient failures. |
| Delivery uncertain | PM reconciles recent channel history before resending. Do not create a new logical message just to retry; a rare duplicate may still appear after a provider/network failure. Replies to either mapped copy are accepted. |
| Reply saved, waiting for agent | Have the running agent check replies, or restart/resume the conversation. |
| Plain channel message ignored | Use Discord's native Reply action on an agent message or an already mapped reply. PM never guesses the target session. |
| Attachments, edits or voice messages | Send a new text reply describing the content. Only message creation and text are forwarded. |
| Suspended conversation | Channel, recipient or enablement changed. Start a new conversation; old history stays with its original recipient. |

Defaults: 5 new agent messages per conversation per 10 minutes; 30 per project per hour; 100 pending sends per project. `PM_DISCORD_CONVERSATION_LIMIT` and `PM_DISCORD_PROJECT_HOURLY_LIMIT` configure the first two. Quotas return HTTP 429 with `Retry-After`; receipts do not use the agent-send budget. Ordinary delivery retries expire after one hour and stop after eight non-rate-limit failed attempts. An administrator may retry failed/expired delivery explicitly with an audit reason.

Conversation history is visible to its owner, original mapped human, and human administrators. Administrators can inspect history, retry, close, or reassign; route changes and recovery actions are audited without message bodies. Reply bodies do not enter the general activity feed or the integrator timeline.

For final live acceptance, test two simultaneous agent sessions, a reply while PM is stopped followed by restart, and a reply while the agent is stopped followed by explicit resume. Verify the integrator channel continues receiving only its existing notifications.
