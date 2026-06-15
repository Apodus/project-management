import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// ── Mocks ──────────────────────────────────────────────────────────
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

const apiMock = vi.hoisted(() => ({
  releaseClaimTo: vi.fn(),
  requestClaimTakeover: vi.fn(),
  getProjectClaims: vi.fn(),
}));
vi.mock("@/lib/api", () => apiMock);

import { useReleaseClaimTo, useRequestClaimTakeover } from "./use-claims";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useReleaseClaimTo", () => {
  it("force_claimed → success toast 'Claim transferred'", async () => {
    apiMock.releaseClaimTo.mockResolvedValue({
      ok: true,
      status: "force_claimed",
      previousHolder: "a",
      newHolder: "b",
    });
    const { result } = renderHook(() => useReleaseClaimTo(), { wrapper });
    result.current.mutate({
      entityType: "task",
      id: "task-1",
      reason: "handing off",
      targetId: "agent-2",
    });
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Claim transferred"));
    expect(apiMock.releaseClaimTo).toHaveBeenCalledWith("task", "task-1", {
      reason: "handing off",
      targetId: "agent-2",
    });
  });

  it("API error → error toast", async () => {
    apiMock.releaseClaimTo.mockRejectedValue(new Error("Target user not found."));
    const { result } = renderHook(() => useReleaseClaimTo(), { wrapper });
    result.current.mutate({
      entityType: "epic",
      id: "epic-1",
      reason: "x",
      targetId: "ghost",
    });
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Target user not found."));
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});

describe("useRequestClaimTakeover", () => {
  it("force_claimed (stale auto-grant) → success toast", async () => {
    apiMock.requestClaimTakeover.mockResolvedValue({
      ok: true,
      status: "force_claimed",
    });
    const { result } = renderHook(() => useRequestClaimTakeover(), { wrapper });
    result.current.mutate({ entityType: "task", id: "task-1", reason: "r" });
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        "Claim transferred",
        expect.objectContaining({ description: expect.any(String) }),
      ),
    );
  });

  it("notified_holder (live claim, NOT mutated) → info toast with the stomp-safety copy", async () => {
    apiMock.requestClaimTakeover.mockResolvedValue({
      ok: false,
      status: "notified_holder",
    });
    const { result } = renderHook(() => useRequestClaimTakeover(), { wrapper });
    result.current.mutate({ entityType: "proposal", id: "prop-1", reason: "r" });
    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith(
        "Holder notified — live claims are never taken over; the claim was not changed",
      ),
    );
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("already_claimed_by_you / not_held → informational no-op toasts", async () => {
    apiMock.requestClaimTakeover.mockResolvedValue({
      ok: true,
      status: "already_claimed_by_you",
    });
    const { result } = renderHook(() => useRequestClaimTakeover(), { wrapper });
    result.current.mutate({ entityType: "task", id: "task-1", reason: "r" });
    await waitFor(() => expect(toastMock.info).toHaveBeenCalledWith("You already hold this claim"));

    apiMock.requestClaimTakeover.mockResolvedValue({
      ok: true,
      status: "not_held",
    });
    result.current.mutate({ entityType: "task", id: "task-2", reason: "r" });
    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith(
        "This item is unclaimed — claim it directly instead",
      ),
    );
  });
});
