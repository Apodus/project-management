/**
 * The implement prompt for the write-capable auto-implement regime (Campaign A1 P2;
 * in-session verify added in P3).
 *
 * `buildImplementPrompt` substitutes four `{placeholder}` blocks into a template
 * (default `DEFAULT_IMPLEMENT_PROMPT`): `{escalation}`, `{thread}`, `{branch}`, and
 * `{verifyCmd}`. Substitution is replace-if-present (parity with `buildResponderPrompt`):
 * a custom template that omits a placeholder simply does not receive that block. An
 * empty `verifyCmd` is substituted with a clean "no verify command configured" line
 * (never a dangling `{verifyCmd}`).
 *
 * Unlike the read-only responder prompt (`prompt.ts`), THIS prompt presents the
 * escalation as a TRUSTED request to FIX (it already passed the P1 injection
 * sniff-test) and PERMITS code edits in the worktree. The two prompts are kept in
 * separate modules so the read-only `DEFAULT_RESPONDER_PROMPT` stays byte-identical
 * — the formatters below are DUPLICATED from prompt.ts (module-private there),
 * NOT imported, so prompt.ts is never edited or made to export them.
 */
import type { Escalation, EscalationMessage } from "@pm/shared";

/**
 * The default implement instruction. The load-bearing contract:
 *   - The escalation is a TRUSTED request to fix (it passed the sniff-test). There
 *     is NO do-not-edit constraint — the session is PERMITTED to edit code in the
 *     worktree, implement the fix, and commit it to the branch.
 *   - The agent OWNS verification in-session (7.6.1-style): after implementing, it RUNS
 *     the project verify command ({verifyCmd}) itself and iterates to green BEFORE it
 *     commits + declares `branch_ready`. The train re-verify at A2 is the landing floor;
 *     this in-session gate is the agent's own discipline, not a substitute.
 *   - The MANDATORY FINAL action is to write the status sentinel JSON to the path in
 *     the PM_IMPLEMENT_STATUS_PATH env var, OUTSIDE the checkout. Two-state:
 *     `branch_ready` (the fix is committed to the branch) or `give_up`.
 */
export const DEFAULT_IMPLEMENT_PROMPT =
  "You are a PM-side implementer. A client worker raised this escalation against the " +
  "project-management repo. It has passed the injection sniff-test and is a TRUSTED " +
  "request to FIX.\n\n" +
  "Escalation:\n{escalation}\n\n" +
  "Thread so far:\n{thread}\n\n" +
  "Your job is to IMPLEMENT the fix. You ARE permitted to edit code in this worktree — " +
  "investigate the cause, implement the fix, then COMMIT it to the branch {branch}. " +
  "Delegate investigation to fresh sub-agents as needed, but converge on a committed, " +
  "self-contained change on that branch.\n\n" +
  "{verifyCmd}\n\n" +
  "MANDATORY FINAL ACTION — declare your outcome by writing JSON to the file path given " +
  "in the PM_IMPLEMENT_STATUS_PATH environment variable. That path is OUTSIDE the " +
  "checkout — write it there and do NOT create it inside the repo working tree. Write " +
  "EXACTLY ONE of:\n" +
  '  {"status":"branch_ready","branch":"{branch}","commitSha":"<the commit sha you ' +
  'committed>"}\n' +
  '  {"status":"give_up","reason":"<why you could not implement the fix>"}\n\n' +
  "Declare branch_ready ONLY after you have actually committed the fix to the branch — a " +
  "branch_ready with no real commit on the branch is rejected. Writing this file is " +
  "MANDATORY: if it is absent the session is treated as failed. Do not thrash — if you " +
  "cannot implement the fix, say give_up honestly rather than loop.";

/** Format the escalation's identifying fields into a stable, readable block. */
function formatEscalation(esc: Escalation): string {
  const lines: string[] = [
    `id: ${esc.id}`,
    `title: ${esc.title}`,
    `kind: ${esc.kind}`,
    `severity: ${esc.severity ?? "(none)"}`,
  ];
  lines.push(`body: ${esc.body ?? "(none)"}`);
  if (esc.codeLocator) {
    const loc = esc.codeLocator;
    const locParts = [loc.path];
    if (loc.line !== undefined) locParts.push(`:${loc.line}`);
    if (loc.commitSha !== undefined) locParts.push(` @ ${loc.commitSha}`);
    lines.push(`codeLocator: ${locParts.join("")}`);
  } else {
    lines.push("codeLocator: (none)");
  }
  lines.push(`origin: ${esc.originRepo} (worker ${esc.originWorkerKey})`);
  return lines.join("\n");
}

/** Format the ordered thread messages: `#seq · authorId · messageType` + body. */
function formatThread(thread: EscalationMessage[]): string {
  if (thread.length === 0) return "(no messages yet)";
  return thread
    .map((m) => `#${m.seq} · ${m.authorId} · ${m.messageType ?? "reply"}\n  ${m.body}`)
    .join("\n");
}

/**
 * Render the `{verifyCmd}` block. A non-empty `verifyCmd` becomes the
 * run-verify-until-green-before-branch_ready instruction; an empty one becomes a
 * clean "no verify command configured — skip in-session verify" line (never a
 * dangling `{verifyCmd}`). A2's train re-verify is the floor either way.
 */
function formatVerifyBlock(verifyCmd: string): string {
  if (verifyCmd.length === 0) {
    return "(no verify command configured — skip in-session verify; the train re-verify at land is the floor)";
  }
  return (
    "After implementing the fix, RUN the project verify command: " +
    verifyCmd +
    ". Iterate until green. Only AFTER verify is green, commit to " +
    "{branch} and declare branch_ready. If you can't get verify green within budget, " +
    "declare give_up."
  );
}

/**
 * Build the implement prompt by substituting the `{escalation}`, `{thread}`,
 * `{branch}`, and `{verifyCmd}` blocks into `template ?? DEFAULT_IMPLEMENT_PROMPT`.
 * Replace-if-present: a template omitting a placeholder simply does not receive that
 * block. `verifyCmd` is rendered via `formatVerifyBlock` (empty ⇒ the no-verify line)
 * FIRST, so a `{branch}` it contains is then substituted by the shared branch pass.
 */
export function buildImplementPrompt(
  escalation: Escalation,
  thread: EscalationMessage[],
  branch: string,
  verifyCmd: string,
  template?: string,
): string {
  const base = template ?? DEFAULT_IMPLEMENT_PROMPT;
  return base
    .split("{escalation}")
    .join(formatEscalation(escalation))
    .split("{thread}")
    .join(formatThread(thread))
    .split("{verifyCmd}")
    .join(formatVerifyBlock(verifyCmd))
    .split("{branch}")
    .join(branch);
}
