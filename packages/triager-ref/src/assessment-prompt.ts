/**
 * The triage assessment prompt (Campaign T2·P3).
 *
 * `buildAssessmentPrompt` substitutes a `{note}` block — the note's identifying
 * fields — into a template (default `DEFAULT_ASSESSMENT_PROMPT`). Substitution is
 * replace-if-present (parity with the responder's `buildResponderPrompt`): a
 * custom template that omits the placeholder simply does not receive that block.
 *
 * The prompt is local to this package (not in `@pm/shared`) — the triager's
 * instructions are triager-ref machinery, not a shared contract.
 */
import type { Note } from "@pm/shared";

/**
 * The default triage instruction. The load-bearing contract:
 *   - Bias-to-reversible: DISMISS only on clear, unambiguous no-merit; ANY merit
 *     ambiguity ⇒ needs_human; merit-but-unsure-size ⇒ prefer promote_standard.
 *   - Investigate the PM repo READ-ONLY (read code/docs to assess; NEVER edit).
 *   - Fast-track sizing: small / self-contained / single-task-able / NO schema
 *     migration / NO cross-cutting ⇒ promote_fast_track WITH a minimal breakdown
 *     (≤3 tasks); larger / multi-area / schema / cross-cutting ⇒ promote_standard
 *     (no breakdown).
 *   - Proposal-gate: the triager NEVER mints tasks directly. promote_fast_track
 *     produces a PROPOSAL the daemon breaks down (promote→claim→implement); the
 *     breakdown is a SUGGESTION on that proposal.
 *   - The MANDATORY FINAL action is the status sentinel JSON written to the path
 *     in PM_TRIAGE_STATUS_PATH (OUTSIDE the checkout).
 */
export const DEFAULT_ASSESSMENT_PROMPT =
  "You are a PM-side triager. A note landed in the project's notes inbox and needs a " +
  "triage decision. Assess it and decide its disposition.\n\n" +
  "Note:\n{note}\n\n" +
  "Investigate the PM repo READ-ONLY — read code, docs, tests, and git history to judge " +
  "whether this note has merit and how large the work would be. You MUST NOT edit, commit, " +
  "push, or branch anything — assessment is read-only; the only artifact you produce is the " +
  "decision sentinel below.\n\n" +
  "Decide ONE of these five dispositions and bias toward the REVERSIBLE choice:\n" +
  "  - dismiss: ONLY when the note has clear, unambiguous NO MERIT (already fixed, " +
  "nonsensical, duplicate of resolved work, out of scope). If there is ANY ambiguity about " +
  "merit, do NOT dismiss.\n" +
  "  - needs_human: any merit ambiguity, a judgment call, or anything you cannot confidently " +
  "decide — punt to a human rather than guess.\n" +
  "  - promote_standard: the note has merit but is larger, spans multiple areas, needs a " +
  "schema/DB migration, or is cross-cutting. When you have merit but are UNSURE of the size, " +
  "PREFER promote_standard. Emit NO breakdown.\n" +
  "  - promote_fast_track: the note has merit AND is small, self-contained, single-task-able, " +
  "with NO schema migration and NOT cross-cutting. Include a MINIMAL breakdown of at most 3 " +
  "tasks (each {title, optional description}); optional epics. The breakdown is a SUGGESTION.\n" +
  "  - give_up: you genuinely cannot make progress assessing this note.\n\n" +
  "PROPOSAL-GATE: you NEVER mint tasks directly. A promote_fast_track decision produces a " +
  "PROPOSAL that the daemon later breaks down (promote → claim → implement); your breakdown " +
  "is only a suggestion attached to that proposal.\n\n" +
  "MANDATORY FINAL ACTION — declare your decision by writing JSON to the file path given in " +
  "the PM_TRIAGE_STATUS_PATH environment variable. That path is OUTSIDE the checkout — write " +
  "it there and do NOT create it inside the repo working tree. Write EXACTLY ONE JSON object:\n" +
  '  {"status":"<dismiss|needs_human|promote_standard|promote_fast_track|give_up>",' +
  '"rationale":"<why>","confidence":0..1' +
  '[,"breakdown":{"epics":[{"title":"...","description":"..."}],' +
  '"tasks":[{"title":"...","description":"..."}]}]}\n' +
  "Include `breakdown` ONLY for promote_fast_track. Writing this file is MANDATORY: an absent " +
  "or unparseable file is treated as a FAILED session.";

/** Format the note's identifying fields into a stable, readable block. */
function formatNote(note: Note): string {
  const lines: string[] = [
    `id: ${note.id}`,
    `kind: ${note.kind}`,
    `title: ${note.title}`,
    `severity: ${note.severity ?? "(none)"}`,
    `body: ${note.body ?? "(none)"}`,
  ];
  if (note.codeLocator) {
    const loc = note.codeLocator;
    const locParts = [loc.path];
    if (loc.line !== undefined) locParts.push(`:${loc.line}`);
    if (loc.commitSha !== undefined) locParts.push(` @ ${loc.commitSha}`);
    lines.push(`codeLocator: ${locParts.join("")}`);
  } else {
    lines.push("codeLocator: (none)");
  }
  return lines.join("\n");
}

/**
 * Build the assessment prompt by substituting the `{note}` block into
 * `template ?? DEFAULT_ASSESSMENT_PROMPT`. Replace-if-present: a template omitting
 * the placeholder simply does not receive that block.
 */
export function buildAssessmentPrompt(note: Note, template?: string): string {
  const base = template ?? DEFAULT_ASSESSMENT_PROMPT;
  return base.split("{note}").join(formatNote(note));
}
