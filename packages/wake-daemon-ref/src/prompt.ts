/**
 * Builds the wake prompt fed to the re-woken worker — mirrors integrator-ref's
 * `buildReconcilePrompt` {placeholder} substitution. `{escalation}` is replaced
 * with the escalation's id/title/kind/originRepo (+ body if present); `{messages}`
 * with the unread replies (seq / authorId / body), oldest-first. A custom template
 * that omits a placeholder simply doesn't receive that detail (replace-if-present).
 */
import type { Escalation, EscalationMessage } from "@pm/shared";

function renderEscalation(escalation: Escalation): string {
  const lines = [
    `Escalation ${escalation.id} [${escalation.kind}] — ${escalation.title}`,
    `  origin repo: ${escalation.originRepo}`,
    `  status: ${escalation.status}`,
  ];
  if (escalation.body) lines.push(`  body: ${escalation.body}`);
  if (escalation.anchorType && escalation.anchorId) {
    lines.push(`  anchor: ${escalation.anchorType} ${escalation.anchorId}`);
  }
  return lines.join("\n");
}

function renderMessages(messages: EscalationMessage[]): string {
  if (messages.length === 0) return "(no unread messages)";
  // Oldest-first within the thread so the worker reads the conversation in order.
  return [...messages]
    .sort((a, b) => a.seq - b.seq)
    .map((m) => `  [#${m.seq}] ${m.authorId}: ${m.body}`)
    .join("\n");
}

export function buildWakePrompt(
  escalation: Escalation,
  unreadMessages: EscalationMessage[],
  template: string,
): string {
  return template
    .split("{escalation}")
    .join(renderEscalation(escalation))
    .split("{messages}")
    .join(renderMessages(unreadMessages));
}
