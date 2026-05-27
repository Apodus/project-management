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

export const projectSettingsSchema = z
  .object({
    ai_autonomy: aiAutonomySettingsSchema,
    workflow: workflowSettingsSchema,
    git: gitSettingsSchema,
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
