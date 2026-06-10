import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

// ── Mock the router (Link / useMatches / useNavigate) ────────────
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useMatches: () => [{ fullPath: "/projects/proj-1/" }],
  useNavigate: () => vi.fn(),
}));

// ── Mock the hooks ───────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  useProjects: vi.fn(() => ({ data: [] })),
  useNotesHealth: vi.fn(),
  useClaimsHealth: vi.fn(
    (): { data?: { stale_count: number; oldest_stale_age_ms: number | null } } => ({
      data: undefined,
    }),
  ),
  useCurrentUser: vi.fn(() => ({ data: { role: "member" } })),
}));
vi.mock("@/hooks/use-projects", () => ({ useProjects: mocks.useProjects }));
vi.mock("@/hooks/use-notes", () => ({ useNotesHealth: mocks.useNotesHealth }));
vi.mock("@/hooks/use-train", () => ({ useClaimsHealth: mocks.useClaimsHealth }));
vi.mock("@/hooks/use-auth", () => ({ useCurrentUser: mocks.useCurrentUser }));

// ── Mock the stores ──────────────────────────────────────────────
vi.mock("@/stores/project-store", () => ({
  useProjectStore: () => ({
    currentProjectName: "Proj 1",
    currentProjectId: "proj-1",
    setCurrentProject: vi.fn(),
  }),
}));
vi.mock("@/stores/sidebar-store", () => ({
  useSidebarStore: () => ({ collapsed: false, toggle: vi.fn() }),
}));

import { Sidebar } from "./sidebar";

describe("Sidebar Inbox count badge", () => {
  beforeEach(() => {
    mocks.useNotesHealth.mockReset();
    mocks.useClaimsHealth.mockReturnValue({ data: undefined });
  });

  it("shows the open-note count next to Inbox when > 0", () => {
    mocks.useNotesHealth.mockReturnValue({
      data: { open_count: 7, oldest_untriaged_age_ms: null },
    });
    render(
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>,
    );
    expect(screen.getByText("Inbox")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("hides the count when open_count is 0", () => {
    mocks.useNotesHealth.mockReturnValue({
      data: { open_count: 0, oldest_untriaged_age_ms: null },
    });
    render(
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>,
    );
    expect(screen.getByText("Inbox")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("hides the count when health data is undefined", () => {
    mocks.useNotesHealth.mockReturnValue({ data: undefined });
    render(
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>,
    );
    expect(screen.getByText("Inbox")).toBeInTheDocument();
  });

  // Campaign C3 (claims surface) — the Claims entry surfaces the STALE count
  // from the cache-shared claims-health poll (trainKeys.claimsHealth).
  it("shows the stale-claim count next to Claims when > 0", () => {
    mocks.useNotesHealth.mockReturnValue({ data: undefined });
    mocks.useClaimsHealth.mockReturnValue({
      data: { stale_count: 3, oldest_stale_age_ms: 60_000 },
    });
    render(
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>,
    );
    expect(screen.getByText("Claims")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("hides the Claims count when stale_count is 0", () => {
    mocks.useNotesHealth.mockReturnValue({ data: undefined });
    mocks.useClaimsHealth.mockReturnValue({
      data: { stale_count: 0, oldest_stale_age_ms: null },
    });
    render(
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>,
    );
    expect(screen.getByText("Claims")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
