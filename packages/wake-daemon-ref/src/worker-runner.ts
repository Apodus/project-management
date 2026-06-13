/**
 * The wake worker runner — spawns a fresh headless client worker turn (default
 * `claude -p`, or `config.workerCommand`) seeded with the wake prompt, bounded by
 * a wall-clock time budget. ONE attempt, no retry.
 *
 * Transplanted from integrator-ref's `resolver-runner.ts` MINUS the status
 * sentinel: a wake has no four-state self-declaration — its outcome is purely the
 * process lifecycle. SUCCESS classification (binding addition 2) is strict: a
 * clean bounded exit (exit 0, not timed out, not a spawn error) is the ONLY `ok`;
 * a timeout, a spawn-level failure, and a NON-ZERO exit are all failures (the
 * caller does NOT mark-delivered on a failure and increments the give-up counter).
 *
 * The runner is the INJECTABLE seam: tests pass a fake that scripts an outcome
 * so no real Claude binary is needed; production wires `createClaudeWorkerRunner`.
 * The spawn + SIGTERM→SIGKILL kill path mirrors the resolver runner exactly (the
 * kill goes through `killTree`, NOT `child.kill`, because Windows needs
 * `taskkill /T /F` to take down the whole tree).
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { Escalation, EscalationMessage } from "@pm/shared";
import { killTree } from "./kill-tree.js";

export interface WorkerRunInput {
  workerKey: string;
  escalation: Escalation;
  unreadMessages: EscalationMessage[];
  /** The fully-substituted wake prompt fed to the worker on stdin. */
  prompt: string;
  budget: { timeBudgetSec: number; tokenBudget?: number };
  cwd: string;
  command: string;
  logPath: string;
  /** External-cancel seam: abort kills the worker tree. */
  signal?: AbortSignal;
}

export type WorkerRunResult =
  | { kind: "ok"; durationMs: number }
  | {
      kind: "error";
      reason: "timeout" | "spawn_error" | "nonzero_exit";
      durationMs: number;
      detail?: string;
    };

export interface WorkerRunner {
  run(input: WorkerRunInput): Promise<WorkerRunResult>;
}

const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * Default runner: spawn the headless worker with the wake prompt on stdin.
 * Mirrors the resolver runner's spawn + timeout + SIGTERM→SIGKILL(killTree)
 * lifecycle. The verdict follows a STRICT precedence: timeout ⇒ `error{timeout}`;
 * spawn-level failure ⇒ `error{spawn_error}`; exit 0 (not timed out) ⇒ `ok`;
 * any non-zero exit ⇒ `error{nonzero_exit}`.
 */
export function createClaudeWorkerRunner(): WorkerRunner {
  return {
    run(input: WorkerRunInput): Promise<WorkerRunResult> {
      const start = Date.now();
      const timeoutMs = input.budget.timeBudgetSec * 1000;

      return new Promise<WorkerRunResult>((resolve) => {
        const logStream = createWriteStream(input.logPath, { flags: "a" });

        // The prompt rides stdin (the established `claude -p` contract). Token
        // budget, if set, is surfaced as an env var for the worker to honor.
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (input.budget.tokenBudget !== undefined) {
          env.PM_WAKE_TOKEN_BUDGET = String(input.budget.tokenBudget);
        }

        const child = spawn(input.command, {
          shell: true,
          cwd: input.cwd,
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

        // Feed the wake prompt then close stdin so the worker runs headless.
        try {
          child.stdin?.write(input.prompt);
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

        const finish = (exitCode: number | null): WorkerRunResult => {
          const durationMs = Date.now() - start;
          if (timedOut) {
            return { kind: "error", reason: "timeout", durationMs };
          }
          if (spawnErrored) {
            return {
              kind: "error",
              reason: "spawn_error",
              durationMs,
              detail: spawnErrorMsg,
            };
          }
          if (exitCode !== 0) {
            return {
              kind: "error",
              reason: "nonzero_exit",
              durationMs,
              detail: `worker exited ${exitCode}`,
            };
          }
          return { kind: "ok", durationMs };
        };

        const settle = (exitCode: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (sigkillTimer) clearTimeout(sigkillTimer);
          if (signal) signal.removeEventListener("abort", onAbort);
          const result = finish(exitCode);
          logStream.end(() => resolve(result));
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
