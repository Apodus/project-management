import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TaskFilters } from "@/lib/api";

// ── Capture the params + the useTasks filter arg ───────────────────
// Each test sets `paramsValue` before render; the router mock reads it.
let paramsValue: { projectId?: string; epicId?: string } = {};
const useTasksSpy = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useParams: () => paramsValue,
  useNavigate: () => vi.fn(),
  // The epic-scoped header uses <Link> — render a plain anchor so it mounts
  // without a RouterProvider.
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

// ── Data hooks ────────────────────────────────────────────────────
vi.mock("@/hooks/use-projects", () => ({
  useProject: () => ({ data: { id: "proj-1", name: "Demo project" } }),
}));

vi.mock("@/hooks/use-tasks", () => ({
  useTasks: (_projectId: string | undefined, filters: TaskFilters) => {
    useTasksSpy(filters);
    return { data: { data: [] }, isLoading: false, error: null, refetch: vi.fn() };
  },
  useTransitionTask: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/hooks/use-epics", () => ({
  useEpics: () => ({
    data: [
      { id: "epic-1", name: "Alpha epic" },
      { id: "epic-2", name: "Beta epic" },
    ],
  }),
}));

vi.mock("@/hooks/use-users", () => ({
  useUsers: () => ({ data: [] }),
}));

vi.mock("@/stores/project-store", () => ({
  useProjectStore: (selector: (s: { setCurrentProject: () => void }) => unknown) =>
    selector({ setCurrentProject: () => {} }),
}));

import { BoardPage } from "./board-page";

beforeEach(() => {
  vi.clearAllMocks();
  paramsValue = {};
});

describe("BoardPage — project-wide", () => {
  beforeEach(() => {
    paramsValue = { projectId: "proj-1" };
  });

  it("fetches only open work (done excluded from the FETCH)", () => {
    render(<BoardPage />);
    const filters = useTasksSpy.mock.calls.at(-1)?.[0] as TaskFilters;
    expect(filters.status).toBe("backlog,ready,in_progress,in_review");
    expect(filters.status).not.toContain("done");
    // No epic pinned on the project-wide board.
    expect(filters.epic).toBeUndefined();
  });

  it("STILL renders the Done column header (drag-to-complete target preserved)", () => {
    render(<BoardPage />);
    // All 5 columns render incl Done — the column is empty, not removed.
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
  });

  it("shows the epic filter dropdown", () => {
    render(<BoardPage />);
    // The Select trigger renders its "Epic" placeholder (dropdown content is
    // portalled only when open, so assert against the always-rendered trigger).
    expect(screen.getByText("Epic")).toBeInTheDocument();
  });
});

describe("BoardPage — epic-scoped", () => {
  beforeEach(() => {
    paramsValue = { projectId: "proj-1", epicId: "epic-1" };
  });

  it("pins the epic into useTasks and passes NO status filter (all 5 columns incl done)", () => {
    render(<BoardPage />);
    const filters = useTasksSpy.mock.calls.at(-1)?.[0] as TaskFilters;
    expect(filters.epic).toBe("epic-1");
    expect(filters.status).toBeUndefined();
  });

  it("hides the epic filter dropdown (the epic is already pinned)", () => {
    render(<BoardPage />);
    // The "Epic" placeholder belongs to the now-hidden epic Select trigger.
    expect(screen.queryByText("Epic")).not.toBeInTheDocument();
  });

  it("renders the scoped epic name in the header + a back link", () => {
    render(<BoardPage />);
    expect(screen.getByText("Alpha epic")).toBeInTheDocument();
    expect(screen.getByText("Back to epic")).toBeInTheDocument();
  });

  it("still renders all 5 board columns incl Done", () => {
    render(<BoardPage />);
    expect(screen.getByText("Done")).toBeInTheDocument();
  });
});
