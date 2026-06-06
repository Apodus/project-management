import { z } from "zod";
import { TASK_STATUSES, PRIORITIES, TASK_TYPES, EFFORT_SIZES, CLAIM_STATES } from "../constants/enums.js";
import { ulidSchema, timestampSchema, optionalText } from "./common.js";

export const taskContextSchema = z
  .object({
    relevant_files: z.array(z.string()).optional(),
    codebase_areas: z.array(z.string()).optional(),
    acceptance_criteria: z.array(z.string()).optional(),
    design_references: z.array(z.string()).optional(),
    notes: z.string().optional(),
    implementation_hints: z.string().optional(),
  })
  .nullable()
  .optional();

export const selectTaskSchema = z.object({
  id: ulidSchema,
  project_id: ulidSchema,
  proposal_id: ulidSchema.nullable().optional(),
  epic_id: ulidSchema.nullable().optional(),
  parent_task_id: ulidSchema.nullable().optional(),
  title: z.string().min(1),
  description: optionalText,
  status: z.enum(TASK_STATUSES),
  priority: z.enum(PRIORITIES),
  type: z.enum(TASK_TYPES),
  assignee_id: ulidSchema.nullable().optional(),
  reporter_id: ulidSchema,
  estimated_effort: z.enum(EFFORT_SIZES).nullable().optional(),
  due_date: z.string().nullable().optional(),
  sort_order: z.number().int(),
  context: taskContextSchema,
  git_branch: z.string().nullable().optional(),
  claim_state: z.enum(CLAIM_STATES),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  started_at: timestampSchema.nullable().optional(),
  completed_at: timestampSchema.nullable().optional(),
});

export const insertTaskSchema = selectTaskSchema.omit({
  id: true,
  claim_state: true,
  created_at: true,
  updated_at: true,
});
