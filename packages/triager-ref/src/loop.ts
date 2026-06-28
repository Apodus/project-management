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
 *   4. run `decide()` per candidate under a global concurrency semaphore.
 *
 * In P2 `decide` is a pure-log STUB (`createStubDecide`) that MUTATES NOTHING —
 * no note edits, no triage-decision rows, no proposals/tasks. The `decide` seam
 * is a `DecideFn` injected into `TriagerDeps`; P3 replaces the stub with the
 * sniff + assessment brain, P4 wires decision execution. There are NO action
 * wrappers yet, so the proposal-gate invariant is structurally untouched.
 */
import type { Note, ResolvedNotesTriage } from "@pm/shared";
import { resolveNotesTriage } from "@pm/shared";
import type { Logger } from "./logger.js";
import type { SpawnBudget } from "./config.js";
import type { TriagerClient } from "./api-client.js";

/**
 * The outcome of assessing one note. In P2 the ONLY variant is the inert
 * `noop` — the stub records nothing and mutates nothing. P3 replaces this with
 * the real disposition union (promote/dismiss/needs_human/give_up).
 */
export type TriageDecision = { kind: "noop" };

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
 * The pure-log STUB decide (P2). Logs `would assess note <id>` with the mode +
 * project, and returns `{ kind: "noop" }`. Records NOTHING, mutates NOTHING.
 * Exercises the mode-threading (reads `resolved.mode`) even though it ignores it.
 */
export function createStubDecide(deps: { logger: Logger }): DecideFn {
  return async ({ note, projectId, resolved }) => {
    deps.logger.info(
      { noteId: note.id, projectId, mode: resolved.mode },
      `would assess note ${note.id} (mode=${resolved.mode}, project=${projectId})`,
    );
    return { kind: "noop" };
  };
}

/**
 * Per-process mutable triager state, threaded across ticks. Created once by
 * `runTriagerLoop` and passed into every `triagerTick`.
 */
export interface TriagerState {
  /** Notes with an assessment currently in flight (skip a second). */
  inFlight: Set<string>;
  /** Notes this process has already assessed (skip re-seed). */
  triaged: Set<string>;
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
    spawnTimestamps: [],
  };
}

export interface TriagerDeps {
  client: Pick<TriagerClient, "listOpenNotes" | "getProject">;
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
 * flight, and not already assessed this process. Sorted OLDEST-FIRST by
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
        !state.triaged.has(n.id),
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
          // P2: the stub mutates nothing. We deliberately do NOT add to
          // `state.triaged` — a noop re-seed next tick is harmless/idempotent
          // (P3 owns the triaged-bookkeeping once decisions are real).
          await deps.decide({ note, projectId, resolved });
        } catch (err) {
          deps.logger.warn(
            { noteId, projectId, err: errMessage(err) },
            "decide threw; skipping this note (will re-seed next tick)",
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
