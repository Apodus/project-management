import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Distinct arbitrary 40-hex gitlink SHAs. SAFE by construction: update-index
// --cacheinfo + commit + diff --name-only operate on the RECORDED sha string and
// never dereference the (absent) inner objects — no inner repo is ever needed.
const X0 = "a".repeat(40);
const X1 = "b".repeat(40);
const X2 = "c".repeat(40);
const GITLINK_PATH = "vendor/rynx";

async function configIdentity(g: SimpleGit): Promise<void> {
  await g.addConfig("user.email", "int@test.local");
  await g.addConfig("user.name", "Integrator Test");
  await g.addConfig("commit.gpgsign", "false");
}

// .gitmodules is parsed by git AS git-config, so use forward slashes; the url is
// cosmetic (no inner repo is ever cloned in this matrix).
const GITMODULES = `[submodule "rynx"]\n\tpath = ${GITLINK_PATH}\n\turl = https://example.invalid/rynx.git\n`;

describe.skipIf(!GIT_AVAILABLE)("git-ops isPureGitlinkBump (real git)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-purebump-"));
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // Build an isolated outer bare+clone whose `main` carries top.txt + .gitmodules
  // + gitlink(vendor/rynx@X0). Returns the clone's simple-git (bound, on main).
  async function seedOuter(label: string): Promise<{ dir: string; g: SimpleGit }> {
    const bare = path.join(tmpRoot, `${label}.git`);
    const dir = path.join(tmpRoot, label);
    await simpleGit().init(["--bare", "--initial-branch=main", bare]);
    await simpleGit().clone(bare, dir);
    const g = simpleGit(dir);
    await configIdentity(g);
    writeFileSync(path.join(dir, "top.txt"), "top v1\n");
    writeFileSync(path.join(dir, ".gitmodules"), GITMODULES);
    await g.add(["top.txt", ".gitmodules"]);
    await g.raw(["update-index", "--add", "--cacheinfo", `160000,${X0},${GITLINK_PATH}`]);
    await g.commit("outer main base with gitlink");
    await g.branch(["-M", "main"]);
    return { dir, g };
  }

  // Create `branch` off current main, apply the given gitlink bumps and/or file
  // writes, commit, then return to main. gitlinks: [sha, path] entries;
  // files: [relpath, content] entries (parent dirs created).
  async function bumpCommit(
    g: SimpleGit,
    dir: string,
    branch: string,
    opts: { gitlinks?: Array<[string, string]>; files?: Array<[string, string]> },
  ): Promise<void> {
    await g.checkoutLocalBranch(branch);
    for (const [rel, content] of opts.files ?? []) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      await g.add([rel]);
    }
    for (const [sha, p] of opts.gitlinks ?? []) {
      await g.raw(["update-index", "--add", "--cacheinfo", `160000,${sha},${p}`]);
    }
    await g.commit(`bump on ${branch}`);
    await g.checkout("main");
  }

  it("1. pure gitlink bump → true", async () => {
    const { dir, g } = await seedOuter("case1");
    await bumpCommit(g, dir, "bump", { gitlinks: [[X1, GITLINK_PATH]] });
    const ops = createGitOps(g);
    expect(await ops.isPureGitlinkBump("bump", GITLINK_PATH)).toBe(true);
  });

  it("2. bump + .gitmodules change → false", async () => {
    const { dir, g } = await seedOuter("case2");
    await bumpCommit(g, dir, "bump", {
      gitlinks: [[X1, GITLINK_PATH]],
      files: [[".gitmodules", GITMODULES + "\n# touched\n"]],
    });
    const ops = createGitOps(g);
    expect(await ops.isPureGitlinkBump("bump", GITLINK_PATH)).toBe(false);
  });

  it("3. bump + real source file → false", async () => {
    const { dir, g } = await seedOuter("case3");
    await bumpCommit(g, dir, "bump", {
      gitlinks: [[X1, GITLINK_PATH]],
      files: [["src/foo.txt", "hello\n"]],
    });
    const ops = createGitOps(g);
    expect(await ops.isPureGitlinkBump("bump", GITLINK_PATH)).toBe(false);
  });

  it("4. two gitlinks bumped → false", async () => {
    const { dir, g } = await seedOuter("case4");
    await bumpCommit(g, dir, "bump", {
      gitlinks: [
        [X1, GITLINK_PATH],
        [X2, "tools/other"],
      ],
    });
    const ops = createGitOps(g);
    expect(await ops.isPureGitlinkBump("bump", GITLINK_PATH)).toBe(false);
  });

  it("5. unrelated history (no merge-base) → false (fail-open)", async () => {
    const { dir, g } = await seedOuter("case5");
    await g.raw(["checkout", "--orphan", "unrelated"]);
    await g.raw(["rm", "--cached", "-r", "."]);
    writeFileSync(path.join(dir, "other.txt"), "orphan\n");
    await g.add(["other.txt"]);
    await g.commit("orphan root");
    // The orphan tree lacks top.txt/.gitmodules, leaving them untracked on disk;
    // force back to main so HEAD = main (merge-base(HEAD, unrelated) then fails).
    await g.raw(["checkout", "-f", "main"]);
    const ops = createGitOps(g);
    expect(await ops.isPureGitlinkBump("unrelated", GITLINK_PATH)).toBe(false);
  });

  it("6. empty branch (zero diff) → false", async () => {
    const { g } = await seedOuter("case6");
    await g.branch(["empty", "main"]);
    const ops = createGitOps(g);
    expect(await ops.isPureGitlinkBump("empty", GITLINK_PATH)).toBe(false);
  });

  it("7. bump-to-already-landed (merge-base, not HEAD) → true", async () => {
    const { dir, g } = await seedOuter("case7");
    // main0 carries gitlink@X0. Fork `bump` and advance the gitlink to X1.
    await bumpCommit(g, dir, "bump", { gitlinks: [[X1, GITLINK_PATH]] });
    // Now advance MAIN to gitlink@X1 via a gitlink-ONLY commit (no other edits),
    // so main's tree == bump's tree and diff(HEAD, bump) is genuinely empty.
    await g.raw(["update-index", "--add", "--cacheinfo", `160000,${X1},${GITLINK_PATH}`]);
    await g.commit("outer main advances gitlink to X1 (out-of-band land)");

    const ops = createGitOps(g);
    // A naive HEAD-based detection would see NO diff → wrongly false. Prove it:
    const headDiff = await g.raw(["diff", "--name-only", "HEAD", "bump"]);
    expect(headDiff.trim()).toBe("");
    // merge-base(HEAD, bump) = main0, diff(main0, bump) = [vendor/rynx] → true.
    expect(await ops.isPureGitlinkBump("bump", GITLINK_PATH)).toBe(true);
  });

  it("8. unresolvable ref → false (fail-open)", async () => {
    const { g } = await seedOuter("case8");
    const ops = createGitOps(g);
    expect(await ops.isPureGitlinkBump("no/such/ref", GITLINK_PATH)).toBe(false);
  });
});
