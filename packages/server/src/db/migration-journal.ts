import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * Migration-journal integrity: heal + fail-loud assertion around drizzle's
 * `migrate()`.
 *
 * THE BUG THIS GUARDS (2026-06-10, live incident): drizzle's sqlite migrator
 * applies a journal entry iff `entry.when > MAX(__drizzle_migrations.created_at)`
 * and records `created_at = entry.when` on apply. Journal entries 0004–0026 were
 * hand-authored with FABRICATED sequential-midnight timestamps that marched into
 * the future (0026 = 2026-06-21) — so the auto-generated 0027 (real time,
 * 2026-06-10) sat BELOW the watermark and was silently skipped on every existing
 * DB; the server then 500'd on each request touching the missing column. The
 * journal has been repaired to real commit times, but any DB migrated under the
 * fabricated journal still carries the future watermark in its migration log —
 * without healing, the NEXT migration (0028+) would silently skip the same way.
 *
 * Two structural pieces:
 *  - `healMigrationLogDrift` (run BEFORE migrate): rewrites each recorded
 *    migration's `created_at` to the shipped journal's `when`, matched by the
 *    migration HASH (sha256 of the .sql file — drizzle's own identity, verified
 *    against drizzle-orm 0.45.2 sqlite dialect). Hash-keyed, so it is
 *    order-independent and refuses (throws) on a recorded migration the journal
 *    does not know — that is real divergence, not drift.
 *  - `assertMigrationLogCurrent` (run AFTER migrate): every journal entry must
 *    be recorded as applied and the watermark must equal the last entry's
 *    `when`. A silent skip becomes a refusal to boot with a pointed message
 *    instead of a 500 per request.
 *
 * Both are no-ops on a healthy DB and on fresh DBs (table absent / created by
 * migrate itself).
 */

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface MigrationLogRow {
  rowid: number;
  hash: string;
  created_at: number | string;
}

export function readJournalEntries(migrationsFolder: string): JournalEntry[] {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

/** sha256 over the raw migration file text — drizzle's migration identity. */
function migrationHash(migrationsFolder: string, tag: string): string {
  const sql = fs.readFileSync(path.join(migrationsFolder, `${tag}.sql`), "utf8");
  return crypto.createHash("sha256").update(sql).digest("hex");
}

function migrationLogRows(rawDb: Database.Database): MigrationLogRow[] | null {
  const table = rawDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    )
    .get();
  if (!table) return null;
  return rawDb
    .prepare("SELECT rowid, hash, created_at FROM __drizzle_migrations ORDER BY rowid")
    .all() as MigrationLogRow[];
}

/**
 * Rewrite recorded `created_at` values that disagree with the shipped journal
 * (hash-matched). Returns the number of rows healed. Throws on a recorded
 * migration the journal does not contain — the log and the shipped migrations
 * have genuinely diverged and continuing could mis-apply schema changes.
 */
export function healMigrationLogDrift(rawDb: Database.Database, migrationsFolder: string): number {
  const rows = migrationLogRows(rawDb);
  if (!rows || rows.length === 0) return 0;

  const entries = readJournalEntries(migrationsFolder);
  const whenByHash = new Map<string, { when: number; tag: string }>(
    entries.map((e) => [migrationHash(migrationsFolder, e.tag), { when: e.when, tag: e.tag }]),
  );

  const update = rawDb.prepare("UPDATE __drizzle_migrations SET created_at = ? WHERE rowid = ?");
  let healed = 0;
  for (const row of rows) {
    const expected = whenByHash.get(row.hash);
    if (expected === undefined) {
      throw new Error(
        `Migration log integrity: __drizzle_migrations records a migration the shipped journal does not contain (hash ${row.hash.slice(0, 12)}…). ` +
          `The database's migration history and this build's migrations folder have diverged — refusing to start. ` +
          `Restore the matching migrations or investigate the database's provenance.`,
      );
    }
    if (Number(row.created_at) !== expected.when) {
      update.run(expected.when, row.rowid);
      healed++;
    }
  }
  return healed;
}

/**
 * Fail-loud boot assertion: every journal entry applied, watermark exactly the
 * last entry's `when`. Catches the silent-skip class at startup instead of
 * letting the server 500 per request against a missing column/table.
 */
export function assertMigrationLogCurrent(
  rawDb: Database.Database,
  migrationsFolder: string,
): void {
  const entries = readJournalEntries(migrationsFolder);
  if (entries.length === 0) return;

  const rows = migrationLogRows(rawDb) ?? [];
  const appliedHashes = new Set(rows.map((r) => r.hash));

  for (const entry of entries) {
    if (!appliedHashes.has(migrationHash(migrationsFolder, entry.tag))) {
      throw new Error(
        `Migration log integrity: journal migration ${entry.tag} (idx ${entry.idx}) is NOT recorded as applied — ` +
          `a migration was silently skipped (the watermark/timestamp bug class). Refusing to start: ` +
          `the schema would be behind the code and every request touching the new schema would 500. ` +
          `Check meta/_journal.json 'when' monotonicity and the __drizzle_migrations table.`,
      );
    }
  }

  const lastWhen = entries[entries.length - 1]!.when;
  const watermark = rows.reduce((max, r) => Math.max(max, Number(r.created_at)), 0);
  if (watermark !== lastWhen) {
    throw new Error(
      `Migration log integrity: watermark MAX(created_at)=${watermark} != last journal 'when'=${lastWhen}. ` +
        `A future-stamped row would make the next migration silently skip. Refusing to start.`,
    );
  }
}
