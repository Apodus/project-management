/**
 * The wake loop (Campaign C2 P2).
 *
 * Per watched worker key, each tick:
 *   1. GET undelivered escalations (a per-key error → warn + continue; the loop
 *      survives and recovers next tick).
 *   2. Keep only escalations WITH unread messages, processed OLDEST-UNREAD-FIRST
 *      (binding addition 3) so a stuck/parked item never perpetually pre-empts a
 *      newer one under maxConcurrentWakes=1.
 *   3. For each, with guards (in-flight, already-woke-for-this-maxSeq, min-wake
 *      cooldown, concurrency semaphore, give-up park), spawn a fresh worker turn.
 *      On `{kind:"ok"}` → mark-delivered(maxSeq). On a failure → NO mark-delivered
 *      (it re-wakes after cooldown) + increment the give-up counter.
 *
 * Give-up (binding addition 1): a per-escalation `{failures, lastMaxSeq}` map. On
 * a failure, failures++. At `failures >= maxConsecutiveFailures` the escalation is
 * PARKED (logged once) until its unread maxSeq advances (a new reply → maxSeq
 * changes → reset failures, un-park). A successful wake also resets failures.
 */
import path from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "./logger.js";
import type { WakeClient } from "./api-client.js";
import { PmApiError } from "./api-client.js";
import type { WorkerRunner } from "./worker-runner.js";
import { buildWakePrompt } from "./prompt.js";
import type { WatchEntry } from "./config.js";

