import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getIntegratorHealth, type IntegratorHealthView } from "../api-client.js";

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

function render(view: IntegratorHealthView): string {
  const tri = triState(view);
  const lines: string[] = [];
  lines.push(`Integrator health — ${view.resource} lane`);
  lines.push("");
  lines.push(`  State: ${tri.toUpperCase()}`);

  const age =
    view.staleness_ms === null
      ? "never heartbeated"
      : `${Math.round(view.staleness_ms / 1000)}s ago`;
  lines.push(`  Last heartbeat: ${age}`);

  const laneStatus = view.status === "never_seen" ? "unknown" : view.status;
  lines.push(`  Lane status: ${laneStatus}`);
  lines.push(`  Version: ${view.version ?? "unknown"}`);

  if (view.pool_size !== null || view.pool_leased !== null) {
    lines.push(`  Pool: ${view.pool_leased ?? "?"}/${view.pool_size ?? "?"} leased`);
  }
  lines.push(
    `  In-flight: requests=${view.in_flight_requests}, batches=${view.in_flight_batches}, groups=${view.in_flight_groups}`,
  );

  if (view.last_release_failure) {
    lines.push(
      `  Last release failure: ${view.last_release_failure.at} — ${view.last_release_failure.message}`,
    );
  }

  if (tri === "down") {
    lines.push("");
    lines.push(
      "  ⚠ No live heartbeat — the queue is not being consumed; restart the integrator daemon.",
    );
  }

  return lines.join("\n");
}

export function registerIntegratorHealthTools(server: McpServer): void {
  server.tool(
    "pm_get_integrator_health",
    "Read a merge-train lane's integrator health: the derived liveness tri-state (alive / stale / down), how long ago the daemon last heartbeated, the lane status (idle / integrating), the integrator version, agent-pool utilization, in-flight request/batch/group counts, and the last release failure if any. Use this to diagnose a stalled queue — DOWN means the daemon isn't consuming the queue (restart it), STALE means a heartbeat exists but is old, ALIVE + integrating means a verify is in progress (wait). Any authenticated user.",
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
