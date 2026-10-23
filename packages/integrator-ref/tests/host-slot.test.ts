import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertQueueWritable,
  commandIdentityProbe,
  createHostSlots,
  describeQueue,
  HostSlotAbortedError,
  isLive,
  parseHostSlotConfig,
  parseIdentityOutput,
  TicketStore,
  type HostSlotConfig,
  type IdentityProbe,
  type ProcessIdentity,
  type TicketDoc,
} from "../src/host-slot.js";
import { runPipeline } from "../src/verify-pipeline.js";
import type { GitOps } from "../src/git-ops.js";

/**
 * C4-P2: the host verify semaphore. Real tickets on a real temp directory; the
 * identity probe and the kill are stubs the test controls (the real probe is
 * game_one's process_identity.ps1, exercised by commandIdentityProbe below and
 * by game_one's tools/host/test_host_slot_identity.ps1).
 */

let dir: string;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** pid -> identity; anything absent is "no such process". */
function stubProbe(table: Map<number, ProcessIdentity>): IdentityProbe & { calls: number[][] } {
  const calls: number[][] = [];
  const probe = (async (pids: number[]) => {
    calls.push([...pids]);
    return new Map(pids.map((p) => [p, table.get(p) ?? { alive: false, ticks: null }]));
  }) as IdentityProbe & { calls: number[][] };
  probe.calls = calls;
  return probe;
}

const cfg = (count = 1): HostSlotConfig => ({ dir, count, identityCommand: ["unused"] });

function slots(
  selfPid: number,
  table: Map<number, ProcessIdentity>,
  count = 1,
  kill?: (pid: number) => void,
) {
  table.set(selfPid, { alive: true, ticks: `${selfPid}000` });
  return createHostSlots({
    config: cfg(count),
    lane: `lane-${selfPid}`,
    logger: quiet,
    probe: stubProbe(table),
    pollMs: 10,
    self: { pid: selfPid, startTicks: `${selfPid}000` },
    kill,
  });
}

/** A ticket written directly, as another host process would have. */
function plantTicket(seq: number, doc: Partial<TicketDoc>): string {
  mkdirSync(path.join(dir, "queue"), { recursive: true });
  const full: TicketDoc = {
    schema: 1,
    seq,
    lane: "other",
    pid: 9000 + seq,
    startTicks: "1",
    requestId: `req-${seq}`,
    enqueuedAt: new Date().toISOString(),
    state: "active",
    children: [],
    ...doc,
  };
  const file = path.join(dir, "queue", `${String(seq).padStart(12, "0")}.ticket`);
  writeFileSync(file, JSON.stringify(full));
  return file;
}

const ticketDocs = (): TicketDoc[] => new TicketStore(dir).list().map((e) => e.doc as TicketDoc);

