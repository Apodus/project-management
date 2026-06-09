import { getRawDb } from "../db/index.js";

// ─── Types ────────────────────────────────────────────────────────

export interface SearchOptions {
  projectId?: string;
  entityType?: string; // "proposal", "task", "comment", "note"
  limit?: number;
}

export interface SearchResult {
  entityType: string;
  entityId: string;
  title: string;
  excerpt: string;
  rank: number;
  projectId: string | null;
}

// ─── Service functions ────────────────────────────────────────────

/**
 * Full-text search across proposals, tasks, and comments using FTS5 MATCH.
 *
 * Queries each FTS5 table, joins back to the source table for
 * entity ID and project ID, and unions results sorted by FTS5 rank.
 */
export function search(query: string, options?: SearchOptions): SearchResult[] {
  const rawDb = getRawDb();
  const limit = Math.max(1, Math.min(100, options?.limit ?? 20));

  // Sanitize the query for FTS5: wrap each token in double quotes
  // to prevent syntax errors from special characters
  const sanitizedQuery = sanitizeFtsQuery(query);

  if (!sanitizedQuery) {
    return [];
  }

  const results: SearchResult[] = [];
  const entityTypes = getEntityTypes(options?.entityType);

  // Search proposals
  if (entityTypes.includes("proposal")) {
    const proposalResults = searchProposals(rawDb, sanitizedQuery, options?.projectId);
    results.push(...proposalResults);
  }

  // Search tasks
  if (entityTypes.includes("task")) {
    const taskResults = searchTasks(rawDb, sanitizedQuery, options?.projectId);
    results.push(...taskResults);
  }

  // Search comments
  if (entityTypes.includes("comment")) {
    const commentResults = searchComments(rawDb, sanitizedQuery, options?.projectId);
    results.push(...commentResults);
  }

  // Search notes
  if (entityTypes.includes("note")) {
    results.push(...searchNotes(rawDb, sanitizedQuery, options?.projectId));
  }

  // Sort by rank (FTS5 rank is negative; more negative = better match)
  results.sort((a, b) => a.rank - b.rank);

  return results.slice(0, limit);
}

// ─── Internal helpers ────────────────────────────────────────────

function getEntityTypes(entityType?: string): string[] {
  if (entityType) {
    const valid = ["proposal", "task", "comment", "note"];
    if (valid.includes(entityType)) {
      return [entityType];
    }
    return [];
  }
  return ["proposal", "task", "comment", "note"];
}

/**
 * Sanitize a user query for FTS5 MATCH syntax.
 * Wraps individual tokens in double quotes to escape special chars,
 * preserving wildcard suffix (*) when present.
 */
export function sanitizeFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";

  // Split into tokens and wrap each in double quotes
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  return tokens
    .map((token) => {
      // Allow trailing wildcard
      if (token.endsWith("*")) {
        const base = token.slice(0, -1).replace(/"/g, "");
        return base ? `"${base}"*` : "";
      }
      return `"${token.replace(/"/g, "")}"`;
    })
    .filter(Boolean)
    .join(" ");
}

function searchProposals(
  rawDb: ReturnType<typeof getRawDb>,
  query: string,
  projectId?: string,
): SearchResult[] {
  let sql = `
    SELECT
      'proposal' as entity_type,
      p.id as entity_id,
      p.title as title,
      snippet(proposals_fts, 0, '<mark>', '</mark>', '...', 32) as excerpt,
      proposals_fts.rank as rank,
      p.project_id as project_id
    FROM proposals_fts
    JOIN proposals p ON p.rowid = proposals_fts.rowid
    WHERE proposals_fts MATCH ?
  `;
  const params: unknown[] = [query];

  if (projectId) {
    sql += ` AND p.project_id = ?`;
    params.push(projectId);
  }

  sql += ` ORDER BY rank LIMIT 100`;

  try {
    const stmt = rawDb.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      entity_type: string;
      entity_id: string;
      title: string;
      excerpt: string;
      rank: number;
      project_id: string | null;
    }>;

    return rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      title: row.title,
      excerpt: row.excerpt,
      rank: row.rank,
      projectId: row.project_id,
    }));
  } catch {
    return [];
  }
}

function searchTasks(
  rawDb: ReturnType<typeof getRawDb>,
  query: string,
  projectId?: string,
): SearchResult[] {
  let sql = `
    SELECT
      'task' as entity_type,
      t.id as entity_id,
      t.title as title,
      snippet(tasks_fts, 0, '<mark>', '</mark>', '...', 32) as excerpt,
      tasks_fts.rank as rank,
      t.project_id as project_id
    FROM tasks_fts
    JOIN tasks t ON t.rowid = tasks_fts.rowid
    WHERE tasks_fts MATCH ?
  `;
  const params: unknown[] = [query];

  if (projectId) {
    sql += ` AND t.project_id = ?`;
    params.push(projectId);
  }

  sql += ` ORDER BY rank LIMIT 100`;

  try {
    const stmt = rawDb.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      entity_type: string;
      entity_id: string;
      title: string;
      excerpt: string;
      rank: number;
      project_id: string | null;
    }>;

    return rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      title: row.title,
      excerpt: row.excerpt,
      rank: row.rank,
      projectId: row.project_id,
    }));
  } catch {
    return [];
  }
}

function searchNotes(
  rawDb: ReturnType<typeof getRawDb>,
  query: string,
  projectId?: string,
): SearchResult[] {
  let sql = `
    SELECT
      'note' as entity_type,
      n.id as entity_id,
      n.title as title,
      snippet(notes_fts, 0, '<mark>', '</mark>', '...', 32) as excerpt,
      notes_fts.rank as rank,
      n.project_id as project_id
    FROM notes_fts
    JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ?
  `;
  const params: unknown[] = [query];

  if (projectId) {
    sql += ` AND n.project_id = ?`;
    params.push(projectId);
  }

  sql += ` ORDER BY rank LIMIT 100`;

  try {
    const stmt = rawDb.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      entity_type: string;
      entity_id: string;
      title: string;
      excerpt: string;
      rank: number;
      project_id: string | null;
    }>;

    return rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      title: row.title,
      excerpt: row.excerpt,
      rank: row.rank,
      projectId: row.project_id,
    }));
  } catch {
    return [];
  }
}

function searchComments(
  rawDb: ReturnType<typeof getRawDb>,
  query: string,
  projectId?: string,
): SearchResult[] {
  let sql = `
    SELECT
      'comment' as entity_type,
      c.id as entity_id,
      COALESCE(c.body, '') as title,
      snippet(comments_fts, 0, '<mark>', '</mark>', '...', 32) as excerpt,
      comments_fts.rank as rank,
      COALESCE(t.project_id, p.project_id) as project_id
    FROM comments_fts
    JOIN comments c ON c.rowid = comments_fts.rowid
    LEFT JOIN tasks t ON t.id = c.task_id
    LEFT JOIN proposals p ON p.id = c.proposal_id
    WHERE comments_fts MATCH ?
  `;
  const params: unknown[] = [query];

  if (projectId) {
    sql += ` AND COALESCE(t.project_id, p.project_id) = ?`;
    params.push(projectId);
  }

  sql += ` ORDER BY rank LIMIT 100`;

  try {
    const stmt = rawDb.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      entity_type: string;
      entity_id: string;
      title: string;
      excerpt: string;
      rank: number;
      project_id: string | null;
    }>;

    return rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      title: row.title,
      excerpt: row.excerpt,
      rank: row.rank,
      projectId: row.project_id,
    }));
  } catch {
    return [];
  }
}
