import { describe, expect, it } from "vitest";
import type { TaskGraphEdge, TaskGraphNode } from "./api";
import { computeTaskGraphLayout } from "./task-graph-layout";

function makeNode(id: string): TaskGraphNode {
  return {
    id,
    title: id,
    status: "backlog",
    priority: "medium",
    type: "feature",
    assignee_id: null,
    done: false,
  };
}

function makeEdge(
  from: string,
  to: string,
  type: "blocks" | "relates_to" = "blocks",
): TaskGraphEdge {
  return { from, to, dependency_type: type, provenance: "explicit" };
}

describe("computeTaskGraphLayout — layering", () => {
  it("case 1: a chain a->b->c lands on layers 0,1,2", () => {
    const r = computeTaskGraphLayout(
      [makeNode("a"), makeNode("b"), makeNode("c")],
      [makeEdge("a", "b"), makeEdge("b", "c")],
    );
    expect(r.positions.get("a")!.layer).toBe(0);
    expect(r.positions.get("b")!.layer).toBe(1);
    expect(r.positions.get("c")!.layer).toBe(2);
    expect(r.layerCount).toBe(3);
    // x is owned by layer at the default layerWidth.
    expect(r.positions.get("a")!.x).toBe(0);
    expect(r.positions.get("b")!.x).toBe(240);
    expect(r.positions.get("c")!.x).toBe(480);
  });

  it("case 2: a diamond a->{b,c}->d puts d at layer 2 (longest path)", () => {
    const r = computeTaskGraphLayout(
      [makeNode("a"), makeNode("b"), makeNode("c"), makeNode("d")],
      [makeEdge("a", "b"), makeEdge("a", "c"), makeEdge("b", "d"), makeEdge("c", "d")],
    );
    expect(r.positions.get("a")!.layer).toBe(0);
    expect(r.positions.get("b")!.layer).toBe(1);
    expect(r.positions.get("c")!.layer).toBe(1);
    expect(r.positions.get("d")!.layer).toBe(2);
    expect(r.layerCount).toBe(3);
  });

  it("case 3: isolated nodes all sit on layer 0 in distinct rows", () => {
    const r = computeTaskGraphLayout([makeNode("x"), makeNode("y"), makeNode("z")], []);
    expect(r.positions.get("x")!.layer).toBe(0);
    expect(r.positions.get("y")!.layer).toBe(0);
    expect(r.positions.get("z")!.layer).toBe(0);
    const ys = [r.positions.get("x")!.y, r.positions.get("y")!.y, r.positions.get("z")!.y];
    expect(new Set(ys).size).toBe(3);
    expect(ys).toEqual([0, 64, 128]); // stable id order x,y,z
    expect(r.layerCount).toBe(1);
  });
});

describe("computeTaskGraphLayout — cycles & termination", () => {
  it("case 4: a 2-cycle a->b->a terminates with finite layers for both", () => {
    const r = computeTaskGraphLayout(
      [makeNode("a"), makeNode("b")],
      [makeEdge("a", "b"), makeEdge("b", "a")],
    );
    expect(Number.isFinite(r.positions.get("a")!.layer)).toBe(true);
    expect(Number.isFinite(r.positions.get("b")!.layer)).toBe(true);
    expect(r.positions.size).toBe(2);
  });
});

describe("computeTaskGraphLayout — determinism", () => {
  it("case 5: shuffled input yields identical positions", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c"), makeNode("d")];
    const edges = [makeEdge("a", "b"), makeEdge("a", "c"), makeEdge("b", "d"), makeEdge("c", "d")];
    const r1 = computeTaskGraphLayout(nodes, edges);
    const r2 = computeTaskGraphLayout(
      [nodes[2], nodes[0], nodes[3], nodes[1]],
      [edges[3], edges[1], edges[0], edges[2]],
    );
    const entries = (r: ReturnType<typeof computeTaskGraphLayout>) =>
      [...r.positions.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(entries(r1)).toEqual(entries(r2));
    expect(r1.layerCount).toBe(r2.layerCount);
  });

  it("case 6: no two nodes share the same (x,y)", () => {
    const r = computeTaskGraphLayout(
      [makeNode("a"), makeNode("b"), makeNode("c"), makeNode("d"), makeNode("e")],
      [makeEdge("a", "b"), makeEdge("a", "c"), makeEdge("d", "e")],
    );
    const coords = [...r.positions.values()].map((p) => `${p.x},${p.y}`);
    expect(new Set(coords).size).toBe(coords.length);
  });
});

describe("computeTaskGraphLayout — edge cases", () => {
  it("case 7: empty input produces an empty layout, layerCount 0", () => {
    const r = computeTaskGraphLayout([], []);
    expect(r.positions.size).toBe(0);
    expect(r.layerCount).toBe(0);
  });

  it("case 8: a relates_to edge does NOT affect layering", () => {
    const r = computeTaskGraphLayout(
      [makeNode("a"), makeNode("b")],
      [makeEdge("a", "b", "relates_to")],
    );
    // No `blocks` prereq → both stay on layer 0.
    expect(r.positions.get("a")!.layer).toBe(0);
    expect(r.positions.get("b")!.layer).toBe(0);
    expect(r.layerCount).toBe(1);
  });
});
