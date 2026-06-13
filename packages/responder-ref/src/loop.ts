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
import type {
  Escalation,
  EscalationMessage,
  EscalationSeverity,
  EscalationWithThread,
} from "@pm/shared";
import type { Logger } from "./logger.js";
import type { ResponderClient } from "./api-client.js";
import { PmApiError } from "./api-client.js";
import type { ResponderRunner } from "./responder-runner.js";
import type { InjectionSniffer } from "./injection-sniffer.js";
import type { ImplementRunner } from "./implement-runner.js";
import type { Worktree } from "./worktree.js";
import { buildResponderPrompt } from "./prompt.js";
import { buildImplementPrompt } from "./implement-prompt.js";
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
    | "addMessage"
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
  /**
   * Auto-implement kill-switch (Campaign A1 P1, FLAT — matches enabled/mode).
   * DEFAULT-effectively false. When TRUE the responder enters the write-capable
   * regime: the injection sniff-test gates session admission (P1 declares
   * `implement` intent; the write capability arrives in P2). When false the
   * session is answer-only/read-only (the existing safe path) — no sniff runs.
   */
  autoImplementEnabled: boolean;
  /**
   * Injectable injection sniff-test (Campaign A1 P1). Runs BEFORE the answering
   * session, ONLY when `autoImplementEnabled` — gating the write-capable
   * regime's entry on the RAW escalation. suspicious/error → escalate, do NOT
   * spawn (FAIL-SAFE). Real classifier in prod; scripted fake in tests.
   */
  sniffer: InjectionSniffer;
  /**
   * The injectable write-capable implement runner (A1 P3). Spawned ONLY on the
   * `implement{bounded}` path when auto_implement is enabled + the sniff is clean.
   * Real spawn (`createClaudeImplementRunner`) in prod; scripted fake in tests.
   */
  implementRunner: ImplementRunner;
  /**
   * Acquire an isolated worktree for an implement session (A1 P3, REVISE FIX #1).
   * Injectable: prod binds `createWorktree` to the git config + worktreeRoot; tests
   * inject a fake (no real git). Called with a stable slot name `pm-implement-<i>`.
   * The loop sizes the slot pool to `maxConcurrent` and leases a free slot per
   * implement session (released in the session's `finally`).
   */
  acquireWorktree: (slotName: string) => Worktree;
  /** Git config for the implement worktree (A1 P3): remote + main branch for push/diff. */
  worktreeGit: { remote: string; mainBranch: string };
  /**
   * Project verify command the implement agent runs in-session before declaring
   * branch_ready (A1 P3). "" ⇒ the agent skips in-session verify (A2 train re-verify
   * is the floor). Threaded into `buildImplementPrompt`.
   */
  verifyCmd: string;
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
  /**
   * Implement-worktree slot leases (A1 P3, REVISE FIX #1). Lazily populated up to
   * `maxConcurrent` entries (slot names `pm-implement-<i>`); `leased` guards a slot
   * against concurrent re-use. A session acquires a free slot, runs in its
   * worktree, and releases it in `finally`. IN-MEMORY — reset on restart.
   */
  implementSlots: { name: string; wt: Worktree; leased: boolean }[];
}

export function createResponderState(): ResponderState {
  return {
    inFlight: new Set(),
    claimed: new Set(),
    reclaimAttempts: new Map(),
    spawnTimestamps: [],
    implementSlots: [],
  };
}

/**
 * Lease a free implement-worktree slot (A1 P3, REVISE FIX #1). The slot pool is
 * sized to `maxConcurrent` (slot names `pm-implement-0..maxConcurrent-1`) and lazily
 * populated via `acquireWorktree`. Returns the leased slot, or null when every slot
 * is busy (rare — only at `maxConcurrent > 1` with all implement sessions in flight).
 */
function leaseImplementSlot(
  deps: ResponderDeps,
  state: ResponderState,
): { name: string; wt: Worktree; leased: boolean } | null {
  // Reuse an existing free slot first.
  for (const slot of state.implementSlots) {
    if (!slot.leased) {
      slot.leased = true;
      return slot;
    }
  }
  // Lazily populate a new slot if the pool is below maxConcurrent.
  if (state.implementSlots.length < deps.maxConcurrent) {
    const name = `pm-implement-${state.implementSlots.length}`;
    const slot = { name, wt: deps.acquireWorktree(name), leased: true };
    state.implementSlots.push(slot);
    return slot;
  }
  return null;
}

