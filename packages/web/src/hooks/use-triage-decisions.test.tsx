import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// ── Mocks ──────────────────────────────────────────────────────────
const apiMock = vi.hoisted(() => ({
  getTriageDecisions: vi.fn(),
}));
vi.mock("@/lib/api", () => apiMock);

import { useTriageDecisions } from "./use-triage-decisions";

describe("useTriageDecisions", () => {
  let client: QueryClient;

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it("calls getTriageDecisions with the {noteId} filter and exposes the rows", async () => {
    const rows = [{ id: "d1", noteId: "n1", mode: "on", decision: "dismiss" }];
    apiMock.getTriageDecisions.mockResolvedValue({ data: rows, pagination: { total: 1 } });

    const { result } = renderHook(() => useTriageDecisions("proj-1", { noteId: "n1" }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMock.getTriageDecisions).toHaveBeenCalledWith("proj-1", { noteId: "n1" });
    expect(result.current.data?.data).toEqual(rows);
  });

  it("respects enabled:false (does NOT fetch)", () => {
    apiMock.getTriageDecisions.mockResolvedValue({ data: [], pagination: { total: 0 } });

    renderHook(() => useTriageDecisions("proj-1", { noteId: "n1" }, { enabled: false }), {
      wrapper,
    });

    expect(apiMock.getTriageDecisions).not.toHaveBeenCalled();
  });
});
