import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  claimEpic,
  forceClaimEpic,
  getEpic,
  listEpics,
  releaseEpic,
} from "../api-client.js";
import {
  claimResultText,
  claimStateLabel,
  claimStatusLabel,
  forceClaimResultText,
} from "./claim-display.js";

export function registerEpicTools(server: McpServer): void {
  // ---- pm_list_epics ----

  server.tool(
    "pm_list_epics",
    "List epics with optional project, status, milestone, and claim filters. Each epic shows its claim_status relative to you (available to claim, claimed for you, claimed by another agent). Pass claim='available' to see only epics you can safely work on.",
    {
      project_id: z.string().optional().describe("Filter by project ID"),
      status: z
        .enum(["draft", "active", "completed", "cancelled"])
        .optional()
        .describe("Filter by epic status"),
      milestone_id: z.string().optional().describe("Filter by milestone ID"),
      claim: z
        .enum(["available", "mine", "all"])
        .optional()
        .describe(
          "Filter by claim ownership relative to you: 'available' = unclaimed OR claimed by you (safe to work on); 'mine' = only epics you've claimed; 'all' = no claim restriction (default).",
        ),
    },
    async ({ project_id, status, milestone_id, claim }) => {
      const epics = await listEpics(project_id, {
        status,
        milestone: milestone_id,
        claim,
      });

      const text = epics
        .map((e) => {
          const claimLine = `  Claim: ${claimStateLabel(e.claimState) || claimStatusLabel(e.claimStatus)}`;
          const progress = e.taskSummary
            ? `  Tasks: ${e.taskSummary.done}/${e.taskSummary.total} done`
            : "";
          const descLine = e.description
            ? e.description.slice(0, 200)
            : "(no description)";
          return [
            `- **${e.name}**`,
            `  ID: ${e.id}`,
            `  Status: ${e.status}`,
            `  Priority: ${e.priority}`,
            `  Project: ${e.projectId}`,
            claimLine,
            progress,
            `  ${descLine}`,
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text:
              epics.length > 0
                ? `Found ${epics.length} epic(s):\n\n${text}`
                : "No epics found.",
          },
        ],
      };
    },
  );

  // ---- pm_get_epic ----

  server.tool(
    "pm_get_epic",
    "Get full epic details with task summary. Includes claim_status (whether the epic is available to claim, claimed for you, or claimed by another agent).",
    {
      epic_id: z.string().describe("The epic ID to retrieve"),
    },
    async ({ epic_id }) => {
      const epic = await getEpic(epic_id);

      const sections: string[] = [
        `# ${epic.name}`,
        "",
        `**ID:** ${epic.id}`,
        `**Status:** ${epic.status}`,
        `**Priority:** ${epic.priority}`,
        `**Claim:** ${claimStateLabel(epic.claimState) || claimStatusLabel(epic.claimStatus)}`,
        `**Project:** ${epic.projectId}`,
      ];

      if (epic.proposalId) sections.push(`**Linked proposal:** ${epic.proposalId}`);
      if (epic.milestoneId) sections.push(`**Milestone:** ${epic.milestoneId}`);
      if (epic.targetDate) sections.push(`**Target date:** ${epic.targetDate}`);

      if (epic.description) {
        sections.push("", "## Description", "", epic.description);
      }

      if (epic.taskSummary) {
        sections.push(
          "",
          `## Tasks (${epic.taskSummary.done}/${epic.taskSummary.total} done)`,
        );
        const statusParts = Object.entries(epic.taskSummary.byStatus)
          .map(([status, count]) => `${status}: ${count}`)
          .join(", ");
        if (statusParts) {
          sections.push(`By status: ${statusParts}`);
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

  // ---- pm_claim_epic ----

  server.tool(
    "pm_claim_epic",
    "Claim an epic so other agents know it's being worked on. Sets you as the epic assignee. The server tells you the outcome — it never reveals other claimants' identities.",
    {
      epic_id: z.string().describe("The epic ID to claim"),
    },
    async ({ epic_id }) => {
      const result = await claimEpic(epic_id);
      return {
        content: [
          {
            type: "text" as const,
            text: claimResultText(result, "claim", "epic"),
          },
        ],
      };
    },
  );

  // ---- pm_force_claim_epic ----

  server.tool(
    "pm_force_claim_epic",
    "Take over an existing claim (reason required, audited). Self-recovery when your session identity changed.",
    {
      epic_id: z.string(),
      reason: z
        .string()
        .describe(
          "Why you are taking over this claim (required, recorded in the audit log)",
        ),
      assignee_id: z
        .string()
        .optional()
        .describe(
          "Target user id — only a human director may target another agent; omit to claim for yourself",
        ),
    },
    async ({ epic_id, reason, assignee_id }) => {
      const result = await forceClaimEpic(epic_id, reason, assignee_id);
      return {
        content: [
          {
            type: "text" as const,
            text: forceClaimResultText(result, "epic"),
          },
        ],
      };
    },
  );

  // ---- pm_release_epic ----

  server.tool(
    "pm_release_epic",
    "Release your claim on an epic so other agents can pick it up. Use this when you're done working on it or handing off.",
    {
      epic_id: z.string().describe("The epic ID to release"),
    },
    async ({ epic_id }) => {
      const result = await releaseEpic(epic_id);
      return {
        content: [
          {
            type: "text" as const,
            text: claimResultText(result, "release", "epic"),
          },
        ],
      };
    },
  );
}
