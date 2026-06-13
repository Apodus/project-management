import { describe, it, expect, vi } from "vitest";
import { responderTick, createResponderState, type ResponderDeps } from "../src/loop.js";
import { PmApiError } from "../src/api-client.js";
import type { Escalation } from "@pm/shared";
import type { Logger } from "../src/logger.js";

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
}

function baseDeps(client: FakeClient, over: Partial<ResponderDeps> = {}): ResponderDeps {
  return {
    client,
    logger: silentLogger,
    projectIds: ["p"],
    selfId: SELF,
    enabled: true,
    maxConcurrent: 1,
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
});
