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
    nodes: { id: string; data: { name: string; lifecycle?: string; ready?: boolean } }[];
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
        <div
          key={n.id}
          data-testid="rf-node"
          data-lifecycle={n.data.lifecycle ?? ""}
          data-ready={n.data.ready ? "true" : ""}
        >
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

// One active epic + one not_started epic (→ lifecycle "future"). Drives the
// structure-mode "hide upcoming" collapse rail.
function futureGraph(): EpicGraph {
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
        id: "future-1",
        project_id: "proj-1",
        name: "Future epic",
        status: "active",
        priority: "low",
        target_date: null,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
        taskSummary: { total: 3, done: 0, byStatus: {} },
        health: "not_started",
        activity_recency: "2026-06-01T00:00:00.000Z",
        time_window: { start: "2026-05-01T00:00:00.000Z", end: null },
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

// Three active epics root→mid→leaf (`blocks` edges root→mid, mid→leaf). root is
// done, mid + leaf on_track. Oracle (actionableNow on the full graph): mid is
// ready (its only prereq root is done), root is NOT (done → not active), leaf is
// NOT (its prereq mid is not done). NO categories → drives the R2 uncategorized
// frontier legend.
function frontierGraph(): EpicGraph {
  const node = (id: string, name: string, health: "done" | "on_track") => ({
    id,
    project_id: "proj-1",
    name,
    status: "active" as const,
    priority: "high" as const,
    target_date: null,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    taskSummary: { total: 4, done: health === "done" ? 4 : 1, byStatus: {} },
    health,
    activity_recency: "2026-06-01T00:00:00.000Z",
    time_window: { start: "2026-05-01T00:00:00.000Z", end: null },
  });
  return {
    nodes: [
      node("root", "Root epic", "done"),
      node("mid", "Mid epic", "on_track"),
      node("leaf", "Leaf epic", "on_track"),
    ],
    edges: [
      { from: "root", to: "mid", dependency_type: "blocks", provenance: "explicit" },
      { from: "mid", to: "leaf", dependency_type: "blocks", provenance: "explicit" },
    ],
    hasCycle: false,
  };
}

// Edge-bearing categorized fixture for the BINDING-CONTRACT test: `prereq`
// (active, NOT done, category "Terrain") blocks `gated` (active, category
// "Graphics"). gated is NOT ready initially (prereq not done). Hiding "Terrain"
// drops prereq from nodesForLayout — but actionableNow runs on the FULL graph,
// so gated must STAY not-ready (the hidden prereq's gating edge still counts).
function gatedGraph(): EpicGraph {
  const node = (id: string, name: string, category: string) => ({
    id,
    project_id: "proj-1",
    name,
    status: "active" as const,
    priority: "high" as const,
    target_date: null,
    category,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    taskSummary: { total: 4, done: 1, byStatus: {} },
    health: "on_track" as const,
    activity_recency: "2026-06-01T00:00:00.000Z",
    time_window: { start: "2026-05-01T00:00:00.000Z", end: null },
  });
  return {
    nodes: [node("prereq", "Prereq epic", "Terrain"), node("gated", "Gated epic", "Graphics")],
    edges: [{ from: "prereq", to: "gated", dependency_type: "blocks", provenance: "explicit" }],
    hasCycle: false,
  };
}

// Three active epics chained A→B→C (ranks 0/1/2) PLUS a long-span A→C `blocks`
// edge (dist 2). Drives the routed-edge test: A→C must render as type "routed",
// the short A→B as the default/"" type.
function longEdgeGraph(): EpicGraph {
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
    nodes: [node("a", "Epic A"), node("b", "Epic B"), node("c", "Epic C")],
    edges: [
      { from: "a", to: "b", dependency_type: "blocks", provenance: "explicit" },
      { from: "b", to: "c", dependency_type: "blocks", provenance: "explicit" },
      { from: "a", to: "c", dependency_type: "blocks", provenance: "explicit" },
    ],
    hasCycle: false,
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
    // shown, so the ancient done epic is NOT collapsed. C2.P4 keeps show-all as
    // the DEFAULT (both lifecycle collapse rails default OFF) and merely ADDS
    // opt-in Hide done / Hide upcoming toggles — the calendar-based Past rail
    // remains a timeline-mode-only affordance.
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

  it("routes a long-span blocks edge through the custom routed edge type", () => {
    mocks.useEpicGraph.mockReturnValue(q(longEdgeGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    const edges = screen.getAllByTestId("rf-edge");
    const long = edges.find((e) => e.getAttribute("data-edge-id") === "a->c-blocks");
    const short = edges.find((e) => e.getAttribute("data-edge-id") === "a->b-blocks");
    expect(long).toBeDefined();
    expect(short).toBeDefined();
    // The dist-2 edge is routed; the dist-1 edge keeps the default type.
    expect(long?.getAttribute("data-edge-type")).toBe("routed");
    expect(short?.getAttribute("data-edge-type")).not.toBe("routed");
  });

  it("keeps a backwards (cycle) edge on smoothstep, never routed", () => {
    mocks.useEpicGraph.mockReturnValue(q(cycleGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    const edges = screen.getAllByTestId("rf-edge");
    const back = edges.find((e) => e.getAttribute("data-edge-id") === "b->a-blocks");
    expect(back?.getAttribute("data-edge-type")).toBe("smoothstep");
  });

  it("does not render the legend in the compact variant", () => {
    mocks.useEpicGraph.mockReturnValue(q(categorizedGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" variant="compact" />);
    // Nodes still render (accents are node-data driven), but no legend buttons.
    expect(screen.getByText("Graphics epic")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Graphics" })).not.toBeInTheDocument();
  });

  // ── Now-frontier (C2.P3) ────────────────────────────────────────

  it("marks exactly the actionable-now epics ready in structure mode", () => {
    mocks.useEpicGraph.mockReturnValue(q(frontierGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    // mid is ready (prereq root is done); root (done → not active) + leaf (prereq
    // mid not done) are not.
    const mid = screen.getByText("Mid epic").closest("[data-testid='rf-node']");
    const root = screen.getByText("Root epic").closest("[data-testid='rf-node']");
    const leaf = screen.getByText("Leaf epic").closest("[data-testid='rf-node']");
    expect(mid?.getAttribute("data-ready")).toBe("true");
    expect(root?.getAttribute("data-ready")).toBe("");
    expect(leaf?.getAttribute("data-ready")).toBe("");
  });

  it("clears all ready markers in timeline mode (recency path, not frontier)", () => {
    mocks.useEpicGraph.mockReturnValue(q(frontierGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    fireEvent.click(screen.getByRole("radio", { name: "Timeline" }));
    for (const n of screen.getAllByTestId("rf-node")) {
      expect(n.getAttribute("data-ready")).toBe("");
    }
  });

  it("computes the now-frontier on the FULL graph, not the category-filtered layout set", () => {
    // BINDING CONTRACT: prereq (Terrain) blocks gated (Graphics). gated is not
    // ready while prereq is incomplete. Hiding Terrain removes prereq from
    // nodesForLayout — but actionableNow ran on graph.nodes/graph.edges, so the
    // gating edge still counts and gated must STAY not-ready.
    // (This fails if the impl wrongly used nodesForLayout: the hidden prereq's
    // edge would be skipped and gated would flip to ready.)
    mocks.useEpicGraph.mockReturnValue(q(gatedGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    const gatedBefore = screen.getByText("Gated epic").closest("[data-testid='rf-node']");
    expect(gatedBefore?.getAttribute("data-ready")).toBe("");
    // Toggle OFF "Terrain" via the proven category-hide mechanism (a button row).
    fireEvent.click(screen.getByRole("button", { name: "Terrain" }));
    // prereq left nodesForLayout, but gated must NOT have flipped to ready.
    expect(screen.queryByText("Prereq epic")).not.toBeInTheDocument();
    const gatedAfter = screen.getByText("Gated epic").closest("[data-testid='rf-node']");
    expect(gatedAfter?.getAttribute("data-ready")).toBe("");
  });

  it("shows the now-frontier legend row for an uncategorized roadmap (R2)", () => {
    // frontierGraph has no categories → no category buttons, but a ready node
    // (mid) → the frontier legend row must still mount.
    mocks.useEpicGraph.mockReturnValue(q(frontierGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    expect(screen.queryByRole("button", { name: "Graphics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terrain" })).not.toBeInTheDocument();
    expect(screen.getByText("Ready to start")).toBeInTheDocument();
  });

  // ── Lifecycle collapse rails (C2.P4) ────────────────────────────

  it("default structure mode shows done + future and offers an opt-in hide", () => {
    mocks.useEpicGraph.mockReturnValue(q(activeAndPastGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    // Both default OFF → the done epic is on-canvas alongside the active one.
    expect(screen.getByText("Active epic")).toBeInTheDocument();
    expect(screen.getByText("Ancient epic")).toBeInTheDocument();
    // The collapse rail offers to hide the (1) done bucket; expanded = shown.
    expect(screen.getByRole("button", { name: /Hide 1 done/ })).toBeInTheDocument();
  });

  it("hides the done bucket when the structure done-rail is toggled", () => {
    mocks.useEpicGraph.mockReturnValue(q(activeAndPastGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Hide 1 done/ }));
    // The done epic leaves the canvas; the active one stays.
    expect(screen.queryByText("Ancient epic")).not.toBeInTheDocument();
    expect(screen.getByText("Active epic")).toBeInTheDocument();
    // The rail now offers to re-show.
    expect(screen.getByRole("button", { name: /Show 1 done/ })).toBeInTheDocument();
  });

  it("hides the future bucket when the structure upcoming-rail is toggled", () => {
    mocks.useEpicGraph.mockReturnValue(q(futureGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    expect(screen.getByText("Future epic")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Hide 1 upcoming/ }));
    expect(screen.queryByText("Future epic")).not.toBeInTheDocument();
    expect(screen.getByText("Active epic")).toBeInTheDocument();
  });

  it("the done collapse is reversible (hide then show)", () => {
    mocks.useEpicGraph.mockReturnValue(q(activeAndPastGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Hide 1 done/ }));
    expect(screen.queryByText("Ancient epic")).not.toBeInTheDocument();
    // Toggle back on → the done epic returns.
    fireEvent.click(screen.getByRole("button", { name: /Show 1 done/ }));
    expect(screen.getByText("Ancient epic")).toBeInTheDocument();
  });

  it("lifecycle collapse rails are structure-only — timeline uses the calendar rails", () => {
    mocks.useEpicGraph.mockReturnValue(q(activeAndPastGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    fireEvent.click(screen.getByRole("radio", { name: "Timeline" }));
    // No lifecycle hide rail in timeline mode...
    expect(screen.queryByRole("button", { name: /Hide.*done/ })).not.toBeInTheDocument();
    // ...the calendar Past rail governs instead (past-1 is done + old → "1 older").
    expect(screen.getByRole("button", { name: /older/i })).toBeInTheDocument();
  });

  it("renders no collapse rail when a lifecycle bucket is empty (RailPanel null)", () => {
    // categorizedGraph is all-active: no done, no future → both rails return null.
    mocks.useEpicGraph.mockReturnValue(q(categorizedGraph()));
    render(<EpicRoadmapCanvas projectId="proj-1" />);
    expect(screen.queryByRole("button", { name: /Hide.*done/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Hide.*upcoming/ })).not.toBeInTheDocument();
  });
});
