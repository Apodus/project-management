import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TrainInFlight, TrainMetrics } from "@/lib/api";

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
  useTrainMetrics: vi.fn(),
  useTrainInFlight: vi.fn(),
  useTrainHealth: vi.fn(),
  useTrainState: vi.fn(),
}));

vi.mock("@/hooks/use-train", () => mocks);

// The header renders an admin-only "Break-glass / Audit" link, so the page
// now reads useCurrentUser — mock it (default: admin) to avoid a real query.
const authMocks = vi.hoisted(() => ({
  useCurrentUser: vi.fn(() => ({ data: { role: "admin" } })),
}));
vi.mock("@/hooks/use-auth", () => authMocks);

import { TrainDashboardPage } from "./train-dashboard-page";

// ── Fixtures ─────────────────────────────────────────────────────

function seededMetrics(): TrainMetrics {
  return {
    resource: "main",
    queue_depth: 4,
    in_flight: 2,
    time_to_land: {
      p50_ms: 9 * 60_000,
      p95_ms: 12 * 60_000,
      p99_ms: 15 * 60_000,
      sample_size: 20,
    },
    verify_success_rate: { ratio: 0.92, passed: 23, total: 25 },
    abandon_rate: { ratio: 0.08, abandoned: 2, resolved: 25 },
    pool_utilization: { size: 4, leased: 3, ratio: 0.75 },
    health: {
      resource: "main",
      status: "idle",
      healthy: true,
      last_seen_at: new Date().toISOString(),
      staleness_ms: 5_000,
      pool_size: 4,
      pool_leased: 3,
      in_flight_requests: 2,
      in_flight_batches: 1,
      in_flight_groups: 0,
      version: "1.0.0",
      integrator_id: "int-1",
    },
    slo: {
      p95_time_to_land: { compliant: true },
      verify_success_rate: { compliant: true },
      abandon_rate: { compliant: false },
      overall_compliant: false,
    },
    verify: {
      cache_enabled: true,
      cache_mode: "on",
      cache_hit_rate: { ratio: 0.61, hits: 122, lookups: 200 },
      time_saved_ms: 5_400_000,
      per_step: [
        {
          step_id: "lint",
          runs: 40,
          cached: 60,
          pass_rate: 0.95,
          avg_duration_ms: 4200,
          fail_count: 2,
        },
      ],
      cache_mismatches: 0,
    },
    window_hours: 24,
    computed_at: new Date().toISOString(),
  };
}

// All-empty metrics: every rate ratio is null → must render "—", never NaN.
function nullMetrics(): TrainMetrics {
  return {
    resource: "main",
    queue_depth: 0,
    in_flight: 0,
    time_to_land: { p50_ms: null, p95_ms: null, p99_ms: null, sample_size: 0 },
    verify_success_rate: { ratio: null, passed: 0, total: 0 },
    abandon_rate: { ratio: null, abandoned: 0, resolved: 0 },
    pool_utilization: { size: null, leased: null, ratio: null },
    health: {
      resource: "main",
      status: "unknown",
      healthy: false,
      last_seen_at: null,
      staleness_ms: null,
      pool_size: null,
      pool_leased: null,
      in_flight_requests: 0,
      in_flight_batches: 0,
      in_flight_groups: 0,
      version: null,
      integrator_id: null,
    },
    slo: { overall_compliant: null },
    verify: {
      cache_enabled: false,
      cache_mode: "off",
      cache_hit_rate: { ratio: null, hits: 0, lookups: 0 },
      time_saved_ms: 0,
      per_step: [],
      cache_mismatches: 0,
    },
    window_hours: 24,
    computed_at: new Date().toISOString(),
  };
}

