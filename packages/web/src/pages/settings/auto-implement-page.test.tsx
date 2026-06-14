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
  useUpdateAutoImplementConfig: vi.fn(),
  useCurrentUser: vi.fn(),
  mutateAsync: vi.fn(),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProject: mocks.useProject,
  useUpdateAutoImplementConfig: mocks.useUpdateAutoImplementConfig,
}));
vi.mock("@/hooks/use-auth", () => ({
  useCurrentUser: mocks.useCurrentUser,
}));

import { AutoImplementPage } from "./auto-implement-page";

// ── Fixtures ─────────────────────────────────────────────────────

function projectWith(
  autoImplement: Record<string, unknown> | undefined,
  otherSettings?: Record<string, unknown>,
) {
  return {
    data: {
      id: "proj-1",
      settings: {
        ...(otherSettings ?? {}),
        ...(autoImplement ? { autoImplement } : {}),
      },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useCurrentUser.mockReturnValue({ data: { role: "admin" } });
  mocks.mutateAsync.mockResolvedValue({});
  mocks.useUpdateAutoImplementConfig.mockReturnValue({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
    isError: false,
    error: null,
  });
  mocks.useProject.mockReturnValue(
    projectWith({ enabled: true, mode: "on" }),
  );
});

describe("AutoImplementPage — admin gating", () => {
  it("non-admins see an access-denied state and no form", () => {
    mocks.useCurrentUser.mockReturnValue({ data: { role: "user" } });
    render(<AutoImplementPage />);
    expect(screen.getByText("Admin access required")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save Changes" }),
    ).not.toBeInTheDocument();
  });
});

describe("AutoImplementPage — defaults / tolerant read", () => {
  it("a project with no autoImplement block shows off + shadow", () => {
    mocks.useProject.mockReturnValue(
      projectWith(undefined, { integrator: { verify_command: "make test" } }),
    );
    render(<AutoImplementPage />);
    expect(
      screen.getByRole("switch", { name: /Enabled/i }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("combobox", { name: "Mode" })).toHaveTextContent(
      "shadow",
    );
  });
});

describe("AutoImplementPage — seeding", () => {
  it("seeds the switch + mode from the persisted block", () => {
    mocks.useProject.mockReturnValue(
      projectWith({ enabled: true, mode: "on" }),
    );
    render(<AutoImplementPage />);
    expect(
      screen.getByRole("switch", { name: /Enabled/i }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("combobox", { name: "Mode" })).toHaveTextContent(
      "on",
    );
  });
});

describe("AutoImplementPage — save payload", () => {
  it("hands the hook only the autoImplement block (merge is the hook's job)", async () => {
    mocks.useProject.mockReturnValue(
      projectWith(
        { enabled: false, mode: "shadow" },
        { integrator: { x: 1 } },
      ),
    );
    render(<AutoImplementPage />);

    // Toggle enabled on.
    fireEvent.click(screen.getByRole("switch", { name: /Enabled/i }));
    // Set mode to "on".
    fireEvent.click(screen.getByRole("combobox", { name: "Mode" }));
    fireEvent.click(screen.getByRole("option", { name: "on" }));

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync.mock.calls[0][0]).toEqual({
      enabled: true,
      mode: "on",
    });
  });
});
