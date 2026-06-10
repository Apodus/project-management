/**
 * Phase 7.3 Step 10 — runGroupIntegration tests (real two-repo fixture).
 *
 * Reuses the group-assembly.test.ts shape: inner + outer bare repos, a seeded
 * gitlink (outer @ inner-main), per-repo worktree pools, and inner/outer
 * feature branches. A FakePmClient (in-memory, records its call sequence)
 * serves startAttempt / completeAttempt / group methods.
 *
 * Proves: all-pass → ready_to_land (worktrees held); per-repo verify-fail →
 * group rejected (worktrees released, AND combine); concurrent verify overlap;
 * FIX 1 deterministic config-declared role binding + fail-loud ambiguity;
 * FIX 2 transition legality (pre-pickup → forming-reject without pickup;
 * post-pickup → integrating-reject after pickup); FIX 4 the all-pass test
 * releases the held slots (no leak).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { MergeAttemptView, MergeRequestView } from "@pm/shared";
import { createGitOps, type GitOps, type VerifyResult } from "../src/git-ops.js";
import { createWorktreePool, type WorktreePool } from "../src/worktree-pool.js";
import { createLogger } from "../src/logger.js";
import {
  runGroupIntegration,
  type GroupIntegrationDeps,
  type RepoLane,
} from "../src/group-integration.js";

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

/**
 * Resolve `ref` in a clone, returning the SHA only if the object actually
 * EXISTS here. `--verify <ref>^{commit}` fails (→ null) on an absent object —
 * unlike a bare `rev-parse <full-sha>` which echoes any 40-hex back.
 */
async function resolveVerified(
  git: SimpleGit,
  ref: string,
): Promise<string | null> {
  try {
    return (await git.revparse(["--verify", `${ref}^{commit}`])).trim();
  } catch {
    return null;
  }
}

// win32-safe ~300ms sleep for the overlap test (NEVER bare `sleep 0.3`).
const SLEEP_300 =
  process.platform === "win32" ? "ping -n 2 127.0.0.1 > nul" : "sleep 0.3";

// ─── In-memory fake PM client (group + attempt surface) ───────────────

interface FakeGroupState {
  state: "forming" | "integrating" | "rejected" | "landed";
  members: MergeRequestView[];
}

