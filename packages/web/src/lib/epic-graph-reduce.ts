import type { BackEdge } from "./epic-graph-rank";

/**
 * Pure, deterministic TRANSITIVE REDUCTION of the epic `blocks` sub-DAG.
 *
 * A direct edge `u -> v` is REDUNDANT when a LONGER path `u -> … -> v` already
 * exists: the direct edge carries no extra ordering (the longer path already
 * forces `rank(u) < rank(v)`). The roadmap renderer hides redundant edges by
 * default so the DAG isn't cluttered by long "detour" arcs that merely restate
 * a constraint the visible chain already implies; a "Show all dependencies"
 * toggle reveals them faint.
 *
 * The input MUST be a true DAG (the cycle-broken `rank.forwardEdges`). Over a
 * DAG the transitive reduction is UNIQUE and exact, computed here as:
 *   1. Build an adjacency list from `forwardEdges` (successor lists sorted by id).
 *   2. `reach(u)` = every node reachable from `u` over forward edges (EXCLUDING
 *      `u` itself). Computed ONCE per node up front — never incrementally as
 *      edges are removed, so the result is independent of removal order.
 *   3. Edge `(u, v)` is REDUNDANT iff there is ANOTHER out-edge `(u, w)` with
 *      `w !== v` and `reach(w)` contains `v` (then `u -> w -> … -> v` is an
 *      alternate, longer path to `v`).
 *   4. Partition into `reduced` (kept) + `redundant` (hidden), both sorted by
 *      `(from, to)` — matching the BackEdge sort convention used elsewhere.
 *
 * Determinism is a correctness requirement: NO Date.now / Math.random. `reach`
 * is set-based, so the redundancy test is order-independent; the output arrays
 * are explicitly sorted. Identical input (in any array order) → identical
 * `reduced` / `redundant`.
 */

export interface ReductionResult {
  /** Surviving edges (NOT redundant), sorted by `(from, to)`. */
  reduced: BackEdge[];
  /** Edges hidden because a longer path implies them, sorted by `(from, to)`. */
  redundant: BackEdge[];
}

const byFromTo = (a: BackEdge, b: BackEdge): number =>
  a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0;

export function transitiveReduction(forwardEdges: BackEdge[]): ReductionResult {
  // Step 1: adjacency. Successor lists sorted by id for stable traversal.
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const e of forwardEdges) {
    nodes.add(e.from);
    nodes.add(e.to);
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  for (const succ of adj.values()) succ.sort();

  // Step 2: reach(u) over forward edges, EXCLUDING u itself. Computed ONCE per
  // node via an iterative DFS — never recomputed as edges are dropped.
  const reach = new Map<string, Set<string>>();
  for (const u of nodes) {
    const visited = new Set<string>();
    const stack = [...(adj.get(u) ?? [])];
    while (stack.length > 0) {
      const v = stack.pop()!;
      if (visited.has(v)) continue;
      visited.add(v);
      for (const w of adj.get(v) ?? []) if (!visited.has(w)) stack.push(w);
    }
    reach.set(u, visited);
  }

  // Step 3 + 4: an edge (u, v) is redundant iff another out-edge (u, w), w != v,
  // already reaches v.
  const reduced: BackEdge[] = [];
  const redundant: BackEdge[] = [];
  for (const e of forwardEdges) {
    const succ = adj.get(e.from) ?? [];
    let isRedundant = false;
    for (const w of succ) {
      if (w === e.to) continue;
      if (reach.get(w)?.has(e.to)) {
        isRedundant = true;
        break;
      }
    }
    (isRedundant ? redundant : reduced).push({ from: e.from, to: e.to });
  }

  reduced.sort(byFromTo);
  redundant.sort(byFromTo);
  return { reduced, redundant };
}
