import { MERGE_PHASES, type MergePhase, type PhaseTraceEntry } from "@pm/shared";
import { listForGroup, listForRequest } from "../services/merge-phase.service.js";

// ─── The Discord stopwatch line (campaign 2026-08-03 §P6) ─────────
//
// The train feed already says WHAT happened ("Group landed … 26m since pickup").
// This module says WHERE THOSE MINUTES WENT:
//
//   :white_check_mark: **Group landed** on `main` — "Fix grass drift" · … · 26m since pickup
//      :stopwatch: forming 4m · assemble 3m · verify 26m (build 20m + test 8m, concurrent) · land 8s
//
// It is ONE message with a newline, never a second POST: two POSTs can interleave
// with another lane's narration and would double the webhook rate limit budget.
//
// DESIGN LOCK 1 (telemetry is never load-bearing) is why every export here is
// total. `phaseLineForRequest`/`phaseLineForGroup` return "" — never throw, never
// null — so a call site reads `base + phaseLineForRequest(id)` with no
// conditional, and a formatter fault costs the operator a stopwatch line rather
// than the whole land narration. The guard MUST live here and not only in the
// listener's outer try/catch: that catch wraps formatTrainFeedEvent itself, so a
// throw inside it would discard `content` entirely and the land would go
// UNNARRATED.
//
// This is the ONLY merge-phase.service importer outside src/services, and
// tests/merge-phase-seal.test.ts pins that: the edge is read-only, guarded, and
// confined to this one formatter.

/**
 * A pre-computed, human-readable age. The merge-train clock-legibility rule
 * (deployment guide §14.14): NEVER hand a reader two timestamps to subtract —
 * state the elapsed time outright.
 *
 * Lives here rather than in train-feed-listener.ts because BOTH the base line
 * ("26m since pickup") and the stopwatch segment render durations, and the
 * import edge listener → phase-line is one-way.
 */
export function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

// ─── Budget + shape ───────────────────────────────────────────────

/**
 * A LEGIBILITY cap for the stopwatch segment, not a protocol one: Discord's
 * limit is 2000 and the base line already reaches ~450. Past ~240 chars the line
 * wraps into a paragraph and stops being scannable, which defeats the point.
 */
const PHASE_LINE_MAX = 240;
const MAX_PART_LABEL = 24;
const MAX_PARTS = 4;
/**
 * A phase must be worth a whole minute before its sub-steps earn characters —
 * this is also what kills `assemble 1s (reset 1s / bind 1s / assert 1s)`, where
 * every figure is humanDuration's ≥1s floor over sub-second work.
 */
const BREAKDOWN_MIN_MS = 60_000;
/** humanDuration's resolution floor — differences below it are not renderable. */
const FLOOR_MS = 1_000;

const SEP = " · ";
const PREFIX = "\n   :stopwatch: ";

/**
 * Display names. `queue_wait` shortens to `queue` (the word "wait" is implied by
 * a duration); `materialize` is deliberately NOT abbreviated — the roadmap names
 * LFS/submodule materialization the prime suspect for cross-repo wall clock, and
 * an operator scanning for it must find the word they were told to look for.
 */
const PHASE_NAMES: Record<MergePhase, string> = {
  forming: "forming",
  queue_wait: "queue",
  assemble: "assemble",
  materialize: "materialize",
  rebase: "rebase",
  verify: "verify",
  land: "land",
};

// ─── Intervals ────────────────────────────────────────────────────

interface Interval {
  start: number;
  end: number;
}

interface LabelledInterval extends Interval {
  /** The role-stripped sub-step name, or null for an unlabelled observation. */
  part: string | null;
}

/**
 * The duration of the UNION of a set of intervals (sort by start, sweep-merge,
 * sum the merged spans).
 *
 * WHY the union and not the sum: at `parallelism > 1`, and always for a
 * cross-repo group, phases of the same name run CONCURRENTLY. Summing them
 * prints `verify 52m` underneath a header that just said `26m since pickup` —
 * byte-for-byte the incoherence this campaign exists to remove. WHY not max:
 * staggered overlap (0→20m and 15→30m) is 30m of wall clock, and max reports 20.
 * The union degrades to exactly the sum when the work was sequential, so nothing
 * is lost on the single-repo lane, and it is the only figure that composes with
 * the "since pickup" header.
 */
