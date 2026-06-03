import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { EpicGraph } from "@/lib/api";

// ── Mock the router (navigate) ───────────────────────────────────
// The canvas takes `projectId` as a prop, so no `useParams` is needed.
// `EpicTasksPanel`'s `useNavigate` only fires on click (not exercised here),
// but it is read at render time inside the panel — keep a minimal stub.
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

// ── Mock React Flow ──────────────────────────────────────────────
// The real canvas needs layout measurement + a DOM-heavy store; for a state
// test we stub ReactFlow to a passthrough that renders each node's name, so
// "node present" assertions still hold without the canvas machinery.
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({
    nodes,
    edges,
    children,
  }: {
    nodes: { id: string; data: { name: string; lifecycle?: string } }[];
    edges?: {
      id: string;
      sourceHandle?: string | null;
      targetHandle?: string | null;
      type?: string;
    }[];
    children?: ReactNode;
  }) => (
    <div>
      {nodes.map((n) => (
        <div key={n.id} data-testid="rf-node" data-lifecycle={n.data.lifecycle ?? ""}>
          {n.data.name}
        </div>
      ))}
      {(edges ?? []).map((e) => (
        <div
          key={e.id}
          data-testid="rf-edge"
          data-edge-id={e.id}
          data-source-handle={e.sourceHandle ?? ""}
          data-target-handle={e.targetHandle ?? ""}
          data-edge-type={e.type ?? ""}
        />
      ))}
      {children}
    </div>
  ),
  Background: () => null,
  Controls: () => null,
  // Panel passes its children through so the legend (and rails) mount. The
  // rAF/useReactFlow camera effect inside RailPanel is harmless under the
  // stubbed useReactFlow (fitView is a no-op).
  Panel: ({ children }: { children?: ReactNode }) => <>{children}</>,
  // ViewportPortal is in the explicit allowlist so the canvas (which renders
  // MilestoneGuides) doesn't throw "Element type is invalid"; the passthrough
  // surfaces its children.
  ViewportPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useReactFlow: () => ({ fitView: () => {} }),
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  MarkerType: {},
}));
vi.mock("@xyflow/react/dist/style.css", () => ({}));

// ── Mock the query hooks the canvas calls ────────────────────────
const mocks = vi.hoisted(() => ({
  useEpicGraph: vi.fn(),
}));
vi.mock("@/hooks/use-epic-graph", () => ({
  useEpicGraph: mocks.useEpicGraph,
}));
// The canvas fetches milestones for the guide lines. There's no
// QueryClientProvider in this render, so a real query would throw "No
// QueryClient set" — stub the hook to an empty list.
vi.mock("@/hooks/use-milestones", () => ({
  useMilestones: () => ({ data: [] }),
}));
// The canvas reads epic categories off the project to color nodes + build the
// legend. Without a QueryClientProvider a real useProject would throw "No
// QueryClient set" — stub it with a two-category settings blob.
vi.mock("@/hooks/use-projects", () => ({
  useProject: () => ({
    data: {
      id: "proj-1",
      settings: {
        epic_categories: [
          { name: "Graphics", color: "#3b82f6", sort_order: 0 },
          { name: "Terrain", color: "#10b981", sort_order: 1 },
        ],
      },
    },
  }),
}));

import { EpicRoadmapCanvas } from "./epic-roadmap-canvas";

// ── Fixtures ─────────────────────────────────────────────────────

function oneNodeGraph(): EpicGraph {
  return {
    nodes: [
      {
        id: "e1",
        project_id: "proj-1",
        name: "Auth epic",
        status: "active",
        priority: "high",
        target_date: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        taskSummary: { total: 4, done: 1, byStatus: {} },
        health: "on_track",
        activity_recency: "2026-01-02T00:00:00.000Z",
        time_window: { start: "2026-01-01T00:00:00.000Z", end: null },
      },
    ],
    edges: [],
    hasCycle: false,
  };
}

