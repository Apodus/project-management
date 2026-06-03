/**
 * Pure, deterministic grid layout for the structure-mode "Independent (no
 * dependencies)" tray — the epics with no `blocks`/`relates_to` edge, pulled
 * out of the dependency DAG and laid into a compact multi-column block below it.
 *
 * Determinism is a correctness requirement (matching epic-graph-layout.ts): NO
 * clock, NO Math.random. Ids are sorted before placement so the grid is stable
 * regardless of input order. The caller owns tray-specific geometry constants
 * and passes them in via `opts` — including `rowHeight` (no local mirror).
 */

export interface TrayLayoutOptions {
  leftX: number;
  topY: number;
  nodeWidth: number;
  colGap: number;
  rowHeight: number;
  columns: number;
}

export interface TrayLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  rightX: number;
}

/**
 * Lay `isolatedIds` into a row-major grid of `opts.columns` columns, starting at
 * (`leftX`, `topY`). Ids are sorted first → deterministic. `rightX` is the right
 * edge of the widest occupied row (≥ used columns), used to size the tray label
 * divider; for an empty input it collapses to `leftX`.
 */
export function layoutIsolatedGrid(
  isolatedIds: string[],
  opts: TrayLayoutOptions,
): TrayLayoutResult {
  const sorted = [...isolatedIds].sort();
  const positions = new Map<string, { x: number; y: number }>();
  const cols = Math.max(1, opts.columns);
  for (let i = 0; i < sorted.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.set(sorted[i], {
      x: opts.leftX + col * (opts.nodeWidth + opts.colGap),
      y: opts.topY + row * opts.rowHeight,
    });
  }
  const usedCols = Math.min(cols, sorted.length);
  const rightX =
    sorted.length > 0
      ? opts.leftX + (usedCols - 1) * (opts.nodeWidth + opts.colGap) + opts.nodeWidth
      : opts.leftX;
  return { positions, rightX };
}
