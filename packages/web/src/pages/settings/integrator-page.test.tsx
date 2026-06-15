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
  useUpdateIntegratorConfig: vi.fn(),
  useCurrentUser: vi.fn(),
  mutateAsync: vi.fn(),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProject: mocks.useProject,
  useUpdateIntegratorConfig: mocks.useUpdateIntegratorConfig,
}));
vi.mock("@/hooks/use-auth", () => ({
  useCurrentUser: mocks.useCurrentUser,
}));

// NOTE: @/lib/integrator is intentionally NOT mocked — the real
// integratorConfigFromProject read-through is exercised here.

import { IntegratorPage } from "./integrator-page";

// ── Fixtures ─────────────────────────────────────────────────────

function projectWith(
  integrator: Record<string, unknown>,
  gitRepoUrl: string | null = "git@x:repo.git",
) {
  return {
    data: {
      id: "proj-1",
      gitRepoUrl,
      settings: { integrator },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown;
}

const SEEDED = {
  enabled: true,
  verify_command: "make test",
  worktree_root: "/wt",
  parallelism: 2,
  verify_timeout_sec: 900,
  git_remote: "origin",
  git_main_branch: "main",
  clean_keep: [".env"],
  linked_repos: [{ name: "a", path: "a/", role: "inner" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useCurrentUser.mockReturnValue({ data: { role: "admin" } });
  mocks.mutateAsync.mockResolvedValue({});
  mocks.useUpdateIntegratorConfig.mockReturnValue({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
    isError: false,
    error: null,
  });
  mocks.useProject.mockReturnValue(projectWith(SEEDED));
});

describe("IntegratorPage — admin gating", () => {
  it("non-admins see an access-denied state and no form", () => {
    mocks.useCurrentUser.mockReturnValue({ data: { role: "user" } });
    render(<IntegratorPage />);
    expect(screen.getByText("Admin access required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
  });
});

describe("IntegratorPage — seeding", () => {
  it("renders all fields seeded from the project", () => {
    render(<IntegratorPage />);
    expect(screen.getByRole("switch", { name: /Enabled/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByLabelText("Parallelism")).toHaveValue(2);
    expect(screen.getByLabelText("Verify timeout (seconds)")).toHaveValue(900);
    expect(screen.getByLabelText("Verify command")).toHaveValue("make test");
    expect(screen.getByLabelText("Worktree root")).toHaveValue("/wt");
    expect(screen.getByLabelText("Git repository URL")).toHaveValue("git@x:repo.git");
    expect(screen.getByLabelText("Clean keep 1")).toHaveValue(".env");
    expect(screen.getByLabelText("Linked repo name 1")).toHaveValue("a");
  });
});

describe("IntegratorPage — verify-cache guardrail hint (C2)", () => {
  it("shows the amber hint when the stored config is cache on + steps lacking cache_key_inputs", () => {
    mocks.useProject.mockReturnValue(
      projectWith({
        ...SEEDED,
        cache_enabled: true,
        cache_mode: "on",
        verify_steps: [{ id: "lint", command: "pnpm lint" }],
      }),
    );
    render(<IntegratorPage />);
    expect(screen.getByText(/verify-cache is ON/)).toBeInTheDocument();
    expect(screen.getByText(/"lint"/)).toBeInTheDocument();
    expect(screen.getByText(/§16\.2/)).toBeInTheDocument();
    expect(screen.getByText(/shadow/)).toBeInTheDocument();
  });

  it("shows the synthetic-step hint when cache is on with no verify_steps", () => {
    mocks.useProject.mockReturnValue(
      projectWith({ ...SEEDED, cache_enabled: true, cache_mode: "on" }),
    );
    render(<IntegratorPage />);
    expect(screen.getByText(/synthetic verify_command step/)).toBeInTheDocument();
  });

  it("shows NO hint in shadow mode / when the cache is off / when inputs are declared", () => {
    mocks.useProject.mockReturnValue(
      projectWith({
        ...SEEDED,
        cache_enabled: true,
        cache_mode: "shadow",
        verify_steps: [{ id: "lint", command: "pnpm lint" }],
      }),
    );
    const { unmount } = render(<IntegratorPage />);
    expect(screen.queryByText(/verify-cache is ON/)).toBeNull();
    unmount();

    mocks.useProject.mockReturnValue(
      projectWith({
        ...SEEDED,
        cache_enabled: true,
        cache_mode: "on",
        verify_steps: [{ id: "lint", command: "pnpm lint", cache_key_inputs: ["node -v"] }],
      }),
    );
    render(<IntegratorPage />);
    expect(screen.queryByText(/verify-cache is ON/)).toBeNull();
  });
});

describe("IntegratorPage — validation", () => {
  it("disables Save and shows a message when enabled but verify/worktree blank", () => {
    mocks.useProject.mockReturnValue(
      projectWith({
        ...SEEDED,
        verify_command: "",
        worktree_root: "",
      }),
    );
    render(<IntegratorPage />);
    expect(
      screen.getByText(/Enabling the integrator requires a verify command and a worktree root/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  it("disables Save when parallelism is 0", () => {
    render(<IntegratorPage />);
    fireEvent.change(screen.getByLabelText("Parallelism"), {
      target: { value: "0" },
    });
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  it("disables Save when verify_timeout_sec is 0", () => {
    render(<IntegratorPage />);
    fireEvent.change(screen.getByLabelText("Verify timeout (seconds)"), {
      target: { value: "0" },
    });
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });
});

describe("IntegratorPage — clean_keep editor", () => {
  it("adds and removes clean_keep rows", () => {
    render(<IntegratorPage />);
    expect(screen.queryByLabelText("Clean keep 2")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add path" }));
    expect(screen.getByLabelText("Clean keep 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove clean keep 2" }));
    expect(screen.queryByLabelText("Clean keep 2")).not.toBeInTheDocument();
  });
});

describe("IntegratorPage — linked_repos editor", () => {
  it("adds and removes linked_repos rows", () => {
    render(<IntegratorPage />);
    expect(screen.queryByLabelText("Linked repo name 2")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    expect(screen.getByLabelText("Linked repo name 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove linked repo 2" }));
    expect(screen.queryByLabelText("Linked repo name 2")).not.toBeInTheDocument();
  });
});

describe("IntegratorPage — save payload", () => {
  it("calls the mutation with the merged config and no deferred keys", async () => {
    render(<IntegratorPage />);
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    const payload = mocks.mutateAsync.mock.calls[0][0];
    expect(payload).toMatchObject({
      gitRepoUrl: "git@x:repo.git",
      config: {
        enabled: true,
        parallelism: 2,
        verify_timeout_sec: 900,
        verify_command: "make test",
        worktree_root: "/wt",
        clean_keep: [".env"],
        linked_repos: [{ name: "a", path: "a/", role: "inner" }],
      },
    });
    const keys = Object.keys(payload.config);
    expect(keys).not.toContain("verify_steps");
    expect(keys).not.toContain("resolver");
    expect(keys).not.toContain("cache_mode");
  });

  it("sends gitRepoUrl null when the URL is blank", async () => {
    render(<IntegratorPage />);
    fireEvent.change(screen.getByLabelText("Git repository URL"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalled());
    expect(mocks.mutateAsync.mock.calls[0][0].gitRepoUrl).toBeNull();
  });

  it("drops blank clean_keep entries on save", async () => {
    render(<IntegratorPage />);
    fireEvent.click(screen.getByRole("button", { name: "Add path" }));
    // The newly-added row is blank; it must not survive into the payload.
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalled());
    const cleanKeep = mocks.mutateAsync.mock.calls[0][0].config.clean_keep;
    expect(cleanKeep).not.toContain("");
    expect(cleanKeep).toEqual([".env"]);
  });
});
