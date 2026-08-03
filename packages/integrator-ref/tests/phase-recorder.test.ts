/**
 * PhaseRecorder unit tests (campaign 2026-08-03 §P2) — pure, no git, no PM.
 *
 * The theme is design lock 1: telemetry is never load-bearing. Every way the
 * ingest can misbehave (reject, throw before returning a promise, not exist at
 * all, never answer) is exercised here so the integration tests can assert the
 * consequence — that a merge is unaffected — rather than re-derive the causes.
 *
 * Vitest fails a run on an unhandled rejection, so the "a rejecting client is
 * safe" cases are self-enforcing: if `flush()` ever let a rejection escape, this
 * file goes red without needing an assertion to notice.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createNoopPhaseRecorder,
  createPhaseRecorder,
  type PhaseRecorder,
} from "../src/phase-recorder.js";
import type { PmClient } from "../src/pm-client.js";

interface Post {
  projectId: string;
  resource: string;
  phases: {
    phase: string;
    startedAt: string;
    durationMs: number;
    label: string | null;
    detail?: Record<string, unknown> | null;
    requestId?: string;
    groupId?: string;
    attemptId?: string;
  }[];
}

type ClientBehavior =
  | { kind: "ok"; adjusted?: number }
  | { kind: "reject" }
  | { kind: "throw" }
  | { kind: "never" }
  | { kind: "absent" };

function harness(behavior: ClientBehavior = { kind: "ok" }): {
  recorder: PhaseRecorder;
  posts: Post[];
  warnings: string[];
} {
  const posts: Post[] = [];
  const warnings: string[] = [];
  const pmClient = {
    postMergePhases(projectId: string, body: { resource: string; phases: Post["phases"] }) {
      posts.push({ projectId, resource: body.resource, phases: body.phases });
      if (behavior.kind === "throw") throw new Error("synchronous client explosion");
      if (behavior.kind === "reject") return Promise.reject(new Error("PM said no"));
      if (behavior.kind === "never") return new Promise(() => {});
      return Promise.resolve({ recorded: body.phases.length, adjusted: behavior.adjusted ?? 0 });
    },
  };
  const recorder = createPhaseRecorder({
    pmClient: (behavior.kind === "absent" ? {} : pmClient) as unknown as Pick<
      PmClient,
      "postMergePhases"
    >,
    projectId: "proj-1",
    resource: "main",
    logger: { warn: (_fields, msg) => warnings.push(msg) },
  });
  return { recorder, posts, warnings };
}

describe("PhaseRecorder.time — invisible to the operation it measures", () => {
  it("returns fn's value verbatim", async () => {
    const { recorder } = harness();
    const sentinel = { deep: { value: 1 } };
    await expect(recorder.time({ phase: "rebase" }, () => Promise.resolve(sentinel))).resolves.toBe(
      sentinel,
    );
  });

  it("rethrows fn's error with IDENTICAL object identity, and still records the span", async () => {
    const { recorder, posts } = harness();
    const boom = new Error("rebase blew up");
    let caught: unknown;
    try {
      await recorder.time({ phase: "rebase", label: "inner" }, () => Promise.reject(boom));
    } catch (err) {
      caught = err;
    }
    // Identity, not equality: a wrapper would break every `instanceof PmApiError`
    // discriminator on the integrator's catch paths.
    expect(caught).toBe(boom);
    recorder.flush();
    // The wall clock was spent whether or not the operation succeeded.
    expect(posts[0].phases).toHaveLength(1);
    expect(posts[0].phases[0].label).toBe("inner");
  });

  it("evaluates a detail thunk against the RESOLVED value", async () => {
    const { recorder, posts } = harness();
    await recorder.time(
      { phase: "land", label: "push", detail: (p) => ({ ok: p?.ok ?? false }) },
      () => Promise.resolve({ ok: true }),
    );
    recorder.flush();
    expect(posts[0].phases[0].detail).toEqual({ ok: true });
  });

  it("passes `undefined` to the detail thunk when fn threw", async () => {
    const { recorder, posts } = harness();
    await recorder
      .time({ phase: "land", label: "push", detail: (p) => ({ ok: p?.ok ?? false }) }, () =>
        Promise.reject(new Error("push failed")),
      )
      .catch(() => {});
    recorder.flush();
    expect(posts[0].phases[0].detail).toEqual({ ok: false });
  });

  it("a detail thunk that THROWS still records the row, with detail null", async () => {
    const { recorder, posts } = harness();
    await recorder.time(
      {
        phase: "verify",
        label: "verify",
        detail: () => {
          throw new Error("bad thunk");
        },
      },
      () => Promise.resolve(1),
    );
    recorder.flush();
    expect(posts[0].phases[0].detail).toBeNull();
    expect(posts[0].phases[0].phase).toBe("verify");
  });
});

describe("PhaseRecorder — a broken ingest is never load-bearing", () => {
  it("a REJECTING client neither throws nor leaks an unhandled rejection", async () => {
    const { recorder, warnings } = harness({ kind: "reject" });
    recorder.record({ phase: "assemble", startedAtMs: Date.now(), durationMs: 5 });
    expect(() => recorder.flush()).not.toThrow();
    // Let the rejection settle inside the recorder rather than at the top level.
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings.some((w) => w.includes("POST failed"))).toBe(true);
  });

  it("a SYNCHRONOUSLY-throwing client is contained (a bare .catch would not catch it)", async () => {
    const { recorder, warnings } = harness({ kind: "throw" });
    recorder.record({ phase: "assemble", startedAtMs: Date.now(), durationMs: 5 });
    expect(() => recorder.flush()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings.some((w) => w.includes("threw synchronously"))).toBe(true);
  });

  it("a client with NO postMergePhases is safe (every legacy test fake)", () => {
    const { recorder, posts } = harness({ kind: "absent" });
    recorder.record({ phase: "land", startedAtMs: Date.now(), durationMs: 1 });
    expect(() => recorder.flush()).not.toThrow();
    expect(posts).toHaveLength(0);
  });

  it("a non-zero `adjusted` is warned about — it is this emitter's only self-check", async () => {
    const { recorder, warnings } = harness({ kind: "ok", adjusted: 3 });
    recorder.record({ phase: "verify", startedAtMs: Date.now(), durationMs: 10 });
    recorder.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings.some((w) => w.includes("THIS emitter is wrong"))).toBe(true);
  });
});

describe("PhaseRecorder — bounded work", () => {
  it("250 records produce 3 posts, none over the route's 100-entry cap", () => {
    const { recorder, posts } = harness();
    for (let i = 0; i < 250; i += 1) {
      recorder.record({ phase: "verify", startedAtMs: Date.now(), durationMs: i });
    }
    recorder.flush();
    expect(posts).toHaveLength(3);
    expect(posts.map((p) => p.phases.length)).toEqual([100, 100, 50]);
  });

  it("a never-answering PM costs bounded sockets: the 5th flush drops and the post count pins", () => {
    const { recorder, posts, warnings } = harness({ kind: "never" });
    for (let flushNo = 0; flushNo < 8; flushNo += 1) {
      recorder.record({ phase: "land", startedAtMs: Date.now(), durationMs: 1 });
      recorder.flush();
    }
    // Four outstanding POSTs is the cap; everything after is dropped, never queued.
    expect(posts).toHaveLength(4);
    expect(warnings.some((w) => w.includes("dropped"))).toBe(true);
    // ...and exactly ONE complaint, because a per-drop warning would itself be
    // the log flood (drops happen precisely when PM has stopped answering).
    expect(warnings.filter((w) => w.includes("dropped"))).toHaveLength(1);
  });

  it("an empty flush posts nothing (the route's .min(1) would answer 400)", () => {
    const { recorder, posts } = harness();
    recorder.flush();
    recorder.flush();
    expect(posts).toHaveLength(0);
  });
});

describe("PhaseRecorder.scope — a view, not a second buffer", () => {
  it("scoped rows land in the PARENT's flush and inherit ids + detail", async () => {
    const { recorder, posts } = harness();
    const scoped = recorder.scope({ groupId: "grp-1", detail: { batchId: "b-1" } });
    await scoped.time({ phase: "materialize", label: "objects" }, () => Promise.resolve(null));
    // The scope never flushed — the parent did, and the row is there.
    recorder.flush();
    expect(posts).toHaveLength(1);
    expect(posts[0].phases[0].groupId).toBe("grp-1");
    expect(posts[0].phases[0].detail).toEqual({ batchId: "b-1" });
  });

  it("a nested scope inherits, and a span's own ids/detail win over the scope's", async () => {
    const { recorder, posts } = harness();
    const outer = recorder.scope({ groupId: "grp-1", detail: { batchId: "b-1", role: "none" } });
    const inner = outer.scope({ requestId: "req-9", detail: { role: "inner" } });
    await inner.time(
      { phase: "rebase", label: "inner", attemptId: "att-3", detail: { ok: true } },
      () => Promise.resolve(null),
    );
    recorder.flush();
    const row = posts[0].phases[0];
    expect(row.groupId).toBe("grp-1");
    expect(row.requestId).toBe("req-9");
    expect(row.attemptId).toBe("att-3");
    expect(row.detail).toEqual({ batchId: "b-1", role: "inner", ok: true });
  });

  it("a scope CANNOT flush — the type split is the whole point", () => {
    const { recorder } = harness();
    const scoped = recorder.scope({ groupId: "g" });
    // Structural, not merely absent from the type: an instrumented module that
    // reached for `.flush()` at runtime would find nothing to call.
    expect("flush" in scoped).toBe(false);
  });
});

describe("PhaseRecorder — normalization keeps `adjusted` at zero", () => {
  /** The server's rules, mirrored: over-long labels, skewed durations, fat detail. */
  it("produces a body a healthy server answers adjusted: 0", () => {
    const { recorder, posts } = harness();
    recorder.record({
      phase: "verify",
      label: "x".repeat(500),
      startedAtMs: Date.now(),
      durationMs: 12.7,
      detail: { keep: "yes", drop: undefined, notFinite: Number.NaN },
    });
    recorder.record({
      phase: "assemble",
      startedAtMs: Number.NaN,
      durationMs: -50,
      detail: { blob: "y".repeat(5000) },
    });
    recorder.flush();
    const [a, b] = posts[0].phases;

    // label truncated to the server's LABEL_MAX...
    expect(a.label).toHaveLength(120);
    // ...duration rounded to a non-negative integer...
    expect(a.durationMs).toBe(13);
    expect(b.durationMs).toBe(0);
    // ...an absent fact omitted rather than encoded, a non-finite one nulled...
    expect(a.detail).toEqual({ keep: "yes", notFinite: null });
    // ...and an oversized detail dropped whole rather than sent to be dropped.
    expect(b.detail).toBeNull();

    // startedAt is an ISO instant minted here, so a caller cannot hand in the one
    // value the route 400s on rather than clamps.
    for (const row of posts[0].phases) {
      expect(row.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(Number.isNaN(Date.parse(row.startedAt))).toBe(false);
    }

    // Applying the server's own normalization to our body must be a no-op —
    // that identity IS `adjusted: 0`.
    for (const row of posts[0].phases) {
      expect(Math.max(0, Math.round(row.durationMs))).toBe(row.durationMs);
      expect(row.label === null || row.label.length <= 120).toBe(true);
      expect(row.detail === null || JSON.stringify(row.detail).length <= 4096).toBe(true);
    }
  });

  it("omits an unknown id rather than sending null (the wire rejects null there)", () => {
    const { recorder, posts } = harness();
    recorder.record({ phase: "land", startedAtMs: Date.now(), durationMs: 1 });
    recorder.flush();
    expect(posts[0].phases[0]).not.toHaveProperty("requestId");
    expect(posts[0].phases[0]).not.toHaveProperty("groupId");
    expect(posts[0].phases[0]).not.toHaveProperty("attemptId");
  });
});

describe("createNoopPhaseRecorder", () => {
  it("runs fn and records nothing", async () => {
    const noop = createNoopPhaseRecorder();
    const fn = vi.fn(() => Promise.resolve("value"));
    await expect(noop.time({ phase: "verify" }, fn)).resolves.toBe("value");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(() => {
      noop.record({ phase: "verify", startedAtMs: 0, durationMs: 0 });
      noop.scope({ groupId: "g" }).record({ phase: "verify", startedAtMs: 0, durationMs: 0 });
      noop.flush();
    }).not.toThrow();
  });
});
