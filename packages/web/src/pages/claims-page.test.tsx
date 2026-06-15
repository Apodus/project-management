import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ClaimItem, ProjectClaims } from "@/lib/api";

// ── Router mock (board-page idiom: no RouterProvider needed) ───────
let paramsValue: { projectId?: string } = {};

vi.mock("@tanstack/react-router", () => ({
  useParams: () => paramsValue,
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

// ── Data hooks ────────────────────────────────────────────────────
vi.mock("@/hooks/use-projects", () => ({
  useProject: () => ({ data: { id: "proj-1", name: "Demo project" } }),
}));

let claimsResult: {
  data: ProjectClaims | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} = { data: undefined, isLoading: false, error: null, refetch: vi.fn() };

const plainReleaseMutation = {
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ ok: true, status: "released" }),
  isPending: false,
  reset: vi.fn(),
};
const releaseMutation = {
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ ok: true, status: "force_claimed" }),
  isPending: false,
  reset: vi.fn(),
};
const takeoverMutation = {
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ ok: true, status: "force_claimed" }),
  isPending: false,
  reset: vi.fn(),
};

vi.mock("@/hooks/use-claims", () => ({
  useProjectClaims: () => claimsResult,
  useReleaseClaim: () => plainReleaseMutation,
  useReleaseClaimTo: () => releaseMutation,
  useRequestClaimTakeover: () => takeoverMutation,
  claimKeys: { all: ["claims"] },
}));

vi.mock("@/hooks/use-users", () => ({
  useUsers: () => ({ data: [], error: null }),
}));

vi.mock("@/stores/project-store", () => ({
  useProjectStore: (selector: (s: { setCurrentProject: () => void }) => unknown) =>
    selector({ setCurrentProject: () => {} }),
}));

import { ClaimsPage } from "./claims-page";

function makeItem(overrides: Partial<ClaimItem>): ClaimItem {
  return {
    entityType: "task",
    id: "task-1",
    title: "A claimed task",
    status: "in_progress",
    claimState: "live",
    holder: { id: "agent-1", name: "Agent One", type: "ai_agent" },
    claimedAt: "2026-06-10T08:00:00.000Z",
    updatedAt: "2026-06-10T09:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  paramsValue = { projectId: "proj-1" };
  claimsResult = { data: undefined, isLoading: false, error: null, refetch: vi.fn() };
});

describe("ClaimsPage", () => {
  it("renders the empty state when there are no claims", () => {
    claimsResult.data = { items: [], total: 0 };
    render(<ClaimsPage />);
    expect(screen.getByText("No active claims.")).toBeInTheDocument();
  });

  it("renders a row per claim with holder name and claim-state badge", () => {
    claimsResult.data = {
      items: [
        makeItem({
          id: "task-1",
          title: "Live task",
          claimState: "live",
          holder: { id: "a1", name: "Worker Alpha", type: "ai_agent" },
        }),
        makeItem({
          entityType: "epic",
          id: "epic-1",
          title: "Stale epic",
          status: "active",
          claimState: "stale",
          holder: { id: "a2", name: "Worker Beta", type: "ai_agent" },
        }),
      ],
      total: 2,
    };
    render(<ClaimsPage />);

    expect(screen.getByText("Live task")).toBeInTheDocument();
    expect(screen.getByText("Stale epic")).toBeInTheDocument();
    expect(screen.getByText("Worker Alpha")).toBeInTheDocument();
    expect(screen.getByText("Worker Beta")).toBeInTheDocument();
    // ClaimStateBadge renders its state label.
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
  });

  it("groups stale claims FIRST regardless of payload order", () => {
    claimsResult.data = {
      items: [
        makeItem({ id: "t-live", title: "Row live", claimState: "live" }),
        makeItem({ id: "t-yours", title: "Row yours", claimState: "yours" }),
        makeItem({ id: "t-stale", title: "Row stale", claimState: "stale" }),
      ],
      total: 3,
    };
    render(<ClaimsPage />);

    const rows = screen.getAllByRole("row");
    // rows[0] is the header row; data rows follow in render order.
    const dataRowTitles = rows
      .slice(1)
      .map((r) => r.textContent ?? "")
      .filter((t) => t.includes("Row "));
    expect(dataRowTitles[0]).toContain("Row stale");
    expect(dataRowTitles[1]).toContain("Row live");
    expect(dataRowTitles[2]).toContain("Row yours");
  });

  it("renders the handoff action buttons per row (takeover hidden on yours)", () => {
    claimsResult.data = {
      items: [
        makeItem({ id: "t-other", title: "Held by other", claimState: "live" }),
        makeItem({ id: "t-mine", title: "Held by me", claimState: "yours" }),
      ],
      total: 2,
    };
    render(<ClaimsPage />);
    // A plain Release and Release-to are offered on every row; request-takeover
    // only on rows the caller does NOT already hold.
    expect(screen.getAllByRole("button", { name: "Release" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Release to…" })).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Request takeover" }),
    ).toHaveLength(1);
  });

  it("releases a claim outright via the plain Release action", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    claimsResult.data = {
      items: [makeItem({ id: "t-dead", title: "Dead claim", claimState: "live" })],
      total: 1,
    };
    render(<ClaimsPage />);

    await user.click(screen.getByRole("button", { name: "Release" }));
    // Confirm in the dialog (the dialog's primary button shares the label).
    const confirm = screen.getAllByRole("button", { name: "Release claim" });
    await user.click(confirm[confirm.length - 1]);

    expect(plainReleaseMutation.mutateAsync).toHaveBeenCalledWith({
      entityType: "task",
      id: "t-dead",
    });
  });

  it("marks AI holders with an AI tag", () => {
    claimsResult.data = {
      items: [
        makeItem({
          holder: { id: "h1", name: "Mika", type: "human" },
          id: "t-h",
          title: "Human-held",
        }),
        makeItem({
          holder: { id: "a1", name: "Botty", type: "ai_agent" },
          id: "t-a",
          title: "Agent-held",
        }),
      ],
      total: 2,
    };
    render(<ClaimsPage />);
    expect(screen.getAllByText("AI")).toHaveLength(1);
  });
});
