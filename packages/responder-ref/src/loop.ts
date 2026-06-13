/**
 * The responder loop (Campaign C3 — claim + answer).
 *
 * Per watched project, each tick:
 *   1. GET open escalations (a per-project error → warn + continue; the loop
 *      survives and recovers next tick).
 *   2. Filter to the SEED set: an escalation is a candidate iff
 *        holderId == null            (unclaimed — no live worker owns it)
 *        && authorId !== selfId      (NO-RECURSION: never answer our own thread)
 *        && status === "open"
 *        && !claimed.has(id)          (we haven't already claimed it this process)
 *   3. Oldest-first by createdAt. For each, under a `maxConcurrent` semaphore,
 *      acknowledge(id) to CLAIM it (the C1 one-active-responder gate). On a
 *      successful claim the job (holding the slot for the budget duration, like
 *      the wake daemon) fetches the thread, builds the prompt, SPAWNS the
 *      answering session, and handles its 4-state outcome.
 *
 * Outcome routing (P5 — shadow + the permanent human-approval boundary):
 *   - An `answered` outcome runs through `decideAnsweredDisposition(mode,
 *     severity)`:
 *       off            → log_only  (off is fully silent — never posts anything).
 *       on + routine   → auto_send (answer() reaches the client directly).
 *       on + HIGH sev  → approve   (the PERMANENT boundary — a high-severity
 *                                   drafted answer ALWAYS routes to a human for
 *                                   approval, even at on; it never auto-sends).
 *       shadow         → approve   (every drafted answer is routed to a human
 *                                   for review before it could reach a client —
 *                                   shadow is the safe-rollout rung).
 *     `approve` reuses `escalateToHuman` (the C2 Discord needs-human bridge),
 *     embedding the draft in the reason so NO proven work is discarded.
 *   - `needs_human` / `give_up` / `error` (the agent's own low-confidence /
 *     failure signals): at `off` they are SILENT (off escalates nothing); at
 *     shadow OR on they escalate-to-human verbatim (no proven work discarded).
 *
 *      ack failures: 403 (another responder beat us; debug, don't record),
 *      409 (raced out of open; skip), other (warn, retry next tick).
 *
 * `enabled` is the kill-switch: a disabled tick is a no-op (defense-in-depth —
 * index.ts also exits before entering the loop). The spawn always runs when
 * enabled (so shadow exercises the real session); `mode` gates only what the
 * outcome POSTs — and the high-severity approval boundary survives `on`.
 */
import path from "node:path";
import { tmpdir } from "node:os";
import type { EscalationSeverity } from "@pm/shared";
import type { Logger } from "./logger.js";
import type { ResponderClient } from "./api-client.js";
import { PmApiError } from "./api-client.js";
import type { ResponderRunner } from "./responder-runner.js";
import { buildResponderPrompt } from "./prompt.js";
import type { ResponderMode } from "./config.js";

/**
 * Decide what to do with an `answered` outcome given the mode and the
 * escalation's severity. Pure — the single source of the P5 disposition table:
 *   off                       → "log_only"  (off is silent)
 *   on  + severity !== high    → "auto_send" (routine answers reach the client)
 *   shadow, OR on + high       → "approve"   (route the draft to a human first;
 *                                            high-severity approval is PERMANENT
 *                                            and survives `on`)
 */
export function decideAnsweredDisposition(
  mode: ResponderMode,
  severity: EscalationSeverity | null,
): "auto_send" | "approve" | "log_only" {
  if (mode === "off") return "log_only";
  if (mode === "on" && severity !== "high") return "auto_send";
  return "approve";
}

/**
 * Route a drafted answer to a human for approval by reusing `escalateToHuman`
 * (the C2 needs-human → Discord bridge). The draft is embedded in the reason so
 * the human can review/send it — NO proven work is discarded.
 */
export function routeToHumanApproval(
  client: Pick<ResponderClient, "escalateToHuman">,
  escalationId: string,
  draft: string,
  reason: string,
): Promise<unknown> {
  return client.escalateToHuman(
    escalationId,
    "[NEEDS APPROVAL] " + reason + "\n\nDraft answer:\n" + draft,
  );
}

