/**
 * The implement runner (Campaign A1 P2).
 *
 * The write-capable counterpart to the read-only responder runner. It spawns a
 * fresh headless client turn (default `claude -p`) seeded with the implement prompt
 * so the agent reads the escalation + thread, IMPLEMENTS the fix in an ISOLATED git
 * worktree, commits it to a branch, and declares via a status sentinel — bounded by
 * a wall-clock time budget. ONE attempt, no retry.
 *
 * The session runs with `cwd = input.worktreePath` — the worktree CLONE, never the
 * live repo / `main`. The runner is the INJECTABLE seam: tests pass a fake (or a
 * real `node <script>.cjs` agent stub) so no real Claude binary is needed;
 * production wires `createClaudeImplementRunner`. The spawn + SIGTERM→SIGKILL kill
 * path (via `killTree`, NOT `child.kill`, because Windows needs `taskkill /T /F`)
 * and the strict post-exit precedence are transplanted VERBATIM from the responder
 * runner; only the contract differs: a distinct `PM_IMPLEMENT_STATUS_PATH` sentinel
 * env var and a `branch_ready`/`give_up` two-state.
 *
 * COMMIT CROSS-CHECK (load-bearing) — mirrors the resolver runner's "NEVER infer
 * complete from a clean tree": a `branch_ready` outcome is NEVER inferred from the
 * sentinel alone. The runner captures the worktree's base HEAD BEFORE spawning;
 * on a `branch_ready` sentinel it verifies a REAL commit exists on HEAD beyond that
 * base (a `git rev-parse HEAD` + a `rev-list --count base..HEAD > 0` via a SimpleGit
 * bound to the worktree). If no commit beyond base exists the outcome falls through
 * to `error{spawn_error}` ("branch_ready declared but no commit on branch"). The
 * returned `commitSha` is the ACTUAL `git rev-parse HEAD`, never the sentinel's
 * self-asserted sha.
 *
 * Post-exit verdict precedence is STRICT (see `finish`):
 *   1. timeout      ⇒ {kind:"error", reason:"timeout"}
 *   2. spawn_error  ⇒ {kind:"error", reason:"spawn_error"}
 *   3. sentinel     ⇒ branch_ready (commit-cross-checked) | give_up
 *   4. fallback     ⇒ absent / unparseable / unrecognized ⇒ {kind:"error",
 *                     reason:"spawn_error"}. branch_ready is NEVER inferred.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { simpleGit } from "simple-git";
import type { Escalation, EscalationMessage } from "@pm/shared";
import { killTree } from "./kill-tree.js";

export interface ImplementRunInput {
  /** The escalation this session is implementing a fix for. */
  escalation: Escalation;
  /** The ordered escalation thread (context for the prompt). */
  thread: EscalationMessage[];
  /** The branch the agent commits its fix to. */
  branch: string;
  /**
   * The isolated worktree clone the session runs in (its cwd). NEVER the live
   * repo / main — a write session edits files here only.
   */
  worktreePath: string;
  budget: { timeBudgetSec: number; tokenBudget?: number };
  command: string;
  /** The fully-substituted implement prompt fed to the agent on stdin. */
  prompt: string;
  logPath: string;
  /**
   * Absolute path where the agent writes its status sentinel JSON
   * (`{"status":"branch_ready","branch":…,"commitSha":…}` /
   * `{"status":"give_up","reason":…}`). Injected into the agent's env as
   * `PM_IMPLEMENT_STATUS_PATH` (DISTINCT from PM_RESPONDER_STATUS_PATH). This
   * path MUST live OUTSIDE the worktree so the sentinel never registers as a
   * working-tree change. The runner deletes any stale file here before spawning.
   */
  statusPath: string;
  /** External-cancel seam: abort kills the worker tree. */
  signal?: AbortSignal;
}

/**
 * The implement-session outcome:
 *   - `branch_ready` — the agent committed a fix to the branch, CROSS-CHECKED
 *     against a real commit beyond the clone base. `commitSha` is the actual
 *     `git rev-parse HEAD` (never the sentinel's self-asserted value).
 *   - `give_up`      — the agent could not implement the fix and bowed out.
 *   - `error`        — the session itself failed: a `timeout`, a `spawn_error`,
 *     or a `branch_ready` that failed the commit cross-check.
 */
export type ImplementRunResult =
  | {
      kind: "branch_ready";
      branch: string;
      commitSha?: string;
      durationMs: number;
      tokensConsumed?: number;
    }
  | { kind: "give_up"; reason: string; durationMs: number }
  | {
      kind: "error";
      reason: "timeout" | "spawn_error";
      durationMs: number;
      detail?: string;
    };

export interface ImplementRunner {
  run(input: ImplementRunInput): Promise<ImplementRunResult>;
}

const DEFAULT_IMPLEMENT_COMMAND = "claude -p";
const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * Resolve the worktree's current HEAD sha (the clone's base, captured before the
 * session runs). Returns null if git is unreadable (e.g. an unborn/missing clone) —
 * in which case the cross-check treats a later branch_ready as having "no commit
 * beyond base", since there is no base to advance past.
 */
