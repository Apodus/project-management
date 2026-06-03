import { describe, expect, it } from "vitest";
import type { EpicGraphNode } from "./api";
import { partitionEpics, recedeOpacity, PAST_THRESHOLD_MS } from "./epic-graph-recency";

const NOW = "2026-06-02T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

// Minimal node carrying only the fields the recency helpers read. `time_window`
// defaults to a non-null end (so a fixture is "scheduled" unless it explicitly
// passes `end: null`); `created_at` rides along to satisfy the widened generic.
function makeNode(
  id: string,
  opts: {
    recency: string;
    health: EpicGraphNode["health"];
    end?: string | null;
  },
): Pick<EpicGraphNode, "health" | "activity_recency" | "time_window"> & {
  id: string;
  created_at: string;
} {
  return {
    id,
    health: opts.health,
    activity_recency: opts.recency,
    created_at: opts.recency,
    time_window: { start: opts.recency, end: opts.end === undefined ? opts.recency : opts.end },
  };
}

// Helpers to land a recency a given number of ms before NOW.
function recencyAgo(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

describe("partitionEpics", () => {
  it("done + old recedes into the past bucket", () => {
    const old = makeNode("a", {
      recency: recencyAgo(PAST_THRESHOLD_MS + 86_400_000),
      health: "done",
    });
    const r = partitionEpics([old], { now: NOW });
    expect(r.past.map((n) => n.id)).toEqual(["a"]);
    expect(r.active).toEqual([]);
  });

  it("done + recent stays active", () => {
    const recent = makeNode("a", { recency: recencyAgo(86_400_000), health: "done" });
    const r = partitionEpics([recent], { now: NOW });
    expect(r.active.map((n) => n.id)).toEqual(["a"]);
    expect(r.past).toEqual([]);
  });

  it("incomplete + old stays active for every non-done health (never hidden)", () => {
    const oldRecency = recencyAgo(PAST_THRESHOLD_MS + 86_400_000);
    const healths: EpicGraphNode["health"][] = ["not_started", "on_track", "at_risk", "blocked"];
    for (const health of healths) {
      const node = makeNode("a", { recency: oldRecency, health });
      const r = partitionEpics([node], { now: NOW });
      expect(r.active.map((n) => n.id)).toEqual(["a"]);
      expect(r.past).toEqual([]);
    }
  });

  it("NaN recency + done stays active", () => {
    const bad = makeNode("a", { recency: "not-a-date", health: "done" });
    const r = partitionEpics([bad], { now: NOW });
    expect(r.active.map((n) => n.id)).toEqual(["a"]);
    expect(r.past).toEqual([]);
  });

  it("exactly-at-threshold stays active (strict <)", () => {
    const atBoundary = makeNode("a", { recency: recencyAgo(PAST_THRESHOLD_MS), health: "done" });
    const r = partitionEpics([atBoundary], { now: NOW });
    expect(r.active.map((n) => n.id)).toEqual(["a"]);
    expect(r.past).toEqual([]);
  });

  it("empty input → empty buckets", () => {
    const r = partitionEpics([], { now: NOW });
    expect(r).toEqual({ active: [], past: [], unscheduled: [] });
  });

  it("preserves input order within each bucket", () => {
    const oldRecency = recencyAgo(PAST_THRESHOLD_MS + 86_400_000);
    const recentRecency = recencyAgo(86_400_000);
    const nodes = [
      makeNode("p1", { recency: oldRecency, health: "done" }),
      makeNode("a1", { recency: recentRecency, health: "on_track" }),
      makeNode("u1", { recency: recentRecency, health: "not_started", end: null }),
      makeNode("p2", { recency: oldRecency, health: "done" }),
      makeNode("a2", { recency: oldRecency, health: "blocked" }),
      makeNode("u2", { recency: recentRecency, health: "not_started", end: null }),
    ];
    const r = partitionEpics(nodes, { now: NOW });
    expect(r.past.map((n) => n.id)).toEqual(["p1", "p2"]);
    expect(r.active.map((n) => n.id)).toEqual(["a1", "a2"]);
    expect(r.unscheduled.map((n) => n.id)).toEqual(["u1", "u2"]);
  });

  it("not_started + no target → unscheduled", () => {
    const n = makeNode("a", { recency: recencyAgo(86_400_000), health: "not_started", end: null });
    const r = partitionEpics([n], { now: NOW });
    expect(r.unscheduled.map((x) => x.id)).toEqual(["a"]);
    expect(r.active).toEqual([]);
    expect(r.past).toEqual([]);
  });

  it("not_started + has target → active (a committed window keeps it on the timeline)", () => {
    const n = makeNode("a", {
      recency: recencyAgo(86_400_000),
      health: "not_started",
      end: NOW,
    });
    const r = partitionEpics([n], { now: NOW });
    expect(r.active.map((x) => x.id)).toEqual(["a"]);
    expect(r.unscheduled).toEqual([]);
  });

  it("in-flight health + no target → active (only not_started parks to the backlog)", () => {
    for (const health of ["on_track", "at_risk", "blocked"] as EpicGraphNode["health"][]) {
      const n = makeNode("a", { recency: recencyAgo(86_400_000), health, end: null });
      const r = partitionEpics([n], { now: NOW });
      expect(r.active.map((x) => x.id)).toEqual(["a"]);
      expect(r.unscheduled).toEqual([]);
      expect(r.past).toEqual([]);
    }
  });

  it("done + old wins over the unscheduled rule (priority order)", () => {
    // not_started would be unscheduled, but done+old is checked first; a done
    // epic is never unscheduled.
    const n = makeNode("a", {
      recency: recencyAgo(PAST_THRESHOLD_MS + 86_400_000),
      health: "done",
      end: null,
    });
    const r = partitionEpics([n], { now: NOW });
    expect(r.past.map((x) => x.id)).toEqual(["a"]);
    expect(r.unscheduled).toEqual([]);
  });

  it("is deterministic + disjoint: a shuffle yields identical buckets, every node in exactly one", () => {
    const oldRecency = recencyAgo(PAST_THRESHOLD_MS + 86_400_000);
    const recent = recencyAgo(86_400_000);
    const nodes = [
      makeNode("p1", { recency: oldRecency, health: "done" }),
      makeNode("a1", { recency: recent, health: "on_track" }),
      makeNode("u1", { recency: recent, health: "not_started", end: null }),
      makeNode("u2", { recency: recent, health: "not_started", end: null }),
      makeNode("a2", { recency: recent, health: "not_started", end: NOW }),
    ];
    const shuffled = [nodes[3], nodes[0], nodes[4], nodes[2], nodes[1]];
    const r1 = partitionEpics(nodes, { now: NOW });
    const r2 = partitionEpics(shuffled, { now: NOW });
    const buckets = (r: typeof r1) => ({
      active: new Set(r.active.map((n) => n.id)),
      past: new Set(r.past.map((n) => n.id)),
      unscheduled: new Set(r.unscheduled.map((n) => n.id)),
    });
    expect(buckets(r1)).toEqual(buckets(r2));
    // Disjoint + total: each of the 5 ids lands in exactly one bucket.
    const all = [...r1.active, ...r1.past, ...r1.unscheduled].map((n) => n.id);
    expect(all.sort()).toEqual(["a1", "a2", "p1", "u1", "u2"]);
    expect(new Set(all).size).toBe(5);
  });

  it("honors a custom pastThresholdMs", () => {
    const recency = recencyAgo(10 * 86_400_000); // 10 days old
    const done = makeNode("a", { recency, health: "done" });
    // 5-day threshold → 10 days is past; 20-day threshold → still active.
    expect(partitionEpics([done], { now: NOW, pastThresholdMs: 5 * 86_400_000 }).past).toHaveLength(
      1,
    );
    expect(
      partitionEpics([done], { now: NOW, pastThresholdMs: 20 * 86_400_000 }).active,
    ).toHaveLength(1);
  });

  it("NaN now → everything active (never hide on bad input)", () => {
    const old = makeNode("a", {
      recency: recencyAgo(PAST_THRESHOLD_MS + 86_400_000),
      health: "done",
    });
    const r = partitionEpics([old], { now: "garbage" });
    expect(r.active.map((n) => n.id)).toEqual(["a"]);
    expect(r.past).toEqual([]);
  });
});

describe("recedeOpacity", () => {
  it("present (now) → full opacity", () => {
    expect(recedeOpacity(NOW, { now: NOW })).toBe(1);
  });

  it("future recency → full opacity", () => {
    const future = new Date(NOW_MS + 86_400_000).toISOString();
    expect(recedeOpacity(future, { now: NOW })).toBe(1);
  });

  it("age >= window → floors at minOpacity (0.4 default)", () => {
    const old = recencyAgo(PAST_THRESHOLD_MS);
    expect(recedeOpacity(old, { now: NOW })).toBe(0.4);
    const older = recencyAgo(PAST_THRESHOLD_MS * 3);
    expect(recedeOpacity(older, { now: NOW })).toBe(0.4);
  });

  it("half-window age → midpoint fade (0.7 with 0.4 floor)", () => {
    const half = recencyAgo(PAST_THRESHOLD_MS / 2);
    expect(recedeOpacity(half, { now: NOW })).toBeCloseTo(0.7, 10);
  });

  it("NaN recency → full opacity", () => {
    expect(recedeOpacity("not-a-date", { now: NOW })).toBe(1);
  });

  it("NaN now → full opacity", () => {
    expect(recedeOpacity(recencyAgo(PAST_THRESHOLD_MS / 2), { now: "garbage" })).toBe(1);
  });

  it("honors custom minOpacity and fullOpacityMs", () => {
    const window = 10 * 86_400_000;
    const half = recencyAgo(window / 2);
    // floor 0.2: half-window → 1 - 0.5*(0.8) = 0.6
    expect(recedeOpacity(half, { now: NOW, fullOpacityMs: window, minOpacity: 0.2 })).toBeCloseTo(
      0.6,
      10,
    );
    // beyond custom window → custom floor
    expect(
      recedeOpacity(recencyAgo(window * 2), { now: NOW, fullOpacityMs: window, minOpacity: 0.2 }),
    ).toBe(0.2);
  });

  it("is deterministic (same input → same output)", () => {
    const r = recencyAgo(PAST_THRESHOLD_MS / 3);
    expect(recedeOpacity(r, { now: NOW })).toBe(recedeOpacity(r, { now: NOW }));
  });
});
