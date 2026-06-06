import { z } from "zod";
import { CLAIM_STATUSES, CLAIM_STATES, EPIC_STATUSES, PRIORITIES } from "../constants/enums.js";
import { ulidSchema, timestampSchema, optionalText } from "./common.js";

export const selectEpicSchema = z.object({
  id: ulidSchema,
  project_id: ulidSchema,
  proposal_id: ulidSchema.nullable().optional(),
  milestone_id: ulidSchema.nullable().optional(),
  assignee_id: ulidSchema.nullable().optional(),
  name: z.string().min(1),
  description: optionalText,
  status: z.enum(EPIC_STATUSES),
  priority: z.enum(PRIORITIES),
  target_date: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  sort_order: z.number().int(),
  claim_status: z.enum(CLAIM_STATUSES),
  claim_state: z.enum(CLAIM_STATES),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  created_by: ulidSchema,
});

export const insertEpicSchema = selectEpicSchema.omit({
  id: true,
  assignee_id: true,
  claim_status: true,
  claim_state: true,
  created_at: true,
  updated_at: true,
});
