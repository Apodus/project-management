import { z } from "zod";
import { CLAIM_STATUSES, CLAIM_STATES, PROPOSAL_STATUSES } from "../constants/enums.js";
import { ulidSchema, timestampSchema, optionalText } from "./common.js";

export const selectProposalSchema = z.object({
  id: ulidSchema,
  project_id: ulidSchema.nullable().optional(),
  title: z.string().min(1),
  description: optionalText,
  status: z.enum(PROPOSAL_STATUSES),
  created_by: ulidSchema,
  claimed_by: ulidSchema.nullable().optional(),
  claim_status: z.enum(CLAIM_STATUSES),
  claim_state: z.enum(CLAIM_STATES),
  resolved_by: ulidSchema.nullable().optional(),
  resolved_at: timestampSchema.nullable().optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export const insertProposalSchema = selectProposalSchema.omit({
  id: true,
  claimed_by: true,
  claim_status: true,
  claim_state: true,
  created_at: true,
  updated_at: true,
});
