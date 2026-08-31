/**
 * Phase 7.3 Step 11 — landAssembledGroup tests (real two-repo fixture).
 *
 * Reuses the group-integration.test.ts shape: inner + outer bare repos, a
 * seeded gitlink (outer @ inner-main), per-repo worktree pools, and inner/outer
 * feature branches. runGroupIntegration assembles + verifies to ready_to_land;
 * landAssembledGroup then runs the §6 atomic land. A FakePm records the full
 * group-land call surface (landGroup / markInnerOrphaned / openIncident /
 * markPartiallyLanded / rejectMergeRequest / completeAttempt) and the member /
 * group / incident state.
 *
 * Induced push failure: wrap a lane's gitOps factory so the chosen repo's
 * `push` returns a PushFailure once (the 7.2 technique), while every other op
 * delegates to the real gitOps. The OTHER repo pushes for real, so the real
 * bare main advances (or does not) exactly as the atomic protocol dictates —
 * which the assertions read back from the bare repos.
 *
 * Proves: (a) clean land — both bare mains advance, gitlink @ Ri, landGroup
 * with both roles, attempts passed-before-landGroup, worktrees released;
 * (b) inner-push-fail — inner bare main NOT advanced, outer untouched, group
 * rejected, no incident; (c) outer-push-fail AFTER inner landed — THE ORPHAN:
 * inner bare main advanced, outer NOT advanced, the EXACT §6.5 call order +
 * incident; (d) drift — neither push attempted, group RE-QUEUED (campaign
 * 2026-08-15 §R1: main moving is not a verdict on the change), no incident.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { MergeAttemptView, MergeRequestView } from "@pm/shared";
import { createGitOps, type GitOps, type PushResult } from "../src/git-ops.js";
import { createWorktreePool, type WorktreePool } from "../src/worktree-pool.js";
import { createLogger } from "../src/logger.js";
import { makePhaseProbe } from "./phase-probe.js";
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

// ─── In-memory fake PM client (group-land surface) ────────────────────

interface FakeGroupState {
  state: "forming" | "integrating" | "rejected" | "landed" | "partially_landed";
  members: MergeRequestView[];
}

interface OpenedIncident {
  id: string;
  projectId: string;
  type: string;
  innerRepo: string;
  orphanedSha: string;
  outerRepo: string;
  groupId?: string | null;
  innerRequestId?: string | null;
  taskId?: string | null;
}

interface FakePm {
  group: FakeGroupState;
  attempts: MergeAttemptView[];
  /** Ordered call log (the §6.5 EXACT-order assertion reads this). */
  calls: string[];
  rejectPayload?: { reason: string; category?: string };
  /** landGroup body (members + roles). */
  landGroupBody?: {
    members: { requestId: string; landedSha: string; role: string }[];
  };
  /** Recorded openIncident params. */
  incident?: OpenedIncident;
  /** Recorded markPartiallyLanded body. */
  partiallyLanded?: { reason: string; incidentId?: string };
  /** Recorded markInnerOrphaned (requestId → orphanedSha). */
  orphaned?: { requestId: string; orphanedSha: string };
  /** Recorded per-request rejectMergeRequest (the outer member, §6.5e). */
  requestRejects: { requestId: string; category: string; reason: string }[];
  /** §R1: recorded resetGroup payload (the re-queue). */
  resetPayload?: { reason?: string };
  /** §R1: force the derived attempt count, to drive the re-queue bound. */
  priorAttempts?: number;
  /** §R1: make the attempt-count read fail (the fail-open branch). */
  getRequestThrows?: boolean;
  /** Per-attempt completion payloads, in order. */
  attemptCompletions: {
    attemptId: string;
    status: string;
    treeSha?: string;
    steps?: unknown[];
  }[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeFakePm(state: FakePm): GroupIntegrationDeps["pmClient"] {
  let seq = 0;
  let incidentSeq = 0;
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
    // Campaign 2026-08-15 §R1: the re-queue primitive (integrating → forming,
    // members back to queued) and the attempt-count read behind its bound.
    async resetGroup(_id: string, opts?: { reason?: string }): Promise<unknown> {
      state.calls.push("resetGroup");
      state.resetPayload = { reason: opts?.reason };
      state.group.state = "forming";
      for (const m of state.group.members) {
        if (m.status === "integrating") m.status = "queued";
      }
      return { ...state.group };
    },
    async getMergeRequest(
      id: string,
    ): Promise<MergeRequestView & { attempts: MergeAttemptView[] }> {
      if (state.getRequestThrows) throw new Error("PM is having a moment");
      const m = state.group.members.find((x) => x.id === id);
      if (!m) throw new Error("not found");
      // The bound is derived from attempt rows; `priorAttempts` lets a test
      // pretend this group has already been round the loop several times.
      const attempts =
        state.priorAttempts !== undefined
          ? (Array.from({ length: state.priorAttempts }, (_, i) => ({
              id: `hist-${i}`,
            })) as MergeAttemptView[])
          : state.attempts.filter((a) => a.requestId === id);
      return { ...m, attempts };
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
      body: { status: string; treeSha?: string; steps?: unknown[] },
    ): Promise<MergeAttemptView> {
      const att = state.attempts.find((a) => a.id === attemptId);
      if (!att) throw new Error(`no attempt ${attemptId}`);
      att.status = body.status as MergeAttemptView["status"];
      att.completedAt = nowIso();
      if (body.treeSha) att.treeSha = body.treeSha;
      state.calls.push(`completeAttempt:${body.status}`);
      state.attemptCompletions.push({
        attemptId,
        status: body.status,
        treeSha: body.treeSha,
        steps: body.steps,
      });
      return att;
    },
    // ── group-land family ──
    async landGroup(
      _groupId: string,
      body: {
        members: { requestId: string; landedSha: string; role: string }[];
      },
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
    async markInnerOrphaned(requestId: string, orphanedSha: string): Promise<unknown> {
      state.calls.push("markInnerOrphaned");
      state.orphaned = { requestId, orphanedSha };
      const m = state.group.members.find((x) => x.id === requestId);
      if (m) {
        m.status = "orphaned" as MergeRequestView["status"];
        m.landedSha = orphanedSha;
      }
      return m;
    },
    async openIncident(params: {
      projectId: string;
      type: string;
      innerRepo: string;
      orphanedSha: string;
      outerRepo: string;
      groupId?: string | null;
      innerRequestId?: string | null;
      taskId?: string | null;
    }): Promise<{ incident: { id: string }; created: boolean }> {
      state.calls.push("openIncident");
      incidentSeq += 1;
      state.incident = { id: `inc-${incidentSeq}`, ...params };
      // The open is idempotent server-side: { incident, created }.
      return { incident: { id: state.incident.id }, created: true };
    },
    async markPartiallyLanded(
      _groupId: string,
      body: { reason: string; incidentId?: string },
    ): Promise<unknown> {
      state.calls.push("markPartiallyLanded");
      state.partiallyLanded = body;
      state.group.state = "partially_landed";
      return { ...state.group };
    },
    async rejectMergeRequest(
      requestId: string,
      payload: { category: string; reason: string },
    ): Promise<unknown> {
      state.calls.push("rejectMergeRequest");
      state.requestRejects.push({
        requestId,
        category: payload.category,
        reason: payload.reason,
      });
      const m = state.group.members.find((x) => x.id === requestId);
      if (m) {
        m.status = "rejected";
        m.rejectReason = payload.reason;
      }
      return m;
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

/**
 * A gitOps factory whose `push` returns a fixed PushFailure for worktrees whose
 * path contains `failOnPathSubstring` (every other op, and other worktrees,
 * delegate to the real gitOps).
 *
 * NOTE: group assembly builds BOTH the inner and outer GitOps from the INNER
 * lane's `gitOps` factory (group-integration.ts wires `gitOps: innerLane.gitOps`
 * for assembleGroup), so to induce an inner OR an outer push failure we override
 * the SAME (inner) lane factory and discriminate by the worktree path — the
 * inner pool worktree path contains "inner", the outer contains "outer".
 */
function failingPushGitOps(
  real: (p: string) => GitOps,
  reason: "non_fast_forward" | "auth" | "network" | "other",
  failOnPathSubstring: string,
): (p: string) => GitOps {
  return (p: string): GitOps => {
    const g = real(p);
    if (!p.includes(failOnPathSubstring)) return g;
    return {
      ...g,
      async push(): Promise<PushResult> {
        return { ok: false, reason, stderr: `induced ${reason}` };
      },
    };
  };
}

// ─── Fixture ──────────────────────────────────────────────────────────

describe.skipIf(!GIT_AVAILABLE)("landAssembledGroup (real two-repo)", () => {
  let tmpRoot: string;
  let innerBare: string;
  let outerBare: string;
  let innerMainSha: string;
  let innerFeatureSha: string;
  let outerFeatureSha: string;
  let innerPool: WorktreePool;
  let outerPool: WorktreePool;
  let innerBindGit: SimpleGit;
  let outerBindGit: SimpleGit;
  const logger = createLogger("error");

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-grpland-"));
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

    innerPool = createWorktreePool({
      worktreeRoot,
      worktreeName: "inner",
      gitRepoUrl: innerBare,
      gitRemote: GIT_REMOTE,
      gitMainBranch: GIT_MAIN,
      parallelism: 1,
      cleanKeep: [],
    });
    outerPool = createWorktreePool({
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

  // Read the inner SHA the outer BARE main's tree gitlink references.
  async function readSubmoduleGitlinkOnBareMain(): Promise<string> {
    const out = await simpleGit(outerBare).raw(["ls-tree", GIT_MAIN, GITLINK_PATH]);
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === "160000" && parts[2]) return parts[2];
    }
    throw new Error("no gitlink on outer bare main");
  }

  async function bareMainSha(bare: string): Promise<string> {
    return (await simpleGit(bare).revparse([GIT_MAIN])).trim();
  }

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
    over: {
      inner?: Partial<MergeRequestView>;
      outer?: Partial<MergeRequestView>;
    } = {},
  ): FakePm {
    const inner = makeMember({
      id: "req-inner",
      commitSha: innerFeatureSha,
      verifyCmd: "echo inner-ok",
      taskId: "task-inner",
      ...over.inner,
    });
    const outer = makeMember({
      id: "req-outer",
      commitSha: outerFeatureSha,
      verifyCmd: "echo outer-ok",
      ...over.outer,
    });
    return {
      group: { state: "forming", members: [inner, outer] },
      attempts: [],
      calls: [],
      requestRejects: [],
      attemptCompletions: [],
    };
  }

  function depsFor(state: FakePm, over?: Partial<GroupIntegrationDeps>): GroupIntegrationDeps {
    return {
      pmClient: makeFakePm(state),
      logger,
      innerLane: innerLane(),
      outerLane: outerLane(),
      gitRemote: GIT_REMOTE,
      defaultVerifyCommand: "echo verify-ok",
      verifyTimeoutSec: 30,
      ...over,
    };
  }

  // Drain + reacquire proves the worktrees were released exactly once.
  function assertPoolsReacquirable(): void {
    const i = innerPool.acquire();
    const o = outerPool.acquire();
    expect(i).not.toBeNull();
    expect(o).not.toBeNull();
    if (i) innerPool.release(i);
    if (o) outerPool.release(o);
  }

  // ── (a) clean land ──
  it("clean land: both bare mains advance, gitlink @ Ri, landGroup both roles, attempts passed-before-landGroup, worktrees released", async () => {
    const state = makeGroupState();
    const deps = depsFor(state);
    const integ = await runGroupIntegration(
      { id: "grp-land-a", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error("not ready");

    const result = await landAssembledGroup(
      {
        groupId: "grp-land-a",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );

    expect(result.kind).toBe("landed");
    if (result.kind !== "landed") throw new Error("not landed");
    expect(result.innerLandedSha).toBe(integ.Ri);
    expect(result.outerLandedSha).toBe(integ.Ro);

    // R1 + clean land: BOTH bare mains advanced.
    expect(await bareMainSha(innerBare)).toBe(integ.Ri);
    expect(await bareMainSha(outerBare)).toBe(integ.Ro);
    // The outer bare main's gitlink references Ri.
    expect(await readSubmoduleGitlinkOnBareMain()).toBe(integ.Ri);

    // landGroup called with BOTH members + roles.
    expect(state.landGroupBody?.members).toEqual([
      { requestId: "req-inner", landedSha: integ.Ri, role: "inner" },
      { requestId: "req-outer", landedSha: integ.Ro, role: "outer" },
    ]);

    // BOTH attempts completed passed WITH treeSha, BEFORE landGroup (CONSTRAINT C).
    const landIdx = state.calls.indexOf("landGroup");
    const innerPass = state.attemptCompletions.find((c) => c.attemptId === integ.innerAttemptId);
    const outerPass = state.attemptCompletions.find((c) => c.attemptId === integ.outerAttemptId);
    expect(innerPass).toMatchObject({
      attemptId: integ.innerAttemptId,
      status: "passed",
      treeSha: integ.Ri,
    });
    expect(outerPass).toMatchObject({
      attemptId: integ.outerAttemptId,
      status: "passed",
      treeSha: integ.Ro,
    });
    // Phase 7.5 FOLDED-FIX M1: the grouped passing-land carries each repo's
    // per-step results (threaded from ready_to_land — pipeI/pipeO are out of
    // scope in group-land). The synthetic single-step pipeline → a 1-element array.
    expect((innerPass!.steps as { stepId: string }[]).map((s) => s.stepId)).toEqual(["verify"]);
    expect((outerPass!.steps as { stepId: string }[]).map((s) => s.stepId)).toEqual(["verify"]);
    // Both completeAttempt:passed precede landGroup in the call log.
    const passedIndices = state.calls
      .map((c, i) => (c === "completeAttempt:passed" ? i : -1))
      .filter((i) => i >= 0);
    expect(passedIndices.length).toBe(2);
    for (const pi of passedIndices) expect(pi).toBeLessThan(landIdx);

    // No orphan / incident on the clean path.
    expect(state.calls).not.toContain("openIncident");
    expect(state.calls).not.toContain("markInnerOrphaned");
    expect(state.group.state).toBe("landed");

    // Worktrees released exactly once (pools reacquirable).
    assertPoolsReacquirable();
  }, 30_000);

  // ── (b) inner push fails ──
  it("inner push fails: inner bare main NOT advanced, outer untouched, group rejected, NO incident, worktrees released", async () => {
    const innerBefore = await bareMainSha(innerBare);
    const outerBefore = await bareMainSha(outerBare);

    const state = makeGroupState();
    const deps = depsFor(state, {
      // Assembly builds both GitOps from the INNER lane factory → fail push only
      // for the inner worktree path.
      // Campaign 2026-08-15 §R1: induced with `auth` rather than
      // `non_fast_forward`. This test's subject is ATOMICITY — inner main not
      // advanced, outer untouched, no incident — which is unchanged; but a
      // non-fast-forward push is now a lost RACE that re-queues, so inducing it
      // here would be asserting the disposition this campaign deliberately
      // changed. The race variant has its own §R1 test below.
      innerLane: innerLane({
        gitOps: failingPushGitOps((p) => createGitOps(simpleGit(p)), "auth", "inner"),
      }),
    });
    const integ = await runGroupIntegration(
      { id: "grp-land-b", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error("not ready");

    const result = await landAssembledGroup(
      {
        groupId: "grp-land-b",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );

    expect(result.kind).toBe("rejected");

    // Inner bare main NOT advanced (push was induced to fail); outer unchanged.
    expect(await bareMainSha(innerBare)).toBe(innerBefore);
    expect(await bareMainSha(outerBare)).toBe(outerBefore);

    // Inner attempt failed; outer attempt cancelled; group rejected.
    const innerComp = state.attemptCompletions.find((c) => c.attemptId === integ.innerAttemptId);
    const outerComp = state.attemptCompletions.find((c) => c.attemptId === integ.outerAttemptId);
    expect(innerComp?.status).toBe("failed");
    expect(outerComp?.status).toBe("cancelled");
    expect(state.calls).toContain("rejectGroup");

    // NO incident / orphan.
    expect(state.calls).not.toContain("openIncident");
    expect(state.calls).not.toContain("markInnerOrphaned");
    expect(state.calls).not.toContain("landGroup");

    assertPoolsReacquirable();
  }, 30_000);

  // ── (c) outer push fails AFTER inner landed — THE ORPHAN ──
  it("outer push fails after inner landed → ORPHAN: inner bare main advanced, outer NOT advanced, EXACT §6.5 order + incident, worktrees released", async () => {
    const outerBefore = await bareMainSha(outerBare);

    const state = makeGroupState();
    const deps = depsFor(state, {
      // Assembly builds both GitOps from the INNER lane factory. Inner pushes
      // for REAL; ONLY the outer worktree's push is induced to fail (discriminate
      // by path "outer") — so inner main advances and outer push fails after.
      innerLane: innerLane({
        gitOps: failingPushGitOps((p) => createGitOps(simpleGit(p)), "non_fast_forward", "outer"),
      }),
    });
    const integ = await runGroupIntegration(
      { id: "grp-land-c", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error("not ready");

    const result = await landAssembledGroup(
      {
        groupId: "grp-land-c",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );

    expect(result.kind).toBe("orphaned");
    if (result.kind !== "orphaned") throw new Error("not orphaned");
    expect(result.orphanedSha).toBe(integ.Ri);
    expect(result.incidentId).toBe("inc-1");

    // R1: inner bare main DID advance to Ri; outer bare main NOT advanced
    // (half-landed-gitlink structurally avoided).
    expect(await bareMainSha(innerBare)).toBe(integ.Ri);
    expect(await bareMainSha(outerBare)).toBe(outerBefore);

    // The EXACT §6.5 call order (a→f).
    const order = [
      "completeAttempt:passed", // a — inner passed @Ri
      "markInnerOrphaned", // b
      "openIncident", // c
      "completeAttempt:failed", // d — outer failed
      "rejectMergeRequest", // e — PLAIN per-request reject of the outer member
      "markPartiallyLanded", // f
    ];
    // Filter the call log to just these tokens and assert the relative order.
    const seen = state.calls.filter((c) => order.includes(c));
    expect(seen).toEqual(order);

    // a — inner attempt passed WITH treeSha Ri.
    const innerComp = state.attemptCompletions.find((c) => c.attemptId === integ.innerAttemptId);
    expect(innerComp).toMatchObject({
      attemptId: integ.innerAttemptId,
      status: "passed",
      treeSha: integ.Ri,
    });
    // Phase 7.5 FOLDED-FIX M1: even on the orphan path the inner-passed attempt
    // carries the inner repo's per-step results (it passed verify).
    expect((innerComp!.steps as { stepId: string }[]).map((s) => s.stepId)).toEqual(["verify"]);
    // b — orphaned the INNER request @Ri.
    expect(state.orphaned).toEqual({
      requestId: "req-inner",
      orphanedSha: integ.Ri,
    });
    // c — incident params (orphaned_inner, Ri, inner/outer repos, group, req, task).
    expect(state.incident).toMatchObject({
      type: "orphaned_inner",
      orphanedSha: integ.Ri,
      innerRepo: "rynx-inner",
      outerRepo: "app-outer",
      groupId: "grp-land-c",
      innerRequestId: "req-inner",
      taskId: "task-inner",
    });
    // d — outer attempt failed.
    const outerComp = state.attemptCompletions.find((c) => c.attemptId === integ.outerAttemptId);
    expect(outerComp?.status).toBe("failed");
    // e — the PLAIN per-request reject targeted the OUTER member (not 409).
    expect(state.requestRejects).toHaveLength(1);
    expect(state.requestRejects[0].requestId).toBe("req-outer");
    // f — partially_landed cross-links the incident.
    expect(state.partiallyLanded?.incidentId).toBe("inc-1");
    expect(state.group.state).toBe("partially_landed");

    // NOT a clean land.
    expect(state.calls).not.toContain("landGroup");
    expect(state.calls).not.toContain("rejectGroup");

    assertPoolsReacquirable();
  }, 30_000);

  // ── (d) drift precondition ──
  it("drift: live inner main moved between assembly and land → NEITHER push attempted, group RE-QUEUED (not rejected), NO incident, worktrees released", async () => {
    const state = makeGroupState();
    // Wrap the inner lane's gitOps so resolveRef of remote main returns a SHA
    // that differs from baseInnerSha (Mi) — simulating drift after assembly.
    // Every other op (fetch / push / etc.) delegates to the real gitOps; push
    // must NEVER be reached, which the bare-main assertions confirm.
    const innerBefore = await bareMainSha(innerBare);
    const outerBefore = await bareMainSha(outerBare);

    const driftGitOps = (p: string): GitOps => {
      const g = createGitOps(simpleGit(p));
      return {
        ...g,
        async resolveRef(ref: string): Promise<string> {
          const real = await g.resolveRef(ref);
          // Only perturb the live-main lookup; HEAD etc. stay truthful.
          if (ref === `${GIT_REMOTE}/${GIT_MAIN}`) return "f".repeat(40);
          return real;
        },
        async push(): Promise<PushResult> {
          throw new Error("push must not be reached on drift");
        },
      };
    };
    const deps = depsFor(state, {
      innerLane: innerLane({ gitOps: driftGitOps }),
    });
    const integ = await runGroupIntegration(
      { id: "grp-land-d", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error("not ready");

    const result = await landAssembledGroup(
      {
        groupId: "grp-land-d",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );

    // Campaign 2026-08-15 §R1: this used to REJECT — while writing the reason
    // "re-verify next pass". Main moving under an assembled group says nothing
    // about the change, and the single-repo lane has always re-queued the
    // identical event silently. THE assertion of this campaign.
    expect(result.kind).toBe("requeued");
    if (result.kind === "requeued") {
      expect(result.reason).toMatch(/drift/i);
    }

    // NEITHER bare main advanced (no push attempted).
    expect(await bareMainSha(innerBare)).toBe(innerBefore);
    expect(await bareMainSha(outerBare)).toBe(outerBefore);

    // Both attempts cancelled (neither produced a verdict); the group went back
    // to forming rather than being terminated; NO incident.
    const innerComp = state.attemptCompletions.find((c) => c.attemptId === integ.innerAttemptId);
    const outerComp = state.attemptCompletions.find((c) => c.attemptId === integ.outerAttemptId);
    expect(innerComp?.status).toBe("cancelled");
    expect(outerComp?.status).toBe("cancelled");
    expect(state.calls).toContain("resetGroup");
    // Nobody is told anything, because there is nothing for an author to do.
    expect(state.calls).not.toContain("rejectGroup");
    expect(state.group.state).toBe("forming");
    expect(state.calls).not.toContain("openIncident");
    expect(state.calls).not.toContain("landGroup");

    assertPoolsReacquirable();
  }, 30_000);

  // ── Campaign 2026-08-15 §R1: the bound, and the push race ──────────

  it("§R1: drift stops being retried once the group has burned its attempts", async () => {
    const state = makeGroupState();
    // Pretend this group has already been round the loop the maximum number of
    // times. The bound is what makes a re-queue safe: without it a group that
    // can never land cycles forever and tells nobody.
    state.priorAttempts = 4;

    const driftGitOps = (p: string): GitOps => {
      const g = createGitOps(simpleGit(p));
      return {
        ...g,
        async resolveRef(ref: string): Promise<string> {
          if (ref === `${GIT_REMOTE}/${GIT_MAIN}`) return "f".repeat(40);
          return g.resolveRef(ref);
        },
        async push(): Promise<PushResult> {
          throw new Error("push must not be reached on drift");
        },
      };
    };
    const deps = depsFor(state, { innerLane: innerLane({ gitOps: driftGitOps }) });
    const integ = await runGroupIntegration(
      { id: "grp-land-r1-bound", members: state.group.members },
      deps,
    );
    if (integ.kind !== "ready_to_land") throw new Error("not ready");

    const result = await landAssembledGroup(
      {
        groupId: "grp-land-r1-bound",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );

    expect(result.kind).toBe("rejected");
    expect(state.calls).toContain("rejectGroup");
    expect(state.calls).not.toContain("resetGroup");
    // And the rejection names the LANE, not the change — the author has not
    // done anything wrong and must not be sent looking for a bug.
    expect(state.rejectPayload?.reason).toMatch(/lane is landing changes faster/i);
    assertPoolsReacquirable();
  }, 30_000);

  it("§R1: an unreadable attempt count still re-queues rather than bouncing", async () => {
    const state = makeGroupState();
    state.getRequestThrows = true;

    const driftGitOps = (p: string): GitOps => {
      const g = createGitOps(simpleGit(p));
      return {
        ...g,
        async resolveRef(ref: string): Promise<string> {
          if (ref === `${GIT_REMOTE}/${GIT_MAIN}`) return "f".repeat(40);
          return g.resolveRef(ref);
        },
        async push(): Promise<PushResult> {
          throw new Error("push must not be reached on drift");
        },
      };
    };
    const deps = depsFor(state, { innerLane: innerLane({ gitOps: driftGitOps }) });
    const integ = await runGroupIntegration(
      { id: "grp-land-r1-openread", members: state.group.members },
      deps,
    );
    if (integ.kind !== "ready_to_land") throw new Error("not ready");

    const result = await landAssembledGroup(
      {
        groupId: "grp-land-r1-openread",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );

    // A transient PM read failure must not reintroduce the bounce this campaign
    // exists to remove. A persistently unlandable group gets a readable count on
    // some later pass and is stopped then.
    expect(result.kind).toBe("requeued");
    expect(state.calls).toContain("resetGroup");
    assertPoolsReacquirable();
  }, 30_000);

  it("§R1: an inner push that loses a race re-queues; other push failures still reject", async () => {
    // (a) non_fast_forward — a lost race, not a verdict.
    const race = makeGroupState();
    const raceDeps = depsFor(race, {
      innerLane: innerLane({
        gitOps: failingPushGitOps((p) => createGitOps(simpleGit(p)), "non_fast_forward", "inner"),
      }),
    });
    const raceInteg = await runGroupIntegration(
      { id: "grp-land-r1-race", members: race.group.members },
      raceDeps,
    );
    if (raceInteg.kind !== "ready_to_land") throw new Error("not ready");
    const raceResult = await landAssembledGroup(
      {
        groupId: "grp-land-r1-race",
        projectId: "proj-1",
        ready: raceInteg,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: raceDeps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );
    expect(raceResult.kind).toBe("requeued");
    expect(race.calls).toContain("resetGroup");
    expect(race.calls).not.toContain("rejectGroup");
    // The attempt is CANCELLED, not failed: recording a `conflict` failure would
    // put a defect on the author's history for a race they did not run.
    const innerComp = race.attemptCompletions.find((c) => c.attemptId === raceInteg.innerAttemptId);
    expect(innerComp?.status).toBe("cancelled");
    assertPoolsReacquirable();

    // (b) auth — retrying this spins a lane against a wall forever, so it must
    // still reject. This is the arm that keeps the re-queue honest.
    const auth = makeGroupState();
    const authDeps = depsFor(auth, {
      innerLane: innerLane({
        gitOps: failingPushGitOps((p) => createGitOps(simpleGit(p)), "auth", "inner"),
      }),
    });
    const authInteg = await runGroupIntegration(
      { id: "grp-land-r1-auth", members: auth.group.members },
      authDeps,
    );
    if (authInteg.kind !== "ready_to_land") throw new Error("not ready");
    const authResult = await landAssembledGroup(
      {
        groupId: "grp-land-r1-auth",
        projectId: "proj-1",
        ready: authInteg,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: authDeps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );
    expect(authResult.kind).toBe("rejected");
    expect(auth.calls).toContain("rejectGroup");
    expect(auth.calls).not.toContain("resetGroup");
    assertPoolsReacquirable();
  }, 60_000);

  // ── Campaign 2026-08-03 §P2 ────────────────────────────────────────
  it("P2: an ORPHANED land is legible in two rows — inner:push ok, outer:push not", async () => {
    const state = makeGroupState();
    const deps = depsFor(state, {
      innerLane: innerLane({
        gitOps: failingPushGitOps((p) => createGitOps(simpleGit(p)), "non_fast_forward", "outer"),
      }),
    });
    const integ = await runGroupIntegration(
      { id: "grp-p2-orphan", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error("not ready");

    const probe = makePhaseProbe();
    const result = await landAssembledGroup(
      {
        groupId: "grp-p2-orphan",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      {
        pmClient: deps.pmClient,
        logger,
        gitRemote: GIT_REMOTE,
        gitMainBranch: GIT_MAIN,
        phases: probe.recorder.scope({ groupId: "grp-p2-orphan" }),
      },
    );
    expect(result.kind).toBe("orphaned");

    const rows = probe.rows();
    const by = (label: string) => rows.find((r) => r.label === label)!;
    expect(probe.labels()).toEqual([
      "land/inner:fetch",
      "land/inner:push",
      "land/outer:fetch",
      "land/outer:push",
    ]);
    // THE incident, in two rows: the inner really landed, the outer really did
    // not, and the reason is named rather than left to a log grep.
    expect(by("inner:push").detail).toMatchObject({ ok: true, reason: null });
    expect(by("outer:push").detail).toMatchObject({ ok: false, reason: "non_fast_forward" });
    // Each row names its own member + attempt, so the trace is per-request.
    expect(by("inner:push").requestId).toBe("req-inner");
    expect(by("inner:push").attemptId).toBe(integ.innerAttemptId);
    expect(by("outer:push").requestId).toBe("req-outer");
    expect(by("outer:push").attemptId).toBe(integ.outerAttemptId);

    assertPoolsReacquirable();
  }, 30_000);

  it("P2: a THROWING phase ingest leaves the land outcome and the release accounting identical", async () => {
    const state = makeGroupState();
    const deps = depsFor(state);
    const integ = await runGroupIntegration(
      { id: "grp-p2-throw", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error("not ready");

    const probe = makePhaseProbe("throw");
    const result = await landAssembledGroup(
      {
        groupId: "grp-p2-throw",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      {
        pmClient: deps.pmClient,
        logger,
        gitRemote: GIT_REMOTE,
        gitMainBranch: GIT_MAIN,
        phases: probe.recorder,
      },
    );
    // A synchronously-throwing ingest is the nastiest case (a bare .catch would
    // miss it) — and it changes nothing: both mains advanced, the group landed,
    // CONSTRAINT D released the worktrees exactly once.
    expect(result.kind).toBe("landed");
    expect(await bareMainSha(innerBare)).toBe(integ.Ri);
    expect(await bareMainSha(outerBare)).toBe(integ.Ro);
    expect(state.calls).toContain("landGroup");
    assertPoolsReacquirable();
  }, 30_000);
});