// One in-flight epic + one done-and-old epic (activity well past the 45-day
// recede threshold relative to the test clock). The collapsed default must
// frame only the active node and keep the past node out of the canvas.
function activeAndPastGraph(): EpicGraph {
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  return {
    nodes: [
      {
        id: "active-1",
        project_id: "proj-1",
        name: "Active epic",
        status: "active",
        priority: "high",
        target_date: null,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
        taskSummary: { total: 4, done: 1, byStatus: {} },
        health: "on_track",
        activity_recency: "2026-06-01T00:00:00.000Z",
        time_window: { start: "2026-05-01T00:00:00.000Z", end: null },
      },
      {
        id: "past-1",
        project_id: "proj-1",
        name: "Ancient epic",
        status: "active",
        priority: "low",
        target_date: null,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: old,
        taskSummary: { total: 3, done: 3, byStatus: {} },
        health: "done",
        activity_recency: old,
        time_window: { start: "2025-01-01T00:00:00.000Z", end: old },
      },
    ],
    edges: [],
    hasCycle: false,
  };
}

// Two active epics, each in a distinct defined category — drives the legend +
// per-category filter tests.
function categorizedGraph(): EpicGraph {
  return {
    nodes: [
      {
        id: "gfx-1",
        project_id: "proj-1",
        name: "Graphics epic",
        status: "active",
        priority: "high",
        target_date: null,
        category: "Graphics",
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
        taskSummary: { total: 4, done: 1, byStatus: {} },
        health: "on_track",
        activity_recency: "2026-06-01T00:00:00.000Z",
        time_window: { start: "2026-05-01T00:00:00.000Z", end: null },
      },
      {
        id: "terrain-1",
        project_id: "proj-1",
        name: "Terrain epic",
        status: "active",
        priority: "high",
        target_date: null,
        category: "Terrain",
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
        taskSummary: { total: 4, done: 1, byStatus: {} },
        health: "on_track",
        activity_recency: "2026-06-01T00:00:00.000Z",
        time_window: { start: "2026-05-01T00:00:00.000Z", end: null },
      },
    ],
    edges: [],
    hasCycle: false,
  };
}

// Two active epics with a mutual dependency (a→b AND b→a) — a 2-cycle. Drives
// the cycle banner + the back-edge facing-handle routing test.
function cycleGraph(): EpicGraph {
  const node = (id: string, name: string) => ({
    id,
    project_id: "proj-1",
    name,
    status: "active" as const,
    priority: "high" as const,
    target_date: null,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    taskSummary: { total: 4, done: 1, byStatus: {} },
    health: "on_track" as const,
    activity_recency: "2026-06-01T00:00:00.000Z",
    time_window: { start: "2026-05-01T00:00:00.000Z", end: null },
  });
  return {
    nodes: [node("a", "Epic A"), node("b", "Epic B")],
    edges: [
      { from: "a", to: "b", dependency_type: "blocks", provenance: "explicit" },
      { from: "b", to: "a", dependency_type: "blocks", provenance: "explicit" },
    ],
    hasCycle: true,
    cycles: [["a", "b"]],
  };
}

function q<T>(data: T | undefined, isLoading = false) {
  return { data, isLoading } as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useEpicGraph.mockReturnValue(q(oneNodeGraph()));
});

