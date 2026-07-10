/**
 * Direction-C gitlink-bump auto-convert (campaign xrepo-gitlink-bump-autoconvert)
 * — real two-repo fixtures.
 *
 * A LEGACY two-real-member cross-repo group whose OUTER member is a pure gitlink
 * bump (its net contribution over its fork point is EXACTLY the 160000 gitlink)
 * is content-free ceremony: assembly step 8 overwrites the gitlink to the rebased
 * inner SHA regardless, and the outer rebase is the ONLY thing that can mint
 * `outer_conflict`. `assembleGroup` recognizes the bump (`isPureGitlinkBump`) and
 * takes the synthetic arm — skips the outer rebase, synthesizes the outer
 * candidate on LIVE outer main — killing the grass-stability ping-pong
 * structurally while leaving the DB `synthetic` flag untouched.
 *
 * Mirrors the group-synthetic.test.ts / group-assembly.test.ts idioms: bare repos
 * (--initial-branch=main) + seed clones + configIdentity, the .gitmodules
 * forward-slash URL, a seeded 160000 gitlink, size-1 createWorktreePool pairs,
 * binding clones (resolveVerified), and the fuller FakePm (landGroupBody /
 * ordered calls) + a noteOuterConverted spy.
 *
 * Cases: (1) conversion via a commitSha outer member → converted + lands, outer
 * @ Ro role "outer"; (2) conversion via a BRANCH-only outer member (seals
 * resolveDetectRef's `<remote>/<ref>` fallback via a --mirror bind); (3) a mixed
 * bump+source outer member is NOT converted and STILL rejects `outer_conflict`
 * when outer main drifted (invariant 4, byte-identical legacy behavior); (4)
 * structural conflict-immunity — a stale pure bump against an advanced outer main
 * still assembles + lands with zero `outer_conflict` (the live grass-stability
 * failure, unit level); (5) surfacing — a converted+landed group calls
 * noteOuterConverted with the exact reason (invariant 5).
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { MergeAttemptView, MergeRequestView } from "@pm/shared";
import { createGitOps } from "../src/git-ops.js";
import { createWorktreePool, type WorktreePool } from "../src/worktree-pool.js";
import { createLogger } from "../src/logger.js";
import {
  runGroupIntegration,
  type GroupIntegrationDeps,
  type RepoLane,
} from "../src/group-integration.js";
import { landAssembledGroup } from "../src/group-land.js";

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
const GIT_REMOTE = "origin";
const GIT_MAIN = "main";

/** The EXACT reason string group-integration.ts logs + posts on conversion. */
const CONVERT_REASON =
  "outer member superseded: pure gitlink bump — outer candidate synthesized against live main";

async function resolveVerified(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    return (await git.revparse(["--verify", `${ref}^{commit}`])).trim();
  } catch {
    return null;
  }
}

// ─── In-memory fake PM client (group-land surface + noteOuterConverted spy) ──

