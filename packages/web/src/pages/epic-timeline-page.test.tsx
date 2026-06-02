import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { EpicGraph } from "@/lib/api";

// ── Mock the router param hook ───────────────────────────────────
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

// ── Mock the query hooks the page calls ──────────────────────────
const mocks = vi.hoisted(() => ({
  useEpicGraph: vi.fn(),
  useProject: vi.fn(),
}));
vi.mock("@/hooks/use-epic-graph", () => ({
  useEpicGraph: mocks.useEpicGraph,
}));
vi.mock("@/hooks/use-projects", () => ({
  useProject: mocks.useProject,
}));

// The page calls useProjectStore((s) => s.setCurrentProject) — stub the
// selector so it returns a no-op rather than touching the real store.
vi.mock("@/stores/project-store", () => ({
  useProjectStore: (selector: (s: { setCurrentProject: () => void }) => unknown) =>
    selector({ setCurrentProject: () => {} }),
}));

import { EpicTimelinePage } from "./epic-timeline-page";

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

function q<T>(data: T | undefined, isLoading = false) {
  return { data, isLoading } as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useProject.mockReturnValue(q({ id: "proj-1", name: "Demo project" }));
  mocks.useEpicGraph.mockReturnValue(q(oneNodeGraph()));
});

describe("EpicTimelinePage", () => {
  it("renders a node card with name, task ratio, and health badge", () => {
    render(<EpicTimelinePage />);
    expect(screen.getByText("Auth epic")).toBeInTheDocument();
    // EpicCard completion vocabulary: "1 of 4 tasks done" + percentage.
    expect(screen.getByText("1 of 4 tasks done")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    // Health badge formatted via formatStatus("on_track") → "On Track".
    expect(screen.getByText("On Track")).toBeInTheDocument();
  });

  it("renders a loading affordance while fetching", () => {
    mocks.useEpicGraph.mockReturnValue(q(undefined, true));
    render(<EpicTimelinePage />);
    // The header is always present; the node card is not yet rendered.
    expect(screen.getByText("Roadmap")).toBeInTheDocument();
    expect(screen.queryByText("Auth epic")).not.toBeInTheDocument();
  });

  it("renders the empty state when the graph has no nodes", () => {
    mocks.useEpicGraph.mockReturnValue(
      q({ nodes: [], edges: [], hasCycle: false }),
    );
    render(<EpicTimelinePage />);
    expect(
      screen.getByText("No epics in this roadmap yet."),
    ).toBeInTheDocument();
  });
});
