/**
 * The triage `decide()` brain (Campaign T2·P3).
 *
 * Replaces P2's pure-log stub with the real assessment seam: a CHEAP injection
 * sniff GATES a bounded assessment session that PRODUCES a structured
 * `TriageAssessment`. This phase only PRODUCES the decision — it is SIDE-EFFECT
 * FREE: no triage-decision record, no promote/dismiss/flag, no note mutation. The
 * loop (loop.ts:194) still ignores the return; P4 wires execution + mode-gating.
 *
 * Control flow:
 *   1. sniff the raw note. If NOT clean (suspicious OR error) → short-circuit to
 *      {kind:"needs_human"} and the assessment runner is NEVER called (fail-safe:
 *      a tripwire that trips or cannot run must not grant an assessment session).
 *   2. clean → run the bounded assessment session.
 *   3. runner error (timeout / spawn_error) → {kind:"needs_human"} (the single
 *      fail-safe sink: a failed session never gives_up or fabricates a decision).
 *   4. else → return the agent's `TriageAssessment` unchanged.
 *
 * The sniff/assessment sentinels + logs live under `logsDir` (OUTSIDE any git
 * tree) so they never register as a working-tree change.
 */
import path from "node:path";
import type { Note, ResolvedNotesTriage } from "@pm/shared";
import type { Logger } from "./logger.js";
import type { DecideFn } from "./loop.js";
import type { TriageAssessment } from "./decision.js";
import type { InjectionSniffer } from "./injection-sniffer.js";
import type { AssessmentRunner } from "./assessment-runner.js";
import { buildAssessmentPrompt } from "./assessment-prompt.js";

export interface TriageDecideDeps {
  sniffer: InjectionSniffer;
  runner: AssessmentRunner;
  /** Directory for per-note status sentinels + logs (OUTSIDE any git tree). */
  logsDir: string;
  /** Headless assessment command passed through to the runner. */
  command: string;
  budget: { timeBudgetSec: number; tokenBudget?: number };
  logger: Logger;
  /** Working directory for the spawned sessions. Defaults to process.cwd(). */
  cwd?: string;
}

/** Sanitize a note id into a filename-safe token for sentinel/log paths. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Build the real `decide()` seam. Returns a `DecideFn` (loop-injected). The
 * `projectId`/`resolved.mode` are accepted (the loop threads them) but P3 does
 * not act on the mode — execution/mode-gating is P4.
 */
export function createTriageDecide(deps: TriageDecideDeps): DecideFn {
  const cwd = deps.cwd ?? process.cwd();
  return async ({ note }: { note: Note; projectId: string; resolved: ResolvedNotesTriage }) => {
    const token = safeId(note.id);

    // ── 1. Injection sniff (the gate). ──
    const sniffStatusPath = path.join(deps.logsDir, `sniff-${token}.status.json`);
    const sniffLogPath = path.join(deps.logsDir, `sniff-${token}.log`);
    const sniff = await deps.sniffer.sniff({
      note,
      budget: deps.budget,
      cwd,
      logPath: sniffLogPath,
      statusPath: sniffStatusPath,
    });

    if (sniff.kind !== "clean") {
      const reason = `injection-suspected: ${sniff.reason}`;
      deps.logger.warn(
        { noteId: note.id, sniff: sniff.kind },
        "note failed the injection sniff; needs_human (assessment session NOT spawned)",
      );
      return { kind: "needs_human", rationale: reason, confidence: 0 } satisfies TriageAssessment;
    }

    // ── 2. Bounded assessment session. ──
    const assessStatusPath = path.join(deps.logsDir, `assess-${token}.status.json`);
    const assessLogPath = path.join(deps.logsDir, `assess-${token}.log`);
    const result = await deps.runner.run({
      note,
      prompt: buildAssessmentPrompt(note),
      budget: deps.budget,
      cwd,
      command: deps.command,
      logPath: assessLogPath,
      statusPath: assessStatusPath,
    });

    // ── 3. Runner failure → the single fail-safe sink (needs_human). ──
    if (result.kind === "error") {
      deps.logger.warn(
        { noteId: note.id, reason: result.reason },
        "assessment session failed; needs_human (fail-safe)",
      );
      return {
        kind: "needs_human",
        rationale: `assessment-session-failed: ${result.reason}`,
        confidence: 0,
      } satisfies TriageAssessment;
    }

    // ── 4. The agent's trusted decision, unchanged. ──
    return result;
  };
}