const settled = async <T>(p: Promise<T>, ms = 150): Promise<boolean> => {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((r) => setTimeout(r, ms));
  return done;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "host-slot-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("host slots: the bound", () => {
  it("one contender acquires at once; its ticket goes active -> released", async () => {
    const hs = slots(100, new Map());
    const hold = await hs.lease("r1").acquire();
    expect(ticketDocs().map((d) => d.state)).toEqual(["active"]);
    expect(hs.snapshot()).toMatchObject([{ request_id: "r1", state: "held", position: 0 }]);
    hold.release();
    expect(ticketDocs().map((d) => d.state)).toEqual(["released"]);
    expect(hs.snapshot()).toEqual([]);
  });

  it("count 1: a second verify waits until the first releases", async () => {
    const table = new Map<number, ProcessIdentity>();
    const a = slots(100, table);
    const b = slots(200, table);
    const holdA = await a.lease("ra").acquire();
    const pB = b.lease("rb").acquire();
    expect(await settled(pB)).toBe(false);
    expect(b.snapshot()).toMatchObject([
      { request_id: "rb", state: "waiting", position: 1, holder_lane: "lane-100", holder_pid: 100 },
    ]);
    holdA.release();
    const holdB = await pB;
    holdB.release();
  });

  it("count 2 with three contenders: the third waits", async () => {
    const table = new Map<number, ProcessIdentity>();
    const [a, b, c] = [slots(100, table, 2), slots(200, table, 2), slots(300, table, 2)];
    const ha = await a.lease("ra").acquire();
    const hb = await b.lease("rb").acquire();
    const pc = c.lease("rc").acquire();
    expect(await settled(pc)).toBe(false);
    hb.release();
    (await pc).release();
    ha.release();
  });

  it("FIFO by sequence: a new ticket takes max(seq)+1, never a free lower number", async () => {
    // A live holder at seq 5 and nothing below it. Allocating the first free
    // number (1) would sort the newcomer AHEAD of the holder: two verifies at once.
    const table = new Map<number, ProcessIdentity>([[42, { alive: true, ticks: "1" }]]);
    plantTicket(5, { pid: 42, lane: "holder" });
    const hs = slots(100, table);
    const p = hs.lease("r").acquire();
    expect(await settled(p)).toBe(false);
    expect(hs.snapshot()[0]).toMatchObject({ seq: 6, position: 1, holder_lane: "holder" });
  });

  it("FIFO by sequence: the holder is the lowest seq, not the oldest file", async () => {
    const table = new Map<number, ProcessIdentity>([
      [41, { alive: true, ticks: "1" }],
      [42, { alive: true, ticks: "1" }],
    ]);
    // seq 2 written first (older mtime), seq 1 written later (newer mtime).
    const two = plantTicket(2, { pid: 42, lane: "second" });
    utimesSync(two, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    plantTicket(1, { pid: 41, lane: "first" });
    const hs = slots(100, table);
    void hs.lease("r").acquire();
    await new Promise((r) => setTimeout(r, 50));
    expect(hs.snapshot()[0]).toMatchObject({ position: 2, holder_lane: "first", holder_pid: 41 });
  });

  it("a released seq is never reused", async () => {
    const hs = slots(100, new Map());
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const h = await hs.lease(`r${i}`).acquire();
      seqs.push(hs.snapshot()[0].seq);
      h.release();
    }
    expect(seqs).toEqual([1, 2, 3]);
    expect(readdirSync(path.join(dir, "queue")).filter((f) => f.endsWith(".ticket"))).toHaveLength(
      3,
    );
  });

  it("the lease is shared: two acquirers (a group's inner + outer) hold ONE ticket", async () => {
    const table = new Map<number, ProcessIdentity>();
    const hs = slots(100, table);
    const lease = hs.lease("group-1");
    const [h1, h2] = await Promise.all([lease.acquire(), lease.acquire()]);
    expect(ticketDocs()).toHaveLength(1);
    h1.release();
    expect(ticketDocs()[0].state).toBe("active");
    h2.release();
    expect(ticketDocs()[0].state).toBe("released");
  });
});

