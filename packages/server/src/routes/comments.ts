import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { COMMENT_TYPES } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as commentService from "../services/comment.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const commentSchema = z
  .object({
    id: z.string(),
    taskId: z.string().nullable(),
    proposalId: z.string().nullable(),
    authorId: z.string(),
    body: z.string(),
    commentType: z.string(),
    metadata: z.unknown().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("TaskComment");

const commentDataEnvelope = z.object({
  data: commentSchema,
});

const commentListEnvelope = z.object({
  data: z.array(commentSchema),
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

const createTaskCommentBody = z
  .object({
    body: z.string().min(1, "Comment body is required"),
    commentType: z.enum(COMMENT_TYPES).optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("CreateTaskComment");

const updateCommentBody = z
  .object({
    body: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("UpdateComment");

const taskIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "taskId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const commentIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "id", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

// ─── Route definitions ────────────────────────────────────────────

const listTaskCommentsRoute = createRoute({
  method: "get",
  path: "/api/v1/tasks/{taskId}/comments",
  tags: ["Comments"],
  summary: "List task comments",
  description: "List all comments on a task, in chronological order.",
  request: {
    params: z.object({ taskId: taskIdParam }),
  },
  responses: {
    200: {
      description: "List of comments",
      content: { "application/json": { schema: commentListEnvelope } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const createTaskCommentRoute = createRoute({
  method: "post",
  path: "/api/v1/tasks/{taskId}/comments",
  tags: ["Comments"],
  summary: "Add task comment",
  description: "Add a comment to a task.",
  request: {
    params: z.object({ taskId: taskIdParam }),
    body: {
      content: { "application/json": { schema: createTaskCommentBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Comment created",
      content: { "application/json": { schema: commentDataEnvelope } },
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

const updateCommentRoute = createRoute({
  method: "patch",
  path: "/api/v1/comments/{id}",
  tags: ["Comments"],
  summary: "Edit comment",
  description: "Update a comment's body or metadata.",
  request: {
    params: z.object({ id: commentIdParam }),
    body: {
      content: { "application/json": { schema: updateCommentBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Comment updated",
      content: { "application/json": { schema: commentDataEnvelope } },
    },
    404: {
      description: "Comment not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deleteCommentRoute = createRoute({
  method: "delete",
  path: "/api/v1/comments/{id}",
  tags: ["Comments"],
  summary: "Delete comment",
  description: "Delete a comment.",
  request: {
    params: z.object({ id: commentIdParam }),
  },
  responses: {
    200: {
      description: "Comment deleted",
      content: { "application/json": { schema: commentDataEnvelope } },
    },
    404: {
      description: "Comment not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createCommentRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/tasks/:taskId/comments
  router.openapi(listTaskCommentsRoute, (c) => {
    const { taskId } = c.req.valid("param");
    const commentsList = commentService.listByTask(taskId);

    return c.json(
      {
        data: commentsList,
        pagination: { total: commentsList.length },
      },
      200,
    );
  });

  // POST /api/v1/tasks/:taskId/comments
  router.openapi(createTaskCommentRoute, (c) => {
    const { taskId } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser");
    const comment = commentService.create({
      taskId,
      authorId: user!.id,
      body: body.body,
      commentType: body.commentType,
      metadata: body.metadata ?? null,
    });

    return c.json({ data: comment }, 201);
  });

  // PATCH /api/v1/comments/:id
  router.openapi(updateCommentRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const comment = commentService.update(id, body);

    return c.json({ data: comment }, 200);
  });

  // DELETE /api/v1/comments/:id
  router.openapi(deleteCommentRoute, (c) => {
    const { id } = c.req.valid("param");
    const comment = commentService.deleteComment(id);

    return c.json({ data: comment }, 200);
  });

  return router;
}
