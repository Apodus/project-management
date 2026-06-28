/**
 * The triage decision EXECUTOR (Campaign T2·P4).
 *
 * Turns a `decide()`-produced `TriageAssessment` into the side-effects the
 * resolved rollout mode permits. The mode gate is the load-bearing invariant:
 *
 *   - **off**     — defensive noop. Touch NOTHING, record NOTHING. (`mode` can be
 *                   "off" even when the daemon is `enabled` — the two are
 *                   orthogonal — so this branch IS reachable and load-bearing.)
 *   - **shadow**  — record() the decision (mode="shadow") and LEAVE THE NOTE OPEN.
 *                   Mutate nothing else. The side-log is the only write.
 *   - **on**      — record() (mode="on") AND perform the real action, backlinking
 *                   any minted proposal via `resultingProposalId`.
 *
 * Proposal-gate: the ONLY way a task is minted is `implementProposal` on a
 * fast_track PROPOSAL (note → proposal → breakdown). There is NO direct
 * note → task wrapper anywhere in this path.
 *
 * Permanent-vs-transient failure (AMENDMENT 1 — the dismiss-403 hot-loop fix):
 * for the single-action kinds (promote_standard / dismiss / needs_human) and the
 * fast_track PROMOTE step, a PERMANENT (4xx) failure ⇒ escalate the note to
 * needs_human (which consumes it out of the `open` lane so it does NOT re-seed
 * forever) and record the disposition truthfully as needs_human. A TRANSIENT
 * failure (network status 0 / 5xx / non-ApiError) ⇒ rethrow so the loop re-seeds
 * the note next tick (no record written).
 */
import type { Note, NotesTriageMode } from "@pm/shared";
import { PmApiError, type TriagerClient } from "./api-client.js";
import type { TriageAssessment } from "./decision.js";
import type { Logger } from "./logger.js";

/** The narrow client slice the executor needs (record + the 5 action wrappers). */
export type ExecClient = Pick<
  TriagerClient,
  | "recordTriageDecision"
  | "promoteToProposal"
  | "dismissNote"
  | "flagNeedsHuman"
  | "claimProposal"
  | "implementProposal"
>;

export interface ExecutionOutcome {
  /** Whether a triage-decision row was written (false ⇒ off / transient retry). */
  recorded: boolean;
  /** The minted proposal id, when a promote produced one (backlink). */
  resultingProposalId?: string;
}

export interface ExecuteDecisionCtx {
  projectId: string;
  note: Note;
  assessment: TriageAssessment;
  mode: NotesTriageMode;
  logger: Logger;
}

/** A permanent (4xx) action failure — caller escalates instead of retrying. */
function isPermanent(err: unknown): boolean {
  return err instanceof PmApiError && err.status >= 400 && err.status < 500;
}

/**
 * Write a triage-decision row. `decisionKind` is passed EXPLICITLY (not read off
 * the assessment) so a downgrade (fast_track→standard) or an escalation
 * (→needs_human) is recorded TRUTHFULLY. `resultingTaskId` is always null —
 * implementProposal mints many tasks, none singular to attribute here.
 */
function record(
  client: ExecClient,
  projectId: string,
  noteId: string,
  mode: NotesTriageMode,
  decisionKind: TriageAssessment["kind"],
  assessment: TriageAssessment,
  resultingProposalId: string | null,
): Promise<unknown> {
  return client.recordTriageDecision(projectId, {
    noteId,
    mode,
    decision: decisionKind,
    rationale: assessment.rationale || null,
    confidence: assessment.confidence,
    resultingProposalId,
    resultingTaskId: null,
  });
}

/**
 * Execute one triage decision under the resolved mode. See the file header for
 * the mode contract + the permanent/transient failure rule.
 */