describe("host slots: liveness and reclaim", () => {
  it("PID reuse is not liveness: same pid, different start ticks -> reclaimed", async () => {
    const table = new Map<number, ProcessIdentity>([[42, { alive: true, ticks: "999" }]]);
    plantTicket(1, { pid: 42, startTicks: "111" });
    const hs = slots(100, table);
    const hold = await hs.lease("r").acquire();
    const docs = ticketDocs();
    expect(docs[0]).toMatchObject({
      state: "reclaimed",
      reclaimedBy: { lane: "lane-100", pid: 100 },
    });
    hold.release();
  });

  it("an unreadable identity is LIVE: never reclaimed", async () => {
    const table = new Map<number, ProcessIdentity>([[42, { alive: true, ticks: null }]]);
    plantTicket(1, { pid: 42, startTicks: "111" });
    const hs = slots(100, table);
    const p = hs.lease("r").acquire();
    expect(await settled(p)).toBe(false);
    expect(ticketDocs()[0].state).toBe("active");
  });

  it("a dead holder's verify tree is killed only when its identity STILL matches at kill time", async () => {
    // Child 501 is the same process (ticks match on the fresh read): killed.
    // Child 502 matched when recorded but is recycled by kill time: NOT killed.
    const table = new Map<number, ProcessIdentity>([
      [501, { alive: true, ticks: "5010" }],
      [502, { alive: true, ticks: "7777" }],
    ]);
    plantTicket(1, {
      pid: 42,
      children: [
        { pid: 501, startTicks: "5010" },
        { pid: 502, startTicks: "5020" },
      ],
    });
    const killed: number[] = [];
    const hs = slots(100, table, 1, async (pid) => {
      killed.push(pid);
      table.delete(pid); // the kill worked: the process is gone
    });
    (await hs.lease("r").acquire()).release();
    expect(killed).toEqual([501]);
    expect(ticketDocs()[0].state).toBe("reclaimed");
  });

  it("an orphan tree that SURVIVES its kill keeps the slot: no second verify starts beside it", async () => {
    const table = new Map<number, ProcessIdentity>([[501, { alive: true, ticks: "5010" }]]);
    plantTicket(1, { pid: 42, children: [{ pid: 501, startTicks: "5010" }] });
    const killed: number[] = [];
    const hs = slots(100, table, 1, async (pid) => {
      killed.push(pid); // taskkill ran, but the process is still the same one
    });
    const p = hs.lease("r").acquire();
    expect(await settled(p)).toBe(false);
    expect(killed.length).toBeGreaterThan(0);
    expect(ticketDocs()[0].state).toBe("active");
    expect(hs.snapshot()[0]).toMatchObject({ state: "waiting", position: 1, holder_pid: 42 });
    // Once it is really gone, the next poll reclaims and acquires.
    table.delete(501);
    (await p).release();
    expect(ticketDocs()[0].state).toBe("reclaimed");
  });

  it("a child recorded with an unreadable identity is never killed", async () => {
    const table = new Map<number, ProcessIdentity>([[501, { alive: true, ticks: "5010" }]]);
    plantTicket(1, { pid: 42, children: [{ pid: 501, startTicks: null }] });
    const killed: number[] = [];
    const hs = slots(100, table, 1, (pid) => killed.push(pid));
    (await hs.lease("r").acquire()).release();
    expect(killed).toEqual([]);
  });

  it("two contenders reclaiming the same dead holder at once: exactly one holds", async () => {
    const table = new Map<number, ProcessIdentity>();
    plantTicket(1, { pid: 42 });
    const a = slots(100, table);
    const b = slots(200, table);
    const pa = a.lease("ra").acquire();
    const pb = b.lease("rb").acquire();
    await new Promise((r) => setTimeout(r, 150));
    const held = [a, b].filter((s) => s.snapshot()[0]?.state === "held");
    expect(held).toHaveLength(1);
    expect(ticketDocs()[0].state).toBe("reclaimed");
    (await Promise.race([pa, pb])).release();
    (await pa.catch(() => null))?.release();
    (await pb.catch(() => null))?.release();
  });

  it("isLive: the identity rule", () => {
    expect(isLive("1", { alive: true, ticks: "1" })).toBe(true);
    expect(isLive("1", { alive: true, ticks: "2" })).toBe(false);
    expect(isLive("1", { alive: false, ticks: null })).toBe(false);
    expect(isLive("1", { alive: true, ticks: null })).toBe(true);
    expect(isLive(null, { alive: true, ticks: "2" })).toBe(true);
  });
});

describe("host slots: waiting", () => {
  it("cancellation while waiting rejects and ends the ticket", async () => {
    const table = new Map<number, ProcessIdentity>([[42, { alive: true, ticks: "1" }]]);
    plantTicket(1, { pid: 42 });
    const hs = slots(100, table);
    const ac = new AbortController();
    const p = hs.lease("r").acquire({ signal: ac.signal });
    await new Promise((r) => setTimeout(r, 40));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(HostSlotAbortedError);
    expect(ticketDocs().map((d) => d.state)).toEqual(["active", "released"]);
    expect(hs.snapshot()).toEqual([]);
  });

  it("waiting stamps the liveness box (the stall watchdog must not kill a queued member)", async () => {
    const table = new Map<number, ProcessIdentity>([[42, { alive: true, ticks: "1" }]]);
    plantTicket(1, { pid: 42 });
    const hs = slots(100, table);
    const liveness = { lastOutputAt: 0 };
    void hs.lease("r").acquire({ liveness });
    await new Promise((r) => setTimeout(r, 60));
    expect(Date.now() - liveness.lastOutputAt).toBeLessThan(1_000);
  });

  it("the held entry keeps waited_ms (a stall check subtracts it after acquire)", async () => {
    const table = new Map<number, ProcessIdentity>([[42, { alive: true, ticks: "1" }]]);
    const holder = plantTicket(1, { pid: 42 });
    const hs = slots(100, table);
    const p = hs.lease("r").acquire();
    await new Promise((r) => setTimeout(r, 120));
    writeFileSync(
      holder,
      JSON.stringify({ ...JSON.parse(readFileSync(holder, "utf8")), state: "released" }),
    );
    const hold = await p;
    const [view] = hs.snapshot();
    expect(view.state).toBe("held");
    expect(view.waited_ms).toBeGreaterThanOrEqual(100);
    hold.release();
  });
});

