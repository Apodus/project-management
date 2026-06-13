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
 *
 * ── C3 P6a — three safety seals ────────────────────────────────────────────
 *
 * Seal 1 — NO-RECURSION (full seal; NO depth marker). WHY no depth marker: the
 * responder exposes NO escalation-CREATING action (answer→answered,
 * escalateToHuman→needs_human; neither mints a new escalation). Recursion is
 * therefore STRUCTURALLY ABSENT — a responder answer can never spawn a new
 * escalation it would then re-pick. The complete seal is the seed predicate:
 *   authorId !== selfId  (never answer our own thread)
 *   && status === "open"
 *   && !excludeOriginRepos.includes(originRepo)   ← the P6a addition
 * `excludeOriginRepos` is the belt-and-suspenders for a self-hosted PM repo
 * whose own escalations a co-located responder must not auto-answer.
 *
 * Seal 2 — RECLAIM SWEEP. A claim → spawn → (transient post-spawn failure)
 * leaves an escalation stranded `acknowledged` under our holderId with no
 * spawn-retry on the claim path. After the claim pass, a reclaim pass lists
 * OUR acknowledged escalations per project and re-processes the STALE ones
 * (`now - updatedAt > (timeBudgetSec + reclaimGraceSec)`) sharing the SAME
 * concurrency semaphore + spawn budget + inFlight set. It re-runs the answering
 * session WITHOUT re-acknowledging (we already hold it). A per-process poison
 * cap (`maxReclaimAttempts`) hands a repeatedly-failing thread to a human via
 * escalateToHuman (→needs_human stops re-qualification). reclaimAttempts +
 * spawnTimestamps are IN-MEMORY and reset on restart (bounded-per-process —
 * matches the 7.6.1 reclaim precedent).
 *
 * Seal 3 — SPAWN-RATE BUDGET. A sliding window (`spawnBudget {maxSpawns,
 * windowSec}`) caps real spawns across BOTH paths. `canSpawn` prunes the
 * window then gates strict-`<`; `recordSpawn` is called immediately before the
 * real `runner.run`, so a 403/409-failed acknowledge never consumes budget.
 */
import path from "node:path";
import { tmpdir } from "node:os";
import type { Escalation, EscalationSeverity } from "@pm/shared";
import type { Logger } from "./logger.js";
import type { ResponderClient } from "./api-client.js";
import { PmApiError } from "./api-client.js";
import type { ResponderRunner } from "./responder-runner.js";
import { buildResponderPrompt } from "./prompt.js";
import type { ResponderMode, SpawnBudget } from "./config.js";

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
    | "listOpenEscalations"
    | "listAcknowledgedByHolder"
    | "acknowledge"
    | "answer"
    | "escalateToHuman"
    | "getEscalation"
  >;
  logger: Logger;
  projectIds: string[];
  /** This responder's own user id (from /auth/me) — the no-recursion seed. */
  selfId: string;
  /** Kill-switch. A disabled tick is a no-op. */
  enabled: boolean;
  maxConcurrent: number;
  /** No-recursion seal (C3 P6a): origin repos to NEVER seed/reclaim. */
  excludeOriginRepos: string[];
  /** Reclaim staleness grace (sec) beyond timeBudgetSec (C3 P6a). */
  reclaimGraceSec: number;
  /** Max per-process reclaim re-spawns before handing to a human (C3 P6a). */
  maxReclaimAttempts: number;
  /** Sliding-window spawn-rate budget gating every spawn (C3 P6a). */
  spawnBudget: SpawnBudget;
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
  /**
   * Per-process reclaim re-spawn counts (C3 P6a). At `maxReclaimAttempts` the
   * thread is handed to a human. IN-MEMORY — reset on restart (bounded-per-
   * process; matches the 7.6.1 reclaim precedent).
   */
  reclaimAttempts: Map<string, number>;
  /**
   * Sliding-window spawn timestamps (ms) for the spawn-rate budget (C3 P6a).
   * IN-MEMORY — reset on restart.
   */
  spawnTimestamps: number[];
}

export function createResponderState(): ResponderState {
  return {
    inFlight: new Set(),
    claimed: new Set(),
    reclaimAttempts: new Map(),
    spawnTimestamps: [],
  };
}

/**
 * Spawn-rate budget gate (C3 P6a, pure). Prunes `state.spawnTimestamps` IN
 * PLACE to those strictly within `(now - windowSec*1000, now]`, then returns
 * whether another spawn fits (strict `<` against maxSpawns — no off-by-one).
 */
export function canSpawn(state: ResponderState, spawnBudget: SpawnBudget, now: number): boolean {
  const cutoff = now - spawnBudget.windowSec * 1000;
  const kept = state.spawnTimestamps.filter((t) => t > cutoff && t <= now);
  state.spawnTimestamps.length = 0;
  state.spawnTimestamps.push(...kept);
  return state.spawnTimestamps.length < spawnBudget.maxSpawns;
}

