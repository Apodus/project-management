import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Task } from "@/lib/api";

// ── Router mock ────────────────────────────────────────────────────
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ taskId: "task-1" }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

// ── Data hooks ─────────────────────────────────────────────────────
let taskData: Task | undefined;

function mutation() {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
    reset: vi.fn(),
  };
}

vi.mock("@/hooks/use-tasks", () => ({
  useTask: () => ({
    data: taskData,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useTaskComments: () => ({ data: [], isLoading: false }),
  useTaskSubtasks: () => ({ data: [], isLoading: false }),
  useUpdateTask: () => mutation(),
  useAddTaskComment: () => mutation(),
}));

vi.mock("@/hooks/use-templates", () => ({
  useCreateTemplateFromTask: () => mutation(),
}));

vi.mock("@/hooks/use-users", () => ({
  useUsers: () => ({ data: [] }),
}));

// The anchored-notes badge pulls its own query — stub it out (covered by its
// own component test).
vi.mock("@/components/anchored-notes-badge", () => ({
  AnchoredNotesBadge: () => null,
}));

vi.mock("@/stores/project-store", () => ({
  useProjectStore: (selector: (s: { currentProjectId: string | null }) => unknown) =>
    selector({ currentProjectId: "proj-1" }),
}));

import { TaskDetailPage } from "./task-detail-page";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    proposalId: null,
    epicId: null,
    parentTaskId: null,
    title: "Detail task",
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

beforeEach(() => {
  vi.clearAllMocks();
  taskData = undefined;
});

// Campaign C3 P4 — ClaimStateBadge in the header meta row.
describe("TaskDetailPage claim badge", () => {
  it("renders a Stale badge in the header for a stale-claimed task", () => {
    taskData = makeTask({
      assigneeId: "agent-1",
      claimStatus: "claimed_by_other",
      claimState: "stale",
    });
    render(<TaskDetailPage />);
    expect(screen.getByText("Detail task")).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
  });

  it("renders a Yours badge for a self-held task", () => {
    taskData = makeTask({
      assigneeId: "me",
      claimStatus: "claimed_by_you",
      claimState: "yours",
    });
    render(<TaskDetailPage />);
    expect(screen.getByText("Yours")).toBeInTheDocument();
  });

  it("renders NO claim badge for an unclaimed task", () => {
    taskData = makeTask({ claimState: "unclaimed" });
    render(<TaskDetailPage />);
    expect(screen.getByText("Detail task")).toBeInTheDocument();
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(screen.queryByText("Yours")).not.toBeInTheDocument();
  });
});
