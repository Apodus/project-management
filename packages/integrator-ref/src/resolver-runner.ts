/**
 * Phase 7.6 §5.2 step 2 — the headless resolver runner.
 *
 * `ResolverRunner.run(...)` spawns a headless agent (default `claude -p`, or
 * `cfg.resolver.command`) in the materialized-conflict worktree with a reconcile
 * prompt, bounded by a wall-clock time budget (and an optional token budget,
 * surfaced as `PM_RESOLVER_TOKEN_BUDGET` for the agent to honor). ONE attempt —
 * no retry. The runner is the INJECTABLE seam: tests pass a fake that scripts an
 * outcome (and, in clean cases, writes a resolved file) so no real Claude binary
 * is needed; production wires `createClaudeResolverRunner`.
 *
 * Success is verify-gated DOWNSTREAM (the worker runs the 7.5 pipeline cache-OFF
 * as the sole arbiter). This runner's `ok:true` is a CHEAP pre-filter only — it
 * asserts merely that the agent exited 0 AND left no remaining conflict markers
 * (`<<<<<<<`) in the conflicting files. A residual marker ⇒ `unresolved`. The
 * spawn + SIGTERM→SIGKILL kill path mirrors `GitOps.runVerify` exactly (the kill
 * goes through `killTree`, NOT `child.kill`, because Windows needs `taskkill /T
 * /F` to take down the whole process tree).
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { killTree } from "./kill-tree.js";

export interface ResolverRunInput {
  worktreePath: string;
  conflictingFiles: string[];
  verifyCommand: string;
  budget: { timeBudgetSec: number; tokenBudget?: number };
  logPath: string;
  /** External-cancel seam (parity with runVerify): abort kills the agent tree. */
  signal?: AbortSignal;
}

export type ResolverRunResult =
  | { ok: true; durationMs: number; tokensConsumed?: number }
  | {
      ok: false;
      reason: "timeout" | "spawn_error" | "unresolved";
      durationMs: number;
      detail?: string;
    };

export interface ResolverRunner {
  run(input: ResolverRunInput): Promise<ResolverRunResult>;
}

const DEFAULT_RESOLVER_COMMAND = "claude -p";
const DEFAULT_KILL_GRACE_MS = 5000;
const CONFLICT_MARKER = "<<<<<<<";

/**
 * The reconcile prompt (design §5.2 step 2). Names the conflicting files and the
 * verify command so the agent has its full working contract: reconcile BOTH
 * intents, clear the markers, then verify.
 */
function buildReconcilePrompt(
  conflictingFiles: string[],
  verifyCommand: string,
): string {
  const files = conflictingFiles.length
    ? conflictingFiles.join(", ")
    : "(the files with conflict markers in this worktree)";
  return [
    `Two changes touched these files: ${files}.`,
    "They produced a merge conflict that has been materialized in this worktree —",
    "the conflict markers (<<<<<<<, =======, >>>>>>>) are in place.",
    "Reconcile BOTH intents: edit the conflicted files so the combined change",
    "preserves what each side was trying to do, and remove every conflict marker.",
    `Then run the verify command and report the result: ${verifyCommand}`,
  ].join(" ");
}

/** True iff any conflicting file still contains a `<<<<<<<` marker. */
async function hasRemainingMarkers(
  worktreePath: string,
  files: string[],
): Promise<boolean> {
  for (const rel of files) {
    try {
      const content = await readFile(path.join(worktreePath, rel), "utf8");
      if (content.includes(CONFLICT_MARKER)) return true;
    } catch {
      // A file the agent deleted (a legitimate resolution) or one we cannot read
      // is not a residual-marker signal — skip it.
    }
  }
  return false;
}

