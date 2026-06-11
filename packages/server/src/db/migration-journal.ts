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

/**
 * All hashes under which this migration may legitimately appear in a DB's log:
 * the file as-is, plus its LF and CRLF renditions. Drizzle hashes the WORKING
 * TREE text at apply time, so a checkout-level line-ending flip changes the
 * recorded identity of an unchanged migration — proven on the live DB
 * (2026-06-11): rows for 0011–0015 carried the CRLF rendition of byte-LF files
 * after the repo's 2026-06-02 line-ending normalization. Same content, same
 * schema effect — a benign rendition, not divergence. Any hash outside this
 * set IS divergence and stays fail-loud.
 */
function migrationHashAliases(
  migrationsFolder: string,
  tag: string,
): { canonical: string; aliases: string[] } {
  const raw = fs.readFileSync(path.join(migrationsFolder, `${tag}.sql`), "utf8");
  const lf = raw.replace(/\r\n/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  const canonical = sha(raw);
  return { canonical, aliases: [...new Set([canonical, sha(lf), sha(crlf)])] };
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
 * Rewrite recorded rows that disagree with the shipped journal, matched by
 * migration hash INCLUDING line-ending renditions (see migrationHashAliases):
 * a matched row's `created_at` is set to the journal `when` and its hash is
 * CANONICALIZED to the current file's hash, so later assertions and heals are
 * rendition-independent. Returns the number of rows healed. Throws on a
 * recorded migration the journal does not contain under ANY rendition — the
 * log and the shipped migrations have genuinely diverged and continuing could
 * mis-apply schema changes.
 */
export function healMigrationLogDrift(rawDb: Database.Database, migrationsFolder: string): number {
  const rows = migrationLogRows(rawDb);
  if (!rows || rows.length === 0) return 0;

  const entries = readJournalEntries(migrationsFolder);
  const byAlias = new Map<string, { when: number; tag: string; canonical: string }>();
  for (const e of entries) {
    const { canonical, aliases } = migrationHashAliases(migrationsFolder, e.tag);
    for (const alias of aliases) {
      byAlias.set(alias, { when: e.when, tag: e.tag, canonical });
    }
  }

  const update = rawDb.prepare(
    "UPDATE __drizzle_migrations SET hash = ?, created_at = ? WHERE rowid = ?",
  );
  let healed = 0;
  for (const row of rows) {
    const expected = byAlias.get(row.hash);
    if (expected === undefined) {
      throw new Error(
        `Migration log integrity: __drizzle_migrations records a migration the shipped journal does not contain (hash ${row.hash.slice(0, 12)}…). ` +
          `The database's migration history and this build's migrations folder have diverged — refusing to start. ` +
          `Restore the matching migrations or investigate the database's provenance.`,
      );
    }
    if (Number(row.created_at) !== expected.when || row.hash !== expected.canonical) {
      update.run(expected.canonical, expected.when, row.rowid);
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
    // Rendition-aware membership (heal canonicalizes, but keep the assertion
    // independently robust — it must never false-alarm on a legacy rendition).
    const { aliases } = migrationHashAliases(migrationsFolder, entry.tag);
    if (!aliases.some((h) => appliedHashes.has(h))) {
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
