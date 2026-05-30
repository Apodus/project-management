import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLogEntry } from "@/lib/api";

// ── Mock the router param hook + Link ────────────────────────────
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
    [key: string]: unknown;
  }) => {
    let href = to ?? "";
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        href = href.replace(`$${k}`, v);
      }
    }
    return (
      <a href={href} {...(rest as Record<string, unknown>)}>
        {children}
      </a>
    );
  },
}));

// ── Mock the auth + train hooks ──────────────────────────────────
const authMocks = vi.hoisted(() => ({
  useCurrentUser: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => authMocks);

const trainMocks = vi.hoisted(() => ({
  useAuditLog: vi.fn(),
  useTrainState: vi.fn(),
  usePauseTrain: vi.fn(),
  useResumeTrain: vi.fn(),
  useForceReleaseLock: vi.fn(),
  useForceLand: vi.fn(),
  useForceReject: vi.fn(),
}));
vi.mock("@/hooks/use-train", () => trainMocks);

import { TrainAuditPage } from "./train-audit-page";

// ── Fixtures ─────────────────────────────────────────────────────

function q<T>(data: T | undefined, isLoading = false) {
  return { data, isLoading } as unknown;
}

function mutation() {
  return { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}), isPending: false, reset: vi.fn() };
}

function seededAudit(): { data: AuditLogEntry[]; pagination: { total: number; page: number; perPage: number } } {
  return {
    data: [
      {
        id: "audit-1",
        projectId: "proj-1",
        actorId: "user-admin-1234",
        action: "force_land",
        targetType: "merge_request",
        targetId: "mr-abcdef99",
        reason: "hotfix for prod outage",
        metadataBefore: null,
        metadataAfter: null,
        createdAt: new Date().toISOString(),
      } as AuditLogEntry,
      {
        id: "audit-2",
        projectId: "proj-1",
        actorId: "user-admin-1234",
        action: "pause",
        targetType: "train",
        targetId: "train-main-0001",
        reason: null,
        metadataBefore: null,
        metadataAfter: null,
        createdAt: new Date().toISOString(),
      } as AuditLogEntry,
    ],
    pagination: { total: 2, page: 1, perPage: 50 },
  };
}

let pauseMutation: ReturnType<typeof mutation>;
let resumeMutation: ReturnType<typeof mutation>;
let forceReleaseMutation: ReturnType<typeof mutation>;
let forceLandMutation: ReturnType<typeof mutation>;
let forceRejectMutation: ReturnType<typeof mutation>;

beforeEach(() => {
  vi.clearAllMocks();
  pauseMutation = mutation();
  resumeMutation = mutation();
  forceReleaseMutation = mutation();
  forceLandMutation = mutation();
  forceRejectMutation = mutation();

  authMocks.useCurrentUser.mockReturnValue(q({ role: "admin" }));
  trainMocks.useAuditLog.mockReturnValue(q(seededAudit()));
  trainMocks.useTrainState.mockReturnValue(q({ state: "running", reason: null }));
  trainMocks.usePauseTrain.mockReturnValue(pauseMutation);
  trainMocks.useResumeTrain.mockReturnValue(resumeMutation);
  trainMocks.useForceReleaseLock.mockReturnValue(forceReleaseMutation);
  trainMocks.useForceLand.mockReturnValue(forceLandMutation);
  trainMocks.useForceReject.mockReturnValue(forceRejectMutation);
});

// ── Per-role gating (the load-bearing test) ──────────────────────

describe("TrainAuditPage — per-role gating", () => {
  it("admin sees the break-glass controls + audit table", () => {
    render(<TrainAuditPage />);
    expect(screen.getByText("Break-glass controls")).toBeInTheDocument();
    expect(screen.getByText("Force-land…")).toBeInTheDocument();
    expect(screen.getByText("Force-reject…")).toBeInTheDocument();
    expect(screen.getByText("Force-release lock…")).toBeInTheDocument();
    expect(screen.getByText("Audit log")).toBeInTheDocument();
    // Audit rows present.
    expect(screen.getByText("hotfix for prod outage")).toBeInTheDocument();
  });

  it("member sees Access Denied and NONE of the force-* controls", () => {
    authMocks.useCurrentUser.mockReturnValue(q({ role: "member" }));
    render(<TrainAuditPage />);
    expect(screen.getByText("Access Denied")).toBeInTheDocument();
    expect(screen.queryByText("Force-land…")).toBeNull();
    expect(screen.queryByText("Force-reject…")).toBeNull();
    expect(screen.queryByText("Force-release lock…")).toBeNull();
    expect(screen.queryByText("Pause train")).toBeNull();
    expect(screen.queryByText("Audit log")).toBeNull();
  });
});

