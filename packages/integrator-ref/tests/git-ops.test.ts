import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { createGitOps } from "../src/git-ops.js";

function hasGit(): boolean {
  try {
    const r = spawnSync("git", ["--version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

// Shared fixture state.
let tmpRoot: string;
let bareRepo: string;
let workClone: string; // the "integrator" clone we run ops against
let authorClone: string; // a second clone used to create branches + simulate races
let git: SimpleGit;

async function configIdentity(g: SimpleGit): Promise<void> {
  await g.addConfig("user.email", "int@test.local");
  await g.addConfig("user.name", "Integrator Test");
  await g.addConfig("commit.gpgsign", "false");
}

describe.skipIf(!GIT_AVAILABLE)("git-ops (real git)", () => {
  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-gitops-"));
    bareRepo = path.join(tmpRoot, "bare.git");
    workClone = path.join(tmpRoot, "work");
    authorClone = path.join(tmpRoot, "author");

    // Create a bare repo and seed it with an initial commit on main.
    await simpleGit().init(["--bare", "--initial-branch=main", bareRepo]);

    // Seed via the author clone.
    await simpleGit().clone(bareRepo, authorClone);
    const author = simpleGit(authorClone);
    await configIdentity(author);
    writeFileSync(path.join(authorClone, "base.txt"), "base\n");
    await author.add(["base.txt"]);
    await author.commit("initial commit");
    // Ensure branch is named main, then push.
    await author.branch(["-M", "main"]);
    await author.push(["-u", "origin", "main"]);

    // Create a feature branch that touches a new file (clean rebase).
    await author.checkoutLocalBranch("feature/clean");
    writeFileSync(path.join(authorClone, "feature.txt"), "feature\n");
    await author.add(["feature.txt"]);
    await author.commit("add feature file");
    await author.push(["-u", "origin", "feature/clean"]);

    // Create a feature branch that conflicts with main (edits base.txt).
    await author.checkout("main");
    await author.checkoutLocalBranch("feature/conflict");
    writeFileSync(path.join(authorClone, "base.txt"), "feature-side\n");
    await author.add(["base.txt"]);
    await author.commit("edit base on feature");
    await author.push(["-u", "origin", "feature/conflict"]);
    await author.checkout("main");

    // The integrator work clone.
    await simpleGit().clone(bareRepo, workClone);
    git = simpleGit(workClone);
    await configIdentity(git);
    await git.fetch("origin");
    // Track the feature branches locally.
    await git.checkout(["-b", "feature/clean", "origin/feature/clean"]);
    await git.checkout(["-b", "feature/conflict", "origin/feature/conflict"]);
    await git.checkout("main");
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("fetch succeeds", async () => {
    const ops = createGitOps(git);
    await expect(ops.fetch("origin")).resolves.toBeUndefined();
  });

  it("resolveRef returns a sha", async () => {
    const ops = createGitOps(git);
    const sha = await ops.resolveRef("HEAD");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("rebaseOnto clean branch → ok with treeSha", async () => {
    const ops = createGitOps(git);
    const base = await ops.resolveRef("origin/main");
    const result = await ops.rebaseOnto(base, "feature/clean");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.treeSha).toMatch(/^[0-9a-f]{40}$/);
    }
    // Reset back to main for subsequent tests.
    await git.checkout("main");
  });

  it("rebaseOnto conflicting branch → not ok with conflicting files", async () => {
    const ops = createGitOps(git);
    // Create a divergent commit on local main that edits base.txt differently
    // than feature/conflict does, so the rebase genuinely conflicts.
    await git.checkout("main");
    await git.reset(["--hard", "origin/main"]);
    writeFileSync(path.join(workClone, "base.txt"), "main-side-edit\n");
    await git.add(["base.txt"]);
    await git.commit("diverging edit on main");
    const base = await ops.resolveRef("HEAD");

    const result = await ops.rebaseOnto(base, "feature/conflict");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflictingFiles).toContain("base.txt");
    }
    // Rebase aborts on conflict; confirm we're back on a clean branch.
    await git.checkout("main");
    await git.reset(["--hard", "origin/main"]);
  });

  it("push success advances remote", async () => {
    const ops = createGitOps(git);
    // Make a fresh commit on main and push it.
    writeFileSync(path.join(workClone, "pushme.txt"), "x\n");
    await git.checkout("main");
    await git.add(["pushme.txt"]);
    await git.commit("push test commit");
    const result = await ops.push("origin", "main");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pushedSha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("push non_fast_forward when remote moved", async () => {
    const ops = createGitOps(git);
    // Author pushes a commit so the remote is ahead of the work clone.
    const author = simpleGit(authorClone);
    await author.checkout("main");
    await author.pull("origin", "main");
    writeFileSync(path.join(authorClone, "race.txt"), "race\n");
    await author.add(["race.txt"]);
    await author.commit("author race commit");
    await author.push("origin", "main");

    // Work clone commits locally WITHOUT fetching, then tries to push.
    writeFileSync(path.join(workClone, "local.txt"), "local\n");
    await git.add(["local.txt"]);
    await git.commit("local commit racing");
    const result = await ops.push("origin", "main");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("non_fast_forward");
    }
    // Recover the work clone for cleanliness.
    await git.fetch("origin");
    await git.reset(["--hard", "origin/main"]);
  });

  it("runVerify exit 0 captures stdout", async () => {
    const ops = createGitOps(git);
    const logPath = path.join(tmpRoot, "verify-0.log");
    const result = await ops.runVerify("echo hello-verify", 10_000, {
      cwd: workClone,
      logPath,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("hello-verify");
  });

  it("runVerify non-zero exit code is surfaced", async () => {
    const ops = createGitOps(git);
    const logPath = path.join(tmpRoot, "verify-7.log");
    const cmd =
      process.platform === "win32" ? "exit 7" : "exit 7";
    const result = await ops.runVerify(cmd, 10_000, {
      cwd: workClone,
      logPath,
    });
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it("runVerify timeout kills the process and flags timedOut", async () => {
    const ops = createGitOps(git);
    const logPath = path.join(tmpRoot, "verify-timeout.log");
    // A command that sleeps longer than the timeout.
    const cmd =
      process.platform === "win32"
        ? "ping -n 10 127.0.0.1 > nul"
        : "sleep 10";
    const result = await ops.runVerify(cmd, 800, {
      cwd: workClone,
      logPath,
      killGracePeriodMs: 500,
    });
    expect(result.timedOut).toBe(true);
  }, 15_000);
});
