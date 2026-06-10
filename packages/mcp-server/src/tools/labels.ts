import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listLabels } from "../api-client.js";

export function registerLabelTools(server: McpServer): void {
  // ---- pm_list_labels ----

  server.tool(
    "pm_list_labels",
    "List the labels defined in a project (name, id, color, description). Labels are the subsystem/area tags consumed by pm_list_tasks label_name and pm_awareness_check label — call this first to discover the valid names instead of guessing.",
    {
      project_id: z.string().describe("The project ID to list labels for"),
    },
    async ({ project_id }) => {
      const labels = await listLabels(project_id);

      if (labels.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No labels in this project. Labels are created by humans in the web UI; pm_list_tasks label_name only matches existing names.",
            },
          ],
        };
      }

      const lines = labels.map((l) => {
        const color = l.color ? `, color ${l.color}` : "";
        const desc = l.description ? ` — ${l.description}` : "";
        return `- **${l.name}** — ID: ${l.id}${color}${desc}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${labels.length} label(s) in project ${project_id}:\n${lines.join("\n")}`,
          },
        ],
      };
    },
  );
}
