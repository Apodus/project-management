import type { IntegratorLiveness } from "@pm/shared";

/**
 * Render the on-read integrator liveness block as a single human line, or null
 * when no liveness was derived (block absent). Shared by the merge-lock and
 * merge-request MCP tool renderers so the DOWN / healthy-integrating /
 * plain-status wording stays in lockstep. See roadmap design-lock D/E.
 *
 * Render rules:
 * - `stall === "integrator_down"` → the DOWN hint ("no heartbeat for Ns") so
 *   an agent staring at a stalled queue self-diagnoses "restart the daemon".
 * - alive + integrating → healthy, verify in progress (wait, don't restart).
 * - else → plain `integrator: <status> (last heartbeat Ns ago)`.
 */
export function renderIntegratorLiveness(
  integrator: IntegratorLiveness | null | undefined,
): string | null {
  if (!integrator) return null;
  const { status, last_heartbeat_age_sec, lane_status, stall } = integrator;

  if (stall === "integrator_down") {
    const ageStr =
      last_heartbeat_age_sec === null
        ? "no heartbeat yet"
        : `no heartbeat for ${last_heartbeat_age_sec}s`;
    return `⚠ integrator appears DOWN (${ageStr}) — the queue is not being consumed; restart the daemon`;
  }

  if (status === "alive" && lane_status === "integrating") {
    return "integrator: healthy, actively integrating (verify in progress)";
  }

  const age =
    last_heartbeat_age_sec === null
      ? "never heartbeated"
      : `last heartbeat ${last_heartbeat_age_sec}s ago`;
  return `integrator: ${status} (${age})`;
}