/**
 * Default runner: spawn the headless agent with the reconcile prompt. Mirrors
 * `GitOps.runVerify`'s spawn + timeout + SIGTERM→SIGKILL(killTree) lifecycle.
 *
 * `ok:true` ONLY when the child exits 0 AND no conflicting file still has a
 * marker. Timeout ⇒ `timeout`; spawn-level failure (ENOENT/EACCES) ⇒
 * `spawn_error`; exit ≠ 0 OR residual markers ⇒ `unresolved`.
 */
export function createClaudeResolverRunner(cfg: {
  resolver: { command?: string };
}): ResolverRunner {
  const command = cfg.resolver.command ?? DEFAULT_RESOLVER_COMMAND;

  return {
    run(input: ResolverRunInput): Promise<ResolverRunResult> {
      const start = Date.now();
      const timeoutMs = input.budget.timeBudgetSec * 1000;

      return new Promise<ResolverRunResult>((resolve) => {
        const logStream = createWriteStream(input.logPath, { flags: "a" });
        const prompt = buildReconcilePrompt(
          input.conflictingFiles,
          input.verifyCommand,
        );

        // The prompt is passed via stdin (the established `claude -p` contract:
        // the prompt is the piped/positional input). Writing it to stdin keeps
        // shell-quoting simple and command-agnostic for `resolver.command`
        // overrides.
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (input.budget.tokenBudget !== undefined) {
          env.PM_RESOLVER_TOKEN_BUDGET = String(input.budget.tokenBudget);
        }

        const child = spawn(command, {
          shell: true,
          cwd: input.worktreePath,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env,
        });

        let timedOut = false;
        let spawnErrored = false;
        let spawnErrorMsg: string | undefined;
        let settled = false;
        let sigkillTimer: NodeJS.Timeout | undefined;

        const onAbort = (): void => {
          if (child.pid !== undefined) killTree(child.pid, "SIGTERM");
        };
        const signal = input.signal;
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        child.stdout?.on("data", (d: Buffer) => logStream.write(d));
        child.stderr?.on("data", (d: Buffer) => logStream.write(d));

        // Feed the reconcile prompt then close stdin so the agent runs headless.
        try {
          child.stdin?.write(prompt);
          child.stdin?.end();
        } catch {
          /* stdin may be closed if the child already failed to spawn */
        }

        const timeout = setTimeout(() => {
          timedOut = true;
          if (child.pid !== undefined) {
            killTree(child.pid, "SIGTERM");
            sigkillTimer = setTimeout(() => {
              if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
            }, DEFAULT_KILL_GRACE_MS);
            sigkillTimer.unref?.();
          }
        }, timeoutMs);
        timeout.unref?.();

        const finish = async (
          exitCode: number | null,
        ): Promise<ResolverRunResult> => {
          const durationMs = Date.now() - start;
          if (timedOut) {
            return { ok: false, reason: "timeout", durationMs };
          }
          if (spawnErrored) {
            return {
              ok: false,
              reason: "spawn_error",
              durationMs,
              detail: spawnErrorMsg,
            };
          }
          if (exitCode !== 0) {
            return {
              ok: false,
              reason: "unresolved",
              durationMs,
              detail: `agent exited ${exitCode}`,
            };
          }
          // Exit 0 — verify no conflict markers remain in the conflicting files.
          if (await hasRemainingMarkers(input.worktreePath, input.conflictingFiles)) {
            return {
              ok: false,
              reason: "unresolved",
              durationMs,
              detail: "conflict markers remain after agent exit 0",
            };
          }
          return { ok: true, durationMs };
        };

        const settle = (exitCode: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (sigkillTimer) clearTimeout(sigkillTimer);
          if (signal) signal.removeEventListener("abort", onAbort);
          logStream.end(() => {
            void finish(exitCode).then(resolve);
          });
        };

        child.on("error", (err) => {
          if (!settled) {
            spawnErrored = true;
            spawnErrorMsg = err instanceof Error ? err.message : String(err);
          }
          settle(127);
        });
        child.on("exit", (code, sig) => {
          settle(code ?? (sig ? 1 : 0));
        });
      });
    },
  };
}
