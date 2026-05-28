import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkUpdates } from "../api-client.js";

export function registerUpdateTools(server: McpServer): void {
  server.tool(
    "pm_check_updates",
    "Check for recent activity by other users (typically the human director) since a given timestamp. Call this between work steps to stay aware of human input.",
    {
      since: z
        .string()
        .describe(
          "ISO 8601 timestamp. Use the timestamp from when you last checked (or when you started working).",
        ),
      project_id: z
        .string()
        .optional()
        .describe("Scope to a specific project."),
    },
    async ({ since, project_id }) => {
      let result;
      try {
        result = await checkUpdates(since, project_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to check updates: ${message}`,
            },
          ],
        };
      }

      if (!result.has_updates) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No updates since ${since}.`,
            },
          ],
        };
      }

      const sections: string[] = [
        `${result.count} update${result.count === 1 ? "" : "s"} since ${since}:`,
        "",
      ];

      for (const entry of result.data) {
        const changesStr =
          entry.changes && typeof entry.changes === "object"
            ? ` | Changes: ${JSON.stringify(entry.changes)}`
            : "";
        sections.push(
          `- [${entry.createdAt}] Actor ${entry.actorId ?? "unknown"}: ${entry.action} ${entry.entityType} ${entry.entityId}${changesStr}`,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: sections.join("\n"),
          },
        ],
      };
    },
  );
}
