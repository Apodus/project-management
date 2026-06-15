import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task } from "@/lib/api";

// ── Router mock (board-page idiom) ─────────────────────────────────
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

// ── Data hooks ─────────────────────────────────────────────────────
let tasksData: Task[] = [];

vi.mock("@/hooks/use-projects", () => ({
  useProject: () => ({ data: { id: "proj-1", name: "Demo project" } }),
}));

vi.mock("@/hooks/use-tasks", () => ({
  taskKeys: { lists: () => ["tasks", "list"] },
  useTasks: () => ({
    data: {
      data: tasksData,
      pagination: { page: 1, total: tasksData.length, totalPages: 1 },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-epics", () => ({
  useEpics: () => ({ data: [] }),
}));

vi.mock("@/hooks/use-users", () => ({
  useUsers: () => ({ data: [] }),
}));

vi.mock("@/stores/project-store", () => ({
  useProjectStore: (selector: (s: { setCurrentProject: () => void }) => unknown) =>
    selector({ setCurrentProject: () => {} }),
}));

import { TaskListPage } from "./task-list-page";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    proposalId: null,
    epicId: null,
    parentTaskId: null,
    title: "A task",
    description: null,
    status: "in_progress",
    priority: "medium",
    type: "feature",
    assigneeId: null,
    reporterId: "user-1",
    estimatedEffort: null,
    dueDate: null,
    sortOrder: 0,
    gitBranch: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    epicName: null,
    projectName: null,
    parentTaskTitle: null,
    assigneeName: null,
    assigneeType: null,
    reporterName: null,
    reporterType: null,
    claimStatus: "unclaimed",
    claimState: "unclaimed",
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TaskListPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tasksData = [];
});

// Campaign C3 P4 — ClaimStateBadge inline in the title cell (no new column).
describe("TaskListPage claim badge", () => {
  it("renders a Stale badge beside a stale-claimed task title", () => {
    tasksData = [
      makeTask({
        id: "t1",
        title: "Stale-claimed task",
        assigneeId: "agent-1",
        claimStatus: "claimed_by_other",
        claimState: "stale",
      }),
    ];
    renderPage();
    expect(screen.getByText("Stale-claimed task")).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
  });

  it("renders NO claim badge for an unclaimed task", () => {
    tasksData = [makeTask({ id: "t1", title: "Unclaimed task", claimState: "unclaimed" })];
    renderPage();
    expect(screen.getByText("Unclaimed task")).toBeInTheDocument();
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(screen.queryByText("Yours")).not.toBeInTheDocument();
  });

  it("keeps the table at 9 columns (badge is inline, not a new column)", () => {
    tasksData = [makeTask({ id: "t1", title: "Any task", claimState: "live" })];
    renderPage();
    const headerCells = screen.getAllByRole("columnheader");
    expect(headerCells).toHaveLength(9);
  });
});
