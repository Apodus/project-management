import type { EpicGraphEdge, EpicGraphNode } from "./api";

/**
 * Pure, deterministic topological RANK assignment over the epic `blocks`
 * sub-DAG, for the structure-mode roadmap layout (C1).
 *
 * Each node is assigned a 0-based integer layer index ("rank") such that for
 * every retained `blocks` edge `from -> to` (prerequisite -> dependent),
 * `rank(from) < rank(to)`. Rank is the LONGEST path from any source — so a
 * dependent sits one layer to the right of its deepest prerequisite, never
 * floating left of work it depends on. Downstream (P3+) maps rank to an x lane.
 *
 * Only `blocks` edges constrain rank. `relates_to` edges are rendered but carry
 * no ordering and are ignored here entirely. Self-loops and edges touching an
 * absent node are filtered out, never crash, and never produce a back-edge.
 *
 * Cycles. The dependency graph is NOT guaranteed acyclic. Before ranking we
 * DAG-ify by deleting a minimal-by-construction set of back-edges found via a
 * deterministic 3-color DFS (roots and successor lists both sorted by id). The
 * dropped edges are returned in `excludedBackEdges` (sorted by `(from, to)`) so
 * the renderer can draw them as "backwards" arcs; the retained `forwardEdges`
 * are a true DAG over which the longest-path rank is well-defined.
 *
 * DELIBERATE ROADMAP DEVIATION. The roadmap specified "DAG-ify by consuming the
 * server's `cycles`." We INTENTIONALLY re-detect cycles client-side via DFS
 * instead: the server's `cycles` is a list of rotation-canonical node
 * *sequences* (`string[][]`), not edge identities — it names which nodes form a
 * cycle but does NOT name an excludable EDGE. Rank assignment needs to drop a
 * specific edge, which the sequence form cannot provide. So the departure is
 * required, not cosmetic.
 *
 * P6 HANDOFF (do not be blindsided). This module's DFS back-edge selection
 * (roots + successors sorted by id, traversed over ALL nodes) may pick a
 * DIFFERENT edge of a cycle than the server's cycle-banner detection (which
 * runs DFS over residual nodes only, in epic-list order, with UNSORTED
 * successors). Both are valid members of the same cycle, so both are correct —
 * but the amber back-edge this module marks for rendering need not coincide
 * with the edge implied by the cycle banner. This is invisible in P2 (which
 * renders nothing). P6 owns reconciling the rendered amber back-edge with the
 * cycle banner so an operator sees one consistent story.
 *
 * Determinism is a correctness requirement: NO Date.now / Math.random / new
 * Date, no clock, no `opts`. Every traversal seed and node loop iterates a
 * sorted id universe (`orderedIds`); successor lists are rebuilt-then-sorted by
 * id; output is identical regardless of input array order.
 */

/** A `blocks` edge dropped to break a cycle. `from`=prerequisite, `to`=dependent. */
export interface BackEdge {
  from: string;
  to: string;
}

