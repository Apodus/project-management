import type { BackEdge, RankResult } from "./epic-graph-rank";

/**
 * Pure, deterministic WITHIN-LAYER ordering for the structure-mode roadmap
 * layout (C1.P3). Consumes a {@link RankResult} (rank per node + the surviving
 * `forwardEdges`) and assigns, within each rank, a left-to-right order that
 * minimizes edge crossings via a hand-rolled median + transpose heuristic — the
 * classic Sugiyama ordering pass, seeded id-sorted.
 *
 * The contract here (`OrderResult`, `countCrossings`, `computeOrder`) is the
 * SAME shape a dagre fallback would expose, so the renderer (P4) binds to one
 * surface regardless of which engine produced it.
 *
 * LONG-SPAN EDGES (to-rank − from-rank > 1) — EXPLICIT LIMITATION. The
 * hand-rolled path inserts NO virtual nodes. A long-span edge therefore
 * contributes to NEITHER a node's median NOR the crossing count; it is simply
 * passed through to be routed straight in P4. The committed fixtures contain no
 * long-span edges, so this gate says NOTHING about long-span behavior — that is
 * the documented boundary of the hand-rolled heuristic. A dagre adoption (if it
 * happens) handles long spans properly via virtual-node chains.
 *
 * Determinism is a correctness requirement: NO Date.now / Math.random / new
 * Date, no clock, no `opts`. Identical `(nodes, edges)` → identical `layers` and
 * `crossings` regardless of input array order. The seed is id-sorted within each
 * layer (NOT input order); every median tie breaks by id ascending; transpose
 * swaps ONLY on a STRICT crossing decrease (ties never swap). Best-tracking keeps
 * the lowest-crossing layering seen, preferring the EARLIER on a tie.
 */

export interface OrderResult {
  /** layers[r] = ordered node ids on rank r (index 0 = leftmost / topmost). */
  layers: string[][];
  /** node id -> its `{rank, order}` (order is the 0-based index within its layer). */
  positions: Map<string, { rank: number; order: number }>;
  /** total edge crossings of `layers` under `rank.forwardEdges` (long spans excluded). */
  crossings: number;
}

const MEDIAN_SWEEPS = 8;

/**
 * Count edge crossings of `layers` under `forwardEdges`, summed over each
 * adjacent layer pair (r, r+1). For a pair, take every forward edge whose
 * from-node is on rank r and to-node on rank r+1; for each unordered pair of
 * such edges, count a crossing iff their endpoints are inverted between the two
 * layers (the from-order delta and to-order delta have opposite signs). O(E²)
 * pairwise per layer — graphs are tiny.
 *
 * Long-span edges (to-rank − from-rank > 1) are EXCLUDED (see module header).
 * Edges are iterated in `forwardEdges`'s existing (from,to)-sorted order.
 */
export function countCrossings(layers: string[][], forwardEdges: BackEdge[]): number {
  // order index of each id within its layer.
  const order = new Map<string, number>();
  // rank of each id (the layer it lives in).
  const rankOf = new Map<string, number>();
  for (let r = 0; r < layers.length; r++) {
    const layer = layers[r];
    for (let o = 0; o < layer.length; o++) {
      order.set(layer[o], o);
      rankOf.set(layer[o], r);
    }
  }

  let total = 0;
  for (let r = 0; r + 1 < layers.length; r++) {
    // Edges strictly between rank r and r+1 (adjacent only).
    const pairEdges: BackEdge[] = [];
    for (const e of forwardEdges) {
      if (rankOf.get(e.from) === r && rankOf.get(e.to) === r + 1) {
        pairEdges.push(e);
      }
    }
    for (let i = 0; i < pairEdges.length; i++) {
      for (let j = i + 1; j < pairEdges.length; j++) {
        const a = pairEdges[i];
        const c = pairEdges[j];
        const fromDelta = order.get(a.from)! - order.get(c.from)!;
        const toDelta = order.get(a.to)! - order.get(c.to)!;
        if (fromDelta * toDelta < 0) total++;
      }
    }
  }
  return total;
}

/**
 * Assign a crossing-minimized within-layer order to every node.
 *
 * @see OrderResult for the returned shape and the long-span limitation.
 */
