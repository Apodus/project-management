import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { TaskGraph } from "@/lib/api";

// ── Mock the router (Link passthrough + useNavigate spy) ─────────
const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateSpy,
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a data-testid="link" data-to={to} data-params={JSON.stringify(params)}>
      {children}
    </a>
  ),
}));

// ── Mock React Flow (passthrough renders node titles as divs) ────
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ nodes }: { nodes: { id: string; data: { title: string } }[] }) => (
    <div>
      {nodes.map((n) => (
        <div key={n.id} data-testid="rf-node">
          {n.data.title}
        </div>
      ))}
    </div>
  ),
  Background: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  MarkerType: {},
  ViewportPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@xyflow/react/dist/style.css", () => ({}));

// ── Mock the task-graph hook (controllable) ──────────────────────
const mocks = vi.hoisted(() => ({ useTaskGraph: vi.fn() }));
vi.mock("@/hooks/use-task-graph", () => ({
  useTaskGraph: mocks.useTaskGraph,
}));

import { EpicTasksPanel } from "./epic-tasks-panel";

function twoTaskGraph(): TaskGraph {
  return {
    nodes: [
      {
        id: "t1",
        title: "Wire up auth",
        status: "in_progress",
        priority: "high",
        type: "feature",
        assignee_id: "alice",
        done: false,
      },
      {
        id: "t2",
        title: "Add login form",
        status: "backlog",
        priority: "medium",
        type: "feature",
        assignee_id: null,
        done: false,
      },
    ],
    edges: [{ from: "t1", to: "t2", dependency_type: "blocks", provenance: "explicit" }],
    hasCycle: false,
  };
}

function q<T>(data: T | undefined, isLoading = false, error: unknown = null) {
  return { data, isLoading, error } as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTaskGraph.mockReturnValue(q(twoTaskGraph()));
});

describe("EpicTasksPanel", () => {
  it("renders a node for each task in the graph", () => {
    render(<EpicTasksPanel projectId="p1" epicId="e1" epicName="Auth epic" onClose={() => {}} />);
    expect(screen.getByText("Wire up auth")).toBeInTheDocument();
    expect(screen.getByText("Add login form")).toBeInTheDocument();
  });

  it("calls onClose when the ✕ button is clicked", () => {
    const onClose = vi.fn();
    render(<EpicTasksPanel projectId="p1" epicId="e1" epicName="Auth epic" onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close panel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<EpicTasksPanel projectId="p1" epicId="e1" epicName="Auth epic" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders an 'Open full epic' link to the epic detail route", () => {
    render(<EpicTasksPanel projectId="p1" epicId="e1" epicName="Auth epic" onClose={() => {}} />);
    const link = screen.getByTestId("link");
    expect(link).toHaveAttribute("data-to", "/epics/$epicId");
    expect(link).toHaveAttribute("data-params", JSON.stringify({ epicId: "e1" }));
  });

  it("renders the empty state when the epic has no tasks", () => {
    mocks.useTaskGraph.mockReturnValue(q({ nodes: [], edges: [], hasCycle: false }));
    render(<EpicTasksPanel projectId="p1" epicId="e1" epicName="Auth epic" onClose={() => {}} />);
    expect(screen.getByText("No tasks in this epic yet.")).toBeInTheDocument();
  });

  it("renders a loading affordance while fetching", () => {
    mocks.useTaskGraph.mockReturnValue(q(undefined, true));
    render(<EpicTasksPanel projectId="p1" epicId="e1" epicName="Auth epic" onClose={() => {}} />);
    expect(screen.queryByText("Wire up auth")).not.toBeInTheDocument();
    expect(screen.queryByText("No tasks in this epic yet.")).not.toBeInTheDocument();
  });
});
