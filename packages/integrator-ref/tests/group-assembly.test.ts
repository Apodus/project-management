import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function hasGitLfs(): boolean {
  try {
    return spawnSync("git", ["lfs", "version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const LFS_AVAILABLE = GIT_AVAILABLE && hasGitLfs();

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

    // materialize: the working tree at the gitlink path is now populated. Pass
    // innerWt as the 3rd arg to exercise the LFS-aware opt-in path. This is the
    // NO-LFS byte-identical guard: a non-LFS inner → `git lfs ls-files` returns
    // EMPTY → overlay no-op → result byte-identical to the non-opt-in path.
    await ops.materializeSubmoduleWorktree(GITLINK_PATH, innerSha, innerWt);
    const libOnDisk = path.join(outerWt, "vendor", "rynx", "lib.txt");
    const readmeOnDisk = path.join(outerWt, "vendor", "rynx", "README.md");
    expect(existsSync(libOnDisk)).toBe(true);
    expect(existsSync(readmeOnDisk)).toBe(true);
    // Same content as the inner sources (the overlay is a no-op for a non-LFS
    // inner; checkout-index wrote the regular blobs). EOL-normalized: on a
    // Windows host with autocrlf=true, checkout-index writes CRLF — which
    // correctly matches a normal git checkout of the inner repo. The byte
    // content (not the line ending) is what this no-LFS guard asserts.
    expect(readFileSync(libOnDisk, "utf8").replace(/\r\n/g, "\n")).toBe("lib content\n");
    expect(readFileSync(readmeOnDisk, "utf8").replace(/\r\n/g, "\n")).toBe("inner\n");

    // The COMMITTED tree still carries ONLY the 160000 gitlink (materialize must
    // not have leaked expanded blobs into HEAD).
    const lsTree = await outerGit.raw(["ls-tree", "HEAD", GITLINK_PATH]);
    expect(lsTree.trim()).toMatch(/^160000 commit [0-9a-f]{40}\tvendor\/rynx$/);

    // readSubmoduleGitlink throws on a non-gitlink path (§11).
    await expect(ops.readSubmoduleGitlink("top.txt")).rejects.toThrow();

    // ── PURGE-BEFORE-MATERIALIZE: a stale overlay file never survives. ──
    // Files at a committed gitlink path are INVISIBLE to git (status/clean/
    // reset all skip them), and checkout-index -f overwrites but never
    // deletes — so a file present from a PREVIOUS materialize (e.g. one the
    // next inner SHA deleted) would silently persist without the purge. Seed
    // a stale file and re-materialize: it must be gone, the real tree intact.
    const staleOnDisk = path.join(outerWt, "vendor", "rynx", "stale-deleted.txt");
    writeFileSync(staleOnDisk, "left over from a previous assembly\n");
    await ops.materializeSubmoduleWorktree(GITLINK_PATH, innerSha, innerWt);
    expect(existsSync(staleOnDisk)).toBe(false);
    expect(existsSync(libOnDisk)).toBe(true);
    expect(existsSync(readmeOnDisk)).toBe(true);
  });

  // BEHAVIORAL PIN (inner-only groups campaign): updateSubmoduleGitlink's
  // no-change IDEMPOTENCE is contractual. Calling it again with the SAME sha
  // returns the same HEAD and creates NO commit (no empty gitlink-bump — the
  // no-op land path depends on this: an up-to-date FF push then lands cleanly
  // at the current main). This pins behavior that previously held only
  // incidentally (simple-git's empty-stderr heuristic on git's "nothing to
  // commit" exit 1) and is now explicit by construction.
  it("updateSubmoduleGitlink is idempotent: same sha again → same HEAD, no new commit", async () => {
    // Fresh inner + outer pair (this describe's tests build their own repos).
    const innerBare = path.join(tmpRoot, "idem-inner.git");
    const innerWt = path.join(tmpRoot, "idem-inner-wt");
    await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
    await simpleGit().clone(innerBare, innerWt);
    const innerGit = simpleGit(innerWt);
    await configIdentity(innerGit);
    writeFileSync(path.join(innerWt, "lib.txt"), "idem lib\n");
    await innerGit.add(["lib.txt"]);
    await innerGit.commit("inner sources");
    await innerGit.branch(["-M", "main"]);
    const innerSha = (await innerGit.revparse(["HEAD"])).trim();

    const outerBare = path.join(tmpRoot, "idem-outer.git");
    const outerWt = path.join(tmpRoot, "idem-outer-wt");
    await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);
    await simpleGit().clone(outerBare, outerWt);
    const outerGit = simpleGit(outerWt);
    await configIdentity(outerGit);
    writeFileSync(path.join(outerWt, "top.txt"), "top\n");
    await outerGit.add(["top.txt"]);
    await outerGit.commit("outer init");
    await outerGit.branch(["-M", "main"]);

    const ops = createGitOps(outerGit);

    // First call: a REAL gitlink change → a new commit.
    const ro1 = await ops.updateSubmoduleGitlink(GITLINK_PATH, innerSha);
    expect(ro1).toMatch(/^[0-9a-f]{40}$/);
    const countAfterFirst = parseInt(
      (await outerGit.raw(["rev-list", "--count", "HEAD"])).trim(),
      10,
    );

    // Second call with the SAME sha: returns the SAME HEAD, no new commit.
    const ro2 = await ops.updateSubmoduleGitlink(GITLINK_PATH, innerSha);
    expect(ro2).toBe(ro1);
    const countAfterSecond = parseInt(
      (await outerGit.raw(["rev-list", "--count", "HEAD"])).trim(),
      10,
    );
    expect(countAfterSecond).toBe(countAfterFirst);
    // The gitlink still reads back the sha.
    expect(await ops.readSubmoduleGitlink(GITLINK_PATH)).toBe(innerSha);
  }, 30_000);
});

