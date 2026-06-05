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
 * The runner reports a four-state outcome driven by a STATUS SENTINEL the agent
 * writes — a JSON file at `PM_RESOLUTION_STATUS_PATH` (injected into the agent's
 * env; the path lives OUTSIDE the git worktree, under the pool's `logsDir`, so it
 * never shows up as a tree change):
 *   - `complete`   — the agent declared it reconciled both intents. Returned ONLY
 *                    when the sentinel says `{"status":"complete"}`. NEVER inferred
 *                    from a clean tree. Success is still verify-gated DOWNSTREAM
 *                    (the worker runs the 7.5 pipeline cache-OFF as the sole
 *                    arbiter) — `complete` is the agent's self-report, not a land.
 *   - `give_up`    — the agent declared it cannot reconcile (`{"status":"give_up",
 *                    "reason":...}`); the worker escalates with that reason.
 *   - `incomplete` — no trustworthy `complete`/`give_up` declaration: a timeout, a
 *                    spawn-level failure, or a fallthrough (absent / unparseable /
 *                    unrecognized sentinel, residual `<<<<<<<` markers, or a
 *                    non-zero exit). `reason` distinguishes `timeout` / `spawn_error`
 *                    / `markers`.
 *
 * Precedence on exit is STRICT: timeout ⇒ spawn_error ⇒ sentinel ⇒ marker/exit
 * fallback (see `finish`). The spawn + SIGTERM→SIGKILL kill path mirrors
 * `GitOps.runVerify` exactly (the kill goes through `killTree`, NOT `child.kill`,
 * because Windows needs `taskkill /T /F` to take down the whole process tree); the
 * wall-clock budget bounds the whole session.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_RESOLVER_PROMPT } from "@pm/shared";
import { killTree } from "./kill-tree.js";

export interface ResolverRunInput {
  worktreePath: string;
  conflictingFiles: string[];
  verifyCommand: string;
  budget: { timeBudgetSec: number; tokenBudget?: number };
  logPath: string;
  /**
   * The reconcile instruction template (`settings.integrator.resolver.prompt`).
   * Absent ⇒ DEFAULT_RESOLVER_PROMPT. `{files}` / `{verify_command}` are
   * substituted before the prompt is handed to the agent.
   */
  promptTemplate?: string;
  /**
   * Absolute path where the agent writes its status sentinel JSON
   * (`{"status":"complete"}` or `{"status":"give_up","reason":...}`). Injected
   * into the agent's env as `PM_RESOLUTION_STATUS_PATH`. This path MUST live
   * OUTSIDE the git worktree (the pool sets it under `wt.logsDir`) so the sentinel
   * never registers as a working-tree change the resolution would commit. The
   * runner deletes any stale file here before spawning.
   */
  statusPath: string;
  /** External-cancel seam (parity with runVerify): abort kills the agent tree. */
  signal?: AbortSignal;
}

