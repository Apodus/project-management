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

  it("treesIdentical: same commit/identical tree → true, differing tree → false, bad object → rejects", async () => {
    const ops = createGitOps(git);
    await git.checkout("main");
    await git.reset(["--hard", "origin/main"]);
    const head = await ops.resolveRef("HEAD");
    // Same commit / byte-identical trees → true (the no-op / already-landed case).
    expect(await ops.treesIdentical("HEAD", head)).toBe(true);
    expect(await ops.treesIdentical(head, "origin/main")).toBe(true);
    // A branch carrying a real change → trees differ → false (a normal land).
    expect(await ops.treesIdentical("HEAD", "feature/clean")).toBe(false);
    // A bad/nonexistent object REJECTS (not silently treated as "differ", which
    // would let a no-op push slip through).
    await expect(ops.treesIdentical("HEAD", "dead".repeat(10))).rejects.toThrow();
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
    // A normal non-zero exit is NOT a spawn failure: spawnError must be
    // undefined so the retry classifier reads this as a REAL failure (guard
    // against a false-positive transient). (phase 7.2 Step 8)
    expect(result.spawnError).toBeUndefined();
  });

  it("fetchFromPath materializes a never-pushed commit across clones (§4.3)", async () => {
    // Two independent clones of the bare remote. Clone A makes a commit that is
    // NEVER pushed to the remote; clone B fetches that commit's SHA directly
    // from A's worktree path (the §4.3 cross-worktree materialization) and can
    // then resolve it locally — proving the not-yet-pushed object reached B.
    // Use a dedicated bare repo + fresh clones so no cross-test state (other
    // pushed commits in the shared `bareRepo`) can make B coincidentally hold A's
    // commit object.
    const ffpBare = path.join(tmpRoot, "ffp-bare.git");
    const cloneA = path.join(tmpRoot, "ffp-a");
    const cloneB = path.join(tmpRoot, "ffp-b");
    await simpleGit().init(["--bare", "--initial-branch=main", ffpBare]);
    // Seed via A so main exists, then clone B from the same point.
    await simpleGit().clone(ffpBare, cloneA);
    const ga = simpleGit(cloneA);
    await configIdentity(ga);
    writeFileSync(path.join(cloneA, "base.txt"), "base\n");
    await ga.add(["base.txt"]);
    await ga.commit("ffp base");
    await ga.branch(["-M", "main"]);
    await ga.push(["-u", "origin", "main"]);
    await simpleGit().clone(ffpBare, cloneB);
    const gb = simpleGit(cloneB);
    await configIdentity(gb);

    // A commits locally, does NOT push.
    await ga.checkout("main");
    writeFileSync(path.join(cloneA, "speculative.txt"), "spec\n");
    await ga.add(["speculative.txt"]);
    await ga.commit("never-pushed speculative commit");
    const opsA = createGitOps(ga);
    const sha = await opsA.resolveRef("HEAD");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // The object is absent from B before the fetch. `cat-file -t` errors (and
    // simple-git rejects) on a missing object, so it actually proves presence —
    // unlike `rev-parse` (echoes a well-formed SHA without checking the store)
    // or `cat-file -e` (simple-git swallows its non-zero exit).
    const opsB = createGitOps(gb);
    await expect(gb.raw(["cat-file", "-t", sha])).rejects.toBeTruthy();

    // §4.3 cross-worktree fetch: B pulls the object from A's path. Now the
    // object is present (cat-file -t resolves to "commit") and resolveRef
    // returns it.
    await opsB.fetchFromPath(cloneA, sha);
    const objType = await gb.raw(["cat-file", "-t", sha]);
    expect(objType.trim()).toBe("commit");
    const resolved = await opsB.resolveRef(sha);
    expect(resolved).toBe(sha);
  });

  it("revert(sha): a landed sha → a revert commit undoing it (Campaign A4 P2)", async () => {
    // Dedicated fixture so the revert can't collide with the shared repo's
    // cross-test state. A change lands on main; revert(sha) produces a commit
    // that restores the tree to the pre-change state.
    const rBare = path.join(tmpRoot, "revert-ok-bare.git");
    const rWork = path.join(tmpRoot, "revert-ok-work");
    await simpleGit().init(["--bare", "--initial-branch=main", rBare]);
    await simpleGit().clone(rBare, rWork);
    const rg = simpleGit(rWork);
    await configIdentity(rg);
    writeFileSync(path.join(rWork, "f.txt"), "original\n");
    await rg.add(["f.txt"]);
    await rg.commit("base");
    await rg.branch(["-M", "main"]);
    await rg.push(["-u", "origin", "main"]);
    const baseSha = (await rg.revparse(["HEAD"])).trim();
    // A "bad" change lands.
    writeFileSync(path.join(rWork, "f.txt"), "bad change\n");
    await rg.add(["f.txt"]);
    await rg.commit("bad change");
    const badSha = (await rg.revparse(["HEAD"])).trim();

    const ops = createGitOps(rg);
    const result = await ops.revert(badSha);
    expect(result.ok).toBe(true);
    // The revert commit's tree is byte-identical to the pre-bad-change tree.
    expect(await ops.treesIdentical("HEAD", baseSha)).toBe(true);
    // A NEW commit was created (HEAD advanced past badSha).
    expect((await rg.revparse(["HEAD"])).trim()).not.toBe(badSha);
  });

  it("revert(sha): a conflicting revert → {ok:false, conflict:true}, aborted (no partial state)", async () => {
    const rBare = path.join(tmpRoot, "revert-conflict-bare.git");
    const rWork = path.join(tmpRoot, "revert-conflict-work");
    await simpleGit().init(["--bare", "--initial-branch=main", rBare]);
    await simpleGit().clone(rBare, rWork);
    const rg = simpleGit(rWork);
    await configIdentity(rg);
    writeFileSync(path.join(rWork, "f.txt"), "line1\n");
    await rg.add(["f.txt"]);
    await rg.commit("base");
    await rg.branch(["-M", "main"]);
    await rg.push(["-u", "origin", "main"]);
    // A change to revert.
    writeFileSync(path.join(rWork, "f.txt"), "line1-edited\n");
    await rg.add(["f.txt"]);
    await rg.commit("edit");
    const editSha = (await rg.revparse(["HEAD"])).trim();
    // A LATER change to the same line, so reverting `editSha` conflicts.
    writeFileSync(path.join(rWork, "f.txt"), "line1-edited-again\n");
    await rg.add(["f.txt"]);
    await rg.commit("edit again");
    const headBefore = (await rg.revparse(["HEAD"])).trim();

    const ops = createGitOps(rg);
    const result = await ops.revert(editSha);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(true);
    }
    // Aborted: HEAD unchanged and the tree is clean (no UU/markers left).
    expect((await rg.revparse(["HEAD"])).trim()).toBe(headBefore);
    const status = await rg.status();
    expect(status.conflicted).toHaveLength(0);
    expect(status.isClean()).toBe(true);
  });

  it("createBranch points a local branch at HEAD (checkout-able)", async () => {
    const ops = createGitOps(git);
    await git.checkout("main");
    await git.reset(["--hard", "origin/main"]);
    const head = (await git.revparse(["HEAD"])).trim();
    await ops.createBranch("pm/revert-test-branch");
    // The local branch resolves to HEAD and is checkout-able.
    const branchSha = (await git.revparse(["pm/revert-test-branch"])).trim();
    expect(branchSha).toBe(head);
    await git.checkout("pm/revert-test-branch");
    await git.checkout("main");
  });

  it("runVerify external AbortSignal kills the process well before the sleep", async () => {
    const ops = createGitOps(git);
    const logPath = path.join(tmpRoot, "verify-abort.log");
    // A command that sleeps ~9s; we abort after ~100ms and assert the promise
    // resolves WELL under the full sleep, reflecting an external kill.
    const cmd =
      process.platform === "win32"
        ? "ping -n 10 127.0.0.1 > nul"
        : "sleep 9";
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 100);
    const result = await ops.runVerify(cmd, 30_000, {
      cwd: workClone,
      logPath,
      signal: controller.signal,
      killGracePeriodMs: 500,
    });
    const elapsed = Date.now() - start;
    // Killed long before the ~9s sleep would naturally complete.
    expect(elapsed).toBeLessThan(5_000);
    // The kill is an external abort, NOT the internal timeout (30s never fired).
    expect(result.timedOut).toBe(false);
    // The result reflects a kill: non-zero exit or a kill signal.
    expect(result.exitCode !== 0 || result.signal !== null).toBe(true);
  }, 15_000);

  it("runVerify already-aborted signal kills immediately", async () => {
    const ops = createGitOps(git);
    const logPath = path.join(tmpRoot, "verify-pre-abort.log");
    const cmd =
      process.platform === "win32"
        ? "ping -n 10 127.0.0.1 > nul"
        : "sleep 9";
    const controller = new AbortController();
    controller.abort(); // aborted BEFORE runVerify spawns
    const start = Date.now();
    const result = await ops.runVerify(cmd, 30_000, {
      cwd: workClone,
      logPath,
      signal: controller.signal,
      killGracePeriodMs: 500,
    });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode !== 0 || result.signal !== null).toBe(true);
  }, 15_000);

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
