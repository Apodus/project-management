import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables } from "../types.js";
import { requireAdmin } from "../middleware/require-admin.js";
import * as userService from "../services/user.service.js";
import * as authService from "../services/auth.service.js";

// ─── Response schemas ────────────────────────────────────────────

const userSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    email: z.string().nullable(),
    role: z.string(),
    type: z.string(),
    avatarUrl: z.string().nullable(),
    poolId: z.string().nullable(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("User");

const userWithTokenSchema = userSchema
  .extend({
    apiToken: z.string().optional(),
  })
  .openapi("UserWithToken");

const userDataEnvelope = z.object({
  data: userSchema,
});

const userWithTokenEnvelope = z.object({
  data: userWithTokenSchema,
});

const userListEnvelope = z.object({
  data: z.array(userSchema),
});

const tokenEnvelope = z.object({
  data: z.object({
    apiToken: z.string(),
  }),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ─────────────────────────────────────────────

const createUserBody = z.object({
  username: z.string().min(1, "Username is required"),
  displayName: z.string().min(1, "Display name is required"),
  email: z.string().nullable().optional(),
  password: z.string().optional(),
  role: z.string().min(1, "Role is required"),
  type: z.string().min(1, "Type is required"),
});

const updateUserBody = z.object({
  username: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  email: z.string().nullable().optional(),
  role: z.string().min(1).optional(),
});

const userIdParam = z.object({
  id: z.string().min(1),
});

// ─── Route definitions ──────────────────────────────────────────

const listUsersRoute = createRoute({
  method: "get",
  path: "/api/v1/users",
  tags: ["Users"],
  summary: "List all users",
  description: "Returns all users. Admin only.",
  responses: {
    200: {
      description: "User list",
      content: { "application/json": { schema: userListEnvelope } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const createUserRoute = createRoute({
  method: "post",
  path: "/api/v1/users",
  tags: ["Users"],
  summary: "Create a user",
  description:
    "Creates a new user. For AI agent users, returns the API token (shown once). Admin only.",
  request: {
    body: {
      content: { "application/json": { schema: createUserBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "User created",
      content: { "application/json": { schema: userWithTokenEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Duplicate username",
      content: { "application/json": { schema: errorEnvelope } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updateUserRoute = createRoute({
  method: "patch",
  path: "/api/v1/users/{id}",
  tags: ["Users"],
  summary: "Update a user",
  description: "Updates user fields. Admin only.",
  request: {
    params: userIdParam,
    body: {
      content: { "application/json": { schema: updateUserBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "User updated",
      content: { "application/json": { schema: userDataEnvelope } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Duplicate username",
      content: { "application/json": { schema: errorEnvelope } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const rotateTokenRoute = createRoute({
  method: "post",
  path: "/api/v1/users/{id}/rotate-token",
  tags: ["Users"],
  summary: "Rotate API token",
  description: "Regenerates the API token for a user. Returns the new raw token. Admin only.",
  request: {
    params: userIdParam,
  },
  responses: {
    200: {
      description: "New token generated",
      content: { "application/json": { schema: tokenEnvelope } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deactivateUserRoute = createRoute({
  method: "post",
  path: "/api/v1/users/{id}/deactivate",
  tags: ["Users"],
  summary: "Deactivate a user",
  description: "Sets the user as inactive. Admin only.",
  request: {
    params: userIdParam,
  },
  responses: {
    200: {
      description: "User deactivated",
      content: { "application/json": { schema: userDataEnvelope } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const activateUserRoute = createRoute({
  method: "post",
  path: "/api/v1/users/{id}/activate",
  tags: ["Users"],
  summary: "Activate a user",
  description: "Sets the user as active. Admin only.",
  request: {
    params: userIdParam,
  },
  responses: {
    200: {
      description: "User activated",
      content: { "application/json": { schema: userDataEnvelope } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Route factory ───────────────────────────────────────────────

export function createUserRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // Apply admin middleware to all user routes
  router.use("/api/v1/users/*", requireAdmin);
  router.use("/api/v1/users", requireAdmin);

  // GET /api/v1/users
  router.openapi(listUsersRoute, (c) => {
    const allUsers = userService.list();
    return c.json({ data: allUsers }, 200);
  });

  // POST /api/v1/users
  router.openapi(createUserRoute, async (c) => {
    const body = c.req.valid("json");

    // Validate type
    if (body.type !== "human" && body.type !== "ai_agent") {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: 'Type must be "human" or "ai_agent"',
          },
        },
        400,
      );
    }

    // Validate role
    if (body.role !== "admin" && body.role !== "member") {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: 'Role must be "admin" or "member"',
          },
        },
        400,
      );
    }

    // Human users require a password
    if (body.type === "human" && !body.password) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Password is required for human users",
          },
        },
        400,
      );
    }

    try {
      const result = await userService.create({
        username: body.username,
        displayName: body.displayName,
        email: body.email ?? null,
        password: body.password,
        role: body.role,
        type: body.type,
      });

      const responseData = {
        ...result.user,
        ...(result.apiToken ? { apiToken: result.apiToken } : {}),
      };

      return c.json({ data: responseData }, 201);
    } catch (err) {
      if (err instanceof userService.DuplicateUsernameError) {
        return c.json(
          {
            error: {
              code: "DUPLICATE_USERNAME",
              message: err.message,
            },
          },
          409,
        );
      }
      throw err;
    }
  });

  // PATCH /api/v1/users/:id
  router.openapi(updateUserRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    try {
      const updated = userService.update(id, body);
      if (!updated) {
        return c.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "User not found",
            },
          },
          404,
        );
      }

      return c.json({ data: updated }, 200);
    } catch (err) {
      if (err instanceof userService.DuplicateUsernameError) {
        return c.json(
          {
            error: {
              code: "DUPLICATE_USERNAME",
              message: err.message,
            },
          },
          409,
        );
      }
      throw err;
    }
  });

  // POST /api/v1/users/:id/rotate-token
  router.openapi(rotateTokenRoute, async (c) => {
    const { id } = c.req.valid("param");

    const user = userService.getById(id);
    if (!user) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "User not found",
          },
        },
        404,
      );
    }

    const newToken = await authService.createApiToken(id);
    return c.json({ data: { apiToken: newToken } }, 200);
  });

  // POST /api/v1/users/:id/deactivate
  router.openapi(deactivateUserRoute, (c) => {
    const { id } = c.req.valid("param");

    const user = userService.deactivate(id);
    if (!user) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "User not found",
          },
        },
        404,
      );
    }

    return c.json({ data: user }, 200);
  });

  // POST /api/v1/users/:id/activate
  router.openapi(activateUserRoute, (c) => {
    const { id } = c.req.valid("param");

    const user = userService.activate(id);
    if (!user) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "User not found",
          },
        },
        404,
      );
    }

    return c.json({ data: user }, 200);
  });

  return router;
}
