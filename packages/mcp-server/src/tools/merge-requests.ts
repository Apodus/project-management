import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MERGE_REQUEST_STATUSES,
  type MergeRequestStatus,
} from "@pm/shared";
import {
  cancelMergeRequest,
  getMergeRequest,
  listMergeRequests,
  submitMergeRequest,
  type MergeAttemptView,
  type MergeRequestView,
  type MergeRequestDetailView,
} from "../api-client.js";

const resourceDesc =
  "Lock resource name (default: 'main'). Names the train lane. Use 'main' unless told otherwise.";

const STATUS_FILTER_VALUES = [...MERGE_REQUEST_STATUSES, "all"] as const;

export function registerMergeRequestTools(server: McpServer): void {
  // ── pm_request_merge ──────────────────────────────────────────────────────

  server.tool(
    "pm_request_merge",
    "Submit a merge request: the integrator picks it up, rebases, runs verify, and either lands it or rejects it with a structured payload. THIS IS THE RECOMMENDED WAY TO LAND CHANGES — you submit and exit; you do NOT hold a lock during verify. Subscribe to 'merge.request.landed' / 'merge.request.rejected' SSE events with the returned request id to learn the outcome. The Stage 1 pm_acquire_merge_lock tool still exists but is low-level — use this instead unless you are driving integration yourself.",
    {
      project_id: z.string().describe("The project ID."),
      resource: z
        .string()
        .optional()
        .default("main")
        .describe(resourceDesc),
      task_id: z
        .string()
        .optional()
        .describe(
          "Task this landing is for. Strongly recommended — required for the auto side-effects (landed_sha git_ref on land; merge_rejection comment on reject).",
        ),
      branch: z
        .string()
        .optional()
        .describe(
          "Branch to land (e.g. 'feat/skinning'). At least one of branch / commit_sha should be set.",
        ),
      commit_sha: z
        .string()
        .optional()
        .describe(
          "Specific commit SHA to land. Pin to a SHA when you may keep committing on the branch while queued.",
        ),
      verify_cmd: z
        .string()
        .optional()
        .describe(
          "Per-request override of the project's configured verify command.",
        ),
      worktree_path: z
        .string()
        .optional()
        .describe(
          "Per-machine path to your isolated worktree. Informational only — recorded so observability tools can correlate to your host.",
        ),
    },
    async ({
      project_id,
      resource,
      task_id,
      branch,
      commit_sha,
      verify_cmd,
      worktree_path,
    }) => {
      const resolvedResource = resource ?? "main";
      const created = await submitMergeRequest(project_id, {
        resource: resolvedResource,
        taskId: task_id,
        branch,
        commitSha: commit_sha,
        verifyCmd: verify_cmd,
        worktreePath: worktree_path,
      });

      let position: number | null = null;
      let total = 0;
      try {
        const queued = await listMergeRequests(project_id, {
          resource: resolvedResource,
          status: "queued",
        });
        total = queued.length;
        const idx = queued.findIndex((r) => r.id === created.id);
        if (idx >= 0) position = idx + 1;
      } catch {
        // Position is best-effort.
      }

      const lines: string[] = [];
      lines.push(`Merge request ${created.id} queued.`);
      lines.push("");
      lines.push(`  Project:  ${created.projectId}`);
      lines.push(`  Resource: ${created.resource}`);
      if (created.taskId) lines.push(`  Task:     ${created.taskId}`);
      if (created.branch) lines.push(`  Branch:   ${created.branch}`);
      if (created.commitSha) lines.push(`  Commit:   ${created.commitSha}`);
      lines.push("");
      if (position !== null) {
        lines.push(`  Queue position: ${position} of ${total}`);
      }
      lines.push(
        "  Status:         queued — waiting for the integrator to pick this up.",
      );
      lines.push("");
      lines.push(
        `Subscribe to SSE events for "merge.request.landed" / "merge.request.rejected"`,
      );
      lines.push(`with entityId ${created.id} to learn the outcome.`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── pm_list_merge_requests ────────────────────────────────────────────────

  server.tool(
    "pm_list_merge_requests",
    "List merge requests for a project. Optional filters: resource (lane), status (queued/integrating/landed/rejected/abandoned/all), task_id. Returns id, status, branch/commit, submitter, and queue position for queued entries.",
    {
      project_id: z.string().describe("The project ID."),
      resource: z
        .string()
        .optional()
        .describe(resourceDesc),
      status: z
        .enum(STATUS_FILTER_VALUES)
        .optional()
        .default("all")
        .describe(
          'Status filter. Default "all" returns every status. Use "queued" to see the active queue, "integrating" to see what the integrator is working on, etc.',
        ),
      task_id: z
        .string()
        .optional()
        .describe("Only return requests linked to this task id."),
    },
    async ({ project_id, resource, status, task_id }) => {
      const statusFilter: MergeRequestStatus | undefined =
        status === "all" || status === undefined
          ? undefined
          : (status as MergeRequestStatus);

      const rows = await listMergeRequests(project_id, {
        resource,
        status: statusFilter,
        taskId: task_id,
      });

      if (rows.length === 0) {
        const filterDesc = resource ? ` (${resource} lane)` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `No merge requests in ${project_id}${filterDesc}.`,
            },
          ],
        };
      }

      const queuedCounters = new Map<string, number>();
      const queuePositions = new Map<string, number>();
      for (const r of rows) {
        if (r.status === "queued") {
          const next = (queuedCounters.get(r.resource) ?? 0) + 1;
          queuedCounters.set(r.resource, next);
          queuePositions.set(r.id, next);
        }
      }

      const laneLabel = resource ? ` (${resource} lane)` : "";
      const out: string[] = [
        `${rows.length} merge request(s) in ${project_id}${laneLabel}:`,
        "",
      ];
      rows.forEach((r, i) => {
        const pos = queuePositions.get(r.id);
        const statusLabel =
          r.status === "queued" && pos !== undefined
            ? `queued (position ${pos})`
            : r.status;
        const idLine = `  ${i + 1}. ${r.id}   ${statusLabel}`;
        const refLine =
          r.branch && r.commitSha
            ? `     ${r.branch} @ ${r.commitSha}`
            : r.branch
              ? `     ${r.branch}`
              : r.commitSha
                ? `     ${r.commitSha}`
                : "     (no branch/commit recorded)";
        const byLine = `     by ${r.submittedBy}   enqueued ${r.enqueuedAt}`;
        out.push(idLine, refLine, byLine, "");
      });
      return {
        content: [{ type: "text" as const, text: out.join("\n").trimEnd() }],
      };
    },
  );

  // ── pm_get_merge_request ──────────────────────────────────────────────────

  server.tool(
    "pm_get_merge_request",
    "Get full detail for a merge request including all attempts (most-recent first). For rejected requests, the structured rejection envelope (category, reason, failed files, log URL) is surfaced prominently at the top so you can see why without scrolling.",
    {
      request_id: z.string().describe("The merge request ID."),
    },
    async ({ request_id }) => {
      const detail = await getMergeRequest(request_id);
      const lines: string[] = [];

      const headerStatus = detail.status.toUpperCase();
      lines.push(`Merge request ${detail.id}  ${headerStatus}`);
      lines.push("");
      lines.push(`  Project:  ${detail.projectId}`);
      lines.push(`  Resource: ${detail.resource}`);
      if (detail.taskId) lines.push(`  Task:     ${detail.taskId}`);
      if (detail.branch || detail.commitSha) {
        const ref = [detail.branch, detail.commitSha].filter(Boolean).join(" @ ");
        const arrow = detail.landedSha ? ` -> ${detail.landedSha} (landed)` : "";
        lines.push(`  Branch:   ${ref}${arrow}`);
      }
      if (detail.landedSha) lines.push(`  Landed SHA: ${detail.landedSha}`);
      lines.push(`  Submitted by: ${detail.submittedBy}   ${detail.enqueuedAt}`);
      if (detail.pickedUpAt) lines.push(`  Picked up at: ${detail.pickedUpAt}`);
      if (detail.resolvedAt) lines.push(`  Resolved at:  ${detail.resolvedAt}`);

      if (detail.status === "rejected") {
        lines.push("");
        lines.push(`  REJECTION (${detail.rejectCategory ?? "unknown"}):`);
        if (detail.rejectReason) {
          const firstLine = detail.rejectReason.split("\n", 1)[0] ?? "";
          lines.push(`    ${firstLine}`);
        }
        const failed = detail.failedFiles ?? [];
        if (failed.length > 0) {
          lines.push(`    Failed files:`);
          for (const f of failed.slice(0, 5)) {
            lines.push(`      - ${f}`);
          }
          if (failed.length > 5) {
            lines.push(`      ... and ${failed.length - 5} more`);
          }
        }
        if (detail.logUrl) {
          lines.push(`    Log: ${detail.logUrl}`);
        } else if (detail.logExcerpt) {
          lines.push(`    Log excerpt: (${detail.logExcerpt.length} chars — no logUrl)`);
        }
      }

      lines.push("");
      lines.push(`  Attempts (${detail.attempts.length}):`);
      if (detail.attempts.length === 0) {
        lines.push("    (none yet)");
      } else {
        for (const a of detail.attempts) {
          lines.push(...formatAttempt(a));
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  // ── pm_cancel_merge_request ───────────────────────────────────────────────

  server.tool(
    "pm_cancel_merge_request",
    "Cancel a merge request (yours or another agent's — collaborative env) from queued OR integrating. Cancelling an integrating request interrupts the in-flight integration — the integrator discovers it via a 409 on its next call — and is recorded in the audit log with an optional reason. A group member can NOT be cancelled individually → 409 GROUPED_MEMBER (reject the group instead). A request already terminal (landed/rejected) is rejected with 409 INVALID_TRANSITION; 'abandoned → abandoned' is the idempotent no-op.",
    {
      request_id: z.string().describe("The merge request ID."),
      reason: z
        .string()
        .optional()
        .describe(
          "Optional reason for the cancel. Recorded on the audit log when cancelling an integrating request.",
        ),
    },
    async ({ request_id, reason }) => {
      const updated = await cancelMergeRequest(request_id, reason);
      const lines: string[] = [];
      lines.push(`Merge request ${updated.id} ${updated.status}.`);
      lines.push("");
      lines.push(`  Status: ${updated.status}`);
      if (updated.resolvedAt) {
        lines.push(`  Resolved at: ${updated.resolvedAt}`);
      }
      lines.push("");
      lines.push("Use pm_list_merge_requests to see remaining queue.");
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatAttempt(a: MergeAttemptView): string[] {
  const parts: string[] = [];
  const head = `    #${a.attemptNumber}  ${a.status.padEnd(9)} base=${a.baseSha}`;
  const treeStr = a.treeSha ? `  tree=${a.treeSha}` : "";
  const durStr = a.verifyDurationMs ? `  duration=${formatDuration(a.verifyDurationMs)}` : "";
  const catStr = a.status === "failed" && a.failureCategory ? `  ${a.failureCategory}` : "";
  parts.push(`${head}${treeStr}${durStr}${catStr}`);
  if (a.status === "failed" && a.failureReason) {
    const firstLine = a.failureReason.split("\n", 1)[0] ?? "";
    parts.push(`        "${firstLine}"`);
  }
  return parts;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

export type {
  MergeAttemptView,
  MergeRequestView,
  MergeRequestDetailView,
};
