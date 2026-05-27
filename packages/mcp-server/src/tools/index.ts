import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerProjectTools } from "./projects.js";
import { registerTaskTools } from "./tasks.js";
import { registerProposalTools } from "./proposals.js";
import { registerSearchTools } from "./search.js";
import { registerWorkflowTools } from "./workflow.js";

/**
 * Register all MCP tools on the server.
 */
export function registerAllTools(server: McpServer): void {
  registerProjectTools(server);
  registerTaskTools(server);
  registerProposalTools(server);
  registerSearchTools(server);
  registerWorkflowTools(server);
}
