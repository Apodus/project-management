import { describe, expect, it } from "vitest";
import type { EpicGraphEdge, EpicGraphNode } from "./api";
import { computeEpicGraphLayout, type LayoutResult } from "./epic-graph-layout";

const NOW = "2026-06-02T00:00:00.000Z";

function makeNode(
  id: string,
  window: { start: string; end?: string | null },
): EpicGraphNode {
  return {
    id,
    project_id: "p1",
    name: id,
    status: "active",
    priority: "medium",
    target_date: null,
    created_at: window.start,
    updated_at: window.end ?? window.start,
    taskSummary: { total: 0, done: 0, byStatus: {} },
    health: "on_track",
    activity_recency: window.end ?? window.start,
    time_window: { start: window.start, end: window.end ?? null },
  };
}

function makeEdge(
  from: string,
  to: string,
  type: "blocks" | "relates_to" = "blocks",
): EpicGraphEdge {
  return { from, to, dependency_type: type, provenance: "explicit" };
}

function sortedEntries(result: LayoutResult): [string, unknown][] {
  return [...result.positions.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
}

describe("computeEpicGraphLayout — degenerate inputs", () => {
  it("case 1: empty input produces an empty, floored layout", () => {
    const r = computeEpicGraphLayout([], [], { now: NOW });
    expect(r.positions.size).toBe(0);
    expect(r.backwardsEdges).toEqual([]);
    expect(r.laneCount).toBe(0);
    // span floor applied even with no nodes (domain = {nowMs}).
    expect(r.scale.maxMs).toBeGreaterThan(r.scale.minMs);
  });

  it("case 2: single node is finite, in-range, and on lane 0", () => {
    const r = computeEpicGraphLayout(
      [makeNode("A", { start: "2026-01-01", end: "2026-03-01" })],
      [],
      { now: NOW },
    );
    expect(r.positions.size).toBe(1);
    const a = r.positions.get("A")!;
    expect(Number.isFinite(a.x)).toBe(true);
    expect(a.x).toBeGreaterThanOrEqual(r.scale.xPad);
    expect(a.x).toBeLessThanOrEqual(r.scale.width - r.scale.xPad);
    expect(a.lane).toBe(0);
    expect(a.y).toBe(0);
  });
});

describe("computeEpicGraphLayout — determinism", () => {
  it("case 3: identical output regardless of input array order", () => {
    const nodes = [
      makeNode("A", { start: "2024-01-01", end: "2025-01-01" }),
      makeNode("B", { start: "2025-06-01", end: "2026-01-01" }),
      makeNode("C", { start: "2026-01-01", end: "2026-05-01" }),
      makeNode("D", { start: "2026-01-01", end: "2026-05-01" }),
      makeNode("E", { start: "2026-05-01", end: null }),
    ];
    const edges = [
      makeEdge("A", "B"),
      makeEdge("B", "C"),
      makeEdge("E", "A"), // backwards
      makeEdge("C", "D", "relates_to"),
    ];

    const shuffledNodes = [nodes[3], nodes[0], nodes[4], nodes[1], nodes[2]];
    const shuffledEdges = [edges[2], edges[0], edges[3], edges[1]];

    const r1 = computeEpicGraphLayout(nodes, edges, { now: NOW });
    const r2 = computeEpicGraphLayout(shuffledNodes, shuffledEdges, { now: NOW });

    expect(sortedEntries(r1)).toEqual(sortedEntries(r2));
    expect(r1.backwardsEdges).toEqual(r2.backwardsEdges);
    expect(r1.laneCount).toBe(r2.laneCount);
    expect(r1.scale.minMs).toBe(r2.scale.minMs);
    expect(r1.scale.maxMs).toBe(r2.scale.maxMs);
    expect(r1.scale.nowMs).toBe(r2.scale.nowMs);
    // Compare scales by value (sampling toX), not by function reference.
    const sample = Date.parse("2025-09-01");
    expect(r1.scale.toX(sample)).toBe(r2.scale.toX(sample));
  });
});

describe("computeEpicGraphLayout — time on x", () => {
  it("case 4: later representative time is further right, using end ?? start", () => {
    const r = computeEpicGraphLayout(
      [
        makeNode("A", { start: "2024-06-01", end: "2025-01-01" }),
        makeNode("B", { start: "2026-01-01", end: "2026-05-01" }),
      ],
      [],
      { now: NOW },
    );
    expect(r.positions.get("B")!.x).toBeGreaterThan(r.positions.get("A")!.x);

    // end ?? start: an old-created node with a far-future end sits right of a
    // node whose end is earlier — proving `end` (not start) drives x.
    const r2 = computeEpicGraphLayout(
      [
        makeNode("FUTURE", { start: "2024-01-01", end: "2026-12-01" }),
        makeNode("MID", { start: "2025-01-01", end: "2025-06-01" }),
      ],
      [],
      { now: NOW },
    );
    expect(r2.positions.get("FUTURE")!.x).toBeGreaterThan(
      r2.positions.get("MID")!.x,
    );
  });
});

describe("computeEpicGraphLayout — lane assignment (no overlap)", () => {
  it("case 5: same-x nodes get distinct lanes a full laneHeight apart", () => {
    const r = computeEpicGraphLayout(
      [
        makeNode("A", { start: "2025-01-01", end: "2026-01-01" }),
        makeNode("B", { start: "2025-01-01", end: "2026-01-01" }),
      ],
      [],
      { now: NOW },
    );
    const a = r.positions.get("A")!;
    const b = r.positions.get("B")!;
    expect(a.x).toBe(b.x);
    expect(a.lane).not.toBe(b.lane);
    expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(90);

    const r3 = computeEpicGraphLayout(
      [
        makeNode("A", { start: "2025-01-01", end: "2026-01-01" }),
        makeNode("B", { start: "2025-01-01", end: "2026-01-01" }),
        makeNode("C", { start: "2025-01-01", end: "2026-01-01" }),
      ],
      [],
      { now: NOW },
    );
    const lanes = [
      r3.positions.get("A")!.lane,
      r3.positions.get("B")!.lane,
      r3.positions.get("C")!.lane,
    ].sort((x, y) => x - y);
    expect(lanes).toEqual([0, 1, 2]);
    expect(r3.laneCount).toBe(3);
  });
});

describe("computeEpicGraphLayout — dependency invariants", () => {
  it("case 6: prerequisite-left, no backwards edge flagged", () => {
    const r = computeEpicGraphLayout(
      [
        makeNode("A", { start: "2024-06-01", end: "2025-01-01" }),
        makeNode("B", { start: "2025-06-01", end: "2026-01-01" }),
      ],
      [makeEdge("A", "B")],
      { now: NOW },
    );
    expect(r.positions.get("A")!.x).toBeLessThan(r.positions.get("B")!.x);
    expect(r.backwardsEdges).toEqual([]);
  });

  it("case 7: backwards-in-time blocks edge flagged; relates_to is not", () => {
    const r = computeEpicGraphLayout(
      [
        makeNode("LATE", { start: "2026-01-01", end: "2026-05-01" }),
        makeNode("EARLY", { start: "2025-01-01", end: "2025-05-01" }),
      ],
      [makeEdge("LATE", "EARLY", "blocks"), makeEdge("LATE", "EARLY", "relates_to")],
      { now: NOW },
    );
    expect(r.backwardsEdges).toHaveLength(1);
    expect(r.backwardsEdges[0].from).toBe("LATE");
    expect(r.backwardsEdges[0].to).toBe("EARLY");
    expect(Number.isFinite(r.positions.get("LATE")!.x)).toBe(true);
    expect(Number.isFinite(r.positions.get("EARLY")!.x)).toBe(true);
  });
});

describe("computeEpicGraphLayout — edge cases", () => {
  it("case 8: null end positions by start and orders correctly", () => {
    const r = computeEpicGraphLayout(
      [
        makeNode("NULLEND", { start: "2025-03-01", end: null }),
        makeNode("LATER", { start: "2026-01-01", end: "2026-04-01" }),
      ],
      [],
      { now: NOW },
    );
    const nullEnd = r.positions.get("NULLEND")!;
    expect(Number.isFinite(nullEnd.x)).toBe(true);
    expect(nullEnd.x).toBeLessThan(r.positions.get("LATER")!.x);
  });

  it("case 9: t == now maps exactly to toX(nowMs), finite and in range", () => {
    const r = computeEpicGraphLayout([makeNode("N", { start: NOW, end: NOW })], [], {
      now: NOW,
    });
    const n = r.positions.get("N")!;
    expect(n.x).toBe(r.scale.toX(r.scale.nowMs));
    expect(Number.isFinite(n.x)).toBe(true);
    expect(n.x).toBeGreaterThanOrEqual(r.scale.xPad);
    expect(n.x).toBeLessThanOrEqual(r.scale.width - r.scale.xPad);
  });

  it("case 10: edge to an absent node is skipped without throwing", () => {
    const r = computeEpicGraphLayout(
      [makeNode("P", { start: "2025-01-01", end: "2026-01-01" })],
      [makeEdge("P", "GHOST")],
      { now: NOW },
    );
    expect(r.backwardsEdges).toEqual([]);
    expect(r.positions.has("GHOST")).toBe(false);
  });

  it("case 11: all-identical timestamps yield finite geometry via span floor", () => {
    const r = computeEpicGraphLayout(
      [
        makeNode("A", { start: "2025-05-01", end: "2025-05-01" }),
        makeNode("B", { start: "2025-05-01", end: "2025-05-01" }),
        makeNode("C", { start: "2025-05-01", end: "2025-05-01" }),
      ],
      [],
      { now: NOW },
    );
    expect(r.scale.maxMs).toBeGreaterThan(r.scale.minMs);
    for (const pos of r.positions.values()) {
      expect(Number.isFinite(pos.x)).toBe(true);
      expect(Number.isFinite(pos.y)).toBe(true);
    }
  });
});
