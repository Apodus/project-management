import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { simpleGit, type SimpleGit } from "simple-git";
import { createGitOps } from "../src/git-ops.js";
import {
  assertUnderRoot,
  moduleGitDirExists,
  NestedRepoSweepError,
  PRUNED_DIRECTORY_NAMES,
  sweepUndeclaredNestedRepos,
} from "../src/nested-repo-sweep.js";
import { createWorktree } from "../src/worktree.js";

function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}
const GIT_AVAILABLE = hasGit();

const fwd = (p: string) => p.replace(/\\/g, "/");
const ALLOW_FILE: string[] = []; // protocol.file.allow comes from the GIT_CONFIG_* environment (beforeAll)

async function identity(g: SimpleGit): Promise<void> {
  await g.addConfig("user.email", "sweep@test.local");
  await g.addConfig("user.name", "Sweep Test");
  await g.addConfig("commit.gpgsign", "false");
}

/** A pino logger whose lines are collected, so a test can read what the sweep SAID. */
function collectingLogger(): { logger: pino.Logger; lines: () => Array<Record<string, unknown>> } {
  const out: string[] = [];
  const logger = pino({ level: "warn" }, { write: (chunk: string) => void out.push(chunk) });
  return { logger, lines: () => out.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

let tmpRoot: string;
let counter = 0;

/**
 * One universe per test: a sub-repository, an origin whose main declares submodule `sub`
 * (name `engine` when asked), a CANDIDATE branch that retires it, and a populated slot
 * checked out at main.
 */
async function makeOrigin(opts: { submoduleName?: string }) {
  const dir = path.join(tmpRoot, `u${++counter}`);
  mkdirSync(dir, { recursive: true });
  const subBare = fwd(path.join(dir, "sub.git"));
  const originBare = fwd(path.join(dir, "origin.git"));
  await simpleGit().init(["--bare", "--initial-branch=main", subBare]);
  await simpleGit().init(["--bare", "--initial-branch=main", originBare]);

  const subSeedPath = path.join(dir, "subseed");
  await simpleGit().clone(subBare, subSeedPath);
  const subSeed = simpleGit(subSeedPath);
  await identity(subSeed);
  writeFileSync(path.join(subSeedPath, "lib.txt"), "lib\n");
  await subSeed.add(["lib.txt"]);
  await subSeed.commit("sub initial");
  await subSeed.branch(["-M", "main"]);
  await subSeed.push(["-u", "origin", "main"]);

  const seedPath = path.join(dir, "seed");
  await simpleGit().clone(originBare, seedPath);
  const seed = simpleGit(seedPath);
  await identity(seed);
  writeFileSync(path.join(seedPath, "base.txt"), "base\n");
  await seed.add(["base.txt"]);
  await seed.commit("initial");
  await seed.branch(["-M", "main"]);
  await seed.raw([
    ...ALLOW_FILE,
    "submodule",
    "add",
    ...(opts.submoduleName ? ["--name", opts.submoduleName] : []),
    subBare,
    "sub",
  ]);
  await seed.commit("declare sub");
  await seed.push(["-u", "origin", "main"]);
  const mainSha = (await seed.revparse(["HEAD"])).trim();

  // The candidate retires the submodule: no gitlink, no .gitmodules entry.
  await seed.checkout(["-b", "cand"]);
  await seed.raw(["rm", "-f", "sub"]);
  await seed.commit("retire sub");
  await seed.push(["-u", "origin", "cand"]);
  await seed.checkout("main");

  return { dir, subBare, originBare, seed, seedPath, mainSha };
}

const originCache = new Map<string, Awaited<ReturnType<typeof makeOrigin>>>();

/**
 * A populated slot on an origin. The origin is built once per submodule name and shared (a slot is a
 * clone, so tests cannot disturb each other); `fresh: true` builds a private origin for a test that
 * pushes to it.
 */
async function universe(opts: { submoduleName?: string; fresh?: boolean } = {}) {
  const key = opts.submoduleName ?? "";
  let origin = opts.fresh ? undefined : originCache.get(key);
  if (!origin) {
    origin = await makeOrigin(opts);
    if (!opts.fresh) originCache.set(key, origin);
  }
  const slotPath = path.join(origin.dir, `slot${++counter}`);
  await simpleGit().clone(origin.originBare, slotPath);
  const slot = simpleGit(slotPath);
  await identity(slot);
  await slot.raw([...ALLOW_FILE, "submodule", "update", "--init"]);
  return { ...origin, slot, slotPath };
}

describe.skipIf(!GIT_AVAILABLE)("nested repo sweep (real git)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-sweep-"));
    // Submodule clones of local fixtures need protocol.file.allow; simple-git refuses to set it (-c or config),
    // git itself reads it from the environment.
    for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])
      savedEnv[k] = process.env[k];
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
    process.env.GIT_CONFIG_VALUE_0 = "always";
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  });

  it("the populated fixture really is a registered submodule with a module gitdir", async () => {
    const u = await universe();
    expect(existsSync(path.join(u.slotPath, "sub", ".git"))).toBe(true);
    expect(await moduleGitDirExists(u.slotPath, "sub")).toBe(true);
  });

  // ── Fixture A: the CANDIDATE retires a populated submodule (no reset spans old -> new) ──
  it("A: a candidate checkout that deletes the gitlink and .gitmodules removes the checkout, the module gitdir and the clean_keep entry; the slot is clean", async () => {
    const u = await universe();
    mkdirSync(path.join(u.slotPath, "sub", "build"), { recursive: true });
    writeFileSync(path.join(u.slotPath, "sub", "build", "out.o"), "kept by clean_keep\n");
    const { logger, lines } = collectingLogger();
    const ops = createGitOps(u.slot, { gitRemote: "origin", logger, cleanKeep: ["sub/build"] });
    await u.slot.fetch("origin");

    const r = await ops.rebaseOnto(u.mainSha, "cand");
    expect(r.ok).toBe(true);

    expect(existsSync(path.join(u.slotPath, "sub"))).toBe(false);
    expect(await moduleGitDirExists(u.slotPath, "sub")).toBe(false);
    expect((await u.slot.status()).files).toEqual([]);
    const said = lines();
    expect(
      said.some(
        (l) => l.msg === "nested_repo_removed" && l.path === "sub" && l.kind === "checkout",
      ),
    ).toBe(true);
    expect(
      said.some(
        (l) =>
          l.msg === "nested_repo_removed" && l.path === ".git/modules/sub" && l.kind === "module",
      ),
    ).toBe(true);
    expect(said.map((l) => l.msg)).toContain(
      "clean_keep entry 'sub/build' dropped: parent nested repo 'sub' undeclared at HEAD",
    );
    expect(said.find((l) => l.msg === "nested_repo_removed")?.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("A2: the plain checkout path sweeps too", async () => {
    const u = await universe();
    const { logger } = collectingLogger();
    const ops = createGitOps(u.slot, { gitRemote: "origin", logger });
    await u.slot.fetch("origin");
    await ops.checkout("cand");
    expect(existsSync(path.join(u.slotPath, "sub"))).toBe(false);
    expect(await moduleGitDirExists(u.slotPath, "sub")).toBe(false);
  });

  // ── Fixture B: the same, across a reset ──
  it("B: resetForAttempt removes a submodule main stopped declaring since the slot was populated", async () => {
    const u = await universe({ fresh: true });
    const wtRoot = path.join(u.dir, "wtroot");
    const { logger, lines } = collectingLogger();
    const wt = createWorktree({
      worktreeRoot: wtRoot,
      worktreeName: "slot",
      gitRemote: "origin",
      gitMainBranch: "main",
      gitRepoUrl: u.originBare,
      cleanKeep: ["sub/build"],
      logger,
    });
    await wt.ensureExists();
    await identity(wt.git);
    await wt.resetForAttempt();
    await wt.git.raw([...ALLOW_FILE, "submodule", "update", "--init"]);
    mkdirSync(path.join(wt.path, "sub", "build"), { recursive: true });
    writeFileSync(path.join(wt.path, "sub", "build", "out.o"), "kept\n");
    expect(existsSync(path.join(wt.path, "sub", ".git"))).toBe(true);

    // main retires the submodule
    await u.seed.raw(["rm", "-f", "sub"]);
    await u.seed.commit("main retires sub");
    await u.seed.push(["origin", "main"]);

    await wt.resetForAttempt();
    expect(existsSync(path.join(wt.path, "sub"))).toBe(false);
    expect(await moduleGitDirExists(wt.path, "sub")).toBe(false);
    expect((await wt.git.status()).files).toEqual([]);
    expect(wt.lastNestedSweep?.removed.map((x) => x.path).sort()).toEqual([
      ".git/modules/sub",
      "sub",
    ]);
    expect(lines().map((l) => l.msg)).toContain(
      "clean_keep entry 'sub/build' dropped: parent nested repo 'sub' undeclared at HEAD",
    );
  });

  // ── Fixture C: nothing is spared by name ──
  it("C: a repository under engines/ is removed like any other (no exemption list)", async () => {
    const u = await universe();
    const dir = path.join(u.slotPath, "engines", "abc123");
    mkdirSync(dir, { recursive: true });
    await simpleGit(dir).init();
    const r = await sweepUndeclaredNestedRepos({ git: u.slot });
    expect(r.removed.map((x) => x.path)).toContain("engines/abc123");
    expect(existsSync(dir)).toBe(false);
  });

  // ── Fixture D: declared stays ──
  it("D: a declared, populated submodule is untouched, module gitdir included", async () => {
    const u = await universe();
    const r = await sweepUndeclaredNestedRepos({ git: u.slot });
    expect(r.removed).toEqual([]);
    expect(existsSync(path.join(u.slotPath, "sub", ".git"))).toBe(true);
    expect(await moduleGitDirExists(u.slotPath, "sub")).toBe(true);
  });

  it("D2: a submodule whose NAME differs from its path is declared through .gitmodules at HEAD", async () => {
    const u = await universe({ submoduleName: "engine" });
    expect(await moduleGitDirExists(u.slotPath, "engine")).toBe(true);
    const r = await sweepUndeclaredNestedRepos({ git: u.slot });
    expect(r.removed).toEqual([]);
    expect(await moduleGitDirExists(u.slotPath, "engine")).toBe(true);
  });

  // ── Fixture E: the real on-disk estate: a populated, UNTRACKED tools/rynx-treegen ──
  it("E: a populated untracked nested repository that HEAD never declared (tools/rynx-treegen) is removed", async () => {
    const u = await universe();
    const dir = path.join(u.slotPath, "tools", "rynx-treegen");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "x.cpp"), "int x;\n");
    await simpleGit(dir).init();
    const r = await sweepUndeclaredNestedRepos({ git: u.slot });
    expect(r.removed.map((x) => x.path)).toContain("tools/rynx-treegen");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(u.slotPath, "tools"))).toBe(true); // only the repository, not its parent
  });

  it("module gitdirs with no checkout (an orphaned .git/modules/<p>) are removed when undeclared", async () => {
    const u = await universe();
    const orphan = path.join(u.slotPath, ".git", "modules", "retired", "deep");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(path.join(orphan, "HEAD"), "ref: refs/heads/main\n");
    const r = await sweepUndeclaredNestedRepos({ git: u.slot });
    expect(r.removed.map((x) => x.path)).toEqual([".git/modules/retired/deep"]);
    expect(existsSync(orphan)).toBe(false);
    expect(await moduleGitDirExists(u.slotPath, "sub")).toBe(true);
  });

  it("tracked content is never deleted: only the .git of a repository over tracked files goes", async () => {
    const u = await universe({ fresh: true });
    mkdirSync(path.join(u.seedPath, "tools", "foo"), { recursive: true });
    writeFileSync(path.join(u.seedPath, "tools", "foo", "a.txt"), "tracked\n");
    await u.seed.add(["tools/foo/a.txt"]);
    await u.seed.commit("track tools/foo");
    await u.seed.push(["origin", "main"]);
    await u.slot.pull("origin", "main");
    await simpleGit(path.join(u.slotPath, "tools", "foo")).init();
    const r = await sweepUndeclaredNestedRepos({ git: u.slot });
    expect(r.removed.map((x) => `${x.kind}:${x.path}`)).toEqual(["git-dir-only:tools/foo/.git"]);
    expect(existsSync(path.join(u.slotPath, "tools", "foo", "a.txt"))).toBe(true);
    expect(existsSync(path.join(u.slotPath, "tools", "foo", ".git"))).toBe(false);
  });

  // ── cost and uncertainty ──
  it("the walk prunes build trees by name and never enters them; the pruned names are the documented set", async () => {
    const u = await universe();
    for (const rel of ["build/deep/x", "generate/build/y", "prof/z"]) {
      const d = path.join(u.slotPath, ...rel.split("/"));
      mkdirSync(d, { recursive: true });
      await simpleGit(d).init();
    }
    const r = await sweepUndeclaredNestedRepos({ git: u.slot });
    expect(r.removed).toEqual([]); // documented limit: a repository under a pruned tree is not found
    expect(PRUNED_DIRECTORY_NAMES).toEqual([
      "build",
      "build_temp",
      "prof",
      "logs",
      "external",
      "node_modules",
    ]);
    expect(r.directoriesRead).toBeLessThan(25);
    expect(typeof r.walkMs).toBe("number");
  });

  it("uncertainty removes nothing: not a repository, and an unborn HEAD", async () => {
    const notRepo = path.join(tmpRoot, "plain");
    mkdirSync(path.join(notRepo, "x"), { recursive: true });
    await simpleGit(path.join(notRepo, "x")).init();
    const none = await sweepUndeclaredNestedRepos({ git: simpleGit(notRepo) });
    expect(none.skipped).not.toBeNull();
    expect(existsSync(path.join(notRepo, "x", ".git"))).toBe(true);

    const unborn = path.join(tmpRoot, "unborn");
    mkdirSync(path.join(unborn, "y"), { recursive: true });
    await simpleGit(unborn).init();
    await simpleGit(path.join(unborn, "y")).init();
    const r = await sweepUndeclaredNestedRepos({ git: simpleGit(unborn) });
    expect(r.skipped).toBe("no HEAD");
    expect(existsSync(path.join(unborn, "y", ".git"))).toBe(true);
  });

  it("a verify is not swept mid-attempt: what a verify creates survives runVerify", async () => {
    const u = await universe();
    await u.slot.fetch("origin");
    const ops = createGitOps(u.slot, { gitRemote: "origin" });
    await ops.checkout("cand"); // sweeps once, here
    const late = path.join(u.slotPath, "late-clone");
    mkdirSync(late, { recursive: true });
    await simpleGit(late).init();
    const res = await ops.runVerify('node -e "process.exit(0)"', 20_000, {
      cwd: u.slotPath,
      logPath: path.join(u.dir, "verify.log"),
    });
    expect(res.exitCode).toBe(0);
    expect(existsSync(path.join(late, ".git"))).toBe(true);
  });

  // ── refusal ──
  it("assertUnderRoot refuses the root, escapes, absolute paths elsewhere and empty input", () => {
    const root = path.join(tmpRoot, "root");
    expect(assertUnderRoot(root, "sub/dir")).toBe(path.resolve(root, "sub", "dir"));
    for (const bad of [
      "",
      ".",
      "..",
      "../x",
      "a/../../x",
      path.resolve(tmpRoot, "elsewhere"),
      path.resolve(root),
    ]) {
      expect(() => assertUnderRoot(root, bad), `refuses '${bad}'`).toThrow(NestedRepoSweepError);
    }
  });

  it("the slot's top-level listing is unchanged by a no-op sweep (nothing is written)", async () => {
    const u = await universe();
    const before = readdirSync(u.slotPath).sort();
    const r = await sweepUndeclaredNestedRepos({ git: u.slot });
    expect(r.removed).toEqual([]);
    expect(readdirSync(u.slotPath).sort()).toEqual(before);
  });
});
