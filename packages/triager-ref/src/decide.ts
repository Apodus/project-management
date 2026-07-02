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
 *
 * ── Repo-aware assessment ────────────────────────────────────────────────────
 * A note is judged against the WATCHED PROJECT'S code (does the issue STILL
 * EXIST?), so both sessions `cwd` into that project's DEDICATED checkout
 * (`projectRepos.get(projectId)`), refreshed to `repoRef` (fetch + reset --hard)
 * immediately before the assessment. Two fail-safe gates precede any spawn: a
 * project with NO configured checkout, and a refresh that throws, BOTH short-
 * circuit to `needs_human` (never blind- or stale-assess). Because one dedicated
 * checkout backs a project, assessments for the SAME project are SERIALIZED here
 * (a `reset --hard` under a live session would corrupt its read) — correct even
 * if an operator raises `maxConcurrent` above the default 1.
 *
 * ── Isolation — accepted residual (T2·P5, updated) ───────────────────────────
 * Both sessions are read-only-BY-PROMPT in the project's DEDICATED checkout,
 * spawned with NO permission-mode flag and NO tool restriction — IDENTICAL to the
 * shipped escalation responder's read-only sessions. The daemon itself has NO
 * write / commit / push path (simple-git was dropped in P2); the only artifacts a
 * session should produce are the out-of-tree status sentinel + log under
 * `logsDir`, and the pre-assessment `reset --hard` wipes any stray write anyway —
 * so the project's LIVE working tree is never touched. Defense-in-depth: (1) the
 * cheap injection SNIFF gates every assessment; (2) the prompts instruct
 * read-only investigation; (3) sentinels live under `os.tmpdir()`. An operator
 * who wants a HARD tool restriction can supply one WITHOUT a code change via
 * `PM_TRIAGE_COMMAND` (e.g. a wrapper passing `--allowedTools`/`--permission-mode`);
 * the command is threaded verbatim into both the sniffer and the assessment runner.
 */
import path from "node:path";
import type { Note, ResolvedNotesTriage } from "@pm/shared";
import type { Logger } from "./logger.js";
import { errMessage, type DecideFn } from "./loop.js";
import type { TriageAssessment } from "./decision.js";
import type { InjectionSniffer } from "./injection-sniffer.js";
import type { AssessmentRunner } from "./assessment-runner.js";
import type { RepoRefresher } from "./repo-refresh.js";
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
  /**
   * Watched-project → DEDICATED-checkout path. The sniff + assessment sessions
   * `cwd` here so the agent reads the PROJECT'S code. A project absent from this
   * map short-circuits to `needs_human` (no blind assessment).
   */
  projectRepos: Map<string, string>;
  /** Git ref the checkout is refreshed to (fetch + reset --hard) per assessment. */
  repoRef: string;
  /** Refreshes the dedicated checkout to `repoRef` before each assessment. */
  refresher: RepoRefresher;
}

/** Sanitize a note id into a filename-safe token for sentinel/log paths. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const NEEDS_HUMAN = (rationale: string): TriageAssessment => ({
  kind: "needs_human",
  rationale,
  confidence: 0,
});

/**
 * Build the real `decide()` seam. Returns a `DecideFn` (loop-injected). The
 * sniff + assessment sessions run in the watched project's DEDICATED checkout
 * (refreshed to `repoRef` first) so the agent reads the PROJECT'S code. Two
 * fail-safe gates precede any spawn (no repo configured; refresh failure), each
 * short-circuiting to `needs_human`. Assessments for the SAME project are
 * serialized (one dedicated checkout per project — a concurrent `reset --hard`
 * would corrupt a live read). `resolved.mode` is accepted but not acted on here
 * (execution/mode-gating is the loop's job, P4).
 */
export function createTriageDecide(deps: TriageDecideDeps): DecideFn {
  // Per-project tail-chain: each project's assessments run one at a time, so two
  // notes for the same project never share the dedicated checkout concurrently.
  const chains = new Map<string, Promise<unknown>>();

  const assessOne = async (note: Note, projectId: string): Promise<TriageAssessment> => {
    // ── Gate 1. A project with no dedicated checkout cannot be code-verified. ──
    const repoPath = deps.projectRepos.get(projectId);
    if (!repoPath) {
      deps.logger.warn(
        { noteId: note.id, projectId },
        "no code repo configured for project; needs_human (no assessment spawned)",
      );
      return NEEDS_HUMAN(
        `no code repo configured for project ${projectId}; cannot verify the note against code`,
      );
    }

    const token = safeId(note.id);

    // ── 1. Injection sniff (the gate), in the project checkout. ──
    const sniffStatusPath = path.join(deps.logsDir, `sniff-${token}.status.json`);
    const sniffLogPath = path.join(deps.logsDir, `sniff-${token}.log`);
    const sniff = await deps.sniffer.sniff({
      note,
      budget: deps.budget,
      cwd: repoPath,
      logPath: sniffLogPath,
      statusPath: sniffStatusPath,
    });

    if (sniff.kind !== "clean") {
      const reason = `injection-suspected: ${sniff.reason}`;
      deps.logger.warn(
        { noteId: note.id, sniff: sniff.kind },
        "note failed the injection sniff; needs_human (assessment session NOT spawned)",
      );
      return NEEDS_HUMAN(reason);
    }

    // ── Gate 2. Refresh the dedicated checkout to current code BEFORE assessing.
    // A failure (bad path, not a git repo, network) fail-safes to needs_human —
    // never assess against unknown/stale code. Runs AFTER a clean sniff so a
    // suspicious note never triggers git work. ──
    try {
      await deps.refresher.refresh(repoPath, deps.repoRef);
    } catch (err) {
      deps.logger.warn(
        { noteId: note.id, projectId, repoPath, ref: deps.repoRef, err: errMessage(err) },
        "repo refresh failed; needs_human (assessment session NOT spawned)",
      );
      return NEEDS_HUMAN(`repo refresh failed: ${errMessage(err)}`);
    }

    // ── 2. Bounded assessment session, in the refreshed project checkout. ──
    const assessStatusPath = path.join(deps.logsDir, `assess-${token}.status.json`);
    const assessLogPath = path.join(deps.logsDir, `assess-${token}.log`);
    const result = await deps.runner.run({
      note,
      prompt: buildAssessmentPrompt(note),
      budget: deps.budget,
      cwd: repoPath,
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
      return NEEDS_HUMAN(`assessment-session-failed: ${result.reason}`);
    }

    // ── 4. The agent's trusted decision, unchanged. ──
    return result;
  };

  return async ({
    note,
    projectId,
  }: {
    note: Note;
    projectId: string;
    resolved: ResolvedNotesTriage;
  }) => {
    // Chain onto this project's tail (ignore the predecessor's outcome), so
    // same-project assessments serialize over the one dedicated checkout.
    const prev = chains.get(projectId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => assessOne(note, projectId));
    chains.set(projectId, run);
    try {
      return await run;
    } finally {
      // Drop the tail once we ARE the tail — keeps the map from growing unbounded.
      if (chains.get(projectId) === run) chains.delete(projectId);
    }
  };
}
