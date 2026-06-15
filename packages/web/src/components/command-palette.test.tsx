import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SearchResult } from "@/lib/api";

// ── Command palette on server FTS (Campaign C4 P5) ─────────────────
// One search() call feeds Tasks/Proposals/Notes groups (rank order, ≤8 each);
// comment hits are dropped (no navigation target); a note hit navigates to
// the project inbox with the hit title seeded as the free-text query.

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/stores/project-store", () => ({
  useProjectStore: (selector: (s: { currentProjectId: string | null }) => unknown) =>
    selector({ currentProjectId: "proj-1" }),
}));

const searchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  search: (q: string, opts: unknown) => searchMock(q, opts) as Promise<SearchResult[]>,
}));

import { CommandPalette } from "./command-palette";

function makeHit(entityType: string, entityId: string, title: string, rank = -1): SearchResult {
  return {
    entityType,
    entityId,
    title,
    excerpt: `…${title}…`,
    rank,
    projectId: "proj-1",
  } as SearchResult;
}

async function typeQuery(value: string) {
  fireEvent.change(screen.getByPlaceholderText("Search tasks, proposals, or type a command..."), {
    target: { value },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  searchMock.mockResolvedValue([]);
});

describe("CommandPalette (server FTS)", () => {
  it("renders grouped Tasks/Proposals/Notes from ONE search() call; comment hits are dropped", async () => {
    searchMock.mockResolvedValue([
      makeHit("note", "n1", "Note about caching", -3),
      makeHit("task", "t1", "Cache the responses", -2.5),
      makeHit("comment", "c1", "A comment mentioning cache", -2),
      makeHit("proposal", "p1", "Proposal: cache layer", -1.5),
      makeHit("task", "t2", "Invalidate cache on write", -1),
    ]);
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);
    await typeQuery("cache");

    // Debounced 300ms, then the single FTS call.
    await waitFor(() =>
      expect(searchMock).toHaveBeenCalledWith("cache", {
        projectId: "proj-1",
        limit: 24,
      }),
    );
    expect(searchMock).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(screen.getByText("Cache the responses")).toBeInTheDocument());
    // Group headings (cmdk renders heading via aria-label + visible div).
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("Proposals")).toBeInTheDocument();
    expect(screen.getByText("Notes")).toBeInTheDocument();
    // All non-comment hits visible.
    expect(screen.getByText("Invalidate cache on write")).toBeInTheDocument();
    expect(screen.getByText("Proposal: cache layer")).toBeInTheDocument();
    expect(screen.getByText("Note about caching")).toBeInTheDocument();
    // Comment hits have no nav target → dropped, never rendered.
    expect(screen.queryByText("A comment mentioning cache")).not.toBeInTheDocument();
  });

  it("caps each group at 8 hits (rank order)", async () => {
    searchMock.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => makeHit("task", `t${i}`, `cap-task-${i}`, -10 + i)),
    );
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);
    await typeQuery("cap");

    await waitFor(() => expect(screen.getByText("cap-task-0")).toBeInTheDocument());
    expect(screen.getByText("cap-task-7")).toBeInTheDocument();
    expect(screen.queryByText("cap-task-8")).not.toBeInTheDocument();
    expect(screen.queryByText("cap-task-9")).not.toBeInTheDocument();
  });

  it("selecting a NOTE hit navigates to the project inbox with q seeded from the hit title", async () => {
    searchMock.mockResolvedValue([makeHit("note", "n1", "Flicker on login", -2)]);
    const onOpenChange = vi.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);
    await typeQuery("flicker");

    await waitFor(() => expect(screen.getByText("Flicker on login")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Flicker on login"));

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/projects/$projectId/notes",
      params: { projectId: "proj-1" },
      search: { q: "Flicker on login" },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("selecting a TASK hit navigates to the task detail (parity)", async () => {
    searchMock.mockResolvedValue([makeHit("task", "t9", "Fix the spinner", -2)]);
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);
    await typeQuery("spinner");

    await waitFor(() => expect(screen.getByText("Fix the spinner")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Fix the spinner"));

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/tasks/$taskId",
      params: { taskId: "t9" },
    });
  });
});
