import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { search } from "../api-client.js";

export function registerSearchTools(server: McpServer): void {
  server.tool(
    "pm_search",
    "Full-text search across proposals, tasks, and comments. Returns results with entity_type, entity_id, title, excerpt, and relevance score.",
    {
      query: z.string().describe("The search query string"),
      project_id: z.string().optional().describe("Limit search to a specific project"),
      entity_type: z
        .enum(["proposal", "task", "comment"])
        .optional()
        .describe("Limit search to a specific entity type"),
      limit: z.number().optional().describe("Maximum number of results (default 20, max 100)"),
    },
    async ({ query, project_id, entity_type, limit }) => {
      const results = await search(query, { project_id, entity_type, limit });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results found for "${query}".`,
            },
          ],
        };
      }

      const text = results
        .map(
          (r) =>
            `- [${r.entityType}] **${r.title}**\n  ID: ${r.entityId}${r.projectId ? ` | Project: ${r.projectId}` : ""}\n  ${r.excerpt}`,
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${results.length} result(s) for "${query}":\n\n${text}`,
          },
        ],
      };
    },
  );
}
