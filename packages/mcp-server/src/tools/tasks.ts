import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  awareness,
  claimTask,
  forceClaimTask,
  getTask,
  listTasks,
  releaseTask,
  releaseTaskTo,
  requestTakeoverTask,
} from "../api-client.js";
import {
  claimResultText,
  claimStateLabel,
  forceClaimResultText,
  releaseToResultText,
  requestTakeoverResultText,
} from "./claim-display.js";

export function registerTaskTools(server: McpServer): void {
  server.tool(
    "pm_list_tasks",
    "List tasks with rich filtering. Returns array of task summaries with id, title, status, priority, type, assignee.",
    {
      project_id: z.string().optional().describe("Filter by project ID"),
      epic_id: z.string().optional().describe("Filter by epic ID"),
      status: z
        .string()
        .optional()
        .describe("Filter by status (e.g. 'backlog', 'ready', 'in_progress', 'done')"),
      priority: z
        .string()
        .optional()
        .describe("Filter by priority ('critical', 'high', 'medium', 'low')"),
      assignee: z.string().optional().describe("Filter by assignee user ID, or 'unassigned'"),
      type: z
        .string()
        .optional()
        .describe("Filter by type ('feature', 'bug', 'chore', 'spike', 'design', 'research')"),
      is_blocked: z.boolean().optional().describe("Filter to only blocked or unblocked tasks"),
      search: z.string().optional().describe("Text search within task titles/descriptions"),
      label_name: z
        .string()
        .optional()
        .describe(
          "Filter to tasks tagged with this label (by name, scoped to the project). Use this as the subsystem/area filter when you don't know label IDs. Call pm_list_labels to discover valid names — an unknown name returns empty results, not an error.",
        ),
      claim: z
        .enum(["available", "mine", "all"])
        .optional()
        .describe(
          "Filter by claim ownership relative to you: 'available' = unclaimed OR claimed by you (safe to work on); 'mine' = only tasks you've claimed; 'all' = no claim restriction (default).",
        ),
      sort: z
        .enum(["priority", "created_at", "updated_at", "due_date"])
        .optional()
        .describe("Sort order"),
      limit: z.number().optional().describe("Maximum number of tasks to return (default 50)"),
    },
    async (params) => {
      const tasks = await listTasks({
        project_id: params.project_id,
        epic_id: params.epic_id,
        status: params.status,
        priority: params.priority,
        assignee: params.assignee,
        type: params.type,
        is_blocked: params.is_blocked,
        search: params.search,
        label_name: params.label_name,
        claim: params.claim,
        sort: params.sort,
        limit: params.limit,
      });

      const text = tasks
        .map((t) => {
          const assignee = t.assigneeName ?? t.assigneeId;
          const epic = t.epicName ?? t.epicId;
          const claim = claimStateLabel(t.claimState);
          return `- [${t.priority.toUpperCase()}] **${t.title}**\n  ID: ${t.id}\n  Status: ${t.status} | Type: ${t.type}${assignee ? ` | Assignee: ${assignee}` : ""}${epic ? ` | Epic: ${epic}` : ""}${claim ? ` | Claim: ${claim}` : ""}`;
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text:
              tasks.length > 0
                ? `Found ${tasks.length} task(s):\n\n${text}`
                : "No tasks found matching the given filters.",
          },
        ],
      };
    },
  );

  server.tool(
    "pm_get_task",
    "Get full task details including description, context, comments, dependencies, and subtasks. Use this before starting work on a task.",
    {
      task_id: z.string().describe("The task ID to retrieve"),
    },
    async ({ task_id }) => {
      const task = await getTask(task_id);

      const sections: string[] = [
        `# ${task.title}`,
        "",
        `**ID:** ${task.id}`,
        `**Status:** ${task.status}`,
        `**Priority:** ${task.priority}`,
        `**Type:** ${task.type}`,
        `**Project:** ${task.projectName ?? task.projectId}`,
      ];

      if (task.epicId) {
        sections.push(`**Epic:** ${task.epicName ?? task.epicId}`);
      }
      if (task.assigneeId) {
        sections.push(`**Assignee:** ${task.assigneeName ?? task.assigneeId}`);
      }
      const taskClaim = claimStateLabel(task.claimState);
      if (taskClaim) {
        sections.push(`**Claim:** ${taskClaim}`);
      }
      if (task.estimatedEffort) sections.push(`**Estimated Effort:** ${task.estimatedEffort}`);
      if (task.dueDate) sections.push(`**Due Date:** ${task.dueDate}`);
      if (task.parentTaskId) {
        sections.push(`**Parent Task:** ${task.parentTaskTitle ?? task.parentTaskId}`);
      }

      sections.push("");

      if (task.description) {
        sections.push("## Description", "", task.description, "");
      }

      if (task.context && typeof task.context === "object") {
        const ctx = task.context as Record<string, unknown>;
        if (Object.keys(ctx).length > 0) {
          sections.push("## Context", "", JSON.stringify(ctx, null, 2), "");
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

  // ---- pm_claim_task ----

  server.tool(
    "pm_claim_task",
    "Claim a task so other agents know it's being worked on. Sets you as the assignee. AI agents must hold the claim to update or transition a task — call this first when picking a specific task by ID. (For 'pick something to work on', prefer pm_pick_next_task which combines claim + start atomically.)",
    {
      task_id: z.string().describe("The task ID to claim"),
    },
    async ({ task_id }) => {
      const result = await claimTask(task_id);
      return {
        content: [
          {
            type: "text" as const,
            text: claimResultText(result, "claim", "task"),
          },
        ],
      };
    },
  );

  // ---- pm_force_claim_task ----

  server.tool(
    "pm_force_claim_task",
    "Take over an existing claim (reason required, audited). Self-recovery when your session identity changed.",
    {
      task_id: z.string(),
      reason: z
        .string()
        .describe("Why you are taking over this claim (required, recorded in the audit log)"),
      assignee_id: z
        .string()
        .optional()
        .describe(
          "Target user id — only a human director may target another agent; omit to claim for yourself",
        ),
    },
    async ({ task_id, reason, assignee_id }) => {
      const result = await forceClaimTask(task_id, reason, assignee_id);
      return {
        content: [
          {
            type: "text" as const,
            text: forceClaimResultText(result, "task"),
          },
        ],
      };
    },
  );

  // ---- pm_release_task ----

  server.tool(
    "pm_release_task",
    "Release your claim on a task so other agents can pick it up. Use when handing off or stepping away.",
    {
      task_id: z.string().describe("The task ID to release"),
    },
    async ({ task_id }) => {
      const result = await releaseTask(task_id);
      return {
        content: [
          {
            type: "text" as const,
            text: claimResultText(result, "release", "task"),
          },
        ],
      };
    },
  );

  // ---- pm_release_task_to ----

  server.tool(
    "pm_release_task_to",
    "Hand off your task claim to a named worker (reason required, audited). You must currently hold the claim (a human director may hand off any claim). The claim and its liveness lease transfer to the target.",
    {
      task_id: z.string().describe("The task ID to hand off"),
      reason: z.string().describe("Why you are handing off (required, recorded in the audit log)"),
      target: z.string().describe("The user id of the worker to hand the claim to"),
    },
    async ({ task_id, reason, target }) => {
      const result = await releaseTaskTo(task_id, reason, target);
      return {
        content: [
          {
            type: "text" as const,
            text: releaseToResultText(result, "task"),
          },
        ],
      };
    },
  );

  // ---- pm_request_takeover_task ----

  server.tool(
    "pm_request_takeover_task",
    "Request to take over a task's claim (stomp-safe). If the current claim is stale (the holder's liveness lease lapsed) it is auto-granted to you; if it is LIVE (actively held) nothing changes — the holder is notified and you should pick a different task or wait.",
    {
      task_id: z.string().describe("The task ID to request takeover of"),
      reason: z
        .string()
        .describe(
          "Why you want to take over (required, recorded in the audit log on a stale grant)",
        ),
    },
    async ({ task_id, reason }) => {
      const result = await requestTakeoverTask(task_id, reason);
      return {
        content: [
          {
            type: "text" as const,
            text: requestTakeoverResultText(result, "task"),
          },
        ],
      };
    },
  );

  // ---- pm_awareness_check ----

  server.tool(
    "pm_awareness_check",
    "Before starting work in a subsystem, query who else (if anyone) is currently in flight there. Returns in-progress tasks for the project, optionally narrowed to a label (the subsystem/area tag). The right call at the boundary of starting work — and again before entering a new area mid-task.",
    {
      project_id: z.string().describe("The project ID."),
      label: z
        .string()
        .optional()
        .describe(
          "Optional label name (subsystem/area). If omitted, returns all in-flight tasks in the project. Call pm_list_labels to discover valid names — an unknown name returns empty results, not an error.",
        ),
    },
    async ({ project_id, label }) => {
      const data = await awareness(project_id, label);
      if (data.total === 0) {
        const where = label ? `in \`${label}\`` : "in this project";
        return {
          content: [
            {
              type: "text" as const,
              text: `Clear — no one is in flight ${where}.`,
            },
          ],
        };
      }
      const lines = data.inFlight.map((t) => {
        const who = t.assignee?.name ?? t.assignee?.id ?? "unassigned";
        const branch = t.gitBranch ? ` on \`${t.gitBranch}\`` : "";
        const claim = claimStateLabel(t.claimState);
        const liveness = claim ? ` — ${claim}` : "";
        return `- ${who}${branch} — "${t.title}" (task ${t.taskId})${liveness}`;
      });
      const header = label
        ? `${data.total} agent(s) in flight in \`${label}\`:`
        : `${data.total} agent(s) in flight in this project:`;
      return {
        content: [
          {
            type: "text" as const,
            text: `${header}\n${lines.join("\n")}`,
          },
        ],
      };
    },
  );
}