export interface RankResult {
  /** node id -> 0-based integer layer index (longest-path rank). */
  ranks: Map<string, number>;
  /**
   * The deepest layer index present.
   *
   * Convention: `-1` ONLY when the node set is empty. Because every node is
   * seeded at rank 0, a non-empty graph with no forward `blocks` edges has
   * `maxRank === 0` (NOT -1) — every node simply sits on layer 0.
   */
  maxRank: number;
  /** `blocks` edges dropped to DAG-ify, sorted by `(from, to)`. */
  excludedBackEdges: BackEdge[];
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/**
 * Assign a longest-path topological rank to every node over the `blocks`
 * sub-DAG, re-detecting and excluding cycle back-edges deterministically.
 *
 * @see RankResult.maxRank for the empty-vs-no-edges `-1`/`0` convention.
 */
export function computeRanks(nodes: EpicGraphNode[], edges: EpicGraphEdge[]): RankResult {
  // Step 1: stable universe. Every traversal seed / node loop iterates
  // `orderedIds`, never the raw input order.
  const nodeIds = nodes.map((n) => n.id);
  const nodeSet = new Set(nodeIds);
  const orderedIds = [...nodeIds].sort();

  // Step 2: filter to the blocks sub-DAG candidate edge set. Keep `blocks`
  // edges whose endpoints both exist and which are not self-loops; dedupe.
  const seen = new Set<string>();
  const blocksEdges: BackEdge[] = [];
  for (const e of edges) {
    if (e.dependency_type !== "blocks") continue;
    if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    if (e.from === e.to) continue;
    const key = `${e.from}|${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blocksEdges.push({ from: e.from, to: e.to });
  }

  // Step 3: DAG-ify via deterministic 3-color DFS. Build adjacency, then sort
  // each successor list by id (rebuild-then-sort — never rely on insertion
  // order). Iterate roots in `orderedIds` order.
  const adj = new Map<string, string[]>();
  for (const id of orderedIds) adj.set(id, []);
  for (const e of blocksEdges) adj.get(e.from)!.push(e.to);
  for (const succ of adj.values()) succ.sort();

  const excludedKeys = new Set<string>();
  const excludedBackEdges: BackEdge[] = [];
  const color = new Map<string, number>();
  for (const id of orderedIds) color.set(id, WHITE);

  // Explicit-stack iterative DFS. Each stack frame tracks its successor cursor;
  // a node is colored GRAY on entry and BLACK once its successors are exhausted.
  for (const root of orderedIds) {
    if (color.get(root) !== WHITE) continue;
    const stack: { node: string; index: number }[] = [{ node: root, index: 0 }];
    color.set(root, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const succ = adj.get(frame.node)!;
      if (frame.index < succ.length) {
        const v = succ[frame.index];
        frame.index++;
        const cv = color.get(v);
        if (cv === GRAY) {
          // `frame.node -> v` closes a cycle: it is a back-edge.
          const key = `${frame.node}|${v}`;
          if (!excludedKeys.has(key)) {
            excludedKeys.add(key);
            excludedBackEdges.push({ from: frame.node, to: v });
          }
        } else if (cv === WHITE) {
          color.set(v, GRAY);
          stack.push({ node: v, index: 0 });
        }
        // BLACK -> already finished, skip.
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
      }
    }
  }

  const forwardEdges = blocksEdges.filter((e) => !excludedKeys.has(`${e.from}|${e.to}`));

  // Step 4: longest-path rank via Kahn over forwardEdges. Seed every node at 0.
  const ranks = new Map<string, number>();
  for (const id of orderedIds) ranks.set(id, 0);

  const fwd = new Map<string, string[]>();
  for (const id of orderedIds) fwd.set(id, []);
  const indegree = new Map<string, number>();
  for (const id of orderedIds) indegree.set(id, 0);
  for (const e of forwardEdges) {
    fwd.get(e.from)!.push(e.to);
    indegree.set(e.to, indegree.get(e.to)! + 1);
  }
  for (const succ of fwd.values()) succ.sort();

  const queue: string[] = [];
  for (const id of orderedIds) if (indegree.get(id) === 0) queue.push(id);

  // FIFO over a head cursor (queue is a true DAG, every node dequeued once).
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    const ru = ranks.get(u)!;
    for (const v of fwd.get(u)!) {
      if (ru + 1 > ranks.get(v)!) ranks.set(v, ru + 1);
      const d = indegree.get(v)! - 1;
      indegree.set(v, d);
      if (d === 0) queue.push(v);
    }
  }

  // Step 5: sort excluded back-edges by (from, to) — matching the
  // `backwardsEdges` comparator style in epic-graph-layout.ts.
  excludedBackEdges.sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  );

  // CORRECTION 1: -1 only for an empty node set; otherwise max over the (all
  // 0-seeded) rank values, so a node-bearing edgeless graph yields 0.
  const maxRank = nodes.length === 0 ? -1 : Math.max(...ranks.values());

  return { ranks, maxRank, excludedBackEdges };
}
