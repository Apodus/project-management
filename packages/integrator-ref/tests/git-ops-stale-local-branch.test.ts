import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { createGitOps } from "../src/git-ops.js";
import { createWorktree } from "../src/worktree.js";

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

/**
 * STALE-LOCAL-BRANCH REGRESSION (2026-08-22) — the client-reported false reject.
 *
 * A worker submits `fix/x`, the integrator rejects it, the worker pushes the fix
 * to THE SAME BRANCH, and the integrator replays the OLD tip — rejecting a correct
 * fix with the error that fix removes. Cause: `git checkout <branch>` only DWIMs to
 * `<remote>/<branch>` while no local branch of that name exists; attempt 1 creates
 * one and `git rebase` moves it onto that attempt's commits, so the pool slot keeps
 * a local `fix/x` pinned to the rejected content forever. `resetForAttempt` fetches
 * (advancing the remote-tracking ref) but never touches the local branch.
 *
 * The test drives the REAL lifecycle — one long-lived slot, resetForAttempt between
 * attempts, a real force-push in between — because the defect lives in the
 * interaction between the pool clone's longevity and checkout DWIM, not in either
 * alone.
 */
describe.skipIf(!GIT_AVAILABLE)("rebaseOnto: resubmission on the same branch", () => {
  let tmpRoot: string;
  let bareRepo: string;
  let authorClone: string;
  let slotRoot: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-stalebranch-"));
    bareRepo = path.join(tmpRoot, "bare.git");
    authorClone = path.join(tmpRoot, "author");
    slotRoot = path.join(tmpRoot, "slots");

    await simpleGit().init(["--bare", "--initial-branch=main", bareRepo]);
    await simpleGit().clone(bareRepo, authorClone);
    const author = simpleGit(authorClone);
    await configIdentity(author);
    writeFileSync(path.join(authorClone, "base.txt"), "base\n");
    await author.add(["base.txt"]);
    await author.commit("initial commit");
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

  it("rebases the RE-PUSHED tip, not the tip of the rejected attempt", async () => {
    const author = simpleGit(authorClone);
    const branch = "fix/same-branch";

    // ── the worker's first submission: a broken fix ──
    await author.checkout("main");
    await author.checkoutLocalBranch(branch);
    writeFileSync(path.join(authorClone, "fix.txt"), "BROKEN\n");
    await author.add(["fix.txt"]);
    await author.commit("first attempt (broken)");
    await author.push(["-u", "origin", branch]);

    // ── the integrator's pool slot: cloned once, reused for the life of the daemon ──
    const wt = createWorktree({
      worktreeRoot: slotRoot,
      worktreeName: "slot-0",
      gitRemote: "origin",
      gitMainBranch: "main",
      gitRepoUrl: bareRepo,
      cleanKeep: [],
    });
    await wt.ensureExists();
    await configIdentity(wt.git);
    const ops = createGitOps(wt.git, { gitRemote: "origin" });

    // attempt 1 — this is what creates (and then rebase-moves) the local branch
    await wt.resetForAttempt();
    const base1 = await ops.resolveRef("origin/main");
    const attempt1 = await ops.rebaseOnto(base1, branch);
    expect(attempt1.ok).toBe(true);
    expect(readFileSync(path.join(wt.path, "fix.txt"), "utf8").trim()).toBe("BROKEN");
    // The slot now holds a local branch pinned to attempt 1 — the trap.
    const stale = (await wt.git.revparse([branch])).trim();

    // ── the worker fixes it and re-pushes THE SAME BRANCH (force — a rebase/amend) ──
    writeFileSync(path.join(authorClone, "fix.txt"), "FIXED\n");
    await author.add(["fix.txt"]);
    await author.commit("the correct fix");
    await author.push(["-f", "origin", branch]);
    const submittedTip = (await author.revparse([branch])).trim();
    expect(submittedTip).not.toBe(stale);

    // ── attempt 2, same slot ──
    await wt.resetForAttempt();
    // The fetch DID advance the remote-tracking ref; the defect was never here.
    expect((await wt.git.revparse([`origin/${branch}`])).trim()).toBe(submittedTip);
    // ...and the local branch is still pinned to the rejected attempt.
    expect((await wt.git.revparse([branch])).trim()).toBe(stale);

    const base2 = await ops.resolveRef("origin/main");
    const attempt2 = await ops.rebaseOnto(base2, branch);

    expect(attempt2.ok).toBe(true);
    // THE ASSERTION: the integrator judged the re-pushed commit. Before the fix
    // this read "BROKEN" — the rejected attempt, replayed.
    expect(readFileSync(path.join(wt.path, "fix.txt"), "utf8").trim()).toBe("FIXED");
    expect(attempt2.checkedOutSha).toBe(submittedTip);
  });

  it("falls back to a local-only branch when no remote-tracking ref exists", async () => {
    // The A4 revert path builds `pm/revert-<sha>` locally (createBranch) and the
    // resolver may replay a ref that was never pushed. Remote-first resolution
    // must FAIL OPEN to the bare name rather than throw.
    const wt = createWorktree({
      worktreeRoot: slotRoot,
      worktreeName: "slot-local-only",
      gitRemote: "origin",
      gitMainBranch: "main",
      gitRepoUrl: bareRepo,
      cleanKeep: [],
    });
    await wt.ensureExists();
    await configIdentity(wt.git);
    const ops = createGitOps(wt.git, { gitRemote: "origin" });

    await wt.resetForAttempt();
    writeFileSync(path.join(wt.path, "local-only.txt"), "local\n");
    await wt.git.add(["local-only.txt"]);
    await wt.git.commit("local-only commit");
    await ops.createBranch("pm/revert-local");
    const localTip = (await wt.git.revparse(["pm/revert-local"])).trim();
    await wt.resetForAttempt();

    const base = await ops.resolveRef("origin/main");
    const result = await ops.rebaseOnto(base, "pm/revert-local");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.checkedOutSha).toBe(localTip);
  });
});