// ─── materialize populates NESTED submodules (real git, file protocol) ─
//
// The game_one shape: the inner repo (rynx) vendors its deps as its OWN
// submodules (jolt, zstd, …). `sha`'s tree records them as 160000 gitlinks,
// which checkout-index SKIPS — so without the nested overlay the assembled
// outer tree lacks every vendored dep and the outer verify cannot fetch them
// (the gitlink path is not a git repo in the outer worktree). materialize must
// initialize them in the INNER pool worktree (a real clone) and export each
// nested HEAD tree into the overlay.
describe.skipIf(!GIT_AVAILABLE)("materialize populates nested submodules", () => {
  let tmpRoot: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-nested-"));
    // Modern git blocks file-protocol submodule clones (CVE-2022-39253
    // mitigation). The materialize-spawned `submodule update --init` inherits
    // process.env, so allow it for this suite via GIT_CONFIG_* (scoped here +
    // restored in afterAll — never touches global git config). Production is
    // unaffected: real linked repos use https/ssh URLs.
    for (const [k, v] of Object.entries({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.file.allow",
      GIT_CONFIG_VALUE_0: "always",
    })) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("exports each nested submodule's tree into the overlay (no .git pointers)", async () => {
    // ── NESTED repo (the vendored dep) ──
    const nestedBare = path.join(tmpRoot, "nested.git");
    const nestedSeed = path.join(tmpRoot, "nested-seed");
    await simpleGit().init(["--bare", "--initial-branch=main", nestedBare]);
    await simpleGit().clone(nestedBare, nestedSeed);
    const ng = simpleGit(nestedSeed);
    await configIdentity(ng);
    writeFileSync(path.join(nestedSeed, "dep.txt"), "vendored dep\n");
    await ng.add(["dep.txt"]);
    await ng.commit("nested dep");
    await ng.branch(["-M", "main"]);
    await ng.push(["-u", "origin", "main"]);

    // ── INNER repo embedding it as a submodule at external/dep ──
    const innerBare = path.join(tmpRoot, "inner.git");
    const innerSeed = path.join(tmpRoot, "inner-seed");
    await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
    await simpleGit().clone(innerBare, innerSeed);
    const ig = simpleGit(innerSeed);
    await configIdentity(ig);
    writeFileSync(path.join(innerSeed, "lib.txt"), "inner lib\n");
    await ig.add(["lib.txt"]);
    // submodule add CLONES the nested repo (file protocol — allowed via env).
    await ig.raw(["submodule", "add", nestedBare.replace(/\\/g, "/"), "external/dep"]);
    await ig.commit("inner with nested submodule");
    await ig.branch(["-M", "main"]);
    await ig.push(["-u", "origin", "main"]);
    const innerSha = (await ig.revparse(["HEAD"])).trim();

    // ── The inner POOL worktree: a FRESH clone (submodule NOT initialized —
    //    exactly the daemon's pool-slot state). materialize must run
    //    `submodule update --init --recursive` here itself. ──
    const innerPoolWt = path.join(tmpRoot, "inner-pool-0");
    await simpleGit().clone(innerBare, innerPoolWt);
    expect(existsSync(path.join(innerPoolWt, "external", "dep", "dep.txt"))).toBe(false);

    // ── OUTER repo with the gitlink ──
    const outerBare = path.join(tmpRoot, "outer.git");
    const outerWt = path.join(tmpRoot, "outer-wt");
    await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);
    await simpleGit().clone(outerBare, outerWt);
    const og = simpleGit(outerWt);
    await configIdentity(og);
    writeFileSync(path.join(outerWt, "top.txt"), "top\n");
    await og.add(["top.txt"]);
    await og.commit("outer init");
    await og.branch(["-M", "main"]);

    const ops = createGitOps(og);
    await ops.fetchFromPath(innerPoolWt, innerSha);
    await ops.updateSubmoduleGitlink(GITLINK_PATH, innerSha);
    await ops.materializeSubmoduleWorktree(GITLINK_PATH, innerSha, innerPoolWt);

    // The inner repo's own tree is materialized…
    expect(existsSync(path.join(outerWt, "vendor", "rynx", "lib.txt"))).toBe(true);
    // …AND the nested submodule's tree (the fix: previously an empty hole).
    const depOnDisk = path.join(outerWt, "vendor", "rynx", "external", "dep", "dep.txt");
    expect(existsSync(depOnDisk)).toBe(true);
    expect(readFileSync(depOnDisk, "utf8").replace(/\r\n/g, "\n")).toBe("vendored dep\n");
    // Tree-exact export: NO .git pointer is copied into the overlay (a copied
    // gitdir pointer into the inner clone's .git/modules would be poison).
    expect(existsSync(path.join(outerWt, "vendor", "rynx", "external", "dep", ".git"))).toBe(false);
    // The committed outer tree still carries ONLY the 160000 gitlink.
    const lsTree = await og.raw(["ls-tree", "HEAD", GITLINK_PATH]);
    expect(lsTree.trim()).toMatch(/^160000 commit [0-9a-f]{40}\tvendor\/rynx$/);
    // Side effect (by design): the inner pool worktree now has the nested
    // submodule initialized — persistent across attempts (clean skips .git).
    expect(existsSync(path.join(innerPoolWt, "external", "dep", "dep.txt"))).toBe(true);
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
      cleanKeep: [],
    });
    outerPool = createWorktreePool({
      worktreeRoot,
      worktreeName: "outer",
      gitRepoUrl: outerBare,
      gitRemote: "origin",
      gitMainBranch: "main",
      parallelism: 1,
      cleanKeep: [],
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
    const lsTree = await simpleGit(outerWt.path).raw(["ls-tree", "HEAD", GITLINK_PATH]);
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

// ─── materialize is LFS-aware (real git + git-lfs, NO network) ─────────
//
// Proves the fix: an inner repo with an LFS-tracked binary, materialized into an
// outer worktree whose smudge filter IS enabled, lands the REAL binary bytes (not
// a pointer) and does NOT 404 on the outer LFS endpoint. Per clarification A, the
// assertion is "new file == real bytes" — the bug shape is a throw, so a clean
// run that yields the real bytes is the proof. NO push, NO network.
describe.skipIf(!LFS_AVAILABLE)("materialize is LFS-aware (real git+lfs, no network)", () => {
  let tmpRoot: string;
  // A fixed, deterministic "binary" (NOT randomBytes — reproducible).
  const originalBytes = Buffer.from([
    0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0xfc, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80,
  ]);

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-lfs-"));
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("materializes inner LFS files as REAL binaries in the outer worktree", async () => {
    // ── 1. Inner repo with an LFS-tracked binary; capture innerSha. NO push. ──
    const innerBare = path.join(tmpRoot, "inner.git");
    const innerWt = path.join(tmpRoot, "inner-wt");
    await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
    await simpleGit().clone(innerBare, innerWt);
    const innerGit = simpleGit(innerWt);
    await configIdentity(innerGit);
    await innerGit.raw(["lfs", "install", "--local"]);
    await innerGit.raw(["lfs", "track", "*.bin"]);
    writeFileSync(path.join(innerWt, "blob.bin"), originalBytes);
    await innerGit.add([".gitattributes", "blob.bin"]);
    await innerGit.commit("inner lfs binary");
    await innerGit.branch(["-M", "main"]);
    const innerSha = (await innerGit.revparse(["HEAD"])).trim();

    // Fixture sanity: the working-tree file is the REAL bytes (smudged locally)…
    expect(Buffer.compare(readFileSync(path.join(innerWt, "blob.bin")), originalBytes)).toBe(0);
    // …but the COMMITTED blob is an LFS POINTER.
    const committedBlob = await innerGit.raw(["show", "HEAD:blob.bin"]);
    expect(committedBlob.startsWith("version https://git-lfs")).toBe(true);

    // ── 2. Outer repo with a top file; ENABLE the local LFS smudge filter ──
    //    (clarification B — deterministic regardless of host global LFS state, so
    //    the test genuinely exercises the smudge path the fix defuses).
    const outerBare = path.join(tmpRoot, "outer.git");
    const outerWt = path.join(tmpRoot, "outer-wt");
    await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);
    await simpleGit().clone(outerBare, outerWt);
    const outerGit = simpleGit(outerWt);
    await configIdentity(outerGit);
    await outerGit.raw(["lfs", "install", "--local"]);
    writeFileSync(path.join(outerWt, "top.txt"), "top\n");
    await outerGit.add(["top.txt"]);
    await outerGit.commit("outer init");
    await outerGit.branch(["-M", "main"]);

    const ops = createGitOps(simpleGit(outerWt));

    // ── 3. Mirror the real assembly sequence (steps 7-9) ──
    // step 7: copy Ri's objects (the POINTER blob — NOT the LFS object) into outer.
    await ops.fetchFromPath(innerWt, innerSha);
    // step 8: commit the gitlink at GITLINK_PATH -> innerSha.
    await ops.updateSubmoduleGitlink(GITLINK_PATH, innerSha);
    // step 9: materialize — LFS-aware (opt-in via innerWt). WITHOUT the fix this
    // throws ("smudge filter lfs failed", exit 128) as the outer smudge 404s.
    await ops.materializeSubmoduleWorktree(GITLINK_PATH, innerSha, innerWt);

    // ── 4. Assertions: the materialized file is the REAL binary, not a pointer ──
    const dst = path.join(outerWt, "vendor", "rynx", "blob.bin");
    expect(existsSync(dst)).toBe(true);
    // PRIMARY: real bytes, byte-for-byte.
    expect(Buffer.compare(readFileSync(dst), originalBytes)).toBe(0);
    // It is NOT an LFS pointer.
    expect(readFileSync(dst, "utf8").startsWith("version https://git-lfs")).toBe(false);
    // .gitattributes was also materialized.
    expect(existsSync(path.join(outerWt, "vendor", "rynx", ".gitattributes"))).toBe(true);
    // The committed outer tree still carries ONLY the 160000 gitlink at the path.
    const lsTree = await outerGit.raw(["ls-tree", "HEAD", GITLINK_PATH]);
    expect(lsTree.trim()).toMatch(/^160000 commit [0-9a-f]{40}\tvendor\/rynx$/);
  });
});