export async function executeDecision(
  client: ExecClient,
  ctx: ExecuteDecisionCtx,
): Promise<ExecutionOutcome> {
  const { projectId, note, assessment, mode, logger } = ctx;

  // ── off: defensive noop (mode can be off while the daemon is enabled). ──
  if (mode === "off") {
    return { recorded: false };
  }

  // ── shadow: record only, mutate NOTHING. NEVER reference an action wrapper. ──
  if (mode === "shadow") {
    await record(client, projectId, note.id, "shadow", assessment.kind, assessment, null);
    return { recorded: true };
  }

  // ── on: perform the action, then record (with any backlink). ──
  // Bias guard FIRST: a fast_track with no usable breakdown is a STANDARD promote
  // (never fabricate a breakdown). The downgrade is recorded truthfully.
  const kind =
    assessment.kind === "promote_fast_track" && !assessment.breakdown?.tasks?.length
      ? "promote_standard"
      : assessment.kind;

  /**
   * Run a single-action kind (promote_standard / dismiss / needs_human) under the
   * permanent/transient rule. `recordKind` is what gets logged on SUCCESS.
   */
  const runSingleAction = async (
    action: () => Promise<{ resultingProposalId?: string } | void>,
    recordKind: TriageAssessment["kind"],
  ): Promise<ExecutionOutcome> => {
    let actionResult: { resultingProposalId?: string } | void;
    try {
      actionResult = await action();
    } catch (err) {
      if (!isPermanent(err)) throw err; // transient ⇒ retry next tick (no record).
      // Permanent (4xx) ⇒ escalate to a human, record truthfully, stop the loop.
      const status = (err as PmApiError).status;
      logger.warn(
        { noteId: note.id, projectId, kind: recordKind, status },
        `on-mode ${recordKind} failed permanently (status ${status}); escalating note ${note.id} to needs_human`,
      );
      try {
        await client.flagNeedsHuman(note.id);
      } catch (e2) {
        // The escalation sink itself failed — log + rethrow the ORIGINAL so the
        // loop re-seeds (rather than swallowing a half-state).
        logger.error(
          { noteId: note.id, projectId, err: e2 instanceof Error ? e2.message : String(e2) },
          "flagNeedsHuman failed while escalating a permanent action failure",
        );
        throw err;
      }
      const escalated: TriageAssessment = {
        ...assessment,
        rationale:
          `${assessment.rationale || ""} [escalated: ${recordKind} failed ${status}]`.trim(),
      };
      await record(client, projectId, note.id, "on", "needs_human", escalated, null);
      return { recorded: true };
    }
    const resultingProposalId = actionResult?.resultingProposalId ?? null;
    await record(client, projectId, note.id, "on", recordKind, assessment, resultingProposalId);
    return resultingProposalId ? { recorded: true, resultingProposalId } : { recorded: true };
  };

  switch (kind) {
    case "promote_standard":
      return runSingleAction(async () => {
        const { proposal } = await client.promoteToProposal(note.id, { proposalKind: "standard" });
        return { resultingProposalId: proposal.id };
      }, "promote_standard");

    case "promote_fast_track": {
      // The promote is the COMMIT POINT: if it throws, the permanent/transient
      // rule applies (escalate on 4xx / propagate on transient) WITHOUT a
      // half-state. Once the proposal exists, claim+implement are best-effort —
      // a failure there leaves a human-reviewable proposal artifact, NOT an
      // escalation.
      let proposalId: string;
      try {
        const { proposal } = await client.promoteToProposal(note.id, {
          proposalKind: "fast_track",
        });
        proposalId = proposal.id;
      } catch (err) {
        if (!isPermanent(err)) throw err; // transient ⇒ retry next tick.
        const status = (err as PmApiError).status;
        logger.warn(
          { noteId: note.id, projectId, status },
          `on-mode promote_fast_track failed permanently (status ${status}); escalating note ${note.id} to needs_human`,
        );
        try {
          await client.flagNeedsHuman(note.id);
        } catch (e2) {
          logger.error(
            { noteId: note.id, projectId, err: e2 instanceof Error ? e2.message : String(e2) },
            "flagNeedsHuman failed while escalating a permanent promote failure",
          );
          throw err;
        }
        const escalated: TriageAssessment = {
          ...assessment,
          rationale:
            `${assessment.rationale || ""} [escalated: promote_fast_track failed ${status}]`.trim(),
        };
        await record(client, projectId, note.id, "on", "needs_human", escalated, null);
        return { recorded: true };
      }

      const breakdown = assessment.breakdown;
      try {
        const claim = await client.claimProposal(proposalId);
        if (!claim.ok) {
          logger.warn(
            { noteId: note.id, projectId, proposalId, status: claim.status },
            "fast-track proposal claim not ok; proposal left for human breakdown",
          );
        } else {
          await client.implementProposal(proposalId, {
            epics: (breakdown?.epics ?? []).map((e) => ({
              name: e.title,
              description: e.description,
            })),
            tasks: (breakdown?.tasks ?? []).map((t) => ({
              title: t.title,
              description: t.description,
            })),
          });
        }
      } catch (err) {
        logger.warn(
          {
            noteId: note.id,
            projectId,
            proposalId,
            err: err instanceof Error ? err.message : String(err),
          },
          "fast-track claim/implement failed; proposal left for human breakdown",
        );
      }

      await record(client, projectId, note.id, "on", "promote_fast_track", assessment, proposalId);
      return { recorded: true, resultingProposalId: proposalId };
    }

    case "dismiss":
      return runSingleAction(async () => {
        await client.dismissNote(note.id, assessment.rationale || "dismissed by triager");
      }, "dismiss");

    case "needs_human":
      return runSingleAction(async () => {
        await client.flagNeedsHuman(note.id);
      }, "needs_human");

    case "give_up":
      // Fail-safe route to a human, but record the ACTUAL disposition (give_up).
      return runSingleAction(async () => {
        await client.flagNeedsHuman(note.id);
      }, "give_up");

    default: {
      // Exhaustiveness guard — every TriageDecisionKind is handled above.
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
