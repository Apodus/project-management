import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { wakeTick, createWakeState, type WakeDeps } from "../src/loop.js";
import { PmApiError } from "../src/api-client.js";
import type { WorkerRunner, WorkerRunResult, WorkerRunInput } from "../src/worker-runner.js";
import type { Escalation, EscalationMessage, UndeliveredEscalation } from "@pm/shared";
import type { Logger } from "../src/logger.js";

// ── Fakes ──────────────────────────────────────────────────────────

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function mkEscalation(id: string, createdAt = "2026-06-13T00:00:00.000Z"): Escalation {
  return {
    id,
    projectId: "p",
    kind: "question",
    status: "answered",
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
    createdAt,
    updatedAt: createdAt,
    resolvedAt: null,
    resolvedBy: null,
  };
}

function mkMsg(escalationId: string, seq: number, createdAt: string): EscalationMessage {
  return {
    id: `${escalationId}-m${seq}`,
    escalationId,
    seq,
    authorId: "human",
    body: `reply ${seq}`,
    messageType: "reply",
    metadata: null,
    createdAt,
  };
}

function undelivered(esc: Escalation, msgs: EscalationMessage[]): UndeliveredEscalation {
  return { escalation: esc, unreadMessages: msgs, unreadCount: msgs.length };
}

class FakeClient {
  listResults: UndeliveredEscalation[][] = [];
  listError: unknown;
  marks: { escalationId: string; workerKey: string; uptoSeq: number }[] = [];
  markError: ((escalationId: string) => unknown) | undefined;

  listUndelivered = vi.fn(async (): Promise<UndeliveredEscalation[]> => {
    if (this.listError) throw this.listError;
    return this.listResults.shift() ?? [];
  });

  markDelivered = vi.fn(async (escalationId: string, workerKey: string, uptoSeq: number) => {
    const err = this.markError?.(escalationId);
    if (err) throw err;
    this.marks.push({ escalationId, workerKey, uptoSeq });
    return mkEscalation(escalationId);
  });
}

class FakeRunner implements WorkerRunner {
  calls: WorkerRunInput[] = [];
  result: WorkerRunResult = { kind: "ok", durationMs: 1 };
  /** When set, run() awaits this before resolving (blocking-runner case). */
  gate: Promise<void> | undefined;
  run = vi.fn(async (input: WorkerRunInput): Promise<WorkerRunResult> => {
    this.calls.push(input);
    if (this.gate) await this.gate;
    return this.result;
  });
}

