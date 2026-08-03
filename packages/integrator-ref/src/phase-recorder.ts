/**
 * Phase-timing spans for the integrator (campaign 2026-08-03 §P2).
 *
 * The daemon is the only process inside the worktree, so it is the only thing
 * that can say where a merge's wall clock actually went. This module is how it
 * says so — and its shape exists to make design lock 1 ("telemetry is never
 * load-bearing") a property of the TYPES rather than a rule every call site has
 * to remember:
 *
 *  - `PhaseSpans` has no `flush`. Every instrumented module (batch's admit path,
 *    group-assembly, group-land) receives a `PhaseSpans` and therefore CANNOT
 *    ship a POST; only the pass owner, which holds the `PhaseRecorder`, decides
 *    when bytes leave the process. `scope()` returns a view over the SAME
 *    buffer, so a scoped row can never be orphaned in a buffer nobody flushes.
 *  - `flush()` returns `void`. Fire-and-forget stops being a convention a
 *    reviewer has to spot: `await recorder.flush()` does not type-check, so the
 *    lane lock structurally cannot wait on a POST to PM.
 *  - `time()` returns fn's value verbatim and rethrows fn's error with the SAME
 *    object identity, so wrapping an operation in a span is invisible to the
 *    operation. It does add ~1-2 microtask ticks, which can reorder interleaving
 *    between concurrently-verifying members; what it never adds is a suspension
 *    point between a pool acquire and its release, or inside a lock hold — the
 *    two places where the 2026-08-02 lane wedge (§14.15) lived.
 *
 * Values are normalized HERE, not merely trusted to be sane. The ingest route
 * clamps rather than rejects (merge-phase.service.ts), and counts each clamped
 * row in `adjusted` — which is this emitter's ONLY self-check. That signal is
 * worth nothing if we routinely send rows we know need fixing, so a healthy
 * daemon must read `adjusted: 0` forever and any non-zero is a real defect.
 *
 * SEAL: this file contains exactly ONE suspension point (the wrapped call in
 * `time`), pinned at the source by tests/phase-timing-seal.test.ts. The keyword
 * is deliberately absent from every comment here so that token count is a
 * statement about the code and nothing else.
 */
import type { MergeObservedPhase, MergePhaseEntryInput, MergePhaseIngestResult } from "@pm/shared";
import type { PmClient } from "./pm-client.js";

// The ingest route accepts at most 100 entries per POST and rejects an empty
// array (`.min(1).max(100)`), so both bounds are mirrored here rather than
// discovered as 400s in production.
const MAX_BATCH = 100;
/**
 * Outstanding POSTs allowed at once. A PM that stops answering (the exact
 * moment an operator most wants a running lane) costs bounded memory and
 * bounded sockets: past the cap a flush DROPS its rows instead of queueing
 * them. Telemetry is the thing that gets sacrificed, never the merge.
 */
const MAX_IN_FLIGHT = 4;
/** Mirrors merge-phase.service.ts LABEL_MAX — over it the server truncates + counts `adjusted`. */
const LABEL_MAX = 120;
/**
 * Half the server's 4 KB detail budget. Deliberately conservative: our JSON and
 * the server's can differ by key order and escaping, and a row dropped there
 * costs an `adjusted` we would then have to explain.
 */
const DETAIL_MAX_BYTES = 2048;
/** The ECMAScript time-value range; outside it `toISOString()` throws RangeError. */
const MAX_TIME_MS = 8.64e15;

// ─── Public shape ─────────────────────────────────────────────────

/**
 * A detail value. FLAT SCALARS ONLY — `detail` carries facts that must NOT
 * become group-by keys (P3 groups on `phase` + `label`), and a nested blob is
 * something no aggregate can read and no operator can scan.
 */
export type PhaseDetailValue = string | number | boolean | null | undefined;
export type PhaseDetail = Record<string, PhaseDetailValue>;

