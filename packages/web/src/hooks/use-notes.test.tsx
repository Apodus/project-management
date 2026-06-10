import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// ── Mocks ──────────────────────────────────────────────────────────
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const apiMock = vi.hoisted(() => ({
  getNotes: vi.fn(),
  getNote: vi.fn(),
  getNotesHealth: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  dismissNote: vi.fn(),
  promoteNoteToProposal: vi.fn(),
  promoteNoteToTask: vi.fn(),
}));
vi.mock("@/lib/api", () => apiMock);

import { usePromoteNoteToProposal, usePromoteNoteToTask } from "./use-notes";
import { taskKeys } from "./use-tasks";
import { proposalKeys } from "./use-proposals";

// ── C3 P5 — project-scoped promote invalidations ───────────────────
// The promote mutations must refresh ONLY the promoted-into project's
// task/proposal lists (listsFor(projectId) partial object matching), never
// every project's. Two projects are seeded; only the matching one flips
// isInvalidated.

describe("use-notes promote mutations — project-scoped invalidation", () => {
  let client: QueryClient;

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("promote-to-task invalidates ONLY the matching project's task lists (incl. filtered keys)", async () => {
    apiMock.promoteNoteToTask.mockResolvedValue({ data: {}, task: { id: "t" } });

    // Seed both a bare and a filtered list key per project — the filtered key
    // proves the {projectId} partial object match reaches keys with extra
    // filter fields.
    client.setQueryData(taskKeys.list("proj-1"), { data: [] });
    client.setQueryData(taskKeys.list("proj-1", { status: "ready" }), { data: [] });
    client.setQueryData(taskKeys.list("proj-2"), { data: [] });

    const { result } = renderHook(() => usePromoteNoteToTask(), { wrapper });
    result.current.mutate({ id: "n1", projectId: "proj-1", title: "T" });

    await waitFor(() =>
      expect(
        client.getQueryState(taskKeys.list("proj-1"))?.isInvalidated,
      ).toBe(true),
    );
    expect(
      client.getQueryState(taskKeys.list("proj-1", { status: "ready" }))
        ?.isInvalidated,
    ).toBe(true);
    // The OTHER project's list is untouched.
    expect(client.getQueryState(taskKeys.list("proj-2"))?.isInvalidated).toBe(
      false,
    );
  });

  it("promote-to-proposal invalidates ONLY the matching project's proposal lists", async () => {
    apiMock.promoteNoteToProposal.mockResolvedValue({
      data: {},
      proposal: { id: "p" },
    });

    client.setQueryData(proposalKeys.list("proj-1"), []);
    client.setQueryData(proposalKeys.list("proj-1", "open"), []);
    client.setQueryData(proposalKeys.list("proj-2"), []);

    const { result } = renderHook(() => usePromoteNoteToProposal(), { wrapper });
    result.current.mutate({ id: "n1", projectId: "proj-1", title: "P" });

    await waitFor(() =>
      expect(
        client.getQueryState(proposalKeys.list("proj-1"))?.isInvalidated,
      ).toBe(true),
    );
    expect(
      client.getQueryState(proposalKeys.list("proj-1", "open"))?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(proposalKeys.list("proj-2"))?.isInvalidated,
    ).toBe(false);
  });
});
