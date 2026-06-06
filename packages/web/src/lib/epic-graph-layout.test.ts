import { describe, expect, it } from "vitest";
import type { EpicGraphEdge, EpicGraphNode } from "./api";
import { computeEpicGraphLayout, type LayoutResult } from "./epic-graph-layout";

const NOW = "2026-06-02T00:00:00.000Z";

function makeNode(
  id: string,
  window: { start: string; end?: string | null; created_at?: string },
): EpicGraphNode {
  return {
    id,
    project_id: "p1",
    name: id,
    status: "active",
    priority: "medium",
    target_date: null,
    created_at: window.created_at ?? window.start,
    updated_at: window.end ?? window.start,
    taskSummary: { total: 0, done: 0, byStatus: {} },
    health: "on_track",
    claimState: "unclaimed",
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
  return [...result.positions.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

describe("computeEpicGraphLayout — degenerate inputs", () => {
  it("case 1: empty input produces an empty, floored layout", () => {
    const r = computeEpicGraphLayout([], [], { now: NOW, mode: "timeline" });
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
      { now: NOW, mode: "timeline" },
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

    const r1 = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "timeline" });
    const r2 = computeEpicGraphLayout(shuffledNodes, shuffledEdges, { now: NOW, mode: "timeline" });

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
      { now: NOW, mode: "timeline" },
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
      { now: NOW, mode: "timeline" },
    );
    expect(r2.positions.get("FUTURE")!.x).toBeGreaterThan(r2.positions.get("MID")!.x);
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
      { now: NOW, mode: "timeline" },
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
      { now: NOW, mode: "timeline" },
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
      { now: NOW, mode: "timeline" },
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
      { now: NOW, mode: "timeline" },
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
      { now: NOW, mode: "timeline" },
    );
    const nullEnd = r.positions.get("NULLEND")!;
    expect(Number.isFinite(nullEnd.x)).toBe(true);
    expect(nullEnd.x).toBeLessThan(r.positions.get("LATER")!.x);
  });

  it("case 9: t == now maps exactly to toX(nowMs), finite and in range", () => {
    const r = computeEpicGraphLayout([makeNode("N", { start: NOW, end: NOW })], [], {
      now: NOW,
      mode: "timeline",
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
      { now: NOW, mode: "timeline" },
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
      { now: NOW, mode: "timeline" },
    );
    expect(r.scale.maxMs).toBeGreaterThan(r.scale.minMs);
    for (const pos of r.positions.values()) {
      expect(Number.isFinite(pos.x)).toBe(true);
      expect(Number.isFinite(pos.y)).toBe(true);
    }
  });
});