function unionMs(intervals: Interval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let start = sorted[0]!.start;
  let end = sorted[0]!.end;
  for (const iv of sorted.slice(1)) {
    if (iv.start > end) {
      total += end - start;
      start = iv.start;
      end = iv.end;
    } else if (iv.end > end) {
      end = iv.end;
    }
  }
  return total + (end - start);
}

/**
 * The sub-step name a label contributes to, with a leading `inner:`/`outer:` repo
 * role STRIPPED — `inner:build` and `outer:build` collapse into one `build` part.
 *
 * This is a TRADE, not a free win: 2m inner + 18m outer prints `build 18m`, and
 * cross-repo diagnosis is exactly where that per-repo detail lives. What makes it
 * acceptable is the `, concurrent` marker — it tells the reader the parts
 * overlapped, so `build 18m` reads as "the build phase spanned 18 minutes of wall
 * clock", not "each repo built for 18 minutes". Keeping the roles apart would
 * double the part count on precisely the lane with the least room for them, and
 * the per-repo split is one click away on the train page (§P4) and in the trace.
 *
 * A bare `inner`/`outer` label has no colon and survives as its own part.
 */
function partKey(label: string | null): string | null {
  if (label === null) return null;
  const flat = label.trim();
  if (flat === "") return null;
  const stripped = /^(?:inner|outer):(.+)$/.exec(flat)?.[1]?.trim();
  return stripped !== undefined && stripped !== "" ? stripped : flat;
}

