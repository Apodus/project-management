/**
 * campaign xrepo-gitlink-umbrella-widening (P1) — real two-repo unit matrix for
 * `classifyOuterGitlinkDiff` + `GitOps.splitGitlinkDiff` / `objectPresent`.
 *
 * The classifier splits an OUTER member's net diff (over its merge-base with
 * live outer main) into managed-gitlink hunk(s) vs source, then gates each
 * managed gitlink target G against the landing inner `Ri` via an INNER-repo
 * presence probe + `isAncestor`. It returns a five-way verdict:
 * pure_bump / normalize / diverged / unreachable / legacy (fail-open).
 *
 * Fixtures (fused from git-ops-pure-gitlink-bump + group-convert idioms):
 *  - a real INNER bare+clone with history c0→c1→c2 (Ri = c2, G_anc = c1) plus a
 *    divergent pushed branch c0→d1 (G_div = d1: present, NOT ancestor of c2),
 *    and G_unreach = a commit made in a throwaway clone, pushed NOWHERE (absent
 *    even after `fetch origin`);
 *  - a fresh OUTER bare+clone per case whose feature branch records gitlink
 *    targets via `update-index --cacheinfo 160000,<sha>,<path>` (records a
 *    gitlink without needing the inner object present).
 *
 * The inner store is READ-ONLY across cases (the classifier only reads / fetches
 * it), so it is built once; each outer is fresh to isolate branch state.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { classifyOuterGitlinkDiff, createGitOps, type GitOps } from "../src/git-ops.js";

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
const GITLINK_PATH_2 = "tools/rynx-treegen";
const GIT_REMOTE = "origin";
// An arbitrary 40-hex the outer-main base gitlink points at (never dereferenced;
// distinct from every real inner sha so a feature bump always shows a diff hunk).
const OUTER_BASE_GITLINK = "f".repeat(40);
// A well-formed but absent inner sha (case 12: isAncestor throws on a bad object).
const BOGUS_INNER_SHA = "d".repeat(40);

interface Inner {
  bare: string;
  work: string;
  gitOps: GitOps;
  Ri: string; // c2 = inner main HEAD (the landing inner)
  gAnc: string; // c1 = ancestor of c2
  gDiv: string; // d1 = present, NOT ancestor of c2
  gUnreach: string; // absent even after fetch origin
}

interface OuterFeatureOpts {
  gitlinks?: Array<[string, string]>; // [path, sha]
  files?: Array<[string, string]>; // [relpath, content]
  orphan?: boolean; // build an unrelated-history branch (no merge-base)
}

describe.skipIf(!GIT_AVAILABLE)("git-ops classifyOuterGitlinkDiff (real two-repo)", () => {
  let tmpRoot: string;
  let inner: Inner;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-classify-"));

    // ── INNER: c0 → c1 (G_anc) → c2 (Ri) on main; c0 → d1 (G_div) on `diverged`.
    const innerBare = path.join(tmpRoot, "inner.git");
    await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
    const innerSeed = path.join(tmpRoot, "inner-seed");
    await simpleGit().clone(innerBare, innerSeed);
    const ig = simpleGit(innerSeed);
    await configIdentity(ig);

    writeFileSync(path.join(innerSeed, "lib.txt"), "v0\n");
    await ig.add(["lib.txt"]);
    await ig.commit("c0 inner base");
    await ig.branch(["-M", "main"]);
    const c0 = (await ig.revparse(["HEAD"])).trim();

    writeFileSync(path.join(innerSeed, "lib.txt"), "v1\n");
    await ig.add(["lib.txt"]);
    await ig.commit("c1 inner (G_anc)");
    const c1 = (await ig.revparse(["HEAD"])).trim();

    writeFileSync(path.join(innerSeed, "lib.txt"), "v2\n");
    await ig.add(["lib.txt"]);
    await ig.commit("c2 inner (Ri = main)");
    const c2 = (await ig.revparse(["HEAD"])).trim();
    await ig.push(["-u", GIT_REMOTE, "main"]);

    // divergent branch off c0 → d1 (present on origin, NOT an ancestor of c2)
    await ig.checkout(["-b", "diverged", c0]);
    writeFileSync(path.join(innerSeed, "sidecar.txt"), "divergent\n");
    await ig.add(["sidecar.txt"]);
    await ig.commit("d1 inner (G_div)");
    const d1 = (await ig.revparse(["HEAD"])).trim();
    await ig.push(["-u", GIT_REMOTE, "diverged"]);

    // G_unreach — a commit made in a THROWAWAY clone, pushed NOWHERE.
    const throwaway = path.join(tmpRoot, "inner-throwaway");
    await simpleGit().clone(innerBare, throwaway);
    const tg = simpleGit(throwaway);
    await configIdentity(tg);
    await tg.checkout("main");
    writeFileSync(path.join(throwaway, "ghost.txt"), "never pushed\n");
    await tg.add(["ghost.txt"]);
    await tg.commit("g_unreach (pushed nowhere)");
    const gUnreach = (await tg.revparse(["HEAD"])).trim();

    // The inner clone the classifier probes/fetches (has c1/c2/d1, NOT g_unreach).
    const innerWork = path.join(tmpRoot, "inner-work");
    await simpleGit().clone(innerBare, innerWork);
    await configIdentity(simpleGit(innerWork));

    inner = {
      bare: innerBare,
      work: innerWork,
      gitOps: createGitOps(simpleGit(innerWork)),
      Ri: c2,
      gAnc: c1,
      gDiv: d1,
      gUnreach,
    };
  }, 60_000);

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // Build a fresh outer bare+clone; seed main with top.txt + .gitmodules +
  // vendor/rynx gitlink@OUTER_BASE_GITLINK; then create `feature` with the given
  // gitlink bumps / file writes (or an unrelated-history orphan). Returns the
  // outer gitOps, the live-main sha (= baseOuterSha), and the feature ref.
  async function newOuter(
    label: string,
    feat: OuterFeatureOpts,
  ): Promise<{ gitOps: GitOps; baseOuterSha: string; outerRef: string }> {
    const bare = path.join(tmpRoot, `${label}.git`);
    const dir = path.join(tmpRoot, label);
    await simpleGit().init(["--bare", "--initial-branch=main", bare]);
    await simpleGit().clone(bare, dir);
    const g = simpleGit(dir);
    await configIdentity(g);

    writeFileSync(path.join(dir, "top.txt"), "top v1\n");
    writeFileSync(
      path.join(dir, ".gitmodules"),
      `[submodule "rynx"]\n\tpath = ${GITLINK_PATH}\n\turl = https://example.invalid/rynx.git\n`,
    );
    await g.add(["top.txt", ".gitmodules"]);
    await g.raw([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${OUTER_BASE_GITLINK},${GITLINK_PATH}`,
    ]);
    await g.commit("outer main base with gitlink");
    await g.branch(["-M", "main"]);
    const baseOuterSha = (await g.revparse(["HEAD"])).trim();

    if (feat.orphan) {
      await g.raw(["checkout", "--orphan", "feature"]);
      await g.raw(["rm", "--cached", "-r", "."]).catch(() => {
        /* index may already be clear */
      });
      writeFileSync(path.join(dir, "unrelated.txt"), "orphan root\n");
      await g.add(["unrelated.txt"]);
      await g.commit("orphan root (no merge-base with main)");
      await g.raw(["checkout", "-f", "main"]);
      return { gitOps: createGitOps(g), baseOuterSha, outerRef: "feature" };
    }

    await g.checkoutLocalBranch("feature");
    for (const [rel, content] of feat.files ?? []) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      await g.add([rel]);
    }
    for (const [p, sha] of feat.gitlinks ?? []) {
      await g.raw(["update-index", "--add", "--cacheinfo", `160000,${sha},${p}`]);
    }
    await g.commit("outer feature");
    await g.checkout("main");
    return { gitOps: createGitOps(g), baseOuterSha, outerRef: "feature" };
  }

  function baseArgs(o: { gitOps: GitOps; baseOuterSha: string; outerRef: string }) {
    return {
      outerGitOps: o.gitOps,
      innerGitOps: inner.gitOps,
      outerRef: o.outerRef,
      baseOuterSha: o.baseOuterSha,
      innerLandingSha: inner.Ri,
      managedGitlinkPaths: new Set([GITLINK_PATH]),
      gitRemote: GIT_REMOTE,
    };
  }

  it("1. pure bump (managed → G_anc, no source) → pure_bump", async () => {
    const o = await newOuter("c1", { gitlinks: [[GITLINK_PATH, inner.gAnc]] });
    const r = await classifyOuterGitlinkDiff(baseArgs(o));
    expect(r).toEqual({ kind: "pure_bump" });
  }, 40_000);

  it("2. bump + source (→ G_anc + edit src/foo.txt) → normalize", async () => {
    const o = await newOuter("c2", {
      gitlinks: [[GITLINK_PATH, inner.gAnc]],
      files: [["src/foo.txt", "hello\n"]],
    });
    const r = await classifyOuterGitlinkDiff(baseArgs(o));
    expect(r).toEqual({ kind: "normalize", sourcePaths: ["src/foo.txt"] });
  }, 40_000);

  it("3. bump + source, → G_div → diverged", async () => {
    const o = await newOuter("c3", {
      gitlinks: [[GITLINK_PATH, inner.gDiv]],
      files: [["src/foo.txt", "hello\n"]],
    });
    const r = await classifyOuterGitlinkDiff(baseArgs(o));
    expect(r).toEqual({ kind: "diverged", path: GITLINK_PATH, target: inner.gDiv });
  }, 40_000);

  it("4. bump → G_unreach → unreachable (all-refs fetch ran, still absent — NOT fetch-by-sha)", async () => {
    const o = await newOuter("c4", { gitlinks: [[GITLINK_PATH, inner.gUnreach]] });
    let fetchCount = 0;
    const spyInner: GitOps = {
      ...inner.gitOps,
      async fetch(remote: string): Promise<void> {
        fetchCount += 1;
        return inner.gitOps.fetch(remote);
      },
    };
    const r = await classifyOuterGitlinkDiff({ ...baseArgs(o), innerGitOps: spyInner });
    expect(r).toEqual({ kind: "unreachable", path: GITLINK_PATH, target: inner.gUnreach });
    // The all-refs fetch DID run (seals post-successful-fetch unreachable), and
    // g_unreach remains absent (a fetch-by-sha would have been disallowed / moot).
    expect(fetchCount).toBe(1);
  }, 40_000);

  it("5. set-level: {vendor/rynx→G_anc, tools/rynx-treegen→G_div} → diverged on tools/rynx-treegen", async () => {
    const o = await newOuter("c5", {
      gitlinks: [
        [GITLINK_PATH, inner.gAnc],
        [GITLINK_PATH_2, inner.gDiv],
      ],
    });
    const r = await classifyOuterGitlinkDiff({
      ...baseArgs(o),
      managedGitlinkPaths: new Set([GITLINK_PATH, GITLINK_PATH_2]),
    });
    expect(r).toEqual({ kind: "diverged", path: GITLINK_PATH_2, target: inner.gDiv });
  }, 40_000);

  it("6. managed-vs-unmanaged: vendor/rynx→G_anc + UNMANAGED tools/other + src/foo.txt → normalize (unmanaged 160000 rides source)", async () => {
    const o = await newOuter("c6", {
      gitlinks: [
        [GITLINK_PATH, inner.gAnc],
        ["tools/other", "a".repeat(40)],
      ],
      files: [["src/foo.txt", "hello\n"]],
    });
    // managed set is ONLY vendor/rynx → tools/other (a 160000) rides the source bucket.
    const r = await classifyOuterGitlinkDiff(baseArgs(o));
    expect(r.kind).toBe("normalize");
    if (r.kind === "normalize") {
      expect(r.sourcePaths).toContain("tools/other");
      expect(r.sourcePaths).toContain("src/foo.txt");
      expect(r.sourcePaths).not.toContain(GITLINK_PATH);
    }
  }, 40_000);

  it("7. .gitmodules-only → legacy (no managed gitlink hunk)", async () => {
    const o = await newOuter("c7", {
      files: [
        [
          ".gitmodules",
          `[submodule "rynx"]\n\tpath = ${GITLINK_PATH}\n\turl = https://example.invalid/rynx.git\n# touched\n`,
        ],
      ],
    });
    const r = await classifyOuterGitlinkDiff(baseArgs(o));
    expect(r).toEqual({ kind: "legacy", reason: "no managed gitlink hunk" });
  }, 40_000);

  it("8. empty branch (== main) → legacy (empty gitlinkTargets)", async () => {
    // Build main, then branch feature at main with NO commit → zero net diff.
    const bare = path.join(tmpRoot, "c8.git");
    const dir = path.join(tmpRoot, "c8");
    await simpleGit().init(["--bare", "--initial-branch=main", bare]);
    await simpleGit().clone(bare, dir);
    const g = simpleGit(dir);
    await configIdentity(g);
    writeFileSync(path.join(dir, "top.txt"), "top v1\n");
    await g.add(["top.txt"]);
    await g.raw([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${OUTER_BASE_GITLINK},${GITLINK_PATH}`,
    ]);
    await g.commit("outer main base with gitlink");
    await g.branch(["-M", "main"]);
    const baseOuterSha = (await g.revparse(["HEAD"])).trim();
    await g.branch(["feature", "main"]);

    const r = await classifyOuterGitlinkDiff(
      baseArgs({ gitOps: createGitOps(g), baseOuterSha, outerRef: "feature" }),
    );
    expect(r).toEqual({ kind: "legacy", reason: "no managed gitlink hunk" });
  }, 40_000);

  it("9. pure-source-only (edit src/foo.txt, no gitlink) → legacy (no managed gitlink hunk)", async () => {
    const o = await newOuter("c9", { files: [["src/foo.txt", "only source\n"]] });
    const r = await classifyOuterGitlinkDiff(baseArgs(o));
    expect(r).toEqual({ kind: "legacy", reason: "no managed gitlink hunk" });
  }, 40_000);

  it("10. orphan / merge-base failure → legacy (outer split failed)", async () => {
    const o = await newOuter("c10", { orphan: true });
    const r = await classifyOuterGitlinkDiff(baseArgs(o));
    expect(r).toEqual({ kind: "legacy", reason: "outer split failed" });
  }, 40_000);

  it("11. unresolvable outerRef ('no/such/ref') → legacy (outer split failed)", async () => {
    const o = await newOuter("c11", { gitlinks: [[GITLINK_PATH, inner.gAnc]] });
    const r = await classifyOuterGitlinkDiff({ ...baseArgs(o), outerRef: "no/such/ref" });
    expect(r).toEqual({ kind: "legacy", reason: "outer split failed" });
  }, 40_000);

  it("12. isAncestor throws (present G, bogus innerLandingSha) → legacy, NOT a reject", async () => {
    const o = await newOuter("c12", { gitlinks: [[GITLINK_PATH, inner.gAnc]] });
    const r = await classifyOuterGitlinkDiff({ ...baseArgs(o), innerLandingSha: BOGUS_INNER_SHA });
    // A bad-object isAncestor exit-128 THROW must route to fail-open legacy —
    // never bubble up as diverged/unreachable (which would surface the catch-all
    // `assembly_error` — legible, but a lost classification).
    expect(r).toEqual({ kind: "legacy", reason: "isAncestor threw" });
  }, 40_000);
});
