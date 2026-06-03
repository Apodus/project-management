import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import { EpicNode, type EpicNodeData } from "./epic-node";

// Render EpicNode through a minimal one-node ReactFlow so it receives the real
// NodeProps shape ReactFlow constructs (and the store context Handle needs),
// rather than hand-rolling a partial NodeProps object.
function renderNode(data: EpicNodeData) {
  const nodes: Node<EpicNodeData>[] = [{ id: "n1", type: "epic", position: { x: 0, y: 0 }, data }];
  return render(
    <ReactFlowProvider>
      <div style={{ width: 400, height: 300 }}>
        <ReactFlow nodes={nodes} edges={[]} nodeTypes={{ epic: EpicNode }} />
      </div>
    </ReactFlowProvider>,
  );
}

function baseData(overrides: Partial<EpicNodeData> = {}): EpicNodeData {
  return {
    name: "Auth epic",
    done: 3,
    total: 5,
    progressPct: 60,
    health: "on_track",
    byStatus: { done: 3, in_progress: 2 },
    ...overrides,
  };
}

describe("EpicNode", () => {
  it("renders the epic name", () => {
    renderNode(baseData());
    expect(screen.getByText("Auth epic")).toBeInTheDocument();
  });

  it("renders the task ratio and percentage", () => {
    renderNode(baseData());
    expect(screen.getByText("3/5")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
  });

  it("fills to the progress percentage with the health-colored swatch", () => {
    renderNode(baseData());
    const fill = screen.getByTestId("epic-node-fill");
    expect(fill).toHaveStyle({ width: "60%" });
    // getHealthColor("on_track", "fill") → "bg-blue-500".
    expect(fill).toHaveClass("bg-blue-500");
  });

  it("marks a cycle member with a red ring", () => {
    const { container } = renderNode(baseData({ inCycle: true }));
    expect(container.querySelector(".ring-red-500")).not.toBeNull();
  });

  it("dims a node that is off the focused dependency chain (target opacity 0.25)", () => {
    const { container } = renderNode(baseData({ dimmed: true }));
    const root = container.querySelector(".bg-card") as HTMLElement;
    // Dim is now a single inline opacity TARGET (with an always-on transition),
    // not a conditional `.opacity-25` class — that conditional class was the
    // hover-flicker cause (it snapped current opacity each time it was removed).
    expect(root).toHaveStyle({ opacity: "0.25" });
  });

  it("applies neither ring nor dim when both flags are absent (opacity 1)", () => {
    const { container } = renderNode(baseData());
    const root = container.querySelector(".bg-card") as HTMLElement;
    expect(container.querySelector(".ring-red-500")).toBeNull();
    expect(root).toHaveStyle({ opacity: "1" });
  });

  it("applies the recede value as inline opacity when not dimmed", () => {
    const { container } = renderNode(baseData({ recede: 0.5 }));
    const root = container.querySelector(".bg-card") as HTMLElement;
    expect(root).toHaveStyle({ opacity: "0.5" });
  });

  it("lets dim win over recede (target opacity = 0.25, not the recede value)", () => {
    const { container } = renderNode(baseData({ dimmed: true, recede: 0.5 }));
    const root = container.querySelector(".bg-card") as HTMLElement;
    expect(root).toHaveStyle({ opacity: "0.25" });
  });

  it("draws a left category accent when a categoryColor is present", () => {
    const { container } = renderNode(baseData({ categoryColor: "#3b82f6" }));
    const root = container.querySelector(".bg-card") as HTMLElement;
    expect(root).toHaveClass("border-l-4");
    expect(root).toHaveStyle({ borderLeftColor: "#3b82f6" });
  });

  it("draws no category accent when categoryColor is absent", () => {
    const { container } = renderNode(baseData());
    const root = container.querySelector(".bg-card") as HTMLElement;
    expect(root).not.toHaveClass("border-l-4");
  });

  it("handles a zero-task epic without crashing (0/0, 0%, empty underline)", () => {
    renderNode(
      baseData({
        done: 0,
        total: 0,
        progressPct: 0,
        byStatus: {},
      }),
    );
    expect(screen.getByText("0/0")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
    const fill = screen.getByTestId("epic-node-fill");
    expect(fill).toHaveStyle({ width: "0%" });
  });

  // ── Lifecycle-driven emphasis (structure mode) ──────────────────
  // The canvas passes `lifecycle` only in structure mode; opacity precedence is
  // dimmed > lifecycle > recede. The dashed FUTURE outline lives on the
  // box-outline channel so it never touches the `border-l-4` category accent.

  it("desaturates a done epic (data-lifecycle=done, grayscale, opacity 0.55)", () => {
    const { container } = renderNode(baseData({ lifecycle: "done" }));
    const root = container.querySelector(".bg-card") as HTMLElement;
    expect(root.getAttribute("data-lifecycle")).toBe("done");
    expect(root).toHaveClass("grayscale");
    expect(root).toHaveStyle({ opacity: "0.55" });
  });

  it("renders an active epic at full opacity, no grayscale, no dashed outline", () => {
    const { container } = renderNode(baseData({ lifecycle: "active" }));
    const root = container.querySelector(".bg-card") as HTMLElement;
    expect(root.getAttribute("data-lifecycle")).toBe("active");
    expect(root).toHaveStyle({ opacity: "1" });
    expect(root).not.toHaveClass("grayscale");
    expect(root).not.toHaveClass("outline-dashed");
  });

  it("outlines a future epic with a dashed inset outline (opacity 0.7)", () => {
    const { container } = renderNode(baseData({ lifecycle: "future" }));
    const root = container.querySelector(".bg-card") as HTMLElement;
    expect(root.getAttribute("data-lifecycle")).toBe("future");
    expect(root).toHaveClass("outline-dashed");
    expect(root).toHaveClass("outline-1");
    expect(root).toHaveStyle({ opacity: "0.7" });
  });

  it("lets lifecycle override recede (done → 0.55, not the recede value)", () => {
    const { container } = renderNode(baseData({ lifecycle: "done", recede: 0.9 }));
    const root = container.querySelector(".bg-card") as HTMLElement;
    expect(root).toHaveStyle({ opacity: "0.55" });
  });

  it("lets dim beat lifecycle (opacity 0.25, future outline suppressed)", () => {
    const { container } = renderNode(baseData({ lifecycle: "future", dimmed: true }));
    const root = container.querySelector(".bg-card") as HTMLElement;
    expect(root).toHaveStyle({ opacity: "0.25" });
    // The future treatment is gated on !dimmed, so a chain-off node only dims.
    expect(root).not.toHaveClass("outline-dashed");
  });

  it("keeps the timeline path unchanged when no lifecycle is passed (recede only)", () => {
    const { container } = renderNode(baseData({ recede: 0.5 }));
    const root = container.querySelector(".bg-card") as HTMLElement;
    expect(root).toHaveStyle({ opacity: "0.5" });
    // No lifecycle → undefined → no data-lifecycle attribute, no treatment.
    expect(root.getAttribute("data-lifecycle")).toBeNull();
    expect(root).not.toHaveClass("grayscale");
    expect(root).not.toHaveClass("outline-dashed");
  });

  it("keeps the future outline orthogonal to the category accent and cycle ring", () => {
    const { container } = renderNode(
      baseData({ lifecycle: "future", categoryColor: "#3b82f6", inCycle: true }),
    );
    const root = container.querySelector(".bg-card") as HTMLElement;
    // Dashed future outline (box-outline channel)…
    expect(root).toHaveClass("outline-dashed");
    // …does NOT replace the category left-accent border (separate channel)…
    expect(root).toHaveClass("border-l-4");
    expect(root).toHaveStyle({ borderLeftColor: "#3b82f6" });
    // …nor the cycle ring.
    expect(root).toHaveClass("ring-red-500");
  });

  it("mounts all four handles under a real ReactFlow store without crashing", () => {
    // The node now declares four Handles (two unnamed forward + two id'd
    // facing-side back-edge). Each Handle reads the ReactFlow store on mount; a
    // clean render (name present) proves the 4-handle JSX mounts.
    renderNode(baseData());
    expect(screen.getByText("Auth epic")).toBeInTheDocument();
  });
});
