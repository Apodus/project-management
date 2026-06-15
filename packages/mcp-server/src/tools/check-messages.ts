import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listUndelivered, markDelivered } from "../api-client.js";
import { getWorkerKey } from "../worker-key.js";

/**
 * pm_check_messages (Campaign C2 §P4) — the drain tool.
 *
 * Reads the directed escalation replies addressed to the caller's worker key
 * (PM_WORKER_KEY, or an explicit `worker_key` override) that it has not yet
 * seen, renders them thread-aware, and (unless `mark_delivered: false`)
 * advances the per-escalation read cursor so they are not re-surfaced.
 *
 * Surfacing (the response piggyback) is distinct from consuming: only THIS
 * tool advances the cursor. A cursor-write failure never blanks the replies —
 * the render is built BEFORE the mark loop and the loop is best-effort.
 */
export function registerCheckMessagesTool(server: McpServer): void {
  server.tool(
    "pm_check_messages",
    "Check for directed replies on escalations you raised — the cross-team channel's inbox for your worker. Drains the unread replies addressed to your PM_WORKER_KEY (or an explicit worker_key), renders the threads, and acknowledges them (advances your read cursor) unless mark_delivered is false. Call this between work steps, or whenever you're notified you have unread replies.",
    {
      project_id: z.string().optional().describe("Optionally scope to a single project."),
      worker_key: z
        .string()
        .optional()
        .describe("Override the worker identity (defaults to PM_WORKER_KEY)."),
      mark_delivered: z
        .boolean()
        .optional()
        .describe(
          "Acknowledge (advance the read cursor) after reading. Default true; pass false to peek.",
        ),
    },
    async ({ project_id, worker_key, mark_delivered }) => {
      const workerKey = worker_key ?? getWorkerKey();
      if (!workerKey) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No worker key configured. Set PM_WORKER_KEY (or pass worker_key) so I can check for directed replies addressed to you.",
            },
          ],
        };
      }

      let undelivered;
      try {
        undelivered = await listUndelivered(workerKey, project_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to check messages: ${message}` }],
        };
      }

      if (!undelivered || undelivered.length === 0) {
        const scope = project_id ? ` in project ${project_id}` : "";
        return {
          content: [{ type: "text" as const, text: `No unread directed replies${scope}.` }],
        };
      }

      const totalUnread = undelivered.reduce((sum, u) => sum + u.unreadMessages.length, 0);
      const lines: string[] = [
        `${totalUnread} unread repl${totalUnread === 1 ? "y" : "ies"} across ${
          undelivered.length
        } escalation${undelivered.length === 1 ? "" : "s"}:`,
        "",
      ];

      for (const { escalation: e, unreadMessages } of undelivered) {
        lines.push(`**[${e.kind}]** ${e.title}`);
        lines.push(`  ${e.id} | ${e.status} | Origin: ${e.originRepo} · ${e.originWorkerKey}`);
        const ordered = [...unreadMessages].sort((a, b) => a.seq - b.seq);
        for (const msg of ordered) {
          lines.push(`  **#${msg.seq}** (${msg.messageType ?? "reply"}) — ${msg.createdAt}`);
          lines.push(`  ${msg.body}`);
        }
        lines.push("");
      }

      // Advance the read cursor (best-effort) AFTER building the render, so a
      // cursor-write failure never blanks the replies.
      let cursorFailed = false;
      if (mark_delivered !== false) {
        try {
          const results = await Promise.allSettled(
            undelivered.map(({ escalation: e, unreadMessages }) => {
              const uptoSeq = Math.max(...unreadMessages.map((m) => m.seq));
              return markDelivered(e.id, workerKey, uptoSeq);
            }),
          );
          cursorFailed = results.some((r) => r.status === "rejected");
        } catch {
          cursorFailed = true;
        }
      }

      if (mark_delivered === false) {
        lines.push("Peeked only — call again without mark_delivered to acknowledge.");
      } else if (cursorFailed) {
        lines.push("(note: could not advance the read cursor — these may resurface)");
      } else {
        lines.push("Marked as read.");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n").trimEnd() }],
      };
    },
  );
}
