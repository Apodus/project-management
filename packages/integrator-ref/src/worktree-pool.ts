import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createWorktree, type Worktree } from "./worktree.js";

export interface WorktreePoolOptions {
  worktreeRoot: string;
  worktreeName: string;
  gitRepoUrl: string;
  gitRemote: string;
  gitMainBranch: string;
  parallelism: number;
  cleanKeep: string[];
  /** See WorktreeOptions.gitlinkPurgePaths — passed through to every slot. */
  gitlinkPurgePaths?: string[];
}

export interface WorktreePool {
  readonly size: number;
  readonly leasedCount: number;
  ensureAll(): Promise<void>;
  acquire(): Worktree | null;
  release(wt: Worktree): void;
  /**
   * Free EVERY slot and return how many were still leased. The lane-wedge
   * backstop (2026-08-02): a leased slot is freed only by an explicit
   * `release`, so ANY throw between `acquire()` and the matching release
   * strands the slot for the lifetime of the process — with `parallelism: 1`
   * that silently kills the lane (the daemon keeps heartbeating, keeps taking
   * the lane lock, and admits nothing, forever).
   *
   * Call ONLY at a point where the caller knows no work holds a slot — i.e.
   * the end of a drained batch, which is single-flight per lane. Returns 0 on
   * the healthy path, so the caller can alarm on a non-zero result.
   */
  reclaimAll(): number;
  repair(wt: Worktree): Promise<void>;
  gc(): Promise<void>;
}

export function createWorktreePool(opts: WorktreePoolOptions): WorktreePool {
  const root = opts.worktreeRoot.replace(/[\\/]+$/, "");
  const size = Math.max(1, Math.floor(opts.parallelism));

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
      worktreeName: `${opts.worktreeName}-${i}`,
      gitRepoUrl: opts.gitRepoUrl,
      gitRemote: opts.gitRemote,
      gitMainBranch: opts.gitMainBranch,
      cleanKeep: opts.cleanKeep,
      gitlinkPurgePaths: opts.gitlinkPurgePaths,
    }),
  }));

  const byPath = new Map<string, Slot>(slots.map((s) => [s.wt.path, s]));

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

  function reclaimAll(): number {
    let reclaimed = 0;
    for (const s of slots) {
      if (s.leased) {
        s.leased = false;
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  async function repair(wt: Worktree): Promise<void> {
    const s = byPath.get(wt.path);
    if (!s) return;
    await s.wt.repair();
  }

  async function gc(): Promise<void> {
    const valid = new Set(slots.map((s) => path.basename(s.wt.path)));
    const prefix = `${opts.worktreeName}-`;
    let entries: string[];
    try {
      entries = await readdir(path.normalize(root));
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(prefix) || valid.has(name)) continue;
      const suffix = name.slice(prefix.length);
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
    ensureAll,
    acquire,
    release,
    reclaimAll,
    repair,
    gc,
  };
}
