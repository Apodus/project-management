import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getIntegratorHealth, type IntegratorHealthView } from "../api-client.js";
import { formatInstant, renderClockLine } from "../time.js";

const resourceDesc =
  "Lane resource name (default: 'main'). Names the train lane whose integrator you want the health of. Use 'main' unless told otherwise.";

// Derived liveness tri-state from the health view: no row ever seen → down;
// heartbeat within the staleness cutoff → alive; otherwise stale (a heartbeat
// exists but is old — the daemon likely crashed mid-run). Reading fires the
// train.integrator_unhealthy edge server-side.
function triState(view: IntegratorHealthView): "alive" | "stale" | "down" {
  if (view.last_seen_at === null) return "down";
  return view.healthy ? "alive" : "stale";
}

/**
 * Every verify worktree leased while the lane reports NOTHING in flight — the
 * leaked-slot signature (2026-08-02). Mirrors the server-side `pool_stranded`
 * derivation in integrator-liveness.service.ts; kept here too so the health
 * tool says it even when the caller never reads a lock or a request.
 *
 * A pool fully leased DURING a batch is normal — but that lane reports
 * in-flight work, which is exactly what this predicate excludes.
 */
function isPoolStranded(view: IntegratorHealthView): boolean {
  return (
    view.pool_size !== null &&
    view.pool_size > 0 &&
    (view.pool_leased ?? 0) >= view.pool_size &&
    view.in_flight_requests === 0 &&
    view.in_flight_batches === 0 &&
    view.in_flight_groups === 0
  );
}

function render(view: IntegratorHealthView): string {
  const tri = triState(view);
  const lines: string[] = [];
  lines.push(`Integrator health — ${view.resource} lane`);
  lines.push(renderClockLine());
  lines.push("");
  lines.push(`  State: ${tri.toUpperCase()}`);

  // Age FIRST (the decision-grade number), absolute instant second — this
  // ordering is the whole point: a reader who stops at the first value already
  // has the answer and never reaches for a local clock.
  // Seconds precision, NOT formatAge's coarser buckets: the staleness cutoff
  // is 90s and the beat cadence is 30s, so "2m" would blur the exact
  // distinction this line exists to make. The absolute instant trails the age.
  const age =
    view.staleness_ms === null
      ? "never heartbeated"
      : view.last_seen_at
        ? `${Math.round(view.staleness_ms / 1000)}s ago   (${view.last_seen_at})`
        : `${Math.round(view.staleness_ms / 1000)}s ago`;
  lines.push(`  Last heartbeat: ${age}`);

  const laneStatus = view.status === "never_seen" ? "unknown" : view.status;
  lines.push(`  Lane status: ${laneStatus}`);
  lines.push(`  Version: ${view.version ?? "unknown"}`);

  if (view.pool_size !== null || view.pool_leased !== null) {
    lines.push(
      `  Verify worktree pool: ${view.pool_leased ?? "?"}/${view.pool_size ?? "?"} leased (single-repo lane only)`,
    );
  }
  lines.push(
    `  In-flight: requests=${view.in_flight_requests}, batches=${view.in_flight_batches}, groups=${view.in_flight_groups}`,
  );

  // The pool counter is minted from the SINGLE-REPO batch WorktreePool
  // (integrator-ref/heartbeat.ts). A cross-repo group leases from the separate
  // per-repo pools, so it legitimately reads 0 leased while a group verifies —
  // and a "0/1 leased" was once read as corroboration that a healthy in-flight
  // group was wedged. Say what the zero means, on the read where it appears.
  if (view.in_flight_groups > 0 && (view.pool_leased ?? 0) === 0) {
    lines.push(
      "    (0 leased is EXPECTED here: a cross-repo group verifies from the per-repo pools, which this counter does not track — not an idle integrator.)",
    );
  }

  if (view.last_release_failure) {
    lines.push(
      `  Last release failure: ${formatInstant(view.last_release_failure.at)} — ${view.last_release_failure.message}`,
    );
  }

  if (tri === "down") {
    lines.push("");
    lines.push(
      "  ⚠ No live heartbeat — the queue is not being consumed; restart the integrator daemon.",
    );
  } else if (tri === "alive" && isPoolStranded(view)) {
    // The hardest stall to read from outside, and the reason this hint exists:
    // on 2026-08-02 a leaked worktree slot wedged the lane for 9h while every
    // other signal — heartbeat age, lane status, in-flight counts — read
    // perfectly healthy. The tell is right here in the numbers: all slots
    // leased AND nothing in flight is impossible on a working daemon.
    lines.push("");
    lines.push(
      "  ⚠ WEDGED: every verify worktree is leased while NOTHING is in flight — a leaked slot.",
    );
    lines.push(
      "    The heartbeat is healthy and the lane will keep looking alive, but it can admit no",
    );
    lines.push("    work: the queue will not move until the daemon is restarted.");
  } else if (tri === "alive" && view.status === "integrating") {
    // The positive counterpart to the DOWN hint. A fresh heartbeat is the ONLY
    // evidence that distinguishes "slow verify" from "wedged" — elapsed time
    // never is — so state the conclusion here instead of leaving a reader to
    // reach it from a wall clock.
    lines.push("");
    lines.push(
      "  ✓ Heartbeat is live and the lane is INTEGRATING — verify is running. Wait; do not cancel or resubmit on elapsed time alone.",
    );
  }

  return lines.join("\n");
}

export function registerIntegratorHealthTools(server: McpServer): void {
  server.tool(
    "pm_get_integrator_health",
    "Read a merge-train lane's integrator health: the derived liveness tri-state (alive / stale / down), how long ago the daemon last heartbeated, the lane status (idle / integrating), the integrator version, agent-pool utilization, in-flight request/batch/group counts, and the last release failure if any. Use this to diagnose a stalled queue — DOWN means the daemon isn't consuming the queue (restart it), STALE means a heartbeat exists but is old, ALIVE + integrating means a verify is in progress (wait). THIS — heartbeat freshness — is the evidence for a stall; elapsed wall-clock time is not, and a long-running cross-repo verify is normal. Ages here are pre-computed and the output carries a UTC-now/local-now clock line: never diff a Z timestamp against local `date`. Any authenticated user.",
    {
      project_id: z.string().describe("The project ID."),
      resource: z.string().optional().default("main").describe(resourceDesc),
    },
    async ({ project_id, resource }) => {
      const view = await getIntegratorHealth(project_id, resource ?? "main");
      return { content: [{ type: "text" as const, text: render(view) }] };
    },
  );
}
