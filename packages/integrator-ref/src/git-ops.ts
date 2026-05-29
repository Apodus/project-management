import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { SimpleGit } from "simple-git";

// ─── Result types ─────────────────────────────────────────────────

export interface RebaseSuccess {
  ok: true;
  treeSha: string;
}

export interface RebaseConflict {
  ok: false;
  conflictingFiles: string[];
  stderr: string;
}

export type RebaseResult = RebaseSuccess | RebaseConflict;

export interface PushSuccess {
  ok: true;
  pushedSha: string;
}

export interface PushFailure {
  ok: false;
  reason: "non_fast_forward" | "auth" | "network" | "other";
  stderr: string;
}

export type PushResult = PushSuccess | PushFailure;

export interface VerifyResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  logPath: string;
}

export interface RunVerifyOptions {
  cwd: string;
  logPath: string;
  killGracePeriodMs?: number;
}

export interface GitOps {
  fetch(remote: string): Promise<void>;
  checkout(ref: string): Promise<void>;
  rebaseOnto(base: string, branch: string): Promise<RebaseResult>;
  push(remote: string, branch: string): Promise<PushResult>;
  resolveRef(ref: string): Promise<string>;
  runVerify(
    command: string,
    timeoutMs: number,
    opts: RunVerifyOptions,
  ): Promise<VerifyResult>;
}

export interface GitOpsOptions {
  /** Max bytes captured into the in-memory stdout/stderr buffers. */
  maxBufferBytes?: number;
}

const DEFAULT_MAX_BUFFER = 1024 * 1024; // 1 MiB
const DEFAULT_KILL_GRACE_MS = 5000;

// ─── Push failure classification ──────────────────────────────────

function classifyPushFailure(stderr: string): PushFailure["reason"] {
  if (/non-fast-forward|fetch first|stale info/i.test(stderr)) {
    return "non_fast_forward";
  }
  if (/permission denied|publickey|authentication failed|403/i.test(stderr)) {
    return "auth";
  }
  if (/could not resolve|connection refused|network|timed out|getaddrinfo/i.test(stderr)) {
    return "network";
  }
  return "other";
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ─── Process-tree kill (cross-platform) ───────────────────────────

function killTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    // taskkill terminates the whole process tree. /T = tree, /F = force.
    const tk = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    tk.on("error", () => {
      /* best-effort */
    });
    return;
  }
  // POSIX: kill the process group (negative pid). spawn used detached so the
  // child is its own group leader.
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

// ─── Factory ──────────────────────────────────────────────────────

export function createGitOps(git: SimpleGit, opts: GitOpsOptions = {}): GitOps {
  const maxBuffer = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER;

  async function fetch(remote: string): Promise<void> {
    await git.fetch(remote);
  }

  async function checkout(ref: string): Promise<void> {
    await git.checkout(ref);
  }

  async function rebaseOnto(base: string, branch: string): Promise<RebaseResult> {
    await git.checkout(branch);
    try {
      await git.rebase([base]);
      const treeSha = (await git.revparse(["HEAD"])).trim();
      return { ok: true, treeSha };
    } catch (err) {
      let conflictingFiles: string[] = [];
      try {
        const diff = await git.raw([
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]);
        conflictingFiles = diff
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      } catch {
        /* ignore — best-effort conflict-file capture */
      }
      try {
        await git.rebase(["--abort"]);
      } catch {
        /* ignore — abort may itself fail on a corrupt state */
      }
      return { ok: false, conflictingFiles, stderr: errText(err) };
    }
  }

  async function push(remote: string, branch: string): Promise<PushResult> {
    try {
      // Push the rebased tree (current HEAD) to the target branch. After
      // rebaseOnto(), HEAD is the rebased feature commit but the local
      // `branch` ref still points at the old base — so a plain
      // `git push origin <branch>` would be a no-op that never advances the
      // remote. The explicit HEAD:<branch> refspec fast-forwards the remote
      // branch to the verified tree. (Discovered by the full-stack E2E:
      // land previously reported success without moving remote main.)
      await git.push(remote, `HEAD:${branch}`);
      const pushedSha = (await git.revparse(["HEAD"])).trim();
      return { ok: true, pushedSha };
    } catch (err) {
      const stderr = errText(err);
      return { ok: false, reason: classifyPushFailure(stderr), stderr };
    }
  }

  async function resolveRef(ref: string): Promise<string> {
    return (await git.revparse([ref])).trim();
  }

  function runVerify(
    command: string,
    timeoutMs: number,
    runOpts: RunVerifyOptions,
  ): Promise<VerifyResult> {
    const killGrace = runOpts.killGracePeriodMs ?? DEFAULT_KILL_GRACE_MS;
    const start = Date.now();

    return new Promise<VerifyResult>((resolve) => {
      const logStream = createWriteStream(runOpts.logPath, { flags: "a" });

      const child = spawn(command, {
        shell: true,
        cwd: runOpts.cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdoutBuf = "";
      let stderrBuf = "";
      let timedOut = false;
      let sigkillTimer: NodeJS.Timeout | undefined;

      const appendCapped = (current: string, chunk: string): string => {
        if (current.length >= maxBuffer) return current;
        const room = maxBuffer - current.length;
        return current + (chunk.length > room ? chunk.slice(0, room) : chunk);
      };

      child.stdout?.on("data", (d: Buffer) => {
        const s = d.toString();
        logStream.write(s);
        stdoutBuf = appendCapped(stdoutBuf, s);
      });
      child.stderr?.on("data", (d: Buffer) => {
        const s = d.toString();
        logStream.write(s);
        stderrBuf = appendCapped(stderrBuf, s);
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          killTree(child.pid, "SIGTERM");
          sigkillTimer = setTimeout(() => {
            if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
          }, killGrace);
          // Don't keep the event loop alive solely for the grace timer.
          sigkillTimer.unref?.();
        }
      }, timeoutMs);
      timeout.unref?.();

      const finish = (exitCode: number, signal: NodeJS.Signals | null): void => {
        clearTimeout(timeout);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        logStream.end(() => {
          resolve({
            exitCode,
            signal,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            durationMs: Date.now() - start,
            timedOut,
            logPath: runOpts.logPath,
          });
        });
      };

      child.on("error", (err) => {
        // spawn-level failure (e.g. ENOENT). Surface as a non-zero exit with
        // the error text in the captured stderr so categorize() can read it.
        const s = errText(err);
        logStream.write(s);
        stderrBuf = appendCapped(stderrBuf, s);
        finish(127, null);
      });

      child.on("exit", (code, signal) => {
        finish(code ?? (signal ? 1 : 0), signal);
      });
    });
  }

  return { fetch, checkout, rebaseOnto, push, resolveRef, runVerify };
}
