import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables } from "../types.js";
import * as automationService from "../services/automation.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const automationRuleSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    triggerEvent: z.string(),
    conditions: z.unknown().nullable(),
    actionType: z.string(),
    actionConfig: z.unknown().nullable(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    createdBy: z.string().nullable(),
  })
  .openapi("AutomationRule");

const ruleDataEnvelope = z.object({
  data: automationRuleSchema,
});

const ruleListEnvelope = z.object({
  data: z.array(automationRuleSchema),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ─────────────────────────────────────────────

const conditionSchema = z.object({
  field: z.string(),
  operator: z.enum(["eq", "neq", "in", "not_in", "contains"]),
  value: z.unknown(),
});

const createRuleBody = z
  .object({
    name: z.string().min(1, "Name is required"),
    description: z.string().nullable().optional(),
    triggerEvent: z.string().min(1, "Trigger event is required"),
    conditions: z.array(conditionSchema).nullable().optional(),
    actionType: z.string().min(1, "Action type is required"),
    actionConfig: z.record(z.string(), z.unknown()).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .openapi("CreateAutomationRule");

const updateRuleBody = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    triggerEvent: z.string().min(1).optional(),
    conditions: z.array(conditionSchema).nullable().optional(),
    actionType: z.string().min(1).optional(),
    actionConfig: z.record(z.string(), z.unknown()).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .openapi("UpdateAutomationRule");

const toggleBody = z
  .object({
    active: z.boolean(),
  })
  .openapi("ToggleAutomationRule");

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const ruleIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

// ─── Route definitions ──────────────────────────────────────────

const listRulesRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/automation-rules",
  tags: ["Automation"],
  summary: "List automation rules",
  description: "List all automation rules for a project.",
  request: {
    params: z.object({ projectId: projectIdParam }),
  },
  responses: {
    200: {
      description: "List of automation rules",
      content: { "application/json": { schema: ruleListEnvelope } },
    },
  },
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/automation-rules",
  tags: ["Automation"],
  summary: "Create automation rule",
  description: "Create a new automation rule for a project.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: {
      content: { "application/json": { schema: createRuleBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Rule created",
      content: { "application/json": { schema: ruleDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updateRuleRoute = createRoute({
  method: "patch",
  path: "/api/v1/automation-rules/{id}",
  tags: ["Automation"],
  summary: "Update automation rule",
  description: "Update an automation rule.",
  request: {
    params: z.object({ id: ruleIdParam }),
    body: {
      content: { "application/json": { schema: updateRuleBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Rule updated",
      content: { "application/json": { schema: ruleDataEnvelope } },
    },
    404: {
      description: "Rule not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deleteRuleRoute = createRoute({
  method: "delete",
  path: "/api/v1/automation-rules/{id}",
  tags: ["Automation"],
  summary: "Delete automation rule",
  description: "Delete an automation rule.",
  request: {
    params: z.object({ id: ruleIdParam }),
  },
  responses: {
    200: {
      description: "Rule deleted",
      content: {
        "application/json": {
          schema: z.object({ data: z.object({ deleted: z.boolean() }) }),
        },
      },
    },
    404: {
      description: "Rule not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const toggleRuleRoute = createRoute({
  method: "post",
  path: "/api/v1/automation-rules/{id}/toggle",
  tags: ["Automation"],
  summary: "Toggle automation rule",
  description: "Enable or disable an automation rule.",
  request: {
    params: z.object({ id: ruleIdParam }),
    body: {
      content: { "application/json": { schema: toggleBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Rule toggled",
      content: { "application/json": { schema: ruleDataEnvelope } },
    },
    404: {
      description: "Rule not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ─────────────────────────────────────────────────────

export function createAutomationRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:projectId/automation-rules
  router.openapi(listRulesRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const rules = automationService.list(projectId);
    return c.json({ data: rules }, 200);
  });

  // POST /api/v1/projects/:projectId/automation-rules
  router.openapi(createRuleRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser");

    const rule = automationService.create({
      projectId,
      name: body.name,
      description: body.description ?? null,
      triggerEvent: body.triggerEvent,
      conditions: body.conditions as automationService.Condition[] | null ?? null,
      actionType: body.actionType,
      actionConfig: body.actionConfig ?? null,
      isActive: body.isActive ?? true,
      createdBy: user?.id ?? null,
    });

    return c.json({ data: rule }, 201);
  });

  // PATCH /api/v1/automation-rules/:id
  router.openapi(updateRuleRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const rule = automationService.update(id, {
      name: body.name,
      description: body.description,
      triggerEvent: body.triggerEvent,
      conditions: body.conditions as automationService.Condition[] | null | undefined,
      actionType: body.actionType,
      actionConfig: body.actionConfig,
      isActive: body.isActive,
    });

    return c.json({ data: rule }, 200);
  });

  // DELETE /api/v1/automation-rules/:id
  router.openapi(deleteRuleRoute, (c) => {
    const { id } = c.req.valid("param");
    automationService.deleteRule(id);
    return c.json({ data: { deleted: true } }, 200);
  });

  // POST /api/v1/automation-rules/:id/toggle
  router.openapi(toggleRuleRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const rule = automationService.toggle(id, body.active);
    return c.json({ data: rule }, 200);
  });

  return router;
}
