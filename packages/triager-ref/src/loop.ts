/**
 * The triager poll/seed loop (Campaign T2·P2 scaffold).
 *
 * The escalation responder's loop, retargeted at NOTES. Each tick, for every
 * watched project:
 *   1. read the project to compose EFFECTIVE notes-triage enablement/mode
 *      (`resolveNotesTriage(masterEnv, settings)`) — fail-safe OFF on any read
 *      error; skip a disabled project (the per-project gate);
 *   2. list the project's open notes;
 *   3. seed candidate notes (not self-authored, not the designated triage
 *      agent's, not in flight, not already triaged this process) OLDEST-FIRST;
 *   4. run `decide()` per candidate under a global concurrency semaphore, then
 *      EXECUTE the resulting assessment via `executeDecision` under the resolved
 *      rollout mode (P4):
 *        - off    ⇒ noop;
 *        - shadow ⇒ record-only, the note stays open (tracked in `shadowSeen` so
 *          it is not re-assessed every tick);
 *        - on     ⇒ perform the action (promote/dismiss/flag), record, backlink,
 *          and mark the note `triaged`.
 *
 * The proposal-gate is preserved: the ONLY task-minting path is implementProposal
 * on a fast_track proposal — there is no direct note→task wrapper.
 */
import type { Note, ResolvedNotesTriage } from "@pm/shared";
import { resolveNotesTriage } from "@pm/shared";
import type { Logger } from "./logger.js";
import type { SpawnBudget } from "./config.js";
import type { TriagerClient } from "./api-client.js";
import type { TriageAssessment } from "./decision.js";
import { executeDecision } from "./executor.js";

/**
 * The outcome of assessing one note (T2·P3). The real disposition is the
 * structured `TriageAssessment` (promote_standard/promote_fast_track/dismiss/
 * needs_human/give_up + rationale/confidence/optional breakdown) produced by
 * `createTriageDecide`. The loop still IGNORES this return in P3 — execution /
 * side-log recording / mode-gating is P4.
 */
export type TriageDecision = TriageAssessment;

/**
 * The injected assessment seam. Receives the note, its project, and the EFFECTIVE
 * resolved enablement/mode (so the mode is threaded even though P2's stub ignores
 * it). P3 swaps the stub for the real brain. MUST NOT mutate anything in P2.
 */
export type DecideFn = (ctx: {
  note: Note;
  projectId: string;
  resolved: ResolvedNotesTriage;
}) => Promise<TriageDecision>;

/**
 * The pure-log STUB decide (P2 legacy). Logs `would assess note <id>` with the
 * mode + project, and returns an inert `give_up` assessment. Records NOTHING,
 * mutates NOTHING. Kept past P3 because the non-destructiveness test still uses it
 * to assert the loop never records/acts; production now wires the real
 * `createTriageDecide` brain instead.
 */
export function createStubDecide(deps: { logger: Logger }): DecideFn {
  return async ({ note, projectId, resolved }) => {
    deps.logger.info(
      { noteId: note.id, projectId, mode: resolved.mode },
      `would assess note ${note.id} (mode=${resolved.mode}, project=${projectId})`,
    );
    return { kind: "give_up", rationale: "stub", confidence: 0 };
  };
}

/**
 * Per-process mutable triager state, threaded across ticks. Created once by
 * `runTriagerLoop` and passed into every `triagerTick`.
 */
