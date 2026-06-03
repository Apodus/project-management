import { MarkerType } from "@xyflow/react";
import type { CSSProperties } from "react";

/**
 * Pure edge-styling for the epic timeline-DAG view. Maps an edge's provenance
 * (derived/explicit), time-validity (backwards/forwards), and hover highlight
 * state into a ReactFlow edge visual: stroke style + arrowhead + edge type +
 * z-index. No React, no DOM — just a deterministic descriptor the page spreads
 * onto each rfEdge.
 *
 * Encoding:
 * - provenance: derived → dashed ("6 4"); explicit → solid (no dash).
 * - backwards-in-time edges (a data contradiction) are amber and rendered with
 *   a curved "smoothstep" path so the contradiction reads at a glance.
 * - highlightState (driven by the hovered node's dependency chain): highlighted
 *   thickens + brightens + raises z; dimmed fades to near-transparent; none is
 *   the resting appearance.
 */

const STROKE_BASE = "#94a3b8"; // slate-400
const STROKE_BACKWARDS = "#f59e0b"; // amber-500
const STROKE_HIGHLIGHT = "#475569"; // slate-600 (brightened resting stroke)
const STROKE_RELATES = "#cbd5e1"; // slate-300 (soft, non-sequencing)

const MARKER_SIZE = 16;

export interface EdgeVisualInput {
  provenance: "derived" | "explicit";
  dependencyType: "blocks" | "relates_to";
  isBackwards: boolean;
  /**
   * A forward `blocks` edge hidden by transitive reduction (a longer path
   * already implies it). When the "Show all dependencies" toggle reveals it, it
   * renders faint + dotted + arrowless — it carries no extra ordering, so it
   * never competes visually with the real chain. Ignored for backwards /
   * relates_to edges (those tiers win first).
   */
  isRedundant: boolean;
  highlightState: "none" | "highlighted" | "dimmed";
}

export interface EdgeVisual {
  style: CSSProperties;
  markerEnd?: {
    type: MarkerType;
    width: number;
    height: number;
    color: string;
  };
  type: "default" | "smoothstep";
  zIndex: number;
  animated: boolean;
}

export function getEdgeStyling(input: EdgeVisualInput): EdgeVisual {
  const { provenance, dependencyType, isBackwards, isRedundant, highlightState } = input;

  const transition = "opacity 150ms ease, stroke 150ms ease, stroke-width 150ms ease";

  // Redundant `blocks` edge (transitive-reduction-hidden, revealed by the
  // toggle) — THIRD precedence tier, AFTER backwards/relates_to short-circuits,
  // BEFORE the normal blocks logic. Faint, dotted, arrowless: it restates an
  // ordering the visible chain already carries, so it must never read as a real
  // dependency arc. Dim/highlight only nudge its opacity.
  if (!isBackwards && dependencyType === "blocks" && isRedundant) {
    return {
      style: {
        stroke: STROKE_BASE,
        strokeWidth: 1,
        opacity:
          highlightState === "highlighted" ? 0.5 : highlightState === "dimmed" ? 0.08 : 0.2,
        strokeDasharray: "2 3",
        transition,
      },
      // markerEnd omitted — no arrowhead on a redundant restatement.
      type: "default",
      zIndex: highlightState === "highlighted" ? 10 : 0,
      animated: false,
    };
  }

  // relates_to (non-sequencing) edges — SECOND precedence tier, after backwards.
  // A backwards (data-contradiction) edge stays amber/curved regardless of type;
  // but a forward relates_to edge fully owns its soft dotted style and returns
  // here, short-circuiting the provenance dash block so its "2 4" can never be
  // overwritten by derived "6 4". No arrowhead: relates_to is non-directional.
  if (!isBackwards && dependencyType === "relates_to") {
    const relatesStroke =
      highlightState === "highlighted" ? STROKE_HIGHLIGHT : STROKE_RELATES;
    return {
      style: {
        stroke: relatesStroke,
        strokeWidth: highlightState === "highlighted" ? 2 : 1,
        opacity: highlightState === "dimmed" ? 0.12 : 1,
        strokeDasharray: "2 4",
        transition,
      },
      type: "default",
      zIndex: highlightState === "highlighted" ? 10 : 0,
      animated: false,
    };
  }

  // Stroke color: amber for backwards (and it stays amber even when
  // highlighted); otherwise slate, brightened on highlight.
  let stroke: string;
  if (isBackwards) {
    stroke = STROKE_BACKWARDS;
  } else if (highlightState === "highlighted") {
    stroke = STROKE_HIGHLIGHT;
  } else {
    stroke = STROKE_BASE;
  }

  // Stroke width: backwards edges read a notch heavier at every state.
  let strokeWidth: number;
  if (highlightState === "highlighted") {
    strokeWidth = isBackwards ? 3 : 2.5;
  } else {
    // none + dimmed share the base width (dimmed only changes opacity).
    strokeWidth = isBackwards ? 2 : 1.5;
  }

  const opacity = highlightState === "dimmed" ? 0.12 : 1;

  const style: CSSProperties = {
    stroke,
    strokeWidth,
    opacity,
    // Always-on transition so hover highlight/dim drives current -> target
    // smoothly (same anti-flicker rule as the nodes: never reset current state,
    // only move the target). Unconditional so a flapping hover target redirects
    // the in-flight interpolation instead of snapping.
    transition,
  };
  // Provenance: derived dashes, explicit is solid (no dash property at all).
  if (provenance === "derived") {
    style.strokeDasharray = "6 4";
  }

  let zIndex: number;
  if (highlightState === "highlighted") {
    zIndex = 10;
  } else if (isBackwards) {
    zIndex = 5;
  } else {
    zIndex = 0;
  }

  return {
    style,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: MARKER_SIZE,
      height: MARKER_SIZE,
      color: stroke,
    },
    type: isBackwards ? "smoothstep" : "default",
    zIndex,
    animated: false,
  };
}