describe("computeEpicGraphLayout — backlog zone", () => {
  // A scheduled timeline of three nodes plus two unscheduled (future, no end).
  function backlogFixture() {
    return {
      nodes: [
        makeNode("S1", { start: "2025-01-01", end: "2025-06-01" }),
        makeNode("S2", { start: "2026-01-01", end: "2026-05-01" }),
        makeNode("S3", { start: "2026-03-01", end: "2026-04-01" }),
        // Unscheduled (no end); distinct created_at to order the block.
        makeNode("U1", { start: "2026-02-01", end: null, created_at: "2026-02-10" }),
        makeNode("U2", { start: "2026-02-01", end: null, created_at: "2026-02-20" }),
      ],
      scheduledIds: ["S1", "S2", "S3"],
      unscheduledIds: new Set(["U1", "U2"]),
    };
  }

  it("places every unscheduled node strictly right of every scheduled node", () => {
    const { nodes, scheduledIds, unscheduledIds } = backlogFixture();
    const r = computeEpicGraphLayout(nodes, [], { now: NOW, unscheduledIds, mode: "timeline" });
    const maxScheduledX = Math.max(...scheduledIds.map((id) => r.positions.get(id)!.x));
    for (const id of unscheduledIds) {
      expect(r.positions.get(id)!.x).toBeGreaterThan(maxScheduledX);
    }
  });

  it("orders >=2 unscheduled nodes by created_at with distinct x", () => {
    const { nodes, unscheduledIds } = backlogFixture();
    const r = computeEpicGraphLayout(nodes, [], { now: NOW, unscheduledIds, mode: "timeline" });
    const u1 = r.positions.get("U1")!;
    const u2 = r.positions.get("U2")!;
    expect(u1.x).not.toBe(u2.x);
    // U1 created before U2 → earlier rank → smaller x.
    expect(u1.x).toBeLessThan(u2.x);
  });

  it("is deterministic across shuffled nodes and set insertion order", () => {
    const { nodes, unscheduledIds } = backlogFixture();
    const shuffledNodes = [nodes[4], nodes[1], nodes[3], nodes[0], nodes[2]];
    const shuffledSet = new Set(["U2", "U1"]);
    const r1 = computeEpicGraphLayout(nodes, [], { now: NOW, unscheduledIds, mode: "timeline" });
    const r2 = computeEpicGraphLayout(shuffledNodes, [], {
      now: NOW,
      unscheduledIds: shuffledSet,
      mode: "timeline",
    });
    expect(sortedEntries(r1)).toEqual(sortedEntries(r2));
    expect(r1.laneCount).toBe(r2.laneCount);
  });

  it("REGRESSION: an empty unscheduledIds set is byte-identical to omitting it", () => {
    const nodes = [makeNode("N", { start: NOW, end: NOW })];
    const a = computeEpicGraphLayout(nodes, [], { now: NOW, mode: "timeline" });
    const b = computeEpicGraphLayout(nodes, [], {
      now: NOW,
      unscheduledIds: new Set(),
      mode: "timeline",
    });
    expect(sortedEntries(a)).toEqual(sortedEntries(b));
    expect(a.laneCount).toBe(b.laneCount);
    expect(a.scale.minMs).toBe(b.scale.minMs);
    expect(a.scale.maxMs).toBe(b.scale.maxMs);
    expect(a.scale.nowMs).toBe(b.scale.nowMs);
    expect(a.scale.xPad).toBe(b.scale.xPad);
    expect(a.scale.width).toBe(b.scale.width);
    const sample = Date.parse("2025-09-01");
    expect(a.scale.toX(sample)).toBe(b.scale.toX(sample));
  });

  it("all-unscheduled (zero scheduled) stays finite with a floored span", () => {
    const nodes = [
      makeNode("U1", { start: "2026-02-01", end: null, created_at: "2026-02-10" }),
      makeNode("U2", { start: "2026-02-01", end: null, created_at: "2026-02-20" }),
    ];
    const r = computeEpicGraphLayout(nodes, [], {
      now: NOW,
      unscheduledIds: new Set(["U1", "U2"]),
      mode: "timeline",
    });
    expect(r.scale.maxMs).toBeGreaterThan(r.scale.minMs);
    for (const pos of r.positions.values()) {
      expect(Number.isFinite(pos.x)).toBe(true);
      expect(Number.isFinite(pos.y)).toBe(true);
    }
  });

  it("a single unscheduled node is finite", () => {
    const nodes = [
      makeNode("S1", { start: "2025-01-01", end: "2025-06-01" }),
      makeNode("U1", { start: "2026-02-01", end: null, created_at: "2026-02-10" }),
    ];
    const r = computeEpicGraphLayout(nodes, [], {
      now: NOW,
      unscheduledIds: new Set(["U1"]),
      mode: "timeline",
    });
    const u1 = r.positions.get("U1")!;
    expect(Number.isFinite(u1.x)).toBe(true);
    expect(u1.x).toBeGreaterThan(r.positions.get("S1")!.x);
  });

  it("an unscheduled node's t equals its created_at ms", () => {
    const nodes = [makeNode("U1", { start: "2026-02-01", end: null, created_at: "2026-02-10" })];
    const r = computeEpicGraphLayout(nodes, [], {
      now: NOW,
      unscheduledIds: new Set(["U1"]),
      mode: "timeline",
    });
    expect(r.positions.get("U1")!.t).toBe(Date.parse("2026-02-10"));
  });
});

const STRUCTURE_X_GAP = 320;
const STRUCTURE_ROW_HEIGHT = 130;
const STRUCTURE_X_PAD = 80;