export interface ResponderDeps {
  client: Pick<
    ResponderClient,
    "listOpenEscalations" | "acknowledge" | "answer" | "escalateToHuman" | "getEscalation"
  >;
  logger: Logger;
  projectIds: string[];
  /** This responder's own user id (from /auth/me) — the no-recursion seed. */
  selfId: string;
  /** Kill-switch. A disabled tick is a no-op. */
  enabled: boolean;
  maxConcurrent: number;
  /** The injectable answering session (real spawn in prod; scripted in tests). */
  runner: ResponderRunner;
  /** Working directory the answering session runs in (the PM repo checkout). */
  repoCwd: string;
  /** Headless answering command passed to the runner. */
  command: string;
  /** off|shadow|on — gates ONLY the POST (the spawn always runs when enabled). */
  mode: ResponderMode;
  /** Per-session budget handed to the runner. */
  budget: { timeBudgetSec: number; tokenBudget?: number };
  /** Optional custom prompt template (default DEFAULT_RESPONDER_PROMPT). */
  promptTemplate?: string;
  /** Directory for status sentinels + logs (OUTSIDE any git tree). */
  logsDir?: string;
  /** External-cancel seam threaded into the runner. */
  signal?: AbortSignal;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface RunResponderLoopDeps extends ResponderDeps {
  /** Resolves when the poll tick elapses (or a wakeup arrives). */
  waitForWork: (pollMs: number) => Promise<void>;
  /** Should the loop keep running? Flipped by the SIGTERM/SIGINT handler. */
  shouldContinue: () => boolean;
}

export interface RunResponderLoopOptions {
  pollIntervalMs?: number;
}

/**
 * Per-process mutable responder state, threaded across ticks. Created once by
 * `runResponderLoop` and passed into every `responderTick`.
 */
export interface ResponderState {
  /** Escalations with a claim spawn currently in flight (skip a second). */
  inFlight: Set<string>;
  /** Escalations this process has already successfully claimed (skip re-ack). */
  claimed: Set<string>;
}

export function createResponderState(): ResponderState {
  return {
    inFlight: new Set(),
    claimed: new Set(),
  };
}

/**
 * One poll pass over every watched project. Non-throwing per project: a poll
 * error is logged and the other projects still run. Claims are awaited only up
 * to the concurrency semaphore — a claim that would exceed `maxConcurrent` is
 * skipped this tick and reappears next tick.
 */
export async function responderTick(deps: ResponderDeps, state: ResponderState): Promise<void> {
  if (!deps.enabled) return; // kill-switch — inert tick.

  // The concurrency budget is GLOBAL across all watched projects this tick.
  let available = deps.maxConcurrent - state.inFlight.size;
  if (available < 0) available = 0;

  const pending: Promise<void>[] = [];

  for (const projectId of deps.projectIds) {
    if (available <= 0) break; // semaphore saturated — reappears next tick.

    let open;
    try {
      open = await deps.client.listOpenEscalations(projectId);
    } catch (err) {
      deps.logger.warn(
        { projectId, err: errMessage(err) },
        "listOpenEscalations failed; skipping this project for this tick",
      );
      continue;
    }

    // SEED filter (no-recursion): unclaimed, open, NOT authored by us, not
    // already claimed this process. Oldest-first by createdAt.
    const candidates = open
      .filter(
        (e) =>
          e.holderId == null &&
          e.authorId !== deps.selfId &&
          e.status === "open" &&
          !state.claimed.has(e.id),
      )
      .sort((a, b) => createdAtMs(a.createdAt) - createdAtMs(b.createdAt));

    for (const esc of candidates) {
      if (available <= 0) break; // semaphore saturated.

      const escalationId = esc.id;
      if (state.inFlight.has(escalationId)) continue; // already claiming.

      // Admit. Claim a semaphore slot + the in-flight marker.
      available -= 1;
      state.inFlight.add(escalationId);

      const job = (async (): Promise<void> => {
        try {
          await deps.client.acknowledge(escalationId);
          // The `claimed` set deliberately blocks ANY re-attempt on a later
          // failure: once we hold the claim, a post-spawn failure leaves the
          // escalation stranded-acknowledged and P6 reclaim owns recovery —
          // there is NO spawn-retry loop here (re-spawning would burn budget on
          // a thread another mechanism is already accountable for).
          state.claimed.add(escalationId);
          deps.logger.info(
            { escalationId, projectId },
            `claimed escalation ${escalationId}; spawning answering session`,
          );

          // ── Answering session (holds the concurrency slot for its budget). ──
          const detail = await deps.client.getEscalation(escalationId);
          const prompt = buildResponderPrompt(detail, detail.messages, deps.promptTemplate);
          const logsDir = deps.logsDir ?? tmpdir();
          const statusPath = path.join(logsDir, `${escalationId}.status.json`);
          const logPath = path.join(logsDir, `${escalationId}.log`);
          const result = await deps.runner.run({
            escalation: detail,
            prompt,
            budget: deps.budget,
            cwd: deps.repoCwd,
            command: deps.command,
            logPath,
            statusPath,
            signal: deps.signal,
          });

          // ── Outcome handling (P5). The POST is wrapped in an inner try/catch
          // so a transient client failure does NOT escape the job (the
          // escalation stays acknowledged; P6 reclaim recovers it). ──
          try {
            switch (result.kind) {
              case "answered": {
                const disposition = decideAnsweredDisposition(deps.mode, detail.severity);
                if (disposition === "log_only") {
                  deps.logger.info(
                    { escalationId, kind: "answered", mode: deps.mode },
                    "answered (mode=off) — not sending; off is silent",
                  );
                  return;
                }
                if (disposition === "auto_send") {
                  await deps.client.answer(escalationId, result.answer);
                  deps.logger.info(
                    { escalationId, projectId },
                    "responder answered escalation",
                  );
                } else {
                  // "approve" — route the draft to a human (shadow review, OR
                  // the permanent high-severity boundary at `on`).
                  await routeToHumanApproval(
                    deps.client,
                    escalationId,
                    result.answer,
                    deps.mode === "shadow"
                      ? "shadow mode — review the drafted answer before it reaches the client"
                      : "high-severity escalation — drafted answer requires human approval",
                  );
                  deps.logger.info(
                    { escalationId, projectId, mode: deps.mode, severity: detail.severity },
                    "responder routed drafted answer to a human for approval",
                  );
                }
                break;
              }
              case "needs_human":
                if (deps.mode === "off") {
                  deps.logger.info(
                    { escalationId, kind: result.kind, mode: deps.mode },
                    "outcome (mode=off) — not escalating; off is silent",
                  );
                  return;
                }
                await deps.client.escalateToHuman(escalationId, result.reason);
                deps.logger.info(
                  { escalationId, projectId, reason: result.reason },
                  "responder escalated to human (needs_human)",
                );
                break;
              case "give_up":
                if (deps.mode === "off") {
                  deps.logger.info(
                    { escalationId, kind: result.kind, mode: deps.mode },
                    "outcome (mode=off) — not escalating; off is silent",
                  );
                  return;
                }
                await deps.client.escalateToHuman(
                  escalationId,
                  `Responder gave up: ${result.reason}`,
                );
                deps.logger.info(
                  { escalationId, projectId, reason: result.reason },
                  "responder escalated to human (give_up)",
                );
                break;
              case "error":
                if (deps.mode === "off") {
                  deps.logger.info(
                    { escalationId, kind: result.kind, mode: deps.mode },
                    "outcome (mode=off) — not escalating; off is silent",
                  );
                  return;
                }
                await deps.client.escalateToHuman(
                  escalationId,
                  `Responder failed (${result.reason}): ${result.detail ?? ""}`,
                );
                deps.logger.warn(
                  { escalationId, projectId, reason: result.reason, detail: result.detail },
                  "responder session failed; escalated to human",
                );
                break;
            }
          } catch (postErr) {
            deps.logger.error(
              { escalationId, projectId, kind: result.kind, err: errMessage(postErr) },
              "post-spawn client call failed; escalation stays acknowledged (P6 reclaim recovers)",
            );
          }
        } catch (err) {
          if (err instanceof PmApiError && err.status === 403) {
            // Another responder already holds it — the C1 one-active gate did its
            // job. Skip silently; do NOT record as claimed.
            deps.logger.debug(
              { escalationId, projectId },
              "escalation already claimed by another responder; skipping",
            );
          } else if (err instanceof PmApiError && err.status === 409) {
            // Raced out of `open` (resolved/answered between list and ack). Skip.
            deps.logger.info(
              { escalationId, projectId },
              "escalation no longer open (raced); skipping",
            );
          } else {
            // Transient (5xx / network) or unknown — leave un-claimed; a later
            // tick retries.
            deps.logger.warn(
              { escalationId, projectId, err: errMessage(err) },
              "acknowledge failed; will retry next tick",
            );
          }
        } finally {
          state.inFlight.delete(escalationId);
        }
      })();
      pending.push(job);
    }
  }

  await Promise.all(pending);
}

export async function runResponderLoop(
  deps: RunResponderLoopDeps,
  opts: RunResponderLoopOptions = {},
): Promise<void> {
  const pollMs = opts.pollIntervalMs ?? 15_000;
  const state = createResponderState();

  while (deps.shouldContinue()) {
    try {
      await responderTick(deps, state);
    } catch (err) {
      // Defense-in-depth: responderTick is already per-project non-fatal, but a
      // bug in the tick body must never kill the loop.
      deps.logger.error({ err: errMessage(err) }, "responderTick threw unexpectedly");
    }

    if (!deps.shouldContinue()) break;
    await deps.waitForWork(pollMs);
  }
}

function createdAtMs(createdAt: string): number {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) ? t : 0;
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
