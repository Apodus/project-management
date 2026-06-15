import { BaseEdge, type EdgeProps } from "@xyflow/react";
import type { RoutePoint } from "@/lib/epic-graph-route";

/**
 * Custom ReactFlow edge that threads a pre-computed polyline (the structure
 * layout's `longEdgeRoutes`) through the inter-rank gaps, so a long-span
 * dependency doesn't slice across intermediate nodes.
 *
 * The true endpoints are RF's `sourceX/Y` + `targetX/Y` (the live handle
 * positions); the route's stored first/last points are center-anchors the
 * canvas drops — only the INTERIOR waypoints are threaded. `markerEnd` (the
 * arrowhead) is passed through, never dropped.
 */

/**
 * Build a smooth SVG path from `src` through every interior waypoint to `tgt`.
 * Pure. Uses a quadratic through each interior point toward the midpoint to its
 * successor, so N waypoints (≥2 for a dist-3 edge) are all threaded — never
 * assumes a single waypoint. With < 1 interior point it degrades to a straight
 * `M..L..` between the endpoints.
 */
export function buildRoutedPath(
  interior: RoutePoint[],
  src: { x: number; y: number },
  tgt: { x: number; y: number },
): string {
  if (interior.length < 1) {
    return `M ${src.x},${src.y} L ${tgt.x},${tgt.y}`;
  }

  // Walk src → w0 → w1 → … → tgt. For each interior point we curve INTO it with
  // a quadratic whose control point is the waypoint, then end the segment at the
  // midpoint between this waypoint and the next anchor — yielding a smooth,
  // corner-rounding polyline rather than sharp turns.
  let d = `M ${src.x},${src.y}`;
  for (let i = 0; i < interior.length; i++) {
    const w = interior[i];
    const nextAnchor = i + 1 < interior.length ? interior[i + 1] : tgt;
    const midX = (w.x + nextAnchor.x) / 2;
    const midY = (w.y + nextAnchor.y) / 2;
    d += ` Q ${w.x},${w.y} ${midX},${midY}`;
  }
  d += ` L ${tgt.x},${tgt.y}`;
  return d;
}

export function RoutedEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  style,
  markerEnd,
}: EdgeProps) {
  const points = (data?.points as RoutePoint[] | undefined) ?? [];
  // Drop the stored source/target center-anchors; use RF's real endpoints.
  const interior = points.slice(1, -1);
  const d = buildRoutedPath(interior, { x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  return <BaseEdge path={d} style={style} markerEnd={markerEnd} />;
}
