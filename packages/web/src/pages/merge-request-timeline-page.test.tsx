import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MergeRequestTimeline } from "@/lib/api";

// ── Mock the router (useParams + Link) ───────────────────────────
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ requestId: "mr-1111" }),
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
    // Render a plain anchor whose href encodes the resolved route so the
    // link target is assertable without a full router.
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

// ── Mock the query hook ──────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  useMergeRequestTimeline: vi.fn(),
}));
vi.mock("@/hooks/use-train", () => mocks);

import { MergeRequestTimelinePage } from "./merge-request-timeline-page";

// ── Fixtures ─────────────────────────────────────────────────────

function seededTimeline(): MergeRequestTimeline {
  const t = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  return {
    request: {
      id: "mr-1111-2222",
      projectId: "proj-1",
      resource: "main",
      submittedBy: "user-1",
      taskId: "task-aaaa",
      resolvedFrom: null,
      synthetic: false,
      branch: "feature/x",
      commitSha: "deadbeef",
      verifyCmd: "pnpm verify",
      worktreePath: null,
      status: "landed",
      enqueuedAt: t(30),
      pickedUpAt: t(25),
      resolvedAt: t(2),
      landedSha: "feedface1234",
      rejectCategory: null,
      rejectReason: null,
      failedFiles: null,
      logExcerpt: null,
      logUrl: null,
      createdAt: t(30),
      updatedAt: t(2),
    },
    events: [
      { at: t(30), kind: "queued" },
      { at: t(25), kind: "integrating" },
      {
        at: t(24),
        kind: "attempt",
        attemptNumber: 1,
        status: "failed",
        baseSha: "aaaa1111",
        treeSha: "bbbb2222",
        failureCategory: "test_failed",
        logUrl: "https://logs.example/attempt-1",
      },
      {
        at: t(10),
        kind: "attempt",
        attemptNumber: 2,
        status: "passed",
        baseSha: "cccc3333",
        treeSha: "dddd4444",
        logExcerpt: "all tests passed\nverify ok",
        logUrl: null,
        // Phase 7.5: per-step pipeline results on THIS attempt only (others
        // stay absent → the degrades-to-7.4 path is exercised too).
        steps: [
          {
            stepId: "lint",
            outcome: "pass",
            cached: true,
            durationMs: 0,
            treeSha: "dddd4444",
            stepConfigSha: "cfg-lint",
          },
          {
            stepId: "unit",
            outcome: "pass",
            cached: false,
            durationMs: 11000,
            treeSha: "dddd4444",
            stepConfigSha: "cfg-unit",
          },
        ],
      },
      {
        at: t(5),
        kind: "audit",
        action: "force_land",
        actorId: "alice",
        reason: "hotfix — verify flaky on CI",
      },
      { at: t(2), kind: "landed", landedSha: "feedface1234" },
    ],
  };
}

function orphanTimeline(): MergeRequestTimeline {
  const now = new Date().toISOString();
  return {
    request: {
      ...seededTimeline().request,
      status: "orphaned",
      landedSha: null,
    },
    events: [
      { at: now, kind: "queued" },
      {
        at: now,
        kind: "incident",
        type: "orphaned_inner",
        orphanedSha: "0rph4n5ha99",
        state: "open",
        openedAt: now,
        resolvedAt: null,
      },
    ],
  };
}

// An attempt with no logUrl AND no logExcerpt → must render without crashing.
function nullSafeTimeline(): MergeRequestTimeline {
  const now = new Date().toISOString();
  return {
    request: {
      ...seededTimeline().request,
      status: "integrating",
      taskId: null,
      branch: null,
      landedSha: null,
    },
    events: [
      {
        at: now,
        kind: "attempt",
        // attemptNumber, baseSha, treeSha, logUrl, logExcerpt all absent
        status: "running",
      },
    ],
  };
}

// Phase 7.6: an origin request whose conflict spawned a resolver attempt that
// resolved + resubmitted (carries a "resolution" event with a forward link),
// plus a resolved request carrying a "resolution_origin" back-link.
function resolutionTimeline(): MergeRequestTimeline {
  const now = new Date().toISOString();
  return {
    request: {
      ...seededTimeline().request,
      id: "mr-origin-9999",
      status: "rejected",
      landedSha: null,
      rejectCategory: "conflict",
    },
    events: [
      { at: now, kind: "queued" },
      { at: now, kind: "rejected", rejectCategory: "conflict" },
      {
        at: now,
        kind: "resolution",
        resolutionId: "res-1",
        resolutionState: "resolved",
        originRequestId: "mr-origin-9999",
        resolvedRequestId: "mr-resolved-5555",
        conflictingFiles: ["src/conflicted.ts"],
      },
    ],
  };
}

