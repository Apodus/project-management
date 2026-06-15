import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables } from "../types.js";
import * as exportService from "../services/export.service.js";
import { workspaces } from "../db/index.js";
import { getDb } from "../db/index.js";

// ─── Response schemas ─────────────────────────────────────────────

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const projectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  gitRepoUrl: z.string().nullable(),
  settings: z.unknown().nullable(),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string().nullable(),
});

const importResponseEnvelope = z.object({
  data: projectSchema,
});

const backupResponseEnvelope = z.object({
  data: z.object({
    path: z.string(),
    size: z.number(),
    timestamp: z.string(),
  }),
});

// ─── Request schemas ──────────────────────────────────────────────

const projectIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "id", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

// ─── Route definitions ────────────────────────────────────────────

const exportProjectRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{id}/export",
  tags: ["Export/Import"],
  summary: "Export project",
  description:
    "Export a complete project and all related data as JSON. Optionally include the activity log.",
  request: {
    params: z.object({ id: projectIdParam }),
    query: z.object({
      include_activity: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Project exported as JSON",
      content: {
        "application/json": {
          schema: z.object({
            version: z.string(),
            exported_at: z.string(),
            project: z.record(z.string(), z.unknown()),
            proposals: z.array(z.record(z.string(), z.unknown())),
            epics: z.array(z.record(z.string(), z.unknown())),
            milestones: z.array(z.record(z.string(), z.unknown())),
            tasks: z.array(z.record(z.string(), z.unknown())),
            comments: z.array(z.record(z.string(), z.unknown())),
            labels: z.array(z.record(z.string(), z.unknown())),
            task_labels: z.array(z.record(z.string(), z.unknown())),
            task_dependencies: z.array(z.record(z.string(), z.unknown())),
            git_refs: z.array(z.record(z.string(), z.unknown())),
            activity_log: z.array(z.record(z.string(), z.unknown())).optional(),
          }),
        },
      },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const importProjectRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/import",
  tags: ["Export/Import"],
  summary: "Import project",
  description: "Import a project from previously exported JSON. Creates new IDs for all entities.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            version: z.string(),
            exported_at: z.string(),
            project: z.record(z.string(), z.unknown()),
            proposals: z.array(z.record(z.string(), z.unknown())),
            epics: z.array(z.record(z.string(), z.unknown())),
            milestones: z.array(z.record(z.string(), z.unknown())),
            tasks: z.array(z.record(z.string(), z.unknown())),
            comments: z.array(z.record(z.string(), z.unknown())),
            labels: z.array(z.record(z.string(), z.unknown())),
            task_labels: z.array(z.record(z.string(), z.unknown())),
            task_dependencies: z.array(z.record(z.string(), z.unknown())),
            git_refs: z.array(z.record(z.string(), z.unknown())),
            activity_log: z.array(z.record(z.string(), z.unknown())).optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Project imported",
      content: { "application/json": { schema: importResponseEnvelope } },
    },
    400: {
      description: "Invalid import data",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const backupRoute = createRoute({
  method: "post",
  path: "/api/v1/backup",
  tags: ["Export/Import"],
  summary: "Backup database",
  description: "Create a backup of the SQLite database file.",
  responses: {
    200: {
      description: "Backup created",
      content: { "application/json": { schema: backupResponseEnvelope } },
    },
    400: {
      description: "Backup error",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createExportRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:id/export
  router.openapi(exportProjectRoute, (c) => {
    const { id } = c.req.valid("param");
    const { include_activity } = c.req.valid("query");
    const includeActivity = include_activity === "true";

    const exportData = exportService.exportProject(id, { includeActivity });

    // Set Content-Disposition header for download
    c.header("Content-Disposition", `attachment; filename="project-${id}-export.json"`);

    return c.json(exportData, 200);
  });

  // POST /api/v1/projects/import
  router.openapi(importProjectRoute, (c) => {
    const body = c.req.valid("json");
    const currentUser = c.get("currentUser");
    const createdBy = currentUser?.id ?? "system";

    // Get first workspace
    const db = getDb();
    const ws = db.select().from(workspaces).all();
    if (ws.length === 0) {
      return c.json({ error: { code: "NO_WORKSPACE", message: "No workspace exists" } }, 400);
    }

    const project = exportService.importProject(body, ws[0].id, createdBy);

    return c.json({ data: project } as z.infer<typeof importResponseEnvelope>, 201);
  });

  // POST /api/v1/backup
  router.openapi(backupRoute, (c) => {
    const result = exportService.backupDatabase();

    return c.json({ data: result }, 200);
  });

  return router;
}