async function resolveHead(worktreePath: string): Promise<string | null> {
  try {
    const head = (await simpleGit(worktreePath).revparse(["HEAD"])).trim();
    return head.length > 0 ? head : null;
  } catch {
    return null;
  }
}

/**
 * Cross-check a declared `branch_ready` against the worktree's real git state:
 * resolve `HEAD` and confirm at least one commit exists beyond the captured base
 * (i.e. the agent actually committed). Returns the resolved HEAD sha on success,
 * or null when no commit beyond base exists / git is unreadable (the latter is
 * treated as no-commit — branch_ready is never trusted on uncertainty).
 *
 * The robust, clone-shape-agnostic test: `HEAD` resolves AND there is ≥1 commit on
 * HEAD not reachable from the pre-session base (`rev-list --count <base>..HEAD`).
 * If the base could not be resolved, HEAD simply differing from a (null) base is
 * insufficient — we require a non-empty base to count against.
 */
async function crossCheckCommit(
  worktreePath: string,
  baseSha: string | null,
): Promise<string | null> {
  if (baseSha === null) return null;
  try {
    const g = simpleGit(worktreePath);
    const head = (await g.revparse(["HEAD"])).trim();
    if (!head) return null;
    // Commits on HEAD not reachable from the captured base.
    const count = (await g.raw(["rev-list", "--count", `${baseSha}..HEAD`])).trim();
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return null;
    return head;
  } catch {
    return null;
  }
}

/**
 * Default runner: spawn the headless write-enabled agent with the implement prompt
 * in the isolated worktree. Transplants the responder runner's spawn + timeout +
 * SIGTERM→SIGKILL(killTree) lifecycle VERBATIM; the differences are cwd (the
 * worktree clone), the PM_IMPLEMENT_STATUS_PATH sentinel env var, and the
 * branch_ready commit cross-check.
 */
export function createClaudeImplementRunner(cfg: { command?: string }): ImplementRunner {
  return {
    async run(input: ImplementRunInput): Promise<ImplementRunResult> {
      const command = input.command ?? cfg.command ?? DEFAULT_IMPLEMENT_COMMAND;
      const start = Date.now();
      const timeoutMs = input.budget.timeBudgetSec * 1000;

      // Delete any stale sentinel from a prior run BEFORE spawning, so a leftover
      // `branch_ready` can never be mistaken for THIS run's declaration.
      // `force: true` ⇒ no-throw when the file is absent.
      await rm(input.statusPath, { force: true });

      // Capture the worktree's base HEAD BEFORE the session runs — the commit
      // cross-check confirms the agent advanced HEAD beyond this base.
      const baseSha = await resolveHead(input.worktreePath);

      return new Promise<ImplementRunResult>((resolve) => {
        const logStream = createWriteStream(input.logPath, { flags: "a" });

        // The agent declares its outcome by writing this JSON file; inject the
        // path. An optional token budget is surfaced for the agent to honor.
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (input.budget.tokenBudget !== undefined) {
          env.PM_IMPLEMENT_TOKEN_BUDGET = String(input.budget.tokenBudget);
        }
        env.PM_IMPLEMENT_STATUS_PATH = input.statusPath;

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

        // Feed the implement prompt then close stdin so the agent runs headless.
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
        //   3. sentinel     — branch_ready (commit-cross-checked) / give_up.
        //   4. fallback     — no trustworthy declaration (absent / unparseable /
        //                     unrecognized) ⇒ a spawn_error-classed error.
        //                     branch_ready is NEVER inferred from a clean exit, and
        //                     a branch_ready sentinel with no real commit on the
        //                     branch ALSO falls through to spawn_error.
        const finish = async (): Promise<ImplementRunResult> => {
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

          // The agent's status sentinel is the ONLY source of branch_ready/give_up.
          // A read/parse throw must NOT reject the run — fall through to fallback.
          try {
            const raw = await readFile(input.statusPath, "utf8");
            const parsed = JSON.parse(raw) as {
              status?: unknown;
              branch?: unknown;
              commitSha?: unknown;
              reason?: unknown;
            };
            if (parsed.status === "branch_ready") {
              // COMMIT CROSS-CHECK — never infer branch_ready from the sentinel
              // alone. Confirm a real commit exists on the branch beyond base; use
              // the actual HEAD sha (not the sentinel's self-asserted one).
              const branch =
                typeof parsed.branch === "string" && parsed.branch.length > 0
                  ? parsed.branch
                  : input.branch;
              const head = await crossCheckCommit(input.worktreePath, baseSha);
              if (head === null) {
                return {
                  kind: "error",
                  reason: "spawn_error",
                  durationMs,
                  detail: "branch_ready declared but no commit on branch",
                };
              }
              return {
                kind: "branch_ready",
                branch,
                commitSha: head,
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
            // Recognized file but no usable status → fall through.
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
