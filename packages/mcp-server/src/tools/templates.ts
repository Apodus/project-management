import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiRequest } from "../api-client.js";

// ─── Types ────────────────────────────────────────────────────────

interface TemplateSummary {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  templateType: string;
  templateData: unknown;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

// ─── Query-string helper ─────────────────────────────────────────

function qs(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      parts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      );
    }
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

// ─── Tool registration ──────────────────────────────────────────

export function registerTemplateTools(server: McpServer): void {
  // ---- pm_list_templates ----

  server.tool(
    "pm_list_templates",
    "List available task and project templates. Optionally filter by project_id (includes workspace-level templates) or template_type.",
    {
      project_id: z
        .string()
        .optional()
        .describe("Filter templates by project ID (also includes workspace-level templates)"),
      template_type: z
        .enum(["task", "project"])
        .optional()
        .describe("Filter by template type: 'task' or 'project'"),
    },
    async ({ project_id, template_type }) => {
      const params: Record<string, string | undefined> = {};
      if (project_id) params.project_id = project_id;
      if (template_type) params.template_type = template_type;

      const templates = await apiRequest<TemplateSummary[]>(
        "GET",
        `/templates${qs(params)}`,
      );

      if (templates.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No templates found.",
            },
          ],
        };
      }

      const lines = templates.map((t) => {
        const scope = t.projectId ? `Project: ${t.projectId}` : "Workspace-level";
        return [
          `- **${t.name}** (${t.templateType})`,
          `  ID: ${t.id}`,
          `  Scope: ${scope}`,
          `  ${t.description ?? "(no description)"}`,
        ].join("\n");
      });

      return {
        content: [
          {
            type: "text" as const,
            text: lines.join("\n\n"),
          },
        ],
      };
    },
  );

  // ---- pm_use_template ----

  server.tool(
    "pm_use_template",
    "Instantiate a template to create tasks or a project. For task templates, provide template_id and project_id. For project templates, provide template_id, workspace_id, and name. Optionally pass overrides to customize the created entities.",
    {
      template_id: z.string().describe("The template ID to instantiate"),
      project_id: z
        .string()
        .optional()
        .describe("Project ID (required for task templates)"),
      workspace_id: z
        .string()
        .optional()
        .describe("Workspace ID (required for project templates)"),
      name: z
        .string()
        .optional()
        .describe("Name for the created project (required for project templates)"),
      overrides: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Override template defaults (e.g., title, description, priority)"),
    },
    async ({ template_id, project_id, workspace_id, name, overrides }) => {
      const body: Record<string, unknown> = {};
      if (project_id) body.project_id = project_id;
      if (workspace_id) body.workspace_id = workspace_id;
      if (name) body.name = name;
      if (overrides) body.overrides = overrides;

      const result = await apiRequest<unknown>(
        "POST",
        `/templates/${encodeURIComponent(template_id)}/instantiate`,
        body,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Template instantiated successfully.",
              "",
              "**Result:**",
              JSON.stringify(result, null, 2),
            ].join("\n"),
          },
        ],
      };
    },
  );
}
