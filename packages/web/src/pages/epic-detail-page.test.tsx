import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock router (Link / useNavigate / useParams) ─────────────────
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ epicId: "epic-1" }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

// ── Mock the project store ───────────────────────────────────────
vi.mock("@/stores/project-store", () => ({
  useProjectStore: (selector: (s: { currentProjectId: string }) => unknown) =>
    selector({ currentProjectId: "proj-1" }),
}));

// ── Mock the hooks ───────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  useEpic: vi.fn(),
  useUpdateEpic: vi.fn(),
  useClaimEpic: vi.fn(),
  useReleaseEpic: vi.fn(),
  useTasks: vi.fn(),
  useMilestones: vi.fn(),
  useProject: vi.fn(),
  useUsers: vi.fn(),
  useCurrentUser: vi.fn(),
  updateMutate: vi.fn(),
}));

vi.mock("@/hooks/use-epics", () => ({
  useEpic: mocks.useEpic,
  useUpdateEpic: mocks.useUpdateEpic,
  useClaimEpic: mocks.useClaimEpic,
  useReleaseEpic: mocks.useReleaseEpic,
}));
vi.mock("@/hooks/use-tasks", () => ({ useTasks: mocks.useTasks }));
vi.mock("@/hooks/use-milestones", () => ({
  useMilestones: mocks.useMilestones,
}));
vi.mock("@/hooks/use-projects", () => ({ useProject: mocks.useProject }));
vi.mock("@/hooks/use-users", () => ({ useUsers: mocks.useUsers }));
vi.mock("@/hooks/use-auth", () => ({ useCurrentUser: mocks.useCurrentUser }));

import { EpicDetailPage } from "./epic-detail-page";

// ── Fixtures ─────────────────────────────────────────────────────

const CATEGORIES = [
  { name: "Frontend", color: "#3b82f6", sort_order: 0 },
  { name: "Backend", color: "#10b981", sort_order: 1 },
];

function makeEpic(overrides: Record<string, unknown> = {}) {
  return {
    id: "epic-1",
    projectId: "proj-1",
    name: "My Epic",
    description: null,
    status: "active",
    priority: "medium",
    category: null,
    milestoneId: null,
    assigneeId: null,
    createdAt: new Date().toISOString(),
    createdBy: null,
    proposalId: null,
    targetDate: null,
    taskSummary: { total: 0, done: 0, byStatus: {} },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useEpic.mockReturnValue({
    data: makeEpic(),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.useUpdateEpic.mockReturnValue({
    mutate: mocks.updateMutate,
    isPending: false,
  });
  mocks.useClaimEpic.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mocks.useReleaseEpic.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mocks.useTasks.mockReturnValue({ data: { data: [] }, isLoading: false });
  mocks.useMilestones.mockReturnValue({ data: [] });
  mocks.useProject.mockReturnValue({
    data: { id: "proj-1", settings: { epic_categories: CATEGORIES } },
  });
  mocks.useUsers.mockReturnValue({ data: [] });
  mocks.useCurrentUser.mockReturnValue({ data: { id: "u-1", role: "admin" } });
});

describe("EpicDetailPage — category assign", () => {
  it("renders the Category select with None + the project categories", () => {
    render(<EpicDetailPage />);
    act(() => {
      fireEvent.click(screen.getByRole("combobox", { name: "Category" }));
    });
    expect(
      screen.getByRole("option", { name: "Frontend" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Backend" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument();
  });

  it("selecting a category calls update with { category: <name> }", async () => {
    render(<EpicDetailPage />);
    act(() => {
      fireEvent.click(screen.getByRole("combobox", { name: "Category" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("option", { name: "Frontend" }));
    });
    await waitFor(() => expect(mocks.updateMutate).toHaveBeenCalled());
    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: "epic-1",
      data: { category: "Frontend" },
    });
  });

  it("selecting None clears the category with { category: null }", async () => {
    mocks.useEpic.mockReturnValue({
      data: makeEpic({ category: "Frontend" }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<EpicDetailPage />);
    // Trigger reflects the assigned category.
    expect(
      within(
        screen.getByRole("combobox", { name: "Category" }),
      ).getByText("Frontend"),
    ).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByRole("combobox", { name: "Category" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("option", { name: "None" }));
    });
    await waitFor(() => expect(mocks.updateMutate).toHaveBeenCalled());
    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: "epic-1",
      data: { category: null },
    });
  });
});
