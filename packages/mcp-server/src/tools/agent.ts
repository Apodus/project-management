import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  claimEpic,
  releaseEpic,
  listTasks,
  listProposals,
  getAgentIdentity,
  type EpicSummary,
} from "../api-client.js";

export function registerAgentTools(server: McpServer): void {
  // ---- pm_claim_epic ----

  server.tool(
    "pm_claim_epic",
    "Claim an unowned epic for focused work. Sets you as the epic assignee so other agents know you own it.",
    {
      epic_id: z.string().describe("The epic ID to claim"),
    },
    async ({ epic_id }) => {
      const epic = await claimEpic(epic_id);

      const sections: string[] = [
        "Epic claimed successfully.",
        "",
        `**Epic:** ${epic.name}`,
        `**ID:** ${epic.id}`,
        `**Status:** ${epic.status}`,
        `**Priority:** ${epic.priority}`,
        `**Project:** ${epic.projectId}`,
      ];

      if (epic.description) {
        sections.push("", "**Description:**", epic.description);
      }

      if (epic.taskSummary) {
        sections.push(
          "",
          `**Tasks:** ${epic.taskSummary.total} total, ${epic.taskSummary.done} done`,
        );
        const statusParts = Object.entries(epic.taskSummary.byStatus)
          .map(([status, count]) => `${status}: ${count}`)
          .join(", ");
        if (statusParts) {
          sections.push(`**By status:** ${statusParts}`);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: sections.join("\n"),
          },
        ],
      };
    },
  );

  // ---- pm_release_epic ----

  server.tool(
    "pm_release_epic",
    "Release an epic when done working on it. Clears the assignee so other agents can claim it.",
    {
      epic_id: z.string().describe("The epic ID to release"),
    },
    async ({ epic_id }) => {
      const epic = await releaseEpic(epic_id);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Epic released.",
              "",
              `**Epic:** ${epic.name}`,
              `**ID:** ${epic.id}`,
              `**Status:** ${epic.status}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ---- pm_get_my_work ----

  server.tool(
    "pm_get_my_work",
    "Get the current agent's work state: identity, assigned epics, in-progress tasks, and open proposals. Use this to orient yourself at the start of a session.",
    {},
    async () => {
      const identity = getAgentIdentity();

      const sections: string[] = [];

      // Identity
      if (identity) {
        sections.push(
          `**You are:** ${identity.displayName} (@${identity.username})`,
          "",
        );
      } else {
        sections.push(
          "**Identity:** Using static API token (no pool claim)",
          "",
        );
      }

      // Fetch in-progress tasks assigned to this agent
      let myTasks: Awaited<ReturnType<typeof listTasks>> = [];
      try {
        const assigneeFilter = identity?.userId ?? "me";
        myTasks = await listTasks({
          status: "in_progress",
          assignee: assigneeFilter,
        });
      } catch {
        // If we can't get tasks, continue with empty list
      }

      // Fetch open/discussing proposals
      let openProposals: Awaited<ReturnType<typeof listProposals>> = [];
      try {
        openProposals = await listProposals(undefined, "open");
      } catch {
        // Continue with empty list
      }

      // Format tasks
      if (myTasks.length > 0) {
        sections.push(`## In-Progress Tasks (${myTasks.length})`);
        for (const task of myTasks) {
          sections.push(
            `- [${task.priority.toUpperCase()}] **${task.title}** (${task.id})${task.epicId ? ` [Epic: ${task.epicId}]` : ""}`,
          );
        }
        sections.push("");
      } else {
        sections.push("## In-Progress Tasks: None", "");
      }

      // Format proposals
      if (openProposals.length > 0) {
        sections.push(`## Open Proposals (${openProposals.length})`);
        for (const p of openProposals) {
          sections.push(
            `- **${p.title}** (${p.id}) — ${p.status}`,
          );
        }
        sections.push("");
      } else {
        sections.push("## Open Proposals: None", "");
      }

      // Summary line
      const summaryParts: string[] = [];
      if (myTasks.length > 0) summaryParts.push(`${myTasks.length} task(s) in progress`);
      if (openProposals.length > 0) summaryParts.push(`${openProposals.length} open proposal(s)`);

      if (summaryParts.length > 0) {
        sections.push(`**Summary:** ${summaryParts.join(", ")}`);
      } else {
        sections.push("**Summary:** No active work. Use pm_pick_next_task to get started.");
      }

      return {
        content: [
          {
            type: "text" as const,
            text: sections.join("\n"),
          },
        ],
      };
    },
  );
}
