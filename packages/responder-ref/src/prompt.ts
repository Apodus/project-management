/**
 * The responder prompt (Campaign C3 P2).
 *
 * `buildResponderPrompt` substitutes two `{placeholder}` blocks into a template
 * (default `DEFAULT_RESPONDER_PROMPT`): `{escalation}` — a formatted block of the
 * escalation's identifying fields — and `{thread}` — the ordered thread messages.
 * Substitution is replace-if-present (parity with the resolver's
 * `buildReconcilePrompt`): a custom template that omits a placeholder simply does
 * not receive that detail.
 *
 * The prompt is local to this package (not in `@pm/shared`) — the responder's
 * instructions are responder-ref machinery, not a shared contract.
 */
import type { Escalation, EscalationMessage } from "@pm/shared";

/**
 * The default responder instruction. The load-bearing contract:
 *   - Investigate the PM repo READ-ONLY (read code/docs to diagnose; never edit /
 *     commit / push / branch — code mutation is OUT OF SCOPE for the responder).
 *   - The MANDATORY FINAL action is to write the status sentinel JSON to the path
 *     in the PM_RESPONDER_STATUS_PATH env var, OUTSIDE the checkout. The four-state
 *     contract: `answered` (with a self-contained `answer` — the `answer` field IS
 *     the message the client receives), `needs_human`, or `give_up`.
 *
 * ANSWER-ONLY SEAL: this is a read-only diagnostic responder. There is NO commit
 * path — the only artifact it produces is the `answer` text the daemon posts back
 * to the escalation thread (P3). Writing the sentinel is mandatory: an absent file
 * is treated as a failed session and escalated.
 */
export const DEFAULT_RESPONDER_PROMPT =
  "You are a PM-side responder. A client worker raised this escalation against the " +
  "project-management repo and is blocked waiting for an answer.\n\n" +
  "Escalation:\n{escalation}\n\n" +
  "Thread so far:\n{thread}\n\n" +
  "Your job is to DIAGNOSE and ANSWER. Investigate the PM repo READ-ONLY — read code, " +
  "docs, tests, and git history to work out the true cause and the fix or workaround the " +
  "client needs. You MUST NOT edit, commit, push, or branch anything — code mutation is " +
  "out of scope for the responder; the only thing you produce is an answer the client can " +
  "act on. Delegate investigation to fresh sub-agents as needed, but converge on a " +
  "self-contained, actionable answer.\n\n" +
  "MANDATORY FINAL ACTION — declare your outcome by writing JSON to the file path given in " +
  "the PM_RESPONDER_STATUS_PATH environment variable. That path is OUTSIDE the checkout — " +
  "write it there and do NOT create it inside the repo working tree. Write EXACTLY ONE of:\n" +
  '  {"status":"answered","answer":"<self-contained diagnosis / answer / workaround the ' +
  'client receives>"}\n' +
  '  {"status":"needs_human","reason":"<why a human is required>"}\n' +
  '  {"status":"give_up","reason":"<why you could not make progress>"}\n' +
  '  {"status":"implement","size":"bounded"|"systemic","rationale":"<why a code change is ' +
  'warranted + why localized vs large>"}\n\n' +
  "If the fix is a localized code change, declare implement rather than answering.\n\n" +
  "The `answer` field IS the message posted back to the client — make it complete and " +
  "actionable on its own (the client does not see your investigation, only this answer). " +
  "Writing this file is MANDATORY: if it is absent the session is treated as failed and the " +
  "escalation is re-escalated. Do not thrash — if you cannot answer, say needs_human or " +
  "give_up honestly rather than loop.";

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
 * Build the responder prompt by substituting the `{escalation}` and `{thread}`
 * blocks into `template ?? DEFAULT_RESPONDER_PROMPT`. Replace-if-present: a
 * template omitting a placeholder simply does not receive that block.
 */
export function buildResponderPrompt(
  escalation: Escalation,
  thread: EscalationMessage[],
  template?: string,
): string {
  const base = template ?? DEFAULT_RESPONDER_PROMPT;
  return base
    .split("{escalation}")
    .join(formatEscalation(escalation))
    .split("{thread}")
    .join(formatThread(thread));
}
