import type { EpicGraphEdge, EpicGraphNode } from "./api";
import { computeRanks } from "./epic-graph-rank";
import { computeOrder } from "./epic-graph-order";
import { assignCoordinates } from "./epic-graph-coords";

/**
 * Pure, deterministic layout engine for the epic timeline-DAG view.
 *
 * x is owned by TIME: each node is placed by a representative timestamp drawn
 * from its `time_window` (end, falling back to start), mapped through a linear
 * monotonic scale whose domain spans every node time plus `now`. y is owned by
 * a greedy interval-coloring lane assignment that guarantees no two nodes
 * overlap horizontally within a lane.
 *
 * Dependency-aware lane biasing / crossing-minimization is DELIBERATELY
 * deferred: greedy interval coloring is the correct, concise core. Time wins on
 * x; dependency order is carried by edge direction (prerequisite -> dependent)
 * and is highlighted downstream (P4 chain-highlight) rather than baked into the
 * lane geometry here. `lane`, `laneCount`, and `backwardsEdges` are exposed so
 * P4 can route/highlight edges without recomputing.
 *
 * Determinism is a correctness requirement: NO Date.now / Math.random / new
 * Date inside this module. The only clock input is the injected `opts.now`
 * string. All ordering is via explicit comparators with id / (from,to)
 * tie-breaks, and the `positions` Map is populated in stable sorted order.
 *
 * Mode seam: `computeEpicGraphLayout` dispatches on `opts.mode` over a
 * discriminated `LayoutResult` (structure default; timeline opt-in).
 */

const ONE_DAY_MS = 86_400_000;

const STRUCTURE_X_GAP = 320; // px between adjacent ranks (node is 200px wide → 120px edge channel)
const STRUCTURE_ROW_HEIGHT = 104; // px between adjacent orders within a layer
const STRUCTURE_X_PAD = 80; // left margin

export interface LayoutOptions {
  /**
   * Layout mode. Defaults to "structure" (the topological DAG); pass
   * "timeline" to opt into the calendar-scaled view.
   */
  mode?: LayoutMode;
  now: string;
  width?: number;
  xPad?: number;
  nodeWidth?: number;
  laneHeight?: number;
  minSpanMs?: number;
  /**
   * Ids of UNSCHEDULED epics (not_started + no target end). When present and
   * non-empty, these are pulled OUT of the time-driven timeline and laid out as
   * a stacked block in a reserved FUTURE zone on the right; the timeline scale
   * is derived from the scheduled nodes only. Absent/empty → byte-identical to
   * the pre-backlog layout (every node placed by time across the full width).
   */
  unscheduledIds?: ReadonlySet<string>;
}

export type LayoutMode = "structure" | "timeline";

/** Geometry common to every mode. */
export interface BaseNodePosition {
  x: number;
  y: number;
  lane: number;
}

/** Timeline mode additionally carries the representative-time ms (`t`). */
export interface TimelineNodePosition extends BaseNodePosition {
  t: number;
}

/**
 * Back-compat alias: the timeline variant is the full historical shape.
 * Kept so existing imports of `NodePosition` keep resolving to the same fields.
 */
export type NodePosition = TimelineNodePosition;

export interface TimeScale {
  minMs: number;
  maxMs: number;
  nowMs: number;
  xPad: number;
  width: number;
  toX(ms: number): number;
}

export interface BackwardsEdge {
  from: string;
  to: string;
  fromX: number;
  toX: number;
}

interface BaseLayoutResult {
  positions: Map<string, BaseNodePosition>;
  laneCount: number;
  backwardsEdges: BackwardsEdge[];
}

/** Timeline mode: calendar scale + per-node `t` present. */
export interface TimelineLayoutResult extends BaseLayoutResult {
  mode: "timeline";
  positions: Map<string, TimelineNodePosition>;
  scale: TimeScale;
}

/** Structure mode: NO calendar scale, NO per-node `t`. Unpopulated until P4. */
export interface StructureLayoutResult extends BaseLayoutResult {
  mode: "structure";
  positions: Map<string, BaseNodePosition>;
}

export type LayoutResult = TimelineLayoutResult | StructureLayoutResult;

/**
 * Representative time for a node, in epoch ms.
 *
 * NaN-guard: `Date.parse` returns NaN for unparseable input. Prefer
 * `time_window.end`; if that is NaN fall back to `time_window.start`; if THAT
 * is NaN fall back to `nowMs`. NaN must never reach geometry.
 */
function representativeTime(node: EpicGraphNode, nowMs: number): number {
  const end = node.time_window.end;
  if (end != null) {
    const endMs = Date.parse(end);
    if (!Number.isNaN(endMs)) return endMs;
  }
  const startMs = Date.parse(node.time_window.start);
  if (!Number.isNaN(startMs)) return startMs;
  return nowMs;
}

