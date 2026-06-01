import { spawn } from "node:child_process";

/**
 * Cross-platform process-tree kill (extracted from git-ops.ts so both the verify
 * spawn and the Phase 7.6 resolver spawn share ONE kill path). On Windows a raw
 * `child.kill` only signals the shell, leaving the real agent/verify subprocess
 * orphaned — `taskkill /T /F` terminates the whole tree. On POSIX the child is
 * spawned `detached` (its own group leader) so a negative-pid kill takes the
 * group.
 */
export function killTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    const tk = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    tk.on("error", () => {
      /* best-effort */
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}