interface FakePm {
  group: { state: string; members: MergeRequestView[] };
  attempts: MergeAttemptView[];
  calls: string[];
  rejectPayload?: { reason: string; category?: string };
  landGroupBody?: { members: { requestId: string; landedSha: string; role: string }[] };
  attemptCompletions: { attemptId: string; status: string; treeSha?: string }[];
  /** Captured noteOuterConverted args (invariant 5 surfacing). */
  outerConverted?: { requestId: string; reason: string };
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeFakePm(state: FakePm): GroupIntegrationDeps["pmClient"] {
  let seq = 0;
  const fake = {
    async markGroupIntegrating(_id: string): Promise<unknown> {
      state.calls.push("markGroupIntegrating");
      state.group.state = "integrating";
      for (const m of state.group.members) m.status = "integrating";
      return { ...state.group };
    },
    async noteOuterConverted(requestId: string, reason: string): Promise<void> {
      state.calls.push("noteOuterConverted");
      state.outerConverted = { requestId, reason };
    },
    async rejectGroup(
      _id: string,
      payload: { reason: string; category?: string },
    ): Promise<unknown> {
      state.calls.push("rejectGroup");
      state.rejectPayload = payload;
      state.group.state = "rejected";
      for (const m of state.group.members) {
        if (m.status === "queued" || m.status === "integrating") {
          m.status = "rejected";
          m.rejectReason = payload.reason;
        }
      }
      return { ...state.group };
    },
    async startAttempt(requestId: string, baseSha: string): Promise<MergeAttemptView> {
      seq += 1;
      const att: MergeAttemptView = {
        id: `att-${seq}`,
        requestId,
        attemptNumber: seq,
        baseSha,
        treeSha: null,
        status: "running",
        startedAt: nowIso(),
        completedAt: null,
        verifyDurationMs: null,
        failureCategory: null,
        failureReason: null,
        failedFiles: null,
        logExcerpt: null,
        logUrl: null,
        createdAt: nowIso(),
      };
      state.attempts.push(att);
      state.calls.push(`startAttempt:${requestId}`);
      return att;
    },
    async completeAttempt(
      attemptId: string,
      body: { status: string; treeSha?: string },
    ): Promise<MergeAttemptView> {
      const att = state.attempts.find((a) => a.id === attemptId);
      if (!att) throw new Error(`no attempt ${attemptId}`);
      att.status = body.status as MergeAttemptView["status"];
      att.completedAt = nowIso();
      if (body.treeSha) att.treeSha = body.treeSha;
      state.calls.push(`completeAttempt:${body.status}`);
      state.attemptCompletions.push({ attemptId, status: body.status, treeSha: body.treeSha });
      return att;
    },
    async landGroup(
      _groupId: string,
      body: { members: { requestId: string; landedSha: string; role: string }[] },
    ): Promise<unknown> {
      state.calls.push("landGroup");
      state.landGroupBody = body;
      state.group.state = "landed";
      for (const m of state.group.members) {
        const land = body.members.find((b) => b.requestId === m.id);
        if (land) {
          m.status = "landed";
          m.landedSha = land.landedSha;
        }
      }
      return { ...state.group };
    },
  };
  return fake as unknown as GroupIntegrationDeps["pmClient"];
}

function makeMember(over: Partial<MergeRequestView>): MergeRequestView {
  return {
    id: "req-1",
    projectId: "proj-1",
    resource: "main",
    submittedBy: "worker-1",
    taskId: null,
    resolvedFrom: null,
    synthetic: false,
    branch: null,
    commitSha: null,
    verifyCmd: null,
    worktreePath: null,
    status: "queued",
    enqueuedAt: nowIso(),
    pickedUpAt: null,
    resolvedAt: null,
    landedSha: null,
    rejectCategory: null,
    rejectReason: null,
    failedFiles: null,
    logExcerpt: null,
    logUrl: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...over,
  };
}

// ─── Two-repo world builder ────────────────────────────────────────────

interface WorldOpts {
  /** Bind the OUTER member by a BARE branch → use a --mirror bind clone (case 2). */
  mirrorOuterBind?: boolean;
  /** The bump commit ALSO edits a real source path → NOT a pure bump (case 3). */
  bumpEditsSource?: boolean;
  /** Advance outer main's gitlink to a DIFFERENT inner sha AFTER minting the bump
   *  (a concurrent land → the bump is stale; cases 3 & 4). */
  advanceOuterGitlink?: boolean;
}

interface World {
  tmpRoot: string;
  innerBare: string;
  outerBare: string;
  innerMainSha: string;
  innerFeatureSha: string;
  outerMain0: string;
  outerBumpSha: string;
  advancedOuterMain?: string;
  innerPool: WorktreePool;
  outerPool: WorktreePool;
  innerBindGit: SimpleGit;
  outerBindGit: SimpleGit;
}

async function buildWorld(opts: WorldOpts = {}): Promise<World> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-grpconv-"));
  const innerBare = path.join(tmpRoot, "inner.git");
  const outerBare = path.join(tmpRoot, "outer.git");
  const worktreeRoot = path.join(tmpRoot, "wtroot");
  await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
  await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);

  // ── seed INNER (main base + a feature branch = a REAL gitlink target) ──
  const innerSeed = path.join(tmpRoot, "inner-seed");
  await simpleGit().clone(innerBare, innerSeed);
  const ig = simpleGit(innerSeed);
  await configIdentity(ig);
  writeFileSync(path.join(innerSeed, "lib.txt"), "v1\n");
  await ig.add(["lib.txt"]);
  await ig.commit("inner main base");
  await ig.branch(["-M", "main"]);
  await ig.push(["-u", "origin", "main"]);
  const innerMainSha = (await ig.revparse(["HEAD"])).trim();

  await ig.checkoutLocalBranch("feature/inner");
  writeFileSync(path.join(innerSeed, "feature.txt"), "inner feature\n");
  await ig.add(["feature.txt"]);
  await ig.commit("inner feature commit");
  await ig.push(["-u", "origin", "feature/inner"]);
  const innerFeatureSha = (await ig.revparse(["HEAD"])).trim();

  // ── seed OUTER (main base with gitlink -> inner main) ──
  const outerSeed = path.join(tmpRoot, "outer-seed");
  await simpleGit().clone(outerBare, outerSeed);
  const og = simpleGit(outerSeed);
  await configIdentity(og);
  writeFileSync(path.join(outerSeed, "top.txt"), "top v1\n");
  const innerUrlForGitmodules = innerBare.replace(/\\/g, "/");
  writeFileSync(
    path.join(outerSeed, ".gitmodules"),
    `[submodule "rynx"]\n\tpath = ${GITLINK_PATH}\n\turl = ${innerUrlForGitmodules}\n`,
  );
  await og.add(["top.txt", ".gitmodules"]);
  await og.raw(["update-index", "--add", "--cacheinfo", `160000,${innerMainSha},${GITLINK_PATH}`]);
  await og.commit("outer main base with gitlink");
  await og.branch(["-M", "main"]);
  await og.push(["-u", "origin", "main"]);
  const outerMain0 = (await og.revparse(["HEAD"])).trim();

  // ── the worker-minted OUTER bump branch off main0: gitlink -> inner feature.
  //    A PURE bump touches only the gitlink; `bumpEditsSource` adds a real source
  //    path so the diff is 2 paths (→ never converts). ──
  await og.checkoutLocalBranch("bump/outer");
  await og.raw([
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${innerFeatureSha},${GITLINK_PATH}`,
  ]);
  if (opts.bumpEditsSource) {
    mkdirSync(path.join(outerSeed, "src"), { recursive: true });
    writeFileSync(path.join(outerSeed, "src", "foo.txt"), "outer source change\n");
    await og.add(["src/foo.txt"]);
  }
  await og.commit("outer gitlink bump -> inner feature");
  await og.push(["-u", "origin", "bump/outer"]);
  const outerBumpSha = (await og.revparse(["HEAD"])).trim();

  // ── optional concurrent land: another gitlink change advances outer main to a
  //    DIFFERENT inner sha, so the worker's bump (anchored to main0) is stale. ──
  let advancedOuterMain: string | undefined;
  if (opts.advanceOuterGitlink) {
    await ig.checkout("main");
    writeFileSync(path.join(innerSeed, "other.txt"), "someone else's change\n");
    await ig.add(["other.txt"]);
    await ig.commit("concurrent inner change");
    await ig.push(["origin", "main"]);
    const innerSecondSha = (await ig.revparse(["HEAD"])).trim();

    await og.checkout("main");
    await og.raw([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${innerSecondSha},${GITLINK_PATH}`,
    ]);
    await og.commit("concurrent gitlink land -> second inner sha");
    await og.push(["origin", "main"]);
    advancedOuterMain = (await og.revparse(["HEAD"])).trim();
  }

  // ── per-repo pools (size-1) ──
  const innerPool = createWorktreePool({
    worktreeRoot,
    worktreeName: "inner",
    gitRepoUrl: innerBare,
    gitRemote: GIT_REMOTE,
    gitMainBranch: GIT_MAIN,
    parallelism: 1,
    cleanKeep: [],
  });
  const outerPool = createWorktreePool({
    worktreeRoot,
    worktreeName: "outer",
    gitRepoUrl: outerBare,
    gitRemote: GIT_REMOTE,
    gitMainBranch: GIT_MAIN,
    parallelism: 1,
    cleanKeep: [],
  });
  await innerPool.ensureAll();
  await outerPool.ensureAll();

  // ── binding clones. The OUTER bind is a --mirror clone when the case binds by
  //    a bare branch (a normal clone puts branches under refs/remotes/origin/*,
  //    where a bare `bump/outer` does NOT resolve; a mirror maps them to
  //    refs/heads/* so it does — production parity). ──
  const innerBind = path.join(tmpRoot, "inner-bind");
  const outerBind = path.join(tmpRoot, "outer-bind");
  await simpleGit().clone(innerBare, innerBind);
  if (opts.mirrorOuterBind) {
    await simpleGit().clone(outerBare, outerBind, ["--mirror"]);
  } else {
    await simpleGit().clone(outerBare, outerBind);
  }
  const innerBindGit = simpleGit(innerBind);
  const outerBindGit = simpleGit(outerBind);
  await innerBindGit.fetch("origin");
  if (!opts.mirrorOuterBind) await outerBindGit.fetch("origin");

  return {
    tmpRoot,
    innerBare,
    outerBare,
    innerMainSha,
    innerFeatureSha,
    outerMain0,
    outerBumpSha,
    advancedOuterMain,
    innerPool,
    outerPool,
    innerBindGit,
    outerBindGit,
  };
}

