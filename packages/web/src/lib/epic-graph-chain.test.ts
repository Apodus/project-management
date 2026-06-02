import { describe, expect, it } from "vitest";
import type { EpicGraphEdge } from "./api";
import { computeChain, edgeKey } from "./epic-graph-chain";

function makeEdge(
  from: string,
  to: string,
  type: "blocks" | "relates_to" = "blocks",
): EpicGraphEdge {
  return { from, to, dependency_type: type, provenance: "explicit" };
}

function sorted(set: Set<string>): string[] {
  return [...set].sort();
}

describe("edgeKey", () => {
  it("produces exactly `${from}->${to}-${dependency_type}`", () => {
    expect(edgeKey({ from: "A", to: "B", dependency_type: "blocks" })).toBe("A->B-blocks");
    expect(edgeKey({ from: "x", to: "y", dependency_type: "relates_to" })).toBe("x->y-relates_to");
  });
});

describe("computeChain — linear A->B->C", () => {
  const edges = [makeEdge("A", "B"), makeEdge("B", "C")];

  it("focus B reaches both ancestors and descendants + both edge keys", () => {
    const r = computeChain("B", edges);
    expect(sorted(r.nodeIds)).toEqual(["A", "B", "C"]);
    expect(sorted(r.edgeKeys)).toEqual(["A->B-blocks", "B->C-blocks"]);
  });

  it("focus A (head) descends to the full chain", () => {
    const r = computeChain("A", edges);
    expect(sorted(r.nodeIds)).toEqual(["A", "B", "C"]);
    expect(sorted(r.edgeKeys)).toEqual(["A->B-blocks", "B->C-blocks"]);
  });

  it("focus C (tail) ascends to the full chain", () => {
    const r = computeChain("C", edges);
    expect(sorted(r.nodeIds)).toEqual(["A", "B", "C"]);
    expect(sorted(r.edgeKeys)).toEqual(["A->B-blocks", "B->C-blocks"]);
  });
});

describe("computeChain — diamond A->B->D, A->C->D", () => {
  const edges = [makeEdge("A", "B"), makeEdge("A", "C"), makeEdge("B", "D"), makeEdge("C", "D")];

  it("focus A reaches all four nodes", () => {
    const r = computeChain("A", edges);
    expect(sorted(r.nodeIds)).toEqual(["A", "B", "C", "D"]);
  });

  it("focus B reaches A, B, D but NOT the sibling C", () => {
    const r = computeChain("B", edges);
    expect(sorted(r.nodeIds)).toEqual(["A", "B", "D"]);
    expect(r.nodeIds.has("C")).toBe(false);
    // Only the edges on the path through B; the C-side edges stay dim.
    expect(sorted(r.edgeKeys)).toEqual(["A->B-blocks", "B->D-blocks"]);
  });
});

describe("computeChain — isolated focus", () => {
  it("returns just the focus with no edge keys", () => {
    const r = computeChain("X", [makeEdge("A", "B")]);
    expect(sorted(r.nodeIds)).toEqual(["X"]);
    expect(r.edgeKeys.size).toBe(0);
  });
});

describe("computeChain — cycle A->B->A", () => {
  it("terminates and includes both nodes + both edge keys", () => {
    const edges = [makeEdge("A", "B"), makeEdge("B", "A")];
    const r = computeChain("A", edges);
    expect(sorted(r.nodeIds)).toEqual(["A", "B"]);
    expect(sorted(r.edgeKeys)).toEqual(["A->B-blocks", "B->A-blocks"]);
  });
});

describe("computeChain — relates_to participates", () => {
  it("follows a relates_to edge like any other rendered edge", () => {
    const r = computeChain("A", [makeEdge("A", "B", "relates_to")]);
    expect(sorted(r.nodeIds)).toEqual(["A", "B"]);
    expect(sorted(r.edgeKeys)).toEqual(["A->B-relates_to"]);
  });
});
