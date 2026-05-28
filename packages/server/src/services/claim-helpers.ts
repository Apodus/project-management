import type { ClaimStatus, UserType } from "@pm/shared";
import { AppError } from "../types.js";

export interface Actor {
  id: string;
  type: UserType;
}

export type ClaimFilter = "available" | "mine" | "all";

/**
 * Compute the claim_status enum relative to a caller.
 * Returns "unclaimed" when no caller is supplied (e.g. server-internal call).
 */
export function deriveClaimStatus(
  claimedBy: string | null | undefined,
  caller?: { id: string } | null,
): ClaimStatus {
  if (!claimedBy) return "unclaimed";
  if (caller && claimedBy === caller.id) return "claimed_by_you";
  return "claimed_by_other";
}

/**
 * Enforce that an AI agent holds the claim on an entity before writing.
 * Humans always pass. AI agents must hold the claim — unclaimed entities also
 * reject AI-agent writes (the agent must call claim first).
 */
export function assertClaimOk(
  claimedBy: string | null | undefined,
  actor: Actor,
  entityName: string,
): void {
  if (actor.type === "human") return;
  if (claimedBy === actor.id) return;
  throw new AppError(
    409,
    "CLAIM_DENIED",
    claimedBy
      ? `This ${entityName} is claimed by another agent.`
      : `You have not claimed this ${entityName}. Call claim first.`,
  );
}
