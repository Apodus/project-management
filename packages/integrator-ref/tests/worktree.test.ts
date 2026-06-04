import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { buildCleanArgs, createWorktree } from "../src/worktree.js";

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

describe.skipIf(!GIT_AVAILABLE)("worktree (real git)", () => {
  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-wt-"));
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

  function makeWorktree(name: string, cleanKeep: string[] = []) {
    return createWorktree({
      worktreeRoot,
      worktreeName: name,
      gitRemote: "origin",
      gitMainBranch: "main",
      gitRepoUrl: bareRepo,
      cleanKeep,
    });
  }

  it("ensureExists clones when path missing", async () => {
    const wt = makeWorktree("clone-me");
    expect(existsSync(wt.path)).toBe(false);
    await wt.ensureExists();
    expect(existsSync(path.join(wt.path, ".git"))).toBe(true);
    expect(existsSync(wt.logsDir)).toBe(true);
  });

  it("ensureExists is a no-op when already present", async () => {
    const wt = makeWorktree("noop");
    await wt.ensureExists();
    // Second call should not throw and the repo should still be intact.
    await wt.ensureExists();
    expect(existsSync(path.join(wt.path, ".git"))).toBe(true);
  });

  it("resetForAttempt restores a clean checkout of main", async () => {
    const wt = makeWorktree("reset-me");
    await wt.ensureExists();
    // Dirty the worktree.
    writeFileSync(path.join(wt.path, "garbage.txt"), "junk\n");
    writeFileSync(path.join(wt.path, "base.txt"), "modified\n");
    await wt.resetForAttempt();
    expect(existsSync(path.join(wt.path, "garbage.txt"))).toBe(false);
    const status = await wt.git.status();
    expect(status.isClean()).toBe(true);
  });

  it("resetForAttempt preserves untracked paths declared in cleanKeep", async () => {
    const wt = makeWorktree("keep-me", ["keep-dir"]);
    await wt.ensureExists();
    // An untracked path matching cleanKeep + an untracked path that does not.
    writeFileSync(path.join(wt.path, "keep-dir"), "preserved\n");
    writeFileSync(path.join(wt.path, "scratch.txt"), "junk\n");
    await wt.resetForAttempt();
    // The kept path survives; the non-kept untracked file is swept.
    expect(existsSync(path.join(wt.path, "keep-dir"))).toBe(true);
    expect(existsSync(path.join(wt.path, "scratch.txt"))).toBe(false);
  });

  it("detectCorruption returns false for a healthy worktree", async () => {
    const wt = makeWorktree("healthy");
    await wt.ensureExists();
    expect(await wt.detectCorruption()).toBe(false);
  });

  it("detectCorruption returns true when .git is gone", async () => {
    const wt = makeWorktree("corrupt");
    await wt.ensureExists();
    await rm(path.join(wt.path, ".git"), { recursive: true, force: true });
    expect(await wt.detectCorruption()).toBe(true);
  });

  it("repair re-clones a corrupted worktree", async () => {
    const wt = makeWorktree("repair-me");
    await wt.ensureExists();
    await rm(path.join(wt.path, ".git"), { recursive: true, force: true });
    expect(await wt.detectCorruption()).toBe(true);
    await wt.repair();
    expect(await wt.detectCorruption()).toBe(false);
    expect(existsSync(path.join(wt.path, ".git"))).toBe(true);
  });
});

// Pure helper — no git required, so it runs unconditionally (outside skipIf).
describe("buildCleanArgs", () => {
  it("empty cleanKeep yields the plain -d -x clean (pre-P1 byte-identity)", () => {
    expect(buildCleanArgs([])).toEqual(["-d", "-x"]);
  });

  it("each kept pattern adds an -e <pattern> exclusion", () => {
    expect(buildCleanArgs(["node_modules", ".cache/build"])).toEqual([
      "-d",
      "-x",
      "-e",
      "node_modules",
      "-e",
      ".cache/build",
    ]);
  });
});
