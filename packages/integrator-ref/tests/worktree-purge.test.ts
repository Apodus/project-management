import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { createWorktree, type Worktree } from "../src/worktree.js";

function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

async function configIdentity(g: SimpleGit): Promise<void> {
  await g.addConfig("user.email", "int@test.local");
  await g.addConfig("user.name", "Integrator Test");
  await g.addConfig("commit.gpgsign", "false");
}

const GITLINK_PATH = "vendor/rynx";

// ─── resetForAttempt purges stale materialized gitlink overlays ────────
//
// The bug shape (game_one, 2026-06-10): a group assembly materializes the
// inner sources at the outer repo's gitlink path as plain files with no .git.
// git is BLIND to content at a committed gitlink path — `status` reports
// nothing, `clean -fdx` and `reset --hard` never touch it — so the overlay
// outlived every attempt and poisoned each later verify in the slot (the
// verify script's `git submodule update --init` hard-fails on a populated-
// but-unregistered path). resetForAttempt must purge it explicitly, WITHOUT
// ever eating a real submodule checkout or a tracked directory.
describe.skipIf(!GIT_AVAILABLE)("resetForAttempt gitlink-overlay purge", () => {
  let tmpRoot: string;
  let worktreeRoot: string;
  let wt: Worktree;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-wtpurge-"));
    worktreeRoot = path.join(tmpRoot, "wtroot");
    const bare = path.join(tmpRoot, "outer.git");
    const seed = path.join(tmpRoot, "outer-seed");
    await simpleGit().init(["--bare", "--initial-branch=main", bare]);
    await simpleGit().clone(bare, seed);
    const g = simpleGit(seed);
    await configIdentity(g);
    // A top-level file, a TRACKED regular directory, and a committed 160000
    // gitlink (cacheinfo — gitlink SHAs are not validated against local
    // objects, so the seed's own HEAD sha works as a stand-in).
    writeFileSync(path.join(seed, "top.txt"), "top\n");
    mkdirSync(path.join(seed, "src"));
    writeFileSync(path.join(seed, "src", "app.txt"), "tracked dir content\n");
    await g.add(["top.txt", "src/app.txt"]);
    await g.commit("base");
    const sha = (await g.revparse(["HEAD"])).trim();
    await g.raw(["update-index", "--add", "--cacheinfo", `160000,${sha},${GITLINK_PATH}`]);
    await g.commit("add gitlink");
    await g.branch(["-M", "main"]);
    await g.push(["-u", "origin", "main"]);

    wt = createWorktree({
      worktreeRoot,
      worktreeName: "purge-wt",
      gitRepoUrl: bare,
      gitRemote: "origin",
      gitMainBranch: "main",
      cleanKeep: [],
      // "src" (a tracked regular dir) + a nonexistent path prove the guards:
      // only the REAL gitlink path is ever purged.
      gitlinkPurgePaths: [GITLINK_PATH, "src", "does/not/exist"],
    });
    await wt.ensureExists();
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("removes a stale materialized overlay (populated, no .git) at the gitlink path", async () => {
    await wt.resetForAttempt();
    // Simulate a leftover step-9 overlay: plain files, no .git. Confirm the
    // premise first — git clean/reset alone do NOT remove it (the bug).
    const overlay = path.join(path.normalize(wt.path), "vendor", "rynx");
    mkdirSync(overlay, { recursive: true });
    writeFileSync(path.join(overlay, "lib.txt"), "materialized\n");

    await wt.resetForAttempt();
    expect(existsSync(overlay)).toBe(false);
    // The rest of the tree is intact.
    expect(existsSync(path.join(path.normalize(wt.path), "top.txt"))).toBe(true);
  });

  it("preserves a REAL initialized submodule checkout (a .git inside)", async () => {
    await wt.resetForAttempt();
    const overlay = path.join(path.normalize(wt.path), "vendor", "rynx");
    mkdirSync(overlay, { recursive: true });
    // A real repo at the gitlink path (an initialized submodule checkout
    // carries a .git entry — a VALID one, or git itself chokes; a dangling
    // gitdir pointer makes the outer reset/clean fatal, so init a real repo).
    await simpleGit().init([overlay]);
    writeFileSync(path.join(overlay, "lib.txt"), "real checkout\n");

    await wt.resetForAttempt();
    expect(existsSync(path.join(overlay, "lib.txt"))).toBe(true);
    expect(existsSync(path.join(overlay, ".git"))).toBe(true);
  });

  it("never purges a tracked regular directory listed by mistake", async () => {
    await wt.resetForAttempt();
    // "src" is in gitlinkPurgePaths but is a TRACKED dir (ls-tree: 040000
    // tree, not 160000 commit) — the guard must leave it alone.
    expect(existsSync(path.join(path.normalize(wt.path), "src", "app.txt"))).toBe(true);
  });
});
