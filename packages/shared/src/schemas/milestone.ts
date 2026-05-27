import { z } from "zod";
import { MILESTONE_STATUSES } from "../constants/enums.js";
import { ulidSchema, timestampSchema, optionalText } from "./common.js";

export const selectMilestoneSchema = z.object({
  id: ulidSchema,
  project_id: ulidSchema,
  name: z.string().min(1),
  description: optionalText,
  target_date: z.string().nullable().optional(),
  status: z.enum(MILESTONE_STATUSES),
  sort_order: z.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export const insertMilestoneSchema = selectMilestoneSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});
