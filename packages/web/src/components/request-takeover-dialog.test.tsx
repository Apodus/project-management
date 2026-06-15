import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ClaimItem } from "@/lib/api";

const takeoverMutation = {
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ ok: true, status: "force_claimed" }),
  isPending: false,
  reset: vi.fn(),
};
vi.mock("@/hooks/use-claims", () => ({
  useRequestClaimTakeover: () => takeoverMutation,
}));

import { RequestTakeoverDialog } from "./request-takeover-dialog";

const item: ClaimItem = {
  entityType: "epic",
  id: "epic-1",
  title: "A claimed epic",
  status: "active",
  claimState: "stale",
  holder: { id: "agent-1", name: "Agent One", type: "ai_agent" },
  claimedAt: "2026-06-10T08:00:00.000Z",
  updatedAt: "2026-06-10T09:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  takeoverMutation.mutateAsync.mockResolvedValue({
    ok: true,
    status: "force_claimed",
  });
});

describe("RequestTakeoverDialog", () => {
  it("states BOTH outcomes in the copy (stale auto-grant; live never mutated)", () => {
    render(<RequestTakeoverDialog item={item} open={true} onOpenChange={vi.fn()} />);
    const description = screen.getByText(/Ask to take over/);
    expect(description.textContent).toMatch(/stale.*transferred to you/i);
    expect(description.textContent).toMatch(/live.*holder is notified.*NOT changed/i);
    expect(description.textContent).toMatch(/never taken over/i);
  });

  it("requires a reason before submit enables", () => {
    render(<RequestTakeoverDialog item={item} open={true} onOpenChange={vi.fn()} />);
    const submit = screen.getByRole("button", { name: "Request takeover" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "holder inactive" },
    });
    expect(submit).not.toBeDisabled();
  });

  it("submits {entityType, id, reason} and closes", async () => {
    const onOpenChange = vi.fn();
    render(<RequestTakeoverDialog item={item} open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "  picking up abandoned work  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request takeover" }));

    await waitFor(() =>
      expect(takeoverMutation.mutateAsync).toHaveBeenCalledWith({
        entityType: "epic",
        id: "epic-1",
        reason: "picking up abandoned work",
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
