import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { createGitOps } from "../src/git-ops.js";
import { createWorktreePool, type WorktreePool } from "../src/worktree-pool.js";
import { assembleGroup } from "../src/group-assembly.js";

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

// ─── git-ops unit test: round-trip on a SINGLE repo ───────────────────

describe.skipIf(!GIT_AVAILABLE)("git-ops submodule ops (real git)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-subops-"));
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("updateSubmoduleGitlink/readSubmoduleGitlink round-trip + materialize populates a dir", async () => {
    // Seed an INNER source tree (a normal clone) and capture an inner SHA.
    const innerBare = path.join(tmpRoot, "inner.git");
    const innerWt = path.join(tmpRoot, "inner-wt");
    await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
    await simpleGit().clone(innerBare, innerWt);
    const innerGit = simpleGit(innerWt);
    await configIdentity(innerGit);
    writeFileSync(path.join(innerWt, "lib.txt"), "lib content\n");
    writeFileSync(path.join(innerWt, "README.md"), "inner\n");
    await innerGit.add(["lib.txt", "README.md"]);
    await innerGit.commit("inner sources");
    await innerGit.branch(["-M", "main"]);
    await innerGit.push(["-u", "origin", "main"]);
    const innerSha = (await innerGit.revparse(["HEAD"])).trim();

    // OUTER clone with a top-level file; no gitlink yet.
    const outerBare = path.join(tmpRoot, "outer.git");
    const outerWt = path.join(tmpRoot, "outer-wt");
    await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);
    await simpleGit().clone(outerBare, outerWt);
    const outerGit = simpleGit(outerWt);
    await configIdentity(outerGit);
    writeFileSync(path.join(outerWt, "top.txt"), "top\n");
    await outerGit.add(["top.txt"]);
    await outerGit.commit("outer init");
    await outerGit.branch(["-M", "main"]);
    await outerGit.push(["-u", "origin", "main"]);

    const ops = createGitOps(outerGit);

    // The gitlink path must have innerSha's objects locally before materialize.
    await ops.fetchFromPath(innerWt, innerSha);

    // update: stage + commit the 160000 gitlink. Returns the new outer HEAD.
    const ro = await ops.updateSubmoduleGitlink(GITLINK_PATH, innerSha);
    expect(ro).toMatch(/^[0-9a-f]{40}$/);

    // read: round-trips the SHA back.
    const readBack = await ops.readSubmoduleGitlink(GITLINK_PATH);
    expect(readBack).toBe(innerSha);

    // The commit MUST have an identity (no "Author identity unknown") — verify
    // by reading the author of HEAD (the worktree clone has identity configured
    // here, but the op sets its own -c identity regardless).
    const author = (await outerGit.raw(["log", "-1", "--format=%an"])).trim();
    expect(author.length).toBeGreaterThan(0);

    // materialize: the working tree at the gitlink path is now populated.
    await ops.materializeSubmoduleWorktree(GITLINK_PATH, innerSha);
    const libOnDisk = path.join(outerWt, "vendor", "rynx", "lib.txt");
    const readmeOnDisk = path.join(outerWt, "vendor", "rynx", "README.md");
    expect(existsSync(libOnDisk)).toBe(true);
    expect(existsSync(readmeOnDisk)).toBe(true);

    // The COMMITTED tree still carries ONLY the 160000 gitlink (materialize must
    // not have leaked expanded blobs into HEAD).
    const lsTree = await outerGit.raw(["ls-tree", "HEAD", GITLINK_PATH]);
    expect(lsTree.trim()).toMatch(/^160000 commit [0-9a-f]{40}\tvendor\/rynx$/);

    // readSubmoduleGitlink throws on a non-gitlink path (§11).
    await expect(ops.readSubmoduleGitlink("top.txt")).rejects.toThrow();
  });
});

// ─── group-assembly: real TWO-repo fixture ────────────────────────────