/** Ids + detail inherited by every span recorded through a scoped view. */
export interface PhaseScope {
  requestId?: string;
  groupId?: string;
  attemptId?: string;
  /** Merged UNDER each span's own detail — the span wins on a key clash. */
  detail?: PhaseDetail;
}

/**
 * One span. `phase` is the pipeline stage; `label` is the smallest measured unit
 * inside it (a verify step id, a repo role, a sub-step) and is NULL when the
 * phase IS the unit. `phase` is typed `MergeObservedPhase`, so emitting a
 * PM-derived `queue_wait`/`forming` — which would double-count the wait — is a
 * compile error rather than a 400 nobody reads.
 *
 * `detail` may be a thunk, which is evaluated AFTER `fn` settles and sees its
 * resolved value (or `undefined` when `fn` threw) — so a span can report what
 * the operation actually did without the call site restructuring itself around
 * the measurement.
 */
export interface PhaseSpanSpec<T = unknown> {
  phase: MergeObservedPhase;
  label?: string | null;
  requestId?: string;
  groupId?: string;
  attemptId?: string;
  detail?: PhaseDetail | ((value: T | undefined) => PhaseDetail | null | undefined);
}

/** A span whose clock was taken elsewhere (e.g. the verify pipeline's per-step wall time). */
export interface PhaseRecordInput {
  phase: MergeObservedPhase;
  label?: string | null;
  requestId?: string;
  groupId?: string;
  attemptId?: string;
  startedAtMs: number;
  durationMs: number;
  detail?: PhaseDetail | null;
}

/**
 * The instrumentation surface handed to every measured module. Note what is
 * ABSENT: there is no flush, so no instrumented module can decide to talk to PM.
 */
export interface PhaseSpans {
  /** Measure `fn`, record a span, return its value / rethrow its error unchanged. */
  time<T>(spec: PhaseSpanSpec<T>, fn: () => Promise<T>): Promise<T>;
  /** Record a span whose wall clock was measured by the caller. */
  record(entry: PhaseRecordInput): void;
  /** A view over the SAME buffer with inherited ids/detail. */
  scope(defaults: PhaseScope): PhaseSpans;
}

/** What the pass owner holds: spans PLUS the sole authority to ship them. */
export interface PhaseRecorder extends PhaseSpans {
  /**
   * Ship the buffered rows. Synchronous and `void` BY TYPE: there is no promise
   * to hold the lane lock open on, and nothing downstream can accidentally
   * serialize a merge behind a telemetry POST.
   */
  flush(): void;
}

/**
 * The logger shape this module needs. A pino `Logger` satisfies it; narrowing to
 * the one method keeps a test double from having to impersonate all of pino.
 */
interface PhaseLogger {
  warn(fields: object, msg: string): void;
}

export interface PhaseRecorderDeps {
  /**
   * The live PM client. Typed as the one method we call, and probed with a
   * `typeof` guard at the call site (precedent: `maybeOpenResolution`'s
   * `getMergeRequest` guard) so every pre-existing test fake — none of which
   * knows about phase timings — stays safe without being touched.
   */
  pmClient: Pick<PmClient, "postMergePhases">;
  projectId: string;
  resource: string;
  logger: PhaseLogger;
}

// ─── Normalization ────────────────────────────────────────────────

function normalizeLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  return label.length > LABEL_MAX ? label.slice(0, LABEL_MAX) : label;
}

function normalizeStartedAt(ms: number): string {
  // A caller cannot hand in a malformed timestamp string, because a caller
  // never hands in a string at all — the ISO instant is minted here from epoch
  // ms, and `startedAt` is the one field the route 400s on rather than clamps.
  const safe = Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME_MS ? ms : Date.now();
  return new Date(safe).toISOString();
}

function normalizeDuration(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
}