describe("runPipeline under the host slot", () => {
  const steps = [{ id: "verify", command: "x", depends_on: [], cache_key_inputs: [] }];
  const ctxBase = { cwd: "/wt", verifyTimeoutSec: 60, logsDir: dir, attemptId: "a1" };

  it("the slot is released after a throwing verify", async () => {
    const hs = slots(100, new Map());
    const gitOps = {
      runVerify: async () => {
        throw new Error("spawn exploded");
      },
      readLogTail: async () => "",
    } as unknown as GitOps;
    await expect(
      runPipeline(steps, { ...ctxBase, logsDir: dir, gitOps, hostSlot: hs.lease("r") }),
    ).rejects.toThrow(/spawn exploded/);
    expect(ticketDocs().map((d) => d.state)).toEqual(["released"]);
  });

  it("records the spawned verify shell in the ticket, and releases after a pass", async () => {
    const table = new Map<number, ProcessIdentity>([[4321, { alive: true, ticks: "43210" }]]);
    const hs = slots(100, table);
    let childrenWhileRunning: TicketDoc["children"] = [];
    const gitOps = {
      runVerify: async (_c: string, _t: number, o: { onSpawn?: (pid: number) => void }) => {
        o.onSpawn?.(4321);
        await new Promise((r) => setTimeout(r, 50));
        childrenWhileRunning = ticketDocs()[0].children;
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
          logPath: "",
        };
      },
      readLogTail: async () => "",
    } as unknown as GitOps;
    const res = await runPipeline(steps, {
      ...ctxBase,
      logsDir: dir,
      gitOps,
      hostSlot: hs.lease("r"),
    });
    expect(res.outcome).toBe("pass");
    expect(childrenWhileRunning).toEqual([{ pid: 4321, startTicks: "43210" }]);
    expect(ticketDocs()[0].state).toBe("released");
  });

  it("a queue that cannot be written is INFRA: a spawn-failure-shaped (transient) result, nothing ran", async () => {
    const blocker = path.join(dir, "not-a-dir");
    writeFileSync(blocker, "");
    const table = new Map<number, ProcessIdentity>();
    table.set(100, { alive: true, ticks: "100000" });
    const hs = createHostSlots({
      config: { dir: path.join(blocker, "slots"), count: 1, identityCommand: ["unused"] },
      lane: "lane-100",
      logger: quiet,
      probe: stubProbe(table),
      pollMs: 10,
      self: { pid: 100, startTicks: "100000" },
    });
    let ran = false;
    const gitOps = {
      runVerify: async () => {
        ran = true;
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
          logPath: "",
        };
      },
      readLogTail: async () => "",
    } as unknown as GitOps;
    const res = await runPipeline(steps, {
      ...ctxBase,
      logsDir: dir,
      gitOps,
      hostSlot: hs.lease("r"),
    });
    expect(ran).toBe(false);
    expect(res.outcome).toBe("fail");
    expect(res.failingStep?.verify.spawnError).toMatch(/host verify-slot queue failed/);
  });

  it("a pass cancelled while waiting runs NOTHING and reads as a killed verify", async () => {
    const table = new Map<number, ProcessIdentity>([[42, { alive: true, ticks: "1" }]]);
    plantTicket(1, { pid: 42 });
    const hs = slots(100, table);
    let ran = false;
    const gitOps = {
      runVerify: async () => {
        ran = true;
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
          logPath: "",
        };
      },
      readLogTail: async () => "",
    } as unknown as GitOps;
    const ac = new AbortController();
    const p = runPipeline(steps, {
      ...ctxBase,
      logsDir: dir,
      gitOps,
      hostSlot: hs.lease("r"),
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 40));
    ac.abort();
    const res = await p;
    expect(ran).toBe(false);
    expect(res.outcome).toBe("fail");
    expect(res.failingStep?.verify.signal).toBe("SIGTERM");
    expect(res.failingStep?.verify.stderr).toMatch(/waited for a host verify slot/);
  });
});

