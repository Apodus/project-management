import { createId } from "@pm/shared";
import { createApp } from "../src/app.js";
import {
  initializeDatabase,
  closeDb,
  users,
  projects,
  workspaces,
} from "../src/db/index.js";
import type { AppDatabase } from "../src/db/index.js";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppVariables } from "../src/types.js";

/**
 * Test app instance with associated database handles.
 */
export interface TestApp {
  /** The Hono app instance (use with app.request()) */
  app: OpenAPIHono<{ Variables: AppVariables }>;
  /** The Drizzle database instance for direct data manipulation */
  db: AppDatabase;
  /** Tear down: close DB and reset singletons */
  cleanup: () => void;
}

/**
 * Creates a test Hono app backed by an in-memory SQLite database.
 * No HTTP server is started — use `app.request()` for testing.
 *
 * Call `cleanup()` when done (typically in afterEach).
 */
export function createTestApp(): TestApp {
  const db = initializeDatabase({ inMemory: true });
  const app = createApp();

  return {
    app,
    db,
    cleanup: () => {
      closeDb();
    },
  };
}

// ── Helper types ──────────────────────────────────────────────────

export interface TestUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  type: string;
}

export interface TestProject {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  status: string;
}

// ── Factory functions ─────────────────────────────────────────────

/**
 * Insert a user into the test database. Returns the created user data.
 *
 * @param db - The Drizzle database instance
 * @param overrides - Optional field overrides
 */
export function createTestUser(
  db: AppDatabase,
  overrides: Partial<{
    id: string;
    username: string;
    displayName: string;
    email: string;
    role: string;
    type: string;
  }> = {},
): TestUser {
  const ts = new Date().toISOString();
  const id = overrides.id ?? createId();
  const username = overrides.username ?? `user-${id.slice(-6)}`;
  const displayName = overrides.displayName ?? `Test User ${id.slice(-6)}`;

  db.insert(users)
    .values({
      id,
      username,
      displayName,
      email: overrides.email ?? null,
      role: overrides.role ?? "admin",
      type: overrides.type ?? "human",
      createdAt: ts,
      updatedAt: ts,
    })
    .run();

  return {
    id,
    username,
    displayName,
    email: overrides.email ?? null,
    role: overrides.role ?? "admin",
    type: overrides.type ?? "human",
  };
}

/**
 * Insert a project into the test database.
 * Creates a user if userId is not provided (uses the default seeded workspace).
 *
 * @param db - The Drizzle database instance
 * @param overrides - Optional field overrides
 */
export function createTestProject(
  db: AppDatabase,
  overrides: Partial<{
    id: string;
    workspaceId: string;
    name: string;
    slug: string;
    status: string;
    createdBy: string;
  }> = {},
): TestProject {
  const ts = new Date().toISOString();
  const id = overrides.id ?? createId();

  // Get the default workspace
  const ws = db.select().from(workspaces).all();
  const workspaceId = overrides.workspaceId ?? ws[0].id;

  // Create a user if needed
  let createdBy = overrides.createdBy;
  if (!createdBy) {
    const user = createTestUser(db);
    createdBy = user.id;
  }

  const name = overrides.name ?? `Test Project ${id.slice(-6)}`;
  const slug = overrides.slug ?? `test-project-${id.slice(-6)}`;
  const status = overrides.status ?? "active";

  db.insert(projects)
    .values({
      id,
      workspaceId,
      name,
      slug,
      status,
      createdAt: ts,
      updatedAt: ts,
      createdBy,
    })
    .run();

  return {
    id,
    workspaceId,
    name,
    slug,
    status,
  };
}

// ── Request helpers ───────────────────────────────────────────────

/**
 * Make a request to the test app with an Authorization header.
 *
 * @param app - The Hono app instance
 * @param method - HTTP method
 * @param path - URL path
 * @param options - Additional request options
 */
export function authRequest(
  app: OpenAPIHono<{ Variables: AppVariables }>,
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const { token = "test-token", body, headers = {} } = options;

  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...headers,
  };

  if (body !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
  }

  return app.request(path, {
    method,
    headers: requestHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
