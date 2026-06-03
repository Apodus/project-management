import { describe, expect, it } from "vitest";
import type { BackEdge } from "./epic-graph-rank";
import { computeLongEdgeRoutes, type RoutePoint } from "./epic-graph-route";

// Mirror the layout's structure constants so fixtures land on real rank x's.
const X_PAD = 80;
const X_GAP = 320;
const NODE_HEIGHT = 56;
const BAND_MARGIN = 28;

const OPTS = { xPad: X_PAD, xGap: X_GAP, nodeHeight: NODE_HEIGHT, bandMargin: BAND_MARGIN };

// x for a given rank, and the center-y of a node placed with top-left y.
const rankX = (r: number) => X_PAD + r * X_GAP;
const centerY = (topY: number) => topY + NODE_HEIGHT / 2;

function pos(entries: [string, { x: number; y: number }][]) {
  return new Map(entries);
}

describe("computeLongEdgeRoutes — clearance (center space)", () => {
  it("diverts a long edge whose straight center-line cuts an intermediate band", () => {
    // A rank0 (top y=0 → cy=28), C rank2 (top y=0 → cy=28). The straight
    // center-line is flat at cy=28. N rank1 sits at top y=0 → cy=28, so its band
    // [28-56, 28+56] = [-28, 84] contains the line → must divert.
    const positions = pos([
      ["A", { x: rankX(0), y: 0 }],
      ["N", { x: rankX(1), y: 0 }],
      ["C", { x: rankX(2), y: 0 }],
    ]);
    const forward: BackEdge[] = [{ from: "A", to: "C" }];
    const routes = computeLongEdgeRoutes(positions, forward, OPTS);
    const route = routes.get("A->C")!;
    expect(route).toBeDefined();
    // route = [A-anchor, rank1-waypoint, C-anchor].
    expect(route).toHaveLength(3);
    const wp = route[1];
    expect(wp.x).toBe(rankX(1));
    // The rank-1 waypoint y must be OUTSIDE N's center-band.
    const nCy = centerY(0);
    const bandTop = nCy - NODE_HEIGHT / 2 - BAND_MARGIN;
    const bandBottom = nCy + NODE_HEIGHT / 2 + BAND_MARGIN;
    expect(wp.y < bandTop || wp.y > bandBottom).toBe(true);
  });

  it("leaves the waypoint at the interpolated center-y when it already clears the band", () => {
    // A rank0 cy = centerY(0) = 28; C rank2 cy = centerY(1000) = 1028. The line
    // at rank1 interpolates to cy ≈ 528. N rank1 sits near the top (cy=28), band
    // [-28, 84] — 528 is far below it → no divert, waypoint == interpolated.
    const positions = pos([
      ["A", { x: rankX(0), y: 0 }],
      ["N", { x: rankX(1), y: 0 }],
      ["C", { x: rankX(2), y: 1000 }],
    ]);
    const forward: BackEdge[] = [{ from: "A", to: "C" }];
    const routes = computeLongEdgeRoutes(positions, forward, OPTS);
    const wp = routes.get("A->C")![1];
    const yFrom = centerY(0);
    const yTo = centerY(1000);
    const interpolated = yFrom + (1 / 2) * (yTo - yFrom);
    expect(wp.y).toBe(interpolated);
  });
});

describe("computeLongEdgeRoutes — span handling", () => {
  it("a dist-3 edge yields 2 interior waypoints, each clearing its rank's band", () => {
    // A rank0, B rank1, C rank2, D rank3; long edge A->D. B and C placed so the
    // flat center-line (all top y=0 → cy=28) cuts both their bands.
    const positions = pos([
      ["A", { x: rankX(0), y: 0 }],
      ["B", { x: rankX(1), y: 0 }],
      ["C", { x: rankX(2), y: 0 }],
      ["D", { x: rankX(3), y: 0 }],
    ]);
    const forward: BackEdge[] = [{ from: "A", to: "D" }];
    const routes = computeLongEdgeRoutes(positions, forward, OPTS);
    const route = routes.get("A->D")!;
    // anchor + 2 interior + anchor.
    expect(route).toHaveLength(4);
    const interior = route.slice(1, -1);
    expect(interior.map((p) => p.x)).toEqual([rankX(1), rankX(2)]);
    const cy = centerY(0);
    const bandTop = cy - NODE_HEIGHT / 2 - BAND_MARGIN;
    const bandBottom = cy + NODE_HEIGHT / 2 + BAND_MARGIN;
    for (const wp of interior) {
      expect(wp.y < bandTop || wp.y > bandBottom).toBe(true);
    }
  });

  it("returns an empty Map when there are no long edges", () => {
    const positions = pos([
      ["A", { x: rankX(0), y: 0 }],
      ["B", { x: rankX(1), y: 0 }],
    ]);
    const forward: BackEdge[] = [{ from: "A", to: "B" }];
    const routes = computeLongEdgeRoutes(positions, forward, OPTS);
    expect(routes.size).toBe(0);
  });

  it("never keys a short (dist-1) edge", () => {
    const positions = pos([
      ["A", { x: rankX(0), y: 0 }],
      ["B", { x: rankX(1), y: 0 }],
      ["C", { x: rankX(2), y: 0 }],
    ]);
    // A->B is short, A->C is long.
    const forward: BackEdge[] = [
      { from: "A", to: "B" },
      { from: "A", to: "C" },
    ];
    const routes = computeLongEdgeRoutes(positions, forward, OPTS);
    expect(routes.has("A->B")).toBe(false);
    expect(routes.has("A->C")).toBe(true);
  });

  it("skips an edge with an absent endpoint without throwing", () => {
    const positions = pos([["A", { x: rankX(0), y: 0 }]]);
    const forward: BackEdge[] = [{ from: "A", to: "GHOST" }];
    expect(() => computeLongEdgeRoutes(positions, forward, OPTS)).not.toThrow();
    expect(computeLongEdgeRoutes(positions, forward, OPTS).size).toBe(0);
  });
});

describe("computeLongEdgeRoutes — endpoints + determinism", () => {
  it("first point is the source center-anchor, last is the target center-anchor", () => {
    const positions = pos([
      ["A", { x: rankX(0), y: 40 }],
      ["N", { x: rankX(1), y: 0 }],
      ["C", { x: rankX(2), y: 120 }],
    ]);
    const forward: BackEdge[] = [{ from: "A", to: "C" }];
    const route = computeLongEdgeRoutes(positions, forward, OPTS).get("A->C")!;
    expect(route[0]).toEqual({ x: rankX(0), y: centerY(40) });
    expect(route[route.length - 1]).toEqual({ x: rankX(2), y: centerY(120) });
  });

  it("is deterministic across shuffled forwardEdges + positions insertion order", () => {
    const build = (
      entries: [string, { x: number; y: number }][],
      edges: BackEdge[],
    ): [string, RoutePoint[]][] =>
      [...computeLongEdgeRoutes(pos(entries), edges, OPTS).entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      );

    const entries: [string, { x: number; y: number }][] = [
      ["A", { x: rankX(0), y: 0 }],
      ["B", { x: rankX(1), y: 0 }],
      ["C", { x: rankX(2), y: 0 }],
      ["D", { x: rankX(3), y: 0 }],
    ];
    const edges: BackEdge[] = [
      { from: "A", to: "C" },
      { from: "A", to: "D" },
    ];

    const r1 = build(entries, edges);
    const r2 = build([entries[3], entries[1], entries[0], entries[2]], [edges[1], edges[0]]);
    expect(r1).toEqual(r2);
  });
});