function elide(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ─── Phase rendering ──────────────────────────────────────────────

interface PhaseRender {
  phase: MergePhase;
  /** `verify 26m`, or `queue 12m (48m since submit)` for a re-anchored wait. */
  base: string;
  /** The union, and so the richness ranking for the character budget. */
  unionMs: number;
  /** ` (build 20m + test 8m, concurrent)`, or null when not a candidate. */
  breakdown: string | null;
}

/**
 * The parenthesised sub-step breakdown for one phase, or null when there is
 * nothing honest to say.
 *
 * The separator ENCODES THE TIMELINE, and is never mixed inside one phase:
 *   `a + b, concurrent` — the parts overlapped, so they do not add up to the
 *                         phase figure and the reader is told so outright,
 *   `a / b`             — the parts ran back-to-back and DO partition the phase.
 *
 * Coverage gate: with ≥2 labelled parts PLUS unlabelled observations, Σ(parts)
 * can fall SHORT of the phase union — and then `/` would claim a partition while
 * minutes sit unexplained. We drop the breakdown rather than render a residual
 * bucket: an operator who sees `verify 26m` and wants the split has the trace and
 * the train page, whereas `verify 26m (build 4m / test 3m)` actively misleads.
 */
function buildBreakdown(intervals: LabelledInterval[], phaseUnionMs: number): string | null {
  if (phaseUnionMs < BREAKDOWN_MIN_MS) return null;

  const byPart = new Map<string, Interval[]>();
  for (const iv of intervals) {
    if (iv.part === null) continue;
    const bucket = byPart.get(iv.part);
    if (bucket) bucket.push(iv);
    else byPart.set(iv.part, [iv]);
  }
  if (byPart.size < 2) return null;

  const parts = [...byPart].map(([label, ivs]) => ({
    label,
    union: unionMs(ivs),
    start: Math.min(...ivs.map((i) => i.start)),
  }));
  const sum = parts.reduce((acc, p) => acc + p.union, 0);
  if (sum < phaseUnionMs - FLOOR_MS) return null;
  const concurrent = sum - phaseUnionMs >= FLOOR_MS;

  // Earliest-start-first (the parts read as a timeline), ties by longer union,
  // then by label — a total order, so the same trace always renders the same way.
  parts.sort((a, b) => a.start - b.start || b.union - a.union || (a.label < b.label ? -1 : 1));
  const shown = parts.slice(0, MAX_PARTS);
  const more = parts.length - shown.length;

  const body = shown
    .map((p) => `${elide(p.label, MAX_PART_LABEL)} ${humanDuration(p.union)}`)
    .join(concurrent ? " + " : " / ");
  return ` (${body}${more > 0 ? `, +${more} more` : ""}${concurrent ? ", concurrent" : ""})`;
}

/**
 * The derived (PM-computed) wait, rendered from its PRE-COMPUTED durations —
 * nothing is subtracted here (design lock 4).
 *
 * `basis: "requeued"` means a prior integration ended inside the window, so the
 * entry was re-anchored: `queue 12m (48m since submit)` charges this trip 12
 * minutes while still telling the operator the work has been in the system for
 * 48. `basis: "exact"` prints no parenthetical — there is no second number.
 *
 * CAVEAT on `forming`, stated because the line does not say it: forming and a
 * member's queue_wait cover the same interval for the atomic / inner-only /
 * outer-only submit arms (group and members are written at one `now`), but NOT
 * for the back-compat BIND arm (`memberRequestIds`, live via
 * pm_request_merge_group), which binds pre-existing requests — there
 * `group.createdAt` can be much later than a member's `enqueuedAt`, and
 * `forming 4m` understates a 35m wait. The group line reports the group's own
 * clock; per-member waits live in the per-request trace. No behaviour change here.
 */
function renderDerived(name: string, entry: Extract<PhaseTraceEntry, { derived: true }>): string {
  const base = `${name} ${humanDuration(entry.durationMs)}`;
  if (entry.basis !== "requeued") return base;
  const since = entry.phase === "forming" ? "since created" : "since submit";
  return `${base} (${humanDuration(entry.originDurationMs)} ${since})`;
}

// ─── The formatter ────────────────────────────────────────────────

/**
 * Format a phase trace as the stopwatch segment, or null when there is nothing
 * honest to say (no usable entries). Pure and TOTAL — no DB, no clock, no throw.
 *
 * Exported for tests.
 */
export function formatPhaseLine(entries: PhaseTraceEntry[]): string | null {
  // ── Scope to THIS trip ──────────────────────────────────────────
  //
  // listForRequest/listForGroup return EVERY row ever attributed to that id —
  // the table is append-only and has no attempt filter. The union defeats
  // OVERLAPPING intervals, but rows from a PRIOR ATTEMPT (before a requeue:
  // post-verify drift, push race, speculative-suffix invalidation — routine at
  // parallelism > 1) are DISJOINT in time, so the union would degrade to a sum
  // and print `verify 78m` under a `26m since pickup` header. It would also make
  // the line internally inconsistent, since the derived entry IS re-anchored:
  // `queue 12m (48m since submit)` would describe this trip while `verify 78m`
  // described all of them.
  //
  // The cut is free: the derived entry's startedAt + durationMs IS the pickup
  // instant that ended the wait, already in the list. Strict (no skew grace) —
  // PM stamps the pickup and the daemon stamps the phases; on the single-machine
  // deployment that is one clock, and the failure mode of being strict is an
  // ABSENT phase, which the format already treats as honest.
  const derivedEntries = entries.filter(
    (e): e is Extract<PhaseTraceEntry, { derived: true }> => e.derived,
  );
  let tripStart: number | null = null;
  for (const entry of derivedEntries) {
    const pickup = Date.parse(entry.startedAt) + entry.durationMs;
    if (!Number.isFinite(pickup)) continue;
    if (tripStart === null || pickup > tripStart) tripStart = pickup;
  }

  const buckets = new Map<MergePhase, LabelledInterval[]>();
  for (const entry of entries) {
    if (entry.derived) continue;
    const start = Date.parse(entry.startedAt);
    // An unparseable instant has no place on a timeline; if that empties a
    // phase, the phase is simply absent.
    if (!Number.isFinite(start)) continue;
    if (tripStart !== null && start < tripStart) continue;
    const iv: LabelledInterval = {
      start,
      end: start + entry.durationMs,
      part: partKey(entry.label),
    };
    const bucket = buckets.get(entry.phase);
    if (bucket) bucket.push(iv);
    else buckets.set(entry.phase, [iv]);
  }

  // NOTHING OBSERVED, nothing to say. A derived wait alone (`queue 14m`) does not
  // answer the question this line exists to answer — where the INTEGRATION time
  // went — and the base line already carries the trip's headline duration. So a
  // deployment whose daemon does not yet report phases (§P2) narrates exactly as
  // it did before, instead of growing a second line that says only "it queued".
  if (buckets.size === 0) return null;

  const derivedByPhase = new Map<MergePhase, Extract<PhaseTraceEntry, { derived: true }>>();
  for (const entry of derivedEntries) {
    if (!derivedByPhase.has(entry.phase)) derivedByPhase.set(entry.phase, entry);
  }

  // ── Render, in PIPELINE order ───────────────────────────────────
  //
  // The order is a property of construction — iterate MERGE_PHASES and skip the
  // empty buckets. Never a sort, and never arrival order: MERGE_PHASES IS the
  // render-order contract (constants/enums.ts), shared with the stacked bar.
  const rendered: PhaseRender[] = [];
  for (const phase of MERGE_PHASES) {
    const derived = derivedByPhase.get(phase);
    if (derived) {
      rendered.push({
        phase,
        base: renderDerived(PHASE_NAMES[phase], derived),
        // Not a breakdown candidate: a derived phase is one interval PM computed,
        // and it must never lose its parenthetical to the budget.
        unionMs: -1,
        breakdown: null,
      });
      continue;
    }
    const intervals = buckets.get(phase);
    if (intervals === undefined || intervals.length === 0) continue;
    // A phase PRESENT with a zero-duration row still prints: absent ≠ zero.
    const union = unionMs(intervals);
    rendered.push({
      phase,
      base: `${PHASE_NAMES[phase]} ${humanDuration(union)}`,
      unionMs: union,
      breakdown: buildBreakdown(intervals, union),
    });
  }
  if (rendered.length === 0) return null;

  // ── Spend the character budget ──────────────────────────────────
  //
  // Pass 1 is every present phase with its figure — worst case seven phases
  // ≈100 chars, so it always fits. Pass 2 spends what is left on breakdowns,
  // RICHEST PHASE FIRST (where the time actually went), each added only if it
  // fits whole — a half-rendered breakdown would misstate the split.
  let used =
    rendered.reduce((acc, r) => acc + r.base.length, 0) + SEP.length * (rendered.length - 1);
  const chosen = new Set<MergePhase>();
  for (const candidate of [...rendered]
    .filter((r) => r.breakdown !== null)
    .sort((a, b) => b.unionMs - a.unionMs)) {
    const cost = candidate.breakdown!.length;
    if (used + cost > PHASE_LINE_MAX) continue;
    chosen.add(candidate.phase);
    used += cost;
  }

  // Breakdowns render at their phase's pipeline position regardless of which one
  // won the budget. The final slice makes the cap TRUE rather than probable:
  // durationMs is clamped only to max(0, round(n)), so a skewed daemon clock can
  // mint an `${h}h` with arbitrarily many digits and blow pass 1's estimate.
  return rendered
    .map((r) => (chosen.has(r.phase) ? `${r.base}${r.breakdown!}` : r.base))
    .join(SEP)
    .slice(0, PHASE_LINE_MAX);
}

// ─── Guarded call sites ───────────────────────────────────────────

function guarded(kind: string, id: string, read: () => PhaseTraceEntry[]): string {
  try {
    const line = formatPhaseLine(read());
    // null → "", so a trace with nothing to say never leaves an orphan
    // stopwatch glyph dangling on its own line.
    return line === null ? "" : `${PREFIX}${line}`;
  } catch (err) {
    // A 404 is near-unreachable here (the listener runs synchronously
    // post-commit, in-process, on the very row that just changed). The real
    // exposures are drizzle JSON hydration of a corrupt `detail` blob and a
    // parse bug in this file — both of which must cost the stopwatch line and
    // nothing else.
    console.warn(`[train-feed] phase line failed for ${kind} ${id}: ${err}`);
    return "";
  }
}

/** The stopwatch segment for one request, or "" — never throws. */
export function phaseLineForRequest(requestId: string): string {
  return guarded("request", requestId, () => listForRequest(requestId));
}

/** The stopwatch segment for one group, or "" — never throws. */
export function phaseLineForGroup(groupId: string): string {
  return guarded("group", groupId, () => listForGroup(groupId));
}
