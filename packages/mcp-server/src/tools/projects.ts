import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listProjects } from "../api-client.js";

export function registerProjectTools(server: McpServer): void {
  server.tool(
    "pm_list_projects",
    "List projects with optional status filter. Returns array of projects with id, name, slug, status, description.",
    {
      status: z
        .enum(["active", "paused", "archived", "completed"])
        .optional()
        .describe("Filter by project status"),
    },
    async ({ status }) => {
      const projects = await listProjects(status);

      const text = projects
        .map(
          (p) =>
            `- **${p.name}** (${p.slug})\n  ID: ${p.id}\n  Status: ${p.status}\n  ${p.description ?? "(no description)"}`,
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: projects.length > 0 ? text : "No projects found.",
          },
        ],
      };
    },
  );
}
