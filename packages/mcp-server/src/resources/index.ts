import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listProjects, listProposals, getProjectTasks } from "../api-client.js";

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
  const proposalTemplate = new ResourceTemplate("pm://project/{id}/proposals", { list: undefined });

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

  // pm://project/{id}/board — Tasks grouped by status (kanban-style)
  const boardTemplate = new ResourceTemplate("pm://project/{id}/board", { list: undefined });

  server.resource(
    "project-board",
    boardTemplate,
    {
      description: "Kanban-style board showing tasks grouped by status for a project",
      mimeType: "text/plain",
    },
    async (uri: URL, params: Record<string, string | string[]>) => {
      const rawId = params.id;
      const projectId = Array.isArray(rawId) ? rawId[0] : rawId;
      const tasks = await getProjectTasks(projectId);

      // Define status columns in order
      const statusOrder = ["backlog", "ready", "in_progress", "in_review", "done"];
      const columns: Record<string, typeof tasks> = {};
      for (const status of statusOrder) {
        columns[status] = [];
      }

      // Group tasks by status
      for (const task of tasks) {
        if (columns[task.status]) {
          columns[task.status].push(task);
        } else {
          // Handle any unexpected status
          if (!columns[task.status]) {
            columns[task.status] = [];
          }
          columns[task.status].push(task);
        }
      }

      // Build formatted board output
      const sections: string[] = [
        `Board for project ${projectId}`,
        "=".repeat(40),
        "",
        `Total tasks: ${tasks.length}`,
        "",
      ];

      for (const status of statusOrder) {
        const col = columns[status];
        sections.push(`## ${status.toUpperCase()} (${col.length})`);
        if (col.length === 0) {
          sections.push("  (empty)", "");
        } else {
          for (const t of col) {
            sections.push(`  - [${t.priority.toUpperCase()}] ${t.title} (${t.id})`);
          }
          sections.push("");
        }
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: sections.join("\n"),
          },
        ],
      };
    },
  );
}
