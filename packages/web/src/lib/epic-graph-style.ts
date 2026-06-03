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

const MARKER_SIZE = 16;

export interface EdgeVisualInput {
  provenance: "derived" | "explicit";
  isBackwards: boolean;
  highlightState: "none" | "highlighted" | "dimmed";
}

export interface EdgeVisual {
  style: CSSProperties;
  markerEnd: {
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
  const { provenance, isBackwards, highlightState } = input;

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
    transition: "opacity 150ms ease, stroke 150ms ease, stroke-width 150ms ease",
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
