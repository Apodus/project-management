import { z } from "zod";
import { PROPOSAL_STATUSES } from "../constants/enums.js";
import { ulidSchema, timestampSchema, optionalText } from "./common.js";

export const selectProposalSchema = z.object({
  id: ulidSchema,
  project_id: ulidSchema.nullable().optional(),
  title: z.string().min(1),
  description: optionalText,
  status: z.enum(PROPOSAL_STATUSES),
  created_by: ulidSchema,
  resolved_by: ulidSchema.nullable().optional(),
  resolved_at: timestampSchema.nullable().optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export const insertProposalSchema = selectProposalSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});
