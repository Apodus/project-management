import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, getRawDb, initializeDatabase } from "../../src/db/index.js";
import {
  assertMigrationLogCurrent,
  healMigrationLogDrift,
  readJournalEntries,
} from "../../src/db/migration-journal.js";

// The shipped migrations folder (tests run from src — same resolution the
// server uses in dev).
const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

// ─── The root cause, pinned at the source ─────────────────────────────
//
// 2026-06-10 live incident: journal entries 0004–0026 were hand-authored with
// fabricated sequential-midnight `when` timestamps that marched into the
// FUTURE (0026 = 2026-06-21). drizzle applies a migration iff
// `when > MAX(created_at)`, so the auto-generated 0027 (real time) sat below
// the watermark and silently skipped; the server 500'd per request against
// the missing column. These pins make the journal itself unable to regress.
describe("migration journal hygiene", () => {
  it("journal 'when' values are strictly increasing", () => {
    const entries = readJournalEntries(MIGRATIONS);
    for (let i = 1; i < entries.length; i++) {
      expect(
        entries[i]!.when,
        `journal idx ${entries[i]!.idx} (${entries[i]!.tag}) must be > idx ${entries[i - 1]!.idx}`,
      ).toBeGreaterThan(entries[i - 1]!.when);
    }
  });

  it("no journal entry is stamped in the future (the fabrication that caused the silent skip)", () => {
    const entries = readJournalEntries(MIGRATIONS);
    const grace = Date.now() + 60_000;
    for (const e of entries) {
      expect(
        e.when,
        `journal idx ${e.idx} (${e.tag}) is future-stamped — hand-authored entries must use the real authoring time (Date.now()), or the NEXT db:generate migration will silently skip on existing databases`,
      ).toBeLessThan(grace);
    }
  });
});

