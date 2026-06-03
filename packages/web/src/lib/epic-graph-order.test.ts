import { describe, expect, it } from "vitest";
import type { EpicGraphEdge, EpicGraphNode } from "./api";
import { computeRanks } from "./epic-graph-rank";
import { computeOrder, countCrossings } from "./epic-graph-order";

function makeNode(id: string): EpicGraphNode {
  return {
    id,
    project_id: "p1",
    name: id,
    status: "active",
    priority: "medium",
    target_date: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    taskSummary: { total: 0, done: 0, byStatus: {} },
    health: "on_track",
    activity_recency: "2026-01-01",
    time_window: { start: "2026-01-01", end: null },
  };
}

function makeEdge(
  from: string,
  to: string,
  type: "blocks" | "relates_to" = "blocks",
): EpicGraphEdge {
  return { from, to, dependency_type: type, provenance: "explicit" };
}

function nodes(...ids: string[]): EpicGraphNode[] {
  return ids.map(makeNode);
}

/** All permutations of an array (small arrays only — used for brute-force oracles). */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

// FORCED-2 fixture: two stacked K2,2 blocks. Each complete bipartite 2x2 forces
// exactly 1 crossing for ANY ordering, so total is unavoidably 2.
const forced2Nodes = nodes("T0", "T1", "M0", "M1", "Bo0", "Bo1");
const forced2Edges = [
  makeEdge("T0", "M0"),
  makeEdge("T0", "M1"),
  makeEdge("T1", "M0"),
  makeEdge("T1", "M1"),
  makeEdge("M0", "Bo0"),
  makeEdge("M0", "Bo1"),
  makeEdge("M1", "Bo0"),
  makeEdge("M1", "Bo1"),
];

// UNTANGLE fixture: a degree-1 perfect matching whose id-sorted seed has 2
// crossings but whose true minimum is 0.
const untangleNodes = nodes("T0", "T1", "T2", "T3", "B0", "B1", "B2", "B3");
const untangleEdges = [
  makeEdge("T0", "B1"),
  makeEdge("T1", "B0"),
  makeEdge("T2", "B3"),
  makeEdge("T3", "B2"),
];

describe("countCrossings + computeOrder — FORCED-2 (the gate)", () => {
  it("test 1a: brute-force guardrail — every one of 8 orderings is exactly 2", () => {
    const rank = computeRanks(forced2Nodes, forced2Edges);
    const top = ["T0", "T1"];
    const mid = ["M0", "M1"];
    const bot = ["Bo0", "Bo1"];
    const counts: number[] = [];
    for (const t of permutations(top)) {
      for (const m of permutations(mid)) {
        for (const b of permutations(bot)) {
          counts.push(countCrossings([t, m, b], rank.forwardEdges));
        }
      }
    }
    expect(counts.length).toBe(8);
    expect(Math.min(...counts)).toBe(2);
    expect(Math.max(...counts)).toBe(2);
  });

  it("test 1b: heuristic lands on the unavoidable 2", () => {
    const result = computeOrder(computeRanks(forced2Nodes, forced2Edges));
    expect(result.crossings).toBe(2);
  });
});

describe("countCrossings + computeOrder — UNTANGLE (the other gate)", () => {
  it("test 2a: brute-force guardrail — the true minimum over 24 bottom perms is 0", () => {
    const rank = computeRanks(untangleNodes, untangleEdges);
    const top = ["T0", "T1", "T2", "T3"]; // fixed id-sorted
    const bottomPerms = permutations(["B0", "B1", "B2", "B3"]);
    const counts = bottomPerms.map((b) => countCrossings([top, b], rank.forwardEdges));
    expect(counts.length).toBe(24);
    expect(Math.min(...counts)).toBe(0);
  });

  it("test 2b: heuristic untangles to 0", () => {
    const result = computeOrder(computeRanks(untangleNodes, untangleEdges));
    expect(result.crossings).toBe(0);
  });
});

describe("computeOrder — determinism", () => {
  it("test 3: identical layers + crossings regardless of input order (FORCED-2)", () => {
    const shuffledNodes = [
      forced2Nodes[3],
      forced2Nodes[0],
      forced2Nodes[5],
      forced2Nodes[2],
      forced2Nodes[1],
      forced2Nodes[4],
    ];
    const shuffledEdges = [
      forced2Edges[6],
      forced2Edges[1],
      forced2Edges[4],
      forced2Edges[0],
      forced2Edges[7],
      forced2Edges[3],
      forced2Edges[2],
      forced2Edges[5],
    ];
    const r1 = computeOrder(computeRanks(forced2Nodes, forced2Edges));
    const r2 = computeOrder(computeRanks(shuffledNodes, shuffledEdges));
    expect(r1.layers).toEqual(r2.layers);
    expect(r1.crossings).toBe(r2.crossings);
  });
});

describe("computeOrder — sanity", () => {
  it("test 4a: flattened layers is a permutation of all node ids (FORCED-2)", () => {
    const result = computeOrder(computeRanks(forced2Nodes, forced2Edges));
    const flat = result.layers.flat();
    expect(flat.length).toBe(forced2Nodes.length);
    expect([...flat].sort()).toEqual([...forced2Nodes.map((n) => n.id)].sort());
  });

  it("test 4b: positions agree with ranks; order is contiguous 0..len-1 per layer", () => {
    const rank = computeRanks(forced2Nodes, forced2Edges);
    const result = computeOrder(rank);
    for (const [id, pos] of result.positions) {
      expect(pos.rank).toBe(rank.ranks.get(id));
    }
    for (let r = 0; r < result.layers.length; r++) {
      const orders = result.layers[r].map((id) => result.positions.get(id)!.order);
      expect(orders).toEqual([...Array(result.layers[r].length).keys()]);
    }
  });

  it("test 4c: no-edges graph — three isolated nodes all on rank 0, id-sorted, 0 crossings", () => {
    const result = computeOrder(computeRanks(nodes("C", "A", "B"), []));
    expect(result.layers).toEqual([["A", "B", "C"]]);
    expect(result.crossings).toBe(0);
  });

  it("test 4d: empty input — empty layers, 0 crossings, empty positions", () => {
    const result = computeOrder(computeRanks([], []));
    expect(result.layers).toEqual([]);
    expect(result.crossings).toBe(0);
    expect(result.positions.size).toBe(0);
  });
});
