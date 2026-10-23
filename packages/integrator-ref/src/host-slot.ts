/**
 * C4-P2: the HOST verify semaphore. Every integrator lane on one machine (and
 * the engine canary) verifies through it, so the number of concurrent verifies
 * on the host is bounded no matter how many lanes run. One lane per daemon
 * never bounded anything: two daemons meant two full builds at once, each with
 * a 4 GB commit cap and its GPU rows.
 *
 * THE QUEUE is a directory every contender agrees on (an ABSOLUTE path in
 * lanes.json `hostSlots.dir`; never os-tmp, which differs per user/session and
 * would silently give two daemons two semaphores):
 *
 *   <dir>/queue/<seq:12>.ticket   one JSON file per verify, never renamed
 *
 * A ticket HOLDS a slot iff it is `active` and among the first `count` LIVE
 * active tickets in numeric seq order. Order is the seq in the name -- never
 * mtime, never the listing order.
 *
 * ALLOCATION IS LOCK-FREE, because a lock file is the one thing that can go
 * stale. A new ticket takes `max(seq present) + 1`, is written to a temp file
 * and LINKED to its final name (link fails if the name exists: EEXIST -> list
 * again). A seq can therefore never be issued twice, and a new ticket never
 * sorts ahead of one that exists. Release and reclaim REWRITE the ticket's
 * state in place (temp + rename); nothing deletes a ticket except the pruner,
 * which removes only released/reclaimed tickets far below the high-water mark
 * and older than a day -- the only gap a stalled lister could refill.
 *
 * LIVENESS is PID + process start time. The integrator never computes a start
 * time itself: it spawns `hostSlots.identityCommand` (game_one's
 * tools/host/process_identity.ps1, the SAME `.NET Process.StartTime` ticks the
 * engine store's leases and the canary use), so every implementation reads the
 * same number. A recycled pid with different ticks is dead. An UNREADABLE
 * identity is LIVE: doubt never reclaims and never kills.
 *
 * RECLAIM: a dead holder's ticket records the verify shells it spawned. Before
 * the ticket is marked reclaimed, each recorded shell's identity is re-read
 * IMMEDIATELY before `taskkill /T /F`, and it is killed only on an exact match,
 * so a recycled pid is never killed and an orphaned build never runs beside the
 * next one.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { killTree } from "./kill-tree.js";

export interface HostSlotConfig {
  /** Absolute directory every contender on the host shares. */
  dir: string;
  /** Concurrent verifies the host allows. */
  count: number;
  /** argv of the identity probe; `-Pid <n,m,...>` is appended. */
  identityCommand: string[];
}

/** `ticks` is the decimal .NET UTC start tick count; null = alive but unreadable. */
export interface ProcessIdentity {
  alive: boolean;
  ticks: string | null;
}

export type IdentityProbe = (pids: number[]) => Promise<Map<number, ProcessIdentity>>;

export type TicketState = "active" | "released" | "reclaimed";

export interface TicketDoc {
  schema: 1;
  seq: number;
  lane: string;
  pid: number;
  startTicks: string | null;
  requestId: string;
  enqueuedAt: string;
  state: TicketState;
  /** Verify shells this ticket's holder spawned, for the reclaim kill. */
  children: { pid: number; startTicks: string | null }[];
  endedAt?: string;
  reclaimedBy?: { lane: string; pid: number };
}

/** What a heartbeat reports for one of THIS daemon's verifies. */
export interface HostSlotView {
  request_id: string;
  state: "waiting" | "held";
  seq: number;
  /** Live tickets ahead of this one (0 once held). */
  position: number;
  holder_lane: string | null;
  holder_pid: number | null;
  /** Time spent waiting; kept on the held entry so a stall check can subtract it. */
  waited_ms: number;
}

export interface HostSlotHold {
  /** Record a spawned verify shell in the ticket (identity read via the probe). */
  trackChild(pid: number): void;
  release(): void;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Stamped on every wait poll: a member waiting for the host is not a silent build. */
  liveness?: { lastOutputAt: number };
}

/** One verify's claim on the host; acquirers of one lease share ONE ticket. */
export interface HostSlotLease {
  acquire(opts?: AcquireOptions): Promise<HostSlotHold>;
}

export interface HostSlots {
  lease(requestId: string): HostSlotLease;
  snapshot(): HostSlotView[];
  /** True when a bound applies (a heartbeat then carries `host_slots`). */
  readonly bounded: boolean;
}