/**
 * Reserve a spawn against the sliding window (C3 P6a). Pushed synchronously at
 * admission so concurrent admissions in the SAME tick see the reservation (a
 * post-await record would let every concurrent candidate pass an empty gate).
 */
export function recordSpawn(state: ResponderState, now: number): void {
  state.spawnTimestamps.push(now);
}

/**
 * Refund a reservation (C3 P6a) — the claim path calls this when the
 * acknowledge fails, so a 403/409/transient ack never consumes spawn budget.
 * Removes one occurrence of `now` (the reservation timestamp).
 */
export function refundSpawn(state: ResponderState, now: number): void {
  const i = state.spawnTimestamps.lastIndexOf(now);
  if (i >= 0) state.spawnTimestamps.splice(i, 1);
}

/**
 * The post-acknowledge answering session — shared by the claim path AND the P6a
 * reclaim path. Fetches the thread, builds the prompt, records a spawn against
 * the budget, spawns the session, and handles the 4-state outcome (P5 mode
 * gate + decideAnsweredDisposition + routeToHumanApproval). PRESERVES P3-P5
 * behavior EXACTLY (the swallowing inner try/catch wraps only the POST). Does
 * NOT acknowledge or touch `state.claimed` (the claim path owns the claim; the
 * reclaim path already holds it). The spawn is RESERVED against the budget by
 * the caller at admission (a synchronous reservation is what gates concurrent
 * admissions correctly); the claim path REFUNDS that reservation if the
 * acknowledge fails, so a 403/409-failed ack never consumes budget.
 */
async function runAnsweringSession(
  deps: ResponderDeps,
  state: ResponderState,
  projectId: string,
  escalationId: string,
): Promise<void> {
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
          deps.logger.info({ escalationId, projectId }, "responder answered escalation");
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
        await deps.client.escalateToHuman(escalationId, `Responder gave up: ${result.reason}`);
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
}

/**
 * One poll pass over every watched project. Non-throwing per project: a poll
 * error is logged and the other projects still run. Claims are awaited only up
 * to the concurrency semaphore — a claim that would exceed `maxConcurrent` is
 * skipped this tick and reappears next tick. After the claim pass, a reclaim
 * pass (C3 P6a) recovers stranded-acknowledged self-held escalations, sharing
 * the SAME semaphore + spawn budget + inFlight set.
 */
