/**
 * The responder runner (Campaign C3 P2).
 *
 * The responder spawns a fresh headless client turn (default `claude -p`) seeded
 * with the escalation + thread so the agent reads it, investigates the PM repo
 * READ-ONLY, and declares an answer (or `needs_human`/`give_up`) — bounded by a
 * wall-clock time budget. ONE attempt, no retry. The agent NEVER mutates code;
 * the only artifact is the `answer` text P3 posts back to the thread.
 *
 * The runner is the INJECTABLE seam: tests pass a fake that scripts an outcome
 * (and, in clean cases, writes the status sentinel) so no real Claude binary is
 * needed; production wires `createClaudeResponderRunner`. The spawn +
 * SIGTERM→SIGKILL kill path mirrors the resolver/wake runners exactly (the kill
 * goes through `killTree`, NOT `child.kill`, because Windows needs `taskkill
 * /T /F` to take down the whole process tree); the wall-clock budget bounds the
 * whole session.
 *
 * The outcome is driven by a STATUS SENTINEL the agent writes — a JSON file at
 * `PM_RESPONDER_STATUS_PATH` (injected into the agent's env; the path lives
 * OUTSIDE any git tree, under the daemon's logsDir, so it never registers as a
 * working-tree change). Precedence on exit is STRICT (see `finish`):
 *   1. timeout      ⇒ {kind:"error", reason:"timeout"}
 *   2. spawn_error  ⇒ {kind:"error", reason:"spawn_error"}
 *   3. sentinel     ⇒ the agent's own `answered`/`needs_human`/`give_up`
 *   4. fallback     ⇒ absent / unparseable / unrecognized / answered-without-answer
 *                     all map to {kind:"error", reason:"spawn_error"}. An
 *                     `answered` is NEVER inferred from a clean exit.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import type { Escalation } from "@pm/shared";
import { killTree } from "./kill-tree.js";

export interface ResponderRunInput {
  /** The escalation this responder has claimed and is answering. */
  escalation: Escalation;
  /** The fully-substituted responder prompt fed to the worker on stdin. */
  prompt: string;
  budget: { timeBudgetSec: number; tokenBudget?: number };
  cwd: string;
  command: string;
  logPath: string;
  /**
   * Absolute path where the agent writes its status sentinel JSON
   * (`{"status":"answered","answer":…}` / `{"status":"needs_human","reason":…}` /
   * `{"status":"give_up","reason":…}`). Injected into the agent's env as
   * `PM_RESPONDER_STATUS_PATH`. This path MUST live OUTSIDE any git tree (the
   * daemon sets it under its logsDir) so the sentinel never registers as a
   * working-tree change. The runner deletes any stale file here before spawning.
   */
  statusPath: string;
  /** External-cancel seam: abort kills the worker tree. */
  signal?: AbortSignal;
}

/**
 * The C3 FOUR-STATE sentinel for a responder session:
 *   - `answered`     — the agent answered (and resolved) the escalation cleanly.
 *   - `needs_human`  — the agent decided a human is required (escalate, don't drop).
 *   - `give_up`      — the agent could not make progress and bowed out.
 *   - `error`        — the session itself failed: a `timeout` or a `spawn_error`.
 *
 * Mirrors the wake worker-runner's result shape, widened to the C3 self-declared
 * outcomes (P2 will derive `answered`/`needs_human`/`give_up` from a status
 * sentinel the agent writes, and `error` from the process lifecycle).
 */
export type ResponderRunResult =
  | { kind: "answered"; answer: string; durationMs: number }
  | { kind: "needs_human"; reason: string; durationMs: number }
  | { kind: "give_up"; reason: string; durationMs: number }
  | {
      kind: "error";
      reason: "timeout" | "spawn_error";
      durationMs: number;
      detail?: string;
    };

export interface ResponderRunner {
  run(input: ResponderRunInput): Promise<ResponderRunResult>;
}