export function computeOrder(rank: RankResult): OrderResult {
  if (rank.maxRank === -1) {
    return { layers: [], positions: new Map(), crossings: 0 };
  }

  const forwardEdges = rank.forwardEdges;

  // Layer buckets, seeded by id ascending (the deterministic seed — NOT input
  // order). layers[r] = ids with rank r, for r in 0..maxRank.
  let layers: string[][] = [];
  for (let r = 0; r <= rank.maxRank; r++) layers.push([]);
  for (const [id, r] of rank.ranks) layers[r].push(id);
  for (const layer of layers) layer.sort();

  // Per-node adjacency (built once from forwardEdges; only adjacent-layer
  // endpoints matter for medians here — long spans are skipped per the header).
  const rankOf = new Map<string, number>();
  for (let r = 0; r < layers.length; r++) for (const id of layers[r]) rankOf.set(id, r);

  const upperNeighbors = new Map<string, string[]>(); // node -> neighbors one rank ABOVE
  const lowerNeighbors = new Map<string, string[]>(); // node -> neighbors one rank BELOW
  for (const [id] of rank.ranks) {
    upperNeighbors.set(id, []);
    lowerNeighbors.set(id, []);
  }
  for (const e of forwardEdges) {
    const rf = rankOf.get(e.from)!;
    const rt = rankOf.get(e.to)!;
    if (rt - rf === 1) {
      // e.to has e.from as an upper neighbor; e.from has e.to as a lower neighbor.
      upperNeighbors.get(e.to)!.push(e.from);
      lowerNeighbors.get(e.from)!.push(e.to);
    }
    // long-span (rt - rf > 1): contributes to neither median nor crossing.
  }

  const orderIndex = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const layer of layers) for (let o = 0; o < layer.length; o++) m.set(layer[o], o);
    return m;
  };

  // Median of a node's neighbor order-indices in the adjacent reference layer.
  // 0 neighbors -> sentinel = the node's CURRENT order index (pins it). odd ->
  // middle; even -> average of the two middle values.
  const median = (neighbors: string[], pos: Map<string, number>, currentOrder: number): number => {
    if (neighbors.length === 0) return currentOrder;
    const idx = neighbors.map((n) => pos.get(n)!).sort((a, b) => a - b);
    const mid = Math.floor(idx.length / 2);
    if (idx.length % 2 === 1) return idx[mid];
    return (idx[mid - 1] + idx[mid]) / 2;
  };

  // Re-sort a single layer by (median asc, id asc). Stable per the comparator.
  const sortLayerByMedian = (
    r: number,
    neighborsOf: Map<string, string[]>,
    pos: Map<string, number>,
  ): void => {
    const layer = layers[r];
    const med = new Map<string, number>();
    for (let o = 0; o < layer.length; o++) {
      med.set(layer[o], median(neighborsOf.get(layer[o])!, pos, o));
    }
    layer.sort((idA, idB) => {
      const medA = med.get(idA)!;
      const medB = med.get(idB)!;
      return medA !== medB ? medA - medB : idA < idB ? -1 : idA > idB ? 1 : 0;
    });
  };

  // Transpose: repeatedly, for each adjacent pair (u,v) in each layer, swap iff
  // it STRICTLY reduces total crossings. Ties never swap. Loop until a full pass
  // makes no improving swap.
  const transpose = (): void => {
    let improved = true;
    while (improved) {
      improved = false;
      let current = countCrossings(layers, forwardEdges);
      for (let r = 0; r < layers.length; r++) {
        const layer = layers[r];
        for (let i = 0; i + 1 < layer.length; i++) {
          // try swapping i and i+1
          [layer[i], layer[i + 1]] = [layer[i + 1], layer[i]];
          const after = countCrossings(layers, forwardEdges);
          if (after < current) {
            current = after;
            improved = true;
          } else {
            // revert (tie or worse never persists)
            [layer[i], layer[i + 1]] = [layer[i + 1], layer[i]];
          }
        }
      }
    }
  };

  const cloneLayers = (src: string[][]): string[][] => src.map((l) => [...l]);

  // Best-tracking: keep the lowest-crossing layering seen; on tie keep EARLIER.
  let bestLayers = cloneLayers(layers);
  let bestCrossings = countCrossings(layers, forwardEdges);

  for (let iter = 0; iter < MEDIAN_SWEEPS; iter++) {
    const pos = orderIndex();
    if (iter % 2 === 0) {
      // down-sweep: rank 0 -> max; medians from UPPER (r-1) neighbors.
      for (let r = 1; r < layers.length; r++) sortLayerByMedian(r, upperNeighbors, pos);
    } else {
      // up-sweep: max -> 0; medians from LOWER (r+1) neighbors.
      for (let r = layers.length - 2; r >= 0; r--) sortLayerByMedian(r, lowerNeighbors, pos);
    }
    transpose();
    const c = countCrossings(layers, forwardEdges);
    if (c < bestCrossings) {
      bestCrossings = c;
      bestLayers = cloneLayers(layers);
    }
  }

  layers = bestLayers;

  const positions = new Map<string, { rank: number; order: number }>();
  for (let r = 0; r < layers.length; r++) {
    for (let o = 0; o < layers[r].length; o++) {
      positions.set(layers[r][o], { rank: r, order: o });
    }
  }

  return { layers, positions, crossings: bestCrossings };
}
