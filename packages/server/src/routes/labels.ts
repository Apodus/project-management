import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables } from "../types.js";
import * as labelService from "../services/label.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const labelSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    color: z.string().nullable(),
    description: z.string().nullable(),
  })
  .openapi("Label");

const labelDataEnvelope = z.object({
  data: labelSchema,
});

const labelListEnvelope = z.object({
  data: z.array(labelSchema),
  pagination: z.object({
    total: z.number(),
  }),
});

const taskLabelEnvelope = z.object({
  data: z.object({
    taskId: z.string(),
    labelId: z.string(),
  }),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ──────────────────────────────────────────────

const createLabelBody = z
  .object({
    name: z.string().min(1, "Name is required"),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color code")
      .nullable()
      .optional(),
    description: z.string().nullable().optional(),
  })
  .openapi("CreateLabel");

const updateLabelBody = z
  .object({
    name: z.string().min(1).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color code")
      .nullable()
      .optional(),
    description: z.string().nullable().optional(),
  })
  .openapi("UpdateLabel");

const attachLabelBody = z
  .object({
    labelId: z.string().min(1, "labelId is required"),
  })
  .openapi("AttachLabel");

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const labelIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const taskIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const taskLabelIdParam = z.string().min(1).openapi({
  param: { name: "labelId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

// ─── Route definitions ────────────────────────────────────────────

const listLabelsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/labels",
  tags: ["Labels"],
  summary: "List labels",
  description: "List all labels for a project.",
  request: {
    params: z.object({ projectId: projectIdParam }),
  },
  responses: {
    200: {
      description: "List of labels",
      content: { "application/json": { schema: labelListEnvelope } },
    },
  },
});

const createLabelRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/labels",
  tags: ["Labels"],
  summary: "Create label",
  description: "Create a new label for a project. Name must be unique within the project.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: {
      content: { "application/json": { schema: createLabelBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Label created",
      content: { "application/json": { schema: labelDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Label name already exists in this project",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updateLabelRoute = createRoute({
  method: "patch",
  path: "/api/v1/labels/{id}",
  tags: ["Labels"],
  summary: "Update label",
  description: "Update a label's name, color, or description.",
  request: {
    params: z.object({ id: labelIdParam }),
    body: {
      content: { "application/json": { schema: updateLabelBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Label updated",
      content: { "application/json": { schema: labelDataEnvelope } },
    },
    404: {
      description: "Label not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Label name already exists in this project",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deleteLabelRoute = createRoute({
  method: "delete",
  path: "/api/v1/labels/{id}",
  tags: ["Labels"],
  summary: "Delete label",
  description: "Delete a label and all its task associations.",
  request: {
    params: z.object({ id: labelIdParam }),
  },
  responses: {
    200: {
      description: "Label deleted",
      content: { "application/json": { schema: labelDataEnvelope } },
    },
    404: {
      description: "Label not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const attachLabelRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/{id}/labels",
  tags: ["Labels"],
  summary: "Attach label to task",
  description: "Attach a label to a task.",
  request: {
    params: z.object({ id: taskIdParam }),
    body: {
      content: { "application/json": { schema: attachLabelBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Label attached",
      content: { "application/json": { schema: taskLabelEnvelope } },
    },
    404: {
      description: "Task or label not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Label already attached to this task",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const detachLabelRoute = createRoute({
  method: "delete",
  path: "/api/v1/tasks/{id}/labels/{labelId}",
  tags: ["Labels"],
  summary: "Remove label from task",
  description: "Remove a label from a task.",
  request: {
    params: z.object({ id: taskIdParam, labelId: taskLabelIdParam }),
  },
  responses: {
    200: {
      description: "Label detached",
      content: { "application/json": { schema: taskLabelEnvelope } },
    },
    404: {
      description: "Label not attached to this task",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createLabelRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:projectId/labels
  router.openapi(listLabelsRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const labelsList = labelService.listByProject(projectId);

    return c.json(
      {
        data: labelsList,
        pagination: { total: labelsList.length },
      },
      200,
    );
  });

  // POST /api/v1/projects/:projectId/labels
  router.openapi(createLabelRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const label = labelService.create(projectId, body);

    return c.json({ data: label }, 201);
  });

  // PATCH /api/v1/labels/:id
  router.openapi(updateLabelRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const label = labelService.update(id, body);

    return c.json({ data: label }, 200);
  });

  // DELETE /api/v1/labels/:id
  router.openapi(deleteLabelRoute, (c) => {
    const { id } = c.req.valid("param");
    const label = labelService.deleteLabel(id);

    return c.json({ data: label }, 200);
  });

  // POST /api/v1/tasks/:id/labels
  router.openapi(attachLabelRoute, (c) => {
    const { id } = c.req.valid("param");
    const { labelId } = c.req.valid("json");
    const result = labelService.attachToTask(id, labelId);

    return c.json({ data: result }, 201);
  });

  // DELETE /api/v1/tasks/:id/labels/:labelId
  router.openapi(detachLabelRoute, (c) => {
    const { id, labelId } = c.req.valid("param");
    const result = labelService.detachFromTask(id, labelId);

    return c.json({ data: result }, 200);
  });

  return router;
}
