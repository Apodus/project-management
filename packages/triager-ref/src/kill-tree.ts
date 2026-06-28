import { spawn } from "node:child_process";

/**
 * Cross-platform process-tree kill (copied verbatim from responder-ref — which
 * itself copied it verbatim from integrator-ref — so the triager's assessment +
 * sniff spawns share ONE proven kill path; the triager package has no dependency
 * on responder-ref, so this is a copy, matching the integrator→responder
 * precedent). On Windows a raw `child.kill` only signals the shell, leaving the
 * real agent subprocess orphaned — `taskkill /T /F` terminates the whole tree.
 * On POSIX the child is spawned `detached` (its own group leader) so a
 * negative-pid kill takes the group.
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
