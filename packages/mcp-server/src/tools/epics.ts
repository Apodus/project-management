import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  claimEpic,
  forceClaimEpic,
  getEpic,
  getEpicGraph,
  listEpics,
  releaseEpic,
  releaseEpicTo,
  requestTakeoverEpic,
} from "../api-client.js";
import {
  claimResultText,
  claimStateLabel,
  claimStatusLabel,
  forceClaimResultText,
  releaseToResultText,
  requestTakeoverResultText,
} from "./claim-display.js";

// Render caps for pm_get_epic_graph — the count header always carries the FULL
// totals, so truncation is never silent.
const EPIC_GRAPH_NODE_CAP = 200;
const EPIC_GRAPH_EDGE_CAP = 400;

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
    "Get full epic details with task summary. Includes claim_status (whether the epic is available to claim, claimed for you, or claimed by another agent). For dependency topology, use pm_get_epic_graph.",
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

  // ---- pm_get_epic_graph ----

  server.tool(
    "pm_get_epic_graph",
    "Read the epic dependency graph for a project: every epic (id, name, status, health, claim liveness, task progress) plus all dependency edges (prerequisite -> dependent) and any detected cycles. Call this BEFORE pm_link_epic_dependency to see existing topology and avoid duplicate or cyclic edges.",
    {
      project_id: z.string().describe("The project ID to read the epic graph for"),
    },
    async ({ project_id }) => {
      const graph = await getEpicGraph(project_id);
      const nodeCount = graph.nodes.length;
      const edgeCount = graph.edges.length;

      const header = `Epic graph for project ${project_id}: ${nodeCount} epic(s), ${edgeCount} edge(s).`;

      if (nodeCount === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${header} No epics yet.`,
            },
          ],
        };
      }

      const lines: string[] = [header];
      if (graph.hasCycle) {
        lines.push("⚠ CYCLE DETECTED — see Cycles section before adding edges.");
      }

      const shownNodes = graph.nodes.slice(0, EPIC_GRAPH_NODE_CAP);
      lines.push("", "Epics (id | name | status | health | claim | tasks):");
      for (const n of shownNodes) {
        const category = n.category ? ` [${n.category}]` : "";
        lines.push(
          `- ${n.id}  "${n.name}"${category} — ${n.status} | ${n.health} | ${claimStateLabel(n.claimState)} | tasks ${n.taskSummary.done}/${n.taskSummary.total}`,
        );
      }

      const shownEdges = graph.edges.slice(0, EPIC_GRAPH_EDGE_CAP);
      if (edgeCount > 0) {
        lines.push("", "Edges (prerequisite -> dependent):");
        for (const e of shownEdges) {
          lines.push(`- ${e.from} -> ${e.to}  (${e.dependency_type}, ${e.provenance})`);
        }
      }

      // The service omits `cycles` when empty — guard with `?? []`.
      const cycles = graph.cycles ?? [];
      if (graph.hasCycle && cycles.length > 0) {
        lines.push("", "Cycles:");
        for (const cycle of cycles) {
          const closed = cycle.length > 0 ? [...cycle, cycle[0]] : cycle;
          lines.push(`- ${closed.join(" -> ")}`);
        }
      }

      if (nodeCount > EPIC_GRAPH_NODE_CAP || edgeCount > EPIC_GRAPH_EDGE_CAP) {
        lines.push(
          "",
          `⚠ Truncated: showing ${shownNodes.length} of ${nodeCount} epics, ${shownEdges.length} of ${edgeCount} edges.`,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: lines.join("\n"),
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

  // ---- pm_release_epic_to ----

  server.tool(
    "pm_release_epic_to",
    "Hand off your epic claim to a named worker (reason required, audited). You must currently hold the claim (a human director may hand off any claim). The claim and its liveness lease transfer to the target.",
    {
      epic_id: z.string().describe("The epic ID to hand off"),
      reason: z
        .string()
        .describe("Why you are handing off (required, recorded in the audit log)"),
      target: z
        .string()
        .describe("The user id of the worker to hand the claim to"),
    },
    async ({ epic_id, reason, target }) => {
      const result = await releaseEpicTo(epic_id, reason, target);
      return {
        content: [
          {
            type: "text" as const,
            text: releaseToResultText(result, "epic"),
          },
        ],
      };
    },
  );

  // ---- pm_request_takeover_epic ----

  server.tool(
    "pm_request_takeover_epic",
    "Request to take over an epic's claim (stomp-safe). If the current claim is stale (the holder's liveness lease lapsed) it is auto-granted to you; if it is LIVE (actively held) nothing changes — the holder is notified and you should pick a different epic or wait.",
    {
      epic_id: z.string().describe("The epic ID to request takeover of"),
      reason: z
        .string()
        .describe(
          "Why you want to take over (required, recorded in the audit log on a stale grant)",
        ),
    },
    async ({ epic_id, reason }) => {
      const result = await requestTakeoverEpic(epic_id, reason);
      return {
        content: [
          {
            type: "text" as const,
            text: requestTakeoverResultText(result, "epic"),
          },
        ],
      };
    },
  );
}
