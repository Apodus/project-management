import { existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

/**
 * Playwright global setup — runs once before all tests and before the
 * webServer is launched.
 *
 * Per-run DB design: playwright.config.ts computes a UNIQUE DB path per run
 * (`test-e2e-<timestamp>.db`) and exports it via process.env.PM_E2E_RUN_DB.
 * The active run's file is therefore fresh by construction — there is nothing
 * to delete for it, no lock to fight, no retry, no throw. This eliminates the
 * Windows zombie-handle stale-data cascade by design: a dead prior server may
 * still hold a lock on an OLD file, but we never touch that file again.
 *
 * All this setup does is best-effort sweep STALE test DBs (including the legacy
 * fixed `test-e2e.db` and any prior per-run files) out of `data/`. A failed
 * delete (an old file still locked by a zombie process) is harmless and
 * swallowed — that file will never be reused.
 */
export default function globalSetup(): void {
  const dataDir = path.resolve(process.cwd(), "data");

  // The active run's file + sidecars are skipped (fresh by construction).
  const activeRunDb = process.env.PM_E2E_RUN_DB;
  const activeBasenames = new Set<string>();
  if (activeRunDb) {
    const base = path.basename(activeRunDb);
    for (const suffix of ["", "-wal", "-shm"]) {
      activeBasenames.add(base + suffix);
    }
  }

  let entries: string[] = [];
  try {
    entries = existsSync(dataDir) ? readdirSync(dataDir) : [];
  } catch {
    // Can't list the dir — nothing to sweep, proceed.
    return;
  }

  for (const name of entries) {
    // Match the legacy fixed `test-e2e.db(-wal/-shm)` and any prior per-run
    // `test-e2e-<ts>.db(-wal/-shm)` files.
    if (!name.startsWith("test-e2e") || !name.includes(".db")) continue;
    if (activeBasenames.has(name)) continue; // never touch the active run

    try {
      unlinkSync(path.join(dataDir, name));
    } catch {
      // A zombie process may still hold a lock on this OLD file. Harmless —
      // we never reuse it. Swallow and move on.
    }
  }
}
