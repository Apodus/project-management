import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PhaseTraceEntry, TrainInFlight, TrainMetrics } from "@/lib/api";

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
  useMergeRequestPhases: vi.fn(),
}));

vi.mock("@/hooks/use-train", () => mocks);

// The header renders an admin-only "Break-glass / Audit" link, so the page
// now reads useCurrentUser — mock it (default: admin) to avoid a real query.
const authMocks = vi.hoisted(() => ({
  useCurrentUser: vi.fn(() => ({ data: { role: "admin" } })),
}));
vi.mock("@/hooks/use-auth", () => authMocks);

// The ResolutionSection's resolver toggle reads the project + a resolver
// update mutation. Mock both (defaults: resolver disabled).
const projectMocks = vi.hoisted(() => ({
  useProject: vi.fn(),
  useUpdateResolverConfig: vi.fn(),
  resolverMutate: vi.fn(),
}));
vi.mock("@/hooks/use-projects", () => ({
  useProject: projectMocks.useProject,
  useUpdateResolverConfig: projectMocks.useUpdateResolverConfig,
}));

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
      last_release_failure: null,
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
    resolution: {
      attempts: 8,
      auto_resolve_success_rate: {
        ratio: 0.5,
        resolved_and_landed: 4,
        attempts: 8,
      },
      escalation_rate: { ratio: 0.25, escalated: 2, attempts: 8 },
      mean_wall_clock_ms: 250_000,
      mean_session_sec: 250,
      reclaimed_count: 1,
      budget_utilization: {
        ratio: 0.5,
        mean_consumed_sec: 300,
        budget_sec: 600,
      },
    },
    // §P3 phase timing. Note what is NOT here: the five phases with no samples
    // are ABSENT, not zero-filled — the payload never offers a 0 ms bar to
    // render (P4 must show only what was measured).
    phase_timing: {
      window: {
        phases: [
          {
            phase: "queue_wait",
            count: 20,
            p50_ms: 300_000,
            p95_ms: 660_000,
            max_ms: 720_000,
            total_ms: 6_000_000,
            share: 0.4,
            labels: [],
          },
          {
            phase: "verify",
            count: 10,
            p50_ms: 1_200_000,
            p95_ms: 1_560_000,
            max_ms: 1_800_000,
            total_ms: 9_000_000,
            share: 0.6,
            labels: [
              {
                label: "build",
                count: 10,
                p50_ms: 900_000,
                p95_ms: 1_100_000,
                max_ms: 1_200_000,
                total_ms: 7_000_000,
                share: 7 / 9,
              },
              {
                label: "test",
                count: 10,
                p50_ms: 200_000,
                p95_ms: 260_000,
                max_ms: 300_000,
                total_ms: 2_000_000,
                share: 2 / 9,
              },
            ],
          },
        ],
        total_measured_ms: 15_000_000,
        sample_size: 30,
        entity_count: 20,
      },
      recent: {
        phases: [
          {
            phase: "verify",
            count: 5,
            p50_ms: 1_260_000,
            p95_ms: 1_560_000,
            max_ms: 1_800_000,
            total_ms: 6_300_000,
            share: 1,
            labels: [],
          },
        ],
        total_measured_ms: 6_300_000,
        sample_size: 5,
        entity_count: 5,
      },
      recent_limit: 20,
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
      last_release_failure: null,
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
    resolution: {
      attempts: 0,
      auto_resolve_success_rate: {
        ratio: null,
        resolved_and_landed: 0,
        attempts: 0,
      },
      escalation_rate: { ratio: null, escalated: 0, attempts: 0 },
      mean_wall_clock_ms: null,
      mean_session_sec: null,
      reclaimed_count: 0,
      budget_utilization: {
        ratio: null,
        mean_consumed_sec: null,
        budget_sec: 600,
      },
    },
    // Nothing measured: `phases: []` and sample_size 0 IS the no-data-yet
    // predicate — there is no zero-valued phase to accidentally render.
    phase_timing: {
      window: { phases: [], total_measured_ms: 0, sample_size: 0, entity_count: 0 },
      recent: { phases: [], total_measured_ms: 0, sample_size: 0, entity_count: 0 },
      recent_limit: 20,
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
        task_id: "task-1111",
        task_title: "Fix grass placement drift",
        branch: "fix/grass",
        attempt: {
          status: "running",
          base_sha: "abc123",
          tree_sha: "def456",
          started_at: new Date().toISOString(),
        },
      },
      {
        // Task-less: names itself by branch.
        id: "mr-cccc3333",
        group_id: null,
        status: "integrating",
        enqueued_at: new Date().toISOString(),
        picked_up_at: null,
        task_id: null,
        task_title: null,
        branch: "chore/no-task",
        attempt: null,
      },
    ],
  };
}

