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
  /**
   * Set ONLY when the child failed to spawn (e.g. ENOENT/EACCES) — the
   * `child.on("error")` handler captures the error message here BEFORE resolving.
   * Undefined on every normal exit (including a normal non-zero exit), so the
   * retry classifier never mistakes a real verify failure for a transient spawn
   * failure. Threaded as a closure var into the resolved result, mirroring how
   * `timedOut` is reported.
   */
  spawnError?: string;
}

export interface RunVerifyOptions {
  cwd: string;
  logPath: string;
  killGracePeriodMs?: number;
  /**
   * External-cancel seam (phase 7.2 Step 6). When aborted, the verify child's
   * whole process tree is killed via the SAME `killTree` the internal timeout
   * uses (no second kill path). An aborted verify RESOLVES cleanly via the
   * `child.on("exit") → finish()` path (finish only resolves, never rejects),
   * so the killed task settles like any other. Backward compatible: callers
   * that omit `signal` (e.g. loop.ts) are unaffected.
   */
  signal?: AbortSignal;
}

export interface GitOps {
  fetch(remote: string): Promise<void>;
  /**
   * §4.3 cross-worktree materialization. Fetch a single not-yet-pushed COMMIT
   * `sha` from another clone's worktree path (used as a one-off local remote)
   * into THIS clone's object store, so a subsequent `rebaseOnto(sha, ref)` can
   * resolve it. `git fetch <local-path> <commit-sha>` over the local transport
   * copies the object reliably with no refspec — the SHA lands as a loose
   * object / `FETCH_HEAD`. This is how chain member K materializes member K-1's
   * rebased tree (which lives only in K-1's clone, never on the remote).
   */
  fetchFromPath(fromPath: string, sha: string): Promise<void>;
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

  async function fetchFromPath(fromPath: string, sha: string): Promise<void> {
    // Local-transport fetch of a single commit object by SHA. No refspec — git
    // copies the named object (and its history) into this clone's store.
    await git.raw(["fetch", fromPath, sha]);
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
      let spawnError: string | undefined;
      let settled = false;
      let sigkillTimer: NodeJS.Timeout | undefined;

      // External-cancel seam: kill the child's process tree on abort, reusing
      // the SAME killTree the timeout path uses. The kill makes the child exit,
      // which resolves the promise via finish() (never rejects).
      const onAbort = (): void => {
        if (child.pid !== undefined) killTree(child.pid, "SIGTERM");
      };
      const signal = runOpts.signal;
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

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

      const finish = (
        exitCode: number,
        exitSignal: NodeJS.Signals | null,
      ): void => {
        // Settled/finished guard: a spawn `error` can arrive after a partial
        // `exit` (or vice-versa); resolve exactly once so we never double-resolve.
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (signal) signal.removeEventListener("abort", onAbort);
        logStream.end(() => {
          resolve({
            exitCode,
            signal: exitSignal,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            durationMs: Date.now() - start,
            timedOut,
            spawnError,
            logPath: runOpts.logPath,
          });
        });
      };

      child.on("error", (err) => {
        // spawn-level failure (e.g. ENOENT). Surface as a non-zero exit with
        // the error text in the captured stderr so categorize() can read it.
        // Record `spawnError` (the retry classifier reads it to mark this
        // TRANSIENT) BEFORE calling finish — set it only on the first settle so
        // an `error` arriving after a partial `exit` does not overwrite/double.
        const s = errText(err);
        logStream.write(s);
        stderrBuf = appendCapped(stderrBuf, s);
        if (!settled) spawnError = s;
        finish(127, null);
      });

      child.on("exit", (code, signal) => {
        finish(code ?? (signal ? 1 : 0), signal);
      });
    });
  }

  return {
    fetch,
    fetchFromPath,
    checkout,
    rebaseOnto,
    push,
    resolveRef,
    runVerify,
  };
}