function computeTimelineLayout(
  nodes: EpicGraphNode[],
  edges: EpicGraphEdge[],
  opts: LayoutOptions,
): TimelineLayoutResult {
  const width = opts.width ?? 1200;
  const xPad = opts.xPad ?? 80;
  const nodeWidth = opts.nodeWidth ?? 220;
  const laneHeight = opts.laneHeight ?? 90;
  const minSpanMs = opts.minSpanMs ?? ONE_DAY_MS;

  // nowMs is also NaN-guarded: an unparseable `now` collapses to 0 so geometry
  // stays finite (callers inject a real ISO string).
  const parsedNow = Date.parse(opts.now);
  const nowMs = Number.isNaN(parsedNow) ? 0 : parsedNow;

  // The future Backlog zone. When unscheduled epics are present, the timeline
  // gives up its rightmost slice to a reserved block where unscheduled epics
  // stack by created_at (NOT by representativeTime in the active region). Absent
  // / empty → the timeline owns the full width and the layout is byte-identical
  // to the pre-backlog engine.
  const unscheduledIds = opts.unscheduledIds;
  const hasBacklog = unscheduledIds != null && unscheduledIds.size > 0;

  // Partition into the time-driven timeline (`scheduled`) and the future block
  // (`unscheduled`). Without a backlog, ALL nodes are scheduled and the domain
  // seed below folds every node — exactly as before.
  const scheduled = hasBacklog ? nodes.filter((n) => !unscheduledIds.has(n.id)) : nodes;
  const unscheduled = hasBacklog ? nodes.filter((n) => unscheduledIds.has(n.id)) : [];

  // Geometry of the timeline vs the backlog zone. `timelineRight` is where the
  // time scale's right edge falls; with no backlog it is the full inner-right
  // edge (`width - xPad`), preserving the original `inner = width - 2*xPad`.
  const BACKLOG_FRACTION = 0.25;
  const GAP = 40;
  const inner = width - 2 * xPad;
  let timelineRight = width - xPad;
  let backlogLeft = width - xPad;
  let backlogWidth = 0;
  if (hasBacklog) {
    backlogWidth = inner * BACKLOG_FRACTION;
    backlogLeft = width - xPad - backlogWidth;
    timelineRight = backlogLeft - GAP;
    // Degenerate-width clamp: keep everything finite (no negative span / NaN).
    if (timelineRight <= xPad) {
      timelineRight = xPad;
      backlogLeft = xPad;
    }
  }

  // Step 1: representative time per scheduled node (the timeline domain).
  const nodeTime = new Map<string, number>();
  for (const node of scheduled) {
    nodeTime.set(node.id, representativeTime(node, nowMs));
  }

  // Step 2: time scale. Domain = scheduled node times union {nowMs}.
  // P5 seam: recency-collapse refines this domain later (older work recedes /
  // collapses into a Past rail); `t` is exposed per node so that refinement can
  // remap x without re-deriving each node's representative time.
  let minMs = nowMs;
  let maxMs = nowMs;
  for (const t of nodeTime.values()) {
    if (t < minMs) minMs = t;
    if (t > maxMs) maxMs = t;
  }
  const span = Math.max(maxMs - minMs, minSpanMs);
  maxMs = minMs + span;

  // The timeline maps onto [xPad, timelineRight] (== [xPad, width-xPad] with no
  // backlog → identical to `inner = width - 2*xPad`). `width` stays full width
  // on the scale so MilestoneGuides culls against the real canvas extent.
  const innerTimeline = timelineRight - xPad;
  const toX = (ms: number): number => xPad + ((ms - minMs) / span) * innerTimeline;

  const scale: TimeScale = { minMs, maxMs, nowMs, xPad, width, toX };

  // Steps 3-4: x per node, then greedy interval-coloring lane assignment.
  // Sort node ids by (x asc, id asc) — stable + total ordering.
  interface Placed {
    id: string;
    t: number;
    left: number;
    right: number;
  }

  const placed: Placed[] = scheduled.map((node) => {
    const t = nodeTime.get(node.id)!;
    const left = toX(t);
    return { id: node.id, t, left, right: left + nodeWidth };
  });

  // Unscheduled epics stack across the backlog zone, ordered by created_at
  // (NaN-guarded → nowMs) with an id tie-break. Rank r in [0, count-1] maps to
  // an even spread across [backlogLeft, backlogLeft + backlogWidth]; a single
  // node pins to backlogLeft. `t` carries the created_at ms for downstream use.
  if (unscheduled.length > 0) {
    const ranked = unscheduled.map((node) => {
      const parsed = Date.parse(node.created_at);
      const t = Number.isNaN(parsed) ? nowMs : parsed;
      return { id: node.id, t };
    });
    ranked.sort((a, b) => (a.t !== b.t ? a.t - b.t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const count = ranked.length;
    for (let r = 0; r < count; r++) {
      const { id, t } = ranked[r];
      const x = count > 1 ? backlogLeft + (r / (count - 1)) * backlogWidth : backlogLeft;
      placed.push({ id, t, left: x, right: x + nodeWidth });
    }
  }

  placed.sort((a, b) => (a.left !== b.left ? a.left - b.left : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const positions = new Map<string, NodePosition>();
  const lanes: number[] = []; // last-occupied right-edge per lane
  for (const p of placed) {
    let lane = -1;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] <= p.left) {
        // `<=` boundary: abutting nodes may share a lane.
        lane = i;
        break;
      }
    }
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(p.right);
    } else {
      lanes[lane] = p.right;
    }
    positions.set(p.id, { x: p.left, y: lane * laneHeight, lane, t: p.t });
  }
  const laneCount = lanes.length;

  // Step 5: backwards edges. Only `blocks` edges are evaluated; an edge whose
  // prerequisite sits strictly right of its dependent contradicts time.
  const backwardsEdges: BackwardsEdge[] = [];
  for (const edge of edges) {
    if (edge.dependency_type !== "blocks") continue;
    const fromPos = positions.get(edge.from);
    const toPos = positions.get(edge.to);
    if (!fromPos || !toPos) continue; // absent node -> skip, never crash
    if (fromPos.x > toPos.x) {
      backwardsEdges.push({ from: edge.from, to: edge.to, fromX: fromPos.x, toX: toPos.x });
    }
  }
  backwardsEdges.sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  );

  return { mode: "timeline", positions, scale, laneCount, backwardsEdges };
}

