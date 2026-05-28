import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getAgentIdentity,
  listProposals,
  listTasks,
} from "../api-client.js";

export function registerAgentTools(server: McpServer): void {
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
          const epic = task.epicName ?? task.epicId;
          sections.push(
            `- [${task.priority.toUpperCase()}] **${task.title}** (${task.id})${epic ? ` [Epic: ${epic}]` : ""}`,
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