// ── Audit rows + filters ─────────────────────────────────────────

describe("TrainAuditPage — audit log", () => {
  it("renders actor / action / target / reason / timestamp for each row", () => {
    render(<TrainAuditPage />);
    // Actor (short mono)
    expect(screen.getAllByText("user-adm").length).toBeGreaterThan(0);
    // Action badges
    expect(screen.getByText("force land")).toBeInTheDocument();
    expect(screen.getByText("pause")).toBeInTheDocument();
    // Target type + short id
    expect(screen.getByText("merge request")).toBeInTheDocument();
    expect(screen.getByText("mr-abcde")).toBeInTheDocument();
    // Reason + em-dash for null reason
    expect(screen.getByText("hotfix for prod outage")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("re-invokes useAuditLog with the new filter when the actor filter changes", () => {
    render(<TrainAuditPage />);
    trainMocks.useAuditLog.mockClear();
    const actorInput = screen.getByLabelText("Actor");
    fireEvent.change(actorInput, { target: { value: "user-x" } });
    // Latest call carries the new userId filter.
    const calls = trainMocks.useAuditLog.mock.calls;
    const last = calls[calls.length - 1];
    expect(last[0]).toBe("proj-1");
    expect(last[1]).toMatchObject({ userId: "user-x", page: 1 });
  });
});

// ── Force-land dialog (admin + reason + landedSha + warning + 2-step) ──

describe("TrainAuditPage — force-land dialog", () => {
  it("two-step: opens dialog with warning, submit disabled until reason+sha+id, then mutate", () => {
    render(<TrainAuditPage />);
    // Step 1: open via the button (not one-click).
    fireEvent.click(screen.getByText("Force-land…"));

    // Warning block renders.
    expect(
      screen.getByText(/bypasses the verify gate/i),
    ).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "Force-land" });
    expect(submit).toBeDisabled();

    // Fill request id + sha + reason.
    fireEvent.change(screen.getByLabelText("Merge request ID"), {
      target: { value: "mr-123" },
    });
    fireEvent.change(screen.getByLabelText("Landed SHA"), {
      target: { value: "abc1234" },
    });
    // Still disabled — reason missing.
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "prod hotfix" },
    });
    // Now enabled.
    expect(submit).not.toBeDisabled();

    act(() => {
      fireEvent.click(submit);
    });
    expect(forceLandMutation.mutateAsync).toHaveBeenCalledWith({
      requestId: "mr-123",
      landedSha: "abc1234",
      reason: "prod hotfix",
    });
  });
});

// ── Force-reject dialog ──────────────────────────────────────────

describe("TrainAuditPage — force-reject dialog", () => {
  it("submit disabled until reason non-empty, then mutate with the reason", () => {
    render(<TrainAuditPage />);
    fireEvent.click(screen.getByText("Force-reject…"));

    const submit = screen.getByRole("button", { name: "Force-reject" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Merge request ID"), {
      target: { value: "mr-999" },
    });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "obsoleted" },
    });
    expect(submit).not.toBeDisabled();

    act(() => {
      fireEvent.click(submit);
    });
    expect(forceRejectMutation.mutateAsync).toHaveBeenCalledWith({
      requestId: "mr-999",
      reason: "obsoleted",
    });
  });
});

// ── Pause / resume reflect + toggle train state ──────────────────

describe("TrainAuditPage — pause/resume", () => {
  it("running state → renders Pause and calls usePauseTrain", () => {
    render(<TrainAuditPage />);
    const pauseBtn = screen.getByText("Pause train");
    expect(pauseBtn).toBeInTheDocument();
    fireEvent.click(pauseBtn);
    expect(pauseMutation.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", resource: "main" }),
    );
  });

  it("paused state → renders Resume and calls useResumeTrain", () => {
    trainMocks.useTrainState.mockReturnValue(
      q({ state: "paused", reason: "maintenance" }),
    );
    render(<TrainAuditPage />);
    expect(screen.queryByText("Pause train")).toBeNull();
    const resumeBtn = screen.getByText("Resume train");
    expect(resumeBtn).toBeInTheDocument();
    fireEvent.click(resumeBtn);
    expect(resumeMutation.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", resource: "main" }),
    );
  });
});
