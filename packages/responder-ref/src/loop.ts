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
import type { DriveRunner } from "./drive-runner.js";
import type { Worktree } from "./worktree.js";
import { buildResponderPrompt } from "./prompt.js";
import { buildImplementPrompt, type PhaseBrief } from "./implement-prompt.js";
import { buildDrivePrompt } from "./drive-prompt.js";
import type { ArcEpic, ArcMergeRequest } from "./api-client.js";
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
    | "submitMergeRequest"
    | "createEpic"
    | "createTask"
    | "listMergeRequests"
    | "getEpic"
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
   * The injectable vision-producing drive runner (A3 P1). Spawned ONLY on the
   * `implement{systemic}` path when auto_implement is enabled + the sniff is clean.
   * Real spawn (`createClaudeDriveRunner`) in prod; scripted fake in tests. It
   * writes a vision `.md` in the worktree; the LOOP creates the PM epic + tasks over
   * HTTP from its result (the session does NO PM write-back).
   */
  driveRunner: DriveRunner;
  /**
   * Acquire an isolated worktree for an implement session (A1 P3, REVISE FIX #1).
   * Injectable: prod binds `createWorktree` to the git config + worktreeRoot; tests
   * inject a fake (no real git). Called with a stable slot name `pm-implement-<i>`.
   * The loop sizes the slot pool to `maxConcurrent` and leases a free slot per
   * implement session (released in the session's `finally`).
   */
  acquireWorktree: (slotName: string) => Worktree;
  /**
   * Git config for the implement worktree (A1 P3 + P4): remote + main branch for
   * push/diff, plus `allowedPaths` — the coarse blast-radius allowlist (literal
   * path prefixes). EMPTY ⇒ no restriction (permissive-by-design; the clone IS
   * the PM repo). When non-empty, a branch_ready whose diff touches a path
   * outside every prefix is NOT pushed — it escalates to a human.
   */
  worktreeGit: { remote: string; mainBranch: string; allowedPaths: string[] };
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
 * Does this escalation's thread carry a pending-DRIVE handoff marker (A3 P1)? A
 * `vision_ready` drive session leaves a `diagnosis` message with
 * `metadata.pendingDrive === true`; the reclaim sweep keys off it (alongside the
 * pending-land marker) to SKIP an escalation whose vision+epic is awaiting the P2
 * campaign drive — re-spawning a read-only answering session on it would march the
 * poison cap.
 */
function hasPendingDriveMarker(messages: EscalationMessage[]): boolean {
  return messages.some((m) => m.metadata != null && m.metadata.pendingDrive === true);
}

/**
 * Does this escalation's thread carry a pending-ARC handoff marker (A3 P2)? Each
 * advanceArc phase submit leaves a `diagnosis` message with `metadata.pendingArc ===
 * true` (carrying `{epicId, phaseTaskId, mergeRequestId}`). The marker-skip site keys
 * off it (alongside pendingDrive) to ROUTE the escalation into advanceArc each reclaim
 * cycle — the tick-driven advance — rather than re-spawning a read-only answering
 * session (which would march the poison cap).
 */
function hasPendingArcMarker(messages: EscalationMessage[]): boolean {
  return messages.some((m) => m.metadata != null && m.metadata.pendingArc === true);
}

/**
 * Does this escalation's thread already carry the terminal `arcComplete` marker (A3
 * P2)? advanceArc keys off it so an all-landed arc re-parks (idempotent) instead of
 * re-appending the marker every cycle — the escalation stays acknowledged + marked
 * (still arc-routed) until P4 resolves it.
 */
function hasArcCompleteMarker(messages: EscalationMessage[]): boolean {
  return messages.some((m) => m.metadata != null && m.metadata.arcComplete === true);
}

/**
 * Pull the epic id off the most-recent pendingDrive/pendingArc marker (A3 P2). P1's
 * pendingDrive carries `{epicId, visionPath}`; each P2 pendingArc carries
 * `{epicId, phaseTaskId, mergeRequestId}`. advanceArc reads the epic id from whichever
 * marker is present (they all carry the same epicId for the arc). Returns null when no
 * marker carries a string epicId (advanceArc then escalates — the arc is unrecoverable).
 */
function arcEpicId(messages: EscalationMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const md = messages[i].metadata;
    if (md != null && (md.pendingArc === true || md.pendingDrive === true)) {
      const e = md.epicId;
      if (typeof e === "string" && e.length > 0) return e;
    }
  }
  return null;
}

