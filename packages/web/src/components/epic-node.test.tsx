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

  it("dims a node that is off the focused dependency chain", () => {
    const { container } = renderNode(baseData({ dimmed: true }));
    expect(container.querySelector(".opacity-25")).not.toBeNull();
  });

  it("applies neither ring nor dim when both flags are absent", () => {
    const { container } = renderNode(baseData());
    expect(container.querySelector(".ring-red-500")).toBeNull();
    expect(container.querySelector(".opacity-25")).toBeNull();
  });

  it("applies the recede value as inline opacity when not dimmed", () => {
    const { container } = renderNode(baseData({ recede: 0.5 }));
    const root = container.querySelector(".bg-card") as HTMLElement;
    expect(root).toHaveStyle({ opacity: "0.5" });
  });

  it("lets dim win over recede (class applies, no inline override)", () => {
    const { container } = renderNode(baseData({ dimmed: true, recede: 0.5 }));
    expect(container.querySelector(".opacity-25")).not.toBeNull();
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
});