describe("computeEpicGraphLayout — structure mode", () => {
  const W = { start: "2025-01-01", end: "2025-06-01" };

  it("case S1: prerequisite strictly left of dependent for every forward blocks edge", () => {
    const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W), makeNode("D", W)];
    const edges = [makeEdge("A", "B"), makeEdge("B", "C"), makeEdge("A", "D", "relates_to")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    expect(r.positions.get("A")!.x).toBeLessThan(r.positions.get("B")!.x);
    expect(r.positions.get("B")!.x).toBeLessThan(r.positions.get("C")!.x);
    // Generic invariant for every forward blocks edge.
    for (const e of edges) {
      if (e.dependency_type !== "blocks") continue;
      expect(r.positions.get(e.from)!.x).toBeLessThan(r.positions.get(e.to)!.x);
    }
  });

  it("case Sa: single-prereq dependent aligns to its prereq (|ΔY| ≤ rowHeight)", () => {
    // A→B, each alone in its rank → B should land on A's y (within one row).
    const nodes = [makeNode("A", W), makeNode("B", W)];
    const edges = [makeEdge("A", "B")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    const a = r.positions.get("A")!;
    const b = r.positions.get("B")!;
    expect(Math.abs(b.y - a.y)).toBeLessThanOrEqual(STRUCTURE_ROW_HEIGHT + 1);
  });

  it("case Sf: a dependent aligns deep to its prereq, a sibling pair leaves a gap", () => {
    // Two prereqs G0,G3 on rank 0; A,B on rank 1 (G0→A, G3→B). Post-change-B the
    // ONLY-connected nodes drive the DAG; we add two stacking spacers S1,S2 that
    // ALSO depend on G0/G3 so rank 1 holds {A,B,S1,S2}, and a real vertical span
    // separates the A-aligned-to-G0 dependent from the B-aligned-to-G3 dependent.
    // (G1,G2-as-isolated-fillers no longer live in the DAG — they'd be trayed —
    // so dependents carry the spacing instead.)
    const nodes = [
      makeNode("G0", W),
      makeNode("G3", W),
      makeNode("A", W),
      makeNode("B", W),
      makeNode("S1", W),
      makeNode("S2", W),
    ];
    const edges = [
      makeEdge("G0", "A"),
      makeEdge("G0", "S1"),
      makeEdge("G3", "S2"),
      makeEdge("G3", "B"),
    ];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    const a = r.positions.get("A")!;
    const b = r.positions.get("B")!;
    const g0 = r.positions.get("G0")!;
    const g3 = r.positions.get("G3")!;
    // A and B share rank 1 → same x, distinct lanes; no tray (all connected).
    expect(a.x).toBe(b.x);
    expect(a.lane).not.toBe(b.lane);
    if (r.mode !== "structure") throw new Error("expected structure mode");
    expect(r.tray).toBeNull();
    // Each dependent aligns toward its single prereq; G0 sits above G3, so A is
    // above B and a real vertical gap separates them.
    expect(g0.y).toBeLessThan(g3.y);
    expect(a.y).toBeLessThan(b.y);
    expect(Math.abs(b.y - a.y)).toBeGreaterThanOrEqual(STRUCTURE_ROW_HEIGHT);
  });

  it("case S2: no overlap — distinct (x,y); same-rank ΔY≥rowHeight, diff-rank ΔX≥gap", () => {
    // A→C, B→C: A,B rank 0; C rank 1.
    const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W)];
    const edges = [makeEdge("A", "C"), makeEdge("B", "C")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });

    const entries = [...r.positions.entries()];
    // distinct (x,y).
    const seen = new Set<string>();
    for (const [, p] of entries) {
      const key = `${p.x},${p.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }

    const a = r.positions.get("A")!;
    const b = r.positions.get("B")!;
    const c = r.positions.get("C")!;
    // A,B same rank → ΔX 0, ΔY ≥ rowHeight.
    expect(a.x).toBe(b.x);
    expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(STRUCTURE_ROW_HEIGHT);
    // C different rank → ΔX ≥ gap.
    expect(Math.abs(c.x - a.x)).toBeGreaterThanOrEqual(STRUCTURE_X_GAP);
    expect(Math.abs(c.x - b.x)).toBeGreaterThanOrEqual(STRUCTURE_X_GAP);
  });

  describe("case S3: degenerate / finite geometry", () => {
    it("empty → empty positions, no backwards edges, laneCount 0", () => {
      const r = computeEpicGraphLayout([], [], { now: NOW, mode: "structure" as const });
      expect(r.positions.size).toBe(0);
      expect(r.backwardsEdges).toEqual([]);
      expect(r.laneCount).toBe(0);
    });

    it("single node, no edges → trayed, finite, y=0, lane=0, laneCount 0", () => {
      // Post-change-B: a lone edgeless node is ISOLATED → it drops into the tray
      // (empty DAG → tray pinned at y=0), so the DAG laneCount is 0 but the node
      // is still placed with finite geometry.
      const r = computeEpicGraphLayout([makeNode("A", W)], [], {
        now: NOW,
        mode: "structure" as const,
      });
      expect(r.positions.size).toBe(1);
      const a = r.positions.get("A")!;
      expect(Number.isFinite(a.x)).toBe(true);
      expect(a.y).toBe(0);
      expect(a.lane).toBe(0);
      expect(r.laneCount).toBe(0);
      if (r.mode !== "structure") throw new Error("expected structure mode");
      expect(r.tray).not.toBeNull();
      expect(r.tray!.count).toBe(1);
    });

    it("all relates_to → single rank-0 layer of 3, equal x, distinct y, laneCount 3", () => {
      const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W)];
      const edges = [
        makeEdge("A", "B", "relates_to"),
        makeEdge("B", "C", "relates_to"),
        makeEdge("A", "C", "relates_to"),
      ];
      const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
      const a = r.positions.get("A")!;
      const b = r.positions.get("B")!;
      const c = r.positions.get("C")!;
      expect(a.x).toBe(b.x);
      expect(b.x).toBe(c.x);
      const ys = new Set([a.y, b.y, c.y]);
      expect(ys.size).toBe(3);
      expect(r.laneCount).toBe(3);
      expect(r.backwardsEdges).toEqual([]);
      for (const p of [a, b, c]) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    });

    it("full cycle A→B→C→A → all finite geometry, ≥1 backwards edge", () => {
      const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W)];
      const edges = [makeEdge("A", "B"), makeEdge("B", "C"), makeEdge("C", "A")];
      const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
      for (const p of r.positions.values()) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
      expect(Number.isFinite(r.laneCount)).toBe(true);
      expect(r.backwardsEdges.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("case S4: deterministic across shuffled nodes AND edges", () => {
    const nodes = [
      makeNode("A", W),
      makeNode("B", W),
      makeNode("C", W),
      makeNode("D", W),
      makeNode("E", W),
    ];
    const edges = [
      makeEdge("A", "B"),
      makeEdge("B", "C"),
      makeEdge("C", "A"), // cycle back-edge
      makeEdge("A", "D"),
      makeEdge("B", "E", "relates_to"),
    ];
    const shuffledNodes = [nodes[3], nodes[0], nodes[4], nodes[1], nodes[2]];
    const shuffledEdges = [edges[2], edges[0], edges[4], edges[1], edges[3]];

    const r1 = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    const r2 = computeEpicGraphLayout(shuffledNodes, shuffledEdges, {
      now: NOW,
      mode: "structure" as const,
    });
    expect(sortedEntries(r1)).toEqual(sortedEntries(r2));
    expect(r1.backwardsEdges).toEqual(r2.backwardsEdges);
    expect(r1.laneCount).toBe(r2.laneCount);
  });

  it("case S5: backwardsEdges have fromX > toX (points against rank)", () => {
    const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W)];
    const edges = [makeEdge("A", "B"), makeEdge("B", "C"), makeEdge("C", "A")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    expect(r.backwardsEdges.length).toBeGreaterThanOrEqual(1);
    for (const be of r.backwardsEdges) {
      expect(be.fromX).toBeGreaterThan(be.toX);
      expect(r.positions.get(be.from)!.x).toBeGreaterThan(r.positions.get(be.to)!.x);
    }
  });

  it("case S6: lane === order; laneCount === tallest layer", () => {
    // 3-node layer (rank 0: A,B,C all blocking D) + 1-node layer (rank 1: D).
    const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W), makeNode("D", W)];
    const edges = [makeEdge("A", "D"), makeEdge("B", "D"), makeEdge("C", "D")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });

    const wide = ["A", "B", "C"].map((id) => r.positions.get(id)!);
    const lanes = wide.map((p) => p.lane).sort((x, y) => x - y);
    expect(lanes).toEqual([0, 1, 2]);
    expect(r.positions.get("D")!.lane).toBe(0);
    expect(r.laneCount).toBe(3);
  });

  it("case S7: a GENUINE dist-2 blocks edge populates longEdgeRoutes with its key", () => {
    // B→C, C→D chains the ranks (B=0,C=1,D=2) via D's deepest prereq; an
    // explicit A→D spans rank 0→2 with NO alternate path (A→D is not redundant),
    // so it survives reduction and must get a route. (A and B both sit at rank 0.)
    const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W), makeNode("D", W)];
    const edges = [makeEdge("B", "C"), makeEdge("C", "D"), makeEdge("A", "D")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    expect(r.longEdgeRoutes.has("A->D")).toBe(true);
    // The short edges never get a route key.
    expect(r.longEdgeRoutes.has("B->C")).toBe(false);
    expect(r.longEdgeRoutes.has("C->D")).toBe(false);
  });

  it("case S8: a pure dist-1 graph has an empty longEdgeRoutes", () => {
    const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W)];
    const edges = [makeEdge("A", "B"), makeEdge("B", "C")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    expect(r.longEdgeRoutes.size).toBe(0);
  });

  it("case S9: a redundant direct edge is reported in redundantEdges, never routed", () => {
    // C1→C2, C2→C5 chain (ranks 0/1/2); the direct C1→C5 is REDUNDANT (the
    // chain already implies it) → it goes into redundantEdges, NOT the chain
    // edges, and is NOT routed (the reduced set drives long-edge routing).
    const nodes = [makeNode("C1", W), makeNode("C2", W), makeNode("C5", W)];
    const edges = [makeEdge("C1", "C2"), makeEdge("C2", "C5"), makeEdge("C1", "C5")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    if (r.mode !== "structure") throw new Error("expected structure mode");
    expect(r.redundantEdges.has("C1->C5")).toBe(true);
    expect(r.redundantEdges.has("C1->C2")).toBe(false);
    expect(r.redundantEdges.has("C2->C5")).toBe(false);
    // The redundant edge is hidden from routing.
    expect(r.longEdgeRoutes.has("C1->C5")).toBe(false);
    // Node x is UNCHANGED: ranks stay full-based, so C5 sits at rank 2.
    expect(r.positions.get("C5")!.x).toBe(STRUCTURE_X_PAD + 2 * STRUCTURE_X_GAP);
  });

  it("case S10: a diamond has no redundant edges", () => {
    // A→B, A→C, B→D, C→D: no direct edge restates another path → empty.
    const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W), makeNode("D", W)];
    const edges = [makeEdge("A", "B"), makeEdge("A", "C"), makeEdge("B", "D"), makeEdge("C", "D")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    if (r.mode !== "structure") throw new Error("expected structure mode");
    expect(r.redundantEdges.size).toBe(0);
  });

  // ── Independent-epic tray (change B) ────────────────────────────

  it("case T1: adding isolated nodes never perturbs connected geometry (the real partition invariant)", () => {
    // A→B→C is a pure dependency chain. Capture each connected node's full
    // {x,y,lane} with NO isolated nodes present.
    const connOnly = [makeNode("A", W), makeNode("B", W), makeNode("C", W)];
    const connEdges = [makeEdge("A", "B"), makeEdge("B", "C")];
    const base = computeEpicGraphLayout(connOnly, connEdges, {
      now: NOW,
      mode: "structure" as const,
    });
    if (base.mode !== "structure") throw new Error("expected structure mode");
    const baseGeom = (id: string) => {
      const p = base.positions.get(id)!;
      return { x: p.x, y: p.y, lane: p.lane };
    };

    // Now add 3 ISOLATED nodes (no edges) and re-layout. Connected geometry must
    // be BYTE-IDENTICAL (they're partitioned out before the DAG pipeline runs).
    const withIso = [...connOnly, makeNode("I1", W), makeNode("I2", W), makeNode("I3", W)];
    const r = computeEpicGraphLayout(withIso, connEdges, { now: NOW, mode: "structure" as const });
    if (r.mode !== "structure") throw new Error("expected structure mode");
    for (const id of ["A", "B", "C"]) {
      const p = r.positions.get(id)!;
      expect({ x: p.x, y: p.y, lane: p.lane }).toEqual(baseGeom(id));
    }
  });

  it("case T2: isolated nodes land below the DAG in a non-null tray", () => {
    const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W), makeNode("D", W)];
    const edges = [makeEdge("A", "B")]; // A,B connected; C,D isolated
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    if (r.mode !== "structure") throw new Error("expected structure mode");
    const dagMaxY = Math.max(r.positions.get("A")!.y, r.positions.get("B")!.y);
    expect(r.positions.get("C")!.y).toBeGreaterThan(dagMaxY);
    expect(r.positions.get("D")!.y).toBeGreaterThan(dagMaxY);
    expect(r.tray).not.toBeNull();
    expect(r.tray!.count).toBe(2);
    expect(r.tray!.topY).toBeGreaterThan(dagMaxY);
    expect(r.tray!.leftX).toBe(STRUCTURE_X_PAD);
  });

  it("case T3: all-isolated — no DAG, every node in the tray, topY=0, finite geometry", () => {
    const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W)];
    const r = computeEpicGraphLayout(nodes, [], { now: NOW, mode: "structure" as const });
    if (r.mode !== "structure") throw new Error("expected structure mode");
    expect(r.tray).not.toBeNull();
    expect(r.tray!.count).toBe(3);
    expect(r.tray!.topY).toBe(0); // empty DAG pins the tray at the origin
    expect(Number.isFinite(r.tray!.leftX)).toBe(true);
    expect(Number.isFinite(r.tray!.rightX)).toBe(true);
    for (const id of ["A", "B", "C"]) {
      const p = r.positions.get(id)!;
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(r.laneCount).toBe(0);
    expect(r.backwardsEdges).toEqual([]);
  });

  it("case T4: an isolated node's merged position is NOT the origin", () => {
    // A→B connected + isolated C. C's position comes from the tray grid merged
    // into `positions` — proving it's not left at a default {x:0,y:0}.
    const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W)];
    const edges = [makeEdge("A", "B")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    if (r.mode !== "structure") throw new Error("expected structure mode");
    const c = r.positions.get("C")!;
    expect(c.x === 0 && c.y === 0).toBe(false);
    expect(c.y).toBeGreaterThan(0);
  });

  it("case T5: a relates_to edge keeps both nodes in the DAG (not the tray)", () => {
    // A,B joined only by relates_to (no blocks) → still CONNECTED (in an edge),
    // so they stay in the DAG; isolated C is the only tray member.
    const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W)];
    const edges = [makeEdge("A", "B", "relates_to")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    if (r.mode !== "structure") throw new Error("expected structure mode");
    expect(r.tray).not.toBeNull();
    expect(r.tray!.count).toBe(1); // only C
  });

  it("case T6: an all-connected graph has a null tray", () => {
    const nodes = [makeNode("A", W), makeNode("B", W), makeNode("C", W)];
    const edges = [makeEdge("A", "B"), makeEdge("B", "C")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    if (r.mode !== "structure") throw new Error("expected structure mode");
    expect(r.tray).toBeNull();
  });

  it("case T7: determinism with a tray — shuffled mixed graph yields equal positions + tray", () => {
    const mk = () => [
      makeNode("A", W),
      makeNode("B", W),
      makeNode("I1", W),
      makeNode("I2", W),
      makeNode("I3", W),
    ];
    const edges = [makeEdge("A", "B")];
    const r1 = computeEpicGraphLayout(mk(), edges, { now: NOW, mode: "structure" as const });
    const shuffled = [
      makeNode("I3", W),
      makeNode("B", W),
      makeNode("I1", W),
      makeNode("A", W),
      makeNode("I2", W),
    ];
    const r2 = computeEpicGraphLayout(shuffled, edges, { now: NOW, mode: "structure" as const });
    if (r1.mode !== "structure" || r2.mode !== "structure")
      throw new Error("expected structure mode");
    expect(sortedEntries(r1)).toEqual(sortedEntries(r2));
    expect(r1.tray).toEqual(r2.tray);
  });

  it("case T8: a ghost edge (absent endpoint) does NOT connect its present node — it falls to the tray", () => {
    // P→GHOST where GHOST isn't in the node set: P has no edge with both
    // endpoints present, so P is ISOLATED, not stranded out of the layout.
    const nodes = [makeNode("P", W)];
    const edges = [makeEdge("P", "GHOST")];
    const r = computeEpicGraphLayout(nodes, edges, { now: NOW, mode: "structure" as const });
    if (r.mode !== "structure") throw new Error("expected structure mode");
    expect(r.tray).not.toBeNull();
    expect(r.tray!.count).toBe(1);
    expect(r.positions.has("P")).toBe(true);
  });
});
