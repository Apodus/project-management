import { z } from "zod";
import { CLAIM_STATUSES, PROPOSAL_STATUSES } from "../constants/enums.js";
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
  resolved_by: ulidSchema.nullable().optional(),
  resolved_at: timestampSchema.nullable().optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export const insertProposalSchema = selectProposalSchema.omit({
  id: true,
  claimed_by: true,
  claim_status: true,
  created_at: true,
  updated_at: true,
});

export const CLAIM_RESULT_STATUSES = [
  "claimed_by_you",
  "already_claimed_by_you",
  "claimed_by_another_agent",
  "released",
  "not_held",
  "proposal_closed",
] as const;
export type ClaimResultStatus = (typeof CLAIM_RESULT_STATUSES)[number];

export const claimResultSchema = z.object({
  ok: z.boolean(),
  status: z.enum(CLAIM_RESULT_STATUSES),
});
export type ClaimResult = z.infer<typeof claimResultSchema>;
