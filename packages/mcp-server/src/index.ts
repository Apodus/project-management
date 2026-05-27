import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources/index.js";

/**
 * Create and configure the MCP server instance.
 * Exported for testing.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "project-management",
    version: "0.1.0",
  });

  registerAllTools(server);
  registerAllResources(server);

  return server;
}

/**
 * Main entry point — start the MCP server on stdio.
 */
async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`);
  process.exit(1);
});