interface FakePm {
  group: FakeGroupState;
  attempts: MergeAttemptView[];
  calls: string[];
  /** Recorded reject payload (FIX 3 surfacing assertion). */
  rejectPayload?: { reason: string; category?: string };
  /** Phase 7.5 Step 6: recorded per-repo cache lookup keys (treeSha + stepId). */
  cacheLookups?: { treeSha: string; stepId: string }[];
  /** Phase 7.5 Step 7: captured completeAttempt bodies (steps[] M1 assertion). */
  completeBodies?: { status: string; steps?: unknown[] }[];
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
    async startAttempt(
      requestId: string,
      baseSha: string,
    ): Promise<MergeAttemptView> {
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
      body: { status: string; steps?: unknown[] },
    ): Promise<MergeAttemptView> {
      const att = state.attempts.find((a) => a.id === attemptId);
      if (!att) throw new Error(`no attempt ${attemptId}`);
      att.status = body.status as MergeAttemptView["status"];
      att.completedAt = nowIso();
      state.calls.push(`completeAttempt:${body.status}`);
      if (state.completeBodies)
        state.completeBodies.push({ status: body.status, steps: body.steps });
      return att;
    },
    // ── Phase 7.5 Step 6 verify-cache (per-repo). MISS always (returns null), so
    //    both repos run; we record the lookup KEY to assert distinct TREE shas. ──
    async lookupVerifyCache(
      _projectId: string,
      key: { treeSha: string; stepId: string },
    ): Promise<unknown> {
      state.cacheLookups?.push({ treeSha: key.treeSha, stepId: key.stepId });
      state.calls.push("lookupVerifyCache");
      return null;
    },
    async recordVerifyCache(): Promise<unknown> {
      state.calls.push("recordVerifyCache");
      return {};
    },
    async emitVerifyCacheMismatch(): Promise<void> {
      state.calls.push("emitVerifyCacheMismatch");
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

// ─── Fixture ──────────────────────────────────────────────────────────

describe.skipIf(!GIT_AVAILABLE)("runGroupIntegration (real two-repo)", () => {
  let tmpRoot: string;
  let innerBare: string;
  let outerBare: string;
  let innerMainSha: string;
  let innerFeatureSha: string;
  let outerFeatureSha: string;
  let innerPool: WorktreePool;
  let outerPool: WorktreePool;
  // Binding clones (one per repo) for resolveRefInClone.
  let innerBindGit: SimpleGit;
  let outerBindGit: SimpleGit;
  const logger = createLogger("error");

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-grpint-"));
    innerBare = path.join(tmpRoot, "inner.git");
    outerBare = path.join(tmpRoot, "outer.git");
    const worktreeRoot = path.join(tmpRoot, "wtroot");

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
    const innerUrlForGitmodules = innerBare.replace(/\\/g, "/");
    writeFileSync(
      path.join(outerSeed, ".gitmodules"),
      `[submodule "rynx"]\n\tpath = ${GITLINK_PATH}\n\turl = ${innerUrlForGitmodules}\n`,
    );
    await og.add(["top.txt", ".gitmodules"]);
    await og.raw([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${innerMainSha},${GITLINK_PATH}`,
    ]);
    await og.commit("outer main base with gitlink");
    await og.branch(["-M", "main"]);
    await og.push(["-u", "origin", "main"]);

    await og.checkoutLocalBranch("feature/outer");
    writeFileSync(path.join(outerSeed, "app.txt"), "outer feature\n");
    await og.add(["app.txt"]);
    await og.commit("outer feature commit");
    await og.push(["-u", "origin", "feature/outer"]);
    outerFeatureSha = (await og.revparse(["HEAD"])).trim();

    // ── per-repo pools (parallelism 1 → size-1 → no-reacquire proves a leak) ──
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

    // ── binding clones: full clones (objects present so the feature SHAs
    //    resolve via revparse). resolveRefInClone returns null on absent refs. ──
    const innerBind = path.join(tmpRoot, "inner-bind");
    const outerBind = path.join(tmpRoot, "outer-bind");
    await simpleGit().clone(innerBare, innerBind);
    await simpleGit().clone(outerBare, outerBind);
    innerBindGit = simpleGit(innerBind);
    outerBindGit = simpleGit(outerBind);
    await innerBindGit.fetch("origin");
    await outerBindGit.fetch("origin");
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ── lane factories ──
  function innerLane(over?: Partial<RepoLane>): RepoLane {
    return {
      role: "inner",
      name: "rynx-inner",
      acquire: () => innerPool.acquire(),
      release: (wt) => innerPool.release(wt),
      gitOps: (p) => createGitOps(simpleGit(p)),
      gitlinkPath: GITLINK_PATH,
      resolveRefInClone: (ref) => resolveVerified(innerBindGit, ref),
      ...over,
    };
  }
  function outerLane(over?: Partial<RepoLane>): RepoLane {
    return {
      role: "outer",
      name: "app-outer",
      acquire: () => outerPool.acquire(),
      release: (wt) => outerPool.release(wt),
      gitOps: (p) => createGitOps(simpleGit(p)),
      resolveRefInClone: (ref) => resolveVerified(outerBindGit, ref),
      ...over,
    };
  }

  function makeGroupState(
    over: { inner?: Partial<MergeRequestView>; outer?: Partial<MergeRequestView> } = {},
  ): FakePm {
    const inner = makeMember({
      id: "req-inner",
      commitSha: innerFeatureSha,
      ...over.inner,
    });
    const outer = makeMember({
      id: "req-outer",
      commitSha: outerFeatureSha,
      ...over.outer,
    });
    return {
      group: { state: "forming", members: [inner, outer] },
      attempts: [],
      calls: [],
      completeBodies: [],
    };
  }

  function depsFor(
    state: FakePm,
    over?: Partial<GroupIntegrationDeps>,
  ): GroupIntegrationDeps {
    return {
      pmClient: makeFakePm(state),
      logger,
      innerLane: innerLane(),
      outerLane: outerLane(),
      defaultVerifyCommand: "echo verify-ok",
      verifyTimeoutSec: 30,
      ...over,
    };
  }

  // ── 1. all-pass → ready_to_land ──
  it("all-pass → ready_to_land; both attempts started on the rebase bases; worktrees held (FIX 4 releases after)", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: "echo inner-ok" },
      outer: { verifyCmd: "echo outer-ok" },
    });
    const deps = depsFor(state);
    const outcome = await runGroupIntegration(
      { id: "grp-1", members: state.group.members },
      deps,
    );

    expect(outcome.kind).toBe("ready_to_land");
    if (outcome.kind !== "ready_to_land") throw new Error("not ready_to_land");

    // markGroupIntegrating happened (post-pickup path), both startAttempts.
    expect(state.calls).toContain("markGroupIntegrating");
    expect(state.calls).toContain("startAttempt:req-inner");
    expect(state.calls).toContain("startAttempt:req-outer");

    // Attempt bases == the per-repo rebase anchors (baseInnerSha / baseOuterSha).
    const innerAtt = state.attempts.find((a) => a.id === outcome.innerAttemptId)!;
    const outerAtt = state.attempts.find((a) => a.id === outcome.outerAttemptId)!;
    expect(innerAtt.baseSha).toBe(outcome.assembled.baseInnerSha);
    expect(outerAtt.baseSha).toBe(outcome.assembled.baseOuterSha);

    // Ri / Ro returned; Ri != inner main (a real bump).
    expect(outcome.Ri).toMatch(/^[0-9a-f]{40}$/);
    expect(outcome.Ro).toMatch(/^[0-9a-f]{40}$/);
    expect(outcome.Ri).not.toBe(innerMainSha);

    // Phase 7.5 FOLDED-FIX M1: ready_to_land threads each repo's per-step results
    // through to group-land's passing completeAttempt (single synthetic step each).
    expect(outcome.innerSteps?.map((s) => s.stepId)).toEqual(["verify"]);
    expect(outcome.outerSteps?.map((s) => s.stepId)).toEqual(["verify"]);

    // Attempts NOT completed (Step 11 completes with treeSha on land).
    expect(state.calls).not.toContain("completeAttempt:passed");
    // NOT rejected.
    expect(state.calls).not.toContain("rejectGroup");

    // Worktrees NOT released: the size-1 pools cannot reacquire.
    expect(innerPool.acquire()).toBeNull();
    expect(outerPool.acquire()).toBeNull();

    // FIX 4: release the held worktrees AFTER asserting (no leak for later tests).
    outcome.assembled.release();
    const i = innerPool.acquire();
    const o = outerPool.acquire();
    expect(i).not.toBeNull();
    expect(o).not.toBeNull();
    if (i) innerPool.release(i);
    if (o) outerPool.release(o);
  }, 30_000);

  // ── Phase 7.5 Step 6 (§6): per-repo cache keys on DISTINCT content-addressed
  //    TREE shas (CLARIFICATION A: derived from Ri/Ro via `^{tree}`), AND-combine
  //    preserved. Both repos MISS (the fake returns null) → both verifies run. ──
  it("7.5 cross-repo: inner + outer cache lookups key on DISTINCT tree shas; AND preserved", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: "echo inner-ok" },
      outer: { verifyCmd: "echo outer-ok" },
    });
    state.cacheLookups = [];
    const deps = depsFor(state, {
      projectId: "proj-1",
      resource: "main",
      cacheEnabled: true,
      cacheMode: "on",
    });
    const outcome = await runGroupIntegration(
      { id: "grp-cache", members: state.group.members },
      deps,
    );

    expect(outcome.kind).toBe("ready_to_land");
    if (outcome.kind !== "ready_to_land") throw new Error("not ready_to_land");

    // Both repos probed the cache (single synthetic step each → 2 lookups).
    expect(state.cacheLookups!.length).toBe(2);
    const treeShas = state.cacheLookups!.map((l) => l.treeSha);
    // Two DISTINCT content-addressed tree shas (inner vs outer assembled tree).
    expect(new Set(treeShas).size).toBe(2);
    // Each is a real 40-hex git tree sha (NOT the commit shas Ri/Ro).
    for (const t of treeShas) expect(t).toMatch(/^[0-9a-f]{40}$/);
    expect(treeShas).not.toContain(outcome.Ri); // keyed on the TREE, not the commit
    expect(treeShas).not.toContain(outcome.Ro);
    // AND preserved: both passed → ready_to_land (not rejected).
    expect(state.calls).not.toContain("rejectGroup");

    outcome.assembled.release();
    const i = innerPool.acquire();
    const o = outerPool.acquire();
    if (i) innerPool.release(i);
    if (o) outerPool.release(o);
  }, 30_000);

  // ── 2. inner-verify-fail → rejected ──
  it("inner-verify-fail → rejected: inner failed, outer cancelled, group rejected, worktrees released", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: "exit 1" },
      outer: { verifyCmd: "echo outer-ok" },
    });
    const deps = depsFor(state);
    const outcome = await runGroupIntegration(
      { id: "grp-2", members: state.group.members },
      deps,
    );

    expect(outcome.kind).toBe("rejected");
    // Post-pickup path: markGroupIntegrating BEFORE the reject (FIX 2).
    expect(state.calls.indexOf("markGroupIntegrating")).toBeGreaterThanOrEqual(0);
    expect(state.calls.indexOf("markGroupIntegrating")).toBeLessThan(
      state.calls.indexOf("rejectGroup"),
    );
    // Inner attempt failed; outer (passing sibling) cancelled.
    expect(state.calls).toContain("completeAttempt:failed");
    expect(state.calls).toContain("completeAttempt:cancelled");
    expect(state.calls).toContain("rejectGroup");
    // FIX 3: surfaced via the rejectGroup reason exactly once.
    expect(state.rejectPayload?.reason).toMatch(/assembled verify failed: inner/);
    // Phase 7.5 FOLDED-FIX M1: the failing repo's completeAttempt carries its
    // per-repo pipeline steps (the synthetic single step → a 1-element array).
    const failedBody = state.completeBodies!.find((b) => b.status === "failed");
    expect(failedBody).toBeDefined();
    expect(
      (failedBody!.steps as { stepId: string }[]).map((s) => s.stepId),
    ).toEqual(["verify"]);

    // Worktrees RELEASED (pools reacquirable).
    const i = innerPool.acquire();
    const o = outerPool.acquire();
    expect(i).not.toBeNull();
    expect(o).not.toBeNull();
    if (i) innerPool.release(i);
    if (o) outerPool.release(o);
  }, 30_000);

  // ── 3. outer-verify-fail → rejected (symmetric) ──
  it("outer-verify-fail → rejected: outer failed, inner cancelled, group rejected, worktrees released", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: "echo inner-ok" },
      outer: { verifyCmd: "exit 1" },
    });
    const deps = depsFor(state);
    const outcome = await runGroupIntegration(
      { id: "grp-3", members: state.group.members },
      deps,
    );

    expect(outcome.kind).toBe("rejected");
    expect(state.calls).toContain("completeAttempt:failed");
    expect(state.calls).toContain("completeAttempt:cancelled");
    expect(state.rejectPayload?.reason).toMatch(/assembled verify failed: outer/);

    const i = innerPool.acquire();
    const o = outerPool.acquire();
    expect(i).not.toBeNull();
    expect(o).not.toBeNull();
    if (i) innerPool.release(i);
    if (o) outerPool.release(o);
  }, 30_000);

  // ── 4. concurrent verify overlap ──
  it("concurrent verify overlap: inner + outer verify windows intersect (AND runs them in parallel)", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: SLEEP_300 },
      outer: { verifyCmd: SLEEP_300 },
    });
    // Wrap the lane gitOps factories to record each verify's {start,end}.
    const windows: { label: string; start: number; end: number }[] = [];
    const wrap = (label: string, factory: (p: string) => GitOps) => {
      return (p: string): GitOps => {
        const real = factory(p);
        return {
          ...real,
          async runVerify(cmd, t, o): Promise<VerifyResult> {
            const start = Date.now();
            const res = await real.runVerify(cmd, t, o);
            windows.push({ label, start, end: Date.now() });
            return res;
          },
        };
      };
    };
    const deps = depsFor(state, {
      innerLane: innerLane({ gitOps: wrap("inner", (p) => createGitOps(simpleGit(p))) }),
      outerLane: outerLane({ gitOps: wrap("outer", (p) => createGitOps(simpleGit(p))) }),
    });
    const outcome = await runGroupIntegration(
      { id: "grp-4", members: state.group.members },
      deps,
    );

    expect(outcome.kind).toBe("ready_to_land");
    expect(windows.length).toBe(2);
    const [a, b] = windows;
    // The two windows intersect → they ran concurrently (Promise.all).
    expect(a.start < b.end && b.start < a.end).toBe(true);

    if (outcome.kind === "ready_to_land") {
      outcome.assembled.release();
      const i = innerPool.acquire();
      const o = outerPool.acquire();
      if (i) innerPool.release(i);
      if (o) outerPool.release(o);
    }
  }, 30_000);

  // ── 5a. FIX 1 role mapping: deterministic commitSha→repo binding ──
  it("FIX 1: members bind by commitSha→repo; gitlink points at the INNER member's Ri", async () => {
    // Deliberately pass members in OUTER-first order to prove binding is by ref
    // resolution + config role, NOT by array position.
    const inner = makeMember({ id: "req-inner", commitSha: innerFeatureSha, verifyCmd: "echo ok" });
    const outer = makeMember({ id: "req-outer", commitSha: outerFeatureSha, verifyCmd: "echo ok" });
    const state: FakePm = {
      group: { state: "forming", members: [outer, inner] }, // outer FIRST
      attempts: [],
      calls: [],
    };
    const deps = depsFor(state);
    const outcome = await runGroupIntegration(
      { id: "grp-5a", members: state.group.members },
      deps,
    );
    expect(outcome.kind).toBe("ready_to_land");
    if (outcome.kind !== "ready_to_land") throw new Error("not ready");

    // The bound inner/outer members are correct DESPITE the swapped order.
    expect(outcome.innerMember.id).toBe("req-inner");
    expect(outcome.outerMember.id).toBe("req-outer");

    // The committed outer gitlink points at the INNER member's Ri (not outer).
    const readBack = await outcome.assembled.outerGitOps.readSubmoduleGitlink(
      GITLINK_PATH,
    );
    expect(readBack).toBe(outcome.Ri);

    outcome.assembled.release();
    const i = innerPool.acquire();
    const o = outerPool.acquire();
    if (i) innerPool.release(i);
    if (o) outerPool.release(o);
  }, 30_000);

  // ── 5b. FIX 1 ambiguity: a ref resolving in BOTH repos → fail loud ──
  it("FIX 1: a member ref resolving in BOTH repos → rejected (no guess), no pickup, no leak", async () => {
    // Force the inner member's ref to resolve in BOTH clones (ambiguous).
    const inner = makeMember({ id: "req-inner", commitSha: innerFeatureSha });
    const outer = makeMember({ id: "req-outer", commitSha: outerFeatureSha });
    const state: FakePm = {
      group: { state: "forming", members: [inner, outer] },
      attempts: [],
      calls: [],
    };
    const deps = depsFor(state, {
      innerLane: innerLane({ resolveRefInClone: async () => "deadbeef".repeat(5) }),
      outerLane: outerLane({ resolveRefInClone: async () => "deadbeef".repeat(5) }),
    });
    const outcome = await runGroupIntegration(
      { id: "grp-5b", members: state.group.members },
      deps,
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toMatch(/could not unambiguously bind/);
    }
    // FIX 2: pre-pickup → rejected WITHOUT markGroupIntegrating.
    expect(state.calls).not.toContain("markGroupIntegrating");
    expect(state.calls).toContain("rejectGroup");
    // No worktrees were leased → pools still free.
    const i = innerPool.acquire();
    const o = outerPool.acquire();
    expect(i).not.toBeNull();
    expect(o).not.toBeNull();
    if (i) innerPool.release(i);
    if (o) outerPool.release(o);
  });

  // ── 5c. FIX 1 ambiguity: a ref resolving in NEITHER repo → fail loud ──
  it("FIX 1: a member ref resolving in NEITHER repo → rejected (no guess)", async () => {
    const inner = makeMember({ id: "req-inner", commitSha: innerFeatureSha });
    const outer = makeMember({ id: "req-outer", commitSha: outerFeatureSha });
    const state: FakePm = {
      group: { state: "forming", members: [inner, outer] },
      attempts: [],
      calls: [],
    };
    const deps = depsFor(state, {
      innerLane: innerLane({ resolveRefInClone: async () => null }),
      outerLane: outerLane({ resolveRefInClone: async () => null }),
    });
    const outcome = await runGroupIntegration(
      { id: "grp-5c", members: state.group.members },
      deps,
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toMatch(/could not unambiguously bind/);
    }
    expect(state.calls).not.toContain("markGroupIntegrating");
  });

  // ── 6. FIX 2 transition legality: pre-pickup assembly conflict → forming-reject ──
  it("FIX 2: pre-pickup assembly conflict rejects from FORMING (no markGroupIntegrating)", async () => {
    // Inner ref that does not exist as a rebasable branch in the inner POOL
    // worktree → assembleGroup's inner rebase fails → inner_conflict/mismatch.
    // We force this by binding the inner member to a bogus rebase ref that
    // resolves in the binding clone (so binding succeeds) but fails the rebase.
    const inner = makeMember({
      id: "req-inner",
      // commitSha resolves in the inner bind clone (binding ok) but the SHA is
      // not a branch tip in the pool worktree; rebaseOnto will still try it.
      // To force an assembly failure deterministically, use a ref the pool
      // worktree cannot resolve at all → rebase throws → inner_conflict.
      branch: "feature/does-not-exist-in-pool",
      commitSha: null,
    });
    const outer = makeMember({ id: "req-outer", commitSha: outerFeatureSha });
    const state: FakePm = {
      group: { state: "forming", members: [inner, outer] },
      attempts: [],
      calls: [],
    };
    const deps = depsFor(state, {
      // Bind inner by branch — make it resolve ONLY in the inner clone so
      // binding succeeds and role=inner.
      innerLane: innerLane({
        resolveRefInClone: async (ref) =>
          ref === "feature/does-not-exist-in-pool" ? "a".repeat(40) : null,
      }),
      outerLane: outerLane({
        resolveRefInClone: async (ref) =>
          ref === "feature/does-not-exist-in-pool"
            ? null
            : resolveVerified(outerBindGit, ref),
      }),
    });
    const outcome = await runGroupIntegration(
      { id: "grp-6", members: state.group.members },
      deps,
    );
    expect(outcome.kind).toBe("rejected");
    // Rejected from FORMING — NO pickup happened (FIX 2; legal forming→rejected).
    expect(state.calls).not.toContain("markGroupIntegrating");
    expect(state.calls).toContain("rejectGroup");
    // Worktrees released (assembly's release() ran).
    const i = innerPool.acquire();
    const o = outerPool.acquire();
    expect(i).not.toBeNull();
    expect(o).not.toBeNull();
    if (i) innerPool.release(i);
    if (o) outerPool.release(o);
  }, 30_000);

  // ── 6b. FIX 2: post-pickup verify-fail → integrating-reject ──
  it("FIX 2: post-pickup verify-fail rejects from INTEGRATING (markGroupIntegrating first)", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: "exit 1" },
      outer: { verifyCmd: "echo ok" },
    });
    const deps = depsFor(state);
    const outcome = await runGroupIntegration(
      { id: "grp-6b", members: state.group.members },
      deps,
    );
    expect(outcome.kind).toBe("rejected");
    // markGroupIntegrating happened BEFORE rejectGroup (integrating→rejected).
    const mi = state.calls.indexOf("markGroupIntegrating");
    const rj = state.calls.indexOf("rejectGroup");
    expect(mi).toBeGreaterThanOrEqual(0);
    expect(rj).toBeGreaterThan(mi);

    const i = innerPool.acquire();
    const o = outerPool.acquire();
    if (i) innerPool.release(i);
    if (o) outerPool.release(o);
  }, 30_000);

  // ── 7. backpressure: pool exhausted → backpressure, group untouched ──
  it("backpressure: inner pool exhausted → {backpressure}, PM untouched, group still forming", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: "echo ok" },
      outer: { verifyCmd: "echo ok" },
    });
    const held = innerPool.acquire(); // drain the size-1 inner pool
    expect(held).not.toBeNull();
    try {
      const deps = depsFor(state);
      const outcome = await runGroupIntegration(
        { id: "grp-7", members: state.group.members },
        deps,
      );
      expect(outcome.kind).toBe("backpressure");
      // PM untouched: no pickup, no reject, no attempts.
      expect(state.calls).not.toContain("markGroupIntegrating");
      expect(state.calls).not.toContain("rejectGroup");
      expect(state.attempts.length).toBe(0);
      expect(state.group.state).toBe("forming");
    } finally {
      if (held) innerPool.release(held);
    }
  });
});
