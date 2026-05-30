import { z } from "zod";
import { PROJECT_STATUSES, TASK_STATUSES } from "../constants/enums.js";
import { ulidSchema, timestampSchema, optionalText } from "./common.js";

export const aiAutonomySettingsSchema = z.object({
  can_self_assign: z.boolean(),
  can_create_subtasks: z.boolean(),
  can_create_tasks: z.boolean(),
  can_change_priority: z.boolean(),
  can_close_epics: z.boolean(),
  max_concurrent_tasks: z.number().int().min(1),
});

export const workflowSettingsSchema = z.object({
  statuses: z.array(z.enum(TASK_STATUSES)),
});

export const gitSettingsSchema = z.object({
  branch_prefix: z.string(),
  auto_link_branches: z.boolean(),
});

export const linkedRepoSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  role: z.enum(["inner", "outer"]),
  gitlink_parent: z.string().min(1).optional(),
  gitlink_path: z.string().min(1).optional(),
});

export const integratorSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    verify_command: z.string().min(1).optional(),
    verify_timeout_sec: z.number().int().min(1).default(600),
    worktree_root: z.string().min(1).optional(),
    git_remote: z.string().min(1).default("origin"),
    git_main_branch: z.string().min(1).default("main"),
    worktree_name: z.string().min(1).optional(),
    parallelism: z.number().int().min(1).default(1),
    linked_repos: z.array(linkedRepoSchema).default([]),
  })
  .refine(
    (v) => !v.enabled || (Boolean(v.verify_command) && Boolean(v.worktree_root)),
    {
      message:
        "When integrator.enabled is true, verify_command and worktree_root are required and must be non-empty.",
      path: ["enabled"],
    },
  );

export const projectSettingsSchema = z
  .object({
    ai_autonomy: aiAutonomySettingsSchema,
    workflow: workflowSettingsSchema,
    git: gitSettingsSchema,
    integrator: integratorSettingsSchema.optional(),
  })
  .nullable()
  .optional();

export const selectProjectSchema = z.object({
  id: ulidSchema,
  workspace_id: ulidSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  description: optionalText,
  status: z.enum(PROJECT_STATUSES),
  git_repo_url: optionalText,
  settings: projectSettingsSchema,
  sort_order: z.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  created_by: ulidSchema,
});

export const insertProjectSchema = selectProjectSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});