// A fixed "now" for the phase-trace tests, so the unrecorded age is exact
// rather than a race with the wall clock.
const NOW_ISO = "2026-08-03T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

/**
 * A completed-phase trace: the derived queue_wait at the head (boolean
 * `derived`, not the string the invalid discriminator used to emit) followed by
 * one stored row.
 */
function seededTrace(overrides?: Partial<Extract<PhaseTraceEntry, { derived: true }>>) {
  const queueWait: PhaseTraceEntry = {
    derived: true,
    phase: "queue_wait",
    projectId: "proj-1",
    resource: "main",
    requestId: "mr-bbbb2222",
    groupId: null,
    startedAt: "2026-08-03T11:40:00.000Z",
    durationMs: 5 * 60_000,
    originAt: "2026-08-03T11:40:00.000Z",
    originDurationMs: 5 * 60_000,
    basis: "exact",
    ...overrides,
  };
  const rebase: PhaseTraceEntry = {
    derived: false,
    id: "phase-1",
    projectId: "proj-1",
    resource: "main",
    requestId: "mr-bbbb2222",
    groupId: null,
    attemptId: "att-1",
    phase: "rebase",
    label: null,
    startedAt: "2026-08-03T11:45:00.000Z",
    durationMs: 30_000,
    detail: null,
    recordedBy: "int-1",
    createdAt: "2026-08-03T11:45:30.000Z",
  };
  return [queueWait, rebase];
}

/** In-flight members anchored to NOW_ISO: member 1 picked up, member 2 never. */
function tracedInFlight(): TrainInFlight {
  const base = seededInFlight();
  return {
    ...base,
    members: base.members.map((m) =>
      m.id === "mr-bbbb2222"
        ? {
            ...m,
            enqueued_at: "2026-08-03T11:40:00.000Z",
            picked_up_at: "2026-08-03T11:45:00.000Z",
          }
        : { ...m, enqueued_at: "2026-08-03T11:50:00.000Z", picked_up_at: null },
    ),
  };
}

function q<T>(data: T | undefined, isLoading = false, isError = false) {
  return { data, isLoading, isError } as unknown;
}

/**
 * The page assumes an ambient TooltipProvider (App.tsx holds it, the page does
 * not), and the phase table's per-phase "what does this phase cover" tooltips
 * throw without one — so every render in this file goes through here.
 */
function renderPage() {
  return render(
    <TooltipProvider>
      <TrainDashboardPage />
    </TooltipProvider>,
  );
}

function projectWithResolver(enabled: boolean) {
  return {
    data: {
      id: "proj-1",
      settings: { integrator: { resolver: { enabled, max_concurrent: 1 } } },
    },
  } as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTrainState.mockReturnValue(q({ state: "running", reason: null }));
  mocks.useTrainHealth.mockReturnValue(q(seededMetrics().health));
  mocks.useTrainInFlight.mockReturnValue(q(seededInFlight()));
  mocks.useTrainMetrics.mockReturnValue(q(seededMetrics()));
  // vi.mock("@/hooks/use-train", () => mocks) replaces the module with EXACTLY
  // these keys, so every in-flight row calls this hook — without a default
  // return, destructuring `{ data }` off undefined crashes every test that
  // renders a member. Empty trace = the neutral "—" cell.
  mocks.useMergeRequestPhases.mockReturnValue(q([]));
  authMocks.useCurrentUser.mockReturnValue({ data: { role: "admin" } });
  projectMocks.useProject.mockReturnValue(projectWithResolver(false));
  projectMocks.useUpdateResolverConfig.mockReturnValue({
    mutate: projectMocks.resolverMutate,
    isPending: false,
  });
});

