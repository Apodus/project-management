import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables } from "../types.js";
import * as templateService from "../services/template.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const templateSchema = z
  .object({
    id: z.string(),
    projectId: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    templateType: z.string(),
    templateData: z.unknown().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    createdBy: z.string().nullable(),
  })
  .openapi("Template");

const templateDataEnvelope = z.object({
  data: templateSchema,
});

const templateListEnvelope = z.object({
  data: z.array(templateSchema),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ──────────────────────────────────────────────

const createTemplateBody = z
  .object({
    name: z.string().min(1, "Name is required"),
    description: z.string().nullable().optional(),
    project_id: z.string().nullable().optional(),
    template_type: z.enum(["task", "project"]),
    template_data: z.record(z.string(), z.unknown()),
    created_by: z.string().nullable().optional(),
  })
  .openapi("CreateTemplate");

const updateTemplateBody = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    template_data: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("UpdateTemplate");

const instantiateBody = z
  .object({
    project_id: z.string().optional(),
    workspace_id: z.string().optional(),
    name: z.string().optional(),
    overrides: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("InstantiateTemplate");

const createTemplateFromTaskBody = z
  .object({
    name: z.string().min(1, "Name is required"),
    description: z.string().optional(),
  })
  .openapi("CreateTemplateFromTask");

const templateIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const taskIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

// ─── Route definitions ────────────────────────────────────────────

const listTemplatesRoute = createRoute({
  method: "get",
  path: "/api/v1/templates",
  tags: ["Templates"],
  summary: "List templates",
  description: "List templates with optional filters for project_id and template_type.",
  request: {
    query: z.object({
      project_id: z.string().optional(),
      template_type: z.enum(["task", "project"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "List of templates",
      content: { "application/json": { schema: templateListEnvelope } },
    },
  },
});

const createTemplateRoute = createRoute({
  method: "post",
  path: "/api/v1/templates",
  tags: ["Templates"],
  summary: "Create template",
  description: "Create a new task or project template.",
  request: {
    body: {
      content: { "application/json": { schema: createTemplateBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Template created",
      content: { "application/json": { schema: templateDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updateTemplateRoute = createRoute({
  method: "patch",
  path: "/api/v1/templates/{id}",
  tags: ["Templates"],
  summary: "Update template",
  description: "Update a template's name, description, or template_data.",
  request: {
    params: z.object({ id: templateIdParam }),
    body: {
      content: { "application/json": { schema: updateTemplateBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Template updated",
      content: { "application/json": { schema: templateDataEnvelope } },
    },
    404: {
      description: "Template not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deleteTemplateRoute = createRoute({
  method: "delete",
  path: "/api/v1/templates/{id}",
  tags: ["Templates"],
  summary: "Delete template",
  description: "Delete a template.",
  request: {
    params: z.object({ id: templateIdParam }),
  },
  responses: {
    200: {
      description: "Template deleted",
      content: { "application/json": { schema: templateDataEnvelope } },
    },
    404: {
      description: "Template not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const instantiateTemplateRoute = createRoute({
  method: "post",
  path: "/api/v1/templates/{id}/instantiate",
  tags: ["Templates"],
  summary: "Instantiate template",
  description:
    "Create a task or project from a template. For task templates, provide project_id. For project templates, provide workspace_id and name.",
  request: {
    params: z.object({ id: templateIdParam }),
    body: {
      content: { "application/json": { schema: instantiateBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Template instantiated",
      content: {
        "application/json": {
          schema: z.object({ data: z.unknown() }),
        },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Template not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const createTemplateFromTaskRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/{id}/create-template",
  tags: ["Templates"],
  summary: "Create template from task",
  description: "Snapshot a task (with subtasks) as a task template.",
  request: {
    params: z.object({ id: taskIdParam }),
    body: {
      content: { "application/json": { schema: createTemplateFromTaskBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Template created from task",
      content: { "application/json": { schema: templateDataEnvelope } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createTemplateRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/templates
  router.openapi(listTemplatesRoute, (c) => {
    const { project_id, template_type } = c.req.valid("query");
    const templatesList = templateService.list(project_id, template_type);

    return c.json({ data: templatesList }, 200);
  });

  // POST /api/v1/templates
  router.openapi(createTemplateRoute, (c) => {
    const body = c.req.valid("json");
    const template = templateService.create({
      projectId: body.project_id ?? null,
      name: body.name,
      description: body.description ?? null,
      templateType: body.template_type,
      templateData: body.template_data as any,
      createdBy: body.created_by ?? null,
    });

    return c.json({ data: template }, 201);
  });

  // PATCH /api/v1/templates/:id
  router.openapi(updateTemplateRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const template = templateService.update(id, {
      name: body.name,
      description: body.description,
      templateData: body.template_data as any,
    });

    return c.json({ data: template }, 200);
  });

  // DELETE /api/v1/templates/:id
  router.openapi(deleteTemplateRoute, (c) => {
    const { id } = c.req.valid("param");
    const template = templateService.deleteTemplate(id);

    return c.json({ data: template }, 200);
  });

  // POST /api/v1/templates/:id/instantiate
  router.openapi(instantiateTemplateRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const template = templateService.getById(id);

    if (template.templateType === "task") {
      if (!body.project_id) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "project_id is required for task templates.",
            },
          },
          400 as any,
        );
      }

      const result = templateService.instantiateTaskTemplate(
        id,
        body.project_id,
        body.overrides as any,
      );

      return c.json({ data: result }, 201);
    }

    if (template.templateType === "project") {
      if (!body.workspace_id) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "workspace_id is required for project templates.",
            },
          },
          400 as any,
        );
      }

      const result = templateService.instantiateProjectTemplate(
        id,
        body.workspace_id,
        {
          name: body.name,
          description: body.overrides?.description as string | undefined,
        },
      );

      return c.json({ data: result }, 201);
    }

    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: `Unknown template type: ${template.templateType}`,
        },
      },
      400 as any,
    );
  });

  // POST /api/v1/tasks/:id/create-template
  router.openapi(createTemplateFromTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const template = templateService.createTemplateFromTask(
      id,
      body.name,
      body.description,
    );

    return c.json({ data: template }, 201);
  });

  return router;
}