// ─── shared lane + deps helpers ─────────────────────────────────────────

const logger = createLogger("error");

function innerLane(w: World): RepoLane {
  return {
    role: "inner",
    name: "rynx-inner",
    acquire: () => w.innerPool.acquire(),
    release: (wt) => w.innerPool.release(wt),
    gitOps: (p) => createGitOps(simpleGit(p)),
    gitlinkPath: GITLINK_PATH,
    resolveRefInClone: (ref) => resolveVerified(w.innerBindGit, ref),
  };
}
function outerLane(w: World): RepoLane {
  return {
    role: "outer",
    name: "app-outer",
    acquire: () => w.outerPool.acquire(),
    release: (wt) => w.outerPool.release(wt),
    gitOps: (p) => createGitOps(simpleGit(p)),
    resolveRefInClone: (ref) => resolveVerified(w.outerBindGit, ref),
  };
}

function makeState(members: MergeRequestView[]): FakePm {
  return { group: { state: "forming", members }, attempts: [], calls: [], attemptCompletions: [] };
}

function depsFor(w: World, state: FakePm): GroupIntegrationDeps {
  return {
    pmClient: makeFakePm(state),
    logger,
    innerLane: innerLane(w),
    outerLane: outerLane(w),
    gitRemote: GIT_REMOTE,
    defaultVerifyCommand: "echo verify-ok",
    verifyTimeoutSec: 30,
  };
}