function computeStructureLayout(
  nodes: EpicGraphNode[],
  edges: EpicGraphEdge[],
): StructureLayoutResult {
  // Compose the pure P2 rank pass + P3 order pass; both are deterministic
  // (id-sorted, no clock), so structure layout inherits that.
  const rank = computeRanks(nodes, edges);
  const order = computeOrder(rank);

  // Coordinate pass. x = rank * gap (strictly increasing → prerequisite always
  // left of dependent; owned here). y is owned by the neighbor-aligned solver
  // (epic-graph-coords): dependents are pulled toward their prerequisites' y via
  // a balanced median sweep that preserves within-layer order and a >= rowHeight
  // gap — so edges stay short and same-rank nodes never overlap. lane === order.
  const yById = assignCoordinates(order.layers, rank.forwardEdges, {
    rowHeight: STRUCTURE_ROW_HEIGHT,
  });
  const positions = new Map<string, BaseNodePosition>();
  let laneCount = 0;
  for (let r = 0; r < order.layers.length; r++) {
    const layer = order.layers[r];
    if (layer.length > laneCount) laneCount = layer.length; // tallest layer; loop form avoids Math.max(...[]) = -Infinity on empty
    const x = STRUCTURE_X_PAD + r * STRUCTURE_X_GAP;
    for (let o = 0; o < layer.length; o++) {
      positions.set(layer[o], { x, y: yById.get(layer[o])!, lane: o });
    }
  }

  // Re-semanticized cycle back-edges: each points AGAINST rank, so fromX > toX
  // (the "backwards" signal the canvas/getEdgeStyling key on). Skip absent
  // endpoints defensively. Sort with the SAME comparator as timeline backwardsEdges.
  const backwardsEdges: BackwardsEdge[] = [];
  for (const be of rank.excludedBackEdges) {
    const fromPos = positions.get(be.from);
    const toPos = positions.get(be.to);
    if (!fromPos || !toPos) continue;
    backwardsEdges.push({ from: be.from, to: be.to, fromX: fromPos.x, toX: toPos.x });
  }
  backwardsEdges.sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  );

  return { mode: "structure", positions, laneCount, backwardsEdges };
}

export function computeEpicGraphLayout(
  nodes: EpicGraphNode[],
  edges: EpicGraphEdge[],
  opts: LayoutOptions & { mode?: "structure" },
): StructureLayoutResult;
export function computeEpicGraphLayout(
  nodes: EpicGraphNode[],
  edges: EpicGraphEdge[],
  opts: LayoutOptions & { mode: "timeline" },
): TimelineLayoutResult;
export function computeEpicGraphLayout(
  nodes: EpicGraphNode[],
  edges: EpicGraphEdge[],
  opts: LayoutOptions,
): LayoutResult;
export function computeEpicGraphLayout(
  nodes: EpicGraphNode[],
  edges: EpicGraphEdge[],
  opts: LayoutOptions,
): LayoutResult {
  const mode = opts.mode ?? "structure";
  if (mode === "structure") {
    return computeStructureLayout(nodes, edges);
  }
  return computeTimelineLayout(nodes, edges, opts);
}
