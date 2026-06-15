import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { createWorktreePool } from "../src/worktree-pool.js";

function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

let tmpRoot: string;
let bareRepo: string;
let worktreeRoot: string;

async function configIdentity(g: SimpleGit): Promise<void> {
  await g.addConfig("user.email", "int@test.local");
  await g.addConfig("user.name", "Integrator Test");
  await g.addConfig("commit.gpgsign", "false");
}

describe.skipIf(!GIT_AVAILABLE)("worktree pool (real git)", () => {
  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-wtpool-"));
    bareRepo = path.join(tmpRoot, "bare.git");
    worktreeRoot = path.join(tmpRoot, "wtroot");

    await simpleGit().init(["--bare", "--initial-branch=main", bareRepo]);
    const seedClone = path.join(tmpRoot, "seed");
    await simpleGit().clone(bareRepo, seedClone);
    const seed = simpleGit(seedClone);
    await configIdentity(seed);
    writeFileSync(path.join(seedClone, "base.txt"), "base\n");
    await seed.add(["base.txt"]);
    await seed.commit("initial");
    await seed.branch(["-M", "main"]);
    await seed.push(["-u", "origin", "main"]);
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function makePool(name: string, parallelism: number) {
    return createWorktreePool({
      worktreeRoot,
      worktreeName: name,
      gitRepoUrl: bareRepo,
      gitRemote: "origin",
      gitMainBranch: "main",
      parallelism,
      cleanKeep: [],
    });
  }

  it("ensureAll clones 3 separate .git dirs", async () => {
    const pool = makePool("t1", 3);
    await pool.ensureAll();

    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();

    const paths = [a!.path, b!.path, c!.path];
    // 3 distinct paths.
    expect(new Set(paths).size).toBe(3);
    // Each ends in -0 / -1 / -2 and has a real .git.
    const basenames = paths.map((p) => path.basename(p)).sort();
    expect(basenames).toEqual(["t1-0", "t1-1", "t1-2"]);
    for (const wt of [a!, b!, c!]) {
      expect(existsSync(path.join(wt.path, ".git"))).toBe(true);
    }
  });

  it("acquire/release leasing + backpressure", async () => {
    const pool = makePool("t2", 3);
    await pool.ensureAll();

    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(new Set([a!.path, b!.path, c!.path]).size).toBe(3);
    expect(pool.leasedCount).toBe(3);

    // Pool exhausted → backpressure.
    expect(pool.acquire()).toBeNull();

    pool.release(b!);
    expect(pool.leasedCount).toBe(2);

    const next = pool.acquire();
    expect(next).not.toBeNull();
    expect(pool.leasedCount).toBe(3);
  });

  it("release-then-reacquire returns a usable slot", async () => {
    const pool = makePool("t3", 2);
    await pool.ensureAll();

    const a = pool.acquire();
    expect(a).not.toBeNull();
    pool.release(a!);

    const reacquired = pool.acquire();
    expect(reacquired).not.toBeNull();
    expect(existsSync(path.join(reacquired!.path, ".git"))).toBe(true);
    expect(await reacquired!.detectCorruption()).toBe(false);
  });

  it("repair rebuilds ONE slot, others untouched", async () => {
    const pool = makePool("t4", 3);
    await pool.ensureAll();

    const slot0 = pool.acquire()!;
    const slot1 = pool.acquire()!;
    const slot2 = pool.acquire()!;
    expect(slot0).not.toBeNull();
    expect(slot1).not.toBeNull();
    expect(slot2).not.toBeNull();

    // Corrupt slot 1.
    await rm(path.join(slot1.path, ".git"), { recursive: true, force: true });
    expect(await slot1.detectCorruption()).toBe(true);
    expect(await slot0.detectCorruption()).toBe(false);
    expect(await slot2.detectCorruption()).toBe(false);

    await pool.repair(slot1);

    expect(existsSync(path.join(slot1.path, ".git"))).toBe(true);
    expect(await slot1.detectCorruption()).toBe(false);

    // Neighbors untouched.
    expect(existsSync(path.join(slot0.path, ".git"))).toBe(true);
    expect(existsSync(path.join(slot2.path, ".git"))).toBe(true);
    expect(await slot0.detectCorruption()).toBe(false);
    expect(await slot2.detectCorruption()).toBe(false);
  });

  it("gc removes a leaked slot dir, keeps valid + unrelated", async () => {
    const pool = makePool("t5", 3);
    await pool.ensureAll();

    // A leaked numeric-suffixed slot dir matching the pool prefix.
    const leaked = path.join(worktreeRoot, "t5-99");
    mkdirSync(leaked, { recursive: true });
    writeFileSync(path.join(leaked, "stale.txt"), "stale\n");

    // An unrelated dir that must survive.
    const keep = path.join(worktreeRoot, "keepme");
    mkdirSync(keep, { recursive: true });
    writeFileSync(path.join(keep, "keep.txt"), "keep\n");

    await pool.gc();

    // Leaked dir removed.
    expect(existsSync(leaked)).toBe(false);
    // Valid slots survive with intact .git.
    for (const i of [0, 1, 2]) {
      const slotPath = path.join(worktreeRoot, `t5-${i}`);
      expect(existsSync(slotPath)).toBe(true);
      expect(existsSync(path.join(slotPath, ".git"))).toBe(true);
    }
    // Unrelated dir survives.
    expect(existsSync(keep)).toBe(true);
  });

  it("corruption in one slot doesn't poison the pool", async () => {
    const pool = makePool("t6", 3);
    await pool.ensureAll();

    const slot0 = pool.acquire()!;
    const slot1 = pool.acquire()!;
    const slot2 = pool.acquire()!;

    await rm(path.join(slot0.path, ".git"), { recursive: true, force: true });

    expect(await slot0.detectCorruption()).toBe(true);
    expect(await slot1.detectCorruption()).toBe(false);
    expect(await slot2.detectCorruption()).toBe(false);
  });
});