function resolutionOriginTimeline(): MergeRequestTimeline {
  const now = new Date().toISOString();
  return {
    request: {
      ...seededTimeline().request,
      id: "mr-resolved-5555",
      resolvedFrom: "mr-origin-9999",
      status: "landed",
    },
    events: [
      {
        at: now,
        kind: "resolution_origin",
        originRequestId: "mr-origin-9999",
      },
      { at: now, kind: "queued" },
    ],
  };
}

function q<T>(data: T | undefined, opts: Partial<{ isLoading: boolean; isError: boolean }> = {}) {
  return { data, isLoading: false, isError: false, ...opts } as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useMergeRequestTimeline.mockReturnValue(q(seededTimeline()));
});

describe("MergeRequestTimelinePage — seeded multi-attempt", () => {
  it("renders the request header with id + status + landedSha", () => {
    render(<MergeRequestTimelinePage />);
    expect(screen.getByText("mr-1111-2222")).toBeInTheDocument();
    // "Landed" appears as both the header status badge and the terminal event.
    expect(screen.getAllByText("Landed").length).toBeGreaterThan(0);
    // landed sha (short) — header + terminal event both render it.
    expect(screen.getAllByText(/feedface12/).length).toBeGreaterThan(0);
  });

  it("renders events in ascending backend order", () => {
    render(<MergeRequestTimelinePage />);
    const list = screen.getByRole("list");
    const text = list.textContent ?? "";
    const iQueued = text.indexOf("Queued");
    const iIntegrating = text.indexOf("Integrating");
    const iAttempt1 = text.indexOf("Attempt 1");
    const iForce = text.indexOf("Force Land");
    expect(iQueued).toBeGreaterThanOrEqual(0);
    expect(iIntegrating).toBeGreaterThan(iQueued);
    expect(iAttempt1).toBeGreaterThan(iIntegrating);
    expect(iForce).toBeGreaterThan(iAttempt1);
  });

  it("shows attempts with status, failureCategory, and a log link", () => {
    render(<MergeRequestTimelinePage />);
    expect(screen.getByText("Attempt 1")).toBeInTheDocument();
    expect(screen.getByText("Attempt 2")).toBeInTheDocument();
    // failed attempt's failure category
    expect(screen.getByText("Test Failed")).toBeInTheDocument();
    // attempt 1 log link → external href
    const link = screen.getByRole("link", { name: /view verify log/i });
    expect(link).toHaveAttribute("href", "https://logs.example/attempt-1");
    // attempt 2 has no logUrl → an excerpt <details> instead
    expect(screen.getByText("Log excerpt")).toBeInTheDocument();
  });

  it("renders per-step rows under an attempt with steps (Phase 7.5)", () => {
    render(<MergeRequestTimelinePage />);
    // step ids from attempt #2's steps[].
    expect(screen.getByText("lint")).toBeInTheDocument();
    expect(screen.getByText("unit")).toBeInTheDocument();
    // a cache "hit" chip on the cached step.
    expect(screen.getByText("hit")).toBeInTheDocument();
    // the uncached step's duration (11000ms → "11s").
    expect(screen.getByText("11s")).toBeInTheDocument();
  });

  it("degrades to the 7.4 view for attempts WITHOUT steps", () => {
    render(<MergeRequestTimelinePage />);
    // Attempt 1 carries no steps → no step ids/chips for it; only the failing
    // attempt's log link + category render (asserted above). A "hit" chip must
    // come solely from attempt #2 (exactly one cached step in the fixtures).
    expect(screen.getAllByText("hit").length).toBe(1);
  });

  it("surfaces the force_land override accountability (actor + reason)", () => {
    render(<MergeRequestTimelinePage />);
    expect(screen.getByText("Force Land")).toBeInTheDocument();
    expect(screen.getAllByText("Override").length).toBeGreaterThan(0);
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText(/reason: hotfix — verify flaky on CI/)).toBeInTheDocument();
  });
});