export async function responderTick(deps: ResponderDeps, state: ResponderState): Promise<void> {
  if (!deps.enabled) return; // kill-switch — inert tick.

  const now = (deps.now ?? Date.now)();

  // The concurrency budget is GLOBAL across all watched projects this tick.
  const slot = { available: deps.maxConcurrent - state.inFlight.size };
  if (slot.available < 0) slot.available = 0;

  const pending: Promise<void>[] = [];

  // ── Claim pass. ──
  for (const projectId of deps.projectIds) {
    if (slot.available <= 0) break; // semaphore saturated — reappears next tick.

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

    // SEED filter (no-recursion full seal, C3 P6a): unclaimed, open, NOT
    // authored by us, NOT from an excluded origin repo, not already claimed
    // this process. Oldest-first by createdAt.
    const candidates = open
      .filter(
        (e) =>
          e.holderId == null &&
          e.authorId !== deps.selfId &&
          e.status === "open" &&
          !deps.excludeOriginRepos.includes(e.originRepo) &&
          !state.claimed.has(e.id),
      )
      .sort((a, b) => createdAtMs(a.createdAt) - createdAtMs(b.createdAt));

    for (const esc of candidates) {
      if (slot.available <= 0) break; // semaphore saturated.

      const escalationId = esc.id;
      if (state.inFlight.has(escalationId)) continue; // already claiming.

      // Spawn-rate budget gate (Seal 3): if exhausted, defer this project's
      // remaining candidates this tick.
      if (!canSpawn(state, deps.spawnBudget, now)) {
        deps.logger.info(
          { projectId, spawned: state.spawnTimestamps.length, maxSpawns: deps.spawnBudget.maxSpawns },
          `spawn budget exhausted (${state.spawnTimestamps.length}/${deps.spawnBudget.maxSpawns} in ${deps.spawnBudget.windowSec}s); deferring`,
        );
        break;
      }

      // Admit. Claim a semaphore slot + the in-flight marker + RESERVE the
      // spawn budget synchronously (so concurrent admissions this tick see it).
      slot.available -= 1;
      state.inFlight.add(escalationId);
      recordSpawn(state, now);

      const job = (async (): Promise<void> => {
        try {
          await deps.client.acknowledge(escalationId);
          // The `claimed` set deliberately blocks ANY re-attempt on a later
          // failure: once we hold the claim, a post-spawn failure leaves the
          // escalation stranded-acknowledged and P6a reclaim owns recovery.
          state.claimed.add(escalationId);
          deps.logger.info(
            { escalationId, projectId },
            `claimed escalation ${escalationId}; spawning answering session`,
          );
          await runAnsweringSession(deps, state, projectId, escalationId);
        } catch (err) {
          // The acknowledge failed → no real spawn happened → REFUND the budget
          // reservation (Seal 3: a 403/409/transient ack consumes no budget).
          refundSpawn(state, now);
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

  // ── Reclaim pass (C3 P6a). Recover stranded-acknowledged self-held
  // escalations stale past updatedAt + (timeBudgetSec + reclaimGraceSec).
  // Shares the SAME `slot.available` semaphore + spawn budget + inFlight set. ──
  const staleThresholdMs = (deps.budget.timeBudgetSec + deps.reclaimGraceSec) * 1000;
  for (const projectId of deps.projectIds) {
    if (slot.available <= 0) break;

    let stranded: Escalation[];
    try {
      stranded = await deps.client.listAcknowledgedByHolder(projectId, deps.selfId);
    } catch (err) {
      deps.logger.warn(
        { projectId, err: errMessage(err) },
        "listAcknowledgedByHolder failed; skipping reclaim for this project",
      );
      continue;
    }

    const stale = stranded
      .filter(
        (e) =>
          now - updatedAtMs(e.updatedAt) > staleThresholdMs &&
          !state.inFlight.has(e.id) &&
          !deps.excludeOriginRepos.includes(e.originRepo),
      )
      .sort((a, b) => updatedAtMs(a.updatedAt) - updatedAtMs(b.updatedAt));

    for (const esc of stale) {
      if (slot.available <= 0) break;
      const escalationId = esc.id;

      // Poison cap: a thread re-spawned `maxReclaimAttempts` times without
      // resolving is handed to a human (→needs_human stops re-qualification).
      const attempts = state.reclaimAttempts.get(escalationId) ?? 0;
      if (attempts >= deps.maxReclaimAttempts) {
        // PIN 1: swallow — an escalateToHuman throw must NOT kill the sweep.
        // On success the row leaves `acknowledged` and stops re-qualifying; on
        // failure it harmlessly retries one cheap POST next sweep. No re-spawn.
        const reclaimJob = (async (): Promise<void> => {
          try {
            await deps.client.escalateToHuman(
              escalationId,
              `Reclaim exhausted after ${attempts} attempts; handing to a human`,
            );
            deps.logger.warn(
              { escalationId, projectId, attempts },
              "reclaim poison cap reached; escalated to human",
            );
          } catch (err) {
            deps.logger.error(
              { escalationId, projectId, attempts, err: errMessage(err) },
              "reclaim poison-cap escalateToHuman failed; will retry next sweep",
            );
          }
        })();
        pending.push(reclaimJob);
        continue;
      }

      if (!canSpawn(state, deps.spawnBudget, now)) {
        deps.logger.info(
          { projectId, spawned: state.spawnTimestamps.length, maxSpawns: deps.spawnBudget.maxSpawns },
          `spawn budget exhausted (${state.spawnTimestamps.length}/${deps.spawnBudget.maxSpawns} in ${deps.spawnBudget.windowSec}s); deferring reclaim`,
        );
        break;
      }

      // Reserve a slot + the in-flight marker + bump the attempt counter +
      // RESERVE the spawn budget synchronously (the reclaim path always spawns —
      // no acknowledge, so no refund). Mirrors the claim-path reservation.
      state.reclaimAttempts.set(escalationId, attempts + 1);
      slot.available -= 1;
      state.inFlight.add(escalationId);
      recordSpawn(state, now);
      deps.logger.info(
        { escalationId, projectId, attempt: attempts + 1 },
        `reclaiming stranded acknowledged escalation ${escalationId}`,
      );

      const job = (async (): Promise<void> => {
        try {
          // NO acknowledge — we already hold the claim.
          await runAnsweringSession(deps, state, projectId, escalationId);
        } catch (err) {
          deps.logger.warn(
            { escalationId, projectId, err: errMessage(err) },
            "reclaim answering session failed; will retry next sweep",
          );
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

/**
 * Parse `updatedAt` for the reclaim staleness check. Fail-safe-to-LIVE: an
 * unparseable timestamp returns +Infinity so `now - Infinity = -Infinity` is
 * never `> threshold` — an entity is never aggressively reclaimed on a bad date.
 */
function updatedAtMs(updatedAt: string): number {
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) ? t : Infinity;
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
