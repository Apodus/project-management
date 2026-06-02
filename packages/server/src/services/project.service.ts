import { eq, and, count } from "drizzle-orm";
import { createId } from "@pm/shared";
import { getDb, projects, tasks, epics, proposals, workspaces } from "../db/index.js";
import { AppError } from "../types.js";
import { computeChanges } from "./activity.service.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";
import { createBuiltInRules } from "./automation.service.js";

// ─── Types ────────────────────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
  workspaceId?: string;
  description?: string | null;
  gitRepoUrl?: string | null;
  status?: string;
  settings?: unknown;
  sortOrder?: number;
  createdBy?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  gitRepoUrl?: string | null;
  status?: string;
  settings?: unknown;
  sortOrder?: number;
}

export interface ProjectStats {
  tasksByStatus: Record<string, number>;
  totalTasks: number;
  epicCount: number;
  proposalCount: number;
}

// ─── Slug generation ──────────────────────────────────────────────

/**
 * Generate a URL-safe slug from a project name.
 * - Lowercase
 * - Replace spaces and special chars with hyphens
 * - Collapse consecutive hyphens
 * - Trim leading/trailing hyphens
 */
function generateBaseSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Generate a unique slug within a workspace.
 * If the base slug already exists, appends -2, -3, etc.
 */
function generateUniqueSlug(workspaceId: string, name: string): string {
  const db = getDb();
  const baseSlug = generateBaseSlug(name);

  // Check if the base slug is taken
  const existing = db
    .select({ slug: projects.slug })
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, workspaceId),
        eq(projects.slug, baseSlug),
      ),
    )
    .get();

  if (!existing) {
    return baseSlug;
  }

  // Find the next available suffix
  let suffix = 2;
  while (true) {
    const candidate = `${baseSlug}-${suffix}`;
    const taken = db
      .select({ slug: projects.slug })
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, workspaceId),
          eq(projects.slug, candidate),
        ),
      )
      .get();

    if (!taken) {
      return candidate;
    }
    suffix++;
  }
}

// ─── Service functions ────────────────────────────────────────────

/**
 * List all projects, with optional status filter.
 */
export function list(filters?: { status?: string }) {
  const db = getDb();

  if (filters?.status) {
    return db
      .select()
      .from(projects)
      .where(eq(projects.status, filters.status))
      .all();
  }

  return db.select().from(projects).all();
}

/**
 * Get a single project by ID. Throws 404 if not found.
 */
export function getById(id: string) {
  const db = getDb();
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .get();

  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${id}`);
  }

  return project;
}

/**
 * Create a new project.
 * Generates an ID, timestamps, and a unique slug from the name.
 */
export function create(data: CreateProjectInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();

  // Resolve workspace: use provided or fall back to first workspace
  let workspaceId = data.workspaceId;
  if (!workspaceId) {
    const ws = db.select().from(workspaces).all();
    if (ws.length === 0) {
      throw new AppError(500, "NO_WORKSPACE", "No workspace exists");
    }
    workspaceId = ws[0].id;
  }

  const slug = generateUniqueSlug(workspaceId, data.name);

  db.insert(projects)
    .values({
      id,
      workspaceId,
      name: data.name,
      slug,
      description: data.description ?? null,
      status: data.status ?? "active",
      gitRepoUrl: data.gitRepoUrl ?? null,
      settings: data.settings ?? null,
      sortOrder: data.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
      createdBy: data.createdBy ?? null,
    })
    .run();

  const result = getById(id);

  getEventBus().emit(EVENT_NAMES.PROJECT_CREATED, {
    entity: result,
    entityType: "project",
    entityId: id,
    projectId: id,
    actorId: data.createdBy ?? null,
    timestamp: now,
  });

  // Create built-in automation rules for the new project
  createBuiltInRules(id, data.createdBy ?? null);

  return result;
}

/**
 * Update a project's fields. Throws 404 if not found.
 * Automatically updates the `updatedAt` timestamp.
 * If name changes, regenerates the slug.
 */
export function update(id: string, data: UpdateProjectInput) {
  // Verify the project exists first
  const existing = getById(id);
  const db = getDb();
  const now = new Date().toISOString();

  // Build update values
  const values: Record<string, unknown> = {
    updatedAt: now,
  };

  if (data.name !== undefined) {
    values.name = data.name;
    // Regenerate slug when name changes
    values.slug = generateUniqueSlug(existing.workspaceId, data.name);
  }
  if (data.description !== undefined) values.description = data.description;
  if (data.gitRepoUrl !== undefined) values.gitRepoUrl = data.gitRepoUrl;
  if (data.status !== undefined) values.status = data.status;
  if (data.settings !== undefined) values.settings = data.settings;
  if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;

  db.update(projects)
    .set(values)
    .where(eq(projects.id, id))
    .run();

  const result = getById(id);

  const changes = computeChanges(
    existing as unknown as Record<string, unknown>,
    result as unknown as Record<string, unknown>,
    ["name", "description", "status", "gitRepoUrl"],
  );

  getEventBus().emit(EVENT_NAMES.PROJECT_UPDATED, {
    entity: result,
    entityType: "project",
    entityId: id,
    projectId: id,
    actorId: null,
    timestamp: now,
    changes,
    previousStatus: existing.status !== result.status ? existing.status : undefined,
  });

  return result;
}

/**
 * Archive a project (soft delete). Sets status to "archived".
 * Throws 404 if not found.
 */
export function archive(id: string) {
  // Verify the project exists first
  const existing = getById(id);
  const db = getDb();
  const now = new Date().toISOString();

  db.update(projects)
    .set({ status: "archived", updatedAt: now })
    .where(eq(projects.id, id))
    .run();

  const result = getById(id);

  getEventBus().emit(EVENT_NAMES.PROJECT_ARCHIVED, {
    entity: result,
    entityType: "project",
    entityId: id,
    projectId: id,
    actorId: null,
    timestamp: now,
    changes: { status: { from: existing.status, to: "archived" } },
    previousStatus: existing.status,
  });

  return result;
}

/**
 * Get statistics for a project: task counts by status, epic count, proposal count.
 * Throws 404 if the project doesn't exist.
 */
export function getStats(id: string): ProjectStats {
  // Verify the project exists
  getById(id);
  const db = getDb();

  // Count tasks grouped by status
  const taskRows = db
    .select({
      status: tasks.status,
      count: count(),
    })
    .from(tasks)
    .where(eq(tasks.projectId, id))
    .groupBy(tasks.status)
    .all();

  const tasksByStatus: Record<string, number> = {};
  let totalTasks = 0;
  for (const row of taskRows) {
    tasksByStatus[row.status] = row.count;
    totalTasks += row.count;
  }

  // Count epics
  const epicResult = db
    .select({ count: count() })
    .from(epics)
    .where(eq(epics.projectId, id))
    .get();

  // Count proposals
  const proposalResult = db
    .select({ count: count() })
    .from(proposals)
    .where(eq(proposals.projectId, id))
    .get();

  return {
    tasksByStatus,
    totalTasks,
    epicCount: epicResult?.count ?? 0,
    proposalCount: proposalResult?.count ?? 0,
  };
}
