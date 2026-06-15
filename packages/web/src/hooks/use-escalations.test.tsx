import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const apiMock = vi.hoisted(() => ({
  getEscalations: vi.fn(),
  getEscalation: vi.fn(),
}));
vi.mock("@/lib/api", () => apiMock);

import { useEscalations, useEscalation } from "./use-escalations";

describe("use-escalations query hooks", () => {
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

  it("useEscalations is disabled (no fetch) when projectId is undefined", () => {
    renderHook(() => useEscalations(undefined), { wrapper });
    expect(apiMock.getEscalations).not.toHaveBeenCalled();
  });

  it("useEscalations fetches with the projectId + filters", async () => {
    apiMock.getEscalations.mockResolvedValue({
      data: [],
      pagination: { total: 0 },
    });
    const filters = { status: "open" as const };
    renderHook(() => useEscalations("proj-1", filters), { wrapper });
    await waitFor(() => expect(apiMock.getEscalations).toHaveBeenCalledWith("proj-1", filters));
  });

  it("useEscalation is disabled when id is undefined", () => {
    renderHook(() => useEscalation(undefined), { wrapper });
    expect(apiMock.getEscalation).not.toHaveBeenCalled();
  });

  it("useEscalation fetches by id", async () => {
    apiMock.getEscalation.mockResolvedValue({ id: "esc-1", messages: [] });
    renderHook(() => useEscalation("esc-1"), { wrapper });
    await waitFor(() => expect(apiMock.getEscalation).toHaveBeenCalledWith("esc-1"));
  });
});
