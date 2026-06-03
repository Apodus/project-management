import { describe, expect, it } from "vitest";
import type { EpicGraphEdge, EpicGraphNode } from "./api";
import { computeRanks, type RankResult } from "./epic-graph-rank";

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

/** Stable, comparable view of `ranks` for deep-equality across input order. */
function sortedRanks(r: RankResult): [string, number][] {
  return [...r.ranks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

describe("computeRanks — blocks edges constrain rank", () => {
  it("case 1: a blocks edge puts the prerequisite strictly left of the dependent", () => {
    const r = computeRanks(nodes("A", "B", "C"), [makeEdge("A", "B"), makeEdge("B", "C")]);
    expect(sortedRanks(r)).toEqual([
      ["A", 0],
      ["B", 1],
      ["C", 2],
    ]);
    // Every retained forward edge is monotone.
    expect(r.ranks.get("A")!).toBeLessThan(r.ranks.get("B")!);
    expect(r.ranks.get("B")!).toBeLessThan(r.ranks.get("C")!);
    expect(r.excludedBackEdges).toEqual([]);
  });

  it("case 2: a monotone chain ranks 0,1,2,3", () => {
    const r = computeRanks(nodes("A", "B", "C", "D"), [
      makeEdge("A", "B"),
      makeEdge("B", "C"),
      makeEdge("C", "D"),
    ]);
    expect(sortedRanks(r)).toEqual([
      ["A", 0],
      ["B", 1],
      ["C", 2],
      ["D", 3],
    ]);
    expect(r.maxRank).toBe(3);
  });

  it("case 3: a diamond ranks by LONGEST path", () => {
    const r = computeRanks(nodes("A", "B", "C", "D"), [
      makeEdge("A", "B"),
      makeEdge("A", "C"),
      makeEdge("B", "D"),
      makeEdge("C", "D"),
    ]);
    expect(r.ranks.get("A")).toBe(0);
    expect(r.ranks.get("B")).toBe(1);
    expect(r.ranks.get("C")).toBe(1);
    expect(r.ranks.get("D")).toBe(2);
    expect(r.maxRank).toBe(2);
    expect(r.excludedBackEdges).toEqual([]);
  });
});

describe("computeRanks — relates_to never constrains", () => {
  it("case 4a: a lone relates_to edge leaves both endpoints on rank 0", () => {
    const r = computeRanks(nodes("X", "Y"), [makeEdge("X", "Y", "relates_to")]);
    expect(r.ranks.get("X")).toBe(0);
    expect(r.ranks.get("Y")).toBe(0);
    expect(r.excludedBackEdges).toEqual([]);
    expect(r.maxRank).toBe(0);
  });

  it("case 4b: a relates_to back-link does not create a back-edge or change rank", () => {
    const r = computeRanks(nodes("A", "B"), [
      makeEdge("A", "B", "blocks"),
      makeEdge("B", "A", "relates_to"),
    ]);
    expect(sortedRanks(r)).toEqual([
      ["A", 0],
      ["B", 1],
    ]);
    expect(r.excludedBackEdges).toEqual([]);
  });

  it("case 5: all-relates_to with several nodes leaves every rank 0 (CORRECTION 1)", () => {
    const r = computeRanks(nodes("A", "B", "C"), [
      makeEdge("A", "B", "relates_to"),
      makeEdge("B", "C", "relates_to"),
      makeEdge("C", "A", "relates_to"),
    ]);
    expect(sortedRanks(r)).toEqual([
      ["A", 0],
      ["B", 0],
      ["C", 0],
    ]);
    expect(r.maxRank).toBe(0);
    expect(r.excludedBackEdges).toEqual([]);
  });
});

describe("computeRanks — cycles are DAG-ified deterministically", () => {
  it("case 6: a 3-cycle drops exactly the C->A back-edge", () => {
    const r = computeRanks(nodes("A", "B", "C"), [
      makeEdge("A", "B"),
      makeEdge("B", "C"),
      makeEdge("C", "A"),
    ]);
    expect(r.excludedBackEdges).toEqual([{ from: "C", to: "A" }]);
    expect(sortedRanks(r)).toEqual([
      ["A", 0],
      ["B", 1],
      ["C", 2],
    ]);
    // Every retained forward edge stays monotone.
    expect(r.ranks.get("A")!).toBeLessThan(r.ranks.get("B")!);
    expect(r.ranks.get("B")!).toBeLessThan(r.ranks.get("C")!);
  });

  it("case 7: a 4-cycle drops exactly the D->A back-edge; ranks finite + monotone", () => {
    const r = computeRanks(nodes("A", "B", "C", "D"), [
      makeEdge("A", "B"),
      makeEdge("B", "C"),
      makeEdge("C", "D"),
      makeEdge("D", "A"),
    ]);
    expect(r.excludedBackEdges).toEqual([{ from: "D", to: "A" }]);
    expect(sortedRanks(r)).toEqual([
      ["A", 0],
      ["B", 1],
      ["C", 2],
      ["D", 3],
    ]);
    for (const v of r.ranks.values()) expect(Number.isFinite(v)).toBe(true);
  });

  it("case 8: a self-loop is filtered out, not recorded as a back-edge", () => {
    const r = computeRanks(nodes("A"), [makeEdge("A", "A")]);
    expect(r.excludedBackEdges).toEqual([]);
    expect(r.ranks.get("A")).toBe(0);
    expect(r.maxRank).toBe(0);
  });
});

describe("computeRanks — forwardEdges (surviving blocks edges)", () => {
  it("case 14: a diamond keeps all 4 forward edges, sorted by (from,to)", () => {
    const r = computeRanks(nodes("A", "B", "C", "D"), [
      makeEdge("A", "B"),
      makeEdge("A", "C"),
      makeEdge("B", "D"),
      makeEdge("C", "D"),
    ]);
    expect(r.forwardEdges).toEqual([
      { from: "A", to: "B" },
      { from: "A", to: "C" },
      { from: "B", to: "D" },
      { from: "C", to: "D" },
    ]);
  });

  it("case 15: a 3-cycle's forwardEdges exclude the dropped back-edge", () => {
    const r = computeRanks(nodes("A", "B", "C"), [
      makeEdge("A", "B"),
      makeEdge("B", "C"),
      makeEdge("C", "A"),
    ]);
    expect(r.excludedBackEdges).toEqual([{ from: "C", to: "A" }]);
    // C->A is dropped; the two survivors remain, sorted by (from,to).
    expect(r.forwardEdges).toEqual([
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ]);
  });
});

describe("computeRanks — determinism", () => {
  it("case 9: identical output regardless of input array order", () => {
    const baseNodes = nodes("A", "B", "C", "D");
    const baseEdges = [
      makeEdge("A", "B"),
      makeEdge("B", "C"),
      makeEdge("C", "A"), // closes a cycle
      makeEdge("B", "D", "relates_to"),
    ];

    const shuffledNodes = [baseNodes[2], baseNodes[0], baseNodes[3], baseNodes[1]];
    const shuffledEdges = [baseEdges[2], baseEdges[0], baseEdges[3], baseEdges[1]];

    const r1 = computeRanks(baseNodes, baseEdges);
    const r2 = computeRanks(shuffledNodes, shuffledEdges);

    expect(sortedRanks(r1)).toEqual(sortedRanks(r2));
    expect(r1.excludedBackEdges).toEqual(r2.excludedBackEdges);
    expect(r1.maxRank).toBe(r2.maxRank);
  });
});

describe("computeRanks — degenerate + edge cases", () => {
  it("case 10: empty input yields empty ranks, maxRank -1, no back-edges", () => {
    const r = computeRanks([], []);
    expect(r.ranks.size).toBe(0);
    expect(r.maxRank).toBe(-1);
    expect(r.excludedBackEdges).toEqual([]);
  });

  it("case 11: a single node is rank 0, maxRank 0", () => {
    const r = computeRanks(nodes("N"), []);
    expect(sortedRanks(r)).toEqual([["N", 0]]);
    expect(r.maxRank).toBe(0);
  });

  it("case 12: a disconnected isolated node stays rank 0 alongside a chain", () => {
    const r = computeRanks(nodes("A", "B", "C", "ISO"), [
      makeEdge("A", "B"),
      makeEdge("B", "C"),
    ]);
    expect(r.ranks.get("ISO")).toBe(0);
    expect(r.ranks.get("C")).toBe(2);
    expect(r.maxRank).toBe(2);
  });

  it("case 13: an edge to an absent node is skipped without throwing", () => {
    const r = computeRanks(nodes("P"), [makeEdge("P", "GHOST")]);
    expect(sortedRanks(r)).toEqual([["P", 0]]);
    expect(r.ranks.has("GHOST")).toBe(false);
    expect(r.excludedBackEdges).toEqual([]);
  });
});
