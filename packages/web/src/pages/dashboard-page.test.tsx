import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Capture the navigate spy ─────────────────────────────────────
const navigateSpy = vi.fn();

// ── Mock the router ──────────────────────────────────────────────
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useNavigate: () => navigateSpy,
}));

// ── Stub the embedded canvas ─────────────────────────────────────
// The dashboard hero embeds <EpicRoadmapCanvas>; here we only assert the
// dashboard plumbs the props (projectId + compact variant) into it.
vi.mock("@/components/epic-roadmap-canvas", () => ({
  EpicRoadmapCanvas: (props: { projectId?: string; variant?: string }) => (
    <div
      data-testid="roadmap-hero"
      data-project-id={props.projectId}
      data-variant={props.variant}
    />
  ),
}));

// The page calls useProjectStore((s) => s.setCurrentProject) — stub the
// selector so it returns a no-op rather than touching the real store.
vi.mock("@/stores/project-store", () => ({
  useProjectStore: (selector: (s: { setCurrentProject: () => void }) => unknown) =>
    selector({ setCurrentProject: () => {} }),
}));

// ── Mock every data hook the dashboard calls (render throws otherwise) ──
vi.mock("@/hooks/use-projects", () => ({
  useProject: () => ({ data: { id: "proj-1", name: "Demo project" } }),
  useProjectStats: () => ({
    data: {
      tasksByStatus: {},
      totalTasks: 0,
      epicCount: 0,
      proposalCount: 0,
    },
  }),
}));
vi.mock("@/hooks/use-activity", () => ({
  useProjectActivity: () => ({ data: { data: [] } }),
}));
vi.mock("@/hooks/use-tasks", () => ({
  useTasks: () => ({ data: { data: [], pagination: { total: 0 } } }),
}));
vi.mock("@/hooks/use-proposals", () => ({
  useProposals: () => ({ data: [] }),
}));
vi.mock("@/hooks/use-users", () => ({
  useUsers: () => ({ data: [] }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useCurrentUser: () => ({ data: { id: "user-1" } }),
}));

import { DashboardPage } from "./dashboard-page";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DashboardPage", () => {
  it("plumbs projectId + the compact variant into the embedded hero canvas", () => {
    render(<DashboardPage />);
    const hero = screen.getByTestId("roadmap-hero");
    expect(hero).toHaveAttribute("data-variant", "compact");
    expect(hero).toHaveAttribute("data-project-id", "proj-1");
  });

  it("links the hero to the full roadmap route", () => {
    render(<DashboardPage />);
    const trigger = screen.getByText("Open full roadmap");
    expect(trigger).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/projects/$projectId/roadmap",
      params: { projectId: "proj-1" },
    });
  });

  it("still renders the pulse dressing widgets below the hero", () => {
    render(<DashboardPage />);
    expect(screen.getByText("Recent Activity")).toBeInTheDocument();
    expect(screen.getByText("Active AI Agents")).toBeInTheDocument();
    expect(screen.getByText("Proposal Pipeline")).toBeInTheDocument();
  });

  it("collapses My Tasks to nothing when the assignee has no open work", () => {
    render(<DashboardPage />);
    expect(screen.queryByText("My Tasks")).not.toBeInTheDocument();
  });
});