export interface TriagerState {
  /** Notes with an assessment currently in flight (skip a second). */
  inFlight: Set<string>;
  /** Notes this process has already assessed under on-mode (skip re-seed). */
  triaged: Set<string>;
  /**
   * Notes assessed under SHADOW mode this process. Shadow leaves the note OPEN
   * (it only records a side-log row), so without this the note would re-seed +
   * re-assess every tick. IN-MEMORY — reset on restart (a restart re-assesses
   * shadow notes, which is harmless: another inert side-log row).
   */
  shadowSeen: Set<string>;
  /**
   * Projects we've already warned about an on-mode identity mismatch (daemon
   * identity ≠ project's notesTriage.triageAgentId). Warn-once per project.
   * IN-MEMORY — reset on restart.
   */
  warnedIdentityMismatch: Set<string>;
  /**
   * Sliding-window spawn timestamps (ms) for the spawn-rate budget. Carried now;
   * ENFORCED in P5. IN-MEMORY — reset on restart.
   */
  spawnTimestamps: number[];
}

export function createTriagerState(): TriagerState {
  return {
    inFlight: new Set(),
    triaged: new Set(),
    shadowSeen: new Set(),
    warnedIdentityMismatch: new Set(),
    spawnTimestamps: [],
  };
}

export interface TriagerDeps {
  client: Pick<
    TriagerClient,
    | "listOpenNotes"
    | "getProject"
    | "recordTriageDecision"
    | "promoteToProposal"
    | "dismissNote"
    | "flagNeedsHuman"
    | "claimProposal"
    | "implementProposal"
  >;
  logger: Logger;
  projectIds: string[];
  /** This triager's own user id (from /auth/me) — the no-self-triage seed. */
  selfId: string;
  /**
   * The env master `PM_NOTES_TRIAGE_ENABLED` VERBATIM. Composed per project per
   * tick with the project's DB toggle via `resolveNotesTriage(masterEnv, settings)`.
   */
  masterEnv: string | undefined;
  maxConcurrent: number;
  /** Sliding-window spawn-rate budget (shape only in P2; P5 enforces). */
  spawnBudget: SpawnBudget;
  /** The injected assessment seam (stub in P2; real brain in P3). */
  decide: DecideFn;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface RunTriagerLoopDeps extends TriagerDeps {
  /** Resolves when the poll tick elapses (or a wakeup arrives). */
  waitForWork: (pollMs: number) => Promise<void>;
  /** Should the loop keep running? Flipped by the SIGTERM/SIGINT handler. */
  shouldContinue: () => boolean;
}

export interface RunTriagerLoopOptions {
  pollIntervalMs?: number;
}

/**
 * Select the candidate notes to assess (PURE). A note is a candidate iff it is
 * open, NOT authored by this triager, NOT authored by the project's designated
 * triage agent (no self-triage of its own promotions/notes), not currently in
 * flight, not already assessed (on-mode `triaged`), and not already shadow-seen
 * this process (a shadow note stays open but must not re-assess every tick).
 * Sorted OLDEST-FIRST by
 * `createdAt` — the list endpoint returns newest-first, so the ascending sort is
 * required for the fair, oldest-waiting-first discipline.
 */
export function seedNotes(
  open: Note[],
  selfId: string,
  resolved: ResolvedNotesTriage,
  state: TriagerState,
): Note[] {
  return open
    .filter(
      (n) =>
        n.status === "open" &&
        n.authorId !== selfId &&
        (resolved.triageAgentId == null || n.authorId !== resolved.triageAgentId) &&
        !state.inFlight.has(n.id) &&
        !state.triaged.has(n.id) &&
        !state.shadowSeen.has(n.id),
    )
    .sort((a, b) => createdAtMs(a.createdAt) - createdAtMs(b.createdAt));
}

export async function triagerTick(deps: TriagerDeps, state: TriagerState): Promise<void> {
  // The concurrency budget is GLOBAL across all watched projects this tick.
  const slot = { available: Math.max(0, deps.maxConcurrent - state.inFlight.size) };

  const pending: Promise<void>[] = [];

  for (const projectId of deps.projectIds) {
    if (slot.available <= 0) break; // semaphore saturated — reappears next tick.

    // ── Effective enablement resolution. Read the project ONCE and compose
    // resolveNotesTriage(masterEnv, settings.notesTriage). FAIL-SAFE to OFF on
    // any getProject throw (a settings-read error must NEVER auto-triage). ──
    let resolved: ResolvedNotesTriage;
    try {
      const project = await deps.client.getProject(projectId);
      resolved = resolveNotesTriage(deps.masterEnv, project.settings);
    } catch (err) {
      deps.logger.warn(
        { projectId, err: errMessage(err) },
        "getProject failed; notes-triage resolves OFF for this project this tick (fail-safe)",
      );
      continue;
    }

    // GUARDRAIL 3 — the per-project gate. A disabled project does no work.
    if (!resolved.enabled) continue;

    // On-mode identity check (warn-once per project). The dismiss endpoint is
    // authz-gated to the note's author OR a human, so an on-mode triager whose
    // identity is NOT the project's notesTriage.triageAgentId will see dismiss
    // 403 → escalate to needs_human (executor's permanent-failure rule). Surface
    // the misconfiguration once so the operator can set triageAgentId.
    if (
      resolved.mode === "on" &&
      resolved.triageAgentId != null &&
      resolved.triageAgentId !== deps.selfId &&
      !state.warnedIdentityMismatch.has(projectId)
    ) {
      deps.logger.warn(
        { projectId, selfId: deps.selfId, triageAgentId: resolved.triageAgentId },
        `daemon identity ${deps.selfId} is not project ${projectId}'s notesTriage.triageAgentId ${resolved.triageAgentId}; on-mode dismiss will be escalated to needs_human`,
      );
      state.warnedIdentityMismatch.add(projectId);
    }

    let open: Note[];
    try {
      open = await deps.client.listOpenNotes(projectId);
    } catch (err) {
      deps.logger.warn(
        { projectId, err: errMessage(err) },
        "listOpenNotes failed; skipping this project for this tick",
      );
      continue;
    }

    const candidates = seedNotes(open, deps.selfId, resolved, state);

    for (const note of candidates) {
      if (slot.available <= 0) break; // semaphore saturated.
      const noteId = note.id;
      if (state.inFlight.has(noteId)) continue; // already assessing.

      // Admit. Claim a semaphore slot + the in-flight marker.
      slot.available -= 1;
      state.inFlight.add(noteId);

      const job = (async (): Promise<void> => {
        try {
          // Assess, then execute the assessment under the resolved mode (P4).
          const assessment = await deps.decide({ note, projectId, resolved });
          const outcome = await executeDecision(deps.client, {
            projectId,
            note,
            assessment,
            mode: resolved.mode,
            logger: deps.logger,
          });
          if (outcome.recorded) {
            // shadow leaves the note OPEN ⇒ track in shadowSeen so it is not
            // re-assessed every tick. on consumes the note out of the open lane
            // server-side; `triaged` is belt-and-suspenders for this process.
            if (resolved.mode === "shadow") state.shadowSeen.add(noteId);
            else state.triaged.add(noteId);
          }
        } catch (err) {
          // A transient throw (network / 5xx) is swallowed ⇒ the note is NOT
          // marked, so it re-seeds next tick for a retry.
          deps.logger.warn(
            { noteId, projectId, err: errMessage(err) },
            "assess/execute threw; skipping this note (will re-seed next tick)",
          );
        } finally {
          state.inFlight.delete(noteId);
        }
      })();
      pending.push(job);
    }
  }

  await Promise.all(pending);
}

export async function runTriagerLoop(
  deps: RunTriagerLoopDeps,
  opts: RunTriagerLoopOptions = {},
): Promise<void> {
  const pollMs = opts.pollIntervalMs ?? 15_000;
  const state = createTriagerState();

  while (deps.shouldContinue()) {
    try {
      await triagerTick(deps, state);
    } catch (err) {
      // Defense-in-depth: triagerTick is already per-project non-fatal, but a
      // bug in the tick body must never kill the loop.
      deps.logger.error({ err: errMessage(err) }, "triagerTick threw unexpectedly");
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
