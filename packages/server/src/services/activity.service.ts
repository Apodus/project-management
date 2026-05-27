import { eq, and, desc, count, sql, gt, ne, inArray } from "drizzle-orm";
import { createId } from "@pm/shared";
import { getDb, activityLog, tasks, epics, proposals, projects, users } from "../db/index.js";

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
  since?: string;
  excludeActorId?: string;
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

// ─── Enrichment ─────────────────────────────────────────────────

interface EnrichedFields {
  entityTitle?: string | null;
  epicName?: string | null;
  actorName?: string | null;
  actorType?: string | null;
}

/**
 * Enrich raw activity log entries with human-readable names.
 * Batch-queries related entities to avoid N+1 lookups.
 */
export function enrichActivityEntries<
  T extends {
    entityType: string;
    entityId: string;
    actorId: string | null;
  },
>(entries: T[]): (T & EnrichedFields)[] {
  if (entries.length === 0) return [];

  const db = getDb();

  // 1. Collect unique IDs by entity type
  const taskIds = new Set<string>();
  const epicIds = new Set<string>();
  const proposalIds = new Set<string>();
  const projectIds = new Set<string>();
  const actorIds = new Set<string>();

  for (const e of entries) {
    switch (e.entityType) {
      case "task":
        taskIds.add(e.entityId);
        break;
      case "epic":
        epicIds.add(e.entityId);
        break;
      case "proposal":
        proposalIds.add(e.entityId);
        break;
      case "project":
        projectIds.add(e.entityId);
        break;
    }
    if (e.actorId) actorIds.add(e.actorId);
  }

  // 2. Batch-query entities
  const taskMap = new Map<string, { title: string; epicId: string | null }>();
  if (taskIds.size > 0) {
    const rows = db
      .select({ id: tasks.id, title: tasks.title, epicId: tasks.epicId })
      .from(tasks)
      .where(inArray(tasks.id, [...taskIds]))
      .all();
    for (const r of rows) {
      taskMap.set(r.id, { title: r.title, epicId: r.epicId });
      if (r.epicId) epicIds.add(r.epicId);
    }
  }

  const epicMap = new Map<string, string>();
  if (epicIds.size > 0) {
    const rows = db
      .select({ id: epics.id, name: epics.name })
      .from(epics)
      .where(inArray(epics.id, [...epicIds]))
      .all();
    for (const r of rows) {
      epicMap.set(r.id, r.name);
    }
  }

  const proposalMap = new Map<string, string>();
  if (proposalIds.size > 0) {
    const rows = db
      .select({ id: proposals.id, title: proposals.title })
      .from(proposals)
      .where(inArray(proposals.id, [...proposalIds]))
      .all();
    for (const r of rows) {
      proposalMap.set(r.id, r.title);
    }
  }

  const projectMap = new Map<string, string>();
  if (projectIds.size > 0) {
    const rows = db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, [...projectIds]))
      .all();
    for (const r of rows) {
      projectMap.set(r.id, r.name);
    }
  }

  const userMap = new Map<string, { displayName: string; type: string }>();
  if (actorIds.size > 0) {
    const rows = db
      .select({ id: users.id, displayName: users.displayName, type: users.type })
      .from(users)
      .where(inArray(users.id, [...actorIds]))
      .all();
    for (const r of rows) {
      userMap.set(r.id, { displayName: r.displayName, type: r.type });
    }
  }

  // 3. Build enriched entries
  return entries.map((entry) => {
    let entityTitle: string | null = null;
    let epicName: string | null = null;

    switch (entry.entityType) {
      case "task": {
        const t = taskMap.get(entry.entityId);
        if (t) {
          entityTitle = t.title;
          if (t.epicId) epicName = epicMap.get(t.epicId) ?? null;
        }
        break;
      }
      case "epic":
        entityTitle = epicMap.get(entry.entityId) ?? null;
        break;
      case "proposal":
        entityTitle = proposalMap.get(entry.entityId) ?? null;
        break;
      case "project":
        entityTitle = projectMap.get(entry.entityId) ?? null;
        break;
    }

    const actor = entry.actorId ? userMap.get(entry.actorId) : undefined;

    return {
      ...entry,
      entityTitle,
      epicName,
      actorName: actor?.displayName ?? null,
      actorType: actor?.type ?? null,
    };
  });
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
  if (options?.since) {
    conditions.push(gt(activityLog.createdAt, options.since));
  }
  if (options?.excludeActorId) {
    conditions.push(ne(activityLog.actorId, options.excludeActorId));
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

  const rawData = db
    .select()
    .from(activityLog)
    .where(and(...conditions))
    .orderBy(desc(activityLog.createdAt))
    .limit(perPage)
    .offset(offset)
    .all();

  const data = enrichActivityEntries(rawData);

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

  const rawData = db
    .select()
    .from(activityLog)
    .where(and(...conditions))
    .orderBy(desc(activityLog.createdAt))
    .limit(perPage)
    .offset(offset)
    .all();

  const data = enrichActivityEntries(rawData);

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
 * List recent activity updates, excluding actions by a specific actor.
 * Designed for agents to poll for human activity between work steps.
 */
export function listUpdates(options: {
  since: string;
  excludeActorId: string;
  projectId?: string;
  limit?: number;
}) {
  const db = getDb();
  const maxEntries = Math.min(options.limit ?? 50, 50);

  const conditions: ReturnType<typeof eq>[] = [
    gt(activityLog.createdAt, options.since),
    ne(activityLog.actorId, options.excludeActorId),
  ];

  if (options.projectId) {
    conditions.push(eq(activityLog.projectId, options.projectId));
  }

  // Count total matching
  const totalResult = db
    .select({ count: count() })
    .from(activityLog)
    .where(and(...conditions))
    .get();
  const total = totalResult?.count ?? 0;

  const rawData = db
    .select()
    .from(activityLog)
    .where(and(...conditions))
    .orderBy(desc(activityLog.createdAt))
    .limit(maxEntries)
    .all();

  const data = enrichActivityEntries(rawData);

  return {
    has_updates: total > 0,
    count: total,
    data,
  };
}
