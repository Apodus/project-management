import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock router param hook ───────────────────────────────────────
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

// ── Mock the project store ───────────────────────────────────────
vi.mock("@/stores/project-store", () => ({
  useProjectStore: () => ({ currentProjectId: "proj-1" }),
}));

// ── Mock the hooks ───────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  useProject: vi.fn(),
  useResolverDefaults: vi.fn(),
  useUpdateResolverConfig: vi.fn(),
  useCurrentUser: vi.fn(),
  mutateAsync: vi.fn(),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProject: mocks.useProject,
  useResolverDefaults: mocks.useResolverDefaults,
  useUpdateResolverConfig: mocks.useUpdateResolverConfig,
}));
vi.mock("@/hooks/use-auth", () => ({
  useCurrentUser: mocks.useCurrentUser,
}));

import { ConflictResolutionPage } from "./conflict-resolution-page";

// ── Fixtures ─────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: false,
  max_concurrent: 1,
  time_budget_sec: 600,
  token_budget: null,
  command: null,
  prompt: "Reconcile {files} then run {verify_command}.",
};

function projectWith(resolver: Record<string, unknown>) {
  return {
    data: {
      id: "proj-1",
      settings: { integrator: { verify_command: "make test", resolver } },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useCurrentUser.mockReturnValue({ data: { role: "admin" } });
  mocks.useResolverDefaults.mockReturnValue({ data: DEFAULTS });
  mocks.mutateAsync.mockResolvedValue({});
  mocks.useUpdateResolverConfig.mockReturnValue({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
    isError: false,
    error: null,
  });
  mocks.useProject.mockReturnValue(
    projectWith({
      enabled: true,
      max_concurrent: 2,
      time_budget_sec: 900,
      token_budget: 50000,
      prompt: "Custom prompt",
    }),
  );
});

describe("ConflictResolutionPage — seeding", () => {
  it("renders all fields seeded from the project", () => {
    render(<ConflictResolutionPage />);
    expect(screen.getByRole("switch", { name: /Enabled/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByLabelText("Max concurrent")).toHaveValue(2);
    expect(screen.getByLabelText("Time budget (seconds)")).toHaveValue(900);
    expect(screen.getByLabelText("Token budget")).toHaveValue(50000);
    expect(screen.getByLabelText("Reconcile prompt")).toHaveValue("Custom prompt");
    // Unlimited unchecked because a numeric token_budget was present.
    expect(screen.getByRole("checkbox", { name: "Unlimited token budget" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("seeds Unlimited when token_budget is absent", () => {
    mocks.useProject.mockReturnValue(
      projectWith({ enabled: false, max_concurrent: 1, time_budget_sec: 600 }),
    );
    render(<ConflictResolutionPage />);
    expect(screen.getByRole("checkbox", { name: "Unlimited token budget" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByLabelText("Token budget")).toBeDisabled();
  });
});

describe("ConflictResolutionPage — token budget unlimited", () => {
  it("checking Unlimited clears token_budget and omits it from the payload", async () => {
    render(<ConflictResolutionPage />);
    const unlimited = screen.getByRole("checkbox", {
      name: "Unlimited token budget",
    });
    fireEvent.click(unlimited);
    expect(screen.getByLabelText("Token budget")).toHaveValue(null);

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalled());
    const payload = mocks.mutateAsync.mock.calls[0][0];
    expect(payload).not.toHaveProperty("token_budget");
  });

  it("entering a number sends token_budget in the payload", async () => {
    // Start unlimited.
    mocks.useProject.mockReturnValue(
      projectWith({ enabled: true, max_concurrent: 1, time_budget_sec: 600 }),
    );
    render(<ConflictResolutionPage />);
    const unlimited = screen.getByRole("checkbox", {
      name: "Unlimited token budget",
    });
    fireEvent.click(unlimited); // uncheck → enable the input
    fireEvent.change(screen.getByLabelText("Token budget"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalled());
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({
      token_budget: 123456,
    });
  });
});

describe("ConflictResolutionPage — revert to defaults", () => {
  it("resets the config fields to defaults but keeps enabled unchanged", () => {
    render(<ConflictResolutionPage />);
    // enabled starts true (from the project).
    expect(screen.getByRole("switch", { name: /Enabled/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Revert to defaults" }));

    expect(screen.getByLabelText("Max concurrent")).toHaveValue(1);
    expect(screen.getByLabelText("Time budget (seconds)")).toHaveValue(600);
    // token_budget default is null → Unlimited checked.
    expect(screen.getByRole("checkbox", { name: "Unlimited token budget" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // prompt cleared (empty = built-in default).
    expect(screen.getByLabelText("Reconcile prompt")).toHaveValue("");
    // enabled NOT touched.
    expect(screen.getByRole("switch", { name: /Enabled/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

describe("ConflictResolutionPage — save payload", () => {
  it("calls the mutation with the merged resolver block", async () => {
    render(<ConflictResolutionPage />);
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({
      enabled: true,
      max_concurrent: 2,
      time_budget_sec: 900,
      token_budget: 50000,
      prompt: "Custom prompt",
    });
  });

  it("omits prompt when the textarea is empty (use default)", async () => {
    render(<ConflictResolutionPage />);
    fireEvent.change(screen.getByLabelText("Reconcile prompt"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalled());
    expect(mocks.mutateAsync.mock.calls[0][0]).not.toHaveProperty("prompt");
  });
});

describe("ConflictResolutionPage — validation", () => {
  it("disables Save when max_concurrent is 0", () => {
    render(<ConflictResolutionPage />);
    fireEvent.change(screen.getByLabelText("Max concurrent"), {
      target: { value: "0" },
    });
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  it("disables Save when time_budget_sec is 0", () => {
    render(<ConflictResolutionPage />);
    fireEvent.change(screen.getByLabelText("Time budget (seconds)"), {
      target: { value: "0" },
    });
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });
});

describe("ConflictResolutionPage — admin gating", () => {
  it("non-admins see an access-denied state and no form", () => {
    mocks.useCurrentUser.mockReturnValue({ data: { role: "user" } });
    render(<ConflictResolutionPage />);
    expect(screen.getByText("Admin access required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
  });
});
