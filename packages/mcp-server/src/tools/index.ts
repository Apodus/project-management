import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerProjectTools } from "./projects.js";
import { registerTaskTools } from "./tasks.js";
import { registerProposalTools } from "./proposals.js";
import { registerEpicTools } from "./epics.js";
import { registerLabelTools } from "./labels.js";
import { registerSearchTools } from "./search.js";
import { registerWorkflowTools } from "./workflow.js";
import { registerWriteTools } from "./write.js";
import { registerUpdateTools } from "./updates.js";
import { registerTemplateTools } from "./templates.js";
import { registerAgentTools } from "./agent.js";
import { registerMergeLockTools } from "./merge-locks.js";
import { registerMergeRequestTools } from "./merge-requests.js";
import { registerMergeGroupTools } from "./merge-groups.js";
import { registerNoteTools } from "./notes.js";
import { registerEscalationTools } from "./escalations.js";
import { registerCheckMessagesTool } from "./check-messages.js";

/**
 * Register all MCP tools on the server.
 */
export function registerAllTools(server: McpServer): void {
  registerProjectTools(server);
  registerTaskTools(server);
  registerProposalTools(server);
  registerEpicTools(server);
  registerLabelTools(server);
  registerSearchTools(server);
  registerWorkflowTools(server);
  registerWriteTools(server);
  registerUpdateTools(server);
  registerTemplateTools(server);
  registerAgentTools(server);
  registerMergeLockTools(server);
  registerMergeRequestTools(server);
  registerMergeGroupTools(server);
  registerNoteTools(server);
  registerEscalationTools(server);
  registerCheckMessagesTool(server);
}
