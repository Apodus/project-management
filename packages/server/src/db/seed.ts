import { eq, count } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { createId } from "@pm/shared";
import { workspaces } from "./schema.js";

/**
 * Seed a default workspace if none exists.
 * Idempotent: does nothing if any workspace already exists.
 */
export async function seedDefaultWorkspace(
  db: BetterSQLite3Database<Record<string, unknown>>,
): Promise<void> {
  const result = db.select({ total: count() }).from(workspaces).get();
  if (result && result.total > 0) {
    return;
  }

  const now = new Date().toISOString();
  db.insert(workspaces)
    .values({
      id: createId(),
      name: "Default Workspace",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}
