import type { BackEdge } from "./epic-graph-rank";

/**
 * Pure, deterministic vertical-coordinate (y) solver for the structure-mode
 * roadmap layout (C1.P1). Given the crossing-minimized `layers` permutation
 * (from {@link computeOrder}) and the surviving `forwardEdges` (from
 * {@link computeRanks}), it assigns each node a y so that dependents sit close
 * to (ideally aligned with) their prerequisites, while preserving within-layer
 * order and a minimum vertical gap. x and lane are owned by the caller; this
 * module touches ONLY y.
 *
 * DETERMINISM DOCTRINE (a correctness requirement). NO Date.now / Math.random /
 * new Date — no clock at all. Identical `(layers, forwardEdges, opts)` produce
 * an identical Map regardless of input array order:
 *   - `layers` is the canonical crossing-min permutation and is consumed
 *     AS-GIVEN — never re-sorted (re-sorting would discard P3's work).
 *   - medians are computed over NUMERIC neighbor-y values, so they do not depend
 *     on the order edges arrive in (sorting numbers is order-independent).
 *   - the balanced down/up resolution is purely a function of the per-layer
 *     `desired[]` vector, which itself is order-independent.
 *
 * BALANCED RESOLUTION (the readability lever). A node's desired y is the median
 * of its adjacent-rank neighbors' y (prereqs on the down-sweep, dependents on
 * the up-sweep). Naively snapping to the desired y would overlap siblings, so we
 * resolve a layer with a down pass (top-anchored min-gap, pushing DOWN) AND an
 * up pass (bottom-anchored min-gap, pushing UP) and AVERAGE them. The average of
 * two arrangements that each preserve order and each preserve a >= rowHeight gap
 * also preserves order and a >= rowHeight gap (the average of two values each
 * >= g is >= g) — so the result is non-overlapping, order-preserving, and
 * crucially NOT top-heavy: a single down-only push forces a chain of nodes below
 * their desired y (a systematic downward inversion); balancing halves the
 * worst-case displacement. For a single-prereq dependent alone in its layer
 * (n=1) the down and up passes both collapse to `desired`, so the dependent
 * lands EXACTLY on its prerequisite's y (zero alignment displacement).
 */

export interface CoordOptions {
  /** Minimum vertical gap between adjacent nodes within a layer (px). */
  rowHeight: number;
  /** Down+up sweep count. Default 6. More sweeps propagate alignment further. */
  iterations?: number;
}

/**
 * Numeric median of a list of neighbor y-values.
 *
 * Returns `null` for an empty list — the caller reads that as "no adjacent-rank
 * neighbor, keep current y". For a non-empty list: sort numerically, odd length
 * → the middle value, even length → the average of the two middle values.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Assign a y coordinate to every node id present in `layers`.
 *
 * @param layers        order.layers — the crossing-min permutation, consumed
 *                       as-is (never re-sorted). `layers[r]` is rank r,
 *                       index 0 = topmost.
 * @param forwardEdges  rank.forwardEdges — `from`=prerequisite, `to`=dependent.
 * @param opts          `{ rowHeight, iterations? }`.
 * @returns             Map of node id → y.
 */
export function assignCoordinates(
  layers: string[][],
  forwardEdges: BackEdge[],
  opts: CoordOptions,
): Map<string, number> {
  const { rowHeight } = opts;
  const iterations = opts.iterations ?? 6;

  // Rank + order index by walking `layers` (canonical, never re-sorted).
  const rankOf = new Map<string, number>();
  const orderOf = new Map<string, number>();
  for (let r = 0; r < layers.length; r++) {
    const layer = layers[r];
    for (let o = 0; o < layer.length; o++) {
      rankOf.set(layer[o], r);
      orderOf.set(layer[o], o);
    }
  }

  // Seed: each node at its order * rowHeight (a clean, non-overlapping start).
  const y = new Map<string, number>();
  for (const [id, o] of orderOf) y.set(id, o * rowHeight);

  // Adjacent-rank adjacency. Only edges whose endpoints are exactly one rank
  // apart contribute to a median; long-span edges (dist > 1) contribute to NO
  // median (a P2 concern — no virtual nodes here).
  const leftNeighbors = new Map<string, string[]>(); // dependent -> its prereqs one rank LEFT
  const rightNeighbors = new Map<string, string[]>(); // prereq -> its dependents one rank RIGHT
  for (const [id] of orderOf) {
    leftNeighbors.set(id, []);
    rightNeighbors.set(id, []);
  }
  for (const e of forwardEdges) {
    const rf = rankOf.get(e.from);
    const rt = rankOf.get(e.to);
    if (rf === undefined || rt === undefined) continue;
    if (rt - rf === 1) {
      leftNeighbors.get(e.to)!.push(e.from);
      rightNeighbors.get(e.from)!.push(e.to);
    }
  }

  // Place one layer: desired y = median of neighbors (null → keep current), then
  // a top-anchored down pass and bottom-anchored up pass, averaged. See the
  // module header for why averaging preserves order + min-gap and kills the
  // top-heavy inversion of a monotone-only resolution.
  const placeLayer = (r: number, neighborsOf: Map<string, string[]>): void => {
    const layer = layers[r];
    const n = layer.length;
    if (n === 0) return;

    const desired: number[] = new Array(n);
    for (let o = 0; o < n; o++) {
      const id = layer[o];
      const m = median(neighborsOf.get(id)!.map((nb) => y.get(nb)!));
      desired[o] = m ?? y.get(id)!;
    }

    // Down pass: enforce min-gap pushing DOWN (top-anchored).
    const down: number[] = new Array(n);
    let prev = -Infinity;
    for (let o = 0; o < n; o++) {
      down[o] = Math.max(desired[o], prev + rowHeight);
      prev = down[o];
    }

    // Up pass: enforce min-gap pushing UP (bottom-anchored).
    const up: number[] = new Array(n);
    let next = +Infinity;
    for (let o = n - 1; o >= 0; o--) {
      up[o] = Math.min(desired[o], next - rowHeight);
      next = up[o];
    }

    // Average — balanced, order-preserving, min-gap-preserving.
    for (let o = 0; o < n; o++) {
      y.set(layer[o], (down[o] + up[o]) / 2);
    }
  };

  // Sweeps: each iteration aligns dependents to prereqs (down-sweep, left
  // neighbors) then prereqs to dependents (up-sweep, right neighbors).
  const maxR = layers.length - 1;
  for (let it = 0; it < iterations; it++) {
    for (let r = 0; r <= maxR; r++) placeLayer(r, leftNeighbors);
    for (let r = maxR; r >= 0; r--) placeLayer(r, rightNeighbors);
  }

  return y;
}
