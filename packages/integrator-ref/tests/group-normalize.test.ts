/**
 * Gitlink NORMALIZATION arm (campaign xrepo-gitlink-umbrella-widening P2) —
 * real two-repo fixtures + applyExcludingGitlink real-git unit tests.
 *
 * When a REAL inner member is present (`outerRef !== null`), the outer member's
 * managed-gitlink hunk is content-free ceremony (step 8 authors the landed
 * gitlink to the landing inner Ri). The pure-bump arm recognized the special
 * case where the gitlink is the ENTIRE diff; this arm generalizes it: a MIXED
 * source + gitlink member has its gitlink hunk STRIPPED (purely from
 * `splitGitlinkDiff`, no ancestry gate — the inner member defines Ri, step 8
 * authors it, the outer verify is the guard) and its source-only net patch
 * synthesized onto live outer main via `GitOps.applyExcludingGitlink`. The stale
 * gitlink can never mint `outer_conflict`; a real SOURCE conflict still rejects.
 *
 * Forks the group-convert harness (bare repos, size-1 pools, binding clones, the
 * fuller FakePm + noteOuterConverted spy, landAssembledGroup).
 *
 * Cases: (i) normalize LANDS; (ii) gitlink-conflict-immunity CONTROL (legacy
 * rebaseOnto would conflict on the very gitlink the normalize arm strips);
 * (iii) a real SOURCE conflict still rejects outer_conflict (detail = the source
 * path, NOT the gitlink); (iv) pure bump unchanged (converted, not normalized);
 * (v) source-only member unchanged (legacy rebase; not converted, not
 * normalized). Plus an applyExcludingGitlink unit describe.
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

// ─── Two-repo world builder (forked from group-convert, +2 opts) ───────────

interface WorldOpts {
  /** The bump commit ALSO edits a real source path → mixed source+gitlink. */
  bumpEditsSource?: boolean;
  /** Advance outer main's gitlink to a DIFFERENT inner sha AFTER minting the bump. */
  advanceOuterGitlink?: boolean;
  /** The concurrent outer-main land ALSO writes src/foo.txt (main's content) — so
   *  the bump's source add/add-conflicts on apply (force a SOURCE conflict). */
  advanceOuterSource?: boolean;
  /** The bump branch edits ONLY src/foo.txt (no gitlink update-index) → a plain
   *  source member, no managed gitlink hunk → the untouched legacy rebase. */
  sourceOnlyMember?: boolean;
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
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-grpnorm-"));
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

  // ── the worker-minted OUTER bump branch off main0 ──
  await og.checkoutLocalBranch("bump/outer");
  if (!opts.sourceOnlyMember) {
    await og.raw([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${innerFeatureSha},${GITLINK_PATH}`,
    ]);
  }
  if (opts.bumpEditsSource || opts.sourceOnlyMember) {
    mkdirSync(path.join(outerSeed, "src"), { recursive: true });
    writeFileSync(path.join(outerSeed, "src", "foo.txt"), "outer source change\n");
    await og.add(["src/foo.txt"]);
  }
  await og.commit("outer bump branch (gitlink and/or source)");
  await og.push(["-u", "origin", "bump/outer"]);
  const outerBumpSha = (await og.revparse(["HEAD"])).trim();

  // ── optional concurrent land: advance outer main's gitlink (+ maybe source) ──
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
    if (opts.advanceOuterSource) {
      // Main-side content at the SAME path the bump adds → add/add source conflict.
      mkdirSync(path.join(outerSeed, "src"), { recursive: true });
      writeFileSync(path.join(outerSeed, "src", "foo.txt"), "main-side source\n");
      await og.add(["src/foo.txt"]);
    }
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

  // ── binding clones (normal clones — cases bind the outer by commitSha) ──
  const innerBind = path.join(tmpRoot, "inner-bind");
  const outerBind = path.join(tmpRoot, "outer-bind");
  await simpleGit().clone(innerBare, innerBind);
  await simpleGit().clone(outerBare, outerBind);
  const innerBindGit = simpleGit(innerBind);
  const outerBindGit = simpleGit(outerBind);
  await innerBindGit.fetch("origin");
  await outerBindGit.fetch("origin");

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

async function readGitlinkFromBare(bare: string): Promise<string> {
  const out = await simpleGit(bare).raw(["ls-tree", GIT_MAIN, GITLINK_PATH]);
  return out.trim();
}

// ─── integration tests ───────────────────────────────────────────────────

describe.skipIf(!GIT_AVAILABLE)("gitlink normalization arm (real two-repo)", () => {
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

  // ── (i) normalize LANDS: mixed source + stale-but-reachable gitlink ──
  it("mixed source + stale gitlink → normalized (gitlink stripped, source applied) → group lands", async () => {
    const w = await world({ bumpEditsSource: true, advanceOuterGitlink: true });
    expect(w.advancedOuterMain).toBeDefined();
    const state = makeState([
      makeMember({ id: "req-inner", commitSha: w.innerFeatureSha, verifyCmd: "echo inner-ok" }),
      makeMember({ id: "req-outer", commitSha: w.outerBumpSha, verifyCmd: "echo outer-ok" }),
    ]);
    const deps = depsFor(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-norm-1", members: state.group.members },
      deps,
    );

    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") {
      throw new Error(
        `expected ready_to_land, got ${integ.kind}${integ.kind === "rejected" ? `: ${integ.reason}` : ""}`,
      );
    }
    const asm = integ.assembled;
    // The NORMALIZE arm fired — NOT the pure-bump conversion arm.
    expect(asm.outerGitlinkNormalized).toBe(true);
    expect(asm.outerConverted).toBe(false);
    // Synthesized on the ADVANCED live outer main (the stale bump anchor is moot).
    expect(asm.baseOuterSha).toBe(w.advancedOuterMain);
    // Step 8 authored the committed gitlink to Ri.
    expect(await asm.outerGitOps.readSubmoduleGitlink(GITLINK_PATH)).toBe(integ.Ri);
    // The stripped-source patch was applied: the bump's source file is present.
    expect(existsSync(path.join(asm.outerWt.path, "src", "foo.txt"))).toBe(true);
    // The inner sources are materialized on disk (step 9).
    expect(existsSync(path.join(asm.outerWt.path, "vendor", "rynx", "feature.txt"))).toBe(true);
    // NO outer_conflict, NO conversion surfacing.
    expect(state.calls).not.toContain("rejectGroup");
    expect(state.calls).not.toContain("noteOuterConverted");

    const result = await landAssembledGroup(
      {
        groupId: "grp-norm-1",
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
    // Outer bare main's gitlink now references Ri.
    expect(await readGitlinkFromBare(w.outerBare)).toBe(
      `160000 commit ${integ.Ri}\t${GITLINK_PATH}`,
    );
  }, 40_000);

  // ── (ii) CONTROL: legacy rebaseOnto would conflict on the gitlink the arm strips ──
  it("control: a plain rebaseOnto(advancedOuterMain, bump) conflicts on the managed gitlink", async () => {
    const w = await world({ bumpEditsSource: true, advanceOuterGitlink: true });
    expect(w.advancedOuterMain).toBeDefined();
    // A fresh clone so we do not disturb the pools — exercise ONLY rebaseOnto.
    const ctrlDir = path.join(w.tmpRoot, "ctrl-outer");
    await simpleGit().clone(w.outerBare, ctrlDir);
    const ctrlGit = simpleGit(ctrlDir);
    await ctrlGit.fetch("origin");
    const ctrl = createGitOps(ctrlGit);
    const res = await ctrl.rebaseOnto(w.advancedOuterMain!, w.outerBumpSha);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // The very gitlink the normalize arm strips is what legacy conflicts on.
      expect(res.conflictingFiles).toContain(GITLINK_PATH);
    }
  }, 40_000);

  // ── (iii) a real SOURCE conflict still rejects outer_conflict (not the gitlink) ──
  it("mixed member with a real source conflict rejects outer_conflict (detail = source path, not gitlink)", async () => {
    const w = await world({
      bumpEditsSource: true,
      advanceOuterSource: true,
      advanceOuterGitlink: true,
    });
    const state = makeState([
      makeMember({ id: "req-inner", commitSha: w.innerFeatureSha, verifyCmd: "echo inner-ok" }),
      makeMember({ id: "req-outer", commitSha: w.outerBumpSha, verifyCmd: "echo outer-ok" }),
    ]);
    const deps = depsFor(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-norm-3", members: state.group.members },
      deps,
    );

    expect(integ.kind).toBe("rejected");
    if (integ.kind === "rejected") {
      expect(integ.reason).toMatch(/outer_conflict/);
      expect(integ.reason).toContain("src/foo.txt");
      expect(integ.reason).not.toContain(GITLINK_PATH);
    }
    // Rejected PRE-pickup (from forming), never surfaced as a conversion.
    expect(state.calls).not.toContain("markGroupIntegrating");
    expect(state.calls).not.toContain("noteOuterConverted");
    expect(state.outerConverted).toBeUndefined();
  }, 40_000);

  // ── (iv) pure bump unchanged: converted, not normalized ──
  it("pure gitlink bump is CONVERTED (not normalized) and lands", async () => {
    const w = await world();
    const state = makeState([
      makeMember({ id: "req-inner", commitSha: w.innerFeatureSha, verifyCmd: "echo inner-ok" }),
      makeMember({ id: "req-outer", commitSha: w.outerBumpSha, verifyCmd: "echo outer-ok" }),
    ]);
    const deps = depsFor(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-norm-4", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error("not ready_to_land");
    expect(integ.assembled.outerConverted).toBe(true);
    expect(integ.assembled.outerGitlinkNormalized).toBe(false);
    expect(state.calls).toContain("noteOuterConverted");

    const result = await landAssembledGroup(
      {
        groupId: "grp-norm-4",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );
    expect(result.kind).toBe("landed");
  }, 40_000);

  // ── (v) source-only member unchanged: legacy rebase (not converted, not normalized) ──
  it("a source-only member (no managed gitlink hunk) takes the legacy rebase, lands, gitlink authored to Ri", async () => {
    const w = await world({ sourceOnlyMember: true });
    const state = makeState([
      makeMember({ id: "req-inner", commitSha: w.innerFeatureSha, verifyCmd: "echo inner-ok" }),
      makeMember({ id: "req-outer", commitSha: w.outerBumpSha, verifyCmd: "echo outer-ok" }),
    ]);
    const deps = depsFor(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-norm-5", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error("not ready_to_land");
    const asm = integ.assembled;
    expect(asm.outerConverted).toBe(false);
    expect(asm.outerGitlinkNormalized).toBe(false);
    // Step 8 still authored the committed gitlink to Ri (legacy rebase + step 8).
    expect(await asm.outerGitOps.readSubmoduleGitlink(GITLINK_PATH)).toBe(integ.Ri);

    const result = await landAssembledGroup(
      {
        groupId: "grp-norm-5",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );
    expect(result.kind).toBe("landed");
    expect(await readGitlinkFromBare(w.outerBare)).toBe(
      `160000 commit ${integ.Ri}\t${GITLINK_PATH}`,
    );
  }, 40_000);
});

// ─── applyExcludingGitlink unit tests (direct createGitOps, real git) ──────

describe.skipIf(!GIT_AVAILABLE)("applyExcludingGitlink (real git)", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  const FAKE_A = "1111111111111111111111111111111111111111";
  const FAKE_B = "2222222222222222222222222222222222222222";

  /** A repo with a fork-point commit O (source + gitlink→A) checked out. */
  async function initRepo(): Promise<{ dir: string; git: SimpleGit; oSha: string }> {
    const dir = mkdtempSync(path.join(tmpdir(), "pm-apply-"));
    roots.push(dir);
    await simpleGit().init(["--initial-branch=main", dir]);
    const git = simpleGit(dir);
    await configIdentity(git);
    writeFileSync(path.join(dir, "top.txt"), "base\n");
    await git.add(["top.txt"]);
    await git.raw(["update-index", "--add", "--cacheinfo", `160000,${FAKE_A},${GITLINK_PATH}`]);
    await git.commit("fork base O (source + gitlink A)");
    const oSha = (await git.revparse(["HEAD"])).trim();
    return { dir, git, oSha };
  }

  async function porcelain(git: SimpleGit): Promise<string> {
    return (await git.raw(["status", "--porcelain"])).trim();
  }

  it("clean apply commits the source and leaves the gitlink UNCHANGED (proves :(exclude))", async () => {
    const { dir, git, oSha } = await initRepo();
    // feat off O: change source AND move the gitlink → B.
    await git.checkoutLocalBranch("feat");
    writeFileSync(path.join(dir, "top.txt"), "feat side\n");
    await git.add(["top.txt"]);
    await git.raw(["update-index", "--add", "--cacheinfo", `160000,${FAKE_B},${GITLINK_PATH}`]);
    await git.commit("feat: source + gitlink B");
    const featSha = (await git.revparse(["HEAD"])).trim();
    // Worktree back at O (= baseSha).
    await git.checkout(oSha);

    const gitOps = createGitOps(git);
    const res = await gitOps.applyExcludingGitlink(oSha, featSha, new Set([GITLINK_PATH]));
    expect(res.ok).toBe(true);
    if (res.ok) {
      // A new commit was made (source changed).
      expect(res.committedSha).not.toBe(oSha);
      // The committed source is feat's; the gitlink is STILL A (hunk excluded).
      // Normalize CRLF — a host with global core.autocrlf=true rewrites the EOL.
      expect((await readFileHead(path.join(dir, "top.txt"))).replace(/\r\n/g, "\n")).toBe(
        "feat side\n",
      );
      expect(await gitOps.readSubmoduleGitlink(GITLINK_PATH)).toBe(FAKE_A);
    }
  }, 30_000);

  it("source conflict → ok:false, worktree reset clean, HEAD restored to baseSha", async () => {
    const { dir, git, oSha } = await initRepo();
    // feat off O: source "feat side".
    await git.checkoutLocalBranch("feat");
    writeFileSync(path.join(dir, "top.txt"), "feat side\n");
    await git.add(["top.txt"]);
    await git.raw(["update-index", "--add", "--cacheinfo", `160000,${FAKE_B},${GITLINK_PATH}`]);
    await git.commit("feat: source + gitlink B");
    const featSha = (await git.revparse(["HEAD"])).trim();
    // main diverges at the SAME path since O.
    await git.checkout("main");
    writeFileSync(path.join(dir, "top.txt"), "main side\n");
    await git.add(["top.txt"]);
    await git.commit("main: diverged source");
    const mainSha = (await git.revparse(["HEAD"])).trim();

    const gitOps = createGitOps(git);
    const res = await gitOps.applyExcludingGitlink(mainSha, featSha, new Set([GITLINK_PATH]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.conflictingFiles).toContain("top.txt");
    }
    // Reset restored a clean tree at the base.
    expect(await porcelain(git)).toBe("");
    expect((await git.revparse(["HEAD"])).trim()).toBe(mainSha);
  }, 30_000);

  it("gitlink-only patch → ok:true, no commit (committedSha === baseSha)", async () => {
    const { dir, git, oSha } = await initRepo();
    // bumponly off O: ONLY the gitlink moves → B, no source.
    await git.checkoutLocalBranch("bumponly");
    await git.raw(["update-index", "--add", "--cacheinfo", `160000,${FAKE_B},${GITLINK_PATH}`]);
    await git.commit("bumponly: gitlink B");
    const bumpSha = (await git.revparse(["HEAD"])).trim();
    await git.checkout(oSha);

    const gitOps = createGitOps(git);
    const res = await gitOps.applyExcludingGitlink(oSha, bumpSha, new Set([GITLINK_PATH]));
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Empty source net → no commit; HEAD unchanged.
      expect(res.committedSha).toBe(oSha);
    }
    expect(await porcelain(git)).toBe("");
  }, 30_000);
});

// Small file-head reader (avoids importing node:fs/promises just for one call).
async function readFileHead(p: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  // Normalize CRLF → LF: git may apply source with platform line endings on
  // Windows; the tests assert content, not the checkout's line-ending policy.
  return (await readFile(p)).toString("utf8").replace(/\r\n/g, "\n");
}
