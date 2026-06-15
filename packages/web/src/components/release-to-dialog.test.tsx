import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createContext, useContext, type ReactNode } from "react";
import { ApiError, type ClaimItem } from "@/lib/api";

// ── Radix Select mock ──────────────────────────────────────────────
// Radix portals its content only when open (pointer-event driven — hostile in
// jsdom), so the test swaps the Select family for an inline clickable list:
// every SelectItem renders as a button that pushes its value through context.
const SelectCtx = createContext<(v: string) => void>(() => {});

vi.mock("@/components/ui/select", () => ({
  Select: ({
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: (v: string) => void;
    children?: ReactNode;
  }) => <SelectCtx.Provider value={onValueChange}>{children}</SelectCtx.Provider>,
  SelectTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => {
    const onSelect = useContext(SelectCtx);
    return (
      <button type="button" onClick={() => onSelect(value)}>
        {children}
      </button>
    );
  },
}));

// ── Hook mocks ─────────────────────────────────────────────────────
const releaseMutation = {
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ ok: true, status: "force_claimed" }),
  isPending: false,
  reset: vi.fn(),
};
vi.mock("@/hooks/use-claims", () => ({
  useReleaseClaimTo: () => releaseMutation,
}));

let usersResult: { data?: unknown[]; error: Error | null } = {
  data: [],
  error: null,
};
vi.mock("@/hooks/use-users", () => ({
  useUsers: () => usersResult,
}));

import { ReleaseToDialog } from "./release-to-dialog";

const item: ClaimItem = {
  entityType: "task",
  id: "task-1",
  title: "A claimed task",
  status: "in_progress",
  claimState: "stale",
  holder: { id: "agent-1", name: "Agent One", type: "ai_agent" },
  claimedAt: "2026-06-10T08:00:00.000Z",
  updatedAt: "2026-06-10T09:00:00.000Z",
};

function makeUser(id: string, displayName: string, type = "ai_agent") {
  return { id, displayName, type, isActive: true };
}

beforeEach(() => {
  vi.clearAllMocks();
  releaseMutation.mutateAsync.mockResolvedValue({
    ok: true,
    status: "force_claimed",
  });
  usersResult = { data: [], error: null };
});

describe("ReleaseToDialog", () => {
  it("lists active workers EXCLUDING the current holder", () => {
    usersResult = {
      data: [
        makeUser("agent-1", "Agent One"), // current holder — excluded
        makeUser("agent-2", "Agent Two"),
        makeUser("human-1", "Mika", "human"),
        { id: "agent-3", displayName: "Retired", type: "ai_agent", isActive: false },
      ],
      error: null,
    };
    render(<ReleaseToDialog item={item} open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("Agent Two")).toBeInTheDocument();
    expect(screen.getByText("Mika")).toBeInTheDocument();
    // Holder + inactive users are not offered. ("Agent One" still appears in
    // the dialog description, so scope the assertion to buttons.)
    expect(screen.queryByRole("button", { name: /Agent One/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Retired")).not.toBeInTheDocument();
  });

  it("requires BOTH a target and a reason before submit enables", () => {
    usersResult = { data: [makeUser("agent-2", "Agent Two")], error: null };
    render(<ReleaseToDialog item={item} open={true} onOpenChange={vi.fn()} />);

    const submit = screen.getByRole("button", { name: "Release claim" });
    expect(submit).toBeDisabled();

    // Reason alone is not enough.
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "handing off" },
    });
    expect(submit).toBeDisabled();

    // Pick the target → enabled.
    fireEvent.click(screen.getByRole("button", { name: /Agent Two/ }));
    expect(submit).not.toBeDisabled();
  });

  it("submits {entityType, id, targetId, reason} and closes", async () => {
    usersResult = { data: [makeUser("agent-2", "Agent Two")], error: null };
    const onOpenChange = vi.fn();
    render(<ReleaseToDialog item={item} open={true} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Agent Two/ }));
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "  holder went dark  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Release claim" }));

    await waitFor(() =>
      expect(releaseMutation.mutateAsync).toHaveBeenCalledWith({
        entityType: "task",
        id: "task-1",
        targetId: "agent-2",
        reason: "holder went dark",
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders the admin-required notice (no crash) when useUsers 403s", () => {
    usersResult = {
      data: undefined,
      error: new ApiError(403, "FORBIDDEN", "Admin only"),
    };
    render(<ReleaseToDialog item={item} open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText(/Listing workers requires admin access/)).toBeInTheDocument();
    // No picker — and submit can never enable without a target.
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "reason" },
    });
    expect(screen.getByRole("button", { name: "Release claim" })).toBeDisabled();
  });
});
