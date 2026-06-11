import type {
  ClaimResultData,
  ClaimState,
  ClaimStatusValue,
  ForceClaimResultData,
  RequestTakeoverResultData,
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
 * Render a claim_state enum (C3 liveness view) as agent-friendly text. Unlike
 * claim_status (holder-vs-caller only), claim_state folds in lease liveness so
 * an agent can SEE whether another holder is actively working (live) or may
 * have walked away (stale). Identity-masked — the enum never carries a holder
 * id, so this never leaks who holds the claim.
 *
 * `undefined` → "" (fail-safe for an older server that doesn't send the field;
 * callers guard on non-empty and simply omit the segment).
 */
export function claimStateLabel(state: ClaimState | undefined): string {
  switch (state) {
    case "yours":
      return "yours (you hold this)";
    case "live":
      return "live (actively worked)";
    case "stale":
      return "stale (claim lease lapsed — may be abandoned)";
    case "unclaimed":
      return "unclaimed (free to pick up)";
    case undefined:
      return "";
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
export function forceClaimResultText(_result: ForceClaimResultData, entity: string): string {
  return `✓ Force-claimed — this ${entity} is now yours. The previous holder was displaced (recorded in the audit log).`;
}

/**
 * Render a release-to (handoff) result as agent-friendly text. MUST NOT
 * interpolate `previousHolder`/`newHolder` — identities are recorded in the
 * audit log, never leaked.
 */
export function releaseToResultText(_result: ForceClaimResultData, entity: string): string {
  return `✓ Handed off — this ${entity}'s claim was transferred to the named worker (recorded in the audit log).`;
}

/**
 * Render a request-takeover result as agent-friendly text. Stomp-safe: a LIVE
 * claim is NEVER taken — the holder is only notified. MUST NOT interpolate any
 * holder id (identity-masked).
 */
export function requestTakeoverResultText(
  result: RequestTakeoverResultData,
  entity: string,
): string {
  switch (result.status) {
    case "force_claimed":
      return `✓ Taken over — the previous holder's claim was stale (lease lapsed), so this ${entity} is now yours (recorded in the audit log).`;
    case "notified_holder":
      return `⚠ This ${entity} is actively held (live claim). Nothing was changed — the current holder has been notified of your takeover request. Pick a different ${entity} or wait.`;
    case "already_claimed_by_you":
      return `✓ You already hold this ${entity}.`;
    case "not_held":
      return `This ${entity} isn't claimed — just claim it directly.`;
    default:
      return `Unexpected takeover result: ${result.status}`;
  }
}

/**
 * Render an entity reference as "Name (id)" when both are known, else
 * whichever exists ("" when neither). Read-tool renders surface the id beside
 * the display name so follow-up calls always have the id at hand (C5.P4).
 * NOT for assignee/reporter slots — those stay name-preferred with no id
 * pairing (the no-leak sentinel tests pin that masking boundary).
 */
export function nameWithId(name: string | null | undefined, id: string | null | undefined): string {
  if (name && id) return `${name} (${id})`;
  return name ?? id ?? "";
}

/**
 * Standard "you haven't claimed this" message used when a write returns
 * CLAIM_DENIED. `claimTool` is the MCP tool name the agent should call to claim
 * (e.g. "pm_claim_proposal", "pm_claim_epic").
 */
export function claimDeniedText(entity: string, claimTool: string): string {
  return `⚠ You haven't claimed this ${entity}. Call ${claimTool} first, or pick a different ${entity}.`;
}
