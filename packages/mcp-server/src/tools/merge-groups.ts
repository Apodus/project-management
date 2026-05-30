import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MERGE_INCIDENT_STATES } from "@pm/shared";
import {
  requestMergeGroup,
  getMergeGroup,
  listMergeIncidents,
  getMergeIncident,
  type MergeRequestGroupView,
  type MergeIncidentView,
} from "../api-client.js";

const resourceDesc =
  "Lock resource name (default: 'main'). Names the train lane. Use 'main' unless told otherwise.";

const INCIDENT_STATE_FILTER_VALUES = [
  ...MERGE_INCIDENT_STATES,
  "all",
] as const;

export function registerMergeGroupTools(server: McpServer): void {
  // ── pm_request_merge_group ────────────────────────────────────────────────

  server.tool(
    "pm_request_merge_group",
    "Submit N already-queued, ungrouped merge requests as ONE atomic cross-repo unit (state 'forming'). Requires >=2 members. The integrator lands-or-fails the whole group atomically — either every member lands together or none does. Subscribe to 'merge.group.landed' / 'merge.group.rejected' SSE events with the returned group id to learn the outcome. Use this for cross-repo changes (e.g. inner + outer gitlink) that must land together.",
    {
      project_id: z.string().describe("The project ID."),
      member_request_ids: z
        .array(z.string())
        .describe(
          "IDs of >=2 already-queued, ungrouped merge requests to bind into this group. Submit each member via pm_request_merge first, then group them here.",
        ),
      resource: z
        .string()
        .optional()
        .default("main")
        .describe(resourceDesc),
    },
    async ({ project_id, member_request_ids, resource }) => {
      const resolvedResource = resource ?? "main";
      const group = await requestMergeGroup(project_id, {
        resource: resolvedResource,
        memberRequestIds: member_request_ids,
      });

      const lines: string[] = [];
      lines.push(`Merge group ${group.id} created (${group.state}).`);
      lines.push("");
      lines.push(`  Project:  ${group.projectId}`);
      lines.push(`  Resource: ${group.resource}`);
      lines.push("");
      lines.push(`  Members (${group.members.length}):`);
      for (const m of group.members) {
        const ref =
          m.branch && m.commitSha
            ? `${m.branch} @ ${m.commitSha}`
            : m.branch
              ? m.branch
              : m.commitSha
                ? m.commitSha
                : "(no branch/commit recorded)";
        lines.push(`    - ${m.id}   ${ref}`);
      }
      lines.push("");
      lines.push(
        `Subscribe to SSE events for "merge.group.landed" / "merge.group.rejected"`,
      );
      lines.push(`with entityId ${group.id} to learn the outcome.`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── pm_get_merge_group ────────────────────────────────────────────────────

  server.tool(
    "pm_get_merge_group",
    "Get full detail for a merge group including its member requests and their current statuses. Use this to check whether a group has landed, been rejected, or is still forming/integrating.",
    {
      group_id: z.string().describe("The merge group ID."),
    },
    async ({ group_id }) => {
      const group = await getMergeGroup(group_id);
      const lines: string[] = [];

      const headerState = group.state.toUpperCase();
      lines.push(`Merge group ${group.id}  ${headerState}`);
      lines.push("");
      lines.push(`  Project:  ${group.projectId}`);
      lines.push(`  Resource: ${group.resource}`);
      lines.push(`  Submitted by: ${group.submittedBy}   ${group.createdAt}`);
      if (group.integratorId) {
        lines.push(`  Integrator: ${group.integratorId}`);
      }
      if (group.resolvedAt) lines.push(`  Resolved at: ${group.resolvedAt}`);
      if (group.resolutionReason) {
        lines.push(`  Resolution: ${group.resolutionReason}`);
      }
      lines.push("");
      lines.push(`  Members (${group.members.length}):`);
      for (const m of group.members) {
        const ref =
          m.branch && m.commitSha
            ? `${m.branch} @ ${m.commitSha}`
            : m.branch
              ? m.branch
              : m.commitSha
                ? m.commitSha
                : "(no branch/commit recorded)";
        const landed = m.landedSha ? ` -> ${m.landedSha}` : "";
        lines.push(`    - ${m.id}   ${m.status}   ${ref}${landed}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── pm_list_merge_incidents ───────────────────────────────────────────────

  server.tool(
    "pm_list_merge_incidents",
    "List merge incidents for a project — durable records that an inner repo's main landed but the outer gitlink was NOT updated (an orphaned inner). Optional state filter (open/auto_resolved/human_resolved/all). One line per incident.",
    {
      project_id: z.string().describe("The project ID."),
      state: z
        .enum(INCIDENT_STATE_FILTER_VALUES)
        .optional()
        .default("all")
        .describe(
          'State filter. Default "all" returns every state. Use "open" to see unresolved incidents.',
        ),
    },
    async ({ project_id, state }) => {
      const stateFilter =
        state === "all" || state === undefined ? undefined : state;

      const rows = await listMergeIncidents(project_id, { state: stateFilter });

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No merge incidents in ${project_id}.`,
            },
          ],
        };
      }

      const out: string[] = [
        `${rows.length} merge incident(s) in ${project_id}:`,
        "",
      ];
      rows.forEach((r, i) => {
        out.push(
          `  ${i + 1}. ${r.id}   ${r.state}`,
          `     ${r.innerRepo}@${r.orphanedSha} -> ${r.outerRepo}`,
          `     opened ${r.openedAt}`,
          "",
        );
      });
      return {
        content: [{ type: "text" as const, text: out.join("\n").trimEnd() }],
      };
    },
  );

  // ── pm_get_merge_incident ─────────────────────────────────────────────────

  server.tool(
    "pm_get_merge_incident",
    "Get full detail for a merge incident — the orphaned inner repo/SHA, the outer repo whose gitlink was not updated, the linked task, and the resolution (if resolved).",
    {
      incident_id: z.string().describe("The merge incident ID."),
    },
    async ({ incident_id }) => {
      const incident = await getMergeIncident(incident_id);
      const lines: string[] = [];

      const headerState = incident.state.toUpperCase();
      lines.push(`Merge incident ${incident.id}  ${headerState}`);
      lines.push("");
      lines.push(`  Project:  ${incident.projectId}`);
      lines.push(`  Type:     ${incident.type}`);
      lines.push(`  Inner:    ${incident.innerRepo} @ ${incident.orphanedSha}`);
      lines.push(`  Outer:    ${incident.outerRepo}`);
      if (incident.groupId) lines.push(`  Group:    ${incident.groupId}`);
      if (incident.taskId) lines.push(`  Task:     ${incident.taskId}`);
      lines.push(`  Opened at: ${incident.openedAt}`);
      if (incident.resolvedAt) {
        lines.push(`  Resolved at: ${incident.resolvedAt}`);
      }
      if (incident.resolution) {
        lines.push("");
        lines.push(`  Resolution (${incident.resolution.mode}):`);
        if (incident.resolution.outerLandedSha) {
          lines.push(`    Outer landed SHA: ${incident.resolution.outerLandedSha}`);
        }
        if (incident.resolution.resolvedByGroupId) {
          lines.push(
            `    Resolved by group: ${incident.resolution.resolvedByGroupId}`,
          );
        }
        if (incident.resolution.note) {
          lines.push(`    Note: ${incident.resolution.note}`);
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}

export type { MergeRequestGroupView, MergeIncidentView };
