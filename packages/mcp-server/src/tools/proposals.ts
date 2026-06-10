import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ApiError,
  addProposalComment,
  claimProposal,
  forceClaimProposal,
  getProposal,
  listProposals,
  releaseProposal,
  releaseProposalTo,
  requestTakeoverProposal,
  transitionProposal,
} from "../api-client.js";
import {
  claimDeniedText,
  claimResultText,
  claimStateLabel,
  claimStatusLabel,
  forceClaimResultText,
  releaseToResultText,
  requestTakeoverResultText,
} from "./claim-display.js";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerProposalTools(server: McpServer): void {
  server.tool(
    "pm_list_proposals",
    "List proposals with optional project, status, and claim filters. Each proposal shows its claim_status relative to you (available to claim, claimed for you, claimed by another agent). Pass claim='available' to see only proposals you can safely work on.",
    {
      project_id: z.string().optional().describe("Filter by project ID"),
      status: z
        .enum(["open", "discussing", "accepted", "in_progress", "completed", "rejected"])
        .optional()
        .describe("Filter by proposal status"),
      claim: z
        .enum(["available", "mine", "all"])
        .optional()
        .describe(
          "Filter by claim ownership relative to you: 'available' = unclaimed OR claimed by you (safe to work on); 'mine' = only proposals you've claimed; 'all' = no claim restriction (default).",
        ),
    },
    async ({ project_id, status, claim }) => {
      const proposals = await listProposals(project_id, status, claim);

      const text = proposals
        .map((p) => {
          const claimLine = `  Claim: ${claimStateLabel(p.claimState) || claimStatusLabel(p.claimStatus)}`;
          const descLine = p.description
            ? p.description.slice(0, 200)
            : "(no description)";
          return [
            `- **${p.title}**`,
            `  ID: ${p.id}`,
            `  Status: ${p.status}`,
            `  Project: ${p.projectId}`,
            claimLine,
            `  ${descLine}`,
          ].join("\n");
        })
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
    "Get full proposal details with discussion comments and linked work items. Includes claim_status (whether the proposal is available to claim, claimed for you, or claimed by another agent).",
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
        `**Claim:** ${claimStateLabel(proposal.claimState) || claimStatusLabel(proposal.claimStatus)}`,
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
    "pm_claim_proposal",
    "Claim a proposal so other agents know it's being worked on. You must claim before commenting, transitioning, or implementing. The server tells you the outcome — it never reveals other claimants' identities.",
    {
      proposal_id: z.string().describe("The proposal ID to claim"),
    },
    async ({ proposal_id }) => {
      const result = await claimProposal(proposal_id);
      return {
        content: [
          {
            type: "text" as const,
            text: claimResultText(result, "claim", "proposal"),
          },
        ],
      };
    },
  );

  server.tool(
    "pm_force_claim_proposal",
    "Take over an existing claim (reason required, audited). Self-recovery when your session identity changed.",
    {
      proposal_id: z.string(),
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
    async ({ proposal_id, reason, assignee_id }) => {
      const result = await forceClaimProposal(proposal_id, reason, assignee_id);
      return {
        content: [
          {
            type: "text" as const,
            text: forceClaimResultText(result, "proposal"),
          },
        ],
      };
    },
  );

  server.tool(
    "pm_release_proposal",
    "Release your claim on a proposal so other agents can pick it up. Use this if you're abandoning the work or handing off.",
    {
      proposal_id: z.string().describe("The proposal ID to release"),
    },
    async ({ proposal_id }) => {
      const result = await releaseProposal(proposal_id);
      return {
        content: [
          {
            type: "text" as const,
            text: claimResultText(result, "release", "proposal"),
          },
        ],
      };
    },
  );

  server.tool(
    "pm_release_proposal_to",
    "Hand off your proposal claim to a named worker (reason required, audited). You must currently hold the claim (a human director may hand off any claim). The claim and its liveness lease transfer to the target.",
    {
      proposal_id: z.string().describe("The proposal ID to hand off"),
      reason: z
        .string()
        .describe("Why you are handing off (required, recorded in the audit log)"),
      target: z
        .string()
        .describe("The user id of the worker to hand the claim to"),
    },
    async ({ proposal_id, reason, target }) => {
      const result = await releaseProposalTo(proposal_id, reason, target);
      return {
        content: [
          {
            type: "text" as const,
            text: releaseToResultText(result, "proposal"),
          },
        ],
      };
    },
  );

  server.tool(
    "pm_request_takeover_proposal",
    "Request to take over a proposal's claim (stomp-safe). If the current claim is stale (the holder's liveness lease lapsed) it is auto-granted to you; if it is LIVE (actively held) nothing changes — the holder is notified and you should pick a different proposal or wait.",
    {
      proposal_id: z
        .string()
        .describe("The proposal ID to request takeover of"),
      reason: z
        .string()
        .describe(
          "Why you want to take over (required, recorded in the audit log on a stale grant)",
        ),
    },
    async ({ proposal_id, reason }) => {
      const result = await requestTakeoverProposal(proposal_id, reason);
      return {
        content: [
          {
            type: "text" as const,
            text: requestTakeoverResultText(result, "proposal"),
          },
        ],
      };
    },
  );

  server.tool(
    "pm_discuss_proposal",
    "Add a comment to a proposal (design discussion, question, or decision). You must hold the claim first (call pm_claim_proposal). Automatically transitions open proposals to 'discussing' on first comment.",
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
      try {
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
      } catch (err) {
        if (err instanceof ApiError && err.code === "CLAIM_DENIED") {
          return {
            content: [{ type: "text" as const, text: claimDeniedText("proposal", "pm_claim_proposal") }],
          };
        }
        throw err;
      }
    },
  );

  server.tool(
    "pm_transition_proposal",
    "Change a proposal's status. You must hold the claim first (call pm_claim_proposal). The server enforces the valid lifecycle (open → discussing → accepted → in_progress → completed) and your role. The main use is completing a proposal once its work is done: transition 'in_progress' → 'completed'. Note that a proposal also auto-completes on its own once all of its linked epics complete — call this only when you need to flip it manually (e.g. work was tracked outside epics, or you want to close it early).",
    {
      proposal_id: z.string().describe("The proposal ID to transition"),
      to_status: z
        .enum(["open", "discussing", "accepted", "in_progress", "completed", "rejected"])
        .describe("The target status. Must be a legal transition from the current status."),
    },
    async ({ proposal_id, to_status }) => {
      try {
        const proposal = await transitionProposal(proposal_id, to_status);
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Proposal transitioned successfully.",
                "",
                `**Proposal ID:** ${proposal.id}`,
                `**Status:** ${proposal.status}`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        if (err instanceof ApiError && err.code === "CLAIM_DENIED") {
          return {
            content: [{ type: "text" as const, text: claimDeniedText("proposal", "pm_claim_proposal") }],
          };
        }
        throw err;
      }
    },
  );
}