function seededInFlight(): TrainInFlight {
  return {
    groups: [
      {
        id: "group-aaaa1111",
        project_id: "proj-1",
        resource: "main",
        state: "integrating",
        submitted_by: "user-1",
        integrator_id: "int-1",
        resolved_at: null,
        resolution_reason: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    members: [
      {
        id: "mr-bbbb2222",
        group_id: "group-aaaa1111",
        status: "integrating",
        enqueued_at: new Date().toISOString(),
        picked_up_at: new Date().toISOString(),
        attempt: {
          status: "running",
          base_sha: "abc123",
          tree_sha: "def456",
          started_at: new Date().toISOString(),
        },
      },
      {
        id: "mr-cccc3333",
        group_id: null,
        status: "integrating",
        enqueued_at: new Date().toISOString(),
        picked_up_at: null,
        attempt: null,
      },
    ],
  };
}

function q<T>(data: T | undefined, isLoading = false) {
  return { data, isLoading } as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTrainState.mockReturnValue(q({ state: "running", reason: null }));
  mocks.useTrainHealth.mockReturnValue(q(seededMetrics().health));
  mocks.useTrainInFlight.mockReturnValue(q(seededInFlight()));
  mocks.useTrainMetrics.mockReturnValue(q(seededMetrics()));
});

describe("TrainDashboardPage — seeded data", () => {
  it("renders the full metric set", () => {
    render(<TrainDashboardPage />);
    expect(screen.getByText("Queue depth")).toBeInTheDocument();
    // queue depth value
    expect(screen.getByText("4")).toBeInTheDocument();
    // p95 time-to-land formatted
    expect(screen.getByText("12m 0s")).toBeInTheDocument();
    // verify success + pool utilization percentages
    expect(screen.getByText("92%")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    // abandon rate
    expect(screen.getByText("8%")).toBeInTheDocument();
  });

  it("renders the in-flight table with members + attempt state", () => {
    render(<TrainDashboardPage />);
    expect(screen.getByText("mr-bbbb2")).toBeInTheDocument();
    expect(screen.getByText("mr-cccc3")).toBeInTheDocument();
    // grouped lane label vs standalone batch
    expect(screen.getByText(/Group group-aa/)).toBeInTheDocument();
    expect(screen.getByText("Batch")).toBeInTheDocument();
    // attempt-state badge ("Running" also appears as the train-state badge,
    // so assert at least one is present).
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
  });

  it("links each in-flight member to its per-request timeline", () => {
    render(<TrainDashboardPage />);
    const link = screen.getByRole("link", { name: "mr-bbbb2" });
    expect(link).toHaveAttribute(
      "href",
      "/merge-requests/mr-bbbb2222/timeline",
    );
  });

  it("shows the health freshness widget with an 'ago' counter", () => {
    render(<TrainDashboardPage />);
    expect(screen.getByText(/ago/)).toBeInTheDocument();
    expect(screen.getByText("last heard from integrator")).toBeInTheDocument();
  });

  it("renders SLO compliance chips", () => {
    render(<TrainDashboardPage />);
    expect(screen.getByText("SLO Compliance")).toBeInTheDocument();
    // Chips render "<dimension>: OK|Breach" — match the suffix so we don't
    // collide with the metric-card label of the same name.
    expect(screen.getByText(/p95 time-to-land: OK/)).toBeInTheDocument();
    expect(screen.getByText(/Verify rate: OK/)).toBeInTheDocument();
    expect(screen.getByText(/Abandon rate: Breach/)).toBeInTheDocument();
  });

  it("renders the verify cache section (Phase 7.5)", () => {
    render(<TrainDashboardPage />);
    expect(screen.getByText("Verify Cache")).toBeInTheDocument();
    // Cache mode badge.
    expect(screen.getByText("On")).toBeInTheDocument();
    // Cache hit rate: 0.61 → "61%" with hits/lookups sub.
    expect(screen.getByText("61%")).toBeInTheDocument();
    expect(screen.getByText("122/200 lookups")).toBeInTheDocument();
    // Time saved: 5_400_000 ms → "1h 30m".
    expect(screen.getByText("1h 30m")).toBeInTheDocument();
    // Cache mismatches label present (0 in a healthy on-mode deployment).
    expect(screen.getByText("Cache mismatches")).toBeInTheDocument();
    // Per-step row: the lint step id + its pass rate.
    expect(screen.getByText("lint")).toBeInTheDocument();
    expect(screen.getByText("95%")).toBeInTheDocument();
  });
});

describe("TrainDashboardPage — null-safe rendering (divide-by-null bug class)", () => {
  beforeEach(() => {
    mocks.useTrainMetrics.mockReturnValue(q(nullMetrics()));
    mocks.useTrainHealth.mockReturnValue(q(nullMetrics().health));
    mocks.useTrainInFlight.mockReturnValue(q({ groups: [], members: [] }));
  });

  it("renders '—' for null metrics and never NaN", () => {
    render(<TrainDashboardPage />);
    // No NaN anywhere in the rendered output.
    expect(document.body.textContent).not.toContain("NaN");
    // At least one em-dash placeholder is present for the null rates.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows 'No SLO set' when overall_compliant is null", () => {
    render(<TrainDashboardPage />);
    expect(screen.getByText("No SLO set")).toBeInTheDocument();
  });

  it("shows the empty in-flight state", () => {
    render(<TrainDashboardPage />);
    expect(
      screen.getByText("Nothing currently integrating"),
    ).toBeInTheDocument();
  });

  it("shows the disabled verify-cache state without NaN (Phase 7.5)", () => {
    render(<TrainDashboardPage />);
    expect(screen.getByText("Verify cache disabled")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("NaN");
  });
});