// ─── Heal + fail-loud assertion (integration, real file-backed DBs) ────
describe("migration log heal + boot assertion", () => {
  let tmpRoot: string | null = null;

  afterEach(() => {
    closeDb();
    if (tmpRoot) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      tmpRoot = null;
    }
  });

  function freshDbPath(): string {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-journal-"));
    return path.join(tmpRoot, "pm.db");
  }

  it("fresh DB boots with the assertion passing and a fully in-sync log", () => {
    const dbPath = freshDbPath();
    initializeDatabase({ dbPath });
    const raw = getRawDb();
    expect(() => assertMigrationLogCurrent(raw, MIGRATIONS)).not.toThrow();

    const entries = readJournalEntries(MIGRATIONS);
    const rows = raw
      .prepare("SELECT created_at FROM __drizzle_migrations ORDER BY rowid")
      .all() as { created_at: number }[];
    expect(rows.length).toBe(entries.length);
    rows.forEach((r, i) => expect(Number(r.created_at)).toBe(entries[i]!.when));
  });

  it("REGRESSION (the live incident): future watermark + skipped migration → boot heals, applies, and ends current", () => {
    const dbPath = freshDbPath();
    initializeDatabase({ dbPath });
    closeDb();

    // Reconstruct the broken state: every recorded migration future-stamped
    // (the fabricated journal's footprint), the LAST migration unrecorded and
    // its schema effect reverted — exactly what a DB migrated under the old
    // journal looked like the moment 0027 shipped (the live incident; the
    // simulation tracks whatever migration is CURRENTLY last).
    //
    // MAINTENANCE NOTE: the revert below must undo the last SCHEMA migration's
    // effect. The CURRENT last migration (0034) is a DATA migration with no
    // schema effect to revert, so this simulation unrecords the last TWO entries
    // — the data migration 0034 AND the last schema migration 0033 — reverts
    // 0033's column, and proves boot heals the watermark then re-applies BOTH
    // (0033 restores the column; 0034's backfill re-runs idempotently). When you
    // add a SCHEMA migration on top, update LAST_REVERT + LAST_COLUMN_CHECK and
    // the delete count to cover back through it — this test fails loudly
    // (duplicate column on re-apply, or a missing column) if they fall behind.
    const LAST_REVERT = "ALTER TABLE merge_requests DROP COLUMN revert_of;"; // 0033
    const LAST_COLUMN_CHECK = {
      table: "merge_requests",
      column: "revert_of",
    };
    const raw = new Database(dbPath);
    // The genuinely-last two recorded migrations (0034 data + 0033 schema).
    const lastTwo = raw
      .prepare("SELECT rowid, hash FROM __drizzle_migrations ORDER BY rowid DESC LIMIT 2")
      .all() as { rowid: number; hash: string }[];
    const last = lastTwo[0]!; // 0034 — the genuinely-last entry
    const delStmt = raw.prepare("DELETE FROM __drizzle_migrations WHERE rowid = ?");
    for (const r of lastTwo) delStmt.run(r.rowid);
    raw.exec(LAST_REVERT);
    const future = Date.parse("2026-06-21T00:00:00Z");
    raw.prepare("UPDATE __drizzle_migrations SET created_at = ? + rowid").run(future);
    raw.close();

    // Sanity: with the future watermark, a bare drizzle migrate would skip the
    // missing migration (its journal 'when' is below the watermark) — that is
    // the bug. Boot must heal the watermark FIRST, then apply, then assert.
    initializeDatabase({ dbPath });
    const healedRaw = getRawDb();

    const cols = (
      healedRaw.prepare(`PRAGMA table_info(${LAST_COLUMN_CHECK.table})`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain(LAST_COLUMN_CHECK.column);

    const entries = readJournalEntries(MIGRATIONS);
    const rows = healedRaw
      .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid")
      .all() as { hash: string; created_at: number }[];
    expect(rows.length).toBe(entries.length);
    expect(rows.some((r) => r.hash === last.hash)).toBe(true);
    const watermark = Math.max(...rows.map((r) => Number(r.created_at)));
    expect(watermark).toBe(entries[entries.length - 1]!.when);
    expect(() => assertMigrationLogCurrent(healedRaw, MIGRATIONS)).not.toThrow();
  });

  it("heal rewrites drifted timestamps idempotently and reports the count", () => {
    const dbPath = freshDbPath();
    initializeDatabase({ dbPath });
    const raw = getRawDb();
    const future = Date.parse("2026-06-21T00:00:00Z");
    raw.prepare("UPDATE __drizzle_migrations SET created_at = ? + rowid").run(future);

    const healed = healMigrationLogDrift(raw, MIGRATIONS);
    expect(healed).toBeGreaterThan(0);
    expect(healMigrationLogDrift(raw, MIGRATIONS)).toBe(0); // idempotent
    expect(() => assertMigrationLogCurrent(raw, MIGRATIONS)).not.toThrow();
  });

  it("REGRESSION (live boot failure 2026-06-11): a CRLF-rendition hash is the SAME migration — healed + canonicalized, never a divergence throw", () => {
    const dbPath = freshDbPath();
    initializeDatabase({ dbPath });
    closeDb();

    // Reconstruct the live state: rows recorded when the working tree had CRLF
    // line endings (pre-normalization checkout); today's files are LF. Same
    // content, different rendition — drizzle hashed the working-tree text at
    // apply time, so the recorded hash differs from the current file's.
    const entries = readJournalEntries(MIGRATIONS);
    const raw = new Database(dbPath);
    for (const idx of [11, 12, 13]) {
      const sql = readFileSync(path.join(MIGRATIONS, `${entries[idx]!.tag}.sql`), "utf8");
      const crlf = sql.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
      const crlfHash = crypto.createHash("sha256").update(crlf).digest("hex");
      raw
        .prepare("UPDATE __drizzle_migrations SET hash = ? WHERE rowid = ?")
        .run(crlfHash, idx + 1);
    }
    raw.close();

    // Boot must recognize the rendition, canonicalize, and come up clean.
    initializeDatabase({ dbPath });
    const healedRaw = getRawDb();
    expect(() => assertMigrationLogCurrent(healedRaw, MIGRATIONS)).not.toThrow();
    const rows = healedRaw
      .prepare("SELECT hash FROM __drizzle_migrations ORDER BY rowid")
      .all() as { hash: string }[];
    for (const idx of [11, 12, 13]) {
      const sql = readFileSync(path.join(MIGRATIONS, `${entries[idx]!.tag}.sql`), "utf8");
      const canonical = crypto.createHash("sha256").update(sql).digest("hex");
      expect(rows[idx]!.hash).toBe(canonical);
    }
  });

  it("fails loud (refuses to boot) when the log records a migration the journal does not contain", () => {
    const dbPath = freshDbPath();
    initializeDatabase({ dbPath });
    closeDb();

    const raw = new Database(dbPath);
    raw
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run("f".repeat(64), Date.now());
    raw.close();

    expect(() => initializeDatabase({ dbPath })).toThrow(/diverged|refusing to start/);
  });

  it("assertion fails loud when a journal migration is missing from the log (the silent-skip symptom)", () => {
    const dbPath = freshDbPath();
    initializeDatabase({ dbPath });
    const raw = getRawDb();
    raw
      .prepare(
        "DELETE FROM __drizzle_migrations WHERE rowid = (SELECT MAX(rowid) FROM __drizzle_migrations)",
      )
      .run();
    expect(() => assertMigrationLogCurrent(raw, MIGRATIONS)).toThrow(/silently skipped/);
  });

  it("the journal hash contract matches drizzle's (sha256 of the raw migration file)", () => {
    const dbPath = freshDbPath();
    initializeDatabase({ dbPath });
    const raw = getRawDb();
    const entries = readJournalEntries(MIGRATIONS);
    const rows = raw.prepare("SELECT hash FROM __drizzle_migrations ORDER BY rowid").all() as {
      hash: string;
    }[];
    // Spot-check first + last: recompute from the file exactly as
    // migration-journal.ts does and compare to what drizzle recorded.
    for (const i of [0, entries.length - 1]) {
      const sql = readFileSync(path.join(MIGRATIONS, `${entries[i]!.tag}.sql`), "utf8");
      const computed = crypto.createHash("sha256").update(sql).digest("hex");
      expect(rows[i]!.hash).toBe(computed);
    }
  });
});
