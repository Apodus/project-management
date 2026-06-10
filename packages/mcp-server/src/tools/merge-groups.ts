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

const INCIDENT_STATE_FILTER_VALUES = [...MERGE_INCIDENT_STATES, "all"] as const;

/**
 * Render a member's landable ref for the group views. A SYNTHETIC member
 * (inner-only groups) has no branch/commit by design — the integrator
 * synthesizes the outer candidate at integration time. `synthetic` is
 * optional so pre-campaign responses without the field still render.
 */
function memberRef(m: {
  branch: string | null;
  commitSha: string | null;
  synthetic?: boolean;
}): string {
  if (m.synthetic === true) {
    return "(synthetic gitlink bump — outer candidate synthesized at integration)";
  }
  return m.branch && m.commitSha
    ? `${m.branch} @ ${m.commitSha}`
    : m.branch
      ? m.branch
      : m.commitSha
        ? m.commitSha
        : "(no branch/commit recorded)";
}

export function registerMergeGroupTools(server: McpServer): void {
  // ── pm_request_merge_group ────────────────────────────────────────────────

  server.tool(
    "pm_request_merge_group",
    "Submit merge requests as ONE atomic cross-repo unit (state 'forming'). The integrator lands-or-fails the whole group atomically — either every member lands together or none does. THREE forms (provide EXACTLY ONE of members / member_request_ids): (1) INNER-ONLY — RECOMMENDED for any change that lives entirely in the inner repo: members with EXACTLY ONE spec (your inner change: {branch and/or commit_sha, optional verify_cmd, task_id}) plus synthesize_outer: true. PM records your inner member plus a SYNTHETIC outer member (no branch/commit); the integrator synthesizes the outer gitlink-bump candidate against LIVE outer main at integration time and fills its landedSha at land. WHY: a hand-minted outer gitlink-bump branch goes stale the moment ANY other gitlink change lands on outer main — the rebase hits both-sides-modified on the gitlink and the whole group is rejected (outer_conflict). With synthesize_outer there is no bump branch to go stale, so that rejection class cannot happen. Do NOT mint gitlink-bump-only outer branches. Prerequisite: the project declares exactly one inner and one outer repo in settings.integrator.linked_repos (otherwise 400). (2) MULTI-MEMBER atomic form: >=2 member specs submitted AND grouped in one call, so members are born group-bound and a single-repo pickup can never grab one mid-grouping. Use this ONLY when the outer member carries REAL outer-repo content changes (not just a gitlink bump), or when a repo is not declared in linked_repos. If your outer member would be nothing but a gitlink bump, use form (1) instead. (3) member_request_ids — LEGACY two-step form: bind >=2 already-queued, ungrouped requests you submitted earlier via pm_request_merge. Subscribe to 'merge.group.landed' / 'merge.group.rejected' SSE events with the returned group id to learn the outcome.",
    {
      project_id: z.string().describe("The project ID."),
      members: z
        .array(
          z.object({
            branch: z
              .string()
              .optional()
              .describe("Branch to land. At least one of branch / commit_sha."),
            commit_sha: z.string().optional().describe("Specific commit SHA to land."),
            verify_cmd: z
              .string()
              .optional()
              .describe("Per-member override of the project verify command."),
            task_id: z
              .string()
              .optional()
              .describe("Task this member's landing is for (recommended)."),
          }),
        )
        .min(1)
        .optional()
        .describe(
          "ATOMIC form (race-free): member specs submitted AND grouped in one call. >=2 specs, OR exactly 1 spec with synthesize_outer: true (inner-only form). Provide EITHER this OR member_request_ids, not both.",
        ),
      synthesize_outer: z
        .boolean()
        .optional()
        .describe(
          "Inner-only cross-repo form: pass true with members containing EXACTLY ONE spec (your inner-repo change). PM records a synthetic outer member and the integrator synthesizes the outer gitlink-bump candidate against live outer main at integration — never mint a gitlink-bump branch yourself. Strictly true: false behaves like absent. Requires the project to declare exactly one inner and one outer repo in settings.integrator.linked_repos. Cannot be combined with member_request_ids.",
        ),
      member_request_ids: z
        .array(z.string())
        .min(2)
        .optional()
        .describe(
          "LEGACY form: IDs of >=2 already-queued, ungrouped merge requests to bind into this group (submit each via pm_request_merge first). Provide EITHER this OR members, not both. Cannot be combined with synthesize_outer.",
        ),
      resource: z.string().optional().default("main").describe(resourceDesc),
    },
    async ({ project_id, members, synthesize_outer, member_request_ids, resource }) => {
      const resolvedResource = resource ?? "main";
      const group = await requestMergeGroup(project_id, {
        resource: resolvedResource,
        // Inner-only flag: forwarded whenever the caller set it — EVEN with the
        // ids arm (deliberate: the server's 400 matrix owns the combination
        // rules and rejects legibly; never silently drop). Key ABSENT when the
        // caller omitted it, so legacy calls stay byte-identical on the wire.
        ...(synthesize_outer !== undefined ? { synthesizeOuter: synthesize_outer } : {}),
        // Dispatch: atomic members form (>=2 specs, or exactly 1 with
        // synthesize_outer) maps snake_case → camelCase wire; else the legacy
        // ids form. The server enforces exactly-one-of.
        ...(members !== undefined
          ? {
              members: members.map((m) => ({
                branch: m.branch,
                commitSha: m.commit_sha,
                verifyCmd: m.verify_cmd,
                taskId: m.task_id,
              })),
            }
          : { memberRequestIds: member_request_ids }),
      });

      const lines: string[] = [];
      lines.push(`Merge group ${group.id} created (${group.state}).`);
      lines.push("");
      lines.push(`  Project:  ${group.projectId}`);
      lines.push(`  Resource: ${group.resource}`);
      lines.push("");
      lines.push(`  Members (${group.members.length}):`);
      for (const m of group.members) {
        lines.push(`    - ${m.id}   ${memberRef(m)}`);
      }
      if (group.members.some((m) => m.synthetic === true)) {
        lines.push("");
        lines.push("  The outer member is SYNTHETIC: the integrator builds the outer gitlink-bump");
        lines.push("  candidate against live outer main at integration and fills its landedSha at");
        lines.push(
          "  land. No outer bump branch exists, so it can never go stale (no outer_conflict).",
        );
      }
      lines.push("");
      lines.push(`Subscribe to SSE events for "merge.group.landed" / "merge.group.rejected"`);
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
        const landed = m.landedSha ? ` -> ${m.landedSha}` : "";
        lines.push(`    - ${m.id}   ${m.status}   ${memberRef(m)}${landed}`);
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
      const stateFilter = state === "all" || state === undefined ? undefined : state;

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

      const out: string[] = [`${rows.length} merge incident(s) in ${project_id}:`, ""];
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
          lines.push(`    Resolved by group: ${incident.resolution.resolvedByGroupId}`);
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