/**
 * Pull the vision path off the most-recent pendingDrive/pendingArc marker (A3 P2) so
 * the per-phase implement brief can name it. Best-effort: returns "" when absent (the
 * brief still scopes by the campaign-task title+description).
 */
function arcVisionPath(messages: EscalationMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const md = messages[i].metadata;
    if (md != null && (md.pendingArc === true || md.pendingDrive === true)) {
      const v = md.visionPath;
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return "";
}

/**
 * Coarse blast-radius allowlist check (A1 P4, pure). Returns the subset of
 * `touched` paths that fall OUTSIDE every allowed prefix. EMPTY `allowedPaths`
 * ⇒ NO restriction (permissive-by-design: the implement worktree IS a clone of
 * the PM repo, so [] means the whole PM repo is allowed) — returns []. A literal
 * coarse prefix match (`path.startsWith(prefix)`): a touched path is allowed iff
 * it starts with ANY allowed prefix.
 */
export function pathsOutsideAllowlist(touched: string[], allowedPaths: string[]): string[] {
  if (allowedPaths.length === 0) return [];
  return touched.filter((p) => !allowedPaths.some((prefix) => p.startsWith(prefix)));
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
          // A3 P1: a systemic change drives an autonomous VISION. Acquire an isolated
          // worktree, spawn the drive session (writes a vision .md), and on
          // vision_ready CREATE the PM epic + tasks over HTTP + addMessage(pendingDrive)
          // leaving the escalation acknowledged (P2 runs the campaign). NOTE: this runs
          // OUTSIDE the swallowing try/catch below (it owns its own non-fatal handling).
          // We return here so the outer catch never re-wraps it.
          await runDriveSession(deps, state, projectId, escalationId, detail);
          return;
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
/**
 * The per-implement parameterization (A3 P2). The A1 bounded-fix call and the A3
 * per-phase call share ONE machinery (`runImplementForBranch` below); only these
 * fields differ:
 *   - `branch`       — `pm/escalation-<id>` (A1) vs `pm/escalation-<id>-<taskId>` (phase).
 *   - `submitTaskId` — null (A1, task-LESS — its land resolves the root) vs the
 *                      campaign-task id (phase — its land does NOT resolve the root,
 *                      gated by Directive 1's `taskId === null` post-back guard).
 *   - `brief`        — undefined (A1, the escalation IS the scope) vs the phase brief.
 *   - `handoffMeta`  — `{pendingLand:true,…}` (A1, reclaim-skip) vs
 *                      `{pendingArc:true, epicId, phaseTaskId,…}` (phase, advanceArc-route).
 *   - `handoffLabel` — the message-body suffix ("pending land (A2)" / "pending campaign
 *                      phase land").
 */
interface ImplementPhaseConfig {
  branch: string;
  submitTaskId: string | null;
  brief?: PhaseBrief;
  /** Extra metadata merged onto the handoff message (besides mergeRequestId/branch/commitSha). */
  handoffMeta: Record<string, unknown>;
  /** The message-body suffix describing what the handoff is pending. */
  handoffLabel: string;
}

/**
 * The shared write-capable implement machinery (A1 P3 + A3 P2). Acquires an isolated
 * worktree, pre-creates the branch, spawns the write runner with the in-session-verify
 * prompt, and on `branch_ready` runs the allowlist check + PUSHES + submits an
 * escalationId-linked merge request + appends a handoff message — LEAVING the escalation
 * `acknowledged` (the responder never answers/resolves here). give_up/error escalate to a
 * human (mode=off ⇒ silent). All PM/git I/O is non-fatal — a failure escalates (no proven
 * work discarded) and never escapes the job; the worktree is reset for reuse + the slot
 * released in `finally`. The `cfg` parameterizes the A1-bounded vs A3-phase shape (see
 * ImplementPhaseConfig); returns whether a branch_ready handoff was appended (advanceArc
 * keys off this to know a phase MR was submitted).
 */
async function runImplementForBranch(
  deps: ResponderDeps,
  state: ResponderState,
  projectId: string,
  escalationId: string,
  detail: EscalationWithThread,
  cfg: ImplementPhaseConfig,
): Promise<boolean> {
  const branch = cfg.branch;
  let handedOff = false;

  // Lease a worktree slot (sized to maxConcurrent). None free ⇒ escalate (rare;
  // only at maxConcurrent>1 with every implement session in flight).
  const slot = leaseImplementSlot(deps, state);
  if (slot === null) {
    if (deps.mode === "off") return false; // off is silent.
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
    return false;
  }

  const wt = slot.wt;

  // Prepare the worktree (clone-if-needed + reset to fresh main). A failure here is
  // non-fatal: escalate, release the slot, return. The runner never spawns.
  try {
    await wt.ensureExists();
    await wt.resetForAttempt();
  } catch (err) {
    slot.leased = false;
    if (deps.mode === "off") return false; // off is silent.
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
    return false;
  }

  try {
    // Pre-create the branch the agent commits onto.
    await wt.git.checkoutLocalBranch(branch);

    const logsDir = deps.logsDir ?? tmpdir();
    const statusPath = path.join(logsDir, `${escalationId}.implement.status.json`);
    const logPath = path.join(logsDir, `${escalationId}.implement.log`);
    const prompt = buildImplementPrompt(
      detail,
      detail.messages,
      branch,
      deps.verifyCmd,
      undefined,
      cfg.brief,
    );

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

          // ── Coarse blast-radius allowlist check (A1 P4) — BEFORE push. ──
          // Compute the set of paths this branch touched vs main, then gate it
          // against `allowedPaths`. EMPTY allowlist ⇒ no restriction. A diff
          // failure FAILS SAFE: we do NOT push (we cannot prove the blast radius).
          // The local branch is wiped by the existing `finally` resetForAttempt.
          let touched: string[];
          try {
            const nameOnly = await wt.git.diff([
              "--name-only",
              `${deps.worktreeGit.mainBranch}..${readyBranch}`,
            ]);
            touched = nameOnly
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
          } catch (diffErr) {
            if (deps.mode === "off") break; // off is silent.
            await deps.client.escalateToHuman(
              escalationId,
              `could not compute the implement diff for the allowlist check: ${errMessage(diffErr)}; not landing`,
            );
            deps.logger.warn(
              { escalationId, projectId, branch: readyBranch, err: errMessage(diffErr) },
              "implement allowlist diff failed; escalated to human (fail-safe — not pushed)",
            );
            break;
          }
          const outside = pathsOutsideAllowlist(touched, deps.worktreeGit.allowedPaths);
          if (outside.length > 0) {
            if (deps.mode === "off") break; // off is silent.
            await deps.client.escalateToHuman(
              escalationId,
              `auto-implement edited paths outside the allowed set: ${outside.join(", ")}; not landing`,
            );
            deps.logger.warn(
              { escalationId, projectId, branch: readyBranch, outside },
              "implement touched paths outside the allowlist; escalated to human (not pushed)",
            );
            break;
          }

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

          // Submit the merge request (A2 P1) — escalationId-linked, over HTTP (NOT
          // pm_request_merge MCP). The train lands it. A1: task-LESS (its land
          // resolves the root). A3 phase: task-LINKED (Directive 1 gates the
          // post-back on taskId===null, so a phase land does NOT resolve the root —
          // advanceArc drives arc completion from server-observed land status). A
          // submit failure escalates (the branch is pushed — no work lost).
          let mr: { id: string };
          try {
            mr = await deps.client.submitMergeRequest(projectId, {
              resource: "main",
              taskId: cfg.submitTaskId,
              branch: readyBranch,
              commitSha: commitSha ?? null,
              verifyCmd: deps.verifyCmd || null,
              escalationId,
            });
          } catch (submitErr) {
            await deps.client.escalateToHuman(
              escalationId,
              `implemented+pushed branch ${readyBranch} but merge-request submit failed: ${errMessage(submitErr)}`,
            );
            deps.logger.warn(
              { escalationId, projectId, branch: readyBranch, err: errMessage(submitErr) },
              "implement merge-request submit failed; escalated to human (branch preserved)",
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
            `Submitted merge request \`${mr.id}\` for branch \`${readyBranch}\`` +
            (commitSha ? ` (\`${commitSha}\`)` : "") +
            `, ${cfg.handoffLabel}.` +
            (diffSummary.length > 0 ? `\n\n${diffSummary}` : "");
          // addMessage leaves the escalation ACKNOWLEDGED (NOT answer/resolve). The
          // handoff metadata (pendingLand for A1; pendingArc for a phase) keys the
          // reclaim sweep's skip/route; the MR id augments the handoff.
          await deps.client.addMessage(escalationId, body, "diagnosis", {
            ...cfg.handoffMeta,
            mergeRequestId: mr.id,
            branch: readyBranch,
            commitSha: commitSha ?? null,
          });
          handedOff = true;
          deps.logger.info(
            { escalationId, projectId, branch: readyBranch, commitSha, mergeRequestId: mr.id },
            "implemented + pushed branch + submitted merge request; appended handoff (stays acknowledged)",
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
  return handedOff;
}

/**
 * The A1 bounded-fix implement session — runs on the `implement{bounded}` path. A thin
 * wrapper over `runImplementForBranch` with the bounded-fix shape: the
 * `pm/escalation-<id>` branch, a task-LESS submit (its land resolves the root via the
 * A2 post-back), no per-phase brief, and the `pendingLand` handoff marker. BYTE-IDENTICAL
 * to the pre-A3 behavior.
 */
async function runImplementSession(
  deps: ResponderDeps,
  state: ResponderState,
  projectId: string,
  escalationId: string,
  detail: EscalationWithThread,
): Promise<void> {
  await runImplementForBranch(deps, state, projectId, escalationId, detail, {
    branch: `pm/escalation-${escalationId}`,
    submitTaskId: null,
    brief: undefined,
    handoffMeta: { pendingLand: true },
    handoffLabel: "pending land (A2)",
  });
}

/**
 * The vision-producing drive session (A3 P1) — runs on the `implement{systemic}`
 * path when auto_implement is enabled and the injection sniff was clean. Acquires an
 * isolated worktree (the EXISTING implement slot pool), spawns the drive runner with
 * the /vision prompt, and on `vision_ready` CREATES the PM epic + the campaign tasks
 * OVER HTTP from the runner's result — then appends a `pendingDrive` handoff message,
 * LEAVING the escalation `acknowledged` (P2 runs the campaign phases). NO branch is
 * pre-created (the drive writes a file, never commits) and NO campaign runs here (P2).
 *
 * The LOOP does ALL PM write-back (createEpic/createTask over HTTP) — the drive
 * session itself has no PM-MCP access in the clone, so it only declares the breakdown.
 * give_up/error escalate to a human (mode=off ⇒ silent). PARTIAL-FAILURE is
 * load-bearing: if the epic is created but a task POST throws mid-loop, we escalate to
 * a human naming the orphan epic id + the failed campaign (so the partial epic+tasks
 * are findable) — the escalation ends up needs_human, NOT stranded acknowledged. All
 * PM/git I/O is non-fatal; the worktree is reset for reuse + the slot released in
 * `finally`.
 */
async function runDriveSession(
  deps: ResponderDeps,
  state: ResponderState,
  projectId: string,
  escalationId: string,
  detail: EscalationWithThread,
): Promise<void> {
  // Lease a worktree slot (the EXISTING implement pool, sized to maxConcurrent). None
  // free ⇒ escalate (rare; only at maxConcurrent>1 with every session in flight).
  const slot = leaseImplementSlot(deps, state);
  if (slot === null) {
    if (deps.mode === "off") return; // off is silent.
    try {
      await deps.client.escalateToHuman(
        escalationId,
        "no free worktree slot for the drive session (all busy); needs a human or a retry",
      );
    } catch (err) {
      deps.logger.error(
        { escalationId, projectId, err: errMessage(err) },
        "no-slot drive escalateToHuman failed; escalation stays acknowledged (reclaim recovers)",
      );
    }
    return;
  }

  const wt = slot.wt;

  // Prepare the worktree (clone-if-needed + reset to fresh main). A failure here is
  // non-fatal: escalate, release the slot, return. The runner never spawns. NO branch
  // pre-create (the drive writes a vision file, never commits).
  try {
    await wt.ensureExists();
    await wt.resetForAttempt();
  } catch (err) {
    slot.leased = false;
    if (deps.mode === "off") return; // off is silent.
    try {
      await deps.client.escalateToHuman(
        escalationId,
        `could not prepare a worktree for the drive session: ${errMessage(err)}`,
      );
    } catch (postErr) {
      deps.logger.error(
        { escalationId, projectId, err: errMessage(postErr) },
        "drive worktree-prep escalateToHuman failed; escalation stays acknowledged (reclaim recovers)",
      );
    }
    return;
  }

  try {
    const logsDir = deps.logsDir ?? tmpdir();
    const statusPath = path.join(logsDir, `${escalationId}.drive.status.json`);
    const logPath = path.join(logsDir, `${escalationId}.drive.log`);
    const prompt = buildDrivePrompt(detail, detail.messages);

    const result = await deps.driveRunner.run({
      escalation: detail,
      thread: detail.messages,
      worktreePath: wt.path,
      budget: deps.budget,
      command: deps.command,
      prompt,
      statusPath,
      logPath,
      signal: deps.signal,
    });

    // Outcome handling — every PM call wrapped so a transient failure never escapes
    // the job (the escalation stays acknowledged; reclaim recovers it).
    try {
      switch (result.kind) {
        case "vision_ready": {
          if (deps.mode === "off") {
            deps.logger.info(
              { escalationId, projectId, visionPath: result.visionPath, mode: deps.mode },
              "drive vision_ready (mode=off) — not creating epic/tasks; off is silent",
            );
            break;
          }

          // EARLY INTENT MARKER (A3 P3, daemon-restart survival). Write a
          // pendingDrive marker carrying NO epicId BEFORE createEpic. This closes
          // the one real duplicate-arc window: if the daemon dies AFTER createEpic
          // but BEFORE the terminal epicId-bearing marker, on restart the reclaim
          // probe finds this intent marker (hasPendingDriveMarker) and ROUTES to
          // advanceArc — where arcEpicId returns null (the intent marker carries no
          // epicId) → escalateToHuman recovers the rare orphan epic. No second
          // createEpic ever fires. The terminal marker below UPGRADES this one with
          // the epicId; on normal completion advanceArc reads that and drives as P2.
          // A failure here escalates (no epic yet — nothing to orphan).
          try {
            await deps.client.addMessage(
              escalationId,
              `Autonomous drive starting for escalation ${escalationId} — producing the ` +
                `vision arc (epic + campaign tasks). This is a pre-epic intent marker; if a ` +
                `restart finds it without an epic id, the arc has no recoverable epic and a ` +
                `human takes over.`,
              "diagnosis",
              { pendingDrive: true, visionPath: result.visionPath },
            );
          } catch (markerErr) {
            await deps.client.escalateToHuman(
              escalationId,
              `produced a vision (${result.visionPath}) but writing the pre-epic intent marker failed: ${errMessage(markerErr)}`,
            );
            deps.logger.warn(
              { escalationId, projectId, visionPath: result.visionPath, err: errMessage(markerErr) },
              "drive vision_ready but intent-marker addMessage failed; escalated to human (no epic created)",
            );
            break;
          }

          // Create the vision's PM epic over HTTP. A failure escalates (no epic
          // created — nothing to orphan) and does NOT addMessage.
          let epic: { id: string; name?: string };
          try {
            epic = await deps.client.createEpic(projectId, {
              name: result.epicName,
              description: `Auto-driven vision for escalation ${escalationId}`,
              priority: "high",
            });
          } catch (epicErr) {
            await deps.client.escalateToHuman(
              escalationId,
              `produced a vision (${result.visionPath}) but creating the PM epic failed: ${errMessage(epicErr)}`,
            );
            deps.logger.warn(
              { escalationId, projectId, visionPath: result.visionPath, err: errMessage(epicErr) },
              "drive vision_ready but createEpic failed; escalated to human",
            );
            break;
          }

          // Create the campaign tasks under the epic, one at a time. PARTIAL-FAILURE
          // (load-bearing): if a task POST throws mid-loop, escalate naming the epic
          // id + which campaign failed (the partial epic+tasks persist + are findable)
          // — the escalation ends up needs_human, NOT stranded acknowledged.
          for (let i = 0; i < result.campaigns.length; i++) {
            const c = result.campaigns[i];
            try {
              await deps.client.createTask(projectId, {
                title: c.title,
                description: c.description,
                epicId: epic.id,
                priority: c.priority,
              });
            } catch (taskErr) {
              await deps.client.escalateToHuman(
                escalationId,
                `produced a vision (${result.visionPath}) + created epic ${epic.id}, but creating campaign task ${i + 1}/${result.campaigns.length} ("${c.title}") failed: ${errMessage(taskErr)}. The epic + the tasks created so far persist; a human should finish the breakdown.`,
              );
              deps.logger.warn(
                { escalationId, projectId, epicId: epic.id, campaign: c.title, err: errMessage(taskErr) },
                "drive createTask failed mid-loop; escalated to human (epic preserved, partial tasks)",
              );
              return; // do NOT fall through to the pendingDrive handoff.
            }
          }

          // addMessage leaves the escalation ACKNOWLEDGED (NOT answer/resolve — P2
          // runs the campaign). pendingDrive:true keeps the reclaim re-spawn skip
          // byte-identical (hasPendingDriveMarker checks only that flag).
          const body =
            `Produced a vision \`${result.visionPath}\` and created PM epic \`${epic.id}\` ` +
            `with ${result.campaigns.length} campaign task(s), pending campaign drive (P2).`;
          await deps.client.addMessage(escalationId, body, "diagnosis", {
            pendingDrive: true,
            visionPath: result.visionPath,
            epicId: epic.id,
          });
          deps.logger.info(
            { escalationId, projectId, visionPath: result.visionPath, epicId: epic.id, campaigns: result.campaigns.length },
            "drive produced a vision + created the epic + tasks; appended pending-drive handoff (stays acknowledged for P2)",
          );
          break;
        }
        case "give_up":
          if (deps.mode === "off") break; // off is silent.
          await deps.client.escalateToHuman(
            escalationId,
            `Responder could not produce a vision: ${result.reason}`,
          );
          deps.logger.info(
            { escalationId, projectId, reason: result.reason },
            "drive give_up; escalated to human",
          );
          break;
        case "error":
          if (deps.mode === "off") break; // off is silent.
          await deps.client.escalateToHuman(
            escalationId,
            `drive session failed (${result.reason}): ${result.detail ?? ""}`,
          );
          deps.logger.warn(
            { escalationId, projectId, reason: result.reason, detail: result.detail },
            "drive session failed; escalated to human",
          );
          break;
      }
    } catch (postErr) {
      deps.logger.error(
        { escalationId, projectId, kind: result.kind, err: errMessage(postErr) },
        "post-drive client call failed; escalation stays acknowledged (reclaim recovers)",
      );
    }
  } finally {
    // Clean the worktree for reuse (safe — the vision lives in the PM epic now) and
    // release the slot. A reset failure is non-fatal (the next lease re-resets).
    try {
      await wt.resetForAttempt();
    } catch (err) {
      deps.logger.warn(
        { escalationId, projectId, err: errMessage(err) },
        "post-drive worktree reset failed; will re-reset on next lease",
      );
    }
    slot.leased = false;
  }
}

/**
 * The tick-driven autonomous arc orchestrator (A3 P2 — the load-bearing addition).
 *
 * Runs once per reclaim cycle for a self-held `acknowledged` escalation carrying a
 * pendingDrive (A3 P1, the arc's first cycle) or pendingArc (A3 P2, a mid-arc cycle)
 * marker. It derives the arc's TRUE state STRICTLY FROM THE SERVER — never a
 * self-asserted sentinel — by reading:
 *   - the vision epic's campaign-tasks (`getEpic` → the phases), and
 *   - every phase's merge-request land status (`listMergeRequests` filtered by
 *     escalationId; each phase MR is matched to its campaign-task by `taskId`).
 *
 * Then it does EXACTLY ONE of (Model A, non-blocking — one phase per cycle):
 *   1. a phase MR still `queued`/`integrating` → RE-PARK (return; the train lands it
 *      out-of-band; next cycle re-checks). Never two phases in flight.
 *   2. a phase MR `rejected`/`abandoned`/`orphaned` → **arc_partial** (TERMINAL):
 *      escalateToHuman on the ROOT with the partial payload (landed shas preserved +
 *      the rejected/remaining phases named); stop. A rejected phase MR is TERMINAL —
 *      never re-submitted, never a second live MR for that task.
 *   3. every campaign-task has a `landed` MR → **arc_complete**: append an
 *      `arcComplete{epicId, landedShas[]}` marker. Do NOT resolve/answer (P4's job) —
 *      leave it acknowledged + marked.
 *   4. else (prior phase landed, more remain) → IMPLEMENT the next campaign-task with
 *      no MR yet (reuse `runImplementForBranch`): branch `pm/escalation-<id>-<taskId>`,
 *      a phase-scoped brief (campaign-task title+description + vision path), a
 *      task-LINKED escalationId MR (Directive 1 gates its land post-back so it does
 *      NOT resolve the root), and a `pendingArc` handoff. Reserves the spawn budget
 *      (canSpawn/recordSpawn) but NEVER `state.reclaimAttempts` (Directive 2).
 *
 * All PM/git I/O is non-fatal (a throw is logged + retried next cycle; the escalation
 * stays acknowledged + marked, so it re-qualifies). The epic id comes off the marker
 * (`arcEpicId`); a missing epic id escalates the root (the arc is unrecoverable).
 */
async function advanceArc(
  deps: ResponderDeps,
  state: ResponderState,
  projectId: string,
  escalationId: string,
  detail: EscalationWithThread,
  now: number,
): Promise<void> {
  const epicId = arcEpicId(detail.messages);
  if (epicId === null) {
    if (deps.mode === "off") return; // off is silent.
    await deps.client.escalateToHuman(
      escalationId,
      "autonomous arc has no recoverable epic id on its handoff marker; needs a human",
    );
    return;
  }

  // Derive arc state STRICTLY from the server: the epic's campaign-tasks + each
  // phase's MR land status (matched by taskId).
  const epic: ArcEpic = await deps.client.getEpic(projectId, epicId);
  const phaseMrs: ArcMergeRequest[] = await deps.client.listMergeRequests(projectId, {
    escalationId,
  });
  // Index the phase MRs by taskId (the A3 phase MRs are task-LINKED). The A1 task-LESS
  // bounded MR (taskId null), if any, is irrelevant to the arc phases and ignored here.
  const mrByTask = new Map<string, ArcMergeRequest>();
  for (const mr of phaseMrs) {
    if (mr.taskId !== null) mrByTask.set(mr.taskId, mr);
  }

  const inFlightStatuses = new Set(["queued", "integrating"]);
  const failedStatuses = new Set(["rejected", "abandoned", "orphaned"]);

  // ── (1) any phase still in flight → re-park (one phase per cycle). ──
  for (const task of epic.tasks) {
    const mr = mrByTask.get(task.id);
    if (mr !== undefined && inFlightStatuses.has(mr.status)) {
      deps.logger.info(
        { escalationId, projectId, epicId, taskId: task.id, mr: mr.id, status: mr.status },
        "arc re-park: a phase MR is still in flight; waiting for the train (next cycle re-checks)",
      );
      return;
    }
  }

  // ── (2) any phase MR terminally failed → arc_partial (terminal). ──
  const landedShas: string[] = [];
  for (const task of epic.tasks) {
    const mr = mrByTask.get(task.id);
    if (mr !== undefined && mr.status === "landed" && mr.landedSha !== null) {
      landedShas.push(mr.landedSha);
    }
  }
  for (const task of epic.tasks) {
    const mr = mrByTask.get(task.id);
    if (mr !== undefined && failedStatuses.has(mr.status)) {
      if (deps.mode === "off") return; // off is silent.
      const remaining = epic.tasks
        .filter((t) => {
          const m = mrByTask.get(t.id);
          return m === undefined || m.status !== "landed";
        })
        .map((t) => t.title);
      const reason =
        `Autonomous arc PARTIAL: phase "${task.title}" (MR ${mr.id}) ${mr.status}. ` +
        `Landed phases preserved (${landedShas.length}: ${landedShas.join(", ") || "none"}). ` +
        `Unlanded phases: ${remaining.join(", ") || "none"}. A human should take over the rest.`;
      await deps.client.escalateToHuman(escalationId, reason);
      deps.logger.warn(
        { escalationId, projectId, epicId, failedTask: task.title, status: mr.status, landedShas },
        "arc_partial: a phase MR terminally failed; escalated the root to needs_human (landed phases preserved)",
      );
      return;
    }
  }

  // ── (3) every campaign-task has a landed MR → arc_complete. ──
  const allLanded =
    epic.tasks.length > 0 &&
    epic.tasks.every((t) => {
      const mr = mrByTask.get(t.id);
      return mr !== undefined && mr.status === "landed";
    });
  if (allLanded) {
    if (deps.mode === "off") return; // off is silent.
    // Idempotent: if the arcComplete marker is already present, re-park (don't
    // re-append every cycle). The escalation stays acknowledged + arc-marked until
    // P4 resolves it.
    if (hasArcCompleteMarker(detail.messages)) {
      deps.logger.debug(
        { escalationId, projectId, epicId },
        "arc_complete already marked; re-park (awaiting P4 close)",
      );
      return;
    }
    const body =
      `Autonomous arc COMPLETE: all ${epic.tasks.length} phase(s) of epic \`${epicId}\` ` +
      `landed (${landedShas.join(", ")}). Awaiting close.`;
    // arcComplete marker — does NOT resolve/answer (P4 resolves the escalation). The
    // marker keeps the escalation acknowledged + arc-routed (a no-op re-park next cycle).
    await deps.client.addMessage(escalationId, body, "diagnosis", {
      pendingArc: true,
      arcComplete: true,
      epicId,
      landedShas,
    });
    deps.logger.info(
      { escalationId, projectId, epicId, landedShas },
      "arc_complete: all phases landed; appended arcComplete marker (P4 resolves)",
    );
    return;
  }

  // ── (4) prior phases landed, more remain → implement the next phase with no MR. ──
  const next = epic.tasks.find((t) => mrByTask.get(t.id) === undefined);
  if (next === undefined) {
    // Defensive: no in-flight, no failure, not all-landed, yet no task lacks an MR.
    // (Shouldn't happen — a task with an MR is landed/in-flight/failed, all handled
    // above.) Re-park; the next cycle re-derives.
    deps.logger.info(
      { escalationId, projectId, epicId },
      "arc: no next phase to implement and not complete; re-park",
    );
    return;
  }

  if (deps.mode === "off") return; // off is silent — no spawn.

  // Reserve the spawn budget (Directive 2: canSpawn/recordSpawn, NOT reclaimAttempts).
  if (!canSpawn(state, deps.spawnBudget, now)) {
    deps.logger.info(
      { escalationId, projectId, epicId, spawned: state.spawnTimestamps.length },
      "arc: spawn budget exhausted; deferring the next phase to a later cycle",
    );
    return;
  }
  recordSpawn(state, now);

  const visionPath = arcVisionPath(detail.messages);
  deps.logger.info(
    { escalationId, projectId, epicId, taskId: next.id, phase: next.title },
    "arc: implementing the next campaign phase",
  );
  await runImplementForBranch(deps, state, projectId, escalationId, detail, {
    branch: `pm/escalation-${escalationId}-${next.id}`,
    submitTaskId: next.id,
    brief: { title: next.title, description: next.description ?? "", visionPath },
    handoffMeta: { pendingArc: true, epicId, phaseTaskId: next.id },
    handoffLabel: "pending campaign phase land",
  });
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

      // REVISE FIX #3 (reclaim guard) + A3 P2 (arc route): probe the thread for a
      // handoff marker and either SKIP or ROUTE-TO-advanceArc:
      //   - pendingLand (A1 bounded fix) → SKIP: a landed-but-not-yet-merged implement
      //     handoff waiting on A2/the train, NOT a stranded read-only session.
      //   - pendingDrive (A3 P1) / pendingArc (A3 P2) → ROUTE to advanceArc: the
      //     tick-driven autonomous arc advance. advanceArc reads the arc's TRUE state
      //     from the server (the epic's campaign-tasks + each phase's MR land status)
      //     and does ONE of {re-park | arc_partial | arc_complete | implement next
      //     phase}. It NEVER touches state.reclaimAttempts (Directive 2: a >2-phase arc
      //     would otherwise poison-cap to needs_human mid-drive); it reserves its own
      //     spawn budget internally (canSpawn/recordSpawn) only when it implements.
      //   - both absent → fall through to the normal read-only reclaim path.
      // Re-spawning a read-only answering session on any of these would march the
      // poison cap. A fetch failure is non-fatal: fall through to the normal path.
      try {
        const thread = await deps.client.getEscalation(escalationId);
        const arc =
          hasPendingDriveMarker(thread.messages) || hasPendingArcMarker(thread.messages);
        if (arc) {
          // Route to advanceArc. Hold a concurrency slot + the in-flight marker while
          // it runs (it may spawn an implement session), but DO NOT touch
          // reclaimAttempts or the spawn budget here — advanceArc owns its own budget.
          slot.available -= 1;
          state.inFlight.add(escalationId);
          const arcJob = (async (): Promise<void> => {
            try {
              await advanceArc(deps, state, projectId, escalationId, thread, now);
            } catch (err) {
              deps.logger.warn(
                { escalationId, projectId, err: errMessage(err) },
                "advanceArc failed; will retry next cycle",
              );
            } finally {
              state.inFlight.delete(escalationId);
            }
          })();
          pending.push(arcJob);
          continue;
        }
        if (hasPendingLandMarker(thread.messages)) {
          deps.logger.debug(
            { escalationId, projectId },
            "reclaim skip: escalation has a pending-land handoff (awaiting A2/the train); not re-spawning",
          );
          continue;
        }
      } catch (err) {
        deps.logger.warn(
          { escalationId, projectId, err: errMessage(err) },
          "reclaim handoff-marker probe failed; proceeding with the normal reclaim path",
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
