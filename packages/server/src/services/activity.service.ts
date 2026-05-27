import { eq, and, desc, count, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import { getDb, activityLog } from "../db/index.js";

// ─── Types ────────────────────────────────────────────────────────

export interface LogActivityInput {
  entityType: string;
  entityId: string;
  projectId?: string | null;
  actorId?: string | null;
  action: string;
  changes?: Record<string, { from: unknown; to: unknown }> | null;
}

export interface ActivityListOptions {
  entityType?: string;
  actorId?: string;
  page?: number;
  perPage?: number;
}

// ─── Helper ──────────────────────────────────────────────────────

/**
 * Compute a JSON diff of changes between `before` and `after` objects,
 * limited to the specified `fields`. Returns null if no changes detected.
 */
export function computeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): Record<string, { from: unknown; to: unknown }> | null {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  let hasChanges = false;

  for (const field of fields) {
    const fromVal = before[field];
    const toVal = after[field];

    // Simple equality check (works for primitives and null)
    if (fromVal !== toVal) {
      changes[field] = { from: fromVal ?? null, to: toVal ?? null };
      hasChanges = true;
    }
  }

  return hasChanges ? changes : null;
}

// ─── Service functions ────────────────────────────────────────────

/**
 * Insert an activity log entry.
 */
export function logActivity(data: LogActivityInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();

  db.insert(activityLog)
    .values({
      id,
      entityType: data.entityType,
      entityId: data.entityId,
      projectId: data.projectId ?? null,
      actorId: data.actorId ?? null,
      action: data.action,
      changes: data.changes ?? null,
      createdAt: now,
    })
    .run();

  return db
    .select()
    .from(activityLog)
    .where(eq(activityLog.id, id))
    .get()!;
}

/**
 * List activity entries for a project, with pagination and optional filters.
 */
export function listByProject(projectId: string, options?: ActivityListOptions) {
  const db = getDb();

  const conditions: ReturnType<typeof eq>[] = [
    eq(activityLog.projectId, projectId),
  ];

  if (options?.entityType) {
    conditions.push(eq(activityLog.entityType, options.entityType));
  }
  if (options?.actorId) {
    conditions.push(eq(activityLog.actorId, options.actorId));
  }

  // Count total
  const totalResult = db
    .select({ count: count() })
    .from(activityLog)
    .where(and(...conditions))
    .get();
  const total = totalResult?.count ?? 0;

  // Pagination
  const page = Math.max(1, options?.page ?? 1);
  const perPage = Math.max(1, Math.min(100, options?.perPage ?? 50));
  const offset = (page - 1) * perPage;
  const totalPages = Math.ceil(total / perPage);

  const data = db
    .select()
    .from(activityLog)
    .where(and(...conditions))
    .orderBy(desc(activityLog.createdAt))
    .limit(perPage)
    .offset(offset)
    .all();

  return {
    data,
    pagination: {
      page,
      perPage,
      total,
      totalPages,
    },
  };
}

/**
 * List activity entries for a specific entity.
 */
export function listByEntity(
  entityType: string,
  entityId: string,
  options?: { page?: number; perPage?: number },
) {
  const db = getDb();

  const conditions = [
    eq(activityLog.entityType, entityType),
    eq(activityLog.entityId, entityId),
  ];

  // Count total
  const totalResult = db
    .select({ count: count() })
    .from(activityLog)
    .where(and(...conditions))
    .get();
  const total = totalResult?.count ?? 0;

  // Pagination
  const page = Math.max(1, options?.page ?? 1);
  const perPage = Math.max(1, Math.min(100, options?.perPage ?? 50));
  const offset = (page - 1) * perPage;
  const totalPages = Math.ceil(total / perPage);

  const data = db
    .select()
    .from(activityLog)
    .where(and(...conditions))
    .orderBy(desc(activityLog.createdAt))
    .limit(perPage)
    .offset(offset)
    .all();

  return {
    data,
    pagination: {
      page,
      perPage,
      total,
      totalPages,
    },
  };
}