describe.skipIf(!GIT_AVAILABLE)("assembleGroup (real two-repo)", () => {
  let tmpRoot: string;
  let innerBare: string;
  let outerBare: string;
  let worktreeRoot: string;
  let innerMainSha: string;
  let innerFeatureSha: string;
  let outerFeatureSha: string;
  let outerSeedMainSha: string;
  let innerPool: WorktreePool;
  let outerPool: WorktreePool;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-grpasm-"));
    innerBare = path.join(tmpRoot, "inner.git");
    outerBare = path.join(tmpRoot, "outer.git");
    worktreeRoot = path.join(tmpRoot, "wtroot");

    await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
    await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);

    // ── seed INNER ──
    const innerSeed = path.join(tmpRoot, "inner-seed");
    await simpleGit().clone(innerBare, innerSeed);
    const ig = simpleGit(innerSeed);
    await configIdentity(ig);
    writeFileSync(path.join(innerSeed, "lib.txt"), "v1\n");
    await ig.add(["lib.txt"]);
    await ig.commit("inner main base");
    await ig.branch(["-M", "main"]);
    await ig.push(["-u", "origin", "main"]);
    innerMainSha = (await ig.revparse(["HEAD"])).trim();

    // inner feature branch: a new commit (clean — adds a file).
    await ig.checkoutLocalBranch("feature/inner");
    writeFileSync(path.join(innerSeed, "feature.txt"), "inner feature\n");
    await ig.add(["feature.txt"]);
    await ig.commit("inner feature commit");
    await ig.push(["-u", "origin", "feature/inner"]);
    innerFeatureSha = (await ig.revparse(["HEAD"])).trim();

    // ── seed OUTER (with the gitlink) ──
    const outerSeed = path.join(tmpRoot, "outer-seed");
    await simpleGit().clone(outerBare, outerSeed);
    const og = simpleGit(outerSeed);
    await configIdentity(og);
    writeFileSync(path.join(outerSeed, "top.txt"), "top v1\n");
    // .gitmodules referencing the gitlink path + inner URL (operator-seeded).
    // git parses .gitmodules AS git-config, so backslashes in a Windows path are
    // read as escapes ("bad config line"). Use forward slashes for the url value
    // (git accepts forward-slash paths on win32). The integrator never mutates
    // .gitmodules — only the gitlink SHA — so the url value is cosmetic here.
    const innerUrlForGitmodules = innerBare.replace(/\\/g, "/");
    writeFileSync(
      path.join(outerSeed, ".gitmodules"),
      `[submodule "rynx"]\n\tpath = ${GITLINK_PATH}\n\turl = ${innerUrlForGitmodules}\n`,
    );
    await og.add(["top.txt", ".gitmodules"]);
    // Seed the initial gitlink -> inner main base.
    await og.raw([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${innerMainSha},${GITLINK_PATH}`,
    ]);
    await og.commit("outer main base with gitlink");
    await og.branch(["-M", "main"]);
    await og.push(["-u", "origin", "main"]);
    outerSeedMainSha = (await og.revparse(["HEAD"])).trim();

    // outer feature branch: a new commit on a top-level file (clean rebase).
    await og.checkoutLocalBranch("feature/outer");
    writeFileSync(path.join(outerSeed, "app.txt"), "outer feature\n");
    await og.add(["app.txt"]);
    await og.commit("outer feature commit");
    await og.push(["-u", "origin", "feature/outer"]);
    outerFeatureSha = (await og.revparse(["HEAD"])).trim();

    // ── per-repo pools ──
    innerPool = createWorktreePool({
      worktreeRoot,
      worktreeName: "inner",
      gitRepoUrl: innerBare,
      gitRemote: "origin",
      gitMainBranch: "main",
      parallelism: 1,
    });
    outerPool = createWorktreePool({
      worktreeRoot,
      worktreeName: "outer",
      gitRepoUrl: outerBare,
      gitRemote: "origin",
      gitMainBranch: "main",
      parallelism: 1,
    });
    await innerPool.ensureAll();
    await outerPool.ensureAll();
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("assembles inner@Ri + outer gitlink->Ri + populated working tree", async () => {
    const result = await assembleGroup({
      acquireInner: () => innerPool.acquire(),
      releaseInner: (wt) => innerPool.release(wt),
      acquireOuter: () => outerPool.acquire(),
      releaseOuter: (wt) => outerPool.release(wt),
      gitOps: (p) => createGitOps(simpleGit(p)),
      innerRef: innerFeatureSha,
      outerRef: outerFeatureSha,
      gitlinkPath: GITLINK_PATH,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`assembly failed: ${result.reason} ${result.detail ?? ""}`);
    }

    const { innerWt, outerWt, Ri, Ro, outerGitOps } = result;

    // (a) inner worktree HEAD === Ri (the rebased inner feature SHA).
    const innerHead = (await simpleGit(innerWt.path).revparse(["HEAD"])).trim();
    expect(innerHead).toBe(Ri);
    expect(Ri).toMatch(/^[0-9a-f]{40}$/);

    // (b) outer ls-tree HEAD <gitlinkPath> shows 160000 commit <Ri>.
    const lsTree = await simpleGit(outerWt.path).raw([
      "ls-tree",
      "HEAD",
      GITLINK_PATH,
    ]);
    expect(lsTree.trim()).toBe(`160000 commit ${Ri}\t${GITLINK_PATH}`);

    // (c) readSubmoduleGitlink(outerWt, gitlinkPath) === Ri.
    const readBack = await outerGitOps.readSubmoduleGitlink(GITLINK_PATH);
    expect(readBack).toBe(Ri);

    // (d) the gitlink CHANGED from innerMainSha to Ri (a real bump, not no-op).
    expect(Ri).not.toBe(innerMainSha);
    expect(readBack).not.toBe(innerMainSha);

    // (e) R1-CRITICAL: the outer WORKING TREE at gitlinkPath is POPULATED with
    // the inner sources (proves step 9 materialize ran).
    const libOnDisk = path.join(outerWt.path, "vendor", "rynx", "lib.txt");
    const featureOnDisk = path.join(outerWt.path, "vendor", "rynx", "feature.txt");
    expect(existsSync(libOnDisk)).toBe(true);
    expect(existsSync(featureOnDisk)).toBe(true);

    // (f) Ro != the seeded outer main (the assembled outer advanced).
    expect(Ro).toMatch(/^[0-9a-f]{40}$/);
    expect(Ro).not.toBe(outerSeedMainSha);

    result.release();
  });

  it("backpressure: inner pool exhausted -> {ok:false, backpressure}, no deadlock", async () => {
    // Drain the inner pool (parallelism 1) so acquireInner returns null.
    const held = innerPool.acquire();
    expect(held).not.toBeNull();
    try {
      const result = await assembleGroup({
        acquireInner: () => innerPool.acquire(), // null now
        releaseInner: (wt) => innerPool.release(wt),
        acquireOuter: () => outerPool.acquire(),
        releaseOuter: (wt) => outerPool.release(wt),
        gitOps: (p) => createGitOps(simpleGit(p)),
        innerRef: innerFeatureSha,
        outerRef: outerFeatureSha,
        gitlinkPath: GITLINK_PATH,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("backpressure");
      // The OUTER pool must NOT be left leased (release-on-partial). Since inner
      // failed first, outer was never acquired; confirm it is fully free.
      const o = outerPool.acquire();
      expect(o).not.toBeNull();
      if (o) outerPool.release(o);
    } finally {
      if (held) innerPool.release(held);
    }
  });

  it("backpressure: outer pool exhausted -> releases the acquired inner (no leak)", async () => {
    // Inner free, outer drained: assembly must acquire inner then fail on outer,
    // and MUST release the inner it took (deadlock-free partial release).
    const heldOuter = outerPool.acquire();
    expect(heldOuter).not.toBeNull();
    try {
      const result = await assembleGroup({
        acquireInner: () => innerPool.acquire(),
        releaseInner: (wt) => innerPool.release(wt),
        acquireOuter: () => outerPool.acquire(), // null now
        releaseOuter: (wt) => outerPool.release(wt),
        gitOps: (p) => createGitOps(simpleGit(p)),
        innerRef: innerFeatureSha,
        outerRef: outerFeatureSha,
        gitlinkPath: GITLINK_PATH,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("backpressure");
      // The inner slot taken-then-released must be reacquirable.
      const i = innerPool.acquire();
      expect(i).not.toBeNull();
      if (i) innerPool.release(i);
    } finally {
      if (heldOuter) outerPool.release(heldOuter);
    }
  });
});
