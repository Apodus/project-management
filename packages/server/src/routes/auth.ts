import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { AppVariables } from "../types.js";
import * as userService from "../services/user.service.js";
import * as authService from "../services/auth.service.js";

// ─── Constants ───────────────────────────────────────────────────

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

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
  .openapi("AuthUser");

const userDataEnvelope = z.object({
  data: userSchema,
});

const setupStatusEnvelope = z.object({
  data: z.object({
    needsSetup: z.boolean(),
  }),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ─────────────────────────────────────────────

const setupBody = z.object({
  username: z.string().min(1, "Username is required"),
  displayName: z.string().min(1, "Display name is required"),
  password: z.string().min(1, "Password is required"),
});

const loginBody = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

// ─── Route definitions ──────────────────────────────────────────

const getSetupStatusRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/setup/status",
  tags: ["Auth"],
  summary: "Check if setup is needed",
  description: "Returns whether the system needs initial setup (no users exist).",
  responses: {
    200: {
      description: "Setup status",
      content: { "application/json": { schema: setupStatusEnvelope } },
    },
  },
});

const postSetupRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/setup",
  tags: ["Auth"],
  summary: "Initial setup",
  description:
    "Creates the first admin user. Only works if no users exist in the database.",
  request: {
    body: {
      content: { "application/json": { schema: setupBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Admin user created",
      content: { "application/json": { schema: userDataEnvelope } },
    },
    409: {
      description: "Setup already completed",
      content: { "application/json": { schema: errorEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const postLoginRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/login",
  tags: ["Auth"],
  summary: "Login",
  description: "Authenticates a user with username and password, creates a session.",
  request: {
    body: {
      content: { "application/json": { schema: loginBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Login successful",
      content: { "application/json": { schema: userDataEnvelope } },
    },
    401: {
      description: "Invalid credentials",
      content: { "application/json": { schema: errorEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const postLogoutRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/logout",
  tags: ["Auth"],
  summary: "Logout",
  description: "Ends the current session and clears the session cookie.",
  responses: {
    200: {
      description: "Logout successful",
      content: {
        "application/json": {
          schema: z.object({ data: z.object({ message: z.string() }) }),
        },
      },
    },
    401: {
      description: "Not authenticated",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getMeRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/me",
  tags: ["Auth"],
  summary: "Get current user",
  description: "Returns the currently authenticated user.",
  responses: {
    200: {
      description: "Current user",
      content: { "application/json": { schema: userDataEnvelope } },
    },
    401: {
      description: "Not authenticated",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Route factory ───────────────────────────────────────────────

export function createAuthRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/auth/setup/status — PUBLIC
  router.openapi(getSetupStatusRoute, (c) => {
    const count = userService.count();
    return c.json({ data: { needsSetup: count === 0 } }, 200);
  });

  // POST /api/v1/auth/setup — PUBLIC
  router.openapi(postSetupRoute, async (c) => {
    const count = userService.count();
    if (count > 0) {
      return c.json(
        {
          error: {
            code: "SETUP_COMPLETE",
            message: "Setup has already been completed. Users already exist.",
          },
        },
        409,
      );
    }

    const body = c.req.valid("json");

    const { user } = await userService.create({
      username: body.username,
      displayName: body.displayName,
      password: body.password,
      role: "admin",
      type: "human",
    });

    // Create session and set cookie
    const session = await authService.createSession(user.id);
    setCookie(c, "pm_session", session.token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });

    return c.json({ data: user }, 201);
  });

  // POST /api/v1/auth/login — PUBLIC
  router.openapi(postLoginRoute, async (c) => {
    const body = c.req.valid("json");

    const user = await userService.validateCredentials(
      body.username,
      body.password,
    );

    if (!user) {
      return c.json(
        {
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid username or password",
          },
        },
        401,
      );
    }

    // Create session and set cookie
    const session = await authService.createSession(user.id);
    setCookie(c, "pm_session", session.token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });

    return c.json({ data: user }, 200);
  });

  // POST /api/v1/auth/logout — AUTHENTICATED
  router.openapi(postLogoutRoute, async (c) => {
    // Since auth routes are public in the middleware, we need to manually check auth
    const currentUser = c.get("currentUser");
    if (!currentUser) {
      // Try to validate from cookie/header since auth middleware skips /api/v1/auth/*
      const sessionCookie = getCookie(c, "pm_session");
      const authHeader = c.req.header("Authorization");
      let token: string | null = null;

      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.slice(7);
      }

      if (sessionCookie) {
        // Delete the session
        await authService.deleteSession(sessionCookie);
      } else if (token) {
        // Bearer token logout - try as session token
        await authService.deleteSession(token);
      } else {
        return c.json(
          {
            error: {
              code: "UNAUTHORIZED",
              message: "Valid authentication required",
            },
          },
          401,
        );
      }
    } else {
      // User was authenticated via middleware (shouldn't typically happen for /auth/* routes)
      const sessionCookie = getCookie(c, "pm_session");
      const authHeader = c.req.header("Authorization");

      if (sessionCookie) {
        await authService.deleteSession(sessionCookie);
      } else if (authHeader?.startsWith("Bearer ")) {
        await authService.deleteSession(authHeader.slice(7));
      }
    }

    deleteCookie(c, "pm_session", { path: "/" });

    return c.json({ data: { message: "Logged out successfully" } }, 200);
  });

  // GET /api/v1/auth/me — AUTHENTICATED
  router.openapi(getMeRoute, async (c) => {
    // Since auth routes are public, manually validate auth
    let user = c.get("currentUser");

    if (!user) {
      // Try to validate the user ourselves since the middleware skips auth routes
      const sessionCookie = getCookie(c, "pm_session");
      const authHeader = c.req.header("Authorization");

      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        user = await authService.validateApiToken(token);
        if (!user) {
          user = await authService.validateSession(token);
        }
      }

      if (!user && sessionCookie) {
        user = await authService.validateSession(sessionCookie);
      }

      if (!user) {
        return c.json(
          {
            error: {
              code: "UNAUTHORIZED",
              message: "Valid authentication required",
            },
          },
          401,
        );
      }
    }

    // Get full user record from user service
    const fullUser = userService.getById(user.id);
    if (!fullUser) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "User not found",
          },
        },
        401,
      );
    }

    return c.json({ data: fullUser }, 200);
  });

  return router;
}
