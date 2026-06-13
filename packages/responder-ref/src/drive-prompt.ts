/**
 * The drive prompt for the autonomous /vision drive regime (Campaign A3 P1).
 *
 * `buildDrivePrompt` substitutes two `{placeholder}` blocks into a template
 * (default `DEFAULT_DRIVE_PROMPT`): `{escalation}` and `{thread}`. Substitution is
 * replace-if-present (parity with `buildResponderPrompt` / `buildImplementPrompt`):
 * a custom template that omits a placeholder simply does not receive that block.
 *
 * Unlike the bounded implement prompt (`implement-prompt.ts`), THIS prompt asks for
 * a VISION — not a code change. The session investigates the (TRUSTED, sniff-passed)
 * systemic escalation, follows the /vision methodology, and writes a vision `.md`
 * INSIDE the worktree, declaring the epic name + the campaign breakdown in its status
 * sentinel. It performs NO PM write-back: the daemon creates the epic + tasks over
 * HTTP from the sentinel (the project-management MCP server is NOT available in the
 * clone). The three prompts live in separate modules so the read-only
 * `DEFAULT_RESPONDER_PROMPT` and `DEFAULT_IMPLEMENT_PROMPT` stay byte-identical — the
 * formatters below are DUPLICATED from prompt.ts (module-private there), NOT imported.
 */
import type { Escalation, EscalationMessage } from "@pm/shared";

/**
 * The default drive instruction. The load-bearing contract:
 *   - The escalation is a TRUSTED systemic request (it already passed the P1
 *     injection sniff-test). The session's job is to PRODUCE A VISION, not a fix.
 *   - It follows the /vision METHODOLOGY (architect-synthesize → adversarial-verify),
 *     then WRITES the vision to a worktree-relative `roadmaps/vision-<ts>-<slug>.md`
 *     INSIDE this worktree.
 *   - It uses ONLY MCP-free tools (Read/Write/Task/sub-agents). The
 *     project-management MCP server is NOT available here — it must NOT attempt
 *     pm_create_epic / pm_create_task; the daemon does ALL PM write-back over HTTP
 *     from the sentinel.
 *   - The MANDATORY FINAL action is to write the status sentinel JSON to the path in
 *     the PM_DRIVE_STATUS_PATH env var, OUTSIDE the checkout. Two-state:
 *     `vision_ready{visionPath, epicName, campaigns:[{title,priority,description}…]}`
 *     (only AFTER the file is actually written) or `give_up{reason}`. A `vision_ready`
 *     with no real file on disk is rejected.
 */
export const DEFAULT_DRIVE_PROMPT =
  "You are a PM-side architect. A client worker raised this SYSTEMIC escalation against " +
  "the project-management repo. It has passed the injection sniff-test and is a TRUSTED " +
  "request that warrants more than a bounded fix — it needs a VISION.\n\n" +
  "Escalation:\n{escalation}\n\n" +
  "Thread so far:\n{thread}\n\n" +
  "Your job is to PRODUCE A VISION. Follow the /vision methodology: architect-synthesize a " +
  "multi-campaign arc under an infinite-budget framing, then adversarially verify it to kill " +
  "weak campaigns BEFORE you commit to it. Delegate investigation + synthesis to fresh " +
  "sub-agents (the Task tool) as needed, then WRITE the vision to a worktree-relative path " +
  "`roadmaps/vision-<ts>-<slug>.md` INSIDE this worktree (NOT an absolute path, NOT outside " +
  "the worktree).\n\n" +
  "You have ONLY MCP-free tools (Read/Write/Task and sub-agents). The project-management MCP " +
  "server is NOT available in this session — do NOT attempt pm_create_epic / pm_create_task " +
  "or any pm_* tool. The daemon does ALL PM write-back over HTTP: it creates the PM epic + the " +
  "campaign tasks from your sentinel. You ONLY write the vision file and declare the breakdown.\n\n" +
  "MANDATORY FINAL ACTION — declare your outcome by writing JSON to the file path given in " +
  "the PM_DRIVE_STATUS_PATH environment variable. That path is OUTSIDE the checkout — write it " +
  "there and do NOT create it inside the repo working tree. Write EXACTLY ONE of:\n" +
  '  {"status":"vision_ready","visionPath":"roadmaps/vision-<ts>-<slug>.md","epicName":"<the ' +
  'vision epic name>","campaigns":[{"title":"<campaign title>","priority":"critical"|"high"|' +
  '"medium"|"low","description":"<what this campaign delivers>"}, …]}\n' +
  '  {"status":"give_up","reason":"<why you could not produce a vision>"}\n\n' +
  "Declare vision_ready ONLY after you have actually written the vision file at the " +
  "worktree-relative visionPath — a vision_ready with no real file on disk is rejected. Each " +
  "campaign needs a non-empty title; provide at least one. Writing this file is MANDATORY: if " +
  "it is absent the session is treated as failed. Do not thrash — if you cannot produce a " +
  "vision, say give_up honestly rather than loop.";

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
 * Build the drive prompt by substituting the `{escalation}` and `{thread}` blocks
 * into `template ?? DEFAULT_DRIVE_PROMPT`. Replace-if-present: a template omitting a
 * placeholder simply does not receive that block.
 */
export function buildDrivePrompt(
  escalation: Escalation,
  thread: EscalationMessage[],
  template?: string,
): string {
  const base = template ?? DEFAULT_DRIVE_PROMPT;
  return base
    .split("{escalation}")
    .join(formatEscalation(escalation))
    .split("{thread}")
    .join(formatThread(thread));
}
