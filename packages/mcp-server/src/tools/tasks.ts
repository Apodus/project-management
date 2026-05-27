import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listTasks, getTask } from "../api-client.js";

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
      assignee: z
        .string()
        .optional()
        .describe("Filter by assignee user ID, or 'unassigned'"),
      type: z
        .string()
        .optional()
        .describe("Filter by type ('feature', 'bug', 'chore', 'spike', 'design', 'research')"),
      is_blocked: z.boolean().optional().describe("Filter to only blocked or unblocked tasks"),
      search: z.string().optional().describe("Text search within task titles/descriptions"),
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
        sort: params.sort,
        limit: params.limit,
      });

      const text = tasks
        .map(
          (t) =>
            `- [${t.priority.toUpperCase()}] **${t.title}**\n  ID: ${t.id}\n  Status: ${t.status} | Type: ${t.type}${t.assignee ? ` | Assignee: ${t.assignee}` : ""}${t.epicId ? ` | Epic: ${t.epicId}` : ""}`,
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: tasks.length > 0 ? `Found ${tasks.length} task(s):\n\n${text}` : "No tasks found matching the given filters.",
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
        `**Project:** ${task.projectId}`,
      ];

      if (task.epicId) sections.push(`**Epic:** ${task.epicId}`);
      if (task.assignee) sections.push(`**Assignee:** ${task.assignee}`);
      if (task.estimatedEffort) sections.push(`**Estimated Effort:** ${task.estimatedEffort}`);
      if (task.dueDate) sections.push(`**Due Date:** ${task.dueDate}`);
      if (task.parentTaskId) sections.push(`**Parent Task:** ${task.parentTaskId}`);

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
}
