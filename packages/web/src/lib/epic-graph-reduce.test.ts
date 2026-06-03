import { describe, expect, it } from "vitest";
import type { BackEdge } from "./epic-graph-rank";
import { transitiveReduction } from "./epic-graph-reduce";

const e = (from: string, to: string): BackEdge => ({ from, to });

/** Stable string keys for set-style comparison, sorted. */
function keys(edges: BackEdge[]): string[] {
  return edges.map((x) => `${x.from}->${x.to}`);
}

describe("transitiveReduction", () => {
  it("user case: drops the direct A->C when A->B->C exists", () => {
    const r = transitiveReduction([e("C1", "C2"), e("C2", "C5"), e("C1", "C5")]);
    expect(keys(r.reduced)).toEqual(["C1->C2", "C2->C5"]);
    expect(keys(r.redundant)).toEqual(["C1->C5"]);
  });

  it("diamond keeps all four edges (no redundancy)", () => {
    // A->B, A->C, B->D, C->D: A reaches D only via B/C (no direct A->D), and
    // neither spoke implies another → nothing redundant.
    const r = transitiveReduction([e("A", "B"), e("A", "C"), e("B", "D"), e("C", "D")]);
    expect(keys(r.redundant)).toEqual([]);
    expect(keys(r.reduced)).toEqual(["A->B", "A->C", "B->D", "C->D"]);
  });

  it("a plain chain has nothing redundant", () => {
    const r = transitiveReduction([e("A", "B"), e("B", "C")]);
    expect(keys(r.redundant)).toEqual([]);
    expect(keys(r.reduced)).toEqual(["A->B", "B->C"]);
  });

  it("double: A->B, A->C, B->C drops only A->C", () => {
    const r = transitiveReduction([e("A", "B"), e("A", "C"), e("B", "C")]);
    expect(keys(r.redundant)).toEqual(["A->C"]);
    expect(keys(r.reduced)).toEqual(["A->B", "B->C"]);
  });

  it("two parallel len-2 paths + a direct edge: only the direct A->D goes", () => {
    const r = transitiveReduction([
      e("A", "B"),
      e("B", "D"),
      e("A", "C"),
      e("C", "D"),
      e("A", "D"),
    ]);
    expect(keys(r.redundant)).toEqual(["A->D"]);
    expect(keys(r.reduced)).toEqual(["A->B", "A->C", "B->D", "C->D"]);
  });

  it("is deterministic: a shuffled input yields identical partitions", () => {
    const base: BackEdge[] = [
      e("A", "B"),
      e("B", "D"),
      e("A", "C"),
      e("C", "D"),
      e("A", "D"),
    ];
    const shuffled: BackEdge[] = [
      e("A", "D"),
      e("C", "D"),
      e("A", "B"),
      e("A", "C"),
      e("B", "D"),
    ];
    const a = transitiveReduction(base);
    const b = transitiveReduction(shuffled);
    expect(b.reduced).toEqual(a.reduced);
    expect(b.redundant).toEqual(a.redundant);
    // Both sorted by (from, to).
    expect(keys(a.reduced)).toEqual([...keys(a.reduced)].sort());
    expect(keys(a.redundant)).toEqual([...keys(a.redundant)].sort());
  });

  it("empty input → both empty", () => {
    const r = transitiveReduction([]);
    expect(r.reduced).toEqual([]);
    expect(r.redundant).toEqual([]);
  });
});