describe("host slots: config and the identity probe", () => {
  it("assertQueueWritable: the boot check creates the queue and refuses an unusable dir", () => {
    assertQueueWritable(dir);
    expect(readdirSync(path.join(dir, "queue"))).toEqual([]);
    const blocker = path.join(dir, "file");
    writeFileSync(blocker, "");
    expect(() => assertQueueWritable(path.join(blocker, "x"))).toThrow();
  });

  it("parseHostSlotConfig refuses what would silently give two lanes two semaphores", () => {
    const ok = {
      dir: "D:\\pm-host-slots",
      count: 1,
      identityCommand: ["powershell", "-File", "x.ps1"],
    };
    expect(parseHostSlotConfig(ok)).toEqual(ok);
    expect(parseHostSlotConfig({ ...ok, dir: "/var/pm-host-slots" }).dir).toBe(
      "/var/pm-host-slots",
    );
    expect(() => parseHostSlotConfig({ ...ok, dir: "pm-host-slots" })).toThrow(/ABSOLUTE/);
    expect(() => parseHostSlotConfig({ ...ok, count: 0 })).toThrow(/count/);
    expect(() => parseHostSlotConfig({ ...ok, count: 1.5 })).toThrow(/count/);
    expect(() => parseHostSlotConfig({ ...ok, identityCommand: [] })).toThrow(/identityCommand/);
    expect(() => parseHostSlotConfig({ ...ok, identityCommand: "powershell x.ps1" })).toThrow(
      /identityCommand/,
    );
    expect(() => parseHostSlotConfig({ ...ok, slots: 2 })).toThrow(/unknown key "slots"/);
  });

  it("parseIdentityOutput reads the probe's lines and nothing else", () => {
    const m = parseIdentityOutput(
      "pid=1 alive=1 ticks=638900000000000000\r\npid=2 alive=0 ticks=unreadable\nnoise\n",
    );
    expect(m.get(1)).toEqual({ alive: true, ticks: "638900000000000000" });
    expect(m.get(2)).toEqual({ alive: false, ticks: null });
    expect(m.size).toBe(2);
  });

  it("commandIdentityProbe spawns ONE command for all pids, -Pid a,b appended", async () => {
    const stub = path.join(dir, "probe.mjs");
    writeFileSync(
      stub,
      `const i = process.argv.indexOf("-Pid");
for (const p of process.argv[i + 1].split(",")) console.log(p === "7" ? "pid=7 alive=0 ticks=unreadable" : "pid=" + p + " alive=1 ticks=" + p + "00");`,
    );
    const probe = commandIdentityProbe(["node", stub]);
    const ids = await probe([5, 7, 5]);
    expect(ids.get(5)).toEqual({ alive: true, ticks: "500" });
    expect(ids.get(7)).toEqual({ alive: false, ticks: null });
  });

  it("a probe that fails reports every pid alive-and-unreadable (never dead, never killed)", async () => {
    const probe = commandIdentityProbe(["node", path.join(dir, "missing.mjs")]);
    const ids = await probe([5]);
    expect(ids.get(5)).toEqual({ alive: true, ticks: null });
  });

  it("describeQueue prints what this implementation reads", async () => {
    const table = new Map<number, ProcessIdentity>([[41, { alive: true, ticks: "1" }]]);
    plantTicket(1, { pid: 41, lane: "game_one" });
    plantTicket(2, { pid: 42, lane: "rynx_engine" });
    plantTicket(3, { pid: 43, lane: "x", state: "released" });
    expect(await describeQueue(cfg(), stubProbe(table))).toEqual([
      "seq=1 lane=game_one pid=41 state=active live=1",
      "seq=2 lane=rynx_engine pid=42 state=active live=0",
      "seq=3 lane=x pid=43 state=released live=-",
    ]);
  });
});
