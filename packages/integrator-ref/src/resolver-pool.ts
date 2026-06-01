/**
 * Resolver worktree pool + job queue (Phase 7.6 Step 5).
 *
 * Mirrors `worktree-pool.ts` but is a SEPARATE pool dedicated to merge-conflict
 * resolution (design §3 / §5.2). It exists only when
 * `settings.integrator.resolver.enabled = true`; with the resolver off the pool
 * is never constructed and the train is byte-identical to 7.5.
 *
 * Two reasons this is its own module, not a flag on the verify pool:
 *   1. Sizing is independent — `resolver.max_concurrent` (design §3), not the
 *      verify `parallelism`.
 *   2. The worktrees must NOT collide on disk with verify-pool slots, so they
 *      carry a distinct `-resolver-<i>` name suffix (the verify pool uses
 *      `-<i>`). A resolution running in `<name>-resolver-0` and a verify member
 *      in `<name>-0` are different directories.
 *
 * Step 5 implements ONLY the pool skeleton + an in-memory job queue (accept +
 * store). The job PROCESSOR — start → build worktree → spawn headless Claude →
 * local verify → resubmit/escalate — is the Step-6 seam, left as a clearly
 * marked no-op stub below (design §5.2). Do NOT implement the headless worker
 * here.
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createWorktree, type Worktree } from "./worktree.js";

/**
 * A single resolution job enqueued at the conflict seam (design §5.1). Carries
 * exactly what the Step-6 processor needs to reproduce the conflict the rebase
 * hit and run a bounded resolution attempt:
 *   - `resolutionId`     the PM `merge_resolutions` row id (state machine §4.3).
 *   - `originRequestId`  the request that conflicted (rejected `conflict`).
 *   - `conflictingFiles` the files git reported in conflict.
 *   - `baseSha`          live `main` HEAD the rebase was attempted onto.
 *   - `ref`              the origin branch/commit to replay.
 *   - `resource`         the lane.
 */
export interface ResolutionJob {
  resolutionId: string;
  originRequestId: string;
  conflictingFiles: string[];
  baseSha: string;
  ref: string;
  resource: string;
}

export interface ResolverPoolOptions {
  worktreeRoot: string;
  /** The integrator worktree base name (e.g. `<slug>-integrator`). The pool
   *  appends a distinct `-resolver-<i>` suffix so slots never collide with the
   *  verify pool's `-<i>` slots on disk. */
  worktreeName: string;
  gitRepoUrl: string;
  gitRemote: string;
  gitMainBranch: string;
  /** `resolver.max_concurrent` (design §3). Pool size; clamped to ≥ 1. */
  maxConcurrent: number;
}

export interface ResolverPool {
  readonly size: number;
  readonly leasedCount: number;
  readonly queuedCount: number;
  ensureAll(): Promise<void>;
  acquire(): Worktree | null;
  release(wt: Worktree): void;
  repair(wt: Worktree): Promise<void>;
  /** Accept a job onto the in-memory queue (Step 5: accept + store). The
   *  Step-6 processor drains this. */
  enqueue(job: ResolutionJob): void;
  gc(): Promise<void>;
}

export function createResolverPool(opts: ResolverPoolOptions): ResolverPool {
  const root = opts.worktreeRoot.replace(/[\\/]+$/, "");
  const size = Math.max(1, Math.floor(opts.maxConcurrent));
  // Distinct suffix so resolver slots never collide with verify-pool slots.
  const slotPrefix = `${opts.worktreeName}-resolver-`;

  interface Slot {
    index: number;
    wt: Worktree;
    leased: boolean;
  }
  const slots: Slot[] = Array.from({ length: size }, (_, i) => ({
    index: i,
    leased: false,
    wt: createWorktree({
      worktreeRoot: root,
      worktreeName: `${slotPrefix}${i}`,
      gitRepoUrl: opts.gitRepoUrl,
      gitRemote: opts.gitRemote,
      gitMainBranch: opts.gitMainBranch,
    }),
  }));

  const byPath = new Map<string, Slot>(slots.map((s) => [s.wt.path, s]));

  // In-memory job queue (design §4 — the integrator owns resolution scheduling
  // in memory; `merge_resolutions` is the durable record). Step 5 only stores
  // jobs; the Step-6 processor drains them.
  const queue: ResolutionJob[] = [];

  async function ensureAll(): Promise<void> {
    for (const s of slots) await s.wt.ensureExists();
  }

  function acquire(): Worktree | null {
    const free = slots.find((s) => !s.leased);
    if (!free) return null;
    free.leased = true;
    return free.wt;
  }

  function release(wt: Worktree): void {
    const s = byPath.get(wt.path);
    if (s) s.leased = false;
  }

  async function repair(wt: Worktree): Promise<void> {
    const s = byPath.get(wt.path);
    if (!s) return;
    await s.wt.repair();
  }

  function enqueue(job: ResolutionJob): void {
    queue.push(job);
    // ─────────────────────────────────────────────────────────────────
    // STEP-6 SEAM (design §5.2): the job PROCESSOR goes here.
    //
    // Step 6 starts draining `queue`: for each job, lease a slot via
    // acquire(), POST merge-resolutions/{id}/start (→ resolving), build the
    // worktree at live main + replay `ref` to reproduce the conflict, spawn
    // headless Claude (`resolver.command` / `claude -p`) bounded by
    // time_budget_sec, run the 7.5 verify pipeline cache-OFF on the resolved
    // tree, then resubmit (§5.3) or escalate (§5.4), and release() the slot.
    //
    // Step 5 deliberately leaves this a no-op: the seam only ACCEPTS + STORES
    // the job so the conflict path is non-blocking (the lane lock is already
    // released before enqueue — design §5.1). Do NOT implement the headless
    // worker here.
    // ─────────────────────────────────────────────────────────────────
  }

  async function gc(): Promise<void> {
    const valid = new Set(slots.map((s) => path.basename(s.wt.path)));
    let entries: string[];
    try {
      entries = await readdir(path.normalize(root));
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(slotPrefix) || valid.has(name)) continue;
      const suffix = name.slice(slotPrefix.length);
      if (!/^\d+$/.test(suffix)) continue;
      const full = path.join(path.normalize(root), name);
      try {
        if ((await stat(full)).isDirectory()) {
          await rm(full, { recursive: true, force: true });
        }
      } catch {
        // best-effort cleanup
      }
    }
  }

  return {
    size,
    get leasedCount() {
      return slots.filter((s) => s.leased).length;
    },
    get queuedCount() {
      return queue.length;
    },
    ensureAll,
    acquire,
    release,
    repair,
    enqueue,
    gc,
  };
}
