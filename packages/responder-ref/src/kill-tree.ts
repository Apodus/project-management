import { spawn } from "node:child_process";

/**
 * Cross-platform process-tree kill (copied verbatim from integrator-ref so the
 * responder spawn shares ONE kill path). On Windows a raw `child.kill` only
 * signals the shell, leaving the real agent subprocess orphaned — `taskkill
 * /T /F` terminates the whole tree. On POSIX the child is spawned `detached`
 * (its own group leader) so a negative-pid kill takes the group.
 *
 * Unused in the C3 P1 skeleton (no spawn yet), kept verbatim because P2's
 * responder runner needs exactly this kill path.
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
