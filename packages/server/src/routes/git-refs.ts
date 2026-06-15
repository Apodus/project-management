import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { GIT_REF_TYPES, GIT_REF_STATUSES } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as gitRefService from "../services/git-ref.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const gitRefSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    refType: z.string(),
    refValue: z.string(),
    url: z.string().nullable(),
    title: z.string().nullable(),
    status: z.string().nullable(),
    metadata: z.unknown().nullable(),
    createdAt: z.string(),
  })
  .openapi("GitRef");

const gitRefDataEnvelope = z.object({
  data: gitRefSchema,
});

const gitRefListEnvelope = z.object({
  data: z.array(gitRefSchema),
  pagination: z.object({
    total: z.number(),
  }),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ──────────────────────────────────────────────

const createGitRefBody = z
  .object({
    refType: z.enum(GIT_REF_TYPES),
    refValue: z.string().min(1, "refValue is required"),
    url: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    status: z.enum(GIT_REF_STATUSES).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("CreateGitRef");

const updateGitRefBody = z
  .object({
    refType: z.enum(GIT_REF_TYPES).optional(),
    refValue: z.string().min(1).optional(),
    url: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    status: z.enum(GIT_REF_STATUSES).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("UpdateGitRef");

const taskIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "taskId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const gitRefIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "id", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

// ─── Route definitions ────────────────────────────────────────────

const listGitRefsRoute = createRoute({
  method: "get",
  path: "/api/v1/tasks/{taskId}/git-refs",
  tags: ["Git Refs"],
  summary: "List git refs for task",
  description: "List all git refs (branches, commits, PRs) linked to a task.",
  request: {
    params: z.object({ taskId: taskIdParam }),
  },
  responses: {
    200: {
      description: "List of git refs",
      content: { "application/json": { schema: gitRefListEnvelope } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const createGitRefRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/{taskId}/git-refs",
  tags: ["Git Refs"],
  summary: "Add git ref",
  description: "Add a git ref (branch, commit, or pull request) to a task.",
  request: {
    params: z.object({ taskId: taskIdParam }),
    body: {
      content: { "application/json": { schema: createGitRefBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Git ref created",
      content: { "application/json": { schema: gitRefDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updateGitRefRoute = createRoute({
  method: "patch",
  path: "/api/v1/git-refs/{id}",
  tags: ["Git Refs"],
  summary: "Update git ref",
  description: "Update a git ref (e.g., PR status).",
  request: {
    params: z.object({ id: gitRefIdParam }),
    body: {
      content: { "application/json": { schema: updateGitRefBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Git ref updated",
      content: { "application/json": { schema: gitRefDataEnvelope } },
    },
    404: {
      description: "Git ref not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deleteGitRefRoute = createRoute({
  method: "delete",
  path: "/api/v1/git-refs/{id}",
  tags: ["Git Refs"],
  summary: "Remove git ref",
  description: "Remove a git ref from a task.",
  request: {
    params: z.object({ id: gitRefIdParam }),
  },
  responses: {
    200: {
      description: "Git ref deleted",
      content: { "application/json": { schema: gitRefDataEnvelope } },
    },
    404: {
      description: "Git ref not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createGitRefRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/tasks/:taskId/git-refs
  router.openapi(listGitRefsRoute, (c) => {
    const { taskId } = c.req.valid("param");
    const refs = gitRefService.listByTask(taskId);

    return c.json(
      {
        data: refs,
        pagination: { total: refs.length },
      },
      200,
    );
  });

  // POST /api/v1/tasks/:taskId/git-refs
  router.openapi(createGitRefRoute, (c) => {
    const { taskId } = c.req.valid("param");
    const body = c.req.valid("json");
    const ref = gitRefService.create({
      taskId,
      ...body,
    });

    return c.json({ data: ref }, 201);
  });

  // PATCH /api/v1/git-refs/:id
  router.openapi(updateGitRefRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const ref = gitRefService.update(id, body);

    return c.json({ data: ref }, 200);
  });

  // DELETE /api/v1/git-refs/:id
  router.openapi(deleteGitRefRoute, (c) => {
    const { id } = c.req.valid("param");
    const ref = gitRefService.deleteGitRef(id);

    return c.json({ data: ref }, 200);
  });

  return router;
}
