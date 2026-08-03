import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TrainTrace, TrainTraceEntry } from "@/lib/api";

// ── Mock the router Link ─────────────────────────────────────────
vi.mock("@tanstack/react-router", () => ({
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
      for (const [k, v] of Object.entries(params)) href = href.replace(`$${k}`, v);
    }
    return (
      <a href={href} {...(rest as Record<string, unknown>)}>
        {children}
      </a>
    );
  },
}));

const mocks = vi.hoisted(() => ({ useTrainTrace: vi.fn() }));
vi.mock("@/hooks/use-train", () => mocks);

import { TrainTraceSection, formatElapsed } from "./train-trace";

// ── Fixtures ─────────────────────────────────────────────────────

const NOW = "2026-08-03T12:00:00.000Z";
const MIN = 60_000;

function entry(over: Partial<TrainTraceEntry> = {}): TrainTraceEntry {
  return {
    id: "phase:01",
    source: "phase",
    kind: "phase",
    at: NOW,
    resource: "main",
    phase: "verify",
    label: null,
    subject: { type: "request", id: "mr-1", name: "Fix grass placement drift" },
    actor: null,
    reason: null,
    overridden: false,
    detail: null,
    elapsed: { basis: "phase", ms: 18 * MIN },
    ...over,
  };
}

function envelope(data: TrainTraceEntry[], over: Partial<TrainTrace> = {}): TrainTrace {
  return {
    data,
    window: { from: "2026-08-02T12:00:00.000Z", to: NOW },
    limit: 50,
    truncated: false,
    ...over,
  };
}

const q = <T,>(data: T | undefined, isLoading = false, isError = false) =>
  ({ data, isLoading, isError }) as unknown;