describe("MergeRequestTimelinePage — orphan incident", () => {
  beforeEach(() => {
    mocks.useMergeRequestTimeline.mockReturnValue(q(orphanTimeline()));
  });

  it("renders the orphan incident with sha + state", () => {
    render(<MergeRequestTimelinePage />);
    expect(screen.getByText("Orphaned Inner")).toBeInTheDocument();
    expect(screen.getByText(/0rph4n5ha9/)).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
  });
});

describe("MergeRequestTimelinePage — null-safe", () => {
  beforeEach(() => {
    mocks.useMergeRequestTimeline.mockReturnValue(q(nullSafeTimeline()));
  });

  it("renders an attempt with no log/sha/number without crashing", () => {
    render(<MergeRequestTimelinePage />);
    // attemptNumber absent → "Attempt —"
    expect(screen.getByText(/Attempt/)).toBeInTheDocument();
    // running status badge still shows
    expect(screen.getByText("Running")).toBeInTheDocument();
    // no NaN / "undefined" leaked into the output
    expect(document.body.textContent).not.toContain("NaN");
    expect(document.body.textContent).not.toContain("undefined");
    // no log link rendered
    expect(screen.queryByRole("link", { name: /view verify log/i })).not.toBeInTheDocument();
  });
});

describe("MergeRequestTimelinePage — resolution lineage (Phase 7.6)", () => {
  it("renders the resolution event with state + conflicting files + a link to the resolved request", () => {
    mocks.useMergeRequestTimeline.mockReturnValue(q(resolutionTimeline()));
    render(<MergeRequestTimelinePage />);

    // the resolution node label + its resolved state badge.
    expect(screen.getByText("Conflict resolution")).toBeInTheDocument();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
    // conflicting file surfaced.
    expect(screen.getByText("src/conflicted.ts")).toBeInTheDocument();
    // forward link to the resolved request's own timeline.
    const link = screen.getByRole("link", { name: /view resolved request/i });
    expect(link).toHaveAttribute("href", "/merge-requests/mr-resolved-5555/timeline");
  });

  it("renders the resolution_origin back-link on the resolved request", () => {
    mocks.useMergeRequestTimeline.mockReturnValue(q(resolutionOriginTimeline()));
    render(<MergeRequestTimelinePage />);

    expect(screen.getByText("Resolved from origin")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /view origin request/i });
    expect(link).toHaveAttribute("href", "/merge-requests/mr-origin-9999/timeline");
  });
});

describe("MergeRequestTimelinePage — synthetic member (inner-only groups)", () => {
  it("renders the synthetic gitlink bump badge for a ref-less synthetic request", () => {
    const base = seededTimeline();
    mocks.useMergeRequestTimeline.mockReturnValue(
      q({
        request: {
          ...base.request,
          synthetic: true,
          branch: null,
          commitSha: null,
        },
        events: [{ at: new Date().toISOString(), kind: "queued" }],
      } satisfies MergeRequestTimeline),
    );
    render(<MergeRequestTimelinePage />);
    expect(screen.getByText("synthetic gitlink bump")).toBeInTheDocument();
  });

  it("does NOT render the badge on a normal request", () => {
    render(<MergeRequestTimelinePage />);
    expect(screen.queryByText("synthetic gitlink bump")).not.toBeInTheDocument();
  });
});

describe("MergeRequestTimelinePage — loading / error", () => {
  it("renders a skeleton while loading", () => {
    mocks.useMergeRequestTimeline.mockReturnValue(q(undefined, { isLoading: true }));
    const { container } = render(<MergeRequestTimelinePage />);
    // skeleton uses animate-pulse
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders an error state when the query errors", () => {
    mocks.useMergeRequestTimeline.mockReturnValue(q(undefined, { isError: true }));
    render(<MergeRequestTimelinePage />);
    expect(screen.getByText(/could not load this merge request timeline/i)).toBeInTheDocument();
  });
});

describe("MergeRequestTimelinePage — header back link", () => {
  it("links back to the project train dashboard", () => {
    render(<MergeRequestTimelinePage />);
    const back = screen.getByRole("link", { name: /back to train/i });
    expect(back).toHaveAttribute("href", "/projects/proj-1/train");
  });
});
