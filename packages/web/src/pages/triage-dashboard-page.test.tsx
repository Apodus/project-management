import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TriageMetrics } from "@/lib/api";

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

// ── Mock the query hooks ─────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  useTriageMetrics: vi.fn(),
  useProjectActivity: vi.fn(),
}));
vi.mock("@/hooks/use-triage-decisions", () => ({ useTriageMetrics: mocks.useTriageMetrics }));
vi.mock("@/hooks/use-activity", () => ({ useProjectActivity: mocks.useProjectActivity }));

import { TriageDashboardPage } from "./triage-dashboard-page";

// ── Fixtures ─────────────────────────────────────────────────────

function seededMetrics(overrides?: Partial<TriageMetrics>): TriageMetrics {
  return {
    decision_mix: {
      shadow: {
        promote_standard: 1,
        promote_fast_track: 0,
        dismiss: 3,
        needs_human: 1,
        give_up: 0,
      },
      on: { promote_standard: 2, promote_fast_track: 1, dismiss: 0, needs_human: 0, give_up: 1 },
      shadow_total: 5,
      on_total: 4,
      total: 9,
    },
    latency: { p50_ms: 9 * 60_000, p95_ms: 12 * 60_000, sample_size: 7 },
    lane_counts: { open: 4, needs_human: 2, triaged: 11 },
    scope: { triage_agent_id: "agent-x", filtered: true, by_actor: [] },
    heartbeat: { last_decision_at: new Date().toISOString(), age_ms: 5_000 },
    window_since: null,
    total: 9,
    computed_at: new Date().toISOString(),
    ...overrides,
  };
}

function emptyMetrics(): TriageMetrics {
  return {
    decision_mix: {
      shadow: {
        promote_standard: 0,
        promote_fast_track: 0,
        dismiss: 0,
        needs_human: 0,
        give_up: 0,
      },
      on: { promote_standard: 0, promote_fast_track: 0, dismiss: 0, needs_human: 0, give_up: 0 },
      shadow_total: 0,
      on_total: 0,
      total: 0,
    },
    latency: { p50_ms: null, p95_ms: null, sample_size: 0 },
    lane_counts: { open: 0, needs_human: 0, triaged: 0 },
    scope: { triage_agent_id: null, filtered: false, by_actor: [] },
    heartbeat: { last_decision_at: null, age_ms: null },
    window_since: null,
    total: 0,
    computed_at: new Date().toISOString(),
  };
}

function q<T>(data: T | undefined, isLoading = false) {
  return { data, isLoading } as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTriageMetrics.mockReturnValue(q(seededMetrics()));
  mocks.useProjectActivity.mockReturnValue(q({ data: [] }));
});

describe("TriageDashboardPage — seeded data", () => {
  it("renders lane counts", () => {
    render(<TriageDashboardPage />);
    expect(screen.getByText("Open")).toBeInTheDocument();
    // "Needs human" also appears as a decision-mix row label → at least one.
    expect(screen.getAllByText("Needs human").length).toBeGreaterThan(0);
    expect(screen.getByText("Triaged")).toBeInTheDocument();
    expect(screen.getByText("11")).toBeInTheDocument(); // triaged (unique)
  });

  it("renders the decision-mix table with per-kind shadow/on counts", () => {
    render(<TriageDashboardPage />);
    expect(screen.getByText("Decision mix")).toBeInTheDocument();
    expect(screen.getByText("Promote (standard)")).toBeInTheDocument();
    expect(screen.getByText("Give up")).toBeInTheDocument();
    // shadow_total / on_total metric cards.
    expect(screen.getByText("Shadow decisions")).toBeInTheDocument();
    expect(screen.getByText("On decisions")).toBeInTheDocument();
  });

  it("renders the latency card (p95 + p50/n sub)", () => {
    render(<TriageDashboardPage />);
    expect(screen.getByText("Triage latency (p95)")).toBeInTheDocument();
    expect(screen.getByText("12m 0s")).toBeInTheDocument();
    expect(screen.getByText(/p50 9m 0s · n=7/)).toBeInTheDocument();
  });

  it("renders the heartbeat (last-decision freshness, not liveness)", () => {
    render(<TriageDashboardPage />);
    expect(screen.getByText("last triage decision recorded")).toBeInTheDocument();
    expect(screen.getByText(/ago/)).toBeInTheDocument();
  });

  it("renders the scope badge when filtered", () => {
    render(<TriageDashboardPage />);
    expect(screen.getByText(/Scoped to agent agent-x/)).toBeInTheDocument();
  });
});

describe("TriageDashboardPage — unfiltered scope", () => {
  it("shows the amber 'no triage agent designated' banner + by_actor table", () => {
    mocks.useTriageMetrics.mockReturnValue(
      q(
        seededMetrics({
          scope: {
            triage_agent_id: null,
            filtered: false,
            by_actor: [
              { actor_id: "actor-a", count: 6 },
              { actor_id: "actor-b", count: 3 },
            ],
          },
        }),
      ),
    );
    render(<TriageDashboardPage />);
    expect(screen.getByText(/No triage agent designated/)).toBeInTheDocument();
    expect(screen.getByText("actor-a")).toBeInTheDocument();
    expect(screen.getByText("actor-b")).toBeInTheDocument();
  });
});

describe("TriageDashboardPage — audit chain", () => {
  it("filters activity to entityType ∈ {note, triage_decision}", () => {
    mocks.useProjectActivity.mockReturnValue(
      q({
        data: [
          {
            id: "a1",
            entityType: "note",
            entityId: "note-1",
            action: "created",
            actorName: "Alice",
            entityTitle: "A finding",
            createdAt: new Date().toISOString(),
          },
          {
            id: "a2",
            entityType: "triage_decision",
            entityId: "td-1",
            action: "needs_human",
            actorName: "Triager",
            entityTitle: null,
            createdAt: new Date().toISOString(),
          },
          {
            id: "a3",
            entityType: "proposal",
            entityId: "prop-1",
            action: "created",
            actorName: "Bob",
            entityTitle: "Unrelated proposal",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    render(<TriageDashboardPage />);
    expect(screen.getByText("A finding")).toBeInTheDocument();
    expect(screen.getByText("Triager")).toBeInTheDocument();
    // The non-triage entity (proposal) must be filtered out.
    expect(screen.queryByText("Unrelated proposal")).toBeNull();
  });
});

describe("TriageDashboardPage — empty state", () => {
  it("renders the empty decision-mix state and zeroed lanes without NaN", () => {
    mocks.useTriageMetrics.mockReturnValue(q(emptyMetrics()));
    render(<TriageDashboardPage />);
    expect(screen.getByText("No triage decisions yet")).toBeInTheDocument();
    expect(screen.getByText("No triage activity yet")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("NaN");
  });
});