/**
 * Does this escalation's thread carry a pending-land handoff marker (A1 P3,
 * REVISE FIX #3)? A `branch_ready` implement session leaves a `diagnosis` message
 * with `metadata.pendingLand === true`; the reclaim sweep keys off it to SKIP a
 * landed-but-not-yet-merged escalation (it's waiting on A2/the train, not stranded —
 * re-spawning a read-only answering session on it would march the poison cap).
 */
function hasPendingLandMarker(messages: EscalationMessage[]): boolean {
  return messages.some((m) => m.metadata != null && m.metadata.pendingLand === true);
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

  // ── Injection sniff-test (A1 P1) — gates session admission for the
  // write-capable regime. ONLY when auto_implement is enabled (when disabled the
  // session is answer-only/read-only — the existing safe path — so no sniff).
  // suspicious/error → escalate-to-human and do NOT spawn (FAIL-SAFE: a tripwire
  // that can't run must not grant trust). Respect mode==="off"→silent. ──
  if (deps.autoImplementEnabled) {
    const sniffStatusPath = path.join(logsDir, `${escalationId}.sniff.status.json`);
    const sniffLogPath = path.join(logsDir, `${escalationId}.sniff.log`);
    const sniff = await deps.sniffer.sniff({
      escalation: detail,
      messages: detail.messages,
      budget: deps.budget,
      cwd: deps.repoCwd,
      logPath: sniffLogPath,
      statusPath: sniffStatusPath,
      signal: deps.signal,
    });
    if (sniff.kind !== "clean") {
      const reason =
        sniff.kind === "suspicious"
          ? `flagged by injection sniff-test: ${sniff.reason}`
          : `injection sniff-test could not run (${sniff.reason}); denying admission (fail-safe)`;
      if (deps.mode === "off") {
        deps.logger.info(
          { escalationId, projectId, sniff: sniff.kind, mode: deps.mode },
          "injection sniff-test gated admission (mode=off) — not escalating; off is silent",
        );
        return;
      }
      try {
        await deps.client.escalateToHuman(escalationId, reason);
        deps.logger.warn(
          { escalationId, projectId, sniff: sniff.kind },
          "injection sniff-test gated admission; escalated to human (session NOT spawned)",
        );
      } catch (postErr) {
        deps.logger.error(
          { escalationId, projectId, sniff: sniff.kind, err: errMessage(postErr) },
          "post-sniff escalateToHuman failed; escalation stays acknowledged (P6 reclaim recovers)",
        );
      }
      return; // session NOT spawned.
    }
  }

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
      case "implement": {
        if (deps.mode === "off") {
          deps.logger.info(
            { escalationId, kind: result.kind, size: result.size, mode: deps.mode },
            "implement (mode=off) — not acting; off is silent",
          );
          return;
        }
        if (!deps.autoImplementEnabled) {
          // REVISE FIX #1: auto_implement disabled (the default kill-switch) →
          // an `implement` declaration falls back to needs_human with the
          // rationale embedded. NEVER strand-acknowledged: the reclaim sweep only
          // re-spawns the read-only session, which would loop to the poison cap
          // with a misleading reason.
          await deps.client.escalateToHuman(
            escalationId,
            `Responder declared a code change (${result.size}) but auto_implement is disabled; needs a human. Rationale: ${result.rationale}`,
          );
          deps.logger.info(
            { escalationId, projectId, size: result.size },
            "implement declared but auto_implement disabled; escalated to human (fall-back)",
          );
          break;
        }
        // auto_implement ENABLED (the sniff already passed at admission).
        if (result.size === "systemic") {
          await deps.client.escalateToHuman(
            escalationId,
            `Systemic change — needs human (A3 drives systemic later). Rationale: ${result.rationale}`,
          );
          deps.logger.info(
            { escalationId, projectId },
            "implement (systemic) → escalated to human",
          );
        } else {
          // bounded — A1 P3: acquire an isolated worktree, spawn the write session,
          // and on branch_ready push + addMessage(pendingLand) leaving the
          // escalation acknowledged (A2 lands + resolves). NOTE: this runs OUTSIDE
          // the swallowing try/catch below (it owns its own non-fatal handling).
          // We return here so the outer catch never re-wraps it.
          await runImplementSession(deps, state, projectId, escalationId, detail);
        }
        break;
      }
    }
  } catch (postErr) {
    deps.logger.error(
      { escalationId, projectId, kind: result.kind, err: errMessage(postErr) },
      "post-spawn client call failed; escalation stays acknowledged (P6 reclaim recovers)",
    );
  }
}

