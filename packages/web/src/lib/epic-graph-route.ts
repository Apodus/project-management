import type { BackEdge } from "./epic-graph-rank";

/**
 * Pure, deterministic long-span edge ROUTING for the structure-mode roadmap
 * (C1.P2). A `blocks` dependency whose prerequisite and dependent sit MORE than
 * one rank apart would, drawn as a straight bezier between handles, slice
 * through the intermediate rank's nodes. This module pre-computes a polyline
 * that threads such an edge through the vertical GAPS between ranks instead.
 *
 * CENTER-Y THROUGHOUT (correction 1). ReactFlow attaches an edge at its handle,
 * which is vertically CENTERED on the node. So every interior waypoint and the
 * per-rank clearance band MUST live in center-y to line up with the endpoints
 * RF supplies. `positions.y` is the node's TOP-LEFT flow y; the center is
 * `positions.y + nodeHeight/2`. `nodeHeight` is a DELIBERATE design constant
 * (correction 2: STRUCTURE_NODE_HEIGHT = 56, an assumption over the unmeasured
 * DOM height) — the band margin absorbs the measured-vs-assumed residual.
 *
 * Determinism: NO Date.now / Math.random. min/max are order-independent;
 * `forwardEdges` arrives already sorted by (from, to); the output Map is built
 * in that order. Identical input (in any array/insertion order) → identical Map.
 */

export interface RoutePoint {
  x: number;
  y: number;
}

export interface RouteOptions {
  /** Left margin (rank 0's x). Matches STRUCTURE_X_PAD. */
  xPad: number;
  /** Horizontal gap between adjacent ranks. Matches STRUCTURE_X_GAP. */
  xGap: number;
  /** Deliberate design node height (center-y derivation + band thickness). */
  nodeHeight: number;
  /** Extra clearance above/below a rank's node band, in px. */
  bandMargin: number;
}

/**
 * For each `blocks` forward edge spanning > 1 rank, a polyline (in flow space,
 * center-y) that threads the edge through the inter-rank gaps so it clears the
 * intermediate ranks' node bands. Keyed `${from}->${to}`. Short (dist-1) edges
 * and edges touching an absent node are omitted; an all-short graph → empty Map.
 *
 * The first and last points are the source/target CENTER anchors; the canvas's
 * routed-edge component drops them and uses RF's real sourceX/Y + targetX/Y,
 * threading only the interior waypoints.
 */
export function computeLongEdgeRoutes(
  positions: Map<string, { x: number; y: number }>,
  forwardEdges: BackEdge[],
  opts: RouteOptions,
): Map<string, RoutePoint[]> {
  const { xPad, xGap, nodeHeight, bandMargin } = opts;
  const routes = new Map<string, RoutePoint[]>();

  const rankOf = (x: number): number => Math.round((x - xPad) / xGap);
  const centerY = (p: { y: number }): number => p.y + nodeHeight / 2;

  // Per-rank clearance band (center-y). Only ranks that HAVE nodes get a band;
  // min/max are seeded lazily so order doesn't matter.
  const bandTop = new Map<number, number>();
  const bandBottom = new Map<number, number>();
  for (const p of positions.values()) {
    const r = rankOf(p.x);
    const cy = centerY(p);
    const top = cy - nodeHeight / 2 - bandMargin;
    const bottom = cy + nodeHeight / 2 + bandMargin;
    const curTop = bandTop.get(r);
    const curBottom = bandBottom.get(r);
    if (curTop === undefined || top < curTop) bandTop.set(r, top);
    if (curBottom === undefined || bottom > curBottom) bandBottom.set(r, bottom);
  }

  for (const e of forwardEdges) {
    const from = positions.get(e.from);
    const to = positions.get(e.to);
    if (!from || !to) continue; // defensive: absent endpoint → skip (correction 4)
    const rf = rankOf(from.x);
    const rt = rankOf(to.x);
    if (rt - rf <= 1) continue; // short edge → straight bezier, no route

    const yFrom = centerY(from);
    const yTo = centerY(to);
    const span = rt - rf;
    const points: RoutePoint[] = [{ x: from.x, y: yFrom }];

    for (let r = rf + 1; r <= rt - 1; r++) {
      const xR = xPad + r * xGap;
      const t = (r - rf) / span;
      const yI = yFrom + t * (yTo - yFrom);
      const top = bandTop.get(r);
      const bottom = bandBottom.get(r);
      let y: number;
      if (top !== undefined && bottom !== undefined && yI >= top && yI <= bottom) {
        // The straight center-line cuts this rank's band → divert to the nearer
        // side, one px clear of the band edge.
        const distAbove = yI - top;
        const distBelow = bottom - yI;
        y = distAbove <= distBelow ? top - 1 : bottom + 1;
      } else {
        y = yI; // no band on this rank, or already clear
      }
      points.push({ x: xR, y });
    }

    points.push({ x: to.x, y: yTo });
    routes.set(`${e.from}->${e.to}`, points);
  }

  return routes;
}