async function bareMainSha(bare: string): Promise<string> {
  return (await simpleGit(bare).revparse([GIT_MAIN])).trim();
}

// ─── tests ──────────────────────────────────────────────────────────────

describe.skipIf(!GIT_AVAILABLE)("gitlink-bump auto-convert (real two-repo)", () => {
  const worlds: World[] = [];

  afterAll(() => {
    for (const w of worlds) {
      try {
        rmSync(w.tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  async function world(opts: WorldOpts = {}): Promise<World> {
    const w = await buildWorld(opts);
    worlds.push(w);
    return w;
  }

  // ── (1) conversion via a commitSha outer member ──
  it("commitSha outer member is a pure bump → converted, rebase skipped, group lands (outer @ Ro role outer)", async () => {
    const w = await world();
    const liveOuterMain = await bareMainSha(w.outerBare);
    const state = makeState([
      makeMember({ id: "req-inner", commitSha: w.innerFeatureSha, verifyCmd: "echo inner-ok" }),
      makeMember({ id: "req-outer", commitSha: w.outerBumpSha, verifyCmd: "echo outer-ok" }),
    ]);
    const deps = depsFor(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-conv-1", members: state.group.members },
      deps,
    );

    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") {
      throw new Error(
        `expected ready_to_land, got ${integ.kind}${integ.kind === "rejected" ? `: ${integ.reason}` : ""}`,
      );
    }
    const asm = integ.assembled;
    // The converted arm is honestly marked (NOT the born-synthetic arm).
    expect(asm.outerConverted).toBe(true);
    // Bound roles: real inner → inner, real outer bump → outer (config lane).
    expect(integ.innerMember.id).toBe("req-inner");
    expect(integ.outerMember.id).toBe("req-outer");
    // Synthesized on LIVE outer main; Ro == exactly one commit on top of it.
    expect(asm.baseOuterSha).toBe(liveOuterMain);
    const outerWtGit = simpleGit(asm.outerWt.path);
    expect((await outerWtGit.revparse([`${integ.Ro}^`])).trim()).toBe(asm.baseOuterSha);
    const bumpCount = parseInt(
      (await outerWtGit.raw(["rev-list", "--count", `${asm.baseOuterSha}..${integ.Ro}`])).trim(),
      10,
    );
    expect(bumpCount).toBe(1);
    // Committed gitlink == Ri; the inner sources are materialized on disk.
    expect(await asm.outerGitOps.readSubmoduleGitlink(GITLINK_PATH)).toBe(integ.Ri);
    expect(existsSync(path.join(asm.outerWt.path, "vendor", "rynx", "feature.txt"))).toBe(true);
    // NO outer_conflict was ever minted (surfaced conversion instead).
    expect(state.calls).not.toContain("rejectGroup");
    expect(state.calls).toContain("noteOuterConverted");

    const result = await landAssembledGroup(
      {
        groupId: "grp-conv-1",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );
    expect(result.kind).toBe("landed");
    expect(await bareMainSha(w.innerBare)).toBe(integ.Ri);
    expect(await bareMainSha(w.outerBare)).toBe(integ.Ro);
    // The outer (converted, NOT synthetic) member lands @ Ro with role "outer".
    expect(state.landGroupBody?.members).toEqual([
      { requestId: "req-inner", landedSha: integ.Ri, role: "inner" },
      { requestId: "req-outer", landedSha: integ.Ro, role: "outer" },
    ]);
  }, 40_000);

  // ── (2) conversion via a BRANCH-only outer member (resolveDetectRef fallback) ──
  it("branch-only outer member converts (seals the <remote>/<ref> resolvability fallback)", async () => {
    const w = await world({ mirrorOuterBind: true });
    const state = makeState([
      makeMember({ id: "req-inner", commitSha: w.innerFeatureSha, verifyCmd: "echo inner-ok" }),
      // No commitSha — the member binds + rebases by a BARE branch name.
      makeMember({ id: "req-outer", branch: "bump/outer", commitSha: null, verifyCmd: "echo o" }),
    ]);
    const deps = depsFor(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-conv-2", members: state.group.members },
      deps,
    );

    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") {
      throw new Error(
        `expected ready_to_land, got ${integ.kind}${integ.kind === "rejected" ? `: ${integ.reason}` : ""}`,
      );
    }
    // Conversion STILL fires: resolveDetectRef fell back to origin/bump/outer.
    expect(integ.assembled.outerConverted).toBe(true);
    expect(integ.outerMember.id).toBe("req-outer");
    expect(state.calls).toContain("noteOuterConverted");
    expect(state.calls).not.toContain("rejectGroup");
    integ.assembled.release();
  }, 40_000);

  // ── (3) NOT converted: mixed bump+source still rejects outer_conflict ──
  it("mixed bump+source outer member is NOT converted and STILL rejects outer_conflict on drift (invariant 4)", async () => {
    const w = await world({ bumpEditsSource: true, advanceOuterGitlink: true });
    const state = makeState([
      makeMember({ id: "req-inner", commitSha: w.innerFeatureSha, verifyCmd: "echo inner-ok" }),
      makeMember({ id: "req-outer", commitSha: w.outerBumpSha, verifyCmd: "echo outer-ok" }),
    ]);
    const deps = depsFor(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-conv-3", members: state.group.members },
      deps,
    );

    // The mixed member is real outer source → legacy rebase → a genuine conflict
    // on the gitlink line vs the advanced outer main. Byte-identical to today.
    expect(integ.kind).toBe("rejected");
    if (integ.kind === "rejected") {
      expect(integ.reason).toMatch(/outer_conflict/);
    }
    // Never converted, never surfaced — and rejected PRE-pickup (from forming).
    expect(state.calls).not.toContain("noteOuterConverted");
    expect(state.calls).not.toContain("markGroupIntegrating");
    expect(state.outerConverted).toBeUndefined();
  }, 40_000);

  // ── (4) structural conflict-immunity — the grass-stability failure, unit level ──
  it("a stale pure bump against an advanced outer main still assembles + lands (zero outer_conflict)", async () => {
    const w = await world({ advanceOuterGitlink: true });
    expect(w.advancedOuterMain).toBeDefined();
    const state = makeState([
      makeMember({ id: "req-inner", commitSha: w.innerFeatureSha, verifyCmd: "echo inner-ok" }),
      makeMember({ id: "req-outer", commitSha: w.outerBumpSha, verifyCmd: "echo outer-ok" }),
    ]);
    const deps = depsFor(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-conv-4", members: state.group.members },
      deps,
    );

    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") {
      throw new Error(
        `expected ready_to_land, got ${integ.kind}${integ.kind === "rejected" ? `: ${integ.reason}` : ""}`,
      );
    }
    // Converted, and the synthesized candidate anchors to the ADVANCED main (the
    // stale bump anchor is irrelevant — nothing to conflict with).
    expect(integ.assembled.outerConverted).toBe(true);
    expect(integ.assembled.baseOuterSha).toBe(w.advancedOuterMain);

    const result = await landAssembledGroup(
      {
        groupId: "grp-conv-4",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );
    expect(result.kind).toBe("landed");
    expect(state.calls).not.toContain("rejectGroup");
    expect(state.rejectPayload).toBeUndefined();
    // Outer main advanced PAST the drift to Ro; its gitlink references Ri.
    expect(await bareMainSha(w.outerBare)).toBe(integ.Ro);
    const lsTree = await simpleGit(w.outerBare).raw(["ls-tree", GIT_MAIN, GITLINK_PATH]);
    expect(lsTree.trim()).toBe(`160000 commit ${integ.Ri}\t${GITLINK_PATH}`);
  }, 40_000);

  // ── (5) surfacing — a converted+landed group posts noteOuterConverted ──
  it("surfacing: a converted group calls noteOuterConverted with the exact reason, on the outer member", async () => {
    const w = await world();
    const state = makeState([
      makeMember({ id: "req-inner", commitSha: w.innerFeatureSha, verifyCmd: "echo inner-ok" }),
      makeMember({ id: "req-outer", commitSha: w.outerBumpSha, verifyCmd: "echo outer-ok" }),
    ]);
    const deps = depsFor(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-conv-5", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error("not ready_to_land");

    expect(state.calls).toContain("noteOuterConverted");
    expect(state.outerConverted?.requestId).toBe("req-outer");
    expect(state.outerConverted?.reason).toBe(CONVERT_REASON);
    // Surfacing fires AFTER pickup, BEFORE the per-member attempts start.
    const convIdx = state.calls.indexOf("noteOuterConverted");
    expect(convIdx).toBeGreaterThan(state.calls.indexOf("markGroupIntegrating"));
    expect(convIdx).toBeLessThan(state.calls.indexOf("startAttempt:req-inner"));
    integ.assembled.release();
  }, 40_000);
});