function normalizeDetail(detail: PhaseDetail | null | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  const flat: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(detail)) {
    // An absent fact is omitted, never encoded as a key whose value is missing.
    if (value === undefined) continue;
    if (typeof value === "number") {
      flat[key] = Number.isFinite(value) ? value : null;
      continue;
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      flat[key] = value;
      continue;
    }
    // Unreachable through the types — defensive against a dynamically built thunk.
  }
  if (Object.keys(flat).length === 0) return null;
  return JSON.stringify(flat).length > DETAIL_MAX_BYTES ? null : flat;
}

// ─── The recorder ─────────────────────────────────────────────────

export function createPhaseRecorder(deps: PhaseRecorderDeps): PhaseRecorder {
  const buffer: MergePhaseEntryInput[] = [];
  let inFlight = 0;
  let dropped = 0;
  let dropWarned = false;

  const warn = (fields: object, msg: string): void => {
    try {
      deps.logger.warn(fields, msg);
    } catch {
      // Even the complaint about telemetry is not allowed to reach a merge.
    }
  };

  /**
   * One warning per pass, not one per drop. Drops happen precisely when PM has
   * stopped answering, i.e. when a per-drop warning would itself become the
   * log flood — and the count is the whole message anyway.
   */
  const warnDroppedOnce = (): void => {
    if (dropWarned) return;
    dropWarned = true;
    warn(
      { dropped, maxInFlight: MAX_IN_FLIGHT, resource: deps.resource },
      "phase-timing rows dropped: PM is not draining the ingest (telemetry sacrificed; the lane is unaffected)",
    );
  };

  const send = (phases: MergePhaseEntryInput[]): void => {
    const client = deps.pmClient as Partial<Pick<PmClient, "postMergePhases">>;
    // A legacy/fake client without the method is not an error — it simply has
    // nowhere to put the rows.
    if (typeof client.postMergePhases !== "function") return;
    inFlight += 1;
    // The synchronous `try` is load-bearing: a client that throws BEFORE
    // returning a promise (a bad base URL, a stubbed method that raises) would
    // escape a bare `.catch` and reach the drain loop as an unhandled throw.
    try {
      void client
        .postMergePhases(deps.projectId, { resource: deps.resource, phases })
        .then((ack: MergePhaseIngestResult) => {
          if (ack && ack.adjusted > 0) {
            warn(
              { adjusted: ack.adjusted, recorded: ack.recorded, resource: deps.resource },
              "PM normalized phase-timing rows on ingest — THIS emitter is wrong (a healthy daemon reports adjusted: 0)",
            );
          }
        })
        .catch((err: unknown) => {
          warn(
            { err: err instanceof Error ? err.message : String(err) },
            "phase-timing POST failed (telemetry only; the merge is unaffected)",
          );
        })
        .finally(() => {
          inFlight -= 1;
        });
    } catch (err) {
      inFlight -= 1;
      warn(
        { err: err instanceof Error ? err.message : String(err) },
        "phase-timing POST threw synchronously (telemetry only; the merge is unaffected)",
      );
    }
  };

  const flush = (): void => {
    // An empty flush would POST `phases: []`, which the route's `.min(1)`
    // answers with a 400 — a self-inflicted error line on every idle pass.
    if (buffer.length === 0) return;
    if (inFlight >= MAX_IN_FLIGHT) {
      dropped += buffer.length;
      buffer.length = 0;
      warnDroppedOnce();
      return;
    }
    // `push` flushes at MAX_BATCH, so the buffer never exceeds one POST's worth
    // and this splice always drains it.
    send(buffer.splice(0, MAX_BATCH));
  };

  const pushEntry = (entry: PhaseRecordInput): void => {
    try {
      const wire: MergePhaseEntryInput = {
        phase: entry.phase,
        startedAt: normalizeStartedAt(entry.startedAtMs),
        durationMs: normalizeDuration(entry.durationMs),
        label: normalizeLabel(entry.label),
        detail: normalizeDetail(entry.detail),
      };
      // The id fields are `.min(1).optional()` on the wire — a null would 400,
      // so an unknown id is OMITTED rather than sent empty.
      if (entry.requestId) wire.requestId = entry.requestId;
      if (entry.groupId) wire.groupId = entry.groupId;
      if (entry.attemptId) wire.attemptId = entry.attemptId;
      buffer.push(wire);
      if (buffer.length >= MAX_BATCH) flush();
    } catch (err) {
      warn(
        { err: err instanceof Error ? err.message : String(err) },
        "phase-timing row dropped (recording must never fail the operation it measures)",
      );
    }
  };

  /** Resolve a spec's detail. TOTAL: a thunk that throws yields `null`, never a lost span. */
  const resolveDetail = <T>(spec: PhaseSpanSpec<T>, value: T | undefined): PhaseDetail | null => {
    try {
      if (typeof spec.detail === "function") return spec.detail(value) ?? null;
      return spec.detail ?? null;
    } catch {
      return null;
    }
  };

  const mergeScopes = (base: PhaseScope, more: PhaseScope): PhaseScope => ({
    requestId: more.requestId ?? base.requestId,
    groupId: more.groupId ?? base.groupId,
    attemptId: more.attemptId ?? base.attemptId,
    detail: { ...base.detail, ...more.detail },
  });

  const viewFor = (scope: PhaseScope): PhaseSpans => {
    const record = (entry: PhaseRecordInput): void => {
      pushEntry({
        ...entry,
        requestId: entry.requestId ?? scope.requestId,
        groupId: entry.groupId ?? scope.groupId,
        attemptId: entry.attemptId ?? scope.attemptId,
        detail: { ...scope.detail, ...entry.detail },
      });
    };

    async function time<T>(spec: PhaseSpanSpec<T>, fn: () => Promise<T>): Promise<T> {
      const startedAtMs = Date.now();
      let value: T | undefined;
      try {
        value = await fn();
        return value;
      } finally {
        // `pushEntry` and `resolveDetail` are both total, so this cannot alter
        // what `fn` returned or threw. The row is recorded on the THROW path
        // too: the wall clock was spent regardless of the verdict, and a
        // conflict-rejected member's rebase time is exactly what P3 is for.
        record({
          phase: spec.phase,
          label: spec.label ?? null,
          requestId: spec.requestId,
          groupId: spec.groupId,
          attemptId: spec.attemptId,
          startedAtMs,
          durationMs: Date.now() - startedAtMs,
          detail: resolveDetail(spec, value),
        });
      }
    }

    return { time, record, scope: (more) => viewFor(mergeScopes(scope, more)) };
  };

  const root = viewFor({});
  return { time: root.time, record: root.record, scope: root.scope, flush };
}

// ─── No-op ────────────────────────────────────────────────────────

/**
 * The inert recorder. Used as the coalesce target for the OPTIONAL `phases`
 * dependency (`const phases = deps.phases ?? NOOP_PHASE_SPANS`), which makes the
 * local non-nullable — and that is the point: `phases?.time(spec, fn)` would
 * short-circuit the WHOLE call expression and silently skip `fn`, deleting the
 * rebase it was meant to measure. Optional chaining on a span is a bug class,
 * so the code is shaped so it never appears (sealed by phase-timing-seal).
 *
 * `time` here calls `fn` directly — not even a microtask tick — so an
 * un-instrumented caller keeps its exact pre-campaign scheduling.
 */
const NOOP: PhaseRecorder = {
  time: <T>(_spec: PhaseSpanSpec<T>, fn: () => Promise<T>): Promise<T> => fn(),
  record: () => {},
  scope: () => NOOP,
  flush: () => {},
};

export const NOOP_PHASE_SPANS: PhaseSpans = NOOP;

export function createNoopPhaseRecorder(): PhaseRecorder {
  // Stateless, hence shared: there is nothing per-instance to keep apart.
  return NOOP;
}
