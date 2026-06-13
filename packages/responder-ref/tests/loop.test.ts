import { describe, it, expect, vi } from "vitest";
import { responderTick, createResponderState, type ResponderDeps } from "../src/loop.js";
import { PmApiError } from "../src/api-client.js";
import type { Escalation, EscalationWithThread } from "@pm/shared";
import type { Logger } from "../src/logger.js";
import type { ResponderRunner, ResponderRunResult } from "../src/responder-runner.js";

// ── Fakes ──────────────────────────────────────────────────────────

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const SELF = "u-self";

function mkEscalation(
  id: string,
  over: Partial<Escalation> = {},
): Escalation {
  return {
    id,
    projectId: "p",
    kind: "question",
    status: "open",
    severity: null,
    title: id,
    body: null,
    codeLocator: null,
    anchorType: null,
    anchorId: null,
    originRepo: "repo",
    originWorkerKey: "wk",
    holderId: null,
    authorId: "human",
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

class FakeClient {
  listResults: Escalation[][] = [];
  listError: unknown;
  acks: string[] = [];
  ackError: ((id: string) => unknown) | undefined;

  listOpenEscalations = vi.fn(async (): Promise<Escalation[]> => {
    if (this.listError) throw this.listError;
    return this.listResults.shift() ?? [];
  });

  acknowledge = vi.fn(async (id: string): Promise<Escalation> => {
    const err = this.ackError?.(id);
    if (err) throw err;
    this.acks.push(id);
    return mkEscalation(id, { status: "acknowledged", holderId: SELF });
  });

  // P3: the thread fetch + the two outcome posts. getEscalation defaults to the
  // escalation spread with an empty thread (overridable per test).
  getEscalation = vi.fn(async (id: string): Promise<EscalationWithThread> => {
    return { ...mkEscalation(id, { status: "acknowledged", holderId: SELF }), messages: [] };
  });

  answerCalls: { id: string; body: string }[] = [];
  answer = vi.fn(async (id: string, body: string): Promise<Escalation> => {
    this.answerCalls.push({ id, body });
    return mkEscalation(id, { status: "answered", holderId: SELF });
  });

  escalateCalls: { id: string; reason: string }[] = [];
  escalateToHuman = vi.fn(async (id: string, reason: string): Promise<Escalation> => {
    this.escalateCalls.push({ id, reason });
    return mkEscalation(id, { status: "needs_human", holderId: SELF });
  });
}

/**
 * A scripted answering session. `run` resolves the supplied result (default
 * give_up — a benign no-post outcome). A `gate` promise lets a test hold the
 * session in flight to probe the concurrency semaphore.
 */
class FakeResponderRunner implements ResponderRunner {
  result: ResponderRunResult = { kind: "give_up", reason: "noop", durationMs: 0 };
  gate?: Promise<void>;
  run = vi.fn(async (): Promise<ResponderRunResult> => {
    if (this.gate) await this.gate;
    return this.result;
  });
}

function baseDeps(client: FakeClient, over: Partial<ResponderDeps> = {}): ResponderDeps {
  return {
    client,
    logger: silentLogger,
    projectIds: ["p"],
    selfId: SELF,
    enabled: true,
    maxConcurrent: 1,
    // Default mode: shadow. At shadow the job spawns + logs but NEVER posts, so
    // every existing P1 assertion (acknowledge/acks/claimed — all set BEFORE the
    // spawn) stays byte-identical and a no-op runner suffices.
    mode: "shadow",
    runner: new FakeResponderRunner(),
    repoCwd: "/repo",
    command: "claude -p",
    budget: { timeBudgetSec: 900 },
    now: () => 1_000_000,
    ...over,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("responderTick", () => {
  it("enabled=false → zero acknowledge calls", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    await responderTick(baseDeps(client, { enabled: false }), createResponderState());
    expect(client.listOpenEscalations).not.toHaveBeenCalled();
    expect(client.acknowledge).not.toHaveBeenCalled();
  });

  it("N unclaimed client-authored open escalations → N acknowledges", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1"), mkEscalation("e2"), mkEscalation("e3")]];
    // maxConcurrent high so all claim in one tick.
    await responderTick(baseDeps(client, { maxConcurrent: 10 }), createResponderState());
    expect(client.acknowledge).toHaveBeenCalledTimes(3);
    expect(new Set(client.acks)).toEqual(new Set(["e1", "e2", "e3"]));
  });

  it("403-on-ack → skip + continue (other escalations still claimed)", async () => {
    const client = new FakeClient();
    client.ackError = (id) =>
      id === "e1" ? new PmApiError(403, "FORBIDDEN", "held by another") : undefined;
    client.listResults = [[mkEscalation("e1"), mkEscalation("e2")]];
    const state = createResponderState();
    await responderTick(baseDeps(client, { maxConcurrent: 10 }), state);
    expect(client.acknowledge).toHaveBeenCalledTimes(2);
    expect(client.acks).toEqual(["e2"]); // e1 threw 403, not recorded
    expect(state.claimed.has("e1")).toBe(false);
    expect(state.claimed.has("e2")).toBe(true);
  });

  it("409-on-ack → skip (raced out of open)", async () => {
    const client = new FakeClient();
    client.ackError = (id) =>
      id === "e1" ? new PmApiError(409, "CONFLICT", "not open") : undefined;
    client.listResults = [[mkEscalation("e1")]];
    const state = createResponderState();
    await responderTick(baseDeps(client, { maxConcurrent: 10 }), state);
    expect(client.acknowledge).toHaveBeenCalledTimes(1);
    expect(client.acks).toEqual([]);
    expect(state.claimed.has("e1")).toBe(false);
  });

  it("poll error (listOpenEscalations throws) is non-fatal: other project processed + recovers next tick", async () => {
    const client = new FakeClient();
    // First project's list throws on every call this tick; the SECOND project
    // returns work. Model per-project errors via projectIds + a sticky error
    // gated on a call counter.
    let call = 0;
    client.listOpenEscalations = vi.fn(async (): Promise<Escalation[]> => {
      call += 1;
      if (call === 1) throw new PmApiError(0, "NETWORK", "down"); // project "a"
      return [mkEscalation("e2", { projectId: "b" })]; // project "b"
    });
    const state = createResponderState();
    await expect(
      responderTick(baseDeps(client, { projectIds: ["a", "b"], maxConcurrent: 10 }), state),
    ).resolves.toBeUndefined();
    expect(client.acknowledge).toHaveBeenCalledTimes(1);
    expect(client.acks).toEqual(["e2"]);

    // Recovery: a fresh tick where "a" now returns work.
    client.listOpenEscalations = vi.fn(async (): Promise<Escalation[]> => [
      mkEscalation("e1", { projectId: "a" }),
    ]);
    await responderTick(baseDeps(client, { projectIds: ["a"], maxConcurrent: 10 }), state);
    expect(client.acks).toEqual(["e2", "e1"]);
  });

  it("maxConcurrent=1 + blocking ack → only one in flight at a time", async () => {
    const client = new FakeClient();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    client.acknowledge = vi.fn(async (id: string): Promise<Escalation> => {
      await gate;
      client.acks.push(id);
      return mkEscalation(id, { status: "acknowledged" });
    });
    client.listResults = [[mkEscalation("e1"), mkEscalation("e2")]];
    const state = createResponderState();
    const tick = responderTick(baseDeps(client, { maxConcurrent: 1 }), state);
    await Promise.resolve();
    expect(client.acknowledge).toHaveBeenCalledTimes(1); // semaphore gates the 2nd
    release();
    await tick;
    expect(client.acknowledge).toHaveBeenCalledTimes(1); // 2nd reappears next tick
  });

  it("no-recursion seed skips authorId===selfId and holderId!=null", async () => {
    const client = new FakeClient();
    client.listResults = [
      [
        mkEscalation("mine", { authorId: SELF }), // our own thread — skip
        mkEscalation("held", { holderId: "someone" }), // already claimed — skip
        mkEscalation("notopen", { status: "acknowledged" }), // not open — skip
        mkEscalation("ok"), // the only candidate
      ],
    ];
    const state = createResponderState();
    await responderTick(baseDeps(client, { maxConcurrent: 10 }), state);
    expect(client.acks).toEqual(["ok"]);
  });

  it("already-claimed-this-process → acknowledged once across two ticks", async () => {
    const client = new FakeClient();
    const item = mkEscalation("e1");
    client.listResults = [[item], [item]];
    const state = createResponderState();
    await responderTick(baseDeps(client), state);
    await responderTick(baseDeps(client, { now: () => 9_000_000 }), state);
    expect(client.acknowledge).toHaveBeenCalledTimes(1);
    expect(client.acks).toEqual(["e1"]);
  });

  it("processes oldest-first by createdAt under a saturated semaphore", async () => {
    const client = new FakeClient();
    const late = mkEscalation("late", { createdAt: "2026-06-13T09:00:00.000Z" });
    const early = mkEscalation("early", { createdAt: "2026-06-13T01:00:00.000Z" });
    // Present out of order to prove the sort.
    client.listResults = [[late, early]];
    const state = createResponderState();
    await responderTick(baseDeps(client, { maxConcurrent: 1 }), state);
    expect(client.acknowledge).toHaveBeenCalledTimes(1);
    expect(client.acks).toEqual(["early"]);
  });

  // ── P3/P4: outcome handling ──────────────────────────────────────

  function onRunner(result: ResponderRunResult): FakeResponderRunner {
    const r = new FakeResponderRunner();
    r.result = result;
    return r;
  }

  it("on + answered → answer(id, text) called, no escalateToHuman", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = onRunner({ kind: "answered", answer: "A", durationMs: 1 });
    await responderTick(baseDeps(client, { mode: "on", runner }), createResponderState());
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(client.answerCalls).toEqual([{ id: "e1", body: "A" }]);
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("on + needs_human → escalateToHuman(id, reason)", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = onRunner({ kind: "needs_human", reason: "need a human", durationMs: 1 });
    await responderTick(baseDeps(client, { mode: "on", runner }), createResponderState());
    expect(client.escalateCalls).toEqual([{ id: "e1", reason: "need a human" }]);
    expect(client.answer).not.toHaveBeenCalled();
  });

  it("on + give_up → escalateToHuman with 'Responder gave up: ' prefix", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = onRunner({ kind: "give_up", reason: "stuck", durationMs: 1 });
    await responderTick(baseDeps(client, { mode: "on", runner }), createResponderState());
    expect(client.escalateCalls).toEqual([{ id: "e1", reason: "Responder gave up: stuck" }]);
  });

  it("on + error{timeout} and error{spawn_error,detail} → escalateToHuman with a non-empty failure string", async () => {
    const c1 = new FakeClient();
    c1.listResults = [[mkEscalation("e1")]];
    await responderTick(
      baseDeps(c1, { mode: "on", runner: onRunner({ kind: "error", reason: "timeout", durationMs: 1 }) }),
      createResponderState(),
    );
    expect(c1.escalateCalls).toHaveLength(1);
    expect(c1.escalateCalls[0].id).toBe("e1");
    expect(c1.escalateCalls[0].reason.length).toBeGreaterThan(0);
    expect(c1.escalateCalls[0].reason).toContain("timeout");

    const c2 = new FakeClient();
    c2.listResults = [[mkEscalation("e2")]];
    await responderTick(
      baseDeps(c2, {
        mode: "on",
        runner: onRunner({
          kind: "error",
          reason: "spawn_error",
          detail: "ENOENT",
          durationMs: 1,
        }),
      }),
      createResponderState(),
    );
    expect(c2.escalateCalls).toHaveLength(1);
    expect(c2.escalateCalls[0].reason.length).toBeGreaterThan(0);
    expect(c2.escalateCalls[0].reason).toContain("spawn_error");
    expect(c2.escalateCalls[0].reason).toContain("ENOENT");
  });

  it("shadow + answered → runner.run called but NEITHER answer nor escalateToHuman (P5 seam)", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = onRunner({ kind: "answered", answer: "A", durationMs: 1 });
    await responderTick(baseDeps(client, { mode: "shadow", runner }), createResponderState());
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(client.answer).not.toHaveBeenCalled();
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("on + client.answer throws → loop resolves (no throw escapes), escalation still claimed", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    client.answer = vi.fn(async () => {
      throw new PmApiError(500, "INTERNAL", "boom");
    });
    const runner = onRunner({ kind: "answered", answer: "A", durationMs: 1 });
    const state = createResponderState();
    await expect(
      responderTick(baseDeps(client, { mode: "on", runner }), state),
    ).resolves.toBeUndefined();
    expect(client.answer).toHaveBeenCalledTimes(1);
    expect(state.claimed.has("e1")).toBe(true);
  });

  it("403-on-ack → runner.run NOT called (spawn only after a successful claim)", async () => {
    const client = new FakeClient();
    client.ackError = () => new PmApiError(403, "FORBIDDEN", "held");
    client.listResults = [[mkEscalation("e1")]];
    const runner = onRunner({ kind: "answered", answer: "A", durationMs: 1 });
    await responderTick(baseDeps(client, { mode: "on", runner }), createResponderState());
    expect(runner.run).not.toHaveBeenCalled();
    expect(client.answer).not.toHaveBeenCalled();
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("maxConcurrent=1 + blocking runner → one runner.run in flight at a time", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1"), mkEscalation("e2")]];
    let release!: () => void;
    const runner = new FakeResponderRunner();
    runner.result = { kind: "give_up", reason: "noop", durationMs: 0 };
    runner.gate = new Promise<void>((r) => (release = r));
    const state = createResponderState();
    const tick = responderTick(baseDeps(client, { mode: "shadow", maxConcurrent: 1, runner }), state);
    // The first claim + spawn is in flight (blocked on the gate); the 2nd is
    // gated by the semaphore and never spawns this tick. Flush enough microtasks
    // to clear the awaited acknowledge + getEscalation before runner.run.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(runner.run).toHaveBeenCalledTimes(1);
    release();
    await tick;
    expect(runner.run).toHaveBeenCalledTimes(1); // the 2nd reappears next tick
  });
});
