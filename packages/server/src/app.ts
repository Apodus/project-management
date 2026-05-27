import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { apiReference } from "@scalar/hono-api-reference";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { createProjectRoutes } from "./routes/projects.js";
import { createProposalRoutes } from "./routes/proposals.js";
import { createEpicRoutes } from "./routes/epics.js";
import { createTaskRoutes } from "./routes/tasks.js";
import { createCommentRoutes } from "./routes/comments.js";
import { createLabelRoutes } from "./routes/labels.js";
import { createDependencyRoutes } from "./routes/dependencies.js";
import { createSearchRoutes } from "./routes/search.js";
import { createActivityRoutes } from "./routes/activity.js";
import { createMilestoneRoutes } from "./routes/milestones.js";
import { createGitRefRoutes } from "./routes/git-refs.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createAgentPoolRoutes } from "./routes/agent-pool.js";
import { createUserRoutes } from "./routes/users.js";
import { createEventStreamRoutes } from "./routes/events.js";
import { createWebhookRoutes } from "./routes/webhooks.js";
import { createExportRoutes } from "./routes/export.js";
import { createAutomationRoutes } from "./routes/automation.js";
import { createTemplateRoutes } from "./routes/templates.js";
import { initializeEventListeners } from "./events/index.js";
import type { AppVariables } from "./types.js";

/**
 * Create and configure the OpenAPIHono application.
 *
 * This is separated from the server entry point so tests can create
 * the app without starting an HTTP server.
 */
export function createApp(): OpenAPIHono<{ Variables: AppVariables }> {
  // Initialize event listeners (activity log, etc.)
  initializeEventListeners();

  const app = new OpenAPIHono<{ Variables: AppVariables }>();

  // ── Global error & not-found handlers ─────────────────────────────
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  // ── Middleware stack (order matters) ───────────────────────────────

  // 1. Request ID — must run first so logger can reference it
  app.use("*", requestIdMiddleware);

  // 2. Request logging
  app.use("*", loggerMiddleware);

  // 3. CORS — permissive for local development
  app.use(
    "*",
    cors({
      origin: [
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:3000",
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id"],
      credentials: true,
      maxAge: 86400,
    }),
  );

  // 4. Auth stub — extract token (no validation yet)
  app.use("/api/*", authMiddleware);

  // ── Auth & user routes ────────────────────────────────────────────
  app.route("/", createAuthRoutes());
  app.route("/", createAgentPoolRoutes());
  app.route("/", createUserRoutes());

  // ── SSE event stream ──────────────────────────────────────────────
  app.route("/", createEventStreamRoutes());

  // ── Resource routes ───────────────────────────────────────────────
  app.route("/", createProjectRoutes());
  app.route("/", createProposalRoutes());
  app.route("/", createEpicRoutes());
  app.route("/", createTaskRoutes());
  app.route("/", createCommentRoutes());
  app.route("/", createLabelRoutes());
  app.route("/", createDependencyRoutes());
  app.route("/", createSearchRoutes());
  app.route("/", createActivityRoutes());
  app.route("/", createMilestoneRoutes());
  app.route("/", createGitRefRoutes());
  app.route("/", createWebhookRoutes());
  app.route("/", createExportRoutes());
  app.route("/", createAutomationRoutes());
  app.route("/", createTemplateRoutes());

  // ── Health endpoint ───────────────────────────────────────────────
  const healthRoute = createRoute({
    method: "get",
    path: "/health",
    tags: ["System"],
    summary: "Health check",
    description: "Returns the server health status and current timestamp.",
    responses: {
      200: {
        description: "Server is healthy",
        content: {
          "application/json": {
            schema: z.object({
              status: z.string().openapi({ example: "ok" }),
              timestamp: z.string().openapi({ example: "2026-01-01T00:00:00.000Z" }),
            }),
          },
        },
      },
    },
  });

  app.openapi(healthRoute, (c) => {
    return c.json(
      {
        status: "ok" as const,
        timestamp: new Date().toISOString(),
      },
      200,
    );
  });

  // ── OpenAPI spec and docs ─────────────────────────────────────────

  // Serve OpenAPI JSON spec
  app.doc("/api/v1/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Project Management API",
      version: "0.1.0",
      description:
        "REST API for the Human-AI Collaborative Project Management System.",
    },
    servers: [
      {
        url: "http://localhost:3000",
        description: "Local development server",
      },
    ],
  });

  // Serve API documentation UI
  app.get(
    "/api/v1/docs",
    apiReference({
      theme: "kepler",
      spec: {
        url: "/api/v1/openapi.json",
      },
    }),
  );

  return app;
}
