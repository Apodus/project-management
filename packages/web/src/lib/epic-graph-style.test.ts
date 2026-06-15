import { describe, expect, it } from "vitest";
import { MarkerType } from "@xyflow/react";
import { getEdgeStyling, type EdgeVisualInput } from "./epic-graph-style";

function input(overrides: Partial<EdgeVisualInput> = {}): EdgeVisualInput {
  return {
    provenance: "explicit",
    dependencyType: "blocks",
    isBackwards: false,
    isRedundant: false,
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
      expect(v.markerEnd!.type).toBe(MarkerType.ArrowClosed);
    }
  });

  it("colors the arrowhead to match the stroke", () => {
    const v = getEdgeStyling(input({ isBackwards: true }));
    expect(v.markerEnd!.color).toBe(v.style.stroke);
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

describe("getEdgeStyling — relates_to", () => {
  it("is soft dotted, slate-300, thin, with no arrowhead", () => {
    const v = getEdgeStyling(input({ dependencyType: "relates_to" }));
    expect(v.style.strokeDasharray).toBe("2 4");
    expect(v.style.stroke).toBe("#cbd5e1");
    expect(v.style.strokeWidth).toBe(1);
    expect(v.markerEnd).toBeUndefined();
    expect(v.type).toBe("default");
    expect(v.zIndex).toBe(0);
  });

  it("dotted dash is distinct from derived-blocks dash", () => {
    const relates = getEdgeStyling(input({ dependencyType: "relates_to" }));
    const derived = getEdgeStyling(input({ dependencyType: "blocks", provenance: "derived" }));
    expect(relates.style.strokeDasharray).toBe("2 4");
    expect(derived.style.strokeDasharray).toBe("6 4");
    expect(relates.style.strokeDasharray).not.toBe(derived.style.strokeDasharray);
  });

  it("blocks edges still carry a closed arrowhead", () => {
    const v = getEdgeStyling(input({ dependencyType: "blocks" }));
    expect(v.markerEnd!.type).toBe(MarkerType.ArrowClosed);
  });

  it("backwards takes precedence over relates_to (amber, smoothstep)", () => {
    const v = getEdgeStyling(input({ dependencyType: "relates_to", isBackwards: true }));
    expect(v.style.stroke).toBe("#f59e0b");
    expect(v.type).toBe("smoothstep");
  });

  it("highlight composes — brighter, heavier, raised, still dotted, no arrowhead", () => {
    const v = getEdgeStyling(
      input({ dependencyType: "relates_to", highlightState: "highlighted" }),
    );
    expect(v.style.opacity).toBe(1);
    expect(v.style.strokeWidth).toBe(2);
    expect(v.zIndex).toBe(10);
    expect(v.style.strokeDasharray).toBe("2 4");
    expect(v.markerEnd).toBeUndefined();
  });

  it("dim composes — low opacity, still dotted", () => {
    const v = getEdgeStyling(input({ dependencyType: "relates_to", highlightState: "dimmed" }));
    expect(v.style.opacity).toBeCloseTo(0.12);
    expect(v.style.strokeDasharray).toBe("2 4");
  });
});

describe("getEdgeStyling — redundant", () => {
  it("a revealed redundant blocks edge is faint, dotted, thin, arrowless, default type", () => {
    const v = getEdgeStyling(input({ isRedundant: true, dependencyType: "blocks" }));
    expect(v.style.opacity).toBeCloseTo(0.2);
    expect(v.style.strokeWidth).toBe(1);
    expect(v.style.strokeDasharray).toBe("2 3");
    expect(v.markerEnd).toBeUndefined();
    expect(v.type).toBe("default");
  });

  it("highlight brightens the redundant edge; dim fades it further", () => {
    const hi = getEdgeStyling(
      input({ isRedundant: true, dependencyType: "blocks", highlightState: "highlighted" }),
    );
    expect(hi.style.opacity).toBeCloseTo(0.5);
    expect(hi.zIndex).toBe(10);
    const dim = getEdgeStyling(
      input({ isRedundant: true, dependencyType: "blocks", highlightState: "dimmed" }),
    );
    expect(dim.style.opacity).toBeCloseTo(0.08);
  });

  it("isRedundant is ignored when the edge is backwards (backwards wins)", () => {
    const v = getEdgeStyling(input({ isRedundant: true, isBackwards: true }));
    expect(v.style.stroke).toBe("#f59e0b");
    expect(v.type).toBe("smoothstep");
    expect(v.style.strokeDasharray).not.toBe("2 3");
  });

  it("isRedundant is ignored for relates_to (relates wins)", () => {
    const v = getEdgeStyling(input({ isRedundant: true, dependencyType: "relates_to" }));
    expect(v.style.strokeDasharray).toBe("2 4");
    expect(v.style.stroke).toBe("#cbd5e1");
  });
});

describe("getEdgeStyling — invariants", () => {
  it("never animates", () => {
    expect(getEdgeStyling(input()).animated).toBe(false);
  });
});