export class HostSlotAbortedError extends Error {
  constructor() {
    super("aborted while waiting for a host verify slot");
    this.name = "HostSlotAbortedError";
  }
}

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const SEQ_WIDTH = 12;
const TICKET_RE = /^(\d{12})\.ticket$/;
const PRUNE_BELOW_MAX = 256;
const PRUNE_MIN_AGE_MS = 24 * 3600 * 1000;
export const DEFAULT_POLL_MS = 2_000;

// ── Config ────────────────────────────────────────────────────────────────

/** Validate a `hostSlots` block (lanes.json / distribute config). Throws on the first defect. */
export function parseHostSlotConfig(raw: unknown, where = "hostSlots"): HostSlotConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where} must be an object { dir, count, identityCommand }`);
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!k.startsWith("_") && !["dir", "count", "identityCommand"].includes(k)) {
      throw new Error(`${where} has an unknown key "${k}"`);
    }
  }
  if (
    typeof o.dir !== "string" ||
    !(path.win32.isAbsolute(o.dir) || path.posix.isAbsolute(o.dir))
  ) {
    throw new Error(
      `${where}.dir must be an ABSOLUTE path every lane on the host shares (got ${JSON.stringify(o.dir)})`,
    );
  }
  if (typeof o.count !== "number" || !Number.isInteger(o.count) || o.count < 1) {
    throw new Error(`${where}.count must be an integer >= 1 (got ${JSON.stringify(o.count)})`);
  }
  if (
    !Array.isArray(o.identityCommand) ||
    o.identityCommand.length === 0 ||
    !o.identityCommand.every((a) => typeof a === "string" && a !== "")
  ) {
    throw new Error(`${where}.identityCommand must be a non-empty array of non-empty strings`);
  }
  return { dir: o.dir, count: o.count, identityCommand: o.identityCommand as string[] };
}

// ── Identity ──────────────────────────────────────────────────────────────

/** Parse the probe's `pid=<n> alive=<0|1> ticks=<n|unreadable>` lines. */
export function parseIdentityOutput(text: string): Map<number, ProcessIdentity> {
  const out = new Map<number, ProcessIdentity>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^pid=(\d+) alive=([01]) ticks=(\d+|unreadable)\s*$/.exec(line.trim());
    if (!m) continue;
    out.set(Number(m[1]), { alive: m[2] === "1", ticks: m[3] === "unreadable" ? null : m[3] });
  }
  return out;
}

/**
 * The probe the daemon uses: ONE spawn of `identityCommand -Pid <a,b,...>` for
 * every pid asked about. A probe that fails, or omits a pid, reports that pid
 * as alive-and-unreadable (live): a broken probe may stall the queue but can
 * never reclaim a live ticket or kill a process. The daemon's startup self-check
 * is what turns a broken probe into a loud configuration error.
 */
export function commandIdentityProbe(command: string[], timeoutMs = 30_000): IdentityProbe {
  return (pids) =>
    new Promise((resolve) => {
      const unique = [...new Set(pids)];
      const unreadable = (): Map<number, ProcessIdentity> =>
        new Map(unique.map((p) => [p, { alive: true, ticks: null }]));
      if (unique.length === 0) {
        resolve(new Map());
        return;
      }
      execFile(
        command[0],
        [...command.slice(1), "-Pid", unique.join(",")],
        { timeout: timeoutMs, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(unreadable());
            return;
          }
          const parsed = parseIdentityOutput(String(stdout));
          const merged = unreadable();
          for (const [p, id] of parsed) if (merged.has(p)) merged.set(p, id);
          resolve(merged);
        },
      );
    });
}

/** Live iff alive and the start time matches the recorded one (or either is unreadable). */
export function isLive(recordedTicks: string | null, id: ProcessIdentity | undefined): boolean {
  if (!id) return true;
  if (!id.alive) return false;
  if (id.ticks === null || recordedTicks === null) return true;
  return id.ticks === recordedTicks;
}

// ── The ticket store ──────────────────────────────────────────────────────

export interface TicketEntry {
  seq: number;
  file: string;
  /** null = unparsable: treated as an ACTIVE ticket of unknown holder (counts ahead, never reclaimed). */
  doc: TicketDoc | null;
}

function ticketName(seq: number): string {
  return `${String(seq).padStart(SEQ_WIDTH, "0")}.ticket`;
}

/** Windows refuses a replace while another process has the file open without delete sharing: retry briefly. */
function writeInPlace(file: string, doc: TicketDoc): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  let lastErr: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      const until = Date.now() + 50;
      while (Date.now() < until) {
        /* brief spin: the reader holds the file for microseconds */
      }
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* best-effort */
  }
  throw lastErr;
}

export class TicketStore {
  readonly queueDir: string;

  constructor(dir: string) {
    this.queueDir = path.join(dir, "queue");
  }

  list(): TicketEntry[] {
    const entries: TicketEntry[] = [];
    if (!existsSync(this.queueDir)) return entries;
    for (const name of readdirSync(this.queueDir)) {
      const m = TICKET_RE.exec(name);
      if (!m) continue;
      const file = path.join(this.queueDir, name);
      let doc: TicketDoc | null = null;
      try {
        doc = JSON.parse(readFileSync(file, "utf8")) as TicketDoc;
      } catch {
        doc = null;
      }
      entries.push({ seq: Number(m[1]), file, doc });
    }
    return entries.sort((a, b) => a.seq - b.seq);
  }

  /** Publish a new ticket at max(seq)+1, exclusively. Returns the entry. */
  enqueue(fields: Omit<TicketDoc, "schema" | "seq" | "state" | "children">): TicketEntry {
    mkdirSync(this.queueDir, { recursive: true });
    for (let attempt = 0; attempt < 1000; attempt++) {
      const entries = this.list();
      const seq = (entries.length ? entries[entries.length - 1].seq : 0) + 1;
      const doc: TicketDoc = { schema: 1, seq, state: "active", children: [], ...fields };
      const file = path.join(this.queueDir, ticketName(seq));
      const tmp = path.join(
        this.queueDir,
        `.new-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`,
      );
      writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
      try {
        linkSync(tmp, file);
        return { seq, file, doc };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          /* best-effort */
        }
      }
    }
    throw new Error(
      `host-slot: could not allocate a ticket in ${this.queueDir} after 1000 attempts`,
    );
  }

  update(entry: TicketEntry, doc: TicketDoc): void {
    writeInPlace(entry.file, doc);
    entry.doc = doc;
  }

  /** Remove ended tickets far below the high-water mark (never the max, never a recent one). */
  prune(now = Date.now()): number {
    const entries = this.list();
    if (entries.length === 0) return 0;
    const max = entries[entries.length - 1].seq;
    let removed = 0;
    for (const e of entries) {
      if (e.seq > max - PRUNE_BELOW_MAX) break;
      if (!e.doc || e.doc.state === "active") continue;
      try {
        if (now - statSync(e.file).mtimeMs < PRUNE_MIN_AGE_MS) continue;
        unlinkSync(e.file);
        removed++;
      } catch {
        /* another pruner got it */
      }
    }
    return removed;
  }
}

// ── The semaphore ─────────────────────────────────────────────────────────

export interface CreateHostSlotsOptions {
  config: HostSlotConfig;
  lane: string;
  logger: Logger;
  probe?: IdentityProbe;
  pollMs?: number;
  /** This process's identity (from the probe at startup). */
  self: { pid: number; startTicks: string | null };
  /** Kill seam (tests); default taskkill /T /F via killTree. */
  kill?: (pid: number) => void;
}

interface Waiter {
  requestId: string;
  entry: TicketEntry;
  state: "waiting" | "held";
  position: number;
  holderLane: string | null;
  holderPid: number | null;
  startedAt: number;
  heldAt: number | null;
}

export interface QueueReading {
  /** Live active tickets ahead of `mine`, in seq order. */
  ahead: TicketEntry[];
  /** Dead active tickets (any position) found by this reading. */
  dead: TicketEntry[];
}

/**
 * Read the queue relative to ticket `mineSeq` (or the whole queue when null):
 * which active tickets are live, which dead. One probe for every pid involved.
 */
export async function readQueue(
  store: TicketStore,
  probe: IdentityProbe,
  mineSeq: number | null,
  selfPid: number,
): Promise<{ entries: TicketEntry[]; live: Set<number>; dead: TicketEntry[] }> {
  const entries = store.list();
  const active = entries.filter((e) => e.doc === null || e.doc.state === "active");
  const pids = active.flatMap((e) => (e.doc && e.doc.pid !== selfPid ? [e.doc.pid] : []));
  const ids = await probe(pids);
  const live = new Set<number>();
  const dead: TicketEntry[] = [];
  for (const e of active) {
    if (mineSeq !== null && e.seq === mineSeq) continue;
    if (e.doc === null || e.doc.pid === selfPid || isLive(e.doc.startTicks, ids.get(e.doc.pid))) {
      live.add(e.seq);
    } else {
      dead.push(e);
    }
  }
  return { entries, live, dead };
}

export function createHostSlots(opts: CreateHostSlotsOptions): HostSlots {
  const { config, lane, logger, self } = opts;
  const probe = opts.probe ?? commandIdentityProbe(config.identityCommand);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const kill = opts.kill ?? ((pid: number) => killTree(pid, "SIGKILL"));
  const store = new TicketStore(config.dir);
  const waiters = new Map<string, Waiter>();

  const reclaim = async (e: TicketEntry): Promise<void> => {
    const doc = e.doc;
    if (!doc) return;
    for (const child of doc.children) {
      // Re-read the identity NOW, immediately before the kill: the pid may have
      // been recycled since the ticket was written. Only an exact match dies.
      const id = (await probe([child.pid])).get(child.pid);
      if (
        id &&
        id.alive &&
        id.ticks !== null &&
        child.startTicks !== null &&
        id.ticks === child.startTicks
      ) {
        logger.warn(
          { seq: e.seq, lane: doc.lane, childPid: child.pid },
          "host-slot: killing the orphaned verify tree of a dead holder",
        );
        kill(child.pid);
      } else {
        logger.info(
          {
            seq: e.seq,
            lane: doc.lane,
            childPid: child.pid,
            identity: id ?? null,
            recorded: child.startTicks,
          },
          "host-slot: an orphan child of a dead holder is gone or not provably the same process: not killed",
        );
      }
    }
    const fresh = store.list().find((x) => x.seq === e.seq);
    if (!fresh?.doc || fresh.doc.state !== "active") return; // another contender reclaimed it first
    store.update(fresh, {
      ...fresh.doc,
      state: "reclaimed",
      endedAt: new Date().toISOString(),
      reclaimedBy: { lane, pid: self.pid },
    });
    logger.warn(
      { seq: e.seq, lane: doc.lane, pid: doc.pid, requestId: doc.requestId },
      "host-slot: reclaimed the ticket of a dead holder (pid gone or recycled)",
    );
  };

  const releaseEntry = (entry: TicketEntry, requestId: string): void => {
    waiters.delete(requestId);
    const doc = entry.doc as TicketDoc;
    try {
      store.update(entry, { ...doc, state: "released", endedAt: new Date().toISOString() });
    } catch (err) {
      // Last resort: an ACTIVE ticket of a live process would block every other
      // verify on the host until this daemon exits. Deleting it opens a gap only
      // a stalled lister could refill (see the pruner).
      logger.error(
        { seq: entry.seq, err: String(err) },
        "host-slot: could not mark the ticket released; deleting it",
      );
      try {
        unlinkSync(entry.file);
      } catch {
        /* nothing more to do */
      }
    }
  };

  const waitForSlot = async (
    requestId: string,
    signal: AbortSignal,
    liveness?: { lastOutputAt: number },
  ): Promise<TicketEntry> => {
    store.prune();
    const entry = store.enqueue({
      lane,
      pid: self.pid,
      startTicks: self.startTicks,
      requestId,
      enqueuedAt: new Date().toISOString(),
    });
    const w: Waiter = {
      requestId,
      entry,
      state: "waiting",
      position: 0,
      holderLane: null,
      holderPid: null,
      startedAt: Date.now(),
      heldAt: null,
    };
    waiters.set(requestId, w);
    try {
      for (;;) {
        if (signal.aborted) throw new HostSlotAbortedError();
        const { entries, live, dead } = await readQueue(store, probe, entry.seq, self.pid);
        for (const d of dead) await reclaim(d);
        const ahead = entries.filter((e) => e.seq < entry.seq && live.has(e.seq));
        w.position = ahead.length;
        w.holderLane = ahead[0]?.doc?.lane ?? null;
        w.holderPid = ahead[0]?.doc?.pid ?? null;
        if (ahead.length < config.count) {
          w.state = "held";
          w.position = 0;
          w.heldAt = Date.now();
          logger.info(
            { seq: entry.seq, requestId, waitedMs: w.heldAt - w.startedAt },
            "host-slot: acquired",
          );
          return entry;
        }
        if (liveness) liveness.lastOutputAt = Date.now();
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, pollMs);
          const onAbort = (): void => {
            clearTimeout(t);
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    } catch (err) {
      releaseEntry(entry, requestId);
      throw err;
    }
  };

  return {
    bounded: true,
    snapshot: () =>
      [...waiters.values()].map((w) => ({
        request_id: w.requestId,
        state: w.state,
        seq: w.entry.seq,
        position: w.position,
        holder_lane: w.state === "waiting" ? w.holderLane : null,
        holder_pid: w.state === "waiting" ? w.holderPid : null,
        waited_ms: (w.heldAt ?? Date.now()) - w.startedAt,
      })),
    lease(requestId: string): HostSlotLease {
      // Acquirers of one lease (a group's inner + outer pipelines) share ONE
      // ticket: the slot is taken once and released when the last holder releases.
      let shared: Promise<TicketEntry> | null = null;
      let internal = new AbortController();
      let waiting = 0;
      let holders = 0;
      const dropHolder = (held: TicketEntry): void => {
        if (--holders === 0) {
          releaseEntry(held, requestId);
          shared = null;
        }
      };
      return {
        async acquire(acq: AcquireOptions = {}): Promise<HostSlotHold> {
          const signal = acq.signal;
          if (signal?.aborted) throw new HostSlotAbortedError();
          if (!shared) {
            internal = new AbortController();
            shared = waitForSlot(requestId, internal.signal, acq.liveness);
            // A failed wait must not be handed to the next acquirer.
            shared.catch(() => {
              shared = null;
            });
          }
          const pending = shared;
          const myInternal = internal;
          waiting++;
          // The last waiter of a still-waiting lease gone: stop waiting for the host.
          const onAbort = (): void => {
            if (--waiting === 0 && holders === 0) myInternal.abort();
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          let held: TicketEntry;
          try {
            held = await pending;
          } finally {
            if (!signal?.aborted) waiting--;
            signal?.removeEventListener("abort", onAbort);
          }
          holders++;
          if (signal?.aborted) {
            // Aborted in the instant the slot was granted.
            dropHolder(held);
            throw new HostSlotAbortedError();
          }
          let released = false;
          // Serialized: two steps spawning at once must not lose a child record.
          let chain: Promise<void> = Promise.resolve();
          return {
            trackChild(pid: number): void {
              chain = chain.then(async () => {
                const id = (await probe([pid])).get(pid);
                const doc = held.doc as TicketDoc;
                if (doc.state !== "active") return;
                try {
                  store.update(held, {
                    ...doc,
                    children: [
                      ...doc.children,
                      { pid, startTicks: id && id.alive ? id.ticks : null },
                    ],
                  });
                } catch (err) {
                  logger.warn(
                    { seq: held.seq, pid, err: String(err) },
                    "host-slot: could not record a verify child",
                  );
                }
              });
            },
            release(): void {
              if (released) return;
              released = true;
              dropHolder(held);
            },
          };
        },
      };
    },
  };
}

/** No bound (no `hostSlots` configured): every acquire is immediate. */
export const UNBOUNDED_HOST_SLOTS: HostSlots = {
  bounded: false,
  snapshot: () => [],
  lease: () => ({
    acquire: async (opts?: AcquireOptions) => {
      if (opts?.signal?.aborted) throw new HostSlotAbortedError();
      return { trackChild: () => {}, release: () => {} };
    },
  }),
};

/** Read `hostSlots` from a lanes.json; null when the file declares none. */
export function readHostSlotsFile(file: string): HostSlotConfig | null {
  if (!existsSync(file)) throw new Error(`${file} not found`);
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (doc.hostSlots === undefined) return null;
  return parseHostSlotConfig(doc.hostSlots, `${file}: hostSlots`);
}

/**
 * The queue as THIS implementation reads it, one line per ticket:
 * `seq=<n> lane=<l> pid=<p> state=<active|released|reclaimed|unparsable> live=<0|1|->`
 * (`-` for an ended ticket, which is never probed). Read-only.
 */
export async function describeQueue(
  config: HostSlotConfig,
  probe: IdentityProbe,
): Promise<string[]> {
  const store = new TicketStore(config.dir);
  const { entries, live } = await readQueue(store, probe, null, -1);
  return entries.map((e) => {
    const d = e.doc;
    if (!d) return `seq=${e.seq} lane=? pid=? state=unparsable live=1`;
    const liveText = d.state === "active" ? (live.has(e.seq) ? "1" : "0") : "-";
    return `seq=${e.seq} lane=${d.lane} pid=${d.pid} state=${d.state} live=${liveText}`;
  });
}
