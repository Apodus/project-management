import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock the router ──────────────────────────────────────────────
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

// ── Mock the hooks ───────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  useSetupStatus: vi.fn(),
  useSetup: vi.fn(),
  useCreateProject: vi.fn(),
  useCreatePool: vi.fn(),
  useCreatePoolAgents: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useSetupStatus: mocks.useSetupStatus,
  useSetup: mocks.useSetup,
}));
vi.mock("@/hooks/use-projects", () => ({
  useCreateProject: mocks.useCreateProject,
}));
vi.mock("@/hooks/use-agent-pool", () => ({
  useCreatePool: mocks.useCreatePool,
  useCreatePoolAgents: mocks.useCreatePoolAgents,
}));

import { SetupPage } from "./setup-page";

function mutation(overrides: Record<string, unknown> = {}) {
  return {
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    error: null,
    ...overrides,
  };
}

describe("SetupPage wizard", () => {
  beforeEach(() => {
    navigate.mockReset();
    // needsSetup true initially so the admin step renders without a redirect.
    mocks.useSetupStatus.mockReturnValue({
      data: { needsSetup: true },
      isLoading: false,
    });
    mocks.useSetup.mockReturnValue(mutation());
    mocks.useCreateProject.mockReturnValue(mutation());
    mocks.useCreatePool.mockReturnValue(
      mutation({ mutateAsync: vi.fn().mockResolvedValue({ id: "pool-1" }) }),
    );
    mocks.useCreatePoolAgents.mockReturnValue(mutation());
  });

  async function fillAdminAndSubmit() {
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText("Display Name"), {
      target: { value: "Admin User" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create admin account/i }));
  }

  it("advances admin → project → connect → done without bouncing to /login", async () => {
    const setupMutateAsync = vi.fn().mockResolvedValue(undefined);
    mocks.useSetup.mockReturnValue(mutation({ mutateAsync: setupMutateAsync }));

    const { rerender } = render(<SetupPage />);

    expect(screen.getByRole("button", { name: /create admin account/i })).toBeInTheDocument();

    await fillAdminAndSubmit();
    await waitFor(() => expect(setupMutateAsync).toHaveBeenCalled());

    // Simulate the needsSetup → false flip after admin creation. The redirect
    // guard must NOT fire because we are no longer on the "admin" step.
    mocks.useSetupStatus.mockReturnValue({
      data: { needsSetup: false },
      isLoading: false,
    });
    rerender(<SetupPage />);

    // Project step.
    await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "My Project" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));

    // Connect step.
    await waitFor(() => expect(screen.getByLabelText("Pool name")).toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("renders the .mcp.json snippet after pool create, navigates only on Finish", async () => {
    const poolMutateAsync = vi.fn().mockResolvedValue({ id: "pool-1" });
    const agentsMutateAsync = vi.fn().mockResolvedValue(undefined);
    mocks.useCreatePool.mockReturnValue(mutation({ mutateAsync: poolMutateAsync }));
    mocks.useCreatePoolAgents.mockReturnValue(mutation({ mutateAsync: agentsMutateAsync }));

    render(<SetupPage />);

    await fillAdminAndSubmit();
    await waitFor(() => expect(screen.getByLabelText("Project name")).toBeInTheDocument());

    // Skip the project step.
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));

    await waitFor(() => expect(screen.getByLabelText("Pool name")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /create pool/i }));

    await waitFor(() => expect(poolMutateAsync).toHaveBeenCalled());
    await waitFor(() =>
      expect(agentsMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ poolId: "pool-1", count: 5 }),
      ),
    );

    // The snippet renders with the captured pool name + secret.
    await waitFor(() => expect(screen.getByText(/PM_POOL_NAME/)).toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /finish/i }));
    expect(navigate).toHaveBeenCalledWith({ to: "/projects" });
  });
});
