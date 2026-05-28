import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ApiError,
  addTaskComment,
  addTaskDependency,
  createEpic,
  createGitRef,
  createProposal,
  createTask,
  getTask,
  updateTask,
} from "../api-client.js";

function claimDeniedText(): string {
  return "⚠ You haven't claimed this proposal. Call pm_claim_proposal first, or omit proposal_id.";
}

export function registerWriteTools(server: McpServer): void {
  // ---- pm_create_proposal ----

  server.tool(
    "pm_create_proposal",
    "Create a new proposal in a project. Proposals capture an idea or change for discussion. Identity is derived from your authenticated session — you don't need to provide an author ID.",
    {
      project_id: z.string().describe("The project ID to create the proposal in"),
      title: z.string().describe("Short, descriptive proposal title"),
      description: z
        .string()
        .optional()
        .describe("Proposal body (markdown). Explain the what, why, and trade-offs."),
    },
    async ({ project_id, title, description }) => {
      const proposal = await createProposal(project_id, {
        title,
        description: description ?? null,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Proposal created successfully.",
              "",
              `**ID:** ${proposal.id}`,
              `**Title:** ${proposal.title}`,
              `**Status:** ${proposal.status}`,
              `**Project:** ${proposal.projectId}`,
              "",
              "Next: call pm_claim_proposal to take ownership before discussing or implementing.",
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ---- pm_create_epic ----

  server.tool(
    "pm_create_epic",
    "Create a new epic in a project. Epics group related tasks. Optionally link to a proposal (any non-terminal status). If proposal_id is set, you must hold the claim — call pm_claim_proposal first.",
    {
      project_id: z.string().describe("The project ID to create the epic in"),
      name: z.string().describe("Epic name"),
      description: z.string().optional().describe("Epic description (markdown)"),
      priority: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("Epic priority (default: medium)"),
      proposal_id: z
        .string()
        .optional()
        .describe(
          "Link this epic to a proposal. You must hold the claim on that proposal.",
        ),
      milestone_id: z
        .string()
        .optional()
        .describe("Link this epic to a milestone"),
      target_date: z
        .string()
        .optional()
        .describe("Target completion date (ISO 8601)"),
    },
    async ({
      project_id,
      name,
      description,
      priority,
      proposal_id,
      milestone_id,
      target_date,
    }) => {
      try {
        const epic = await createEpic(project_id, {
          name,
          description: description ?? null,
          priority,
          proposalId: proposal_id ?? null,
          milestoneId: milestone_id ?? null,
          targetDate: target_date ?? null,
        });

        const sections: string[] = [
          "Epic created successfully.",
          "",
          `**ID:** ${epic.id}`,
          `**Name:** ${epic.name}`,
          `**Status:** ${epic.status}`,
          `**Priority:** ${epic.priority}`,
          `**Project:** ${epic.projectId}`,
        ];
        if (proposal_id) sections.push(`**Linked proposal:** ${proposal_id}`);

        return {
          content: [{ type: "text" as const, text: sections.join("\n") }],
        };
      } catch (err) {
        if (err instanceof ApiError && err.code === "CLAIM_DENIED") {
          return {
            content: [{ type: "text" as const, text: claimDeniedText() }],
          };
        }
        throw err;
      }
    },
  );

  // ---- pm_create_task ----

  server.tool(
    "pm_create_task",
    "Create a new task in a project. Use this to break down work into actionable items. Optionally set dependencies on other tasks.",
    {
      project_id: z.string().describe("The project ID to create the task in"),
      title: z.string().describe("The task title"),
      description: z.string().optional().describe("Task description (markdown)"),
      epic_id: z.string().optional().describe("Epic ID to associate the task with"),
      parent_task_id: z.string().optional().describe("Parent task ID (create as subtask)"),
      priority: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("Task priority (default: medium)"),
      type: z
        .enum(["feature", "bug", "chore", "spike", "design", "research"])
        .optional()
        .describe("Task type (default: feature)"),
      estimated_effort: z
        .enum(["xs", "s", "m", "l", "xl"])
        .optional()
        .describe("Estimated effort size"),
      context: z
        .object({
          relevant_files: z.array(z.string()).optional(),
          acceptance_criteria: z.array(z.string()).optional(),
          notes: z.string().optional(),
          implementation_hints: z.string().optional(),
          design_references: z.array(z.string()).optional(),
        })
        .optional()
        .describe("AI context for the task"),
      depends_on: z
        .array(z.string())
        .optional()
        .describe("Array of task IDs this task depends on"),
    },
    async ({
      project_id,
      title,
      description,
      epic_id,
      parent_task_id,
      priority,
      type,
      estimated_effort,
      context,
      depends_on,
    }) => {
      const task = await createTask(project_id, {
        title,
        description: description ?? null,
        epicId: epic_id ?? null,
        parentTaskId: parent_task_id ?? null,
        priority,
        type,
        estimatedEffort: estimated_effort ?? null,
        context: context ? (context as Record<string, unknown>) : null,
      });

      // Add dependencies if specified
      if (depends_on && depends_on.length > 0) {
        for (const depId of depends_on) {
          await addTaskDependency(task.id, depId);
        }
      }

      const sections: string[] = [
        "Task created successfully.",
        "",
        `**ID:** ${task.id}`,
        `**Title:** ${task.title}`,
        `**Status:** ${task.status}`,
        `**Priority:** ${task.priority}`,
        `**Type:** ${task.type}`,
        `**Project:** ${task.projectId}`,
      ];

      if (task.epicId) sections.push(`**Epic:** ${task.epicId}`);
      if (task.parentTaskId) sections.push(`**Parent Task:** ${task.parentTaskId}`);
      if (task.estimatedEffort) sections.push(`**Estimated Effort:** ${task.estimatedEffort}`);

      if (depends_on && depends_on.length > 0) {
        sections.push(`**Dependencies:** ${depends_on.join(", ")}`);
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

  // ---- pm_update_task ----

  server.tool(
    "pm_update_task",
    "Update mutable fields on a task. Context is merged with existing context.",
    {
      task_id: z.string().describe("The task ID to update"),
      title: z.string().optional().describe("New task title"),
      description: z.string().optional().describe("New task description (markdown)"),
      priority: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("New priority"),
      type: z
        .enum(["feature", "bug", "chore", "spike", "design", "research"])
        .optional()
        .describe("New task type"),
      estimated_effort: z
        .enum(["xs", "s", "m", "l", "xl"])
        .optional()
        .describe("New estimated effort"),
      context: z
        .object({
          relevant_files: z.array(z.string()).optional(),
          acceptance_criteria: z.array(z.string()).optional(),
          notes: z.string().optional(),
          implementation_hints: z.string().optional(),
          design_references: z.array(z.string()).optional(),
        })
        .optional()
        .describe("Context to merge with existing task context"),
      due_date: z.string().optional().describe("Due date (ISO 8601 format)"),
    },
    async ({ task_id, title, description, priority, type, estimated_effort, context, due_date }) => {
      // If context is provided, merge with existing
      let mergedContext: Record<string, unknown> | undefined;
      if (context) {
        const existing = await getTask(task_id);
        const existingCtx =
          existing.context && typeof existing.context === "object"
            ? (existing.context as Record<string, unknown>)
            : {};
        mergedContext = { ...existingCtx, ...(context as Record<string, unknown>) };
      }

      const data: Record<string, unknown> = {};
      if (title !== undefined) data.title = title;
      if (description !== undefined) data.description = description;
      if (priority !== undefined) data.priority = priority;
      if (type !== undefined) data.type = type;
      if (estimated_effort !== undefined) data.estimatedEffort = estimated_effort;
      if (due_date !== undefined) data.dueDate = due_date;
      if (mergedContext !== undefined) data.context = mergedContext;

      const task = await updateTask(task_id, data);

      const sections: string[] = [
        "Task updated successfully.",
        "",
        `**ID:** ${task.id}`,
        `**Title:** ${task.title}`,
        `**Status:** ${task.status}`,
        `**Priority:** ${task.priority}`,
        `**Type:** ${task.type}`,
      ];

      if (task.estimatedEffort) sections.push(`**Estimated Effort:** ${task.estimatedEffort}`);
      if (task.dueDate) sections.push(`**Due Date:** ${task.dueDate}`);

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

  // ---- pm_add_comment ----

  server.tool(
    "pm_add_comment",
    "Add a typed comment to a task. Supports structured communication with comment types.",
    {
      task_id: z.string().describe("The task ID to comment on"),
      body: z.string().describe("Comment body (markdown)"),
      comment_type: z
        .enum(["comment", "progress_update", "decision", "question"])
        .optional()
        .describe("Type of comment (default: comment)"),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Structured metadata for typed comments"),
    },
    async ({ task_id, body, comment_type, metadata }) => {
      const comment = await addTaskComment(
        task_id,
        body,
        comment_type ?? "comment",
        metadata ?? null,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Comment added successfully.",
              "",
              `**Comment ID:** ${comment.id}`,
              `**Type:** ${comment.commentType}`,
              `**Author:** ${comment.authorId ?? "unknown"}`,
              "",
              "---",
              "",
              comment.body,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ---- pm_log_decision ----

  server.tool(
    "pm_log_decision",
    "Record a design decision with rationale. Creates a structured 'decision' type comment on the task.",
    {
      task_id: z.string().describe("The task ID to log the decision on"),
      decision: z.string().describe("What was decided"),
      rationale: z.string().describe("Why this decision was made"),
      alternatives_considered: z
        .array(z.string())
        .optional()
        .describe("Other options that were considered"),
    },
    async ({ task_id, decision, rationale, alternatives_considered }) => {
      const body = [
        `**Decision:** ${decision}`,
        "",
        `**Rationale:** ${rationale}`,
      ];

      if (alternatives_considered && alternatives_considered.length > 0) {
        body.push("", "**Alternatives considered:**");
        for (const alt of alternatives_considered) {
          body.push(`- ${alt}`);
        }
      }

      const metadata: Record<string, unknown> = {
        decision,
        rationale,
      };
      if (alternatives_considered) {
        metadata.alternatives_considered = alternatives_considered;
      }

      const comment = await addTaskComment(task_id, body.join("\n"), "decision", metadata);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Decision logged successfully.",
              "",
              `**Comment ID:** ${comment.id}`,
              `**Task:** ${task_id}`,
              "",
              `**Decision:** ${decision}`,
              `**Rationale:** ${rationale}`,
              ...(alternatives_considered && alternatives_considered.length > 0
                ? [
                    "",
                    "**Alternatives considered:**",
                    ...alternatives_considered.map((a) => `- ${a}`),
                  ]
                : []),
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ---- pm_report_progress ----

  server.tool(
    "pm_report_progress",
    "Post a structured progress update on a task. Records completion percentage, files changed, and any blockers.",
    {
      task_id: z.string().describe("The task ID to report progress on"),
      summary: z.string().describe("Summary of progress made"),
      completion_pct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Completion percentage (0-100)"),
      files_changed: z
        .array(z.string())
        .optional()
        .describe("List of files that were modified"),
      blockers: z
        .array(z.string())
        .optional()
        .describe("Current blockers or issues"),
    },
    async ({ task_id, summary, completion_pct, files_changed, blockers }) => {
      const bodyParts: string[] = [summary];

      if (completion_pct !== undefined) {
        bodyParts.push("", `**Completion:** ${completion_pct}%`);
      }

      if (files_changed && files_changed.length > 0) {
        bodyParts.push("", "**Files changed:**");
        for (const f of files_changed) {
          bodyParts.push(`- ${f}`);
        }
      }

      if (blockers && blockers.length > 0) {
        bodyParts.push("", "**Blockers:**");
        for (const b of blockers) {
          bodyParts.push(`- ${b}`);
        }
      }

      const metadata: Record<string, unknown> = {
        summary,
      };
      if (completion_pct !== undefined) metadata.completion_pct = completion_pct;
      if (files_changed) metadata.files_changed = files_changed;

      const comment = await addTaskComment(
        task_id,
        bodyParts.join("\n"),
        "progress_update",
        metadata,
      );

      const sections: string[] = [
        "Progress update posted.",
        "",
        `**Comment ID:** ${comment.id}`,
        `**Task:** ${task_id}`,
        "",
        `**Summary:** ${summary}`,
      ];

      if (completion_pct !== undefined) {
        sections.push(`**Completion:** ${completion_pct}%`);
      }

      if (files_changed && files_changed.length > 0) {
        sections.push("", "**Files changed:**");
        for (const f of files_changed) {
          sections.push(`- ${f}`);
        }
      }

      if (blockers && blockers.length > 0) {
        sections.push("", "**Blockers:**");
        for (const b of blockers) {
          sections.push(`- ${b}`);
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

  // ---- pm_set_task_context ----

  server.tool(
    "pm_set_task_context",
    "Update AI context on a task. Merges with existing context fields.",
    {
      task_id: z.string().describe("The task ID to set context on"),
      relevant_files: z
        .array(z.string())
        .optional()
        .describe("Files relevant to this task"),
      acceptance_criteria: z
        .array(z.string())
        .optional()
        .describe("Acceptance criteria for the task"),
      notes: z.string().optional().describe("Additional notes"),
      implementation_hints: z
        .string()
        .optional()
        .describe("Hints for implementation approach"),
      design_references: z
        .array(z.string())
        .optional()
        .describe("References to design documents or proposals"),
    },
    async ({ task_id, relevant_files, acceptance_criteria, notes, implementation_hints, design_references }) => {
      // Build context update from provided fields
      const contextUpdate: Record<string, unknown> = {};
      if (relevant_files !== undefined) contextUpdate.relevant_files = relevant_files;
      if (acceptance_criteria !== undefined) contextUpdate.acceptance_criteria = acceptance_criteria;
      if (notes !== undefined) contextUpdate.notes = notes;
      if (implementation_hints !== undefined) contextUpdate.implementation_hints = implementation_hints;
      if (design_references !== undefined) contextUpdate.design_references = design_references;

      // Merge with existing context
      const existing = await getTask(task_id);
      const existingCtx =
        existing.context && typeof existing.context === "object"
          ? (existing.context as Record<string, unknown>)
          : {};
      const mergedContext = { ...existingCtx, ...contextUpdate };

      const task = await updateTask(task_id, { context: mergedContext });

      const sections: string[] = [
        "Task context updated.",
        "",
        `**ID:** ${task.id}`,
        `**Title:** ${task.title}`,
      ];

      if (task.context && typeof task.context === "object") {
        sections.push("", "**Context:**", JSON.stringify(task.context, null, 2));
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

  // ---- pm_link_git_ref ----

  server.tool(
    "pm_link_git_ref",
    "Link a git branch, commit, or pull request to a task.",
    {
      task_id: z.string().describe("The task ID to link the git ref to"),
      ref_type: z
        .enum(["branch", "commit", "pull_request"])
        .describe("Type of git reference"),
      ref_value: z
        .string()
        .describe("The reference value (branch name, commit SHA, or PR number)"),
      url: z.string().optional().describe("URL to the git reference"),
      title: z.string().optional().describe("Display title for the reference"),
    },
    async ({ task_id, ref_type, ref_value, url, title }) => {
      const gitRef = await createGitRef(task_id, {
        refType: ref_type,
        refValue: ref_value,
        url: url ?? null,
        title: title ?? null,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Git reference linked successfully.",
              "",
              `**Ref ID:** ${gitRef.id}`,
              `**Task:** ${task_id}`,
              `**Type:** ${gitRef.refType}`,
              `**Value:** ${gitRef.refValue}`,
              ...(gitRef.url ? [`**URL:** ${gitRef.url}`] : []),
              ...(gitRef.title ? [`**Title:** ${gitRef.title}`] : []),
            ].join("\n"),
          },
        ],
      };
    },
  );
}
