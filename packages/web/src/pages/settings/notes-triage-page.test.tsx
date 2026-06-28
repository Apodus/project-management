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
  useUpdateNotesTriageConfig: vi.fn(),
  useCurrentUser: vi.fn(),
  mutateAsync: vi.fn(),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProject: mocks.useProject,
  useUpdateNotesTriageConfig: mocks.useUpdateNotesTriageConfig,
}));
vi.mock("@/hooks/use-auth", () => ({
  useCurrentUser: mocks.useCurrentUser,
}));

import { NotesTriagePage } from "./notes-triage-page";

// ── Fixtures ─────────────────────────────────────────────────────

function projectWith(
  notesTriage: Record<string, unknown> | undefined,
  otherSettings?: Record<string, unknown>,
) {
  return {
    data: {
      id: "proj-1",
      settings: {
        ...(otherSettings ?? {}),
        ...(notesTriage ? { notesTriage } : {}),
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
  mocks.useUpdateNotesTriageConfig.mockReturnValue({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
    isError: false,
    error: null,
  });
  mocks.useProject.mockReturnValue(projectWith({ enabled: true, mode: "on" }));
});

describe("NotesTriagePage — admin gating", () => {
  it("non-admins see an access-denied state and no form", () => {
    mocks.useCurrentUser.mockReturnValue({ data: { role: "user" } });
    render(<NotesTriagePage />);
    expect(screen.getByText("Admin access required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
  });
});

describe("NotesTriagePage — defaults / tolerant read", () => {
  it("a project with no notesTriage block shows off + shadow + empty agent id", () => {
    mocks.useProject.mockReturnValue(
      projectWith(undefined, { integrator: { verify_command: "make test" } }),
    );
    render(<NotesTriagePage />);
    expect(screen.getByRole("switch", { name: /Enabled/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("combobox", { name: "Mode" })).toHaveTextContent("shadow");
    expect(screen.getByLabelText("Triage agent ID")).toHaveValue("");
  });
});

describe("NotesTriagePage — seeding", () => {
  it("seeds the switch + mode + agent id from the persisted block", () => {
    mocks.useProject.mockReturnValue(
      projectWith({ enabled: true, mode: "on", triageAgentId: "triager-bot" }),
    );
    render(<NotesTriagePage />);
    expect(screen.getByRole("switch", { name: /Enabled/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Mode" })).toHaveTextContent("on");
    expect(screen.getByLabelText("Triage agent ID")).toHaveValue("triager-bot");
  });
});

describe("NotesTriagePage — save payload", () => {
  it("hands the hook only the notesTriage block (merge is the hook's job)", async () => {
    mocks.useProject.mockReturnValue(
      projectWith({ enabled: false, mode: "shadow" }, { integrator: { x: 1 } }),
    );
    render(<NotesTriagePage />);

    // Toggle enabled on.
    fireEvent.click(screen.getByRole("switch", { name: /Enabled/i }));
    // Set mode to "on".
    fireEvent.click(screen.getByRole("combobox", { name: "Mode" }));
    fireEvent.click(screen.getByRole("option", { name: "on" }));
    // Type a triage agent id.
    fireEvent.change(screen.getByLabelText("Triage agent ID"), {
      target: { value: "triager-bot" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync.mock.calls[0][0]).toEqual({
      enabled: true,
      mode: "on",
      triageAgentId: "triager-bot",
    });
  });

  it("omits triageAgentId when the field is blank", async () => {
    mocks.useProject.mockReturnValue(projectWith({ enabled: false, mode: "shadow" }));
    render(<NotesTriagePage />);

    fireEvent.click(screen.getByRole("switch", { name: /Enabled/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    const payload = mocks.mutateAsync.mock.calls[0][0];
    expect(payload).toEqual({ enabled: true, mode: "shadow" });
    expect(payload).not.toHaveProperty("triageAgentId");
  });
});

describe("NotesTriagePage — mode select", () => {
  it("renders off/shadow/on options and updates help text on select", () => {
    mocks.useProject.mockReturnValue(projectWith({ enabled: false, mode: "shadow" }));
    render(<NotesTriagePage />);

    fireEvent.click(screen.getByRole("combobox", { name: "Mode" }));
    expect(screen.getByRole("option", { name: "off" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "shadow" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "on" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "off" }));
    expect(screen.getByText(/Inert: the triager does nothing/i)).toBeInTheDocument();
  });
});
