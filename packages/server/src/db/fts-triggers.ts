/**
 * FTS5 trigger definitions for keeping external-content FTS tables in sync.
 *
 * For external-content FTS5 tables (content=tablename), you must manually
 * keep the FTS index in sync using triggers on the source table. The pattern
 * for each source table is:
 *
 * - AFTER INSERT: insert the new row into the FTS table
 * - AFTER UPDATE: delete the old row from FTS, then insert the new row
 * - AFTER DELETE: delete the old row from FTS
 *
 * For delete operations on external-content FTS5, you must supply the
 * original column values alongside the special '' command to identify
 * which entry to remove.
 */

// ─── proposals_fts triggers ──────────────────────────────────────

export const PROPOSALS_FTS_INSERT_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS proposals_fts_ai AFTER INSERT ON proposals BEGIN
  INSERT INTO proposals_fts(rowid, title, description)
    VALUES (NEW.rowid, NEW.title, NEW.description);
END;
`.trim();

export const PROPOSALS_FTS_UPDATE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS proposals_fts_au AFTER UPDATE ON proposals BEGIN
  INSERT INTO proposals_fts(proposals_fts, rowid, title, description)
    VALUES ('delete', OLD.rowid, OLD.title, OLD.description);
  INSERT INTO proposals_fts(rowid, title, description)
    VALUES (NEW.rowid, NEW.title, NEW.description);
END;
`.trim();

export const PROPOSALS_FTS_DELETE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS proposals_fts_ad AFTER DELETE ON proposals BEGIN
  INSERT INTO proposals_fts(proposals_fts, rowid, title, description)
    VALUES ('delete', OLD.rowid, OLD.title, OLD.description);
END;
`.trim();

// ─── tasks_fts triggers ─────────────────────────────────────────

export const TASKS_FTS_INSERT_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, description)
    VALUES (NEW.rowid, NEW.title, NEW.description);
END;
`.trim();

export const TASKS_FTS_UPDATE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
    VALUES ('delete', OLD.rowid, OLD.title, OLD.description);
  INSERT INTO tasks_fts(rowid, title, description)
    VALUES (NEW.rowid, NEW.title, NEW.description);
END;
`.trim();

export const TASKS_FTS_DELETE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
    VALUES ('delete', OLD.rowid, OLD.title, OLD.description);
END;
`.trim();

// ─── comments_fts triggers ──────────────────────────────────────

export const COMMENTS_FTS_INSERT_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS comments_fts_ai AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts(rowid, body)
    VALUES (NEW.rowid, NEW.body);
END;
`.trim();

export const COMMENTS_FTS_UPDATE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS comments_fts_au AFTER UPDATE ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, body)
    VALUES ('delete', OLD.rowid, OLD.body);
  INSERT INTO comments_fts(rowid, body)
    VALUES (NEW.rowid, NEW.body);
END;
`.trim();

export const COMMENTS_FTS_DELETE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS comments_fts_ad AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, body)
    VALUES ('delete', OLD.rowid, OLD.body);
END;
`.trim();

/** All FTS trigger creation statements, in order. */
export const ALL_FTS_TRIGGER_STATEMENTS = [
  PROPOSALS_FTS_INSERT_TRIGGER,
  PROPOSALS_FTS_UPDATE_TRIGGER,
  PROPOSALS_FTS_DELETE_TRIGGER,
  TASKS_FTS_INSERT_TRIGGER,
  TASKS_FTS_UPDATE_TRIGGER,
  TASKS_FTS_DELETE_TRIGGER,
  COMMENTS_FTS_INSERT_TRIGGER,
  COMMENTS_FTS_UPDATE_TRIGGER,
  COMMENTS_FTS_DELETE_TRIGGER,
] as const;
