import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listProposals, getProposal, addProposalComment } from "../api-client.js";

export function registerProposalTools(server: McpServer): void {
  server.tool(
    "pm_list_proposals",
    "List proposals with optional project and status filters. Returns array of proposals with id, title, status, description, comment_count.",
    {
      project_id: z.string().optional().describe("Filter by project ID"),
      status: z
        .enum(["open", "discussing", "accepted", "planned", "in_progress", "completed", "rejected"])
        .optional()
        .describe("Filter by proposal status"),
    },
    async ({ project_id, status }) => {
      const proposals = await listProposals(project_id, status);

      const text = proposals
        .map(
          (p) =>
            `- **${p.title}**\n  ID: ${p.id}\n  Status: ${p.status}\n  Project: ${p.projectId}\n  ${p.description ? p.description.slice(0, 200) : "(no description)"}${p.commentCount !== undefined ? `\n  Comments: ${p.commentCount}` : ""}`,
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text:
              proposals.length > 0
                ? `Found ${proposals.length} proposal(s):\n\n${text}`
                : "No proposals found.",
          },
        ],
      };
    },
  );

  server.tool(
    "pm_get_proposal",
    "Get full proposal details with discussion comments and linked work items. Use this to understand what a proposal is about and what has been discussed.",
    {
      proposal_id: z.string().describe("The proposal ID to retrieve"),
    },
    async ({ proposal_id }) => {
      const proposal = await getProposal(proposal_id);

      const sections: string[] = [
        `# ${proposal.title}`,
        "",
        `**ID:** ${proposal.id}`,
        `**Status:** ${proposal.status}`,
        `**Project:** ${proposal.projectId}`,
        `**Created by:** ${proposal.createdBy ?? "unknown"}`,
        `**Created:** ${proposal.createdAt}`,
        "",
      ];

      if (proposal.description) {
        sections.push("## Description", "", proposal.description, "");
      }

      if (proposal.comments.length > 0) {
        sections.push("## Discussion", "");
        for (const comment of proposal.comments) {
          sections.push(
            `### ${comment.authorId ?? "unknown"} (${comment.commentType}) - ${comment.createdAt}`,
            "",
            comment.body,
            "",
          );
        }
      }

      if (proposal.workItems) {
        const { epics, tasks } = proposal.workItems;
        if (epics.length > 0 || tasks.length > 0) {
          sections.push("## Linked Work Items", "");
          if (epics.length > 0) {
            sections.push(`**Epics:** ${epics.length}`, JSON.stringify(epics, null, 2), "");
          }
          if (tasks.length > 0) {
            sections.push(`**Tasks:** ${tasks.length}`, JSON.stringify(tasks, null, 2), "");
          }
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

  server.tool(
    "pm_discuss_proposal",
    "Add a comment to a proposal (design discussion, question, or decision). Automatically transitions open proposals to 'discussing' status on first AI comment.",
    {
      proposal_id: z.string().describe("The proposal ID to comment on"),
      body: z
        .string()
        .describe("The comment body (markdown). Your design input, questions, or suggestions."),
      comment_type: z
        .enum(["design_discussion", "question", "decision"])
        .optional()
        .describe("Type of comment (default: design_discussion)"),
    },
    async ({ proposal_id, body, comment_type }) => {
      const result = await addProposalComment(
        proposal_id,
        body,
        comment_type ?? "design_discussion",
      );

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Comment added successfully.",
              "",
              `**Comment ID:** ${result.comment.id}`,
              `**Proposal status:** ${result.proposal.status}`,
              `**Comment type:** ${result.comment.commentType}`,
              "",
              "---",
              "",
              result.comment.body,
            ].join("\n"),
          },
        ],
      };
    },
  );
}
