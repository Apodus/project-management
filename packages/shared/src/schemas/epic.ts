import { z } from "zod";
import { EPIC_STATUSES, PRIORITIES } from "../constants/enums.js";
import { ulidSchema, timestampSchema, optionalText } from "./common.js";

export const selectEpicSchema = z.object({
  id: ulidSchema,
  project_id: ulidSchema,
  proposal_id: ulidSchema.nullable().optional(),
  milestone_id: ulidSchema.nullable().optional(),
  name: z.string().min(1),
  description: optionalText,
  status: z.enum(EPIC_STATUSES),
  priority: z.enum(PRIORITIES),
  target_date: z.string().nullable().optional(),
  sort_order: z.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  created_by: ulidSchema,
});

export const insertEpicSchema = selectEpicSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});
