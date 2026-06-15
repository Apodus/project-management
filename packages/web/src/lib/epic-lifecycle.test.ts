import { describe, expect, it } from "vitest";
import type { EpicGraphEdge, EpicGraphNode } from "./api";
import { actionableNow, lifecycle, type Lifecycle } from "./epic-lifecycle";

type Health = EpicGraphNode["health"];

const ALL_HEALTH: Health[] = ["not_started", "on_track", "at_risk", "blocked", "done"];

function makeNode(
  id: string,
  opts: { health: Health; status?: string },
): Pick<EpicGraphNode, "id" | "health" | "status"> {
  return { id, health: opts.health, status: opts.status ?? "active" };
}

function makeEdge(
  from: string,
  to: string,
  type: "blocks" | "relates_to" = "blocks",
): Pick<EpicGraphEdge, "from" | "to" | "dependency_type"> {
  return { from, to, dependency_type: type };
}

/** Stable, comparable view of a Set for order-independent assertions. */
function sorted(s: Set<string>): string[] {
  return [...s].sort();
}

describe("lifecycle — done/active/future derivation", () => {
  it("L1: health 'done' is done for any status", () => {
    expect(lifecycle(makeNode("a", { health: "done", status: "active" }))).toBe("done");
    expect(lifecycle(makeNode("a", { health: "done", status: "completed" }))).toBe("done");
    expect(lifecycle(makeNode("a", { health: "done", status: "whatever" }))).toBe("done");
  });

  it("L2: status 'completed' + health 'on_track' is done", () => {
    expect(lifecycle(makeNode("a", { health: "on_track", status: "completed" }))).toBe("done");
  });

  it("L3: status 'completed' + health 'not_started' is done (done beats future)", () => {
    expect(lifecycle(makeNode("a", { health: "not_started", status: "completed" }))).toBe("done");
  });

  it("L4: health 'not_started' + status 'active' is future", () => {
    expect(lifecycle(makeNode("a", { health: "not_started", status: "active" }))).toBe("future");
  });

  it("L5: in-flight healths with status 'active' are active", () => {
    for (const health of ["on_track", "at_risk", "blocked"] as Health[]) {
      expect(lifecycle(makeNode("a", { health, status: "active" }))).toBe("active");
    }
  });

  it("L6: total — every health × {active,completed} maps to one literal by precedence", () => {
    const literals: Lifecycle[] = ["done", "active", "future"];
    for (const health of ALL_HEALTH) {
      for (const status of ["active", "completed"]) {
        const got = lifecycle(makeNode("a", { health, status }));
        expect(literals).toContain(got);
        // Re-derive the expected precedence independently.
        const expected: Lifecycle =
          health === "done" || status === "completed"
            ? "done"
            : health === "not_started"
              ? "future"
              : "active";
        expect(got).toBe(expected);
      }
    }
  });
});

