import type {
  ClaimResultData,
  ClaimStatusValue,
  ForceClaimResultData,
} from "../api-client.js";

/**
 * Render a claim_status enum as agent-friendly text.
 */
export function claimStatusLabel(status: ClaimStatusValue | undefined): string {
  switch (status) {
    case "claimed_by_you":
      return "claimed for you";
    case "claimed_by_other":
      return "claimed by another agent";
    case "unclaimed":
    case undefined:
      return "available to claim";
  }
}

/**
 * Render a claim/release result as agent-friendly text, parameterized on
 * the entity name (e.g. "proposal", "epic").
 */
export function claimResultText(
  result: ClaimResultData,
  mode: "claim" | "release",
  entity: string,
): string {
  if (mode === "claim") {
    switch (result.status) {
      case "claimed_by_you":
        return `✓ Claimed — this ${entity} is yours to work on.`;
      case "already_claimed_by_you":
        return "✓ You already hold this claim.";
      case "claimed_by_another_agent":
        return `⚠ This ${entity} is claimed by another agent. Pick a different one.`;
      case "closed":
        return `⚠ This ${entity} is closed and can no longer be claimed.`;
      default:
        return `Unexpected claim result: ${result.status}`;
    }
  }
  // release
  switch (result.status) {
    case "released":
      return `✓ Released. Other agents can now claim this ${entity}.`;
    case "not_held":
      return `⚠ This ${entity} isn't currently claimed.`;
    case "claimed_by_another_agent":
      return "⚠ You don't hold this claim — only the current claimant or a human can release it.";
    default:
      return `Unexpected release result: ${result.status}`;
  }
}

/**
 * Render a force-claim (takeover) result as agent-friendly text. MUST NOT
 * interpolate `previousHolder` — the displaced holder's identity is recorded in
 * the audit log, never leaked to the new claimant.
 */
export function forceClaimResultText(
  _result: ForceClaimResultData,
  entity: string,
): string {
  return `✓ Force-claimed — this ${entity} is now yours. The previous holder was displaced (recorded in the audit log).`;
}

/**
 * Standard "you haven't claimed this" message used when a write returns
 * CLAIM_DENIED. `claimTool` is the MCP tool name the agent should call to claim
 * (e.g. "pm_claim_proposal", "pm_claim_epic").
 */
export function claimDeniedText(entity: string, claimTool: string): string {
  return `⚠ You haven't claimed this ${entity}. Call ${claimTool} first, or pick a different ${entity}.`;
}
