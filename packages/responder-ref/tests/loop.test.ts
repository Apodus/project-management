import { describe, it, expect, vi } from "vitest";
import {
  responderTick,
  createResponderState,
  pathsOutsideAllowlist,
  type ResponderDeps,
} from "../src/loop.js";
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
import type {
  DriveRunner,
  DriveRunInput,
  DriveRunResult,
} from "../src/drive-runner.js";
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

  resolveCalls: { id: string; reason: string }[] = [];
  resolve = vi.fn(async (id: string, reason: string): Promise<Escalation> => {
    this.resolveCalls.push({ id, reason });
    return mkEscalation(id, { status: "resolved", holderId: SELF });
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

  // A2 P1: the responder submits a task-less, escalationId-linked merge request
  // over HTTP on branch_ready. Records the call; returns a narrow MR view.
  // `submitFail` drives the submit-failure escalation path.
  submitFail = false;
  submitMergeRequestCalls: { projectId: string; body: Record<string, unknown> }[] = [];
  submitMergeRequest = vi.fn(
    async (
      projectId: string,
      body: Record<string, unknown>,
    ): Promise<{ id: string; branch: string | null; commitSha: string | null }> => {
      if (this.submitFail) throw new Error("submit rejected");
      this.submitMergeRequestCalls.push({ projectId, body });
      return {
        id: "mr1",
        branch: (body.branch as string | null) ?? null,
        commitSha: (body.commitSha as string | null) ?? null,
      };
    },
  );

  // A3 P1: the drive session's PM write-back — the LOOP creates the epic + tasks over
  // HTTP from the drive result. `createEpicFail`/`createTaskFail` drive the failure +
  // partial-failure paths; createTask returns a fresh id per call (task-1, task-2, …).
  createEpicFail = false;
  createTaskFail = false;
  createEpicCalls: { projectId: string; body: Record<string, unknown> }[] = [];
  createTaskCalls: { projectId: string; body: Record<string, unknown> }[] = [];
  private taskSeq = 0;
  createEpic = vi.fn(
    async (
      projectId: string,
      body: Record<string, unknown>,
    ): Promise<{ id: string; name?: string }> => {
      if (this.createEpicFail) throw new Error("epic create rejected");
      this.createEpicCalls.push({ projectId, body });
      return { id: "epic1", name: body.name as string | undefined };
    },
  );
  createTask = vi.fn(
    async (projectId: string, body: Record<string, unknown>): Promise<{ id: string }> => {
      if (this.createTaskFail) throw new Error("task create rejected");
      this.createTaskCalls.push({ projectId, body });
      this.taskSeq += 1;
      return { id: `task-${this.taskSeq}` };
    },
  );

  // A3 P2: the arc orchestrator reads arc state from the server.
  // `epicResult` is the epic + its campaign-tasks (advanceArc's getEpic).
  // `mrResults` is scripted PER CALL (shifted) — each cycle's listMergeRequests
  // returns the next phase-MR snapshot (so a test can advance the arc tick-by-tick).
  epicResult: { id: string; name: string; tasks: { id: string; title: string; description: string | null }[] } = {
    id: "epic1",
    name: "E",
    tasks: [],
  };
  getEpicCalls: { projectId: string; epicId: string }[] = [];
  getEpic = vi.fn(
    async (
      projectId: string,
      epicId: string,
    ): Promise<{ id: string; name: string; tasks: { id: string; title: string; description: string | null }[] }> => {
      this.getEpicCalls.push({ projectId, epicId });
      return this.epicResult;
    },
  );

  // `enqueuedAt`/`createdAt` (A4 P3) are OPTIONAL in the scripted literal — they
  // default-fill to a RECENT timestamp at return so every pre-P3 test (which omits
  // them) reads as a fresh, non-stalled MR (byte-identical). A stall test sets a
  // deliberately stale `enqueuedAt`; a fail-safe test sets a garbage one.
  mrResults: {
    id: string;
    taskId: string | null;
    escalationId: string | null;
    status: string;
    landedSha: string | null;
    branch: string | null;
    commitSha: string | null;
    enqueuedAt?: string;
    createdAt?: string;
  }[][] = [];
  listMergeRequestsCalls: { projectId: string; params: Record<string, unknown> }[] = [];
  listMergeRequests = vi.fn(
    async (
      projectId: string,
      params: Record<string, unknown> = {},
    ): Promise<
      {
        id: string;
        taskId: string | null;
        escalationId: string | null;
        status: string;
        landedSha: string | null;
        branch: string | null;
        commitSha: string | null;
        enqueuedAt: string;
        createdAt: string;
      }[]
    > => {
      this.listMergeRequestsCalls.push({ projectId, params });
      const fresh = new Date().toISOString();
      return (this.mrResults.shift() ?? []).map((m) => ({
        ...m,
        enqueuedAt: m.enqueuedAt ?? fresh,
        createdAt: m.createdAt ?? fresh,
      }));
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
 * A scripted vision-producing drive runner (A3 P1). Defaults to a give_up so the
 * drive path is a benign no-post unless a test scripts vision_ready/error. Records
 * the last input for prompt/worktree assertions.
 */
class FakeDriveRunner implements DriveRunner {
  result: DriveRunResult = { kind: "give_up", reason: "noop", durationMs: 0 };
  lastInput?: DriveRunInput;
  run = vi.fn(async (input: DriveRunInput): Promise<DriveRunResult> => {
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
  // A1 P4: the paths the `--name-only` diff reports as touched. Default a single
  // package src path so the (empty-allowlist) existing tests proceed unchanged.
  touchedPaths: string[] = ["packages/responder-ref/src/foo.ts"];
  // A1 P4: set to throw on the `--name-only` diff (the allowlist fail-safe path).
  nameOnlyDiffFail = false;

  push = vi.fn(async (remote: string, branch: string): Promise<void> => {
    if (this.pushFail) throw new Error("push rejected");
    this.pushCalls.push({ remote, branch });
  });
  // Discriminate the two diff invocations: `--name-only` (the P4 allowlist path
  // list) vs `--stat` (the advisory summary). args[0] selects.
  diff = vi.fn(async (args: string[]): Promise<string> => {
    if (args[0] === "--name-only") {
      if (this.nameOnlyDiffFail) throw new Error("diff failed");
      return this.touchedPaths.join("\n");
    }
    return " src/x.ts | 2 +-\n 1 file changed";
  });
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
    // A3 P1 default: a give_up drive runner — the systemic drive path is inert unless
    // a test scripts vision_ready/error, keeping every existing test byte-identical.
    driveRunner: new FakeDriveRunner(),
    acquireWorktree: () => new FakeWorktree(),
    // A1 P4: empty allowlist by default = no restriction (every existing implement
    // test proceeds unchanged).
    worktreeGit: { remote: "origin", mainBranch: "main", allowedPaths: [] },
    verifyCmd: "",
    // A4 P1: GENEROUS budget defaults so every existing A1-A3 test stays
    // byte-identical (the caps never bite at default).
    maxConcurrentArcs: 100,
    maxArcDurationSec: 604800,
    // A4 P3: GENEROUS 24h stall window so every existing A1-A4P2 test stays
    // byte-identical (a wedged-MR reclaim never bites at default).
    stallTimeoutSec: 86400,
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

  /** An implement{systemic} answering runner + a scripted drive runner. */
  function driveSetup(driveResult: DriveRunResult): {
    client: FakeClient;
    runner: FakeResponderRunner;
    sniffer: FakeInjectionSniffer;
    drive: FakeDriveRunner;
    wt: FakeWorktree;
  } {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = implementRunner("systemic");
    const sniffer = snifferOf({ kind: "clean" });
    const drive = new FakeDriveRunner();
    drive.result = driveResult;
    const wt = new FakeWorktree();
    return { client, runner, sniffer, drive, wt };
  }

  it("enabled + implement{systemic} (clean) → drive: vision_ready creates epic + tasks + pendingDrive handoff (no escalate)", async () => {
    const { client, runner, sniffer, drive, wt } = driveSetup({
      kind: "vision_ready",
      visionPath: "roadmaps/v.md",
      epicName: "E",
      campaigns: [{ title: "C1", priority: "high", description: "d" }],
      durationMs: 1,
    });
    await responderTick(
      baseDeps(client, {
        mode: "on",
        runner,
        sniffer,
        autoImplementEnabled: true,
        driveRunner: drive,
        acquireWorktree: () => wt,
      }),
      createResponderState(),
    );
    expect(runner.run).toHaveBeenCalledTimes(1); // the answering (assess) session
    expect(drive.run).toHaveBeenCalledTimes(1); // the drive session
    // The LOOP did the PM write-back over HTTP.
    expect(client.createEpic).toHaveBeenCalledTimes(1);
    expect(client.createEpicCalls[0].projectId).toBe("p");
    expect(client.createEpicCalls[0].body).toMatchObject({ name: "E" });
    expect(client.createTask).toHaveBeenCalledTimes(1);
    expect(client.createTaskCalls[0].body).toMatchObject({
      title: "C1",
      epicId: "epic1",
      priority: "high",
    });
    // A3 P3: an EARLY pre-epic intent marker (pendingDrive, NO epicId) is written
    // BEFORE createEpic, then the terminal epicId-bearing handoff after the tasks.
    expect(client.addMessageCalls).toHaveLength(2);
    const intent = client.addMessageCalls[0];
    expect(intent.metadata).toMatchObject({ pendingDrive: true, visionPath: "roadmaps/v.md" });
    expect(intent.metadata?.epicId).toBeUndefined();
    const msg = client.addMessageCalls[1];
    expect(msg.metadata).toMatchObject({
      pendingDrive: true,
      visionPath: "roadmaps/v.md",
      epicId: "epic1",
    });
    expect(client.escalateToHuman).not.toHaveBeenCalled();
    expect(client.answer).not.toHaveBeenCalled();
  });

  it("enabled + implement{systemic} + drive give_up → escalateToHuman (no epic/tasks created)", async () => {
    const { client, runner, sniffer, drive, wt } = driveSetup({
      kind: "give_up",
      reason: "too vague",
      durationMs: 1,
    });
    await responderTick(
      baseDeps(client, {
        mode: "on",
        runner,
        sniffer,
        autoImplementEnabled: true,
        driveRunner: drive,
        acquireWorktree: () => wt,
      }),
      createResponderState(),
    );
    expect(client.createEpic).not.toHaveBeenCalled();
    expect(client.createTask).not.toHaveBeenCalled();
    expect(client.addMessage).not.toHaveBeenCalled();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("could not produce a vision");
  });

  it("enabled + implement{systemic} + drive error → escalateToHuman (no epic/tasks created)", async () => {
    const { client, runner, sniffer, drive, wt } = driveSetup({
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
        driveRunner: drive,
        acquireWorktree: () => wt,
      }),
      createResponderState(),
    );
    expect(client.createEpic).not.toHaveBeenCalled();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("timeout");
    expect(client.escalateCalls[0].reason).toContain("budget");
  });

  it("enabled + implement{systemic} + vision_ready but createTask fails mid-loop → escalateToHuman naming the epic id; no throw escapes", async () => {
    const { client, runner, sniffer, drive, wt } = driveSetup({
      kind: "vision_ready",
      visionPath: "roadmaps/v.md",
      epicName: "E",
      campaigns: [
        { title: "C1", priority: "high", description: "d1" },
        { title: "C2", priority: "medium", description: "d2" },
      ],
      durationMs: 1,
    });
    client.createTaskFail = true; // both task POSTs throw
    await expect(
      responderTick(
        baseDeps(client, {
          mode: "on",
          runner,
          sniffer,
          autoImplementEnabled: true,
          driveRunner: drive,
          acquireWorktree: () => wt,
        }),
        createResponderState(),
      ),
    ).resolves.toBeUndefined();
    // The epic was created (and persists — findable); the first task POST failed.
    expect(client.createEpic).toHaveBeenCalledTimes(1);
    // A3 P3: the EARLY intent marker (no epicId) is written before createEpic, so it
    // IS present — but the TERMINAL epicId-bearing handoff is NOT (the task POST failed
    // before it). Exactly one addMessage, the pre-epic intent marker.
    expect(client.addMessageCalls).toHaveLength(1);
    expect(client.addMessageCalls[0].metadata).toMatchObject({ pendingDrive: true });
    expect(client.addMessageCalls[0].metadata?.epicId).toBeUndefined();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("epic1"); // orphan epic id named
    expect(client.escalateCalls[0].reason).toContain("C1"); // the failed campaign named
  });

  it("mode=off + implement{systemic} (enabled) → silent: no epic/tasks/addMessage/escalate", async () => {
    const { client, runner, sniffer, drive, wt } = driveSetup({
      kind: "vision_ready",
      visionPath: "roadmaps/v.md",
      epicName: "E",
      campaigns: [{ title: "C1", priority: "high", description: "d" }],
      durationMs: 1,
    });
    await responderTick(
      baseDeps(client, {
        mode: "off",
        runner,
        sniffer,
        autoImplementEnabled: true,
        driveRunner: drive,
        acquireWorktree: () => wt,
      }),
      createResponderState(),
    );
    // mode=off short-circuits the implement switch BEFORE the systemic branch — the
    // drive never runs and nothing is posted.
    expect(client.createEpic).not.toHaveBeenCalled();
    expect(client.createTask).not.toHaveBeenCalled();
    expect(client.addMessage).not.toHaveBeenCalled();
    expect(client.escalateToHuman).not.toHaveBeenCalled();
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

  it("DISABLED + implement{systemic} → escalateToHuman (fall-back); driveRunner.run NOT called", async () => {
    const client = new FakeClient();
    client.listResults = [[mkEscalation("e1")]];
    const runner = implementRunner("systemic");
    const drive = new FakeDriveRunner();
    await responderTick(
      baseDeps(client, { mode: "on", runner, autoImplementEnabled: false, driveRunner: drive }),
      createResponderState(),
    );
    expect(drive.run).not.toHaveBeenCalled(); // disabled → no drive
    expect(client.createEpic).not.toHaveBeenCalled();
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
    // A2 P1: a task-less, escalationId-linked merge request submitted once.
    expect(client.submitMergeRequest).toHaveBeenCalledTimes(1);
    expect(client.submitMergeRequestCalls).toHaveLength(1);
    expect(client.submitMergeRequestCalls[0].projectId).toBe("p");
    expect(client.submitMergeRequestCalls[0].body).toMatchObject({
      resource: "main",
      taskId: null,
      branch: "pm/escalation-e1",
      commitSha: "abc123",
      escalationId: "e1",
    });
    expect(client.addMessageCalls).toHaveLength(1);
    const msg = client.addMessageCalls[0];
    expect(msg.id).toBe("e1");
    expect(msg.body).toContain("pm/escalation-e1");
    expect(msg.body).toContain("mr1");
    expect(msg.body).toContain("abc123");
    expect(msg.body).toContain("pending land");
    // pendingLand:true preserved (reclaim-skip byte-identical); MR id augmented.
    expect(msg.metadata).toMatchObject({
      pendingLand: true,
      mergeRequestId: "mr1",
      branch: "pm/escalation-e1",
      commitSha: "abc123",
    });
    // Stays acknowledged — A2 lands + resolves.
    expect(client.answer).not.toHaveBeenCalled();
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("implement branch_ready + submit failure → escalateToHuman ('submit failed'); no addMessage; branch preserved", async () => {
    const { client, runner, sniffer, impl, wt } = implementSetup({
      kind: "branch_ready",
      branch: "pm/escalation-e1",
      commitSha: "abc123",
      durationMs: 1,
    });
    client.submitFail = true;
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
    // Pushed (work preserved) but the submit failed → escalate, no addMessage.
    expect(wt.pushCalls).toEqual([{ remote: "origin", branch: "pm/escalation-e1" }]);
    expect(client.addMessage).not.toHaveBeenCalled();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("merge-request submit failed");
    expect(client.escalateCalls[0].reason).toContain("pm/escalation-e1");
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
    // A2 P1: mode=off never submits the merge request (the submit sits after the
    // mode=off break; off short-circuits before it).
    expect(client.submitMergeRequest).not.toHaveBeenCalled();
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

  // ── A1 P4: coarse blast-radius allowlist ─────────────────────────

  it("allowlist: branch_ready with all touched paths INSIDE allowed_paths → push + addMessage (no escalate)", async () => {
    const wt = new FakeWorktree();
    wt.touchedPaths = ["packages/responder-ref/src/foo.ts", "packages/server/src/bar.ts"];
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
        worktreeGit: { remote: "origin", mainBranch: "main", allowedPaths: ["packages/"] },
      }),
      createResponderState(),
    );
    expect(wt.pushCalls).toEqual([{ remote: "origin", branch: "pm/escalation-e1" }]);
    expect(client.addMessageCalls).toHaveLength(1);
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("allowlist: branch_ready with a path OUTSIDE allowed_paths → escalate (reason names the path), NOT pushed, no addMessage", async () => {
    const wt = new FakeWorktree();
    wt.touchedPaths = ["packages/responder-ref/src/foo.ts", "infra/secrets.ts"];
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
        worktreeGit: { remote: "origin", mainBranch: "main", allowedPaths: ["packages/"] },
      }),
      createResponderState(),
    );
    expect(wt.pushCalls).toEqual([]);
    expect(client.addMessage).not.toHaveBeenCalled();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("outside the allowed set");
    expect(client.escalateCalls[0].reason).toContain("infra/secrets.ts");
  });

  it("allowlist: empty allowed_paths → NO restriction (out-of-package path still pushes)", async () => {
    const wt = new FakeWorktree();
    wt.touchedPaths = ["infra/secrets.ts"];
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
        worktreeGit: { remote: "origin", mainBranch: "main", allowedPaths: [] },
      }),
      createResponderState(),
    );
    expect(wt.pushCalls).toEqual([{ remote: "origin", branch: "pm/escalation-e1" }]);
    expect(client.addMessageCalls).toHaveLength(1);
    expect(client.escalateToHuman).not.toHaveBeenCalled();
  });

  it("allowlist: diff-check error (the --name-only diff throws) → escalate (fail-safe), NOT pushed", async () => {
    const wt = new FakeWorktree();
    wt.nameOnlyDiffFail = true;
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
        worktreeGit: { remote: "origin", mainBranch: "main", allowedPaths: ["packages/"] },
      }),
      createResponderState(),
    );
    expect(wt.pushCalls).toEqual([]);
    expect(client.addMessage).not.toHaveBeenCalled();
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("could not compute the implement diff");
  });

  it("allowlist: a path OUTSIDE + mode=off → silent (no escalate, no push)", async () => {
    const wt = new FakeWorktree();
    wt.touchedPaths = ["infra/secrets.ts"];
    const { client, runner, sniffer, impl } = implementSetup(
      { kind: "branch_ready", branch: "pm/escalation-e1", commitSha: "x", durationMs: 1 },
      { wt },
    );
    await responderTick(
      baseDeps(client, {
        mode: "off",
        runner,
        sniffer,
        autoImplementEnabled: true,
        implementRunner: impl,
        acquireWorktree: () => wt,
        worktreeGit: { remote: "origin", mainBranch: "main", allowedPaths: ["packages/"] },
      }),
      createResponderState(),
    );
    expect(wt.pushCalls).toEqual([]);
    expect(client.escalateToHuman).not.toHaveBeenCalled();
    expect(client.addMessage).not.toHaveBeenCalled();
  });

  it("allowlist: autoImplementEnabled=false → the whole implement path stays inert (impl.run + acquireWorktree untouched)", async () => {
    const wt = new FakeWorktree();
    const acquire = vi.fn(() => wt);
    const { client, runner, sniffer, impl } = implementSetup(
      { kind: "branch_ready", branch: "pm/escalation-e1", commitSha: "x", durationMs: 1 },
      { wt },
    );
    await responderTick(
      baseDeps(client, {
        mode: "on",
        runner,
        sniffer,
        autoImplementEnabled: false,
        implementRunner: impl,
        acquireWorktree: acquire,
        worktreeGit: { remote: "origin", mainBranch: "main", allowedPaths: ["packages/"] },
      }),
      createResponderState(),
    );
    // Disabled: an `implement` declaration falls back to needs_human; the write
    // runner + worktree are NEVER touched, and the sniffer never runs.
    expect(impl.run).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(sniffer.sniff).not.toHaveBeenCalled();
    expect(wt.pushCalls).toEqual([]);
    expect(client.escalateCalls).toHaveLength(1);
    expect(client.escalateCalls[0].reason).toContain("auto_implement is disabled");
  });

  describe("pathsOutsideAllowlist (pure)", () => {
    it("empty allowlist → [] (no restriction)", () => {
      expect(pathsOutsideAllowlist(["a/x.ts", "b/y.ts"], [])).toEqual([]);
    });
    it("all touched inside → []", () => {
      expect(pathsOutsideAllowlist(["packages/a.ts", "packages/b.ts"], ["packages/"])).toEqual([]);
    });
    it("mixed → only the outside paths", () => {
      expect(
        pathsOutsideAllowlist(["packages/a.ts", "infra/b.ts", "docs/c.md"], ["packages/", "docs/"]),
      ).toEqual(["infra/b.ts"]);
    });
    it("prefix boundary: a literal prefix matches by startsWith", () => {
      // "packages" (no slash) is a prefix of "packages-extra/x.ts" — coarse by design.
      expect(pathsOutsideAllowlist(["packages-extra/x.ts"], ["packages"])).toEqual([]);
      expect(pathsOutsideAllowlist(["packages-extra/x.ts"], ["packages/"])).toEqual([
        "packages-extra/x.ts",
      ]);
    });
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

  // A3 P2: a pendingDrive/pendingArc escalation ROUTES to advanceArc (NOT a read-only
  // re-spawn). This UPDATES the P1 behavior (P1 reclaim-SKIPPED pendingDrive; P2 drives
  // it). Here the arc has one phase with no MR yet → advanceArc implements it.
  it("reclaim ROUTES a pendingDrive escalation to advanceArc (implements the next phase; no read-only re-spawn)", async () => {
    const client = new FakeClient();
    client.listResults = [[]];
    const stale = mkEscalation("r1", {
      status: "acknowledged",
      holderId: SELF,
      updatedAt: "2026-06-13T00:00:00.000Z",
    });
    // Twice: the A4 P1 in-flight-arc probe + the reclaim pass each shift one entry
    // (autoImplementEnabled ⇒ the probe runs).
    client.ackResults = [[stale], [stale]];
    client.getEscalation = vi.fn(async (id: string): Promise<EscalationWithThread> => ({
      ...mkEscalation(id, { status: "acknowledged", holderId: SELF }),
      messages: [
        {
          id: `${id}-m1`,
          escalationId: id,
          seq: 1,
          authorId: SELF,
          body: "Produced a vision ... and created PM epic ...",
          messageType: "diagnosis",
          metadata: { pendingDrive: true, visionPath: "roadmaps/v.md", epicId: "epic1" },
          createdAt: "2026-06-13T00:00:00.000Z",
        },
      ],
    }));
    client.epicResult = { id: "epic1", name: "E", tasks: [{ id: "task-1", title: "P1", description: "d1" }] };
    client.mrResults = [[]]; // no phase MRs yet → implement phase 1.
    const impl = new FakeImplementRunner();
    impl.result = { kind: "branch_ready", branch: "pm/escalation-r1-task-1", commitSha: "c1", durationMs: 1 };
    const runner = onRunner({ kind: "needs_human", reason: "x", durationMs: 1 });
    await responderTick(
      baseDeps(client, {
        mode: "on",
        maxConcurrent: 10,
        runner,
        now: () => STALE_NOW,
        autoImplementEnabled: true,
        implementRunner: impl,
        acquireWorktree: () => new FakeWorktree(),
      }),
      createResponderState(),
    );
    // The read-only answering session is NOT re-spawned; the implement runner is.
    expect(runner.run).not.toHaveBeenCalled();
    expect(impl.run).toHaveBeenCalledTimes(1);
    // A phase MR submitted with the campaign-task id + escalationId.
    expect(client.submitMergeRequestCalls).toHaveLength(1);
    expect(client.submitMergeRequestCalls[0].body).toMatchObject({
      taskId: "task-1",
      escalationId: "r1",
      branch: "pm/escalation-r1-task-1",
    });
    // pendingArc handoff appended; escalation stays acknowledged (no resolve/answer).
    expect(client.addMessageCalls).toHaveLength(1);
    expect(client.addMessageCalls[0].metadata).toMatchObject({
      pendingArc: true,
      epicId: "epic1",
      phaseTaskId: "task-1",
    });
    expect(client.escalateToHuman).not.toHaveBeenCalled();
    expect(client.answer).not.toHaveBeenCalled();
  });

  // ── A3 P2: tick-driven campaign-phase drive (advanceArc) ─────────────
  //
  // The deliverable is the STRUCTURE proven with scripted phase outcomes: each
  // reclaim cycle re-finds a self-held acknowledged escalation carrying a
  // pendingArc/pendingDrive marker, routes it to advanceArc, which derives the arc
  // state from the server (epic campaign-tasks + each phase's MR land status) and
  // advances ONE phase per cycle.
  describe("advanceArc (A3 P2 tick-driven arc)", () => {
    const STALE = Date.parse("2026-06-14T00:00:00.000Z");

    /** A self-held acknowledged escalation carrying a pendingArc marker (epicId/visionPath). */
    function arcThread(id: string, over: { arcComplete?: boolean } = {}): EscalationWithThread {
      return {
        ...mkEscalation(id, { status: "acknowledged", holderId: SELF }),
        messages: [
          {
            id: `${id}-m1`,
            escalationId: id,
            seq: 1,
            authorId: SELF,
            body: "pending campaign phase land",
            messageType: "diagnosis",
            metadata: {
              pendingArc: true,
              epicId: "epic1",
              visionPath: "roadmaps/v.md",
              ...(over.arcComplete ? { arcComplete: true, landedShas: ["s1", "s2"] } : {}),
            },
            createdAt: "2026-06-13T00:00:00.000Z",
          },
        ],
      };
    }

    /** Wire a FakeClient into the arc-route path: empty open list, a stale self-held ack. */
    function arcClient(id: string, thread: EscalationWithThread): FakeClient {
      const client = new FakeClient();
      client.listResults = [[]];
      // listAcknowledgedByHolder is called TWICE per tick under autoImplementEnabled:
      // once by the A4 P1 in-flight-arc probe, once by the reclaim pass. Both shift one
      // entry — script the row twice so both see it.
      const row = mkEscalation(id, {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-06-13T00:00:00.000Z",
      });
      client.ackResults = [[row], [row]];
      client.getEscalation = vi.fn(async (): Promise<EscalationWithThread> => thread);
      return client;
    }

    function arcDeps(client: FakeClient, impl: FakeImplementRunner): ResponderDeps {
      return baseDeps(client, {
        mode: "on",
        maxConcurrent: 10,
        now: () => STALE,
        autoImplementEnabled: true,
        implementRunner: impl,
        acquireWorktree: () => new FakeWorktree(),
      });
    }

    const READY = (branch: string): ImplementRunResult => ({
      kind: "branch_ready",
      branch,
      commitSha: "c",
      durationMs: 1,
    });

    it("cycle 1 (no MRs) → implements phase 1, submits {taskId:'task-1', escalationId:'e1'}, appends pendingArc", async () => {
      const client = arcClient("e1", arcThread("e1"));
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      client.mrResults = [[]];
      const impl = new FakeImplementRunner();
      impl.result = READY("pm/escalation-e1-task-1");
      await responderTick(arcDeps(client, impl), createResponderState());

      expect(impl.run).toHaveBeenCalledTimes(1);
      expect(client.submitMergeRequestCalls).toHaveLength(1);
      expect(client.submitMergeRequestCalls[0].body).toMatchObject({
        taskId: "task-1",
        escalationId: "e1",
        branch: "pm/escalation-e1-task-1",
      });
      // The brief scoped the session to phase 1.
      expect(impl.lastInput?.prompt).toContain("Phase 1");
      expect(impl.lastInput?.prompt).toContain("roadmaps/v.md");
      expect(client.addMessageCalls).toHaveLength(1);
      expect(client.addMessageCalls[0].metadata).toMatchObject({
        pendingArc: true,
        epicId: "epic1",
        phaseTaskId: "task-1",
        mergeRequestId: "mr1",
      });
      expect(client.answer).not.toHaveBeenCalled();
      expect(client.escalateToHuman).not.toHaveBeenCalled();
    });

    it("phase-1 MR 'integrating' → re-park: NO new implement spawn (never two phases in flight)", async () => {
      const client = arcClient("e1", arcThread("e1"));
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      client.mrResults = [
        [{ id: "mr1", taskId: "task-1", escalationId: "e1", status: "integrating", landedSha: null, branch: "b1", commitSha: "c1" }],
      ];
      const impl = new FakeImplementRunner();
      await responderTick(arcDeps(client, impl), createResponderState());

      expect(impl.run).not.toHaveBeenCalled();
      expect(client.submitMergeRequest).not.toHaveBeenCalled();
      expect(client.addMessage).not.toHaveBeenCalled();
    });

    it("phase-1 MR 'landed' → implements phase 2 ({taskId:'task-2'}); exactly one spawn per landed-advance", async () => {
      const client = arcClient("e1", arcThread("e1"));
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      client.mrResults = [
        [{ id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "s1", branch: "b1", commitSha: "c1" }],
      ];
      const impl = new FakeImplementRunner();
      impl.result = READY("pm/escalation-e1-task-2");
      await responderTick(arcDeps(client, impl), createResponderState());

      expect(impl.run).toHaveBeenCalledTimes(1);
      expect(client.submitMergeRequestCalls).toHaveLength(1);
      expect(client.submitMergeRequestCalls[0].body).toMatchObject({ taskId: "task-2", escalationId: "e1" });
    });

    it("arc_complete: both MRs 'landed' (not-yet-marked) → arcComplete marker appended, THEN answer+resolve as holder with a summary naming the epic + landed shas; order marker→answer→resolve", async () => {
      const client = arcClient("e1", arcThread("e1"));
      client.epicResult = {
        id: "epic1",
        name: "Repo Quality Consolidation",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      client.mrResults = [
        [
          { id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "s1", branch: "b1", commitSha: "c1" },
          { id: "mr2", taskId: "task-2", escalationId: "e1", status: "landed", landedSha: "s2", branch: "b2", commitSha: "c2" },
        ],
      ];
      const impl = new FakeImplementRunner();
      await responderTick(arcDeps(client, impl), createResponderState());

      expect(impl.run).not.toHaveBeenCalled();
      expect(client.addMessageCalls).toHaveLength(1);
      expect(client.addMessageCalls[0].metadata).toMatchObject({
        arcComplete: true,
        landedShas: ["s1", "s2"],
        epicId: "epic1",
      });
      // P4: close as holder — answer once + resolve once, same summary, naming the
      // epic NAME + the landed shas.
      expect(client.answerCalls).toHaveLength(1);
      expect(client.resolveCalls).toHaveLength(1);
      const summary = client.resolveCalls[0].reason;
      expect(summary).toContain("Repo Quality Consolidation"); // epic NAME, not just id
      expect(summary).toContain("s1");
      expect(summary).toContain("s2");
      expect(client.answerCalls[0]).toEqual({ id: "e1", body: summary });
      expect(client.resolveCalls[0]).toEqual({ id: "e1", reason: summary });
      // Order: marker appended → answer → resolve.
      const markerOrder = client.addMessage.mock.invocationCallOrder[0];
      const answerOrder = client.answer.mock.invocationCallOrder[0];
      const resolveOrder = client.resolve.mock.invocationCallOrder[0];
      expect(markerOrder).toBeLessThan(answerOrder);
      expect(answerOrder).toBeLessThan(resolveOrder);
      expect(client.escalateToHuman).not.toHaveBeenCalled();
    });

    it("arc_complete is idempotent: an arcComplete-marked thread re-parks (no second marker, no double answer/resolve)", async () => {
      const client = arcClient("e1", arcThread("e1", { arcComplete: true }));
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [{ id: "task-1", title: "Phase 1", description: "d1" }],
      };
      client.mrResults = [
        [{ id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "s1", branch: "b1", commitSha: "c1" }],
      ];
      const impl = new FakeImplementRunner();
      await responderTick(arcDeps(client, impl), createResponderState());
      expect(client.addMessage).not.toHaveBeenCalled();
      expect(client.answer).not.toHaveBeenCalled();
      expect(client.resolve).not.toHaveBeenCalled();
    });

    it("arc_complete re-entry from 'answered' (death between answer and resolve) → answer NOT re-called (gated on acknowledged), resolve IS called", async () => {
      const thread = arcThread("e1");
      thread.status = "answered"; // a death struck after answer committed, before resolve.
      const client = arcClient("e1", thread);
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [{ id: "task-1", title: "Phase 1", description: "d1" }],
      };
      client.mrResults = [
        [{ id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "s1", branch: "b1", commitSha: "c1" }],
      ];
      const impl = new FakeImplementRunner();
      await responderTick(arcDeps(client, impl), createResponderState());

      expect(client.addMessageCalls).toHaveLength(1); // marker still appended.
      expect(client.answer).not.toHaveBeenCalled(); // gated: status !== acknowledged.
      expect(client.resolveCalls).toHaveLength(1); // resolve still fires → clean close.
    });

    it("no-recursion seal: a resolved escalation is not acknowledged → never re-seeded; advanceArc/implement never run for it", async () => {
      const client = arcClient("e1", arcThread("e1"));
      // The thread already resolved: the ack list (the arc seed) is empty, the open
      // list is empty — nothing re-drives it.
      client.ackResults = [[]];
      client.listResults = [[]];
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [{ id: "task-1", title: "Phase 1", description: "d1" }],
      };
      const impl = new FakeImplementRunner();
      await responderTick(arcDeps(client, impl), createResponderState());

      expect(impl.run).not.toHaveBeenCalled();
      expect(client.getEscalation).not.toHaveBeenCalled(); // advanceArc never entered.
      expect(client.answer).not.toHaveBeenCalled();
      expect(client.resolve).not.toHaveBeenCalled();
    });

    it("arc_partial on reject: phase-1 landed, phase-2 rejected → escalateToHuman naming landed sha + remaining; no rollback; no further spawn; reject terminal (no re-submit)", async () => {
      const client = arcClient("e1", arcThread("e1"));
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      client.mrResults = [
        [
          { id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "s1", branch: "b1", commitSha: "c1" },
          { id: "mr2", taskId: "task-2", escalationId: "e1", status: "rejected", landedSha: null, branch: "b2", commitSha: "c2" },
        ],
      ];
      const impl = new FakeImplementRunner();
      await responderTick(arcDeps(client, impl), createResponderState());

      expect(client.escalateCalls).toHaveLength(1);
      expect(client.escalateCalls[0].id).toBe("e1");
      expect(client.escalateCalls[0].reason).toContain("PARTIAL");
      expect(client.escalateCalls[0].reason).toContain("s1"); // landed sha preserved
      expect(client.escalateCalls[0].reason).toContain("Phase 2"); // the rejected/remaining phase
      // Terminal: no re-implement of the rejected task, no second live MR.
      expect(impl.run).not.toHaveBeenCalled();
      expect(client.submitMergeRequest).not.toHaveBeenCalled();
    });

    it("escalationId is threaded on every phase MR", async () => {
      const client = arcClient("e1", arcThread("e1"));
      client.epicResult = { id: "epic1", name: "E", tasks: [{ id: "task-1", title: "P1", description: "d" }] };
      client.mrResults = [[]];
      const impl = new FakeImplementRunner();
      impl.result = READY("pm/escalation-e1-task-1");
      await responderTick(arcDeps(client, impl), createResponderState());
      expect(client.submitMergeRequestCalls[0].body.escalationId).toBe("e1");
      // listMergeRequests was filtered by escalationId (server-derived arc state).
      expect(client.listMergeRequestsCalls[0].params).toMatchObject({ escalationId: "e1" });
    });

    it("no-recursion: an arc-marked escalation only routes to advanceArc (never a read-only answering session); the arc's own MRs never re-enter the seed", async () => {
      const client = arcClient("e1", arcThread("e1"));
      client.epicResult = { id: "epic1", name: "E", tasks: [{ id: "task-1", title: "P1", description: "d" }] };
      client.mrResults = [[]];
      const impl = new FakeImplementRunner();
      impl.result = READY("pm/escalation-e1-task-1");
      const runner = onRunner({ kind: "answered", answer: "a", durationMs: 1 });
      await responderTick(arcDeps(client, impl), createResponderState());
      // The read-only answering runner is NEVER spawned on an arc-marked escalation.
      expect(runner.run).not.toHaveBeenCalled();
      // The escalation is authored by SELF? No — by "human"; but the open list is empty
      // so the seed never re-picks it regardless. Only advanceArc touched it.
      expect(impl.run).toHaveBeenCalledTimes(1);
    });

    it("poison-cap avoidance: a 3-phase arc advances past cycle 2 (reclaimAttempts untouched — no needs_human)", async () => {
      // maxReclaimAttempts default is 2. Drive THREE cycles on the SAME state; if the
      // arc route bumped reclaimAttempts, cycle 3 would poison-cap to needs_human.
      const state = createResponderState();
      const impl = new FakeImplementRunner();

      // Cycle 1: no MRs → implement phase 1.
      const c1 = arcClient("e1", arcThread("e1"));
      c1.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
          { id: "task-3", title: "Phase 3", description: "d3" },
        ],
      };
      c1.mrResults = [[]];
      impl.result = READY("pm/escalation-e1-task-1");
      await responderTick(arcDeps(c1, impl), state);
      expect(c1.escalateToHuman).not.toHaveBeenCalled();

      // Cycle 2: phase 1 landed → implement phase 2.
      const c2 = arcClient("e1", arcThread("e1"));
      c2.epicResult = c1.epicResult;
      c2.mrResults = [
        [{ id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "s1", branch: "b", commitSha: "c" }],
      ];
      impl.result = READY("pm/escalation-e1-task-2");
      await responderTick(arcDeps(c2, impl), state);
      expect(c2.escalateToHuman).not.toHaveBeenCalled();

      // Cycle 3: phases 1+2 landed → implement phase 3. If reclaimAttempts were bumped
      // (default cap 2), THIS cycle would hand to a human instead.
      const c3 = arcClient("e1", arcThread("e1"));
      c3.epicResult = c1.epicResult;
      c3.mrResults = [
        [
          { id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "s1", branch: "b", commitSha: "c" },
          { id: "mr2", taskId: "task-2", escalationId: "e1", status: "landed", landedSha: "s2", branch: "b", commitSha: "c" },
        ],
      ];
      impl.result = READY("pm/escalation-e1-task-3");
      await responderTick(arcDeps(c3, impl), state);
      expect(c3.escalateToHuman).not.toHaveBeenCalled();
      expect(c3.submitMergeRequestCalls[0].body).toMatchObject({ taskId: "task-3" });
      // reclaimAttempts never touched by the arc route.
      expect(state.reclaimAttempts.size).toBe(0);
    });

    it("byte-identical: autoImplementEnabled:false + no arc markers ⇒ the arc path is inert", async () => {
      const client = new FakeClient();
      client.listResults = [[]];
      client.ackResults = [[]];
      const impl = new FakeImplementRunner();
      await responderTick(
        baseDeps(client, { mode: "on", now: () => STALE, implementRunner: impl }),
        createResponderState(),
      );
      expect(client.getEpic).not.toHaveBeenCalled();
      expect(client.listMergeRequests).not.toHaveBeenCalled();
      expect(impl.run).not.toHaveBeenCalled();
    });
  });

  // ── A3 P3: checkpoint / resume (daemon-restart survival) ─────────────
  //
  // The arc carries NO load-bearing in-memory state — advanceArc derives the
  // arc's true state STRICTLY FROM THE SERVER each cycle (getEpic tasks +
  // listMergeRequests by escalationId), and the server-side markers +
  // merge_requests ARE the checkpoint. So a fresh `createResponderState()` is a
  // FAITHFUL restart simulator. These tests seal:
  //   - Gap 1 (the one real fix): an EARLY pre-epic intent marker closes the
  //     duplicate-createEpic window (crash between createEpic and the terminal
  //     epicId-bearing marker) — on restart the intent marker routes to advanceArc,
  //     arcEpicId is null → escalateToHuman; NO second createEpic.
  //   - Gaps 2-5 (already structurally closed): restart resumes from the next
  //     un-landed phase, a completed arc is not re-driven, no double-submit across
  //     ticks, and the checkpoint round-trips across a brand-new state.
  describe("A3 P3 — daemon-restart survival (checkpoint/resume)", () => {
    const STALE = Date.parse("2026-06-14T00:00:00.000Z");

    /** A self-held acknowledged escalation carrying a thread of arbitrary messages. */
    function thread(id: string, messages: EscalationMessage[]): EscalationWithThread {
      return {
        ...mkEscalation(id, { status: "acknowledged", holderId: SELF }),
        messages,
      };
    }

    function msg(
      id: string,
      seq: number,
      metadata: Record<string, unknown>,
    ): EscalationMessage {
      return {
        id: `${id}-m${seq}`,
        escalationId: id,
        seq,
        authorId: SELF,
        body: "marker",
        messageType: "diagnosis",
        metadata,
        createdAt: "2026-06-13T00:00:00.000Z",
      };
    }

    /** Wire a FakeClient into the arc-route reclaim path with the given thread. */
    function arcClient(id: string, detail: EscalationWithThread): FakeClient {
      const client = new FakeClient();
      client.listResults = [[]];
      // Twice: the A4 P1 in-flight-arc probe + the reclaim pass each shift one entry.
      const row = mkEscalation(id, {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-06-13T00:00:00.000Z",
      });
      client.ackResults = [[row], [row]];
      client.getEscalation = vi.fn(async (): Promise<EscalationWithThread> => detail);
      return client;
    }

    function arcDeps(client: FakeClient, impl: FakeImplementRunner): ResponderDeps {
      return baseDeps(client, {
        mode: "on",
        maxConcurrent: 10,
        now: () => STALE,
        autoImplementEnabled: true,
        implementRunner: impl,
        acquireWorktree: () => new FakeWorktree(),
      });
    }

    const READY = (branch: string): ImplementRunResult => ({
      kind: "branch_ready",
      branch,
      commitSha: "c",
      durationMs: 1,
    });

    // Gap 4 seal: a daemon restart mid-arc resumes from the NEXT un-landed phase,
    // not phase 1. A FRESH state proves zero in-memory carryover; the server snapshot
    // (task-1 landed) fully reconstitutes the arc.
    it("restart mid-arc resumes from the next un-landed phase (task-2), not phase 1", async () => {
      const client = arcClient(
        "e1",
        thread("e1", [msg("e1", 1, { pendingArc: true, epicId: "epic1", visionPath: "roadmaps/v.md" })]),
      );
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      client.mrResults = [
        [{ id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "s1", branch: "b1", commitSha: "c1" }],
      ];
      const impl = new FakeImplementRunner();
      impl.result = READY("pm/escalation-e1-task-2");
      // FRESH state = the restart simulator.
      await responderTick(arcDeps(client, impl), createResponderState());

      expect(impl.run).toHaveBeenCalledTimes(1);
      expect(client.submitMergeRequestCalls).toHaveLength(1);
      expect(client.submitMergeRequestCalls[0].body).toMatchObject({ taskId: "task-2", escalationId: "e1" });
      // No submit for the already-landed task-1.
      expect(
        client.submitMergeRequestCalls.some((c) => c.body.taskId === "task-1"),
      ).toBe(false);
    });

    // Gap 1 (the core): an acknowledged self-held escalation whose thread carries ONLY
    // the pre-epic intent marker (pendingDrive, NO epicId) → on the reclaim cycle it
    // routes to advanceArc, arcEpicId is null → escalateToHuman; NO re-drive, NO second
    // createEpic.
    it("restart during vision production (intent marker, no epicId) does NOT re-drive or create a duplicate epic", async () => {
      const client = arcClient(
        "e1",
        thread("e1", [msg("e1", 1, { pendingDrive: true, visionPath: "roadmaps/v.md" })]),
      );
      // The epic does not exist yet from the arc's POV — but advanceArc must NOT even
      // get that far: arcEpicId(null) escalates before any getEpic.
      const impl = new FakeImplementRunner();
      const drive = new FakeDriveRunner();
      await responderTick(
        baseDeps(client, {
          mode: "on",
          maxConcurrent: 10,
          now: () => STALE,
          autoImplementEnabled: true,
          implementRunner: impl,
          driveRunner: drive,
          acquireWorktree: () => new FakeWorktree(),
        }),
        createResponderState(),
      );

      // Routed to advanceArc → arcEpicId null → escalateToHuman.
      expect(client.escalateCalls).toHaveLength(1);
      expect(client.escalateCalls[0].id).toBe("e1");
      expect(client.escalateCalls[0].reason).toContain("no recoverable epic id");
      // NO re-drive, NO second createEpic, NO re-implement.
      expect(drive.run).not.toHaveBeenCalled();
      expect(client.createEpic).not.toHaveBeenCalled();
      expect(impl.run).not.toHaveBeenCalled();
    });

    // Gap 1 (the write-ordering seal): a successful vision_ready drive writes the
    // pre-epic intent marker (pendingDrive, NO epicId) BEFORE createEpic, then the
    // terminal epicId-bearing marker AFTER the tasks. Asserted via mock invocation
    // call order.
    it("a normal vision_ready drive writes the intent marker BEFORE createEpic, then the epicId marker after", async () => {
      const client = new FakeClient();
      client.listResults = [[mkEscalation("e1")]];
      const runner = onRunner({ kind: "implement", size: "systemic", rationale: "r", durationMs: 1 });
      const sniffer = snifferOf({ kind: "clean" });
      const drive = new FakeDriveRunner();
      drive.result = {
        kind: "vision_ready",
        visionPath: "roadmaps/v.md",
        epicName: "E",
        campaigns: [{ title: "C1", priority: "high", description: "d" }],
        durationMs: 1,
      };
      await responderTick(
        baseDeps(client, {
          mode: "on",
          runner,
          sniffer,
          autoImplementEnabled: true,
          driveRunner: drive,
          acquireWorktree: () => new FakeWorktree(),
        }),
        createResponderState(),
      );

      // TWO addMessage calls: the early intent marker (no epicId) then the terminal
      // epicId-bearing marker.
      expect(client.addMessageCalls).toHaveLength(2);
      const intent = client.addMessageCalls[0];
      const terminal = client.addMessageCalls[1];
      expect(intent.metadata).toMatchObject({ pendingDrive: true, visionPath: "roadmaps/v.md" });
      expect(intent.metadata?.epicId).toBeUndefined(); // pre-epic: NO epicId
      expect(terminal.metadata).toMatchObject({
        pendingDrive: true,
        visionPath: "roadmaps/v.md",
        epicId: "epic1",
      });
      // Ordering: intent addMessage < createEpic < terminal addMessage.
      const intentOrder = client.addMessage.mock.invocationCallOrder[0];
      const terminalOrder = client.addMessage.mock.invocationCallOrder[1];
      const epicOrder = client.createEpic.mock.invocationCallOrder[0];
      expect(intentOrder).toBeLessThan(epicOrder);
      expect(epicOrder).toBeLessThan(terminalOrder);
    });

    // Gap 3 seal: a completed arc (arcComplete marker + all-landed snapshot) is NOT
    // re-driven across a fresh-state restart — no implement, no second marker, no
    // answer/escalate.
    it("a completed arc is not re-driven across restart (fresh state, all landed, arcComplete marked)", async () => {
      const client = arcClient(
        "e1",
        thread("e1", [
          msg("e1", 1, {
            pendingArc: true,
            epicId: "epic1",
            visionPath: "roadmaps/v.md",
            arcComplete: true,
            landedShas: ["s1", "s2"],
          }),
        ]),
      );
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      client.mrResults = [
        [
          { id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "s1", branch: "b1", commitSha: "c1" },
          { id: "mr2", taskId: "task-2", escalationId: "e1", status: "landed", landedSha: "s2", branch: "b2", commitSha: "c2" },
        ],
      ];
      const impl = new FakeImplementRunner();
      await responderTick(arcDeps(client, impl), createResponderState());

      expect(impl.run).not.toHaveBeenCalled();
      expect(client.addMessage).not.toHaveBeenCalled(); // no second arcComplete marker
      expect(client.answer).not.toHaveBeenCalled();
      expect(client.escalateToHuman).not.toHaveBeenCalled();
    });

    // Gap 2 seal: no double-submit across two consecutive ticks on a SHARED state.
    // Tick 1 submits phase-1; tick 2 sees phase-1 queued/integrating → re-parks. Exactly
    // ONE submitMergeRequest across both ticks.
    it("no double-submit across two consecutive ticks on a shared state (tick 2 re-parks the in-flight phase)", async () => {
      const state = createResponderState();
      const impl = new FakeImplementRunner();

      // Tick 1: no MRs → implement phase 1.
      const c1 = arcClient(
        "e1",
        thread("e1", [msg("e1", 1, { pendingArc: true, epicId: "epic1", visionPath: "roadmaps/v.md" })]),
      );
      c1.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      c1.mrResults = [[]];
      impl.result = READY("pm/escalation-e1-task-1");
      await responderTick(arcDeps(c1, impl), state);
      expect(c1.submitMergeRequestCalls).toHaveLength(1);
      expect(c1.submitMergeRequestCalls[0].body).toMatchObject({ taskId: "task-1" });

      // Tick 2 (shared state): phase-1 MR now queued → re-park, NO new submit.
      const c2 = arcClient(
        "e1",
        thread("e1", [msg("e1", 1, { pendingArc: true, epicId: "epic1", visionPath: "roadmaps/v.md" })]),
      );
      c2.epicResult = c1.epicResult;
      c2.mrResults = [
        [{ id: "mr1", taskId: "task-1", escalationId: "e1", status: "queued", landedSha: null, branch: "b1", commitSha: "c1" }],
      ];
      await responderTick(arcDeps(c2, impl), state);
      // Exactly ONE submit across both ticks (tick 2 re-parked).
      expect(c2.submitMergeRequest).not.toHaveBeenCalled();
      expect(impl.run).toHaveBeenCalledTimes(1); // only tick 1 spawned
    });

    // Gap 5 seal: the checkpoint ROUND-TRIPS across a simulated restart. Cycle 1
    // (fresh state) implements phase-1 + writes pendingArc; cycle 2 with a BRAND-NEW
    // state + a snapshot showing phase-1 landed → resumes at phase-2. Proves zero
    // in-memory carryover: the server marker + MR status fully reconstitute the arc.
    it("checkpoint round-trips across a simulated restart (fresh state cycle 2 resumes at phase-2)", async () => {
      const impl = new FakeImplementRunner();

      // Cycle 1: fresh state, no MRs → implement phase 1 + append pendingArc.
      const c1 = arcClient(
        "e1",
        thread("e1", [msg("e1", 1, { pendingArc: true, epicId: "epic1", visionPath: "roadmaps/v.md" })]),
      );
      c1.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      c1.mrResults = [[]];
      impl.result = READY("pm/escalation-e1-task-1");
      await responderTick(arcDeps(c1, impl), createResponderState());
      expect(c1.submitMergeRequestCalls[0].body).toMatchObject({ taskId: "task-1" });
      // The pendingArc handoff was written (the durable checkpoint).
      const handoff = c1.addMessageCalls.find((m) => m.metadata?.pendingArc === true);
      expect(handoff?.metadata).toMatchObject({ epicId: "epic1", phaseTaskId: "task-1" });

      // Cycle 2: BRAND-NEW state (restart) + phase-1 landed snapshot → resume at phase-2.
      const c2 = arcClient(
        "e1",
        thread("e1", [msg("e1", 1, { pendingArc: true, epicId: "epic1", visionPath: "roadmaps/v.md" })]),
      );
      c2.epicResult = c1.epicResult;
      c2.mrResults = [
        [{ id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "s1", branch: "b1", commitSha: "c1" }],
      ];
      impl.result = READY("pm/escalation-e1-task-2");
      await responderTick(arcDeps(c2, impl), createResponderState());
      expect(c2.submitMergeRequestCalls).toHaveLength(1);
      expect(c2.submitMergeRequestCalls[0].body).toMatchObject({ taskId: "task-2", escalationId: "e1" });
    });

    // Byte-identical guard: with autoImplementEnabled:false and no arc markers, the
    // arc/restart path is inert (no getEpic, no listMergeRequests, no implement).
    it("byte-identical: autoImplementEnabled:false + no arc markers ⇒ the restart path is inert", async () => {
      const client = new FakeClient();
      client.listResults = [[]];
      client.ackResults = [[]];
      const impl = new FakeImplementRunner();
      await responderTick(
        baseDeps(client, { mode: "on", now: () => STALE, implementRunner: impl }),
        createResponderState(),
      );
      expect(client.getEpic).not.toHaveBeenCalled();
      expect(client.listMergeRequests).not.toHaveBeenCalled();
      expect(impl.run).not.toHaveBeenCalled();
    });
  });

  // ── A4 P1: cost/concurrency budget (max concurrent arcs + max arc duration) ──
  //
  // Two NEW caps extending the responder's existing spawn budget:
  //   - maxConcurrentArcs: a fresh systemic disposition that would exceed the
  //     in-flight-arc count is HELD → escalate-to-human (NO epic created).
  //   - maxArcDurationSec: an arc whose first pendingDrive intent marker is older
  //     than the cap is CAPPED → escalate-to-human with the partial progress
  //     (landed phases preserved, no rollback). Placed AFTER the arc_complete
  //     check so an all-landed arc COMPLETES rather than being capped.
  // Both are server-derived (arc count from listAcknowledgedByHolder markers;
  // arc-start from the durable pendingDrive createdAt) ⇒ restart-resilient. The
  // probe is gated on autoImplementEnabled so answer-mode stays byte-identical.
  describe("A4 P1 — cost/concurrency budget", () => {
    const STALE = Date.parse("2026-06-14T00:00:00.000Z");

    /** A self-held acknowledged arc thread carrying a pendingDrive INTENT marker at `createdAt`. */
    function driveArcThread(id: string, createdAt: string): EscalationWithThread {
      return {
        ...mkEscalation(id, { status: "acknowledged", holderId: SELF }),
        messages: [
          {
            id: `${id}-intent`,
            escalationId: id,
            seq: 1,
            authorId: SELF,
            body: "intent",
            messageType: "diagnosis",
            metadata: { pendingDrive: true, visionPath: "roadmaps/v.md", epicId: "epic1" },
            createdAt,
          },
        ],
      };
    }

    // ── Case 1: maxConcurrentArcs hold ──
    it("max-concurrent-arcs reached → a fresh implement{systemic} is HELD: escalateToHuman with the budget reason; NO drive, NO epic, NO pendingDrive marker", async () => {
      const client = new FakeClient();
      // The claim pass seeds a NEW open escalation that will declare systemic.
      client.listResults = [[mkEscalation("e-new")]];
      // The in-flight-arc probe + the reclaim pass both call listAcknowledgedByHolder
      // (shifted per call): the probe sees one existing arc; reclaim sees it too but it
      // is NOT stale (updatedAt == now) so reclaim skips it.
      const existingArc = mkEscalation("e-arc", {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-06-14T00:00:00.000Z", // == STALE ⇒ not stale ⇒ reclaim skips.
      });
      client.ackResults = [[existingArc], [existingArc]];
      // getEscalation dispatches: the existing arc carries a pendingArc marker (counts
      // as in-flight); the new escalation is a plain open thread.
      client.getEscalation = vi.fn(async (id: string): Promise<EscalationWithThread> => {
        if (id === "e-arc") return driveArcThread("e-arc", "2026-06-13T00:00:00.000Z");
        return { ...mkEscalation(id, { status: "acknowledged", holderId: SELF }), messages: [] };
      });

      const runner = implementRunner("systemic");
      const drive = new FakeDriveRunner();
      const deps = baseDeps(client, {
        mode: "on",
        now: () => STALE,
        autoImplementEnabled: true,
        maxConcurrentArcs: 1, // already 1 in flight ⇒ the new one is held.
        runner,
        driveRunner: drive,
      });
      await responderTick(deps, createResponderState());

      // The systemic ask was HELD, not driven.
      expect(drive.run).not.toHaveBeenCalled();
      expect(client.createEpic).not.toHaveBeenCalled();
      // No pendingDrive handoff marker appended (no epic created on a hold).
      expect(client.addMessage).not.toHaveBeenCalled();
      // Escalated to a human with the budget reason naming the count.
      const budgetEsc = client.escalateCalls.find((e) => e.id === "e-new");
      expect(budgetEsc).toBeDefined();
      expect(budgetEsc?.reason).toContain("auto-drive budget");
      expect(budgetEsc?.reason).toContain("1/1");
      expect(budgetEsc?.reason).toContain("concurrent arcs");
    });

    // ── Case 2: maxArcDuration cap → arc_partial ──
    it("max-arc-duration exceeded → arc CAPPED: escalateToHuman naming the landed sha (preserved) + the remaining phase; the next phase NOT implemented", async () => {
      // arcThread with a pendingDrive intent marker far in the past; now is past
      // createdAt + maxArcDurationSec. Phase 1 landed, phase 2 unlanded.
      const thread = driveArcThread("e1", "2026-01-01T00:00:00.000Z");
      const client = new FakeClient();
      client.listResults = [[]];
      // Probe call + reclaim call: both return the (stale) self-held arc.
      const heldArc = mkEscalation("e1", {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-01-01T00:00:00.000Z", // stale ⇒ reclaim routes it to advanceArc.
      });
      client.ackResults = [[heldArc], [heldArc]];
      client.getEscalation = vi.fn(async (): Promise<EscalationWithThread> => thread);
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      // Phase 1 landed, phase 2 has no MR yet (would normally implement next).
      client.mrResults = [
        [{ id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "sha-1", branch: "b1", commitSha: "c1" }],
      ];
      const impl = new FakeImplementRunner();
      impl.result = { kind: "branch_ready", branch: "pm/escalation-e1-task-2", commitSha: "c", durationMs: 1 };
      const deps = baseDeps(client, {
        mode: "on",
        now: () => STALE,
        autoImplementEnabled: true,
        maxConcurrent: 10,
        maxArcDurationSec: 60, // STALE - 2026-01-01 ≫ 60s ⇒ capped.
        implementRunner: impl,
      });
      await responderTick(deps, createResponderState());

      // Capped → the next phase is NOT implemented.
      expect(impl.run).not.toHaveBeenCalled();
      expect(client.submitMergeRequest).not.toHaveBeenCalled();
      // Escalated with the partial payload naming the landed sha + the remaining phase.
      expect(client.escalateCalls).toHaveLength(1);
      expect(client.escalateCalls[0].id).toBe("e1");
      expect(client.escalateCalls[0].reason).toContain("exceeded max duration");
      expect(client.escalateCalls[0].reason).toContain("sha-1"); // landed phase preserved
      expect(client.escalateCalls[0].reason).toContain("Phase 2"); // remaining phase named
    });

    // ── Case 6: an all-landed arc at/over the deadline COMPLETES (not capped) — Refinement 4 ──
    it("all-landed arc over the duration deadline COMPLETES (arc_complete), NOT the duration cap", async () => {
      const thread = driveArcThread("e1", "2026-01-01T00:00:00.000Z"); // far past the deadline.
      const client = new FakeClient();
      client.listResults = [[]];
      const heldArc = mkEscalation("e1", {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      client.ackResults = [[heldArc], [heldArc]];
      client.getEscalation = vi.fn(async (): Promise<EscalationWithThread> => thread);
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      // BOTH phases landed (no arcComplete marker yet).
      client.mrResults = [
        [
          { id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "s1", branch: "b1", commitSha: "c1" },
          { id: "mr2", taskId: "task-2", escalationId: "e1", status: "landed", landedSha: "s2", branch: "b2", commitSha: "c2" },
        ],
      ];
      const impl = new FakeImplementRunner();
      const deps = baseDeps(client, {
        mode: "on",
        now: () => STALE,
        autoImplementEnabled: true,
        maxConcurrent: 10,
        maxArcDurationSec: 60, // would cap if reached — but arc_complete returns first.
        implementRunner: impl,
      });
      await responderTick(deps, createResponderState());

      // arc_complete fired (marker + resolve), NOT the duration escalate.
      const completeMarker = client.addMessageCalls.find((m) => m.metadata?.arcComplete === true);
      expect(completeMarker).toBeDefined();
      expect(client.resolve).toHaveBeenCalledTimes(1);
      // No duration-cap escalate.
      expect(client.escalateCalls.find((e) => e.reason.includes("exceeded max duration"))).toBeUndefined();
    });

    // ── Case 3a: generous/off default ⇒ A1-A3 byte-identical (cycle-1 implements) ──
    it("generous default caps ⇒ a systemic drive runs unchanged (no spurious budget escalate)", async () => {
      const client = new FakeClient();
      client.listResults = [[mkEscalation("e1")]];
      // No existing arcs ⇒ the probe counts 0.
      client.ackResults = [[], []];
      const runner = implementRunner("systemic");
      const drive = new FakeDriveRunner();
      drive.result = {
        kind: "vision_ready",
        visionPath: "roadmaps/v.md",
        epicName: "E",
        campaigns: [{ title: "C1", priority: "high", description: "d" }],
        durationMs: 1,
      };
      const deps = baseDeps(client, {
        mode: "on",
        now: () => STALE,
        autoImplementEnabled: true,
        // default maxConcurrentArcs=100 / maxArcDurationSec=604800 from baseDeps.
        runner,
        driveRunner: drive,
        acquireWorktree: () => new FakeWorktree(),
      });
      await responderTick(deps, createResponderState());

      // The drive ran + the epic was created — no budget hold.
      expect(drive.run).toHaveBeenCalledTimes(1);
      expect(client.createEpic).toHaveBeenCalledTimes(1);
      expect(client.escalateCalls.find((e) => e.reason.includes("auto-drive budget"))).toBeUndefined();
    });

    // ── Case 5: a normal arc under the caps is NOT falsely held/capped (advances) ──
    it("a normal arc within the caps advances normally (implements the next phase, no escalate)", async () => {
      const thread = driveArcThread("e1", "2026-06-13T23:00:00.000Z"); // 1h before STALE.
      const client = new FakeClient();
      client.listResults = [[]];
      const heldArc = mkEscalation("e1", {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-06-13T00:00:00.000Z", // stale ⇒ routed to advanceArc.
      });
      client.ackResults = [[heldArc], [heldArc]];
      client.getEscalation = vi.fn(async (): Promise<EscalationWithThread> => thread);
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      client.mrResults = [
        [{ id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "s1", branch: "b1", commitSha: "c1" }],
      ];
      const impl = new FakeImplementRunner();
      impl.result = { kind: "branch_ready", branch: "pm/escalation-e1-task-2", commitSha: "c", durationMs: 1 };
      const deps = baseDeps(client, {
        mode: "on",
        now: () => STALE,
        autoImplementEnabled: true,
        maxConcurrent: 10,
        maxConcurrentArcs: 5,
        maxArcDurationSec: 604800, // now well within the cap.
        implementRunner: impl,
      });
      await responderTick(deps, createResponderState());

      // Advanced normally — implemented the next phase, no budget/duration escalate.
      expect(impl.run).toHaveBeenCalledTimes(1);
      expect(client.submitMergeRequestCalls[0].body).toMatchObject({ taskId: "task-2" });
      expect(client.escalateCalls).toHaveLength(0);
    });

    // ── Case 4: the existing spawn budget still governs bounded implements ──
    it("a bounded implement with spawn budget exhausted is deferred by the EXISTING gate; the arc caps do NOT interfere", async () => {
      const client = new FakeClient();
      client.listResults = [[mkEscalation("e1")]];
      client.ackResults = [[], []]; // no in-flight arcs.
      const runner = implementRunner("bounded");
      const impl = new FakeImplementRunner();
      const state = createResponderState();
      // Pre-fill the spawn window to the cap so canSpawn gates this tick's spawn.
      state.spawnTimestamps = [STALE];
      const deps = baseDeps(client, {
        mode: "on",
        now: () => STALE,
        autoImplementEnabled: true,
        // generous arc caps ⇒ they never fire.
        maxConcurrentArcs: 100,
        spawnBudget: { maxSpawns: 1, windowSec: 3600 }, // already 1 spawn in window ⇒ exhausted.
        runner,
        implementRunner: impl,
      });
      await responderTick(deps, state);

      // The existing spawn-budget gate deferred the claim (no acknowledge, no spawn).
      expect(client.acknowledge).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
      expect(impl.run).not.toHaveBeenCalled();
      // NO arc-budget escalate (the arc caps did not interfere).
      expect(client.escalateCalls.find((e) => e.reason.includes("auto-drive budget"))).toBeUndefined();
    });

    // ── Case 7: answer-mode byte-identical when auto_implement off (Refinement 2 seal) ──
    it("answer-mode (autoImplementEnabled:false): the tick-start arc probe does NOT run — no extra getEscalation/listAcknowledgedByHolder fetches", async () => {
      const client = new FakeClient();
      // One open escalation answered normally; no acks.
      client.listResults = [[mkEscalation("e1")]];
      client.ackResults = [[]]; // ONE entry: only the reclaim pass consumes it.
      const runner = onRunner({ kind: "answered", answer: "A", durationMs: 1 });
      const deps = baseDeps(client, {
        mode: "on",
        // maxConcurrent>1 so the reclaim pass is reached (it would call
        // listAcknowledgedByHolder once); the probe — gated off — adds no call.
        maxConcurrent: 10,
        now: () => STALE,
        autoImplementEnabled: false, // answer-mode.
        runner,
      });
      await responderTick(deps, createResponderState());

      // listAcknowledgedByHolder is called ONCE (the reclaim pass only) — the probe
      // did NOT add a second call. (If the probe ran it would shift a 2nd ackResults
      // entry and be called twice.)
      expect(client.listAcknowledgedByHolder).toHaveBeenCalledTimes(1);
      // getEscalation is called ONCE — by the answering session for e1 — NOT by the
      // probe (which is gated off). The answer still posted (byte-identical path).
      expect(client.getEscalation).toHaveBeenCalledTimes(1);
      expect(client.answerCalls).toEqual([{ id: "e1", body: "A" }]);
    });
  });

  // ── A4 P3 — per-MR stall reclaim ──────────────────────────────────
  // ONE shared isMrStalled predicate at TWO wait points: the advanceArc step-(1)
  // re-park (a phase MR wedged queued/integrating → arc escalates instead of
  // re-parking forever — also RESCUES P1's whole-arc cap, which the re-park return
  // never reached) + the bounded pendingLand reclaim skip (reconcile-before-escalate).
  // Both server-derived (MR submit clock + status) ⇒ restart-resilient. The +Infinity
  // fail-safe (an absent/garbage timestamp NEVER stalls) is the correctness floor.
  describe("A4 P3 — per-MR stall reclaim", () => {
    const STALE = Date.parse("2026-06-14T00:00:00.000Z");
    const STALE_ENQUEUED = "2026-06-01T00:00:00.000Z"; // ≫ stallTimeout(60s)+grace before STALE.

    /** A self-held acknowledged arc thread carrying a pendingArc marker. */
    function arcThread(id: string): EscalationWithThread {
      return {
        ...mkEscalation(id, { status: "acknowledged", holderId: SELF }),
        messages: [
          {
            id: `${id}-m1`,
            escalationId: id,
            seq: 1,
            authorId: SELF,
            body: "arc in flight",
            messageType: "diagnosis",
            metadata: { pendingArc: true, epicId: "epic1" },
            createdAt: "2026-06-13T00:00:00.000Z",
          },
        ],
      };
    }

    /** A self-held acknowledged bounded thread carrying a pendingLand marker. */
    function pendingLandThread(id: string): EscalationWithThread {
      return {
        ...mkEscalation(id, { status: "acknowledged", holderId: SELF }),
        messages: [
          {
            id: `${id}-m1`,
            escalationId: id,
            seq: 1,
            authorId: SELF,
            body: "Implemented a bounded fix on branch ...",
            messageType: "diagnosis",
            metadata: { pendingLand: true, branch: `pm/escalation-${id}`, commitSha: "abc" },
            createdAt: "2026-06-13T00:00:00.000Z",
          },
        ],
      };
    }

    // ── Case 1: phase MR stalled → arc escalates (not stuck forever) ──
    it("a phase MR wedged in flight past the stall window → arc escalateToHuman naming the stalled MR + the preserved landed sha; NO implement spawn; does NOT merely re-park", async () => {
      const thread = arcThread("e1");
      const client = new FakeClient();
      client.listResults = [[]];
      const heldArc = mkEscalation("e1", {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-06-13T00:00:00.000Z", // stale ⇒ routed to advanceArc.
      });
      client.ackResults = [[heldArc], [heldArc]];
      client.getEscalation = vi.fn(async (): Promise<EscalationWithThread> => thread);
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [
          { id: "task-1", title: "Phase 1", description: "d1" },
          { id: "task-2", title: "Phase 2", description: "d2" },
        ],
      };
      // Phase 1 landed; phase 2 integrating with a STALE enqueuedAt (the wedge).
      client.mrResults = [
        [
          { id: "mr1", taskId: "task-1", escalationId: "e1", status: "landed", landedSha: "sha-1", branch: "b1", commitSha: "c1" },
          { id: "mr2", taskId: "task-2", escalationId: "e1", status: "integrating", landedSha: null, branch: "b2", commitSha: "c2", enqueuedAt: STALE_ENQUEUED },
        ],
      ];
      const impl = new FakeImplementRunner();
      const deps = baseDeps(client, {
        mode: "on",
        now: () => STALE,
        autoImplementEnabled: true,
        maxConcurrent: 10,
        stallTimeoutSec: 60, // STALE - STALE_ENQUEUED ≫ 60s+grace ⇒ stalled.
        implementRunner: impl,
      });
      await responderTick(deps, createResponderState());

      // Escalated (not re-parked), naming the stalled MR + the preserved landed sha.
      expect(client.escalateCalls).toHaveLength(1);
      expect(client.escalateCalls[0].id).toBe("e1");
      expect(client.escalateCalls[0].reason).toContain("STALLED");
      expect(client.escalateCalls[0].reason).toContain("mr2");
      expect(client.escalateCalls[0].reason).toContain("sha-1"); // landed phase preserved
      // The next phase was NOT implemented (we did not advance past the stall).
      expect(impl.run).not.toHaveBeenCalled();
      expect(client.submitMergeRequest).not.toHaveBeenCalled();
    });

    // ── Case 2: phase MR in flight but WITHIN the window → re-park, NOT reclaimed ──
    it("a phase MR in flight but WITHIN the stall window → re-park (no escalate, no spawn) — byte-identical to today's re-park", async () => {
      const thread = arcThread("e1");
      const client = new FakeClient();
      client.listResults = [[]];
      const heldArc = mkEscalation("e1", {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-06-13T00:00:00.000Z",
      });
      client.ackResults = [[heldArc], [heldArc]];
      client.getEscalation = vi.fn(async (): Promise<EscalationWithThread> => thread);
      client.epicResult = {
        id: "epic1",
        name: "E",
        tasks: [{ id: "task-1", title: "Phase 1", description: "d1" }],
      };
      // Phase 1 integrating with a RECENT enqueuedAt (within the window).
      client.mrResults = [
        [{ id: "mr1", taskId: "task-1", escalationId: "e1", status: "integrating", landedSha: null, branch: "b1", commitSha: "c1", enqueuedAt: "2026-06-13T23:59:00.000Z" }],
      ];
      const impl = new FakeImplementRunner();
      const deps = baseDeps(client, {
        mode: "on",
        now: () => STALE,
        autoImplementEnabled: true,
        maxConcurrent: 10,
        stallTimeoutSec: 86400, // 24h ≫ 1 min ⇒ within window ⇒ re-park.
        implementRunner: impl,
      });
      await responderTick(deps, createResponderState());

      expect(client.escalateToHuman).not.toHaveBeenCalled();
      expect(impl.run).not.toHaveBeenCalled();
      expect(client.submitMergeRequest).not.toHaveBeenCalled();
    });

    // ── Case 3: bounded pendingLand MR stalled → escalateToHuman + branch preserved ──
    it("a bounded pendingLand MR wedged past the stall window → escalateToHuman (branch preserved); no read-only re-spawn", async () => {
      const client = new FakeClient();
      client.listResults = [[]];
      const stale = mkEscalation("r1", {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-06-13T00:00:00.000Z",
      });
      client.ackResults = [[stale], [stale]]; // probe + reclaim.
      client.getEscalation = vi.fn(async (): Promise<EscalationWithThread> => pendingLandThread("r1"));
      // The bounded MR is queued with a STALE enqueuedAt.
      client.mrResults = [
        [{ id: "mrB", taskId: null, escalationId: "r1", status: "queued", landedSha: null, branch: "pm/escalation-r1", commitSha: "abc", enqueuedAt: STALE_ENQUEUED }],
      ];
      const runner = onRunner({ kind: "needs_human", reason: "x", durationMs: 1 });
      const deps = baseDeps(client, {
        mode: "on",
        maxConcurrent: 10,
        autoImplementEnabled: true,
        runner,
        now: () => STALE,
        stallTimeoutSec: 60, // ⇒ stalled.
      });
      await responderTick(deps, createResponderState());

      // Escalated naming the wedged MR; the read-only session was NOT re-spawned.
      expect(client.escalateCalls).toHaveLength(1);
      expect(client.escalateCalls[0].id).toBe("r1");
      expect(client.escalateCalls[0].reason).toContain("mrB");
      expect(client.escalateCalls[0].reason).toContain("not landed");
      expect(runner.run).not.toHaveBeenCalled();
    });

    // ── Case 4: bounded pendingLand within window → still skipped (byte-identical) ──
    it("a bounded pendingLand MR within the stall window → still SKIPPED (no escalate, no spawn)", async () => {
      const client = new FakeClient();
      client.listResults = [[]];
      const stale = mkEscalation("r1", {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-06-13T00:00:00.000Z",
      });
      client.ackResults = [[stale], [stale]];
      client.getEscalation = vi.fn(async (): Promise<EscalationWithThread> => pendingLandThread("r1"));
      client.mrResults = [
        [{ id: "mrB", taskId: null, escalationId: "r1", status: "queued", landedSha: null, branch: "pm/escalation-r1", commitSha: "abc", enqueuedAt: "2026-06-13T23:59:00.000Z" }],
      ];
      const runner = onRunner({ kind: "needs_human", reason: "x", durationMs: 1 });
      const deps = baseDeps(client, {
        mode: "on",
        maxConcurrent: 10,
        autoImplementEnabled: true,
        runner,
        now: () => STALE,
        stallTimeoutSec: 86400, // ⇒ within window.
      });
      await responderTick(deps, createResponderState());

      expect(client.escalateToHuman).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
    });

    // ── Case 5: reconcile (landed out-of-band) → no escalate ──
    it("reconcile-before-escalate: a landed MR exists for the pendingLand escalation → no escalate (the A2 post-back is responsible)", async () => {
      const client = new FakeClient();
      client.listResults = [[]];
      const stale = mkEscalation("r1", {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-06-13T00:00:00.000Z",
      });
      client.ackResults = [[stale], [stale]];
      client.getEscalation = vi.fn(async (): Promise<EscalationWithThread> => pendingLandThread("r1"));
      // A landed MR exists for the escalation (landed out-of-band) — even though a
      // sibling queued MR is stale, reconcile-first wins → no escalate.
      client.mrResults = [
        [
          { id: "mrLanded", taskId: null, escalationId: "r1", status: "landed", landedSha: "sha-X", branch: "pm/escalation-r1", commitSha: "abc" },
          { id: "mrStale", taskId: null, escalationId: "r1", status: "queued", landedSha: null, branch: "pm/escalation-r1b", commitSha: "def", enqueuedAt: STALE_ENQUEUED },
        ],
      ];
      const runner = onRunner({ kind: "needs_human", reason: "x", durationMs: 1 });
      const deps = baseDeps(client, {
        mode: "on",
        maxConcurrent: 10,
        autoImplementEnabled: true,
        runner,
        now: () => STALE,
        stallTimeoutSec: 60,
      });
      await responderTick(deps, createResponderState());

      expect(client.escalateToHuman).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
    });

    // ── Case 7: fail-safe (BINDING NOTE 1) — empty/garbage timestamp NEVER stalls ──
    it("fail-safe: a pendingLand MR with empty/garbage enqueuedAt+createdAt is NEVER stall-reclaimed (the +Infinity direction, not 0)", async () => {
      const client = new FakeClient();
      client.listResults = [[]];
      const stale = mkEscalation("r1", {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-06-13T00:00:00.000Z",
      });
      client.ackResults = [[stale], [stale]];
      client.getEscalation = vi.fn(async (): Promise<EscalationWithThread> => pendingLandThread("r1"));
      // Garbage enqueuedAt AND createdAt ⇒ submitClockMs → +Infinity ⇒ never stalls.
      client.mrResults = [
        [{ id: "mrB", taskId: null, escalationId: "r1", status: "queued", landedSha: null, branch: "pm/escalation-r1", commitSha: "abc", enqueuedAt: "not-a-date", createdAt: "also-garbage" }],
      ];
      const runner = onRunner({ kind: "needs_human", reason: "x", durationMs: 1 });
      const deps = baseDeps(client, {
        mode: "on",
        maxConcurrent: 10,
        autoImplementEnabled: true,
        runner,
        now: () => STALE,
        stallTimeoutSec: 60, // tiny ⇒ a `0` fallback would ALWAYS stall — proves +Infinity.
      });
      await responderTick(deps, createResponderState());

      expect(client.escalateToHuman).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
    });

    // ── Case 6: off mode is silent on a stalled bounded MR ──
    it("mode=off: a stalled pendingLand MR is silent (no escalate)", async () => {
      const client = new FakeClient();
      client.listResults = [[]];
      const stale = mkEscalation("r1", {
        status: "acknowledged",
        holderId: SELF,
        updatedAt: "2026-06-13T00:00:00.000Z",
      });
      client.ackResults = [[stale], [stale]];
      client.getEscalation = vi.fn(async (): Promise<EscalationWithThread> => pendingLandThread("r1"));
      client.mrResults = [
        [{ id: "mrB", taskId: null, escalationId: "r1", status: "queued", landedSha: null, branch: "pm/escalation-r1", commitSha: "abc", enqueuedAt: STALE_ENQUEUED }],
      ];
      const deps = baseDeps(client, {
        mode: "off",
        maxConcurrent: 10,
        autoImplementEnabled: true,
        now: () => STALE,
        stallTimeoutSec: 60,
      });
      await responderTick(deps, createResponderState());

      expect(client.escalateToHuman).not.toHaveBeenCalled();
    });
  });
});