describe("actionableNow — active epics with all blocks-prereqs done", () => {
  it("A1: all prereqs done → dependent actionable, prereqs themselves not", () => {
    const r = actionableNow(
      [
        makeNode("P1", { health: "done" }),
        makeNode("P2", { health: "done" }),
        makeNode("D", { health: "on_track" }),
      ],
      [makeEdge("P1", "D"), makeEdge("P2", "D")],
    );
    expect(sorted(r)).toEqual(["D"]);
  });

  it("A2: a non-done prereq blocks the dependent", () => {
    const r = actionableNow(
      [
        makeNode("P1", { health: "done" }),
        makeNode("P2", { health: "on_track" }),
        makeNode("D", { health: "on_track" }),
      ],
      [makeEdge("P1", "D"), makeEdge("P2", "D")],
    );
    // D is gated by the incomplete P2; P2 itself (no prereqs) is actionable.
    expect(r.has("D")).toBe(false);
    expect(sorted(r)).toEqual(["P2"]);
  });

  it("A3: a lone active node with no edges is actionable; a future node is not", () => {
    expect(sorted(actionableNow([makeNode("A", { health: "on_track" })], []))).toEqual(["A"]);
    expect(sorted(actionableNow([makeNode("F", { health: "not_started" })], []))).toEqual([]);
  });

  it("A4: a live cycle is never actionable; freeing one member unblocks the other", () => {
    const cycleEdges = [makeEdge("A", "B"), makeEdge("B", "A")];
    const live = actionableNow(
      [makeNode("A", { health: "on_track" }), makeNode("B", { health: "on_track" })],
      cycleEdges,
    );
    expect(sorted(live)).toEqual([]);

    // B done → A's only prereq is satisfied → A actionable (B itself is done, not active).
    const freed = actionableNow(
      [makeNode("A", { health: "on_track" }), makeNode("B", { health: "done" })],
      cycleEdges,
    );
    expect(sorted(freed)).toEqual(["A"]);
  });

  it("A6: equivalence guard — for every active node, member ⟺ health !== 'blocked' (server-consistent fixture)", () => {
    // Server-CONSISTENT fixture: an epic gated by an incomplete blocks-prereq
    // has health 'blocked'; completed prereqs are 'done'; ungated live work is
    // 'on_track'/'at_risk'. No impossible nodes (e.g. on_track+completed).
    const nodes = [
      makeNode("done1", { health: "done" }),
      makeNode("done2", { health: "done", status: "completed" }),
      makeNode("future1", { health: "not_started" }),
      // ungated active work (all prereqs done or none) → not blocked
      makeNode("free1", { health: "on_track" }),
      makeNode("free2", { health: "at_risk" }),
      // gated active work (an incomplete prereq) → server health 'blocked'
      makeNode("gated1", { health: "blocked" }),
      makeNode("gated2", { health: "blocked" }),
    ];
    const edges = [
      makeEdge("done1", "free1"), // free1's prereq done → not blocked, actionable
      makeEdge("done1", "free2"),
      makeEdge("done2", "free2"),
      makeEdge("future1", "gated1"), // gated1 blocked by future work
      makeEdge("gated1", "gated2"), // gated2 blocked by gated1 (also blocked)
    ];
    const result = actionableNow(nodes, edges);
    for (const n of nodes) {
      if (lifecycle(n) !== "active") continue;
      const member = result.has(n.id);
      expect(member).toBe(n.health !== "blocked");
    }
  });

  it("A7: an edge from an absent node is skipped (dependent stays actionable)", () => {
    const r = actionableNow([makeNode("D", { health: "on_track" })], [makeEdge("GHOST", "D")]);
    expect(sorted(r)).toEqual(["D"]);
  });

  it("A8: a self-loop is skipped (the active node is actionable)", () => {
    const r = actionableNow([makeNode("A", { health: "on_track" })], [makeEdge("A", "A")]);
    expect(sorted(r)).toEqual(["A"]);
  });

  it("A9: a relates_to prereq never gates (dependent actionable despite non-done prereq)", () => {
    const r = actionableNow(
      [makeNode("P", { health: "on_track" }), makeNode("D", { health: "on_track" })],
      [makeEdge("P", "D", "relates_to")],
    );
    // D actionable (relates_to ignored); P actionable too (no blocks prereqs).
    expect(sorted(r)).toEqual(["D", "P"]);
  });

  it("A10: deterministic — shuffling both arrays yields an identical Set", () => {
    const nodes = [
      makeNode("P1", { health: "done" }),
      makeNode("P2", { health: "on_track" }),
      makeNode("D1", { health: "on_track" }),
      makeNode("D2", { health: "on_track" }),
      makeNode("Iso", { health: "at_risk" }),
    ];
    const edges = [makeEdge("P1", "D1"), makeEdge("P2", "D2"), makeEdge("P1", "D2", "relates_to")];
    const shuffledNodes = [nodes[4], nodes[1], nodes[3], nodes[0], nodes[2]];
    const shuffledEdges = [edges[2], edges[0], edges[1]];

    const r1 = actionableNow(nodes, edges);
    const r2 = actionableNow(shuffledNodes, shuffledEdges);
    expect(sorted(r1)).toEqual(sorted(r2));
  });

  it("A11: empty input → empty Set", () => {
    expect(actionableNow([], []).size).toBe(0);
  });
});
