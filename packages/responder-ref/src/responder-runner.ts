/**
 * The responder runner CONTRACT (Campaign C3).
 *
 * In P2 the responder spawns a fresh headless client turn (default `claude -p`)
 * seeded with the escalation thread so the agent reads it, answers (posts a
 * reply / makes any change the instruction calls for), and resolves the
 * escalation — bounded by a wall-clock time budget. ONE attempt, no retry.
 *
 * The runner is the INJECTABLE seam: tests pass a fake that scripts an outcome
 * so no real Claude binary is needed; production will wire a
 * `createClaudeResponderRunner` (P2). The spawn + SIGTERM→SIGKILL kill path will
 * mirror the resolver/wake runners exactly (the kill goes through `killTree`,
 * NOT `child.kill`, because Windows needs `taskkill /T /F`).
 *
 * P1 ships ONLY the interface + the four-state result type. There is NO
 * implementation here yet — the loop claims and stops (see loop.ts). P2 fills in
 * the impl and wires it into the loop after a successful claim.
 */
import type { Escalation } from "@pm/shared";

export interface ResponderRunInput {
  /** The escalation this responder has claimed and is answering. */
  escalation: Escalation;
  /** The fully-substituted responder prompt fed to the worker on stdin. */
  prompt: string;
  budget: { timeBudgetSec: number; tokenBudget?: number };
  cwd: string;
  command: string;
  logPath: string;
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
  | { kind: "answered"; durationMs: number }
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
