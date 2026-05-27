import { createId } from "@pm/shared";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app.js";
import {
  initializeDatabase,
  closeDb,
  users,
  projects,
  proposals,
  workspaces,
  epics,
  tasks,
} from "../src/db/index.js";
import type { AppDatabase } from "../src/db/index.js";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppVariables } from "../src/types.js";

/**
 * The default test token used by authRequest().
 * createTestApp() creates a user whose api_token_hash matches this token.
 */
export const DEFAULT_TEST_TOKEN = "test-token";

/**
 * Pre-computed bcrypt hash of DEFAULT_TEST_TOKEN.
 * Computing this once at module load avoids repeated hashSync calls.
 */
const DEFAULT_TEST_TOKEN_HASH = bcrypt.hashSync(DEFAULT_TEST_TOKEN, 10);

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
  /** The default authenticated test user */
  testUser: TestUser;
  /** The raw API token for the default test user */
  testToken: string;
}

/**
 * Creates a test Hono app backed by an in-memory SQLite database.
 * No HTTP server is started — use `app.request()` for testing.
 *
 * Also creates a default test user with a valid API token so that
 * authRequest() works out of the box with the default token.
 *
 * Call `cleanup()` when done (typically in afterEach).
 */
export function createTestApp(): TestApp {
  const db = initializeDatabase({ inMemory: true });
  const app = createApp();

  // Create a default authenticated user with a known API token
  const ts = new Date().toISOString();
  const userId = createId();
  const username = "test-admin";
  const displayName = "Test Admin";

  db.insert(users)
    .values({
      id: userId,
      username,
      displayName,
      email: "test@example.com",
      role: "admin",
      type: "human",
      apiTokenHash: DEFAULT_TEST_TOKEN_HASH,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();

  const testUser: TestUser = {
    id: userId,
    username,
    displayName,
    email: "test@example.com",
    role: "admin",
    type: "human",
  };

  return {
    app,
    db,
    cleanup: () => {
      closeDb();
    },
    testUser,
    testToken: DEFAULT_TEST_TOKEN,
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

export interface TestProposal {
  id: string;
  projectId: string;
  title: string;
  status: string;
  createdBy: string;
}

export interface TestEpic {
  id: string;
  projectId: string;
  name: string;
  status: string;
  priority: string;
}

export interface TestTask {
  id: string;
  projectId: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  reporterId: string;
  assigneeId: string | null;
  epicId: string | null;
  parentTaskId: string | null;
}

// ── Factory functions ─────────────────────────────────────────────

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

  const ws = db.select().from(workspaces).all();
  const workspaceId = overrides.workspaceId ?? ws[0].id;

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

export function createTestProposal(
  db: AppDatabase,
  overrides: Partial<{
    id: string;
    projectId: string;
    title: string;
    description: string;
    status: string;
    createdBy: string;
    resolvedBy: string;
    resolvedAt: string;
  }> = {},
): TestProposal {
  const ts = new Date().toISOString();
  const id = overrides.id ?? createId();

  let projectId = overrides.projectId;
  if (!projectId) {
    const project = createTestProject(db);
    projectId = project.id;
  }

  let createdBy = overrides.createdBy;
  if (!createdBy) {
    const user = createTestUser(db);
    createdBy = user.id;
  }

  const title = overrides.title ?? `Test Proposal ${id.slice(-6)}`;
  const status = overrides.status ?? "open";

  db.insert(proposals)
    .values({
      id,
      projectId,
      title,
      description: overrides.description ?? null,
      status,
      createdBy,
      resolvedBy: overrides.resolvedBy ?? null,
      resolvedAt: overrides.resolvedAt ?? null,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();

  return {
    id,
    projectId,
    title,
    status,
    createdBy,
  };
}

export function createTestEpic(
  db: AppDatabase,
  overrides: Partial<{
    id: string;
    projectId: string;
    name: string;
    status: string;
    priority: string;
    proposalId: string | null;
    milestoneId: string | null;
    targetDate: string | null;
    sortOrder: number;
    createdBy: string;
  }> = {},
): TestEpic {
  const ts = new Date().toISOString();
  const id = overrides.id ?? createId();

  let projectId = overrides.projectId;
  if (!projectId) {
    const project = createTestProject(db);
    projectId = project.id;
  }

  let createdBy = overrides.createdBy;
  if (!createdBy) {
    const user = createTestUser(db);
    createdBy = user.id;
  }

  const name = overrides.name ?? `Test Epic ${id.slice(-6)}`;
  const status = overrides.status ?? "draft";
  const priority = overrides.priority ?? "medium";

  db.insert(epics)
    .values({
      id,
      projectId,
      name,
      status,
      priority,
      proposalId: overrides.proposalId ?? null,
      milestoneId: overrides.milestoneId ?? null,
      targetDate: overrides.targetDate ?? null,
      sortOrder: overrides.sortOrder ?? 0,
      createdAt: ts,
      updatedAt: ts,
      createdBy,
    })
    .run();

  return {
    id,
    projectId,
    name,
    status,
    priority,
  };
}

export function createTestTask(
  db: AppDatabase,
  overrides: Partial<{
    id: string;
    projectId: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    type: string;
    assigneeId: string | null;
    reporterId: string;
    epicId: string | null;
    parentTaskId: string | null;
    proposalId: string | null;
    estimatedEffort: string | null;
    dueDate: string | null;
    sortOrder: number;
    context: Record<string, unknown> | null;
    gitBranch: string | null;
  }> = {},
): TestTask {
  const ts = new Date().toISOString();
  const id = overrides.id ?? createId();

  let projectId = overrides.projectId;
  if (!projectId) {
    const project = createTestProject(db);
    projectId = project.id;
  }

  let reporterId = overrides.reporterId;
  if (!reporterId) {
    const user = createTestUser(db);
    reporterId = user.id;
  }

  const title = overrides.title ?? `Test Task ${id.slice(-6)}`;
  const status = overrides.status ?? "backlog";
  const priority = overrides.priority ?? "medium";
  const type = overrides.type ?? "feature";

  db.insert(tasks)
    .values({
      id,
      projectId,
      title,
      description: overrides.description ?? null,
      status,
      priority,
      type,
      assigneeId: overrides.assigneeId ?? null,
      reporterId,
      epicId: overrides.epicId ?? null,
      parentTaskId: overrides.parentTaskId ?? null,
      proposalId: overrides.proposalId ?? null,
      estimatedEffort: overrides.estimatedEffort ?? null,
      dueDate: overrides.dueDate ?? null,
      sortOrder: overrides.sortOrder ?? 0,
      context: overrides.context ?? null,
      gitBranch: overrides.gitBranch ?? null,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();

  return {
    id,
    projectId,
    title,
    status,
    priority,
    type,
    reporterId,
    assigneeId: overrides.assigneeId ?? null,
    epicId: overrides.epicId ?? null,
    parentTaskId: overrides.parentTaskId ?? null,
  };
}

// ── Request helpers ───────────────────────────────────────────────

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
