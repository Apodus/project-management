import type { EpicGraphNode } from "./api";

/**
 * Pure recency helpers for the epic timeline-DAG view.
 *
 * Two levers, both `now`-injected (no clock, no randomness — the page passes a
 * real ISO string, the tests pass a fixed `NOW`):
 *
 * (a) `partitionEpics` splits nodes three ways — `active` vs `past` vs
 *     `unscheduled` — by a fixed priority (mutually exclusive, input order
 *     preserved within each bucket):
 *       1. `past`: BOTH `done` AND no activity for longer than the threshold.
 *          Anything still in flight stays out of `past` no matter how stale, so
 *          live work is never hidden. Unparseable recency (NaN) and
 *          exactly-at-threshold both fall through (boundary is strict `<`).
 *       2. `unscheduled`: `not_started` AND no target end (`time_window.end ==
 *          null`) — future work with no committed window, parked behind a
 *          collapsible Backlog rail by default.
 *       3. `active`: everything else (the live timeline).
 *     The order matters: a `done` epic is never `unscheduled`, and a
 *     `not_started`+no-target epic is `unscheduled`, not `active`.
 *
 * (b) `recedeOpacity` maps an epic's age to a fade in `[minOpacity, 1]`: fresh
 *     work is full opacity, work older than the window floors at `minOpacity`,
 *     and the in-between fades linearly. Future-dated or unparseable recency →
 *     full opacity (we never over-fade on bad data).
 *
 * Determinism: same input → same output; no `Date.now()`, no `Math.random()`.
 */

export const PAST_THRESHOLD_MS = 45 * 86_400_000; // 45 days

export interface PartitionResult<T> {
  active: T[];
  past: T[];
  unscheduled: T[];
}

export function partitionEpics<
  T extends Pick<EpicGraphNode, "health" | "activity_recency" | "time_window">,
>(nodes: T[], opts: { now: string; pastThresholdMs?: number }): PartitionResult<T> {
  const pastThresholdMs = opts.pastThresholdMs ?? PAST_THRESHOLD_MS;
  const nowMs = Date.parse(opts.now);
  const active: T[] = [];
  const past: T[] = [];
  const unscheduled: T[] = [];

  // A NaN `now` makes the cutoff NaN, so the `<` comparison is always false and
  // every node falls through `past` — a safe degenerate (never hide on bad input).
  const cutoff = nowMs - pastThresholdMs;

  for (const node of nodes) {
    const recencyMs = Date.parse(node.activity_recency);
    if (node.health === "done" && recencyMs < cutoff) {
      past.push(node);
    } else if (node.health === "not_started" && node.time_window.end == null) {
      unscheduled.push(node);
    } else {
      active.push(node);
    }
  }

  return { active, past, unscheduled };
}

export function recedeOpacity(
  activityRecency: string,
  opts: { now: string; fullOpacityMs?: number; minOpacity?: number },
): number {
  const fullOpacityMs = opts.fullOpacityMs ?? PAST_THRESHOLD_MS;
  const minOpacity = opts.minOpacity ?? 0.4;

  const nowMs = Date.parse(opts.now);
  const recencyMs = Date.parse(activityRecency);
  if (Number.isNaN(nowMs) || Number.isNaN(recencyMs)) return 1;

  const age = nowMs - recencyMs;
  if (age <= 0) return 1; // future / present → full opacity
  if (age >= fullOpacityMs) return minOpacity; // beyond the window → floored

  return 1 - (age / fullOpacityMs) * (1 - minOpacity);
}
