import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ALL_FTS_STATEMENTS } from "./fts.js";
import { ALL_FTS_TRIGGER_STATEMENTS } from "./fts-triggers.js";
import { seedDefaultWorkspace } from "./seed.js";
import * as schema from "./schema.js";
import * as relations from "./relations.js";

export type AppDatabase = BetterSQLite3Database<typeof schema & typeof relations>;

let db: AppDatabase | null = null;
let rawDb: Database.Database | null = null;

export interface InitOptions {
  dbPath?: string;
  inMemory?: boolean;
}

/**
 * Resolve the migrations folder.
 * In dev (tsx from src/), migrations are at src/db/migrations relative to repo root.
 * In prod (node from dist/), migrations are at dist/db/migrations.
 * We check relative to the current file first, then fall back to src/db/migrations.
 */
function resolveMigrationsFolder(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));

  // First try: migrations next to the current file (works in both dev and prod)
  const adjacent = path.join(currentDir, "migrations");
  if (fs.existsSync(adjacent)) {
    return adjacent;
  }

  // Fallback: from project root src/db/migrations (when running from dist/)
  const fromDist = path.resolve(currentDir, "../../src/db/migrations");
  if (fs.existsSync(fromDist)) {
    return fromDist;
  }

  // If neither exists, return the adjacent path and let drizzle report the error
  return adjacent;
}

/**
 * Initialize the database: open connection, enable WAL + foreign keys,
 * run migrations, create FTS5 virtual tables, and seed defaults.
 */
export function initializeDatabase(options?: InitOptions): AppDatabase {
  if (db) {
    return db;
  }

  const dbPath = options?.inMemory
    ? ":memory:"
    : options?.dbPath ?? "./data/pm.db";

  // Ensure parent directory exists for file-based DBs
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  rawDb = new Database(dbPath);

  // Enable WAL mode for concurrent reads during writes
  rawDb.pragma("journal_mode = WAL");

  // Enable foreign key enforcement
  rawDb.pragma("foreign_keys = ON");

  db = drizzle(rawDb, { schema: { ...schema, ...relations } });

  // Run Drizzle migrations
  const migrationsFolder = resolveMigrationsFolder();
  migrate(db, { migrationsFolder });

  // Create FTS5 virtual tables
  for (const stmt of ALL_FTS_STATEMENTS) {
    rawDb.exec(stmt);
  }

  // Create FTS5 sync triggers
  for (const stmt of ALL_FTS_TRIGGER_STATEMENTS) {
    rawDb.exec(stmt);
  }

  // Seed default workspace
  seedDefaultWorkspace(db);

  return db;
}

/**
 * Get the initialized database singleton.
 * Throws if the database has not been initialized yet.
 */
export function getDb(): AppDatabase {
  if (!db) {
    throw new Error(
      "Database not initialized. Call initializeDatabase() first.",
    );
  }
  return db;
}

/**
 * Get the raw better-sqlite3 Database instance.
 * Needed for executing raw SQL (e.g., FTS triggers).
 * Throws if the database has not been initialized yet.
 */
export function getRawDb(): Database.Database {
  if (!rawDb) {
    throw new Error(
      "Database not initialized. Call initializeDatabase() first.",
    );
  }
  return rawDb;
}

/**
 * Close the database connection and reset the singleton.
 * Important for tests that need clean state between runs.
 */
export function closeDb(): void {
  if (rawDb) {
    rawDb.close();
    rawDb = null;
  }
  db = null;
}

// Re-exports
export * from "./schema.js";
export * from "./relations.js";
export { ALL_FTS_STATEMENTS } from "./fts.js";
export { ALL_FTS_TRIGGER_STATEMENTS } from "./fts-triggers.js";
export { seedDefaultWorkspace } from "./seed.js";
