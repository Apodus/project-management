import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock the router (param hook) ─────────────────────────────────
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

// ── Stub the extracted canvas ────────────────────────────────────
// The page is now a thin shell over <EpicRoadmapCanvas>; the canvas itself is
// tested in epic-roadmap-canvas.test.tsx. Here we only assert the page wires
// the header identity and plumbs the props (projectId + variant) into it.
vi.mock("@/components/epic-roadmap-canvas", () => ({
  EpicRoadmapCanvas: (props: { projectId?: string; variant?: string }) => (
    <div
      data-testid="roadmap-canvas"
      data-project-id={props.projectId}
      data-variant={props.variant}
    />
  ),
}));

// ── Mock the query hook the page calls ───────────────────────────
const mocks = vi.hoisted(() => ({
  useProject: vi.fn(),
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

function q<T>(data: T | undefined) {
  return { data } as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useProject.mockReturnValue(q({ id: "proj-1", name: "Demo project" }));
});

describe("EpicTimelinePage", () => {
  it("renders the header identity (title + project badge)", () => {
    render(<EpicTimelinePage />);
    expect(screen.getByText("Roadmap")).toBeInTheDocument();
    expect(screen.getByText("Demo project")).toBeInTheDocument();
  });

  it("plumbs projectId + the full variant into the embedded canvas", () => {
    render(<EpicTimelinePage />);
    const canvas = screen.getByTestId("roadmap-canvas");
    expect(canvas).toHaveAttribute("data-variant", "full");
    expect(canvas).toHaveAttribute("data-project-id", "proj-1");
  });
});