export type ResolverRunResult =
  | { kind: "complete"; durationMs: number; tokensConsumed?: number }
  | { kind: "give_up"; reason: string; durationMs: number }
  | {
      kind: "incomplete";
      reason: "markers" | "timeout" | "spawn_error";
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
export function buildReconcilePrompt(
  template: string,
  conflictingFiles: string[],
  verifyCommand: string,
): string {
  const files = conflictingFiles.length
    ? conflictingFiles.join(", ")
    : "(the files with conflict markers in this worktree)";
  // Substitute the dynamic placeholders. A custom prompt that omits a placeholder
  // simply doesn't receive that detail — the substitution is replace-if-present.
  return template.split("{files}").join(files).split("{verify_command}").join(verifyCommand);
}

/** True iff any conflicting file still contains a `<<<<<<<` marker. */
async function hasRemainingMarkers(worktreePath: string, files: string[]): Promise<boolean> {
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
 * The outcome is driven by the agent's STATUS SENTINEL at `PM_RESOLUTION_STATUS_PATH`
 * (injected into the agent env; the path lives OUTSIDE the worktree, under the
 * pool's `logsDir`). A stale sentinel is deleted before spawn. After exit, the
 * verdict follows a STRICT precedence (see `finish`): timeout ⇒ `incomplete`
 * (`timeout`); spawn-level failure ⇒ `incomplete` (`spawn_error`); else the
 * sentinel decides — `complete` ⇒ `complete`, `give_up` ⇒ `give_up`; an absent /
 * unparseable / unrecognized sentinel falls through to the marker/exit fallback,
 * which yields `incomplete` (`markers`). `complete` is NEVER inferred from a clean
 * tree — only the sentinel can declare it.
 */
export function createClaudeResolverRunner(cfg: {
  resolver: { command?: string };
}): ResolverRunner {
  const command = cfg.resolver.command ?? DEFAULT_RESOLVER_COMMAND;

  return {
    async run(input: ResolverRunInput): Promise<ResolverRunResult> {
      const start = Date.now();
      const timeoutMs = input.budget.timeBudgetSec * 1000;

      // Delete any stale sentinel from a prior run BEFORE spawning, so a leftover
      // `complete` can never be mistaken for THIS run's declaration. `force: true`
      // ⇒ no-throw when the file is absent.
      await rm(input.statusPath, { force: true });

      return new Promise<ResolverRunResult>((resolve) => {
        const logStream = createWriteStream(input.logPath, { flags: "a" });
        const prompt = buildReconcilePrompt(
          input.promptTemplate ?? DEFAULT_RESOLVER_PROMPT,
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
        // The agent declares its outcome by writing this JSON file. Inject the
        // path so the agent knows where to write it.
        env.PM_RESOLUTION_STATUS_PATH = input.statusPath;

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

        // Post-exit verdict in STRICT precedence:
        //   1. timeout      — REGARDLESS of any sentinel the agent managed to
        //                      write before it was killed.
        //   2. spawn_error  — the child never really ran.
        //   3. sentinel     — the agent's own `complete` / `give_up` declaration.
        //   4. fallback     — no trustworthy declaration: residual markers, a
        //                      non-zero exit, or a clean exit-0 with NO sentinel
        //                      all map to `incomplete{markers}`. `complete` is
        //                      NEVER inferred here — only the sentinel declares it.
        const finish = async (exitCode: number | null): Promise<ResolverRunResult> => {
          const durationMs = Date.now() - start;
          if (timedOut) {
            return { kind: "incomplete", reason: "timeout", durationMs };
          }
          if (spawnErrored) {
            return {
              kind: "incomplete",
              reason: "spawn_error",
              durationMs,
              detail: spawnErrorMsg,
            };
          }

          // The agent's status sentinel is the ONLY source of `complete`/`give_up`.
          // A read/parse throw must NOT reject the run — fall through to the
          // marker/exit fallback below.
          try {
            const raw = await readFile(input.statusPath, "utf8");
            const parsed = JSON.parse(raw) as { status?: unknown; reason?: unknown };
            if (parsed.status === "complete") {
              return { kind: "complete", durationMs };
            }
            if (parsed.status === "give_up") {
              return {
                kind: "give_up",
                reason: String(parsed.reason ?? "give_up"),
                durationMs,
              };
            }
            // Recognized file but no recognized `status` → fall through.
          } catch {
            // Absent / unreadable / unparseable sentinel → fall through.
          }

          // Fallback: no trustworthy declaration. Residual markers, a non-zero
          // exit, and a clean exit-0 lacking a sentinel all mean the agent did
          // NOT declare completion ⇒ incomplete (markers).
          if (await hasRemainingMarkers(input.worktreePath, input.conflictingFiles)) {
            return {
              kind: "incomplete",
              reason: "markers",
              durationMs,
              detail: "conflict markers remain",
            };
          }
          if (exitCode !== 0) {
            return {
              kind: "incomplete",
              reason: "markers",
              durationMs,
              detail: `agent exited ${exitCode}`,
            };
          }
          return {
            kind: "incomplete",
            reason: "markers",
            durationMs,
            detail: "status file absent",
          };
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