const DEFAULT_RESPONDER_COMMAND = "claude -p";
const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * Default runner: spawn the headless agent with the responder prompt. Mirrors the
 * resolver runner's spawn + timeout + SIGTERM→SIGKILL(killTree) lifecycle.
 *
 * The outcome is driven by the agent's STATUS SENTINEL at
 * `PM_RESPONDER_STATUS_PATH` (injected into the agent env; the path lives OUTSIDE
 * any git tree). A stale sentinel is deleted before spawn. After exit, the verdict
 * follows the STRICT precedence documented on `finish`.
 */
export function createClaudeResponderRunner(cfg: { command?: string }): ResponderRunner {
  return {
    async run(input: ResponderRunInput): Promise<ResponderRunResult> {
      const command = input.command ?? cfg.command ?? DEFAULT_RESPONDER_COMMAND;
      const start = Date.now();
      const timeoutMs = input.budget.timeBudgetSec * 1000;

      // Delete any stale sentinel from a prior run BEFORE spawning, so a leftover
      // `answered` can never be mistaken for THIS run's declaration. `force: true`
      // ⇒ no-throw when the file is absent.
      await rm(input.statusPath, { force: true });

      return new Promise<ResponderRunResult>((resolve) => {
        const logStream = createWriteStream(input.logPath, { flags: "a" });

        // The agent declares its outcome by writing this JSON file; inject the
        // path. An optional token budget is surfaced for the agent to honor.
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (input.budget.tokenBudget !== undefined) {
          env.PM_RESPONDER_TOKEN_BUDGET = String(input.budget.tokenBudget);
        }
        env.PM_RESPONDER_STATUS_PATH = input.statusPath;

        const child = spawn(command, {
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

        // Feed the responder prompt then close stdin so the agent runs headless.
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

        // Post-exit verdict in STRICT precedence:
        //   1. timeout      — REGARDLESS of any sentinel written before the kill.
        //   2. spawn_error  — the child never really ran.
        //   3. sentinel     — the agent's own answered/needs_human/give_up.
        //   4. fallback     — no trustworthy declaration (absent / unparseable /
        //                     unrecognized / answered-without-answer) ⇒ a
        //                     spawn_error-classed error. `answered` is NEVER
        //                     inferred — only a sentinel with a non-empty answer
        //                     yields it.
        const finish = async (): Promise<ResponderRunResult> => {
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

          // The agent's status sentinel is the ONLY source of
          // answered/needs_human/give_up. A read/parse throw must NOT reject the
          // run — fall through to the fallback below.
          try {
            const raw = await readFile(input.statusPath, "utf8");
            const parsed = JSON.parse(raw) as {
              status?: unknown;
              answer?: unknown;
              reason?: unknown;
            };
            if (
              parsed.status === "answered" &&
              typeof parsed.answer === "string" &&
              parsed.answer.length > 0
            ) {
              return { kind: "answered", answer: String(parsed.answer), durationMs };
            }
            if (parsed.status === "needs_human") {
              return {
                kind: "needs_human",
                reason: String(parsed.reason ?? "needs_human"),
                durationMs,
              };
            }
            if (parsed.status === "give_up") {
              return {
                kind: "give_up",
                reason: String(parsed.reason ?? "give_up"),
                durationMs,
              };
            }
            // Recognized file but no usable status (incl. answered-without-answer)
            // → fall through.
          } catch {
            // Absent / unreadable / unparseable sentinel → fall through.
          }

          // Fallback: no trustworthy declaration. Treated as a failed session.
          return {
            kind: "error",
            reason: "spawn_error",
            durationMs,
            detail: "status sentinel absent or unrecognized",
          };
        };

        const settle = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (sigkillTimer) clearTimeout(sigkillTimer);
          if (signal) signal.removeEventListener("abort", onAbort);
          logStream.end(() => {
            void finish().then(resolve);
          });
        };

        child.on("error", (err) => {
          if (!settled) {
            spawnErrored = true;
            spawnErrorMsg = err instanceof Error ? err.message : String(err);
          }
          settle();
        });
        child.on("exit", () => {
          settle();
        });
      });
    },
  };
}
