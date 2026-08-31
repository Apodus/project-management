import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { createBindingResolver } from "../src/binding-clone.js";
import { applyGitLocalPolicy } from "../src/git-policy.js";
import { createWorktree } from "../src/worktree.js";

function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

const GITLINK_PATH = "vendor/rynx";
/** Arbitrary 40-hex gitlink targets — never dereferenced by update-index/commit. */
const DANGLING = "1".repeat(40);
const DANGLING_BUMPED = "3".repeat(40);
const NESTED_DANGLING = "2".repeat(40);

// .gitmodules is parsed AS git-config, so forward slashes; the url is cosmetic
// (cases 1–4 never clone the inner).
const GITMODULES = `[submodule "rynx"]\n\tpath = ${GITLINK_PATH}\n\turl = https://example.invalid/rynx.git\n`;

async function configIdentity(g: SimpleGit): Promise<void> {
  await g.addConfig("user.email", "int@test.local");
  await g.addConfig("user.name", "Integrator Test");
  await g.addConfig("commit.gpgsign", "false");
}

/** Read a repo-local key; null when unset (git exits 1). */
function readLocal(dir: string, key: string): string | null {
  const r = spawnSync("git", ["config", "--local", "--get", key], { cwd: dir, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Drop a repo-local key. `--unset` exits 5 when the key is absent — tolerated. */
function unsetLocal(dir: string, key: string): void {
  spawnSync("git", ["config", "--local", "--unset", key], { cwd: dir, encoding: "utf8" });
}

// ─────────────────────────────────────────────────────────────────────────────
// The integrator manages the cross-repo gitlink by hand, so any AUTOMATIC
// submodule recursion by git is pure liability. These cases pin the repo-local
// policy (src/git-policy.ts) end-to-end through production code — the worktree
// pool's clone lifecycle and the binding mirror's — rather than through a shell
// repro.
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!GIT_AVAILABLE)("git recursion suppressed in every clone we own", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-recurse-"));
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* Windows file locking — best effort. */
    }
  });

  /**
   * An isolated outer bare+seed whose `main` carries top.txt, a .gitmodules
   * stanza and a 160000 gitlink at `vendor/rynx`. Returns the pushed seed.
   */
  async function seedOuter(label: string): Promise<{ bare: string; seed: SimpleGit }> {
    const bare = path.join(tmpRoot, `${label}.git`);
    const dir = path.join(tmpRoot, `${label}-seed`);
    await simpleGit().init(["--bare", "--initial-branch=main", bare]);
    await simpleGit().clone(bare, dir);
    const g = simpleGit(dir);
    await configIdentity(g);
    writeFileSync(path.join(dir, "top.txt"), "top v1\n");
    writeFileSync(path.join(dir, ".gitmodules"), GITMODULES);
    await g.add(["top.txt", ".gitmodules"]);
    await g.raw(["update-index", "--add", "--cacheinfo", `160000,${DANGLING},${GITLINK_PATH}`]);
    await g.commit("outer base with gitlink");
    await g.branch(["-M", "main"]);
    await g.push(["-u", "origin", "main"]);
    return { bare, seed: g };
  }

  function makeSlot(label: string, gitRepoUrl: string) {
    return createWorktree({
      worktreeRoot: path.join(tmpRoot, `${label}-root`),
      worktreeName: "slot-0",
      gitRemote: "origin",
      gitMainBranch: "main",
      gitRepoUrl,
      cleanKeep: [],
    });
  }

  /**
   * Stand in for what materializeSubmoduleWorktree (git-ops.ts) leaves in the
   * OUTER slot permanently: the inner sources written at the gitlink path as
   * PLAIN FILES with no .git. The outer pool runs with `gitlinkPurgePaths: []`
   * on purpose, and reset --hard / clean -fdx are blind to content at a
   * committed gitlink path — so the overlay outlives every attempt.
   */
  function writeOverlay(slotPath: string): void {
    const dir = path.join(slotPath, ...GITLINK_PATH.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "src.txt"), "materialized inner sources\n");
  }

  /** Push an outer commit that CHANGES the managed gitlink. */
  async function pushGitlinkBump(seed: SimpleGit, target: string): Promise<void> {
    await seed.raw(["update-index", "--add", "--cacheinfo", `160000,${target},${GITLINK_PATH}`]);
    await seed.commit(`bump gitlink to ${target.slice(0, 7)}`);
    await seed.push(["origin", "main"]);
  }

  it("1: a fetch across a gitlink bump survives a materialize overlay (dangling target)", async () => {
    const { bare, seed } = await seedOuter("case1");
    const wt = makeSlot("case1", bare);
    await wt.ensureExists();
    writeOverlay(wt.path);
    await pushGitlinkBump(seed, DANGLING_BUMPED);

    // Without the policy this rejects at `git fetch origin` with exit 1,
    // "Could not access submodule 'vendor/rynx'" — the failure lands inside
    // assembleGroup's try before any classification runs, so it surfaced as the
    // catch-all reason (`gitlink_mismatch` then; `assembly_error` since §S3).
    await expect(wt.resetForAttempt()).resolves.toBeUndefined();
  });

  it("2: …and equally when the bumped gitlink target is a REACHABLE object", async () => {
    // The dangling target that opened this campaign is INCIDENTAL: the trigger
    // is a gitlink change in the fetched range plus a populated-but-unopenable
    // path. Measured byte-identical failure with a real object, so "the fetch
    // succeeded" is not evidence that the gitlink is sane.
    const { bare, seed } = await seedOuter("case2");
    const wt = makeSlot("case2", bare);
    await wt.ensureExists();
    writeOverlay(wt.path);
    const reachable = (await seed.revparse(["HEAD"])).trim();
    await pushGitlinkBump(seed, reachable);

    await expect(wt.resetForAttempt()).resolves.toBeUndefined();
  });

  it("3: an ALREADY-CLONED slot gets the policy on reuse, not only at clone", async () => {
    // The deployed daemon's slots already exist, so they take ensureExists()'s
    // reuse branch forever. A clone-time-only write would ship a fix that never
    // reaches the machine with the bug; this goes red the moment someone tidies
    // the write into `if (needsClone)`.
    const { bare } = await seedOuter("case3");
    const first = makeSlot("case3", bare);
    await first.ensureExists();

    // Simulate a slot cloned by the pre-fix bundle.
    unsetLocal(first.path, "fetch.recurseSubmodules");
    unsetLocal(first.path, "submodule.recurse");
    expect(readLocal(first.path, "fetch.recurseSubmodules")).toBe(null);
    expect(readLocal(first.path, "submodule.recurse")).toBe(null);

    const reused = makeSlot("case3", bare);
    await reused.ensureExists();
    expect(readLocal(reused.path, "fetch.recurseSubmodules")).toBe("no");
    expect(readLocal(reused.path, "submodule.recurse")).toBe("false");
  });

  it("4: both keys land on a pool slot AND on the binding mirror", async () => {
    const { bare } = await seedOuter("case4");
    const wt = makeSlot("case4", bare);
    await wt.ensureExists();
    expect(readLocal(wt.path, "fetch.recurseSubmodules")).toBe("no");
    expect(readLocal(wt.path, "submodule.recurse")).toBe("false");

    // The mirror is cloned once and lives forever, and resolveRefInClone's catch
    // turns ANY failure there into null = "this member's ref does not exist".
    const bindDir = path.join(tmpRoot, "case4-bind.git");
    const resolver = createBindingResolver(bare, bindDir);
    expect(await resolver.resolveRefInClone("main")).toMatch(/^[0-9a-f]{40}$/);
    expect(readLocal(bindDir, "fetch.recurseSubmodules")).toBe("no");
    expect(readLocal(bindDir, "submodule.recurse")).toBe("false");
  });

  it("5: reset/checkout survive a nested gitlink bump under a global submodule.recurse=true", async () => {
    // The INNER lane's shape: materializeSubmoduleWorktree deliberately runs
    // `submodule update --init --recursive` there, so the slot's vendored
    // submodules are REAL, openable checkouts. With a global
    // submodule.recurse=true in the operator's ~/.gitconfig, resetForAttempt's
    // `reset --hard origin/main` fails exit 128 ("failed to unpack tree
    // object") and its `checkout` fails exit 1 — one step PAST the fetch.
    // fetch.recurseSubmodules=no ALONE does not prevent this, which is what
    // makes this an independent pin for the second key rather than a duplicate
    // of case 1. The repo-local `false` defeats the global `true`.
    const gcfg = path.join(tmpRoot, "case5-gitconfig");
    // protocol.file.allow lives in the SAME temp file: the fixture's
    // `submodule update --init` clones over the file protocol (blocked since
    // CVE-2022-39253) and the temp global REPLACES the developer's real one.
    // One mechanism, not two. Production never sets protocol.file.allow.
    writeFileSync(gcfg, '[submodule]\n\trecurse = true\n[protocol "file"]\n\tallow = always\n');
    const prev = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gcfg;
    try {
      // ── the vendored dep ──
      const nestedBare = path.join(tmpRoot, "case5-nested.git");
      const nestedSeed = path.join(tmpRoot, "case5-nested-seed");
      await simpleGit().init(["--bare", "--initial-branch=main", nestedBare]);
      await simpleGit().clone(nestedBare, nestedSeed);
      const ng = simpleGit(nestedSeed);
      await configIdentity(ng);
      writeFileSync(path.join(nestedSeed, "dep.txt"), "vendored dep\n");
      await ng.add(["dep.txt"]);
      await ng.commit("nested dep");
      await ng.branch(["-M", "main"]);
      await ng.push(["-u", "origin", "main"]);

      // ── the inner repo embedding it ──
      const innerBare = path.join(tmpRoot, "case5-inner.git");
      const innerSeed = path.join(tmpRoot, "case5-inner-seed");
      await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
      await simpleGit().clone(innerBare, innerSeed);
      const ig = simpleGit(innerSeed);
      await configIdentity(ig);
      writeFileSync(path.join(innerSeed, "lib.txt"), "inner lib\n");
      await ig.add(["lib.txt"]);
      await ig.raw(["submodule", "add", nestedBare.replace(/\\/g, "/"), "nested"]);
      await ig.commit("inner with nested submodule");
      await ig.branch(["-M", "main"]);
      await ig.push(["-u", "origin", "main"]);

      // ── the inner pool slot, with the nested submodule INITIALIZED (what
      //    materializeSubmoduleWorktree leaves behind) ──
      const wt = makeSlot("case5", innerBare);
      await wt.ensureExists();
      expect(
        spawnSync("git", ["submodule", "update", "--init"], { cwd: wt.path, encoding: "utf8" })
          .status,
      ).toBe(0);
      expect(existsSync(path.join(wt.path, "nested", "dep.txt"))).toBe(true);

      // ── advance the nested gitlink to an object nobody has ──
      await ig.raw(["update-index", "--add", "--cacheinfo", `160000,${NESTED_DANGLING},nested`]);
      await ig.commit("bump nested gitlink");
      await ig.push(["origin", "main"]);

      await expect(wt.resetForAttempt()).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prev;
    }
  });

  it("6: a slot with an invalid .git must not take the daemon down at boot", async () => {
    // ensureAll() is wrapped in logger.fatal + process.exit(1) at three sites in
    // index.ts. A slot whose .git EXISTS but is invalid (interrupted clone,
    // power loss, an AV-held config lock) skips the clone branch, so a throwing
    // policy write would kill the whole daemon at boot over one damaged slot —
    // and pre-empt the repair path (batch.ts → pool.repair() → rm -rf → fresh
    // clone) that heals it today. Regression guard for that decision.
    const { bare } = await seedOuter("case6");
    const root = path.join(tmpRoot, "case6-root");
    const slotPath = path.join(root, "slot-0");
    mkdirSync(path.join(slotPath, ".git"), { recursive: true });
    writeFileSync(path.join(slotPath, ".git", "HEAD"), "not a git repository\n");

    const wt = createWorktree({
      worktreeRoot: root,
      worktreeName: "slot-0",
      gitRemote: "origin",
      gitMainBranch: "main",
      gitRepoUrl: bare,
      cleanKeep: [],
    });
    await expect(wt.ensureExists()).resolves.toBeUndefined();
  });

  it("7: a policy write that fails is warned, never thrown, and never a wrong reject", async () => {
    // applyGitLocalPolicy swallows its own failure by contract. Pinned directly,
    // because this is where a "tidy-up" would reintroduce a throw — and a throw
    // from binding-clone would reach resolveRefInClone's catch as null = "this
    // member's ref does not exist", the misleading reject this campaign exists
    // to end.
    const junk = path.join(tmpRoot, "case7-junk");
    mkdirSync(path.join(junk, ".git"), { recursive: true });
    writeFileSync(path.join(junk, ".git", "HEAD"), "not a git repository\n");
    await expect(applyGitLocalPolicy(simpleGit(junk))).resolves.toBeUndefined();

    // And through the mirror: an unusable bindDir still degrades to the
    // pre-existing null, not to a throw escaping ensureBind.
    const { bare } = await seedOuter("case7");
    const notARepo = path.join(tmpRoot, "case7-bind-broken.git");
    mkdirSync(notARepo, { recursive: true });
    expect(await createBindingResolver(bare, notARepo).resolveRefInClone("main")).toBe(null);

    const healthy = path.join(tmpRoot, "case7-bind-ok.git");
    expect(await createBindingResolver(bare, healthy).resolveRefInClone("main")).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });
});