export interface WakeDeps {
  client: Pick<WakeClient, "listUndelivered" | "markDelivered">;
  runner: WorkerRunner;
  logger: Logger;
  watch: WatchEntry[];
  workerCommand: string;
  workerCwd: string;
  timeBudgetSec: number;
  tokenBudget?: number;
  maxConcurrentWakes: number;
  minWakeIntervalSec: number;
  maxConsecutiveFailures: number;
  promptTemplate: string;
  /** Log directory for per-wake worker output. Defaults to the OS temp dir. */
  logsDir?: string;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface RunWakeLoopDeps extends WakeDeps {
  /** Resolves when the poll tick elapses (or a wakeup arrives). */
  waitForWork: (pollMs: number) => Promise<void>;
  /** Should the loop keep running? Flipped by the SIGTERM/SIGINT handler. */
  shouldContinue: () => boolean;
}

export interface RunWakeLoopOptions {
  pollIntervalMs?: number;
}

interface GiveUpState {
  failures: number;
  lastMaxSeq: number;
}

/**
 * Per-process mutable wake state, threaded across ticks. Created once by
 * `runWakeLoop` and passed into every `wakeTick`.
 */
export interface WakeState {
  /** Escalations with a wake spawn currently running (skip a second spawn). */
  inFlight: Set<string>;
  /** Last maxSeq we successfully woke for (skip re-waking the same maxSeq). */
  lastUptoSeq: Map<string, number>;
  /** Last wall-clock time we spawned a wake for an escalation (cooldown gate). */
  lastWakeAt: Map<string, number>;
  /** Per-escalation give-up counter (binding addition 1). */
  giveUp: Map<string, GiveUpState>;
}

export function createWakeState(): WakeState {
  return {
    inFlight: new Set(),
    lastUptoSeq: new Map(),
    lastWakeAt: new Map(),
    giveUp: new Map(),
  };
}

function maxSeqOf(unread: { seq: number }[]): number {
  let m = 0;
  for (const u of unread) if (u.seq > m) m = u.seq;
  return m;
}

function oldestUnreadAt(unread: { createdAt: string }[], escalationCreatedAt: string): number {
  // Oldest unread message createdAt; fall back to the escalation's own createdAt
  // when (defensively) there are no messages. Parsed to ms for a stable sort.
  let oldest = Number.POSITIVE_INFINITY;
  for (const u of unread) {
    const t = Date.parse(u.createdAt);
    if (Number.isFinite(t) && t < oldest) oldest = t;
  }
  if (oldest === Number.POSITIVE_INFINITY) {
    const t = Date.parse(escalationCreatedAt);
    return Number.isFinite(t) ? t : 0;
  }
  return oldest;
}

/**
 * One poll pass over every watched worker key. Non-throwing per key: a poll error
 * is logged and the other keys still run. Spawns are awaited only up to the
 * concurrency semaphore — a wake spawn that would exceed `maxConcurrentWakes` is
 * skipped this tick and reappears next tick.
 */
export async function wakeTick(deps: WakeDeps, state: WakeState): Promise<void> {
  const now = deps.now ?? Date.now;
  const logsDir = deps.logsDir ?? tmpdir();
  const cooldownMs = deps.minWakeIntervalSec * 1000;

  // The concurrency budget is GLOBAL across all watched keys this tick.
  let available = deps.maxConcurrentWakes - state.inFlight.size;
  if (available < 0) available = 0;

  const pending: Promise<void>[] = [];

  for (const entry of deps.watch) {
    let undelivered;
    try {
      undelivered = await deps.client.listUndelivered(entry.workerKey, entry.projectId);
    } catch (err) {
      deps.logger.warn(
        { workerKey: entry.workerKey, projectId: entry.projectId, err: errMessage(err) },
        "listUndelivered failed; skipping this key for this tick",
      );
      continue;
    }

    // Keep only escalations that actually have unread messages, OLDEST-UNREAD-FIRST.
    const actionable = undelivered
      .filter((u) => u.unreadMessages.length > 0)
      .sort(
        (a, b) =>
          oldestUnreadAt(a.unreadMessages, a.escalation.createdAt) -
          oldestUnreadAt(b.unreadMessages, b.escalation.createdAt),
      );

    for (const item of actionable) {
      if (available <= 0) break; // semaphore saturated — reappears next tick.

      const escalationId = item.escalation.id;
      const uptoSeq = maxSeqOf(item.unreadMessages);

      // Give-up: reset/un-park when the unread maxSeq advances past what we last
      // saw; PARK once the failure threshold is reached and maxSeq has NOT moved.
      const gu = state.giveUp.get(escalationId);
      if (gu && uptoSeq > gu.lastMaxSeq) {
        // A new reply arrived → un-park, fresh failure budget.
        state.giveUp.delete(escalationId);
      }
      const guNow = state.giveUp.get(escalationId);
      if (guNow && guNow.failures >= deps.maxConsecutiveFailures) {
        continue; // parked until maxSeq advances (handled above).
      }

      // Guard: already spawning for this escalation.
      if (state.inFlight.has(escalationId)) continue;

      // Guard: already woke for this exact maxSeq (no new reply since).
      if (state.lastUptoSeq.get(escalationId) === uptoSeq) continue;

      // Guard: min-wake cooldown.
      const last = state.lastWakeAt.get(escalationId);
      if (last !== undefined && now() - last < cooldownMs) continue;

      // Admit. Claim a semaphore slot + the in-flight marker.
      available -= 1;
      state.inFlight.add(escalationId);
      state.lastWakeAt.set(escalationId, now());

      const prompt = buildWakePrompt(item.escalation, item.unreadMessages, deps.promptTemplate);
      const logPath = path.join(logsDir, `wake-${escalationId}-${uptoSeq}.log`);

      const job = (async (): Promise<void> => {
        try {
          const result = await deps.runner.run({
            workerKey: entry.workerKey,
            escalation: item.escalation,
            unreadMessages: item.unreadMessages,
            prompt,
            budget: { timeBudgetSec: deps.timeBudgetSec, tokenBudget: deps.tokenBudget },
            cwd: deps.workerCwd,
            command: deps.workerCommand,
            logPath,
          });

          if (result.kind === "ok") {
            // SUCCESS classification (binding addition 2): mark-delivered ONLY on
            // a clean bounded exit. Reset the give-up counter.
            state.giveUp.delete(escalationId);
            state.lastUptoSeq.set(escalationId, uptoSeq);
            try {
              await deps.client.markDelivered(escalationId, entry.workerKey, uptoSeq);
              deps.logger.info(
                { escalationId, workerKey: entry.workerKey, uptoSeq },
                "woke worker and advanced delivery cursor",
              );
            } catch (err) {
              if (err instanceof PmApiError && (err.status === 403 || err.status === 404)) {
                // Permanent: wrong worker key / gone escalation. Park the cursor
                // (lastUptoSeq already set above) — do NOT retry.
                deps.logger.error(
                  { escalationId, workerKey: entry.workerKey, uptoSeq, status: err.status },
                  "markDelivered rejected (403/404); parking — will not retry",
                );
              } else {
                // 5xx / network: leave the cursor un-advanced so a later tick
                // re-marks after cooldown.
                state.lastUptoSeq.delete(escalationId);
                deps.logger.warn(
                  { escalationId, workerKey: entry.workerKey, uptoSeq, err: errMessage(err) },
                  "markDelivered transient failure; will retry after cooldown",
                );
              }
            }
          } else {
            // FAILURE (timeout / spawn_error / nonzero_exit): NO mark-delivered →
            // it re-wakes after cooldown. Increment the give-up counter.
            const prev = state.giveUp.get(escalationId);
            const failures = (prev?.failures ?? 0) + 1;
            state.giveUp.set(escalationId, { failures, lastMaxSeq: uptoSeq });
            if (failures >= deps.maxConsecutiveFailures) {
              deps.logger.error(
                { escalationId, workerKey: entry.workerKey, failures, reason: result.reason },
                `parking escalation ${escalationId} after ${failures} consecutive wake failures`,
              );
            } else {
              deps.logger.warn(
                { escalationId, workerKey: entry.workerKey, failures, reason: result.reason },
                "wake spawn failed; will re-wake after cooldown",
              );
            }
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

export async function runWakeLoop(
  deps: RunWakeLoopDeps,
  opts: RunWakeLoopOptions = {},
): Promise<void> {
  const pollMs = opts.pollIntervalMs ?? 15_000;
  const state = createWakeState();

  while (deps.shouldContinue()) {
    try {
      await wakeTick(deps, state);
    } catch (err) {
      // Defense-in-depth: wakeTick is already per-key non-fatal, but a bug in the
      // tick body must never kill the loop.
      deps.logger.error({ err: errMessage(err) }, "wakeTick threw unexpectedly");
    }

    if (!deps.shouldContinue()) break;
    await deps.waitForWork(pollMs);
  }
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
