import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createContext, useContext, type ReactNode } from "react";
import type { Escalation, EscalationFilters } from "@/lib/api";

// ── Radix Select mock (mirrors notes-page.test.tsx) ────────────────
// Each SelectItem renders as a clickable button that pushes its value through
// context, so jsdom can drive the filter selects without portals.
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
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
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

// ── Capture the useEscalations filter arg ──────────────────────────
const useEscalationsSpy = vi.fn();
let escalationsData: Escalation[] = [];

function makeEscalation(overrides: Partial<Escalation>): Escalation {
  return {
    id: "esc-1",
    projectId: "proj-1",
    kind: "bug_report",
    status: "open",
    severity: null,
    title: "An escalation",
    body: "Something is broken",
    codeLocator: null,
    anchorType: null,
    anchorId: null,
    originRepo: "game_one",
    originWorkerKey: "worker-3",
    holderId: null,
    authorId: "agent-1",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

// Capture Link target params so we can assert each card deep-links by id.
const linkCalls: Array<{ to?: string; params?: Record<string, string> }> = [];

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    children,
  }: {
    to?: string;
    params?: Record<string, string>;
    children?: ReactNode;
  }) => {
    linkCalls.push({ to, params });
    return <a>{children}</a>;
  },
}));

vi.mock("@/hooks/use-projects", () => ({
  useProject: () => ({ data: { id: "proj-1", name: "Demo project" } }),
}));

vi.mock("@/hooks/use-escalations", () => ({
  useEscalations: (_projectId: string | undefined, filters: EscalationFilters) => {
    useEscalationsSpy(filters);
    return {
      data: {
        data: escalationsData,
        pagination: { total: escalationsData.length },
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

vi.mock("@/stores/project-store", () => ({
  useProjectStore: (selector: (s: { setCurrentProject: () => void }) => unknown) =>
    selector({ setCurrentProject: () => {} }),
}));

import { EscalationsPage } from "./escalations-page";

beforeEach(() => {
  vi.clearAllMocks();
  escalationsData = [];
  linkCalls.length = 0;
});

describe("EscalationsPage", () => {
  it("renders seeded escalation titles", () => {
    escalationsData = [
      makeEscalation({ id: "e1", title: "Login crashes" }),
      makeEscalation({ id: "e2", title: "Need clarification", kind: "question" }),
    ];
    render(<EscalationsPage />);
    expect(screen.getByText("Login crashes")).toBeInTheDocument();
    expect(screen.getByText("Need clarification")).toBeInTheDocument();
  });

  it("shows the empty-state copy when there are no escalations", () => {
    escalationsData = [];
    render(<EscalationsPage />);
    expect(screen.getByText("No escalations yet")).toBeInTheDocument();
  });

  it("passes an empty EscalationFilters by default", () => {
    escalationsData = [];
    render(<EscalationsPage />);
    const filters = useEscalationsSpy.mock.calls.at(-1)?.[0] as EscalationFilters;
    expect(filters.status).toBeUndefined();
    expect(filters.kind).toBeUndefined();
    expect(filters.severity).toBeUndefined();
    expect(filters.originRepo).toBeUndefined();
    expect(filters.originWorkerKey).toBeUndefined();
  });

  it("status filter updates the object passed to useEscalations", () => {
    render(<EscalationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Needs Human" }));
    const filters = useEscalationsSpy.mock.calls.at(-1)?.[0] as EscalationFilters;
    expect(filters.status).toBe("needs_human");
  });

  it("kind filter updates the object passed to useEscalations", () => {
    render(<EscalationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Blocked" }));
    const filters = useEscalationsSpy.mock.calls.at(-1)?.[0] as EscalationFilters;
    expect(filters.kind).toBe("blocked");
  });

  it("severity filter updates the object passed to useEscalations", () => {
    render(<EscalationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    const filters = useEscalationsSpy.mock.calls.at(-1)?.[0] as EscalationFilters;
    expect(filters.severity).toBe("high");
  });

  it("origin repo + worker key text inputs update the filters", async () => {
    render(<EscalationsPage />);
    fireEvent.change(screen.getByPlaceholderText("Origin repo…"), {
      target: { value: "game_one" },
    });
    fireEvent.change(screen.getByPlaceholderText("Worker key…"), {
      target: { value: "worker-7" },
    });
    await waitFor(() => {
      const filters = useEscalationsSpy.mock.calls.at(-1)?.[0] as EscalationFilters;
      expect(filters.originRepo).toBe("game_one");
      expect(filters.originWorkerKey).toBe("worker-7");
    });
  });

  it("each card links to the escalation timeline carrying the escalationId", () => {
    escalationsData = [makeEscalation({ id: "e-42", title: "Deep link me" })];
    render(<EscalationsPage />);
    const cardLink = linkCalls.find(
      (c) => c.to === "/projects/$projectId/escalations/$escalationId",
    );
    expect(cardLink).toBeTruthy();
    expect(cardLink?.params).toEqual({ projectId: "proj-1", escalationId: "e-42" });
  });
});