/**
 * The write-capable implement session (A1 P3) — runs on the `implement{bounded}`
 * path when auto_implement is enabled and the injection sniff was clean. Acquires an
 * isolated worktree, pre-creates the escalation branch, spawns the write runner with
 * the in-session-verify prompt, and on `branch_ready` PUSHES the branch + appends a
 * `pendingLand` handoff message — LEAVING the escalation `acknowledged` (A2 lands +
 * resolves; the responder never answers/resolves here). give_up/error escalate to a
 * human (mode=off ⇒ silent). NO land yet (A2). All PM/git I/O is non-fatal — a
 * failure escalates (no proven work discarded) and never escapes the job; the
 * worktree is reset for reuse + the slot released in `finally`.
 */
async function runImplementSession(
  deps: ResponderDeps,
  state: ResponderState,
  projectId: string,
  escalationId: string,
  detail: EscalationWithThread,
): Promise<void> {
  const branch = `pm/escalation-${escalationId}`;

  // Lease a worktree slot (sized to maxConcurrent). None free ⇒ escalate (rare;
  // only at maxConcurrent>1 with every implement session in flight).
  const slot = leaseImplementSlot(deps, state);
  if (slot === null) {
    if (deps.mode === "off") return; // off is silent.
    try {
      await deps.client.escalateToHuman(
        escalationId,
        "no free implement worktree slot (all busy); needs a human or a retry",
      );
    } catch (err) {
      deps.logger.error(
        { escalationId, projectId, err: errMessage(err) },
        "no-slot escalateToHuman failed; escalation stays acknowledged (reclaim recovers)",
      );
    }
    return;
  }

  const wt = slot.wt;

  // Prepare the worktree (clone-if-needed + reset to fresh main). A failure here is
  // non-fatal: escalate, release the slot, return. The runner never spawns.
  try {
    await wt.ensureExists();
    await wt.resetForAttempt();
  } catch (err) {
    slot.leased = false;
    if (deps.mode === "off") return; // off is silent.
    try {
      await deps.client.escalateToHuman(
        escalationId,
        `could not prepare a worktree: ${errMessage(err)}`,
      );
    } catch (postErr) {
      deps.logger.error(
        { escalationId, projectId, err: errMessage(postErr) },
        "worktree-prep escalateToHuman failed; escalation stays acknowledged (reclaim recovers)",
      );
    }
    return;
  }

  try {
    // Pre-create the branch the agent commits onto.
    await wt.git.checkoutLocalBranch(branch);

    const logsDir = deps.logsDir ?? tmpdir();
    const statusPath = path.join(logsDir, `${escalationId}.implement.status.json`);
    const logPath = path.join(logsDir, `${escalationId}.implement.log`);
    const prompt = buildImplementPrompt(detail, detail.messages, branch, deps.verifyCmd);

    const result = await deps.implementRunner.run({
      escalation: detail,
      thread: detail.messages,
      branch,
      worktreePath: wt.path,
      budget: deps.budget,
      command: deps.command,
      prompt,
      logPath,
      statusPath,
      signal: deps.signal,
    });

    // Outcome handling — every PM/git call wrapped so a transient failure never
    // escapes the job (the escalation stays acknowledged; reclaim recovers it).
    try {
      switch (result.kind) {
        case "branch_ready": {
          const readyBranch = result.branch;
          const commitSha = result.commitSha;
          // Push the branch (no land — A2). A push failure escalates (work is
          // committed locally; nothing lost) and does NOT addMessage.
          try {
            await wt.git.push(deps.worktreeGit.remote, readyBranch, ["--set-upstream"]);
          } catch (pushErr) {
            if (deps.mode === "off") break; // off is silent.
            await deps.client.escalateToHuman(
              escalationId,
              `implemented on branch ${readyBranch} but push failed: ${errMessage(pushErr)}`,
            );
            deps.logger.warn(
              { escalationId, projectId, branch: readyBranch, err: errMessage(pushErr) },
              "implement push failed; escalated to human (no work lost)",
            );
            break;
          }

          if (deps.mode === "off") {
            deps.logger.info(
              { escalationId, projectId, branch: readyBranch, mode: deps.mode },
              "implement branch_ready (mode=off) — pushed but not handing off; off is silent",
            );
            break;
          }

          // Diff summary (best-effort — a failure just omits the stat).
          let diffSummary = "";
          try {
            const stat = await wt.git.diff([
              "--stat",
              `${deps.worktreeGit.mainBranch}..${readyBranch}`,
            ]);
            diffSummary = stat.length > 2000 ? `${stat.slice(0, 2000)}\n…(truncated)` : stat;
          } catch {
            /* diff is advisory; omit on failure */
          }

          const body =
            `Implemented a fix on branch \`${readyBranch}\`` +
            (commitSha ? ` (\`${commitSha}\`)` : "") +
            `, pending land (A2).` +
            (diffSummary.length > 0 ? `\n\n${diffSummary}` : "");
          // addMessage leaves the escalation ACKNOWLEDGED (NOT answer/resolve — A2
          // lands + resolves). The pendingLand marker stops the reclaim re-spawn.
          await deps.client.addMessage(escalationId, body, "diagnosis", {
            pendingLand: true,
            branch: readyBranch,
            commitSha: commitSha ?? null,
          });
          deps.logger.info(
            { escalationId, projectId, branch: readyBranch, commitSha },
            "implemented + pushed branch; appended pending-land handoff (stays acknowledged for A2)",
          );
          break;
        }
        case "give_up":
          if (deps.mode === "off") break; // off is silent.
          await deps.client.escalateToHuman(
            escalationId,
            `Responder could not implement: ${result.reason}`,
          );
          deps.logger.info(
            { escalationId, projectId, reason: result.reason },
            "implement give_up; escalated to human",
          );
          break;
        case "error":
          if (deps.mode === "off") break; // off is silent.
          await deps.client.escalateToHuman(
            escalationId,
            `implement session failed (${result.reason}): ${result.detail ?? ""}`,
          );
          deps.logger.warn(
            { escalationId, projectId, reason: result.reason, detail: result.detail },
            "implement session failed; escalated to human",
          );
          break;
      }
    } catch (postErr) {
      deps.logger.error(
        { escalationId, projectId, kind: result.kind, err: errMessage(postErr) },
        "post-implement client call failed; escalation stays acknowledged (reclaim recovers)",
      );
    }
  } finally {
    // Clean the worktree for reuse (safe — the branch is pushed to the remote) and
    // release the slot. A reset failure is non-fatal (the next lease re-resets).
    try {
      await wt.resetForAttempt();
    } catch (err) {
      deps.logger.warn(
        { escalationId, projectId, err: errMessage(err) },
        "post-implement worktree reset failed; will re-reset on next lease",
      );
    }
    slot.leased = false;
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

      // REVISE FIX #3 (reclaim guard): SKIP an escalation whose thread carries the
      // pending-land marker — it's a landed-but-not-yet-merged implement handoff
      // waiting on A2/the train, NOT a stranded read-only session. Re-spawning a
      // read-only answering session on it would march the poison cap. A fetch
      // failure is non-fatal: fall through (the existing reclaim path then handles
      // it as before — a getEscalation failure inside the session is logged).
      try {
        const thread = await deps.client.getEscalation(escalationId);
        if (hasPendingLandMarker(thread.messages)) {
          deps.logger.debug(
            { escalationId, projectId },
            "reclaim skip: escalation has a pending-land handoff (awaiting A2); not re-spawning",
          );
          continue;
        }
      } catch (err) {
        deps.logger.warn(
          { escalationId, projectId, err: errMessage(err) },
          "reclaim pending-land probe failed; proceeding with the normal reclaim path",
        );
      }

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
