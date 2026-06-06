import { z } from "zod";

export const CLAIM_RESULT_STATUSES = [
  "claimed_by_you",
  "already_claimed_by_you",
  "claimed_by_another_agent",
  "released",
  "not_held",
  "closed",
  "force_claimed",
  // Campaign C3 §P5b — request-takeover against a LIVE claim: the holder was
  // notified, NOTHING was mutated (the cardinal invariant). ok=false.
  "notified_holder",
] as const;
export type ClaimResultStatus = (typeof CLAIM_RESULT_STATUSES)[number];

export const claimResultSchema = z.object({
  ok: z.boolean(),
  status: z.enum(CLAIM_RESULT_STATUSES),
});
export type ClaimResult = z.infer<typeof claimResultSchema>;
