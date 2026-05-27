import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  implementProposal,
  pickNextTask,
  transitionTask,
  addTaskComment,
  addTaskDependency,
  getTask,
} from "../api-client.js";

export function registerWorkflowTools(server: McpServer): void {
  // ---- pm_implement_proposal ----

  server.tool(
    "pm_implement_proposal",
    "Create epics and tasks from an accepted proposal. Transitions the proposal to 'planned' status. The proposal must be in 'accepted' status.",
    {
      proposal_id: z.string().describe("The accepted proposal ID to implement"),
      epics: z
        .array(
          z.object({
            name: z.string().describe("Epic name"),
            description: z.string().optional().describe("Epic description"),
            priority: z.string().optional().describe("Epic priority"),
            tasks: z
              .array(
                z.object({
                  title: z.string().describe("Task title"),
                  description: z.string().optional().describe("Task description"),
                  priority: z.string().optional().describe("Task priority"),
                  type: z.string().optional().describe("Task type"),
                }),
              )
              .optional()
              .describe("Tasks within this epic"),
          }),
        )
        .optional()
        .describe("Epics to create from this proposal"),
      tasks: z
        .array(
          z.object({
            title: z.string().describe("Task title"),
            description: z.string().optional().describe("Task description"),
            priority: z.string().optional().describe("Task priority"),
            type: z.string().optional().describe("Task type"),
          }),
        )
        .optional()
        .describe("Standalone tasks to create (not under any epic)"),
      summary: z
        .string()
        .optional()
        .describe("Summary comment explaining the implementation plan"),
    },
    async ({ proposal_id, epics, tasks, summary }) => {
      // Build the epics payload for the API. Tasks nested within epics are
      // passed as epicIndex references (position in the epics array).
      const apiEpics: Array<{
        name: string;
        description?: string | null;
        priority?: string;
      }> = [];
      const apiTasks: Array<{
        title: string;
        description?: string | null;
        priority?: string;
        type?: string;
        epicIndex?: number;
      }> = [];

      if (epics) {
        for (let i = 0; i < epics.length; i++) {
          const epic = epics[i];
          apiEpics.push({
            name: epic.name,
            description: epic.description ?? null,
            priority: epic.priority,
          });
          if (epic.tasks) {
            for (const task of epic.tasks) {
              apiTasks.push({
                title: task.title,
                description: task.description ?? null,
                priority: task.priority,
                type: task.type,
                epicIndex: i,
              });
            }
          }
        }
      }

      if (tasks) {
        for (const task of tasks) {
          apiTasks.push({
            title: task.title,
            description: task.description ?? null,
            priority: task.priority,
            type: task.type,
          });
        }
      }

      const result = await implementProposal(proposal_id, {
        actorId: "mcp-agent",
        epics: apiEpics.length > 0 ? apiEpics : undefined,
        tasks: apiTasks.length > 0 ? apiTasks : undefined,
      });

      const sections: string[] = [
        "Proposal planned successfully.",
        "",
        `**Proposal ID:** ${result.id}`,
        `**Status:** ${result.status}`,
      ];

      if (apiEpics.length > 0) {
        sections.push(`**Epics created:** ${apiEpics.length}`);
      }
      if (apiTasks.length > 0) {
        sections.push(`**Tasks created:** ${apiTasks.length}`);
      }
      if (summary) {
        sections.push("", "**Plan summary:**", summary);
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

  // ---- pm_pick_next_task ----

  server.tool(
    "pm_pick_next_task",
    "Find and self-assign the highest priority ready task. Atomically claims the task so no other agent can pick it simultaneously. Returns full task details or a message if nothing is available.",
    {
      project_id: z.string().optional().describe("Limit to tasks in a specific project"),
      epic_id: z.string().optional().describe("Limit to tasks within a specific epic"),
      task_types: z
        .array(z.string())
        .optional()
        .describe("Filter by task types (e.g. ['feature', 'bug'])"),
      max_effort: z
        .enum(["xs", "s", "m", "l", "xl"])
        .optional()
        .describe("Maximum effort size to consider"),
    },
    async ({ project_id, epic_id, task_types, max_effort }) => {
      const task = await pickNextTask({
        project_id,
        epic_id,
        task_types,
        max_effort,
      });

      if (!task) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No tasks available matching the given criteria. All ready tasks may be assigned, blocked, or filtered out.",
            },
          ],
        };
      }

      const sections: string[] = [
        "Task claimed successfully!",
        "",
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

  // ---- pm_start_task ----

  server.tool(
    "pm_start_task",
    "Claim a specific task and begin work. Transitions the task to 'in_progress' status, assigns it to the current agent, and records the start time.",
    {
      task_id: z.string().describe("The task ID to start working on"),
      comment: z.string().optional().describe("Optional note about your planned approach"),
    },
    async ({ task_id, comment }) => {
      const task = await transitionTask(task_id, "in_progress", comment);

      const sections: string[] = [
        "Task started.",
        "",
        `**ID:** ${task.id}`,
        `**Title:** ${task.title}`,
        `**Status:** ${task.status}`,
        `**Priority:** ${task.priority}`,
        `**Type:** ${task.type}`,
      ];

      if (task.assignee) sections.push(`**Assignee:** ${task.assignee}`);

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

  // ---- pm_complete_task ----

  server.tool(
    "pm_complete_task",
    "Mark a task as done with a structured handoff summary. Transitions to 'done' status and adds a handoff comment with metadata about what was accomplished.",
    {
      task_id: z.string().describe("The task ID to complete"),
      summary: z.string().describe("Summary of what was done"),
      files_changed: z
        .array(z.string())
        .optional()
        .describe("List of files that were modified"),
      open_questions: z
        .array(z.string())
        .optional()
        .describe("Questions or issues needing human attention"),
      test_results: z.string().optional().describe("Summary of test outcomes"),
    },
    async ({ task_id, summary, files_changed, open_questions, test_results }) => {
      // Transition to done
      const task = await transitionTask(task_id, "done");

      // Build handoff metadata
      const metadata: Record<string, unknown> = {};
      if (files_changed && files_changed.length > 0) {
        metadata.files_changed = files_changed;
      }
      if (open_questions && open_questions.length > 0) {
        metadata.open_questions = open_questions;
      }
      if (test_results) {
        metadata.test_results = test_results;
      }

      // Add handoff comment
      await addTaskComment(
        task_id,
        summary,
        "handoff",
        Object.keys(metadata).length > 0 ? metadata : null,
      );

      const sections: string[] = [
        "Task completed.",
        "",
        `**ID:** ${task.id}`,
        `**Title:** ${task.title}`,
        `**Status:** ${task.status}`,
        "",
        "**Handoff summary:**",
        summary,
      ];

      if (files_changed && files_changed.length > 0) {
        sections.push("", "**Files changed:**");
        for (const f of files_changed) {
          sections.push(`- ${f}`);
        }
      }

      if (open_questions && open_questions.length > 0) {
        sections.push("", "**Open questions:**");
        for (const q of open_questions) {
          sections.push(`- ${q}`);
        }
      }

      if (test_results) {
        sections.push("", `**Test results:** ${test_results}`);
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

  // ---- pm_request_review ----

  server.tool(
    "pm_request_review",
    "Move a task to 'in_review' status with review context for the human director. Adds a review note comment with details about what to look at.",
    {
      task_id: z.string().describe("The task ID to request review for"),
      summary: z.string().describe("Summary of the changes for the reviewer"),
      review_notes: z
        .string()
        .optional()
        .describe("Specific areas to focus on during review"),
      files_changed: z
        .array(z.string())
        .optional()
        .describe("List of files that were modified"),
    },
    async ({ task_id, summary, review_notes, files_changed }) => {
      // Transition to in_review
      const task = await transitionTask(task_id, "in_review");

      // Build review comment body
      const commentParts: string[] = [summary];
      if (review_notes) {
        commentParts.push("", "**Review focus:**", review_notes);
      }
      if (files_changed && files_changed.length > 0) {
        commentParts.push("", "**Files changed:**");
        for (const f of files_changed) {
          commentParts.push(`- ${f}`);
        }
      }

      // Add review note comment
      await addTaskComment(task_id, commentParts.join("\n"), "review_note");

      const sections: string[] = [
        "Review requested.",
        "",
        `**ID:** ${task.id}`,
        `**Title:** ${task.title}`,
        `**Status:** ${task.status}`,
        "",
        "**Review summary:**",
        summary,
      ];

      if (review_notes) {
        sections.push("", `**Review notes:** ${review_notes}`);
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

  // ---- pm_block_task ----

  server.tool(
    "pm_block_task",
    "Mark a task as blocked with a reason. Optionally link to the blocking task by creating a dependency. Adds a comment explaining why the task is blocked.",
    {
      task_id: z.string().describe("The task ID to mark as blocked"),
      reason: z.string().describe("Explanation of why the task is blocked"),
      blocked_by_task_id: z
        .string()
        .optional()
        .describe("ID of the task that is blocking this one"),
    },
    async ({ task_id, reason, blocked_by_task_id }) => {
      // Add a comment explaining the block reason
      const commentBody = blocked_by_task_id
        ? `Blocked: ${reason}\n\nBlocked by task: ${blocked_by_task_id}`
        : `Blocked: ${reason}`;

      await addTaskComment(task_id, commentBody, "comment");

      // If there's a blocking task, create a dependency
      if (blocked_by_task_id) {
        await addTaskDependency(task_id, blocked_by_task_id, "blocks");
      }

      // Re-fetch task to get current state
      const task = await getTask(task_id);

      const sections: string[] = [
        "Task marked as blocked.",
        "",
        `**ID:** ${task.id}`,
        `**Title:** ${task.title}`,
        `**Status:** ${task.status}`,
        "",
        `**Reason:** ${reason}`,
      ];

      if (blocked_by_task_id) {
        sections.push(`**Blocked by:** ${blocked_by_task_id}`);
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
