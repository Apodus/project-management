/**
 * The triage assessment runner (Campaign T2·P3).
 *
 * The triager spawns a fresh headless client turn (default `claude -p`) seeded
 * with the assessment prompt so the agent reads the note, investigates the PM repo
 * READ-ONLY, and declares a structured triage decision — bounded by a wall-clock
 * time budget. ONE attempt, no retry. The agent NEVER mutates code; the only
 * artifact is the decision sentinel.
 *
 * MIRRORS responder-runner.ts's spawn + SIGTERM→SIGKILL(killTree) lifecycle
 * verbatim (the kill goes through `killTree`, NOT `child.kill`, because Windows
 * needs `taskkill /T /F`). The outcome is driven by the agent's STATUS SENTINEL at
 * `PM_TRIAGE_STATUS_PATH` (injected into the agent env; the path lives OUTSIDE any
 * git tree). A stale sentinel is deleted before spawn. Precedence on exit is
 * STRICT, fail-safe:
 *   1. timeout      ⇒ {kind:"error", reason:"timeout"}
 *   2. spawn_error  ⇒ {kind:"error", reason:"spawn_error"}
 *   3. sentinel     ⇒ parseAssessmentSentinel(raw) (the agent's TriageAssessment)
 *   4. fallback (absent / unparseable / unrecognized) ⇒ {kind:"error",
 *      reason:"spawn_error"}. A promote/dismiss is NEVER fabricated — only the
 *      agent's own trusted sentinel yields one; everything else is an error.
 *
 * The runner is the INJECTABLE seam: tests pass `createFakeAssessmentRunner`;
 * production wires `createClaudeAssessmentRunner`.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import type { Note } from "@pm/shared";
import { killTree } from "./kill-tree.js";
import { parseAssessmentSentinel, type TriageAssessment } from "./decision.js";

export interface AssessmentRunInput {
  /** The note being assessed. */
  note: Note;
  /** The fully-substituted assessment prompt fed to the worker on stdin. */
  prompt: string;
  budget: { timeBudgetSec: number; tokenBudget?: number };
  cwd: string;
  command: string;
  logPath: string;
  /**
   * Absolute path where the agent writes its decision sentinel JSON. Injected as
   * `PM_TRIAGE_STATUS_PATH`. MUST live OUTSIDE any git tree. The runner deletes
   * any stale file here before spawning.
   */
  statusPath: string;
  /** External-cancel seam: abort kills the worker tree. */
  signal?: AbortSignal;
}

/**
 * The assessment outcome: either the agent's trusted `TriageAssessment`, or an
 * `error` (a failed session — a `timeout` or a `spawn_error`). The runner NEVER
 * fabricates a promote/dismiss; an untrustworthy session is always an error.
 */
export type AssessmentResult =
  | TriageAssessment
  | { kind: "error"; reason: "timeout" | "spawn_error"; detail?: string };

export interface AssessmentRunner {
  run(input: AssessmentRunInput): Promise<AssessmentResult>;
}

const DEFAULT_ASSESSMENT_COMMAND = "claude -p";
const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * Default runner: spawn the headless agent with the assessment prompt. Mirrors the
 * responder-runner's spawn + timeout + SIGTERM→SIGKILL(killTree) lifecycle. The
 * verdict follows the STRICT precedence documented on `finish`.
 */
export function createClaudeAssessmentRunner(cfg: { command?: string }): AssessmentRunner {
  return {
    async run(input: AssessmentRunInput): Promise<AssessmentResult> {
      const command = input.command ?? cfg.command ?? DEFAULT_ASSESSMENT_COMMAND;
      const timeoutMs = input.budget.timeBudgetSec * 1000;

      // Delete any stale sentinel from a prior run BEFORE spawning, so a leftover
      // decision can never be mistaken for THIS run's. `force: true` ⇒ no-throw
      // when the file is absent.
      await rm(input.statusPath, { force: true });

      return new Promise<AssessmentResult>((resolve) => {
        const logStream = createWriteStream(input.logPath, { flags: "a" });

        const env: NodeJS.ProcessEnv = { ...process.env };
        if (input.budget.tokenBudget !== undefined) {
          env.PM_TRIAGE_TOKEN_BUDGET = String(input.budget.tokenBudget);
        }
        env.PM_TRIAGE_STATUS_PATH = input.statusPath;

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

        // Feed the assessment prompt then close stdin so the agent runs headless.
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
        //   3. sentinel     — parseAssessmentSentinel returns a trusted decision.
        //   4. fallback     — absent / unparseable / unrecognized ⇒ a spawn_error.
        //                     A promote/dismiss is NEVER fabricated.
        const finish = async (): Promise<AssessmentResult> => {
          if (timedOut) {
            return { kind: "error", reason: "timeout" };
          }
          if (spawnErrored) {
            return { kind: "error", reason: "spawn_error", detail: spawnErrorMsg };
          }

          try {
            const raw = await readFile(input.statusPath, "utf8");
            const assessment = parseAssessmentSentinel(raw);
            if (assessment) return assessment;
            // Recognized file but no trustworthy decision → fall through.
          } catch {
            // Absent / unreadable / unparseable sentinel → fall through.
          }

          return {
            kind: "error",
            reason: "spawn_error",
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

/**
 * A test/seam fake: returns a scripted result without spawning anything. The
 * scripted function receives the input so a test can assert the note/paths it was
 * given.
 */
export function createFakeAssessmentRunner(
  scripted: (input: AssessmentRunInput) => AssessmentResult | Promise<AssessmentResult>,
): AssessmentRunner {
  return {
    async run(input: AssessmentRunInput): Promise<AssessmentResult> {
      return scripted(input);
    },
  };
}
