import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listProjects, listProposals } from "../api-client.js";

/**
 * Register all MCP resources on the server.
 */
export function registerAllResources(server: McpServer): void {
  // pm://projects — List of active projects
  server.resource(
    "projects",
    "pm://projects",
    {
      description: "List of active projects in the project management system",
      mimeType: "text/plain",
    },
    async () => {
      const projects = await listProjects("active");

      const text =
        projects.length > 0
          ? projects
              .map(
                (p) =>
                  `${p.name} (${p.slug})\n  ID: ${p.id}\n  Status: ${p.status}\n  ${p.description ?? "(no description)"}`,
              )
              .join("\n\n")
          : "No active projects.";

      return {
        contents: [
          {
            uri: "pm://projects",
            mimeType: "text/plain",
            text: `Active Projects\n${"=".repeat(40)}\n\n${text}`,
          },
        ],
      };
    },
  );

  // pm://project/{id}/proposals — Active proposals for a project
  const proposalTemplate = new ResourceTemplate(
    "pm://project/{id}/proposals",
    { list: undefined },
  );

  server.resource(
    "project-proposals",
    proposalTemplate,
    {
      description: "Active proposals for a specific project with status counts",
      mimeType: "text/plain",
    },
    async (uri: URL, params: Record<string, string | string[]>) => {
      const rawId = params.id;
      const projectId = Array.isArray(rawId) ? rawId[0] : rawId;
      const proposals = await listProposals(projectId);

      // Compute status counts
      const statusCounts: Record<string, number> = {};
      for (const p of proposals) {
        statusCounts[p.status] = (statusCounts[p.status] ?? 0) + 1;
      }

      const countLine = Object.entries(statusCounts)
        .map(([status, count]) => `${status}: ${count}`)
        .join(" | ");

      const text =
        proposals.length > 0
          ? proposals
              .map(
                (p) =>
                  `${p.title}\n  ID: ${p.id}\n  Status: ${p.status}\n  ${p.description ? p.description.slice(0, 200) : "(no description)"}`,
              )
              .join("\n\n")
          : "No proposals for this project.";

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: `Proposals for project ${projectId}\n${"=".repeat(40)}\n${countLine ? `\nStatus counts: ${countLine}\n` : ""}\n${text}`,
          },
        ],
      };
    },
  );
}