describe("EpicRoadmapCanvas", () => {
  it("renders a node on the canvas for each epic in the graph", () => {
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    // The ReactFlow stub passes node data through; the epic name proves the
    // canvas mapped the graph node into an rfNode and fed it to ReactFlow.
    expect(screen.getByText("Auth epic")).toBeInTheDocument();
    expect(screen.getByTestId("rf-node")).toBeInTheDocument();
  });

  it("renders a loading affordance while fetching", () => {
    mocks.useEpicGraph.mockReturnValue(q(undefined, true));
    const { container } = render(<EpicRoadmapCanvas projectId="proj-1" />);
    // The loading skeleton is present; the canvas/node is not yet rendered.
    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
    expect(screen.queryByText("Auth epic")).not.toBeInTheDocument();
  });

  it("renders the empty state when the graph has no nodes", () => {
    mocks.useEpicGraph.mockReturnValue(q({ nodes: [], edges: [], hasCycle: false }));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    expect(screen.getByText("No epics in this roadmap yet.")).toBeInTheDocument();
  });

  it("shows all epics (incl. done-and-old) in the default structure view — the calendar Past-rail collapse is timeline-only", () => {
    mocks.useEpicGraph.mockReturnValue(q(activeAndPastGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    // Structure is the default mode (C1.P5): the full dependency topology is
    // shown, so the ancient done epic is NOT collapsed — the calendar-based Past
    // rail is a timeline-mode-only affordance now. (C2 re-gates rails on
    // LIFECYCLE — done → receded — which will supersede this interim "show all".)
    expect(screen.getByText("Active epic")).toBeInTheDocument();
    expect(screen.getByText("Ancient epic")).toBeInTheDocument();
  });

  it("tags each structure-mode rf-node with its lifecycle phase", () => {
    mocks.useEpicGraph.mockReturnValue(q(activeAndPastGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    // Structure is the default; both nodes render. The canvas derives lifecycle
    // per node and stamps it on the rf-node data (stub mirrors it to data-*).
    const active = screen.getByText("Active epic").closest("[data-testid='rf-node']");
    const ancient = screen.getByText("Ancient epic").closest("[data-testid='rf-node']");
    expect(active?.getAttribute("data-lifecycle")).toBe("active");
    // health:"done" → lifecycle "done".
    expect(ancient?.getAttribute("data-lifecycle")).toBe("done");
  });

  it("clears lifecycle on rf-nodes in timeline mode (recency path, not phase)", () => {
    mocks.useEpicGraph.mockReturnValue(q(activeAndPastGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    // Radix ToggleGroupItem renders role="radio" (single-select segmented).
    fireEvent.click(screen.getByRole("radio", { name: "Timeline" }));
    // The Active epic survives timeline mode (the done-and-old Ancient epic
    // collapses into the hidden, collapsed Past rail). In timeline the canvas
    // passes `recede`, NOT `lifecycle` → empty data-lifecycle.
    const active = screen.getByText("Active epic").closest("[data-testid='rf-node']");
    expect(active?.getAttribute("data-lifecycle")).toBe("");
  });

  it("renders a category legend listing the present defined categories", () => {
    mocks.useEpicGraph.mockReturnValue(q(categorizedGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    // Legend rows are buttons named after the category (the nodes carry the
    // "… epic" suffix, so the bare names prove the legend, not the rf-nodes).
    expect(screen.getByRole("button", { name: "Graphics" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terrain" })).toBeInTheDocument();
  });

  it("hides a category's epics when its legend row is toggled off", () => {
    mocks.useEpicGraph.mockReturnValue(q(categorizedGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    // Both epics on canvas initially.
    expect(screen.getByText("Graphics epic")).toBeInTheDocument();
    expect(screen.getByText("Terrain epic")).toBeInTheDocument();
    // Toggle off Graphics → its rf-node disappears, Terrain stays.
    fireEvent.click(screen.getByRole("button", { name: "Graphics" }));
    expect(screen.queryByText("Graphics epic")).not.toBeInTheDocument();
    expect(screen.getByText("Terrain epic")).toBeInTheDocument();
    // The legend row survives the filter (still toggleable back on).
    expect(screen.getByRole("button", { name: "Graphics" })).toBeInTheDocument();
  });

  it("fires the dependency cycle banner when the graph has a cycle", () => {
    mocks.useEpicGraph.mockReturnValue(q(cycleGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    expect(screen.getByText(/dependency cycle\(s\) detected/i)).toBeInTheDocument();
  });

  it("routes the cycle back-edge through the facing-side handles", () => {
    mocks.useEpicGraph.mockReturnValue(q(cycleGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    // computeRanks' DFS visits the sorted root "a" first, so a→b is the
    // forward (rank-respecting) edge and b→a is the deterministically-EXCLUDED
    // back-edge. Edge ids are `${from}->${to}-${dependency_type}` (edgeKey).
    const edges = screen.getAllByTestId("rf-edge");
    const back = edges.find((e) => e.getAttribute("data-edge-id") === "b->a-blocks");
    const fwd = edges.find((e) => e.getAttribute("data-edge-id") === "a->b-blocks");
    expect(back).toBeDefined();
    expect(fwd).toBeDefined();
    // The back-edge routes between facing sides via a smoothstep arc.
    expect(back?.getAttribute("data-source-handle")).toBe("src-left");
    expect(back?.getAttribute("data-target-handle")).toBe("tgt-right");
    expect(back?.getAttribute("data-edge-type")).toBe("smoothstep");
    // The forward edge leaves the handles default (binds to Right-source/Left-target).
    expect(fwd?.getAttribute("data-source-handle")).toBe("");
    expect(fwd?.getAttribute("data-target-handle")).toBe("");
  });

  it("does not render the legend in the compact variant", () => {
    mocks.useEpicGraph.mockReturnValue(q(categorizedGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" variant="compact" />);
    // Nodes still render (accents are node-data driven), but no legend buttons.
    expect(screen.getByText("Graphics epic")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Graphics" })).not.toBeInTheDocument();
  });
});
