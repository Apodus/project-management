import { describe, expect, it } from "vitest";
import { assignCoordinates, type CoordOptions } from "./epic-graph-coords";
import type { BackEdge } from "./epic-graph-rank";

const RH = 104;
const OPTS: CoordOptions = { rowHeight: RH };

function edge(from: string, to: string): BackEdge {
  return { from, to };
}

/** Mean over forward edges of |y(to) - y(from)| — the alignment proxy. */
function meanEdgeDisplacement(
  y: Map<string, number>,
  edges: BackEdge[],
): number {
  if (edges.length === 0) return 0;
  let sum = 0;
  for (const e of edges) sum += Math.abs(y.get(e.to)! - y.get(e.from)!);
  return sum / edges.length;
}

describe("assignCoordinates — alignment", () => {
  it("a single-prereq dependent alone in its layer aligns exactly to its prereq", () => {
    const layers = [["A"], ["B"]];
    const edges = [edge("A", "B")];
    const y = assignCoordinates(layers, edges, OPTS);
    // Single prereq, alone in layer → zero displacement.
    expect(Math.abs(y.get("B")! - y.get("A")!)).toBeLessThanOrEqual(RH);
    expect(y.get("B")).toBe(y.get("A"));
  });
});

describe("assignCoordinates — median", () => {
  it("a fan-in dependent sits within rowHeight of the median of its prereqs", () => {
    const layers = [["A", "B", "C"], ["D"]];
    const edges = [edge("A", "D"), edge("B", "D"), edge("C", "D")];
    const y = assignCoordinates(layers, edges, OPTS);
    const ys = [y.get("A")!, y.get("B")!, y.get("C")!].sort((a, b) => a - b);
    const med = ys[1]; // odd → middle
    expect(Math.abs(y.get("D")! - med)).toBeLessThanOrEqual(RH);
  });
});

describe("assignCoordinates — min-gap + order preservation", () => {
  it("consecutive same-layer nodes keep >= rowHeight gap and preserve order", () => {
    // Two prereqs in rank 0 both pointing into a shared rank-1 dependent.
    const layers = [["A", "B"], ["C"]];
    const edges = [edge("A", "C"), edge("B", "C")];
    const y = assignCoordinates(layers, edges, OPTS);
    // order index 0 (A) above order index 1 (B): monotonically increasing y.
    expect(y.get("A")!).toBeLessThan(y.get("B")!);
    expect(y.get("B")! - y.get("A")!).toBeGreaterThanOrEqual(RH);
  });
});

describe("assignCoordinates — empty slot (CORRECTION A)", () => {
  it("a dependent aligns deep to its only prereq, leaving a real gap above it", () => {
    // P0,P1,P2 on rank 0; A,B on rank 1. ONLY P2 → B. A is unconstrained.
    const layers = [["P0", "P1", "P2"], ["A", "B"]];
    const edges = [edge("P2", "B")];
    const y = assignCoordinates(layers, edges, OPTS);
    // B pulled deep to P2 (the bottom prereq); A keeps its seed near the top.
    expect(y.get("B")! - y.get("A")!).toBeGreaterThanOrEqual(2 * RH);
    // No SAME-RANK node (rank 1: A, B) sits in the gap strictly between A and B
    // — the slot is genuinely empty (the prereqs in rank 0 naturally span this
    // y-range and are NOT in scope here).
    const gapLo = y.get("A")!;
    const gapHi = y.get("B")!;
    for (const id of ["A", "B"]) {
      const v = y.get(id)!;
      if (v > gapLo && v < gapHi) {
        expect.fail(`node ${id} at ${v} sits in the gap (${gapLo}, ${gapHi})`);
      }
    }
  });
});

describe("assignCoordinates — no-neighbor stability", () => {
  it("an isolated node keeps its seed and is unmoved by unrelated changes", () => {
    const layersA = [["X", "ISO"], ["Y"]];
    const edgesA = [edge("X", "Y")];
    const y1 = assignCoordinates(layersA, edgesA, OPTS);

    // ISO is order index 1 in rank 0, no edges → seed = 1 * RH; stays put.
    // Changing an unrelated chain (X→Y geometry) must not move ISO.
    const layersB = [["X", "ISO"], ["Y", "Z"]];
    const edgesB = [edge("X", "Y"), edge("X", "Z")];
    const y2 = assignCoordinates(layersB, edgesB, OPTS);

    expect(y1.get("ISO")).toBe(RH);
    expect(y2.get("ISO")).toBe(RH);
  });
});

describe("assignCoordinates — determinism", () => {
  it("shuffling the forwardEdges array yields an identical Map", () => {
    const layers = [["A", "B", "C"], ["D", "E"]];
    const edges = [edge("A", "D"), edge("B", "D"), edge("C", "E"), edge("A", "E")];
    const shuffled = [edges[3], edges[1], edges[0], edges[2]];
    const y1 = assignCoordinates(layers, edges, OPTS);
    const y2 = assignCoordinates(layers, shuffled, OPTS);
    expect([...y1.entries()].sort()).toEqual([...y2.entries()].sort());
  });
});

describe("assignCoordinates — degenerate", () => {
  it("empty layers → empty map", () => {
    const y = assignCoordinates([], [], OPTS);
    expect(y.size).toBe(0);
  });

  it("single node → {A: 0}", () => {
    const y = assignCoordinates([["A"]], [], OPTS);
    expect(y.size).toBe(1);
    expect(y.get("A")).toBe(0);
  });
});

describe("assignCoordinates — mean-displacement gate (CORRECTION B)", () => {
  it("the balanced pass aligns dependents to within ~one row of prereqs on average", () => {
    // ~8 nodes across 3 ranks: two chains plus a fan-in into the last rank.
    // rank0: A, B, C ; rank1: D, E ; rank2: F, G, H
    // A→D, B→D, C→E  (fan-in to D, single to E)
    // D→F, D→G, E→H, E→G  (fan-out + a join at G)
    const layers = [["A", "B", "C"], ["D", "E"], ["F", "G", "H"]];
    const edges = [
      edge("A", "D"),
      edge("B", "D"),
      edge("C", "E"),
      edge("D", "F"),
      edge("D", "G"),
      edge("E", "H"),
      edge("E", "G"),
    ];
    const y = assignCoordinates(layers, edges, OPTS);
    const mean = meanEdgeDisplacement(y, edges);
    expect(mean).toBeLessThanOrEqual(RH);
  });
});
