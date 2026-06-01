/**
 * Resolver pool skeleton tests (Phase 7.6 Step 5).
 *
 * Verifies the SEPARATE conflict-resolution pool: it sizes to
 * resolver.max_concurrent, builds isolated worktrees with a DISTINCT
 * `-resolver-<i>` name suffix (so they never collide with verify-pool slots on
 * disk), and that `enqueue` accepts + stores jobs (Step 5 is accept-only; the
 * job processor is the Step-6 seam).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { createWorktreePool } from "../src/worktree-pool.js";
import {
  createResolverPool,
  type ResolutionJob,
} from "../src/resolver-pool.js";

function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

describe.skipIf(!GIT_AVAILABLE)("createResolverPool (real git)", () => {
  let tmpRoot: string;
  let bareRepo: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-respool-"));
    bareRepo = path.join(tmpRoot, "bare.git");
    const authorClone = path.join(tmpRoot, "author");
    await simpleGit().init(["--bare", "--initial-branch=main", bareRepo]);
    await simpleGit().clone(bareRepo, authorClone);
    const author = simpleGit(authorClone);
    await author.addConfig("user.email", "int@test.local");
    await author.addConfig("user.name", "Integrator Test");
    await author.addConfig("commit.gpgsign", "false");
    writeFileSync(path.join(authorClone, "base.txt"), "base\n");
    await author.add(["base.txt"]);
    await author.commit("initial");
    await author.branch(["-M", "main"]);
    await author.push(["-u", "origin", "main"]);
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("maxConcurrent 2 ⇒ ensureAll creates 2 isolated worktrees with the -resolver- name", async () => {
    const root = path.join(tmpRoot, "wt-res2");
    const pool = createResolverPool({
      worktreeRoot: root,
      worktreeName: "wt",
      gitRepoUrl: bareRepo,
      gitRemote: "origin",
      gitMainBranch: "main",
      maxConcurrent: 2,
    });
    expect(pool.size).toBe(2);
    await pool.ensureAll();

    // Two distinct slots, both carrying the `-resolver-<i>` suffix.
    const wtA = pool.acquire();
    const wtB = pool.acquire();
    expect(wtA).not.toBeNull();
    expect(wtB).not.toBeNull();
    expect(pool.acquire()).toBeNull(); // size 2 → third acquire is null
    expect(wtA!.path).not.toBe(wtB!.path);
    expect(path.basename(wtA!.path)).toBe("wt-resolver-0");
    expect(path.basename(wtB!.path)).toBe("wt-resolver-1");
    expect(pool.leasedCount).toBe(2);
    pool.release(wtA!);
    pool.release(wtB!);
    expect(pool.leasedCount).toBe(0);
  });

  it("enqueue accepts + stores jobs (queuedCount increments)", async () => {
    const root = path.join(tmpRoot, "wt-resq");
    const pool = createResolverPool({
      worktreeRoot: root,
      worktreeName: "wt",
      gitRepoUrl: bareRepo,
      gitRemote: "origin",
      gitMainBranch: "main",
      maxConcurrent: 1,
    });
    expect(pool.queuedCount).toBe(0);
    const job: ResolutionJob = {
      resolutionId: "res-1",
      originRequestId: "req-1",
      conflictingFiles: ["feature.txt"],
      baseSha: "deadbeef",
      ref: "feature/collidefeature",
      resource: "main",
    };
    pool.enqueue(job);
    expect(pool.queuedCount).toBe(1);
    pool.enqueue({ ...job, resolutionId: "res-2", originRequestId: "req-2" });
    expect(pool.queuedCount).toBe(2);
  });

  it("resolver slots are disjoint from a sibling verify pool sharing the same root + name", async () => {
    const root = path.join(tmpRoot, "wt-disjoint");
    const verifyPool = createWorktreePool({
      worktreeRoot: root,
      worktreeName: "wt",
      gitRepoUrl: bareRepo,
      gitRemote: "origin",
      gitMainBranch: "main",
      parallelism: 2,
    });
    const resolverPool = createResolverPool({
      worktreeRoot: root,
      worktreeName: "wt",
      gitRepoUrl: bareRepo,
      gitRemote: "origin",
      gitMainBranch: "main",
      maxConcurrent: 2,
    });
    await verifyPool.ensureAll();
    await resolverPool.ensureAll();

    const verifyPaths = new Set<string>();
    let wt = verifyPool.acquire();
    while (wt) {
      verifyPaths.add(path.normalize(wt.path));
      wt = verifyPool.acquire();
    }
    const resolverPaths = new Set<string>();
    let rwt = resolverPool.acquire();
    while (rwt) {
      resolverPaths.add(path.normalize(rwt.path));
      rwt = resolverPool.acquire();
    }

    expect(verifyPaths.size).toBe(2);
    expect(resolverPaths.size).toBe(2);
    // No path is shared between the two pools — verify slots are `wt-<i>`,
    // resolver slots are `wt-resolver-<i>`.
    for (const p of resolverPaths) {
      expect(verifyPaths.has(p)).toBe(false);
      expect(path.basename(p)).toMatch(/^wt-resolver-\d+$/);
    }
  });
});
