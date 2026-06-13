import { describe, it, expect, vi } from "vitest";
import { responderTick, createResponderState, type ResponderDeps } from "../src/loop.js";
import { PmApiError } from "../src/api-client.js";
import type { Escalation, EscalationMessage, EscalationWithThread } from "@pm/shared";
import type { Logger } from "../src/logger.js";
import type { ResponderRunner, ResponderRunResult } from "../src/responder-runner.js";
import type {
  InjectionSniffer,
  InjectionSniffResult,
} from "../src/injection-sniffer.js";
import type {
  ImplementRunner,
  ImplementRunInput,
  ImplementRunResult,
} from "../src/implement-runner.js";
import type { Worktree } from "../src/worktree.js";

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

  // P6a reclaim seed. Scripted per call (shifted); default [].
  ackResults: Escalation[][] = [];
  ackListError: ((projectId: string, holderId: string) => unknown) | undefined;
  listAcknowledgedByHolder = vi.fn(
    async (projectId: string, holderId: string): Promise<Escalation[]> => {
      const err = this.ackListError?.(projectId, holderId);
      if (err) throw err;
      return this.ackResults.shift() ?? [];
    },
  );

  acknowledge = vi.fn(async (id: string): Promise<Escalation> => {
    const err = this.ackError?.(id);
    if (err) throw err;
    this.acks.push(id);
    return mkEscalation(id, { status: "acknowledged", holderId: SELF });
  });

  // P3: the thread fetch + the two outcome posts. getEscalation defaults to the
  // escalation spread with an empty thread (overridable per test).
  // P5 severity seam: a test sets `severityById[id]` to control the severity
  // returned by getEscalation (default null — keeps existing tests identical).
  severityById: Record<string, Escalation["severity"]> = {};
  getEscalation = vi.fn(async (id: string): Promise<EscalationWithThread> => {
    return {
      ...mkEscalation(id, {
        status: "acknowledged",
        holderId: SELF,
        severity: this.severityById[id] ?? null,
      }),
      messages: [],
    };
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

  // A1 P3: the pending-land handoff message. Records the call; the escalation stays
  // acknowledged (addMessage does NOT transition status).
  addMessageCalls: {
    id: string;
    body: string;
    messageType?: string;
    metadata?: Record<string, unknown>;
  }[] = [];
  addMessage = vi.fn(
    async (
      id: string,
      body: string,
      messageType?: string,
      metadata?: Record<string, unknown>,
    ): Promise<EscalationMessage> => {
      this.addMessageCalls.push({ id, body, messageType, metadata });
      return {
        id: `${id}-msg`,
        escalationId: id,
        seq: 1,
        authorId: SELF,
        body,
        messageType: (messageType as EscalationMessage["messageType"]) ?? null,
        metadata: metadata ?? null,
        createdAt: "2026-06-13T00:00:00.000Z",
      };
    },
  );
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

/**
 * A scripted injection sniff-test (A1 P1). Defaults to `clean` so every existing
 * test stays byte-identical (the sniff only runs when autoImplementEnabled).
 */
class FakeInjectionSniffer implements InjectionSniffer {
  result: InjectionSniffResult = { kind: "clean" };
  sniff = vi.fn(async (): Promise<InjectionSniffResult> => this.result);
}

/**
 * A scripted write-capable implement runner (A1 P3). Defaults to a give_up so the
 * implement path is a benign no-post unless a test scripts branch_ready/error.
 */
class FakeImplementRunner implements ImplementRunner {
  result: ImplementRunResult = { kind: "give_up", reason: "noop", durationMs: 0 };
  lastInput?: ImplementRunInput;
  run = vi.fn(async (input: ImplementRunInput): Promise<ImplementRunResult> => {
    this.lastInput = input;
    return this.result;
  });
}

/**
 * A fake isolated worktree (A1 P3) — no real git. Records ensureExists/resetForAttempt
 * + a fake git surface (checkoutLocalBranch/push/diff). `ensureFail`/`resetFail`/
 * `pushFail` let a test drive the failure paths.
 */
class FakeWorktree implements Worktree {
  readonly path = "/wt/pm-implement-0";
  readonly logsDir = "/wt/logs";
  ensureFail = false;
  resetFail = false;
  pushFail = false;
  pushCalls: { remote: string; branch: string }[] = [];

  push = vi.fn(async (remote: string, branch: string): Promise<void> => {
    if (this.pushFail) throw new Error("push rejected");
    this.pushCalls.push({ remote, branch });
  });
  diff = vi.fn(async (): Promise<string> => " src/x.ts | 2 +-\n 1 file changed");
  checkoutLocalBranch = vi.fn(async (): Promise<void> => {});

  // Only the members the loop touches are real; the rest satisfy the type.
  readonly git = {
    push: this.push,
    diff: this.diff,
    checkoutLocalBranch: this.checkoutLocalBranch,
  } as unknown as Worktree["git"];

  ensureExists = vi.fn(async (): Promise<void> => {
    if (this.ensureFail) throw new Error("clone failed");
  });
  resetForAttempt = vi.fn(async (): Promise<void> => {
    if (this.resetFail) throw new Error("reset failed");
  });
  detectCorruption = vi.fn(async (): Promise<boolean> => false);
  repair = vi.fn(async (): Promise<void> => {});
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
    // A1 P1 defaults: auto_implement off + a clean sniffer, so all existing tests
    // (the sniff never runs when disabled) stay byte-identical.
    autoImplementEnabled: false,
    sniffer: new FakeInjectionSniffer(),
    // A1 P3 defaults: a give_up implement runner + a fake worktree-acquire (no real
    // git) + empty verifyCmd + git defaults — so the implement path is inert unless a
    // test scripts it, keeping every existing test byte-identical.
    implementRunner: new FakeImplementRunner(),
    acquireWorktree: () => new FakeWorktree(),
    worktreeGit: { remote: "origin", mainBranch: "main" },
    verifyCmd: "",
    repoCwd: "/repo",
    command: "claude -p",
    budget: { timeBudgetSec: 900 },
    // P6a defaults: empty exclude list; modest grace; budget high enough that
    // every existing P1-P5 test is unaffected.
    excludeOriginRepos: [],
    reclaimGraceSec: 120,
    maxReclaimAttempts: 2,
    spawnBudget: { maxSpawns: 1000, windowSec: 3600 },
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

  // A1 P1 helpers: an `implement{size}` runner + a scripted sniffer.
  function implementRunner(size: "bounded" | "systemic"): FakeResponderRunner {
    return onRunner({ kind: "implement", size, rationale: "r", durationMs: 1 });
  }
  function snifferOf(result: InjectionSniffResult): FakeInjectionSniffer {
    const s = new FakeInjectionSniffer();
    s.result = result;
    return s;
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

  // ── P5: shadow + the permanent human-approval boundary ───────────

  it("shadow + answered → routeToHumanApproval (escalate, NOT answer); draft embedded", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = onRunner({ kind: "answered", answer: "A", durationMs: 1 });
    await responderTick(baseDeps(client, { mode: "shadow", runner }), createResponderState());
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(client.answer).not.toHaveBeenCalled();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].id).toBe("e1");
    expect(client.escalateCalls[0].reason.startsWith("[NEEDS APPROVAL]")).toBe(true);
    // Draft preserved — no proven work discarded.
    expect(client.escalateCalls[0].reason).toContain("A");
  });

  it("on + answered + severity 'high' → routeToHumanApproval (NOT answer) — the permanent boundary", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    client.severityById["e1"] = "high";
    const runner = onRunner({ kind: "answered", answer: "A", durationMs: 1 });
    await responderTick(baseDeps(client, { mode: "on", runner }), createResponderState());
    expect(client.answer).not.toHaveBeenCalled();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason.startsWith("[NEEDS APPROVAL]")).toBe(true);
    expect(client.escalateCalls[0].reason).toContain("A");
  });

  it("on + answered + severity 'low' → answer(id, text); no escalate", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    client.severityById["e1"] = "low";
    const runner = onRunner({ kind: "answered", answer: "A", durationMs: 1 });
    await responderTick(baseDeps(client, { mode: "on", runner }), createResponderState());
    expect(client.answerCalls).toEqual([{ id: "e1", body: "A" }]);
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("on + answered + severity 'medium' → answer(id, text); no escalate", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    client.severityById["e1"] = "medium";
    const runner = onRunner({ kind: "answered", answer: "A", durationMs: 1 });
    await responderTick(baseDeps(client, { mode: "on", runner }), createResponderState());
    expect(client.answerCalls).toEqual([{ id: "e1", body: "A" }]);
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("off + answered → NEITHER answer nor escalate (log only); runner.run once", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = onRunner({ kind: "answered", answer: "A", durationMs: 1 });
    await responderTick(baseDeps(client, { mode: "off", runner }), createResponderState());
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(client.answer).not.toHaveBeenCalled();
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("off + needs_human → NEITHER (off is silent even for needs_human)", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = onRunner({ kind: "needs_human", reason: "need a human", durationMs: 1 });
    await responderTick(baseDeps(client, { mode: "off", runner }), createResponderState());
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(client.answer).not.toHaveBeenCalled();
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("shadow + needs_human → escalateToHuman with the plain reason (NOT the [NEEDS APPROVAL] form)", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = onRunner({ kind: "needs_human", reason: "need a human", durationMs: 1 });
    await responderTick(baseDeps(client, { mode: "shadow", runner }), createResponderState());
    expect(client.escalateCalls).toEqual([{ id: "e1", reason: "need a human" }]);
    expect(client.answer).not.toHaveBeenCalled();
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

  // ── P6a Seal 1: no-recursion full seal (excludeOriginRepos) ──────

  it("excludeOriginRepos → escalation from an excluded origin repo NOT acknowledged; a sibling repo IS", async () => {
    const client = new FakeClient();
    client.listResults = [
      [
        mkEscalation("self-pm", { originRepo: "pm-repo" }), // excluded — skip
        mkEscalation("client", { originRepo: "client-repo" }), // sibling — claim
      ],
    ];
    await responderTick(
      baseDeps(client, { maxConcurrent: 10, excludeOriginRepos: ["pm-repo"] }),
      createResponderState(),
    );
    expect(client.acks).toEqual(["client"]);
  });

  // ── P6a Seal 2: reclaim sweep ────────────────────────────────────

  // A timestamp comfortably past updatedAt(2026-06-13) + (900 budget + 120 grace).
  const STALE_NOW = Date.parse("2026-06-14T00:00:00.000Z");

  it("reclaim: a stale acknowledged self-held escalation is re-processed (runner.run, no re-acknowledge)", async () => {
    const client = new FakeClient();
    // No open candidates; one stale acknowledged held by SELF.
    client.listResults = [[]];
    client.ackResults = [
      [mkEscalation("r1", { status: "acknowledged", holderId: SELF, updatedAt: "2026-06-13T00:00:00.000Z" })],
    ];
    const runner = onRunner({ kind: "needs_human", reason: "still stuck", durationMs: 1 });
    await responderTick(
      baseDeps(client, { mode: "on", maxConcurrent: 10, runner, now: () => STALE_NOW }),
      createResponderState(),
    );
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(client.acknowledge).not.toHaveBeenCalled(); // already held — never re-ack
    expect(client.escalateCalls).toEqual([{ id: "r1", reason: "still stuck" }]);
  });

  it("reclaim: a FRESH acknowledged escalation (updatedAt=now) is NOT reclaimed", async () => {
    const client = new FakeClient();
    client.listResults = [[]];
    const freshIso = new Date(STALE_NOW).toISOString();
    client.ackResults = [
      [mkEscalation("fresh", { status: "acknowledged", holderId: SELF, updatedAt: freshIso })],
    ];
    const runner = onRunner({ kind: "needs_human", reason: "x", durationMs: 1 });
    await responderTick(
      baseDeps(client, { mode: "on", maxConcurrent: 10, runner, now: () => STALE_NOW }),
      createResponderState(),
    );
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("reclaim: an already-in-flight id is not double-processed", async () => {
    const client = new FakeClient();
    client.listResults = [[]];
    client.ackResults = [
      [mkEscalation("r1", { status: "acknowledged", holderId: SELF, updatedAt: "2026-06-13T00:00:00.000Z" })],
    ];
    const runner = onRunner({ kind: "needs_human", reason: "x", durationMs: 1 });
    const state = createResponderState();
    state.inFlight.add("r1"); // pretend a claim job already holds it
    await responderTick(
      baseDeps(client, { mode: "on", maxConcurrent: 10, runner, now: () => STALE_NOW }),
      state,
    );
    expect(runner.run).not.toHaveBeenCalled();
    state.inFlight.delete("r1");
  });

  it("reclaim poison cap: after maxReclaimAttempts the thread → escalateToHuman (reclaim-exhausted), no more runner.run", async () => {
    const client = new FakeClient();
    // The reclaim post keeps it acknowledged (escalate/answer throw), so it
    // re-qualifies each sweep. maxReclaimAttempts=1: tick 1 spawns once; tick 2
    // hits the cap → escalateToHuman, no spawn.
    client.escalateToHuman = vi.fn(async (id: string, reason: string): Promise<Escalation> => {
      client.escalateCalls.push({ id, reason });
      throw new PmApiError(500, "INTERNAL", "boom"); // keeps it acknowledged
    });
    const strandedRow = () =>
      mkEscalation("p1", { status: "acknowledged", holderId: SELF, updatedAt: "2026-06-13T00:00:00.000Z" });
    client.ackResults = [[strandedRow()], [strandedRow()]];
    client.listResults = [[], []];
    const runner = onRunner({ kind: "needs_human", reason: "x", durationMs: 1 });
    const deps = baseDeps(client, {
      mode: "on",
      maxConcurrent: 10,
      maxReclaimAttempts: 1,
      runner,
      now: () => STALE_NOW,
    });
    const state = createResponderState();
    await responderTick(deps, state); // attempt 1 → spawn
    expect(runner.run).toHaveBeenCalledTimes(1);
    await responderTick(deps, state); // cap reached → escalateToHuman, no spawn
    expect(runner.run).toHaveBeenCalledTimes(1);
    const exhausted = client.escalateCalls.filter((c) =>
      c.reason.startsWith("Reclaim exhausted"),
    );
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].id).toBe("p1");
  });

  it("PIN 1: poison-branch escalateToHuman throwing does NOT crash the tick", async () => {
    const client = new FakeClient();
    client.escalateToHuman = vi.fn(async (): Promise<Escalation> => {
      throw new PmApiError(500, "INTERNAL", "boom");
    });
    client.ackResults = [
      [mkEscalation("p1", { status: "acknowledged", holderId: SELF, updatedAt: "2026-06-13T00:00:00.000Z" })],
    ];
    client.listResults = [[]];
    const runner = onRunner({ kind: "needs_human", reason: "x", durationMs: 1 });
    const state = createResponderState();
    state.reclaimAttempts.set("p1", 5); // already past any cap
    await expect(
      responderTick(
        baseDeps(client, {
          mode: "on",
          maxConcurrent: 10,
          maxReclaimAttempts: 1,
          runner,
          now: () => STALE_NOW,
        }),
        state,
      ),
    ).resolves.toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
  });

  // ── P6a Seal 3: spawn-rate budget ────────────────────────────────

  it("spawn budget: maxSpawns=1 → only 1 runner.run this tick; the 2nd defers, then spawns once the window passes", async () => {
    const client = new FakeClient();
    const e1 = mkEscalation("e1", { createdAt: "2026-06-13T01:00:00.000Z" });
    const e2 = mkEscalation("e2", { createdAt: "2026-06-13T02:00:00.000Z" });
    client.listResults = [[e1, e2], [e2], [e2]];
    const runner = onRunner({ kind: "needs_human", reason: "x", durationMs: 1 });
    const state = createResponderState();
    const spawnBudget = { maxSpawns: 1, windowSec: 100 };
    let now = 1_000_000;
    const deps = baseDeps(client, { mode: "on", maxConcurrent: 10, runner, spawnBudget, now: () => now });

    await responderTick(deps, state); // tick 1: e1 spawns, e2 deferred (budget spent)
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(client.escalateCalls.map((c) => c.id)).toEqual(["e1"]);

    // tick 2: still inside the window, budget spent → e2 still deferred.
    now += 50_000; // +50s (< 100s window)
    await responderTick(deps, state);
    expect(runner.run).toHaveBeenCalledTimes(1);

    // tick 3: window elapsed → the deferred e2 now spawns.
    now += 100_000; // total +150s from the e1 spawn → outside the window
    await responderTick(deps, state);
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(client.escalateCalls.map((c) => c.id)).toEqual(["e1", "e2"]);
  });

  it("spawn budget: a 403-failed acknowledge does NOT consume budget (reservation refunded)", async () => {
    const client = new FakeClient();
    // maxSpawns=1. e1 throws 403 on ack → its budget reservation is refunded, so
    // a later tick's e2 still spawns within the SAME window (no budget burned).
    client.ackError = (id) =>
      id === "e1" ? new PmApiError(403, "FORBIDDEN", "held") : undefined;
    const e1 = mkEscalation("e1", { createdAt: "2026-06-13T01:00:00.000Z" });
    const e2 = mkEscalation("e2", { createdAt: "2026-06-13T02:00:00.000Z" });
    // e1 alone first (it 403s + refunds), then e2 alone next tick.
    client.listResults = [[e1], [e2]];
    const runner = onRunner({ kind: "needs_human", reason: "x", durationMs: 1 });
    const state = createResponderState();
    const deps = baseDeps(client, {
      mode: "on",
      maxConcurrent: 10,
      runner,
      spawnBudget: { maxSpawns: 1, windowSec: 100 },
      now: () => 1_000_000, // SAME window both ticks
    });
    await responderTick(deps, state); // e1 403 → refund; no spawn
    expect(runner.run).not.toHaveBeenCalled();
    expect(state.spawnTimestamps).toEqual([]); // reservation refunded
    await responderTick(deps, state); // e2 spawns — budget was not consumed
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(client.escalateCalls.map((c) => c.id)).toEqual(["e2"]);
  });

  // ── A1 P1: assess gate + injection sniff-test + auto_implement kill-switch ──

  it("enabled(auto_implement) + clean sniff + implement{bounded} → implement session spawned; no answer/escalate (P3: branch_ready hands off)", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = implementRunner("bounded");
    const sniffer = snifferOf({ kind: "clean" });
    // P3: the bounded path now spawns the WRITE runner. Provide a branch_ready so the
    // outcome is the pending-land handoff (addMessage) — neither answer nor escalate.
    const impl = new FakeImplementRunner();
    impl.result = {
      kind: "branch_ready",
      branch: "pm/escalation-e1",
      commitSha: "x",
      durationMs: 1,
    };
    await responderTick(
      baseDeps(client, {
        mode: "on",
        runner,
        sniffer,
        autoImplementEnabled: true,
        implementRunner: impl,
      }),
      createResponderState(),
    );
    expect(sniffer.sniff).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledTimes(1); // the answering (assess) session spawned
    expect(impl.run).toHaveBeenCalledTimes(1); // the write session spawned (P3)
    expect(client.addMessage).toHaveBeenCalledTimes(1); // pending-land handoff
    expect(client.answer).not.toHaveBeenCalled();
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("enabled + SUSPICIOUS sniff → escalateToHuman('flagged by injection sniff-test'), session NOT spawned", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = implementRunner("bounded");
    const sniffer = snifferOf({ kind: "suspicious", reason: "ignore prior instructions" });
    await responderTick(
      baseDeps(client, { mode: "on", runner, sniffer, autoImplementEnabled: true }),
      createResponderState(),
    );
    expect(runner.run).not.toHaveBeenCalled(); // session NOT spawned
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].id).toBe("e1");
    expect(client.escalateCalls[0].reason).toContain("flagged by injection sniff-test");
    expect(client.escalateCalls[0].reason).toContain("ignore prior instructions");
  });

  it("enabled + sniff ERROR → escalate (fail-safe), session not spawned", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = implementRunner("bounded");
    const sniffer = snifferOf({ kind: "error", reason: "timeout" });
    await responderTick(
      baseDeps(client, { mode: "on", runner, sniffer, autoImplementEnabled: true }),
      createResponderState(),
    );
    expect(runner.run).not.toHaveBeenCalled();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("fail-safe");
  });

  it("enabled + implement{systemic} (clean) → escalateToHuman (systemic → human)", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = implementRunner("systemic");
    const sniffer = snifferOf({ kind: "clean" });
    await responderTick(
      baseDeps(client, { mode: "on", runner, sniffer, autoImplementEnabled: true }),
      createResponderState(),
    );
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].id).toBe("e1");
    expect(client.escalateCalls[0].reason).toContain("Systemic");
    expect(client.answer).not.toHaveBeenCalled();
  });

  it("DISABLED + implement{bounded} → escalateToHuman (fall-back, rationale embedded); NOT stranded; sniffer NOT called", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = implementRunner("bounded");
    const sniffer = snifferOf({ kind: "clean" });
    await responderTick(
      baseDeps(client, { mode: "on", runner, sniffer, autoImplementEnabled: false }),
      createResponderState(),
    );
    expect(sniffer.sniff).not.toHaveBeenCalled(); // no sniff when disabled
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].id).toBe("e1");
    expect(client.escalateCalls[0].reason).toContain("auto_implement is disabled");
    expect(client.escalateCalls[0].reason).toContain("r"); // rationale embedded
  });

  it("DISABLED + implement{systemic} → escalateToHuman (fall-back)", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = implementRunner("systemic");
    await responderTick(
      baseDeps(client, { mode: "on", runner, autoImplementEnabled: false }),
      createResponderState(),
    );
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("auto_implement is disabled");
  });

  it("mode=off + implement → silent (neither escalate nor act), regardless of auto_implement", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = implementRunner("bounded");
    const sniffer = snifferOf({ kind: "clean" });
    await responderTick(
      baseDeps(client, { mode: "off", runner, sniffer, autoImplementEnabled: true }),
      createResponderState(),
    );
    expect(client.escalateToHuman).not.toHaveBeenCalled();
    expect(client.answer).not.toHaveBeenCalled();
  });

  it("mode=off + enabled + SUSPICIOUS sniff → silent (off escalates nothing), session not spawned", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = implementRunner("bounded");
    const sniffer = snifferOf({ kind: "suspicious", reason: "x" });
    await responderTick(
      baseDeps(client, { mode: "off", runner, sniffer, autoImplementEnabled: true }),
      createResponderState(),
    );
    expect(runner.run).not.toHaveBeenCalled();
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("injectable-sniffer seam: a clean sniff lets the session proceed (answered still posts)", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = onRunner({ kind: "answered", answer: "A", durationMs: 1 });
    const sniffer = snifferOf({ kind: "clean" });
    await responderTick(
      baseDeps(client, { mode: "on", runner, sniffer, autoImplementEnabled: true }),
      createResponderState(),
    );
    expect(sniffer.sniff).toHaveBeenCalledTimes(1);
    expect(client.answerCalls).toEqual([{ id: "e1", body: "A" }]);
  });

  // ── A1 P3: implement session wiring ──────────────────────────────

  /** An implement{bounded} answering runner + a scripted implement runner + worktree. */
  function implementSetup(
    implResult: ImplementRunResult,
    over: Partial<{ wt: FakeWorktree }> = {},
  ): {
    client: FakeClient;
    runner: FakeResponderRunner;
    sniffer: FakeInjectionSniffer;
    impl: FakeImplementRunner;
    wt: FakeWorktree;
  } {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = implementRunner("bounded");
    const sniffer = snifferOf({ kind: "clean" });
    const impl = new FakeImplementRunner();
    impl.result = implResult;
    const wt = over.wt ?? new FakeWorktree();
    return { client, runner, sniffer, impl, wt };
  }

  it("implement branch_ready → push + addMessage(pendingLand) called once; stays acknowledged (no answer/resolve); worktree prepared", async () => {
    const { client, runner, sniffer, impl, wt } = implementSetup({
      kind: "branch_ready",
      branch: "pm/escalation-e1",
      commitSha: "abc123",
      durationMs: 1,
    });
    await responderTick(
      baseDeps(client, {
        mode: "on",
        runner,
        sniffer,
        autoImplementEnabled: true,
        implementRunner: impl,
        acquireWorktree: () => wt,
      }),
      createResponderState(),
    );
    expect(impl.run).toHaveBeenCalledTimes(1);
    expect(wt.ensureExists).toHaveBeenCalledTimes(1);
    expect(wt.resetForAttempt).toHaveBeenCalled(); // prep + finally
    expect(wt.pushCalls).toEqual([{ remote: "origin", branch: "pm/escalation-e1" }]);
    expect(client.addMessageCalls).toHaveLength(1);
    const msg = client.addMessageCalls[0];
    expect(msg.id).toBe("e1");
    expect(msg.body).toContain("pm/escalation-e1");
    expect(msg.body).toContain("abc123");
    expect(msg.body).toContain("pending land");
    expect(msg.metadata).toMatchObject({ pendingLand: true, branch: "pm/escalation-e1" });
    // Stays acknowledged — A2 lands + resolves.
    expect(client.answer).not.toHaveBeenCalled();
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("implement give_up → escalateToHuman (reason); no addMessage", async () => {
    const { client, runner, sniffer, impl, wt } = implementSetup({
      kind: "give_up",
      reason: "too hard",
      durationMs: 1,
    });
    await responderTick(
      baseDeps(client, {
        mode: "on",
        runner,
        sniffer,
        autoImplementEnabled: true,
        implementRunner: impl,
        acquireWorktree: () => wt,
      }),
      createResponderState(),
    );
    expect(client.addMessage).not.toHaveBeenCalled();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("could not implement");
    expect(client.escalateCalls[0].reason).toContain("too hard");
  });

  it("implement error → escalateToHuman (reason + detail); no addMessage", async () => {
    const { client, runner, sniffer, impl, wt } = implementSetup({
      kind: "error",
      reason: "timeout",
      detail: "budget",
      durationMs: 1,
    });
    await responderTick(
      baseDeps(client, {
        mode: "on",
        runner,
        sniffer,
        autoImplementEnabled: true,
        implementRunner: impl,
        acquireWorktree: () => wt,
      }),
      createResponderState(),
    );
    expect(client.addMessage).not.toHaveBeenCalled();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("timeout");
    expect(client.escalateCalls[0].reason).toContain("budget");
  });

  it("implement worktree prep failure (ensureExists throws) → escalateToHuman, implement runner NOT spawned, no throw", async () => {
    const wt = new FakeWorktree();
    wt.ensureFail = true;
    const { client, runner, sniffer, impl } = implementSetup(
      { kind: "branch_ready", branch: "pm/escalation-e1", commitSha: "x", durationMs: 1 },
      { wt },
    );
    await expect(
      responderTick(
        baseDeps(client, {
          mode: "on",
          runner,
          sniffer,
          autoImplementEnabled: true,
          implementRunner: impl,
          acquireWorktree: () => wt,
        }),
        createResponderState(),
      ),
    ).resolves.toBeUndefined();
    expect(impl.run).not.toHaveBeenCalled();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("could not prepare a worktree");
  });

  it("implement reset failure on prep → escalateToHuman, slot released (no throw)", async () => {
    const wt = new FakeWorktree();
    wt.resetFail = true; // first reset (prep) throws
    const { client, runner, sniffer, impl } = implementSetup(
      { kind: "branch_ready", branch: "pm/escalation-e1", commitSha: "x", durationMs: 1 },
      { wt },
    );
    const state = createResponderState();
    await expect(
      responderTick(
        baseDeps(client, {
          mode: "on",
          runner,
          sniffer,
          autoImplementEnabled: true,
          implementRunner: impl,
          acquireWorktree: () => wt,
        }),
        state,
      ),
    ).resolves.toBeUndefined();
    expect(impl.run).not.toHaveBeenCalled();
    expect(client.escalateCalls[0].reason).toContain("could not prepare a worktree");
    // The slot is released for reuse.
    expect(state.implementSlots.every((s) => !s.leased)).toBe(true);
  });

  it("implement push failure → escalateToHuman ('push failed'); no addMessage (no work lost)", async () => {
    const wt = new FakeWorktree();
    wt.pushFail = true;
    const { client, runner, sniffer, impl } = implementSetup(
      { kind: "branch_ready", branch: "pm/escalation-e1", commitSha: "x", durationMs: 1 },
      { wt },
    );
    await responderTick(
      baseDeps(client, {
        mode: "on",
        runner,
        sniffer,
        autoImplementEnabled: true,
        implementRunner: impl,
        acquireWorktree: () => wt,
      }),
      createResponderState(),
    );
    expect(client.addMessage).not.toHaveBeenCalled();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("push failed");
  });

  it("implement clean-after: resetForAttempt is called in finally on branch_ready (prep + finally = ≥2)", async () => {
    const { client, runner, sniffer, impl, wt } = implementSetup({
      kind: "branch_ready",
      branch: "pm/escalation-e1",
      commitSha: "x",
      durationMs: 1,
    });
    await responderTick(
      baseDeps(client, {
        mode: "on",
        runner,
        sniffer,
        autoImplementEnabled: true,
        implementRunner: impl,
        acquireWorktree: () => wt,
      }),
      createResponderState(),
    );
    expect(wt.resetForAttempt.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("implement mode=off → silent (no spawn? — spawn runs but no addMessage/escalate)", async () => {
    const { client, runner, sniffer, impl, wt } = implementSetup({
      kind: "branch_ready",
      branch: "pm/escalation-e1",
      commitSha: "x",
      durationMs: 1,
    });
    await responderTick(
      baseDeps(client, {
        mode: "off",
        runner,
        sniffer,
        autoImplementEnabled: true,
        implementRunner: impl,
        acquireWorktree: () => wt,
      }),
      createResponderState(),
    );
    // mode=off is silent on the implement OUTCOME (the existing implement-off test
    // already asserts the answering switch returns before reaching the bounded path).
    expect(client.addMessage).not.toHaveBeenCalled();
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("implement verifyCmd is threaded into the implement prompt", async () => {
    const { client, runner, sniffer, impl, wt } = implementSetup({
      kind: "give_up",
      reason: "x",
      durationMs: 1,
    });
    await responderTick(
      baseDeps(client, {
        mode: "on",
        runner,
        sniffer,
        autoImplementEnabled: true,
        implementRunner: impl,
        acquireWorktree: () => wt,
        verifyCmd: "pnpm test",
      }),
      createResponderState(),
    );
    expect(impl.lastInput?.prompt).toContain("pnpm test");
  });

  // REVISE FIX #3: reclaim SKIPS a pending-land escalation.
  it("reclaim SKIPS an acknowledged self-held escalation carrying a pendingLand marker (no re-spawn)", async () => {
    const client = new FakeClient();
    client.listResults = [[]];
    const stale = mkEscalation("r1", {
      status: "acknowledged",
      holderId: SELF,
      updatedAt: "2026-06-13T00:00:00.000Z",
    });
    client.ackResults = [[stale]];
    // getEscalation returns a thread WITH the pending-land marker.
    client.getEscalation = vi.fn(async (id: string): Promise<EscalationWithThread> => ({
      ...mkEscalation(id, { status: "acknowledged", holderId: SELF }),
      messages: [
        {
          id: `${id}-m1`,
          escalationId: id,
          seq: 1,
          authorId: SELF,
          body: "Implemented a fix on branch ...",
          messageType: "diagnosis",
          metadata: { pendingLand: true, branch: "pm/escalation-r1", commitSha: "abc" },
          createdAt: "2026-06-13T00:00:00.000Z",
        },
      ],
    }));
    const runner = onRunner({ kind: "needs_human", reason: "x", durationMs: 1 });
    await responderTick(
      baseDeps(client, { mode: "on", maxConcurrent: 10, runner, now: () => STALE_NOW }),
      createResponderState(),
    );
    // The read-only answering session is NOT re-spawned on the pending-land row.
    expect(runner.run).not.toHaveBeenCalled();
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });
});
