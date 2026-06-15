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
  useUpdateProject: vi.fn(),
  mutateAsync: vi.fn(),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProject: mocks.useProject,
  useUpdateProject: mocks.useUpdateProject,
}));

import { CategoriesPage } from "./categories-page";

// ── Fixtures ─────────────────────────────────────────────────────

function projectWithSettings(settings: Record<string, unknown>) {
  return {
    data: { id: "proj-1", settings },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown;
}

const SEED_CATEGORIES = [
  { name: "Frontend", color: "#3b82f6", sort_order: 0 },
  { name: "Backend", color: "#10b981", sort_order: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutateAsync.mockResolvedValue({});
  mocks.useUpdateProject.mockReturnValue({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
    isError: false,
    error: null,
  });
  mocks.useProject.mockReturnValue(projectWithSettings({ epic_categories: SEED_CATEGORIES }));
});

describe("CategoriesPage — seeding", () => {
  it("renders rows seeded from settings.epic_categories (sort_order ordered)", () => {
    render(<CategoriesPage />);
    expect(screen.getByLabelText("Name for category 1")).toHaveValue("Frontend");
    expect(screen.getByLabelText("Name for category 2")).toHaveValue("Backend");
  });

  it("renders the empty state when there are no categories", () => {
    mocks.useProject.mockReturnValue(projectWithSettings({}));
    render(<CategoriesPage />);
    expect(screen.getByText("No categories yet. Add one to get started.")).toBeInTheDocument();
  });
});

describe("CategoriesPage — editing", () => {
  it("Add appends a new blank row", () => {
    render(<CategoriesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Add category" }));
    expect(screen.getByLabelText("Name for category 3")).toHaveValue("");
  });

  it("remove deletes a row", () => {
    render(<CategoriesPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove category" })[0]);
    expect(screen.getByLabelText("Name for category 1")).toHaveValue("Backend");
    expect(screen.queryByLabelText("Name for category 2")).not.toBeInTheDocument();
  });

  it("up/down reorders rows", () => {
    render(<CategoriesPage />);
    // Move the second row (Backend) up.
    fireEvent.click(screen.getAllByRole("button", { name: "Move up" })[1]);
    expect(screen.getByLabelText("Name for category 1")).toHaveValue("Backend");
    expect(screen.getByLabelText("Name for category 2")).toHaveValue("Frontend");
  });
});

describe("CategoriesPage — validation", () => {
  it("disables Save when a name is blank", () => {
    render(<CategoriesPage />);
    fireEvent.change(screen.getByLabelText("Name for category 1"), {
      target: { value: "  " },
    });
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  it("disables Save when names are duplicated", () => {
    render(<CategoriesPage />);
    fireEvent.change(screen.getByLabelText("Name for category 2"), {
      target: { value: "Frontend" },
    });
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });
});

describe("CategoriesPage — save payload (no-clobber)", () => {
  it("preserves sibling settings and rebuilds epic_categories with reindexed sort_order", async () => {
    const integrator = { verify_command: "make test", parallelism: 2 };
    const webhooks = { discord_url: "https://example.com/hook" };
    mocks.useProject.mockReturnValue(
      projectWithSettings({
        integrator,
        webhooks,
        epic_categories: SEED_CATEGORIES,
      }),
    );
    render(<CategoriesPage />);

    // Reorder so sort_order must be recomputed (Backend → first).
    fireEvent.click(screen.getAllByRole("button", { name: "Move up" })[1]);

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));

    const payload = mocks.mutateAsync.mock.calls[0][0];
    expect(payload.id).toBe("proj-1");
    const settings = payload.data.settings as Record<string, unknown>;

    // Siblings untouched.
    expect(settings.integrator).toEqual(integrator);
    expect(settings.webhooks).toEqual(webhooks);

    // epic_categories rebuilt + reindexed.
    expect(settings.epic_categories).toEqual([
      { name: "Backend", color: "#10b981", sort_order: 0 },
      { name: "Frontend", color: "#3b82f6", sort_order: 1 },
    ]);
  });

  it("trims names on save", async () => {
    mocks.useProject.mockReturnValue(
      projectWithSettings({
        epic_categories: [{ name: "Frontend", color: "#3b82f6", sort_order: 0 }],
      }),
    );
    render(<CategoriesPage />);
    fireEvent.change(screen.getByLabelText("Name for category 1"), {
      target: { value: "  Design  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalled());
    const settings = mocks.mutateAsync.mock.calls[0][0].data.settings as Record<string, unknown>;
    expect(settings.epic_categories).toEqual([{ name: "Design", color: "#3b82f6", sort_order: 0 }]);
  });
});
