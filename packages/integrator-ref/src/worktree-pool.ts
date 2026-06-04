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
}

export interface WorktreePool {
  readonly size: number;
  readonly leasedCount: number;
  ensureAll(): Promise<void>;
  acquire(): Worktree | null;
  release(wt: Worktree): void;
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
    repair,
    gc,
  };
}
