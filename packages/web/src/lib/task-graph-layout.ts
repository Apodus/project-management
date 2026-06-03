import type { TaskGraphEdge, TaskGraphNode } from "./api";

/**
 * Pure, deterministic layered layout for the epic's task mini-DAG.
 *
 * Tasks have no time axis (unlike the epic timeline), so x is owned by
 * dependency DEPTH: a task's layer is one past its deepest `blocks` prerequisite
 * (longest-path layering). y packs tasks within a layer by stable id order. The
 * sibling epic-graph layout owns time-on-x; this owns topology-on-x.
 *
 * `relates_to` is a non-ordering relationship — it is rendered as an edge by the
 * caller but DOES NOT influence layering here. Only `blocks` imposes order.
 *
 * Determinism is a correctness requirement: NO Date.now / Math.random. Layering
 * is a memoized DFS with a GRAY in-progress guard so a dependency CYCLE (a
 * back-edge) is skipped rather than recursed — guaranteeing termination and
 * finite layers for every node. Within a layer ids are stable-sorted and
 * `positions` is populated in that stable order.
 */

export interface TaskLayoutOptions {
  layerWidth?: number;
  rowHeight?: number;
}

export interface TaskNodePosition {
  x: number;
  y: number;
  layer: number;
}

export interface TaskLayoutResult {
  positions: Map<string, TaskNodePosition>;
  layerCount: number;
}

export function computeTaskGraphLayout(
  nodes: TaskGraphNode[],
  edges: TaskGraphEdge[],
  opts?: TaskLayoutOptions,
): TaskLayoutResult {
  const layerWidth = opts?.layerWidth ?? 240;
  // rowHeight is the vertical PITCH between same-layer tasks. The rendered
  // TaskNode is ~86px tall (a 2-line clamped title + badge row + py-2), so a
  // pitch below that overlaps independent tasks. 104 clears the node with a
  // comfortable gap, matching the horizontal headroom (240 pitch / 180 node).
  const rowHeight = opts?.rowHeight ?? 104;

  const nodeIds = new Set(nodes.map((n) => n.id));

  // prereqs: taskId -> the ids that must land BEFORE it (its `blocks`-prereqs).
  // `from` is the prerequisite, `to` is the dependent. `relates_to` is ignored.
  // Edges touching an absent node are skipped (never crash).
  const prereqs = new Map<string, string[]>();
  for (const id of nodeIds) prereqs.set(id, []);
  for (const edge of edges) {
    if (edge.dependency_type !== "blocks") continue;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    prereqs.get(edge.to)!.push(edge.from);
  }

  // Memoized DFS longest-path layering with a gray/done cycle guard.
  const memo = new Map<string, number>();
  const state = new Map<string, "gray" | "done">();

  function layer(t: string): number {
    const cached = memo.get(t);
    if (cached !== undefined) return cached;
    state.set(t, "gray");
    let best = 0;
    for (const p of prereqs.get(t) ?? []) {
      // A gray prerequisite is a back-edge in a cycle: SKIP it (do not recurse)
      // so layering always terminates.
      if (state.get(p) === "gray") continue;
      const pl = layer(p);
      if (pl + 1 > best) best = pl + 1;
    }
    // Write the memo only AFTER all prerequisites resolve.
    memo.set(t, best);
    state.set(t, "done");
    return best;
  }

  for (const n of nodes) layer(n.id);

  // Group ids by layer, stable-sort within each layer by id, then place.
  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = memo.get(n.id)!;
    const bucket = byLayer.get(l);
    if (bucket) bucket.push(n.id);
    else byLayer.set(l, [n.id]);
  }

  const positions = new Map<string, TaskNodePosition>();
  // Populate in stable order: layer asc, then id asc within the layer.
  const sortedLayers = [...byLayer.keys()].sort((a, b) => a - b);
  let maxLayer = -1;
  for (const l of sortedLayers) {
    const ids = byLayer.get(l)!;
    ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    ids.forEach((id, index) => {
      positions.set(id, {
        x: l * layerWidth,
        y: index * rowHeight,
        layer: l,
      });
    });
    if (l > maxLayer) maxLayer = l;
  }

  return { positions, layerCount: nodes.length === 0 ? 0 : maxLayer + 1 };
}