describe("TrainDashboardPage — seeded data", () => {
  it("renders the full metric set", () => {
    renderPage();
    expect(screen.getByText("Queue depth")).toBeInTheDocument();
    // queue depth value
    expect(screen.getByText("4")).toBeInTheDocument();
    // p95 time-to-land formatted (getAll: the phase table renders durations of
    // its own, and queue_wait's max happens to format the same)
    expect(screen.getAllByText("12m 0s").length).toBeGreaterThan(0);
    // verify success + pool utilization percentages
    expect(screen.getByText("92%")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    // abandon rate
    expect(screen.getByText("8%")).toBeInTheDocument();
  });

  it("renders the in-flight table with members + attempt state", () => {
    renderPage();
    // Members are named by their WORK, not their ULID: task title first, and
    // the branch stays visible underneath it.
    expect(screen.getByText("Fix grass placement drift")).toBeInTheDocument();
    expect(screen.getByText("fix/grass")).toBeInTheDocument();
    // A task-less member falls back to its branch.
    expect(screen.getByText("chore/no-task")).toBeInTheDocument();
    // The raw id prefix is no longer the name.
    expect(screen.queryByText("mr-bbbb2")).not.toBeInTheDocument();
    // grouped lane label vs standalone batch
    expect(screen.getByText(/Group group-aa/)).toBeInTheDocument();
    expect(screen.getByText("Batch")).toBeInTheDocument();
    // attempt-state badge ("Running" also appears as the train-state badge,
    // so assert at least one is present).
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
  });

  it("links each in-flight member to its per-request timeline", () => {
    renderPage();
    const link = screen.getByRole("link", { name: "Fix grass placement drift" });
    expect(link).toHaveAttribute("href", "/merge-requests/mr-bbbb2222/timeline");
  });

  it("shows the health freshness widget with an 'ago' counter", () => {
    renderPage();
    expect(screen.getByText(/ago/)).toBeInTheDocument();
    expect(screen.getByText("last heard from integrator")).toBeInTheDocument();
  });

  it("renders the lane-lock release-failure warning when last_release_failure is set (C2)", () => {
    const health = {
      ...seededMetrics().health,
      last_release_failure: {
        at: "2026-06-10T12:00:00.000Z",
        message: "HTTP 500: release exploded",
      },
    };
    mocks.useTrainHealth.mockReturnValue(q(health));
    renderPage();
    expect(screen.getByText(/Lane lock release failed/)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500: release exploded/)).toBeInTheDocument();
    expect(screen.getByText(/staleness sweep or a force-release/)).toBeInTheDocument();
  });

  it("renders NO release-failure warning when last_release_failure is null (C2)", () => {
    renderPage();
    expect(screen.queryByText(/Lane lock release failed/)).toBeNull();
  });

  it("renders SLO compliance chips", () => {
    renderPage();
    expect(screen.getByText("SLO Compliance")).toBeInTheDocument();
    // Chips render "<dimension>: OK|Breach" — match the suffix so we don't
    // collide with the metric-card label of the same name.
    expect(screen.getByText(/p95 time-to-land: OK/)).toBeInTheDocument();
    expect(screen.getByText(/Verify rate: OK/)).toBeInTheDocument();
    expect(screen.getByText(/Abandon rate: Breach/)).toBeInTheDocument();
  });

  it("renders the verify cache section (Phase 7.5)", () => {
    renderPage();
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

  it("renders the conflict-resolution section metric cards (Phase 7.6)", () => {
    renderPage();
    expect(screen.getByText("Conflict Resolution")).toBeInTheDocument();
    // Attempts card.
    expect(screen.getByText("Attempts")).toBeInTheDocument();
    // Auto-resolve success: 0.5 → "50%" with the landed sub-line.
    expect(screen.getByText("Auto-resolve success")).toBeInTheDocument();
    expect(screen.getByText("4/8 landed")).toBeInTheDocument();
    // Escalation rate: 0.25 → "25%".
    expect(screen.getByText("Escalation rate")).toBeInTheDocument();
    expect(screen.getByText("2/8 escalated")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    // Mean wall-clock: 250000ms → "4m 10s".
    expect(screen.getByText("4m 10s")).toBeInTheDocument();
    // Budget utilization sub-line.
    expect(screen.getByText("300s / 600s")).toBeInTheDocument();
  });
});

describe("TrainDashboardPage — null-safe rendering (divide-by-null bug class)", () => {
  beforeEach(() => {
    mocks.useTrainMetrics.mockReturnValue(q(nullMetrics()));
    mocks.useTrainHealth.mockReturnValue(q(nullMetrics().health));
    mocks.useTrainInFlight.mockReturnValue(q({ groups: [], members: [] }));
  });

  it("renders '—' for null metrics and never NaN", () => {
    renderPage();
    // No NaN anywhere in the rendered output.
    expect(document.body.textContent).not.toContain("NaN");
    // At least one em-dash placeholder is present for the null rates.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows 'No SLO set' when overall_compliant is null", () => {
    renderPage();
    expect(screen.getByText("No SLO set")).toBeInTheDocument();
  });

  it("shows the empty in-flight state", () => {
    renderPage();
    expect(screen.getByText("Nothing currently integrating")).toBeInTheDocument();
  });

  it("shows the disabled verify-cache state without NaN (Phase 7.5)", () => {
    renderPage();
    expect(screen.getByText("Verify cache disabled")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("NaN");
  });

  it("shows the empty conflict-resolution state when attempts are 0 (Phase 7.6)", () => {
    renderPage();
    expect(screen.getByText("No resolutions yet")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("NaN");
  });
});

describe("TrainDashboardPage — resolver enable toggle (Phase 7.6)", () => {
  it("admin sees the toggle reflecting the project's enabled state (off)", () => {
    projectMocks.useProject.mockReturnValue(projectWithResolver(false));
    renderPage();
    const toggle = screen.getByRole("switch", {
      name: "Auto-resolve conflicts",
    });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).not.toBeDisabled();
  });

  it("reflects the enabled state when on", () => {
    projectMocks.useProject.mockReturnValue(projectWithResolver(true));
    renderPage();
    const toggle = screen.getByRole("switch", {
      name: "Auto-resolve conflicts",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("toggling calls the update mutation with the inverted enabled flag", () => {
    projectMocks.useProject.mockReturnValue(projectWithResolver(false));
    renderPage();
    const toggle = screen.getByRole("switch", {
      name: "Auto-resolve conflicts",
    });
    fireEvent.click(toggle);
    expect(projectMocks.resolverMutate).toHaveBeenCalledTimes(1);
    expect(projectMocks.resolverMutate).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it("non-admin sees the toggle disabled", () => {
    authMocks.useCurrentUser.mockReturnValue({ data: { role: "user" } });
    projectMocks.useProject.mockReturnValue(projectWithResolver(false));
    renderPage();
    const toggle = screen.getByRole("switch", {
      name: "Auto-resolve conflicts",
    });
    expect(toggle).toBeDisabled();
  });
});

// ── Phase timing (campaign 2026-08-03 §P4) ───────────────────────

/** Swap in a phase-timing block, leaving the rest of the bundle seeded. */
function metricsWithPhases(patch: Partial<TrainMetrics["phase_timing"]>): TrainMetrics {
  const base = seededMetrics();
  return { ...base, phase_timing: { ...base.phase_timing, ...patch } };
}

const EMPTY_WINDOW = {
  phases: [],
  total_measured_ms: 0,
  sample_size: 0,
  entity_count: 0,
} satisfies TrainMetrics["phase_timing"]["window"];

describe("TrainDashboardPage — phase timing panel", () => {
  it("labels the denominator as measured phase time, never elapsed wall clock", () => {
    renderPage();
    expect(screen.getByText("Where the time goes")).toBeInTheDocument();
    // The same words in the subtitle, the column header and the bars' names.
    expect(screen.getAllByText(/share of measured phase time/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("img", { name: /share of measured phase time/i })).toHaveLength(2);
    // The two readings this panel must never be mistaken for.
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/of elapsed/i);
    expect(body).not.toMatch(/of the trip/i);
    // …and the footnote that says why the shares can exceed the wall clock.
    expect(screen.getByText(/counted more than once/i)).toBeInTheDocument();
  });

  it("draws one segment per measured phase and never a zero row", () => {
    renderPage();
    const bar = screen.getByRole("img", { name: /last 24 h/i });
    expect(within(bar).getAllByTestId("phase-segment")).toHaveLength(2);
    // The five unmeasured phases contribute nothing — not even a 0s duration.
    expect(screen.queryByText("0s")).toBeNull();
  });

  it("keys the bar to the named rows via its accessible name", () => {
    renderPage();
    expect(
      screen.getByRole("img", {
        name: "Share of measured phase time, last 24 h: Queue wait 40%, Verify 60%",
      }),
    ).toBeInTheDocument();
  });

  it("reports the phases NOT observed instead of showing them as zero", () => {
    renderPage();
    const absence = screen.getByText(/Not observed in the last 24 h/);
    expect(absence).toHaveTextContent("Forming, Assemble, Materialize, Rebase, Land");
    expect(absence).toHaveTextContent(/left out rather than shown as zero/);
  });

  it("renders the shares and percentiles from the payload", () => {
    renderPage();
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    // queue_wait p50 / p95
    expect(screen.getAllByText("5m 0s").length).toBeGreaterThan(0);
    expect(screen.getByText("11m 0s")).toBeInTheDocument();
    // verify p50 / p95 / max
    expect(screen.getByText("20m 0s")).toBeInTheDocument();
    expect(screen.getByText("26m 0s")).toBeInTheDocument();
    expect(screen.getByText("30m 0s")).toBeInTheDocument();
  });

  it("expands a labelled phase into its steps, scoped to that phase", () => {
    renderPage();
    expect(screen.queryByText("build")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Verify step breakdown/i }));
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    // The sub-row denominator SAYS which phase it is a share of.
    expect(screen.getByText("78% of Verify")).toBeInTheDocument();
    expect(screen.getByText("22% of Verify")).toBeInTheDocument();
  });

  it("gives a phase with no step labels no expander", () => {
    renderPage();
    expect(screen.queryByRole("button", { name: /Queue wait step breakdown/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Verify step breakdown/i })).toBeInTheDocument();
  });

  it("offers NO expander at all when nothing is labelled, and says why for verify", () => {
    const win = seededMetrics().phase_timing.window;
    mocks.useTrainMetrics.mockReturnValue(
      q(
        metricsWithPhases({
          window: { ...win, phases: win.phases.map((p) => ({ ...p, labels: [] })) },
        }),
      ),
    );
    renderPage();
    expect(screen.queryAllByRole("button", { name: /step breakdown/i })).toHaveLength(0);
    expect(
      screen.getByText(/Verify ran as one unlabelled step in this window/),
    ).toBeInTheDocument();
  });

  it("renders an unlabelled step bucket in muted italics", () => {
    const win = seededMetrics().phase_timing.window;
    mocks.useTrainMetrics.mockReturnValue(
      q(
        metricsWithPhases({
          window: {
            ...win,
            phases: win.phases.map((p) =>
              p.phase === "verify"
                ? { ...p, labels: p.labels.map((l) => ({ ...l, label: null })) }
                : p,
            ),
          },
        }),
      ),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Verify step breakdown/i }));
    expect(screen.getAllByText("(unlabelled)").length).toBeGreaterThan(0);
  });

  it("names the recent window in TRIPS, from the payload's limit", () => {
    renderPage();
    expect(screen.getByText("Last 20 trips")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/last 20 requests/i);
  });

  it("honours a different recent_limit", () => {
    mocks.useTrainMetrics.mockReturnValue(q(metricsWithPhases({ recent_limit: 5 })));
    renderPage();
    expect(screen.getByText("Last 5 trips")).toBeInTheDocument();
  });

  it("falls back to the recent window when 24h is empty, and names which it shows", () => {
    mocks.useTrainMetrics.mockReturnValue(q(metricsWithPhases({ window: EMPTY_WINDOW })));
    renderPage();
    expect(screen.getByText(/Per phase, over the last 20 trips/)).toBeInTheDocument();
    expect(screen.getByText(/Not observed in the last 20 trips/)).toHaveTextContent(
      "Forming, Queue wait, Assemble, Materialize, Rebase, Land",
    );
    expect(screen.getByText(/Nothing measured in this window/)).toBeInTheDocument();
  });

  it("shows a muted empty state — not zeros — when both windows are empty", () => {
    mocks.useTrainMetrics.mockReturnValue(q(nullMetrics()));
    renderPage();
    expect(screen.getByText("No phase timings yet")).toBeInTheDocument();
    expect(screen.getByText(/nothing has completed in the last 24 h/i)).toBeInTheDocument();
    expect(screen.queryAllByTestId("phase-segment")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("NaN");
    expect(document.body.textContent).not.toContain("0%");
  });

  it("keeps a null-share phase in the table (em dash) and off the bar", () => {
    mocks.useTrainMetrics.mockReturnValue(
      q(
        metricsWithPhases({
          window: {
            phases: [
              {
                phase: "verify",
                count: 3,
                p50_ms: 60_000,
                p95_ms: 90_000,
                max_ms: 120_000,
                total_ms: 180_000,
                share: 1,
                labels: [],
              },
              {
                phase: "land",
                count: 1,
                p50_ms: 1_000,
                p95_ms: 1_000,
                max_ms: 1_000,
                total_ms: 1_000,
                share: null,
                labels: [],
              },
            ],
            total_measured_ms: 181_000,
            sample_size: 4,
            entity_count: 4,
          },
        }),
      ),
    );
    renderPage();
    const bar = screen.getByRole("img", { name: /last 24 h/i });
    expect(within(bar).getAllByTestId("phase-segment")).toHaveLength(1);
    const landRow = screen.getByText("Land").closest("tr");
    expect(landRow).not.toBeNull();
    expect(within(landRow as HTMLElement).getByText("—")).toBeInTheDocument();
  });

  it("survives an all-zero window without a NaN width", () => {
    mocks.useTrainMetrics.mockReturnValue(
      q(
        metricsWithPhases({
          window: {
            phases: [
              {
                phase: "verify",
                count: 2,
                p50_ms: 0,
                p95_ms: 0,
                max_ms: 0,
                total_ms: 0,
                share: 0,
                labels: [],
              },
            ],
            total_measured_ms: 0,
            sample_size: 2,
            entity_count: 2,
          },
        }),
      ),
    );
    renderPage();
    // innerHTML, not textContent: a NaN would land in a style attribute.
    expect(document.body.innerHTML).not.toContain("NaN");
  });
});

// ── Per-member phase progress (campaign 2026-08-03 §P4) ──────────

describe("TrainDashboardPage — per-member phase progress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
    mocks.useTrainInFlight.mockReturnValue(q(tracedInFlight()));
    mocks.useMergeRequestPhases.mockReturnValue(q(seededTrace()));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders one chip per COMPLETED phase, with its duration", () => {
    renderPage();
    expect(screen.getByText("Phase progress")).toBeInTheDocument();
    const rebaseChips = screen.getAllByText("Rebase");
    expect(rebaseChips.length).toBeGreaterThan(0);
    expect(rebaseChips[0].closest("[title]")).toHaveAttribute(
      "title",
      expect.stringContaining("Replaying the request"),
    );
    expect(screen.getAllByText("30s").length).toBeGreaterThan(0);
  });

  it("names no running phase, and reports the gap as unrecorded", () => {
    renderPage();
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/currently in/i);
    expect(body).not.toMatch(/in progress: verify/i);
    // Last recorded boundary 11:45:30 → now 12:00:00.
    const chip = screen.getByText(/\+ 14m 30s unrecorded/);
    expect(chip).toHaveAttribute("title", expect.stringContaining("no name yet"));
  });

  it("marks a re-queued queue_wait as the last segment, with the origin total", () => {
    mocks.useMergeRequestPhases.mockReturnValue(
      q(
        seededTrace({
          basis: "requeued",
          durationMs: 5 * 60_000,
          originDurationMs: 42 * 60_000,
        }),
      ),
    );
    renderPage();
    const note = screen.getAllByText("(last segment)")[0];
    expect(note.closest("[title]")).toHaveAttribute(
      "title",
      expect.stringContaining("Total since submit: 42m 0s"),
    );
  });

  it("gives a never-picked-up member NO unrecorded chip", () => {
    renderPage();
    // Both members carry a trace; only the picked-up one can accrue unrecorded
    // time — now − enqueued_at is not a substitute (a requeue nulls pickup).
    expect(screen.getAllByText(/unrecorded/)).toHaveLength(1);
  });

  it("holds the row height with a skeleton while the trace loads", () => {
    mocks.useMergeRequestPhases.mockReturnValue(q(undefined, true));
    const { container } = renderPage();
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);
  });

  it("falls back to an em dash when the trace errors", () => {
    mocks.useMergeRequestPhases.mockReturnValue(q(undefined, false, true));
    renderPage();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText(/unrecorded/)).toBeNull();
  });
});
