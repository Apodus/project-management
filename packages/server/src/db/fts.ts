/**
 * FTS5 virtual table definitions for full-text search.
 *
 * These use content-sync (external content) tables pointing back
 * to the real tables. The `content_rowid=rowid` clause tells FTS5
 * to map its internal rowid to the source table's implicit rowid.
 *
 * Note: With external-content FTS5 tables you must keep the FTS
 * index in sync manually (via triggers or application code) when
 * rows in the source table are inserted, updated, or deleted.
 */

export const CREATE_PROPOSALS_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS proposals_fts USING fts5(
  title,
  description,
  content=proposals,
  content_rowid=rowid
);
`.trim();

export const CREATE_TASKS_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  title,
  description,
  content=tasks,
  content_rowid=rowid
);
`.trim();

export const CREATE_COMMENTS_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
  body,
  content=comments,
  content_rowid=rowid
);
`.trim();

export const CREATE_NOTES_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  body,
  content=notes,
  content_rowid=rowid
);
`.trim();

/** All FTS table creation statements, in order. */
export const ALL_FTS_STATEMENTS = [
  CREATE_PROPOSALS_FTS,
  CREATE_TASKS_FTS,
  CREATE_COMMENTS_FTS,
  CREATE_NOTES_FTS,
] as const;
