import { describe, expect, it } from "vitest";
import { MarkerType } from "@xyflow/react";
import { getEdgeStyling, type EdgeVisualInput } from "./epic-graph-style";

function input(overrides: Partial<EdgeVisualInput> = {}): EdgeVisualInput {
  return {
    provenance: "explicit",
    isBackwards: false,
    highlightState: "none",
    ...overrides,
  };
}

describe("getEdgeStyling — provenance", () => {
  it("derived edges are dashed", () => {
    const v = getEdgeStyling(input({ provenance: "derived" }));
    expect(v.style.strokeDasharray).toBe("6 4");
  });

  it("explicit edges are solid (no dash)", () => {
    const v = getEdgeStyling(input({ provenance: "explicit" }));
    expect(v.style.strokeDasharray).toBeUndefined();
  });
});

describe("getEdgeStyling — arrowheads", () => {
  it("always emits a closed arrowhead", () => {
    for (const hs of ["none", "highlighted", "dimmed"] as const) {
      const v = getEdgeStyling(input({ highlightState: hs }));
      expect(v.markerEnd.type).toBe(MarkerType.ArrowClosed);
    }
  });

  it("colors the arrowhead to match the stroke", () => {
    const v = getEdgeStyling(input({ isBackwards: true }));
    expect(v.markerEnd.color).toBe(v.style.stroke);
  });
});

describe("getEdgeStyling — highlight state", () => {
  it("none is full opacity at the base width", () => {
    const v = getEdgeStyling(input({ highlightState: "none" }));
    expect(v.style.opacity).toBe(1);
    expect(v.style.strokeWidth).toBe(1.5);
    expect(v.zIndex).toBe(0);
  });

  it("dimmed fades to a low opacity", () => {
    const v = getEdgeStyling(input({ highlightState: "dimmed" }));
    expect(v.style.opacity).toBeCloseTo(0.12);
  });

  it("highlighted is full opacity, heavier, and raised", () => {
    const v = getEdgeStyling(input({ highlightState: "highlighted" }));
    expect(v.style.opacity).toBe(1);
    expect(v.style.strokeWidth).toBeGreaterThan(1.5);
    expect(v.zIndex).toBe(10);
  });
});

describe("getEdgeStyling — backwards edges", () => {
  it("are amber, curved (smoothstep), and raised above resting edges", () => {
    const v = getEdgeStyling(input({ isBackwards: true }));
    expect(v.style.stroke).toBe("#f59e0b");
    expect(v.type).toBe("smoothstep");
    expect(v.zIndex).toBe(5);
  });

  it("forwards edges use the default edge type", () => {
    const v = getEdgeStyling(input({ isBackwards: false }));
    expect(v.type).toBe("default");
  });

  it("stay amber even when highlighted", () => {
    const v = getEdgeStyling(input({ isBackwards: true, highlightState: "highlighted" }));
    expect(v.style.stroke).toBe("#f59e0b");
  });

  it("backwards + derived is still dashed", () => {
    const v = getEdgeStyling(input({ isBackwards: true, provenance: "derived" }));
    expect(v.style.strokeDasharray).toBe("6 4");
  });
});

describe("getEdgeStyling — invariants", () => {
  it("never animates", () => {
    expect(getEdgeStyling(input()).animated).toBe(false);
  });
});