function baseDeps(client: FakeClient, runner: FakeRunner, over: Partial<WakeDeps> = {}): WakeDeps {
  return {
    client,
    runner,
    logger: silentLogger,
    watch: [{ workerKey: "wk" }],
    workerCommand: "claude -p",
    workerCwd: mkdtempSync(path.join(tmpdir(), "wake-loop-")),
    timeBudgetSec: 900,
    maxConcurrentWakes: 1,
    minWakeIntervalSec: 60,
    maxConsecutiveFailures: 3,
    promptTemplate: "esc={escalation} msgs={messages}",
    logsDir: mkdtempSync(path.join(tmpdir(), "wake-logs-")),
    now: () => 1_000_000,
    ...over,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("wakeTick", () => {
  it("one unread → exactly one spawn (seeded prompt) + one markDelivered(maxSeq, wk)", async () => {
    const client = new FakeClient();
    const runner = new FakeRunner();
    const esc = mkEscalation("e1");
    client.listResults = [
      [undelivered(esc, [mkMsg("e1", 3, "2026-06-13T01:00:00.000Z"), mkMsg("e1", 5, "2026-06-13T02:00:00.000Z")])],
    ];
    const state = createWakeState();
    await wakeTick(baseDeps(client, runner), state);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.calls[0].prompt).toContain("e1");
    expect(runner.calls[0].prompt).toContain("reply 5");
    expect(client.marks).toEqual([{ escalationId: "e1", workerKey: "wk", uptoSeq: 5 }]);
  });

  it("no unread → no spawn / no mark", async () => {
    const client = new FakeClient();
    const runner = new FakeRunner();
    client.listResults = [[undelivered(mkEscalation("e1"), [])]];
    await wakeTick(baseDeps(client, runner), createWakeState());
    expect(runner.run).not.toHaveBeenCalled();
    expect(client.marks).toEqual([]);
  });

  it("lastUptoSeq prevents a double-spawn for the same maxSeq across ticks", async () => {
    const client = new FakeClient();
    const runner = new FakeRunner();
    const esc = mkEscalation("e1");
    const item = undelivered(esc, [mkMsg("e1", 4, "2026-06-13T01:00:00.000Z")]);
    client.listResults = [[item], [item]];
    const state = createWakeState();
    await wakeTick(baseDeps(client, runner), state);
    await wakeTick(baseDeps(client, runner, { now: () => 9_000_000 }), state);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(client.marks).toHaveLength(1);
  });

  it("maxConcurrentWakes=1 + a blocking runner → only one in flight", async () => {
    const client = new FakeClient();
    const runner = new FakeRunner();
    let release!: () => void;
    runner.gate = new Promise<void>((r) => (release = r));
    client.listResults = [
      [
        undelivered(mkEscalation("e1", "2026-06-13T00:00:00.000Z"), [
          mkMsg("e1", 1, "2026-06-13T01:00:00.000Z"),
        ]),
        undelivered(mkEscalation("e2", "2026-06-13T00:00:01.000Z"), [
          mkMsg("e2", 1, "2026-06-13T01:00:01.000Z"),
        ]),
      ],
    ];
    const state = createWakeState();
    const tick = wakeTick(baseDeps(client, runner), state);
    // Let the first spawn start; the second must be gated by the semaphore.
    await Promise.resolve();
    expect(runner.run).toHaveBeenCalledTimes(1);
    release();
    await tick;
    // Only one spawned this tick (the second reappears next tick).
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("a poll error is non-fatal (tick resolves, other ticks recover)", async () => {
    const client = new FakeClient();
    const runner = new FakeRunner();
    client.listError = new PmApiError(0, "NETWORK", "down");
    const state = createWakeState();
    await expect(wakeTick(baseDeps(client, runner), state)).resolves.toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
    // Recovery: clear the error, real data flows.
    client.listError = undefined;
    client.listResults = [[undelivered(mkEscalation("e1"), [mkMsg("e1", 1, "2026-06-13T01:00:00.000Z")])]];
    await wakeTick(baseDeps(client, runner), state);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("a spawn error → no markDelivered + re-wakes after cooldown", async () => {
    const client = new FakeClient();
    const runner = new FakeRunner();
    runner.result = { kind: "error", reason: "spawn_error", durationMs: 1 };
    const item = undelivered(mkEscalation("e1"), [mkMsg("e1", 2, "2026-06-13T01:00:00.000Z")]);
    client.listResults = [[item], [item], [item]];
    const state = createWakeState();
    await wakeTick(baseDeps(client, runner), state);
    expect(client.marks).toEqual([]); // no mark on failure
    // Within cooldown → skipped.
    await wakeTick(baseDeps(client, runner, { now: () => 1_000_000 + 30_000 }), state);
    expect(runner.run).toHaveBeenCalledTimes(1);
    // Past cooldown → re-wakes.
    await wakeTick(baseDeps(client, runner, { now: () => 1_000_000 + 61_000 }), state);
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(client.marks).toEqual([]);
  });

  it("give-up: N consecutive failures park the escalation until maxSeq advances", async () => {
    const client = new FakeClient();
    const runner = new FakeRunner();
    runner.result = { kind: "error", reason: "nonzero_exit", durationMs: 1 };
    const item = undelivered(mkEscalation("e1"), [mkMsg("e1", 2, "2026-06-13T01:00:00.000Z")]);
    // maxConsecutiveFailures = 3.
    const state = createWakeState();
    let t = 1_000_000;
    for (let i = 0; i < 6; i++) {
      client.listResults = [[item]];
      await wakeTick(baseDeps(client, runner, { now: () => t }), state);
      t += 61_000; // past cooldown each time
    }
    // Exactly 3 spawns before parking; subsequent ticks are no-ops.
    expect(runner.run).toHaveBeenCalledTimes(3);

    // A new reply (higher maxSeq) un-parks → spawns again.
    runner.result = { kind: "ok", durationMs: 1 };
    client.listResults = [
      [undelivered(mkEscalation("e1"), [mkMsg("e1", 7, "2026-06-13T05:00:00.000Z")])],
    ];
    await wakeTick(baseDeps(client, runner, { now: () => t + 61_000 }), state);
    expect(runner.run).toHaveBeenCalledTimes(4);
    expect(client.marks).toEqual([{ escalationId: "e1", workerKey: "wk", uptoSeq: 7 }]);
  });

  it("markDelivered 403 → park, no retry (cursor stays advanced)", async () => {
    const client = new FakeClient();
    const runner = new FakeRunner();
    client.markError = () => new PmApiError(403, "FORBIDDEN", "wrong worker");
    const item = undelivered(mkEscalation("e1"), [mkMsg("e1", 2, "2026-06-13T01:00:00.000Z")]);
    client.listResults = [[item], [item]];
    const state = createWakeState();
    await wakeTick(baseDeps(client, runner), state);
    expect(runner.run).toHaveBeenCalledTimes(1);
    // Same maxSeq, past cooldown — must NOT re-wake (cursor parked).
    await wakeTick(baseDeps(client, runner, { now: () => 1_000_000 + 120_000 }), state);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("markDelivered 5xx → cursor NOT advanced, re-marks after cooldown", async () => {
    const client = new FakeClient();
    const runner = new FakeRunner();
    let calls = 0;
    client.markError = () => (calls++ === 0 ? new PmApiError(503, "X", "transient") : undefined);
    const item = undelivered(mkEscalation("e1"), [mkMsg("e1", 2, "2026-06-13T01:00:00.000Z")]);
    client.listResults = [[item], [item]];
    const state = createWakeState();
    await wakeTick(baseDeps(client, runner), state);
    expect(client.marks).toEqual([]); // first mark threw
    // Past cooldown → re-wake + re-mark succeeds.
    await wakeTick(baseDeps(client, runner, { now: () => 1_000_000 + 61_000 }), state);
    expect(client.marks).toEqual([{ escalationId: "e1", workerKey: "wk", uptoSeq: 2 }]);
  });

  it("processes oldest-unread-first under a saturated semaphore", async () => {
    const client = new FakeClient();
    const runner = new FakeRunner();
    // e_late has a NEWER oldest-unread; e_early older — early must spawn first.
    const eEarly = undelivered(mkEscalation("eEarly", "2026-06-13T00:00:00.000Z"), [
      mkMsg("eEarly", 1, "2026-06-13T01:00:00.000Z"),
    ]);
    const eLate = undelivered(mkEscalation("eLate", "2026-06-13T00:00:00.000Z"), [
      mkMsg("eLate", 1, "2026-06-13T09:00:00.000Z"),
    ]);
    // Present out of order to prove the sort.
    client.listResults = [[eLate, eEarly]];
    const state = createWakeState();
    await wakeTick(baseDeps(client, runner, { maxConcurrentWakes: 1 }), state);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.calls[0].escalation.id).toBe("eEarly");
  });
});