function renderTrace(value: unknown) {
  mocks.useTrainTrace.mockReturnValue(value);
  return render(<TrainTraceSection projectId="proj-1" />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── formatElapsed: one number, one sentence ──────────────────────

describe("formatElapsed", () => {
  it("says what each basis actually measured", () => {
    expect(formatElapsed({ basis: "phase", ms: 18 * MIN })).toBe("took 18m 0s");
    expect(
      formatElapsed({
        basis: "queue_wait",
        ms: 12 * MIN,
        sinceSubmitMs: 12 * MIN,
        requeued: false,
      }),
    ).toBe("waited 12m 0s in queue");
    expect(
      formatElapsed({ basis: "forming", ms: 4 * MIN, sinceSubmitMs: 4 * MIN, requeued: false }),
    ).toBe("spent 4m 0s forming");
    // NEVER "took": an outcome is an instant, not an interval.
    expect(formatElapsed({ basis: "since_pickup", ms: 42 * MIN })).toBe("42m 0s after pickup");
    expect(formatElapsed({ basis: "none" })).toBe("");
  });
});

// ── Rows ─────────────────────────────────────────────────────────

describe("TrainTraceSection — rows", () => {
  it("renders a phase row as 'took …' with the P4 phase hue", () => {
    const { container } = renderTrace(q(envelope([entry()])));
    expect(screen.getByText("Verify")).toBeInTheDocument();
    expect(screen.getByText(/took 18m/)).toBeInTheDocument();
    // The hue is the shared taxonomy's, not a second table minted here.
    expect(container.querySelector(".bg-blue-500")).not.toBeNull();
  });

  it("appends the integrator's step label to a phase row", () => {
    renderTrace(q(envelope([entry({ label: "build" })])));
    expect(screen.getByText("Verify · build")).toBeInTheDocument();
  });

  it("renders an instant with NO duration text — no 'took', no dash", () => {
    renderTrace(
      q(
        envelope([
          entry({
            id: "audit:01",
            source: "audit",
            kind: "requeued",
            phase: null,
            elapsed: { basis: "none" },
            reason: "main drifted at land time",
          }),
        ]),
      ),
    );
    expect(screen.getByText("Re-queued")).toBeInTheDocument();
    // Scoped to the ROW (the card's own subtitle legitimately says "took").
    const row = screen.getByTestId("trace-row").textContent ?? "";
    expect(row).not.toMatch(/took/);
    expect(row).not.toContain("—");
    expect(row).not.toMatch(/\b0s\b/);
  });

  it("renders an outcome as '… after pickup', never as 'took …'", () => {
    renderTrace(
      q(
        envelope([
          entry({
            id: "audit:02",
            source: "audit",
            kind: "landed",
            phase: null,
            detail: "abc1234d",
            elapsed: { basis: "since_pickup", ms: 42 * MIN },
          }),
        ]),
      ),
    );
    expect(screen.getByText(/42m 0s after pickup/)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/took 42m/);
  });

  it("marks a re-queued pickup as the last segment, with the total in the title", () => {
    renderTrace(
      q(
        envelope([
          entry({
            id: "entity:picked_up:mr-1",
            source: "entity",
            kind: "picked_up",
            phase: null,
            elapsed: {
              basis: "queue_wait",
              ms: 10 * MIN,
              sinceSubmitMs: 50 * MIN,
              requeued: true,
            },
          }),
        ]),
      ),
    );
    const note = screen.getByText("(last segment)");
    expect(note.closest("[title]")).toHaveAttribute(
      "title",
      expect.stringContaining("Total since submit: 50m 0s"),
    );
    expect(screen.getByText(/waited 10m 0s in queue/)).toBeInTheDocument();
  });

  it("badges a break-glass override and shows its reason", () => {
    renderTrace(
      q(
        envelope([
          entry({
            id: "audit:03",
            source: "audit",
            kind: "force_rejected",
            phase: null,
            overridden: true,
            reason: "obsoleted by a newer request",
            actor: { id: "u1", name: "Mika" },
            elapsed: { basis: "none" },
          }),
        ]),
      ),
    );
    expect(screen.getByText("operator override")).toBeInTheDocument();
    expect(screen.getByText(/obsoleted by a newer request/)).toBeInTheDocument();
    expect(screen.getByText(/Mika/)).toBeInTheDocument();
  });

  it("links a request subject to its own timeline", () => {
    renderTrace(q(envelope([entry()])));
    const link = screen.getByRole("link", { name: "Fix grass placement drift" });
    expect(link).toHaveAttribute("href", "/merge-requests/mr-1/timeline");
  });

  it("does not link a lane or group subject", () => {
    renderTrace(
      q(
        envelope([
          entry({
            id: "audit:04",
            source: "audit",
            kind: "paused",
            phase: null,
            subject: { type: "lane", id: "main", name: "main" },
            elapsed: { basis: "none" },
          }),
        ]),
      ),
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keys two entries sharing an instant by their composite ids", () => {
    // A React key collision here would silently DROP one of the two rows.
    renderTrace(
      q(
        envelope([
          entry({ id: "phase:01", source: "phase" }),
          entry({
            id: "audit:01",
            source: "audit",
            kind: "landed",
            phase: null,
            elapsed: { basis: "since_pickup", ms: 5 * MIN },
          }),
        ]),
      ),
    );
    expect(screen.getAllByTestId("trace-row")).toHaveLength(2);
  });
});

// ── The four degraded states ─────────────────────────────────────

describe("TrainTraceSection — degraded states", () => {
  it("renders normally when there are lifecycle rows but no phase rows", () => {
    // The EXPECTED state until the integrator ships §P2's emitters. It is the
    // GOOD case: a full feed plus a note about the missing durations.
    renderTrace(
      q(
        envelope([
          entry({
            id: "audit:01",
            source: "audit",
            kind: "landed",
            phase: null,
            elapsed: { basis: "since_pickup", ms: 9 * MIN },
          }),
        ]),
      ),
    );
    expect(screen.getByTestId("trace-row")).toBeInTheDocument();
    expect(
      screen.getByText(/Durations appear once the integrator reports phase boundaries/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("trace-empty")).toBeNull();
  });

  it("drops the durations note as soon as a phase row exists", () => {
    renderTrace(q(envelope([entry()])));
    expect(screen.queryByText(/Durations appear once/)).toBeNull();
  });

  it("shows a muted empty state naming the window when nothing happened", () => {
    renderTrace(q(envelope([])));
    expect(screen.getByTestId("trace-empty")).toBeInTheDocument();
    expect(screen.getByText("Nothing in the last 24 h")).toBeInTheDocument();
    expect(screen.queryByTestId("trace-error")).toBeNull();
  });

  it("makes an ERROR visually distinct from an empty lane", () => {
    // "The train is quiet" and "you are flying blind" must never look alike.
    renderTrace(q(undefined, false, true));
    const error = screen.getByTestId("trace-error");
    expect(error).toBeInTheDocument();
    expect(error).toHaveAttribute("role", "alert");
    expect(screen.getByText(/NOT a report that the lane is quiet/)).toBeInTheDocument();
    expect(screen.queryByTestId("trace-empty")).toBeNull();
  });

  it("says so when the feed is truncated", () => {
    renderTrace(q(envelope([entry()], { truncated: true })));
    expect(screen.getByText(/Showing the newest 1 of the last 24 h/)).toBeInTheDocument();
  });

  it("holds the card with skeletons while loading", () => {
    const { container } = renderTrace(q(undefined, true));
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByTestId("trace-empty")).toBeNull();
    expect(screen.queryByTestId("trace-error")).toBeNull();
  });
});
