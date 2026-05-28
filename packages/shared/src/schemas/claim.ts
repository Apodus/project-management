import { z } from "zod";

export const CLAIM_RESULT_STATUSES = [
  "claimed_by_you",
  "already_claimed_by_you",
  "claimed_by_another_agent",
  "released",
  "not_held",
  "closed",
] as const;
export type ClaimResultStatus = (typeof CLAIM_RESULT_STATUSES)[number];

export const claimResultSchema = z.object({
  ok: z.boolean(),
  status: z.enum(CLAIM_RESULT_STATUSES),
});
export type ClaimResult = z.infer<typeof claimResultSchema>;
