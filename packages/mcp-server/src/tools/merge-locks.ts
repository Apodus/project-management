import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  acquireMergeLock,
  getMergeLock,
  heartbeatMergeLock,
  listMergeLocks,
  releaseMergeLock,
} from "../api-client.js";

const resourceDesc =
  "Lock resource name (default: 'main'). Lets a project carry more than one lock stream if needed (e.g. 'release-branch'). Use 'main' unless told otherwise.";

export function registerMergeLockTools(server: McpServer): void {
  // ---- pm_acquire_merge_lock ----

  server.tool(
    "pm_acquire_merge_lock",
    "Low-level / advanced. Most callers should use pm_request_merge instead (Stage 2 — submit and exit, integrator drives rebase + verify + land). This tool acquires the merge lock for a project so the caller can drive integration itself. If free, you become the holder and may proceed with rebase + verify + land. If held, you join a FIFO queue and should wait for 'merge.lock.granted' (over SSE) before acting. The lock has a 5-minute TTL — keep it warm with pm_heartbeat_merge_lock during long verifies. Idempotent for the current holder: re-calling with new intent fields updates them. Optionally attach landing intent (task_id / branch / commit_sha / verify_cmd / worktree_path) so observers and Stage 2 integrators know what you're trying to land.",
    {
      project_id: z.string().describe("The project ID."),
      resource: z.string().optional().default("main").describe(resourceDesc),
      task_id: z
        .string()
        .optional()
        .describe(
          "Optional task this landing is for. If set, observers can correlate the lock with your task context (branch, codebase areas, etc.).",
        ),
      branch: z
        .string()
        .optional()
        .describe(
          "Optional branch you're landing (e.g. 'feat/skinning'). Even when a task_id is set, branch is the load-bearing piece of identity for the train.",
        ),
      commit_sha: z
        .string()
        .optional()
        .describe(
          "Optional specific commit SHA to land. Pin to a SHA instead of branch HEAD when you may keep committing while queued.",
        ),
      verify_cmd: z
        .string()
        .optional()
        .describe(
          "Optional verify command (e.g. 'cargo test --workspace'). Captured now so the Stage 2 integrator can consume it without a schema change.",
        ),
      worktree_path: z
        .string()
        .optional()
        .describe(
          "Optional path to your isolated worktree (single-machine deployments where agents share a host). Used by integrators / for diagnostics; ignored on multi-machine setups.",
        ),
    },
    async ({ project_id, resource, task_id, branch, commit_sha, verify_cmd, worktree_path }) => {
      const result = await acquireMergeLock(project_id, resource ?? "main", {
        taskId: task_id,
        branch,
        commitSha: commit_sha,
        verifyCmd: verify_cmd,
        worktreePath: worktree_path,
      });
      const lines: string[] = [];
      if (result.status === "held") {
        lines.push(`Acquired ${resource ?? "main"} — you are the holder.`);
        if (result.expiresAt) lines.push(`Lease expires at ${result.expiresAt}.`);
        lines.push(
          "Now: rebase onto live main, run verify, land, then call pm_release_merge_lock (pass landed_sha if you advanced main, or reason if you abandon).",
        );
      } else if (result.status === "already_held") {
        lines.push("You already hold this lock.");
        if (result.expiresAt) lines.push(`Lease expires at ${result.expiresAt}.`);
      } else {
        lines.push(
          `Queued behind ${result.position ?? "?"} other holder(s) on ${resource ?? "main"}.`,
        );
        lines.push(
          "Wait for the merge.lock.granted SSE event (or poll pm_get_merge_lock) before acting.",
        );
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ---- pm_heartbeat_merge_lock ----

  server.tool(
    "pm_heartbeat_merge_lock",
    "Refresh your merge-lock lease. Call periodically during long-running verify steps so the lock isn't swept while you're still working. Returns 'not_holder' if the lease already lapsed and someone else was promoted — at that point, abort and call pm_acquire_merge_lock to rejoin the queue.",
    {
      project_id: z.string().describe("The project ID."),
      resource: z.string().optional().default("main").describe(resourceDesc),
    },
    async ({ project_id, resource }) => {
      const result = await heartbeatMergeLock(project_id, resource ?? "main");
      const text =
        result.status === "refreshed"
          ? `Lease refreshed${result.expiresAt ? ` — expires at ${result.expiresAt}` : ""}.`
          : "You no longer hold this lock — it was swept or granted to someone else. Re-acquire to rejoin the queue.";
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ---- pm_release_merge_lock ----

  server.tool(
    "pm_release_merge_lock",
    "Low-level / advanced — pairs with pm_acquire_merge_lock. Stage 2 callers using pm_request_merge do NOT call this. Release the merge lock. Two distinct uses: (1) landed — pass landed_sha to advance main and notify peers via the merge.lock.released event; (2) abandoned — omit landed_sha and pass reason explaining why (conflict, build red, etc.). The reason is stored on the lock so the next queued holder sees why main hasn't moved, and is carried on the release event. The queue head is promoted in both cases.",
    {
      project_id: z.string().describe("The project ID."),
      resource: z.string().optional().default("main").describe(resourceDesc),
      landed_sha: z
        .string()
        .optional()
        .describe(
          "Optional: the SHA you just landed on main. Becomes the 'main moved' announcement on the released event so other agents know to rebase.",
        ),
      reason: z
        .string()
        .optional()
        .describe(
          "Optional: why you're abandoning without landing. Use when landed_sha is omitted — e.g. 'conflict in skinned_renderer.cpp', 'verify failed: 3 tests red'. Ignored when landed_sha is set (a successful land has no failure reason).",
        ),
    },
    async ({ project_id, resource, landed_sha, reason }) => {
      const result = await releaseMergeLock(project_id, resource ?? "main", {
        landedSha: landed_sha,
        reason,
      });
      const lines: string[] = [];
      if (result.status === "released") {
        if (landed_sha) {
          lines.push(`Released ${resource ?? "main"} at ${landed_sha}.`);
        } else if (reason) {
          lines.push(`Abandoned ${resource ?? "main"}: ${reason}`);
        } else {
          lines.push(`Released ${resource ?? "main"} without landing.`);
        }
        if (result.grantedTo) {
          lines.push("The next queued agent has been notified.");
        }
      } else if (result.status === "not_held") {
        lines.push("Nothing to release — the lock was already free.");
      } else {
        lines.push("You don't hold this lock; nothing released.");
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ---- pm_get_merge_lock ----

  server.tool(
    "pm_get_merge_lock",
    "Inspect a merge lock. Reports who holds it relative to you ('you' / 'someone_else' / 'none'), queue length, your position if queued, lease expiry, and the last landed SHA. Other holders' identities are not leaked.",
    {
      project_id: z.string().describe("The project ID."),
      resource: z.string().optional().default("main").describe(resourceDesc),
    },
    async ({ project_id, resource }) => {
      const view = await getMergeLock(project_id, resource ?? "main");
      const lines: string[] = [
        `Resource: ${view.resource}`,
        `Holder: ${view.holder}`,
        `Queue length: ${view.queueLength}`,
      ];
      if (view.yourPosition !== null) {
        lines.push(`Your position in queue: ${view.yourPosition}`);
      }
      if (view.expiresAt) lines.push(`Lease expires: ${view.expiresAt}`);
      // Landing intent — what the holder is trying to land. Available
      // to every observer; useful for "who's about to land what."
      if (view.branch) lines.push(`Branch: ${view.branch}`);
      if (view.commitSha) lines.push(`Commit: ${view.commitSha}`);
      if (view.taskId) lines.push(`Task: ${view.taskId}`);
      if (view.verifyCmd) lines.push(`Verify cmd: ${view.verifyCmd}`);
      if (view.worktreePath) lines.push(`Worktree: ${view.worktreePath}`);
      if (view.abandonReason) {
        lines.push(`Last abandon: ${view.abandonReason}`);
      }
      if (view.landedSha) {
        lines.push(`Last landed: ${view.landedSha} at ${view.landedAt ?? "?"}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ---- pm_list_merge_locks ----

  server.tool(
    "pm_list_merge_locks",
    "List all merge locks for a project (one per resource name). Useful when a project has more than one lock stream.",
    { project_id: z.string().describe("The project ID.") },
    async ({ project_id }) => {
      const list = await listMergeLocks(project_id);
      if (list.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No merge locks yet." }],
        };
      }
      const text = list
        .map(
          (l) =>
            `- **${l.resource}** — holder: ${l.holder}, queue: ${l.queueLength}${
              l.yourPosition !== null ? ` (you @ ${l.yourPosition})` : ""
            }${l.branch ? `, branch ${l.branch}` : ""}${
              l.landedSha ? `, last landed ${l.landedSha}` : ""
            }${l.abandonReason ? `, last abandoned: ${l.abandonReason}` : ""}`,
        )
        .join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );
}
