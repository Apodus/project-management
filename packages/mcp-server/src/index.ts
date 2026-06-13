import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources/index.js";
import { withPiggyback } from "./piggyback.js";
import { getWorkerKey } from "./worker-key.js";
import { VERSION } from "./version.js";
import {
  claimAgent,
  releaseAgent,
  agentHeartbeat,
  getAgentIdentity,
  shouldReleaseOnShutdown,
} from "./api-client.js";

/**
 * Create and configure the MCP server instance.
 * Exported for testing.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "project-management",
    version: VERSION,
  });

  // Wrap server.tool BEFORE registering tools so every tool response can carry
  // the unread-escalation-replies piggyback (C2 §P3) — best-effort, byte-
  // identical when no PM_WORKER_KEY / no unread / lookup throws.
  withPiggyback(server, getWorkerKey);

  registerAllTools(server);
  registerAllResources(server);

  return server;
}

// ─── Lifecycle management ─────────────────────────────────────────

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Auto-claim an agent from the pool if PM_API_TOKEN is not set but
 * PM_POOL_SECRET is. Returns true if an agent was claimed (or PM_API_TOKEN
 * was already set), false if neither is available.
 */
async function autoClaimAgent(): Promise<boolean> {
  // If a static token is set, use it directly (backward compatible)
  if (process.env.PM_API_TOKEN) {
    return true;
  }

  const poolSecret = process.env.PM_POOL_SECRET;
  if (!poolSecret) {
    return false;
  }

  const poolName = process.env.PM_POOL_NAME ?? "default";
  const workerKey = process.env.PM_WORKER_KEY?.trim() || undefined;

  try {
    const result = await claimAgent(poolName, poolSecret, workerKey);
    const identity = getAgentIdentity();
    process.stderr.write(
      `Agent claimed: ${identity?.displayName ?? result.user.username} (${result.user.id})\n`,
    );
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to claim agent: ${message}\n`);
    return false;
  }
}

/**
 * Start the heartbeat interval (every 5 minutes).
 */
function startHeartbeat(): void {
  if (heartbeatInterval) return;

  const HEARTBEAT_MS = 5 * 60 * 1000; // 5 minutes

  heartbeatInterval = setInterval(async () => {
    try {
      await agentHeartbeat();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Heartbeat failed: ${message}\n`);
    }
  }, HEARTBEAT_MS);

  // Don't let the heartbeat interval keep the process alive
  if (heartbeatInterval && typeof heartbeatInterval === "object" && "unref" in heartbeatInterval) {
    (heartbeatInterval as NodeJS.Timeout).unref();
  }
}

/**
 * Clean up: release agent and stop heartbeat.
 */
async function cleanup(): Promise<void> {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Only release a keyless pool claim (legacy behavior). When PM_WORKER_KEY is
  // set, the binding is durable by design (it outlives the TTL so the next
  // respawn re-binds the SAME identity); the server's releaseAgent deletes the
  // claim with NO worker_key filter, so releasing on shutdown would strand the
  // keyed binding and force the next respawn to first-bind a NEW identity —
  // defeating stable-identity (C1). See shouldReleaseOnShutdown.
  if (shouldReleaseOnShutdown()) {
    try {
      await releaseAgent();
      process.stderr.write("Agent released.\n");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Failed to release agent: ${message}\n`);
    }
  }
}

/**
 * Main entry point — start the MCP server on stdio.
 */
async function main(): Promise<void> {
  // Auto-claim an agent if needed
  const hasAuth = await autoClaimAgent();
  if (!hasAuth) {
    process.stderr.write(
      "Warning: Neither PM_API_TOKEN nor PM_POOL_SECRET is set. API calls will fail.\n",
    );
  }

  // Start heartbeat if we claimed via pool
  if (!process.env.PM_API_TOKEN && process.env.PM_POOL_SECRET && getAgentIdentity()) {
    startHeartbeat();
  }

  // Register cleanup handlers
  const doCleanup = () => {
    cleanup().finally(() => process.exit(0));
  };

  process.on("SIGTERM", doCleanup);
  process.on("SIGINT", doCleanup);

  // Detect stdin close (parent process died)
  process.stdin.on("end", () => {
    cleanup().finally(() => process.exit(0));
  });

  const server = createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`);
  process.exit(1);
});
