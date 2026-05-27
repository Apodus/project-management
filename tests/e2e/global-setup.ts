import { existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

/**
 * Playwright global setup — runs once before all tests and before the
 * webServer is launched.  We delete the test database so every test run
 * begins completely clean.
 */
export default function globalSetup(): void {
  const dataDir = path.resolve(process.cwd(), "data");
  const dbPath = path.resolve(dataDir, "test-e2e.db");

  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        // On Windows, Node's unlinkSync may fail on locked files.
        // Fall back to del command which can sometimes succeed.
        try {
          execSync(`del /f /q "${p.replace(/\//g, "\\")}"`, {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          console.warn(`Could not reset ${p} — file is locked. Tests may reuse old data.`);
        }
      }
    }
  }
}
