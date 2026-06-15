import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables } from "../types.js";
import * as gitAutoLinkService from "../services/git-auto-link.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const gitRefSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  refType: z.string(),
  refValue: z.string(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.string(),
});

const webhookResponseSchema = z.object({
  data: z.object({
    linked: z.boolean(),
    refs: z.array(gitRefSchema),
  }),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ──────────────────────────────────────────────

const gitWebhookBody = z
  .object({
    event: z.enum(["branch_created", "commit_pushed"]),
    ref: z.string().min(1, "ref is required"),
    project_id: z.string().min(1, "project_id is required"),
    url: z.string().optional(),
    title: z.string().optional(),
  })
  .openapi("GitWebhookPayload");

// ─── Route definition ────────────────────────────────────────────

const gitWebhookRoute = createRoute({
  method: "post",
  path: "/api/v1/webhooks/git",
  tags: ["Webhooks"],
  summary: "Git webhook",
  description:
    "Public webhook endpoint for git events. Accepts branch creation and commit push events " +
    "to auto-link branches and commits to tasks based on naming conventions.",
  request: {
    body: {
      content: { "application/json": { schema: gitWebhookBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Webhook processed",
      content: { "application/json": { schema: webhookResponseSchema } },
    },
    400: {
      description: "Invalid webhook payload",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createWebhookRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  router.openapi(gitWebhookRoute, (c) => {
    const body = c.req.valid("json");

    if (body.event === "branch_created") {
      const ref = gitAutoLinkService.autoLinkBranch(body.ref, body.project_id);

      return c.json(
        {
          data: {
            linked: ref !== null,
            refs: ref ? [ref] : [],
          },
        },
        200,
      );
    }

    if (body.event === "commit_pushed") {
      // For commit_pushed, ref is the commit SHA, and title is the commit message
      const message = body.title ?? "";
      const refs = gitAutoLinkService.linkCommitToTasks(
        body.ref,
        message,
        body.project_id,
        body.url,
        body.title,
      );

      return c.json(
        {
          data: {
            linked: refs.length > 0,
            refs,
          },
        },
        200,
      );
    }

    // Should not reach here due to zod enum validation, but just in case
    return c.json(
      {
        data: {
          linked: false,
          refs: [],
        },
      },
      200,
    );
  });

  return router;
}
