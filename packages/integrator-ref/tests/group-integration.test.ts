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
import { makePhaseProbe } from "./phase-probe.js";
import {
  runGroupIntegration,
  type GroupIntegrationDeps,
  type RepoLane,
} from "../src/group-integration.js";
import {
  assemblyResolutionEligibility,
  type GroupAssemblyReason,
} from "../src/resolution-eligibility.js";

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
async function resolveVerified(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    return (await git.revparse(["--verify", `${ref}^{commit}`])).trim();
  } catch {
    return null;
  }
}

// win32-safe ~300ms sleep for the overlap test (NEVER bare `sleep 0.3`).
const SLEEP_300 = process.platform === "win32" ? "ping -n 2 127.0.0.1 > nul" : "sleep 0.3";

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
  /** Campaign 2026-08-15 §S1: every cancellation-poll read the watcher issued. */
  getRequestCalls?: string[];
  /** §S1: make every status read fail, to exercise the fail-open branch. */
  getRequestThrows?: boolean;
  /** Phase 7.5 Step 7: captured completeAttempt bodies (steps[] M1 assertion). */
  completeBodies?: { status: string; steps?: unknown[] }[];
  /** P3 legibility: captured merge_rejection task comments (choke-point assertion). */
  taskComments?: {
    taskId: string;
    body: string;
    commentType?: string;
    metadata?: Record<string, unknown> | null;
  }[];
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
    // Campaign 2026-08-15 §S1: the group kill seam's cancellation read.
    // Deliberately NOT pushed onto `state.calls` — a liveness poll is not a
    // merge operation, and the exact call-sequence assertions in this file
    // would break if it appeared there.
    async getMergeRequest(id: string): Promise<MergeRequestView & { attempts: [] }> {
      state.getRequestCalls?.push(id);
      if (state.getRequestThrows) throw new Error("PM is having a moment");
      const m = state.group.members.find((x) => x.id === id);
      if (!m) throw new Error("not found");
      return { ...m, attempts: [] };
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
    async postTaskComment(
      taskId: string,
      body: {
        body: string;
        commentType?: string;
        metadata?: Record<string, unknown> | null;
      },
    ): Promise<void> {
      state.calls.push("postTaskComment");
      (state.taskComments ??= []).push({
        taskId,
        body: body.body,
        commentType: body.commentType,
        metadata: body.metadata,
      });
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

  function depsFor(state: FakePm, over?: Partial<GroupIntegrationDeps>): GroupIntegrationDeps {
    return {
      pmClient: makeFakePm(state),
      logger,
      innerLane: innerLane(),
      outerLane: outerLane(),
      gitRemote: "origin",
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
    const outcome = await runGroupIntegration({ id: "grp-1", members: state.group.members }, deps);

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

  // ─── Campaign 2026-08-15 §R5: the group reject reaches the resolver ──
  //
  // Until this campaign `maybeOpenResolution` had two call sites, both in the
  // SINGLE-REPO conflict branch, and the group path had none — so a cross-repo
  // lane could not spin a resolver no matter how mechanical the failure.

  /** An inner lane whose rebase always conflicts, with named files. */
  function conflictingInnerLane(files: string[]): RepoLane {
    return innerLane({
      gitOps: (p: string): GitOps => {
        const g = createGitOps(simpleGit(p));
        return {
          ...g,
          async rebaseOnto() {
            return { ok: false as const, conflictingFiles: files, stderr: "CONFLICT (content)" };
          },
        };
      },
    });
  }

  it("§R5: an inner_conflict opens a resolution carrying everything needed to replay it", async () => {
    const state = makeGroupState();
    const opened: Record<string, unknown>[] = [];
    const deps = depsFor(state, {
      innerLane: conflictingInnerLane(["src/engine/audio.rs"]),
      resolver: {
        enabled: true,
        openAndEnqueue: async (args) => {
          opened.push({ ...args });
          return "res-1";
        },
      },
    });

    const outcome = await runGroupIntegration(
      { id: "grp-r5-inner", members: state.group.members },
      deps,
    );

    expect(outcome.kind).toBe("rejected");
    expect(opened).toHaveLength(1);
    const job = opened[0];
    // The origin is the INNER member — the repo the conflict actually lives in.
    expect(job.originRequestId).toBe("req-inner");
    expect(job.repoRole).toBe("inner");
    // A group job must come back as a GROUP; resubmitting a resolved inner
    // change alone would land it without the outer gitlink bump.
    expect(job.groupId).toBe("grp-r5-inner");
    // The replay inputs. Without a base and a ref, materializeConflict has
    // nothing to reproduce and the resolution is a dead end.
    expect(job.conflictingFiles).toEqual(["src/engine/audio.rs"]);
    expect(job.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(job.ref).toBeTruthy();
  }, 30_000);

  it("§R5: an unpushed gitlink target is rejected and never handed to a resolver", async () => {
    // The eligibility taxonomy's sharpest refusal, now proven end-to-end: the
    // inner commit was never pushed, so no agent can materialize its objects.
    const state = makeGroupState();
    const opened: unknown[] = [];
    const deps = depsFor(state, {
      innerLane: innerLane({
        gitOps: (p: string): GitOps => {
          const g = createGitOps(simpleGit(p));
          return {
            ...g,
            async rebaseOnto() {
              // Not a conflict — the assembly fails a different way, so no
              // `conflict` payload exists and the capability gate must hold
              // even though the reason may be rated eligible.
              throw new Error("simulated assembly failure");
            },
          };
        },
      }),
      resolver: {
        enabled: true,
        openAndEnqueue: async () => {
          opened.push(1);
          return "res-x";
        },
      },
    });

    const outcome = await runGroupIntegration(
      { id: "grp-r5-nores", members: state.group.members },
      deps,
    );

    expect(outcome.kind).toBe("rejected");
    // No replay inputs ⇒ no resolution, however the reason is rated. A
    // resolution nothing can execute would sit in `pending` forever.
    expect(opened).toHaveLength(0);
  }, 30_000);

  it("§R5: a member that is itself a resolution product does not loop the resolver", async () => {
    const state = makeGroupState({ inner: { resolvedFrom: "req-original" } });
    const opened: unknown[] = [];
    const deps = depsFor(state, {
      innerLane: conflictingInnerLane(["a.rs"]),
      resolver: {
        enabled: true,
        openAndEnqueue: async () => {
          opened.push(1);
          return "res-y";
        },
      },
    });

    await runGroupIntegration({ id: "grp-r5-recur", members: state.group.members }, deps);

    // The no-recursion guard has to live HERE for group jobs: the group
    // resubmit takes member specs and has no resolvedFrom field to carry, so a
    // resolved group member cannot mark itself downstream.
    expect(opened).toHaveLength(0);
  }, 30_000);

  // ─── Campaign 2026-08-15 §S1: the group verify kill seam ─────────
  //
  // Until this campaign both `runPipeline` calls took `signal: undefined`, so
  // neither 2026-08-04 trigger could reach a grouped merge — and game_one is a
  // cross-repo lane, so that was most of its traffic.

  // ~20s of silence. Deliberately much longer than this fixture's real-git
  // assembly (rebase + materialize + gitlink commit, several seconds), so
  // "elapsed" cleanly separates a killed verify from a completed one: killed
  // ≈ assembly only, not-killed ≈ assembly + 20s.
  const S1_QUIET = process.platform === "win32" ? "ping -n 21 127.0.0.1 > nul" : "sleep 20";
  const S1_SHORT = process.platform === "win32" ? "ping -n 3 127.0.0.1 > nul" : "sleep 2";

  it("§S1: polls while integrating and lands normally — and never kills during assembly", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: S1_SHORT },
      outer: { verifyCmd: S1_SHORT },
    });
    state.getRequestCalls = [];
    const deps = depsFor(state, { verifyCancelPollMs: 50 });
    const outcome = await runGroupIntegration(
      { id: "grp-s1-live", members: state.group.members },
      deps,
    );

    // THE assembly trap: members are `queued` until markGroupIntegrating, and
    // `isTerminalForUs` counts `queued` as terminal (right after pickup, wrong
    // before it). The watcher is started only around the verify await, so a
    // group survives its own assembly. Move it earlier and this test dies.
    expect(outcome.kind).toBe("ready_to_land");
    if (outcome.kind !== "ready_to_land") throw new Error("not ready_to_land");
    // It really did poll — the pass above is not vacuous.
    expect((state.getRequestCalls ?? []).length).toBeGreaterThan(0);
    expect(state.calls).not.toContain("rejectGroup");

    outcome.assembled.release();
  }, 30_000);

  it("§S1: a member going terminal mid-verify kills BOTH repos and rejects the group", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: S1_QUIET },
      outer: { verifyCmd: S1_QUIET },
    });
    state.getRequestCalls = [];
    state.completeBodies = [];
    const deps = depsFor(state, { verifyCancelPollMs: 50 });

    // The worker walks away mid-build. Triggered off the FIRST poll rather than
    // a wall-clock timer: the watcher only polls once the verify is running, so
    // this lands the cancellation inside the window by construction. A timer
    // would race real-git assembly, and `markGroupIntegrating` resets every
    // member to `integrating` — so a flip that fires too early is silently
    // undone and the test passes for the wrong reason.
    const realGet = deps.pmClient.getMergeRequest.bind(deps.pmClient);
    let flipped = false;
    (deps.pmClient as { getMergeRequest: unknown }).getMergeRequest = async (id: string) => {
      if (!flipped) {
        flipped = true;
        state.group.members[0].status = "abandoned";
      }
      return realGet(id);
    };

    const startedAt = Date.now();
    const outcome = await runGroupIntegration(
      { id: "grp-s1-cancel", members: state.group.members },
      deps,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(outcome.kind).toBe("rejected");
    // A group is an atom: both repos died, so we did not sit through the
    // remaining ~7s of either build.
    expect(elapsedMs).toBeLessThan(15_000);
    // Neither attempt produced a verdict, because we took it away from them.
    const statuses = (state.completeBodies ?? []).map((b) => b.status);
    expect(statuses.filter((s) => s === "cancelled")).toHaveLength(2);
    // The sibling is owed the news that its group died — and the reason says
    // "cancelled", not "your code failed".
    expect(state.calls).toContain("rejectGroup");
    expect(state.rejectPayload?.reason).toMatch(/cancelled/i);
    expect(state.rejectPayload?.category).toBe("other");
  }, 30_000);

  it("§S1: a silent group verify is killed and rejected as verify_stall", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: S1_QUIET },
      outer: { verifyCmd: S1_QUIET },
    });
    state.completeBodies = [];
    const deps = depsFor(state, { verifyStallMs: 1500, verifyCancelPollMs: 0 });

    const startedAt = Date.now();
    const outcome = await runGroupIntegration(
      { id: "grp-s1-stall", members: state.group.members },
      deps,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(outcome.kind).toBe("rejected");
    expect(elapsedMs).toBeLessThan(15_000);
    // The stall arm works with the cancellation poll OFF, and reports the
    // threshold rather than masquerading as the timeout it pre-empts.
    expect(state.rejectPayload?.category).toBe("verify_stall");
    expect(state.rejectPayload?.reason).toMatch(/no output for \d+s/);
    expect(state.rejectPayload?.reason).toMatch(/verify_stall_sec=2s/);
  }, 30_000);

  it("§S1: fails OPEN — a throwing status read never kills a healthy group", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: S1_SHORT },
      outer: { verifyCmd: S1_SHORT },
    });
    state.getRequestCalls = [];
    state.getRequestThrows = true;
    const deps = depsFor(state, { verifyCancelPollMs: 50 });
    const outcome = await runGroupIntegration(
      { id: "grp-s1-open", members: state.group.members },
      deps,
    );

    // Every read failed, and the group still landed.
    expect((state.getRequestCalls ?? []).length).toBeGreaterThan(0);
    expect(outcome.kind).toBe("ready_to_land");
    if (outcome.kind !== "ready_to_land") throw new Error("not ready_to_land");
    outcome.assembled.release();
  }, 30_000);

  // ── Phase 7.5 Step 6 (§6): per-repo cache keys on DISTINCT content-addressed
  //    TREE shas (CLARIFICATION A: derived from Ri/Ro via `^{tree}`), AND-combine
  //    preserved. Both repos MISS (the fake returns null) → both verifies run. ──
  it("two pinned linked-repo specs prefer exact commit SHAs over branch names", async () => {
    const innerBranch = "codex/piano-meadow-freeplay-v1-rynx";
    const outerBranch = "codex/piano-meadow-freeplay-v1";
    const state = makeGroupState({
      inner: { branch: innerBranch, verifyCmd: null },
      outer: { branch: outerBranch, verifyCmd: null },
    });
    const seenInnerRefs: string[] = [];
    const exactInnerLane = innerLane({
      gitOps: (poolPath) => {
        const real = createGitOps(simpleGit(poolPath));
        return {
          ...real,
          async rebaseOnto(base, ref) {
            seenInnerRefs.push(ref);
            return real.rebaseOnto(base, ref);
          },
        };
      },
    });

    const outcome = await runGroupIntegration(
      { id: "grp-pinned-two-specs", members: state.group.members },
      depsFor(state, { innerLane: exactInnerLane }),
    );

    expect(outcome.kind).toBe("ready_to_land");
    if (outcome.kind !== "ready_to_land") {
      throw new Error(`expected ready_to_land, got ${outcome.kind}`);
    }
    outcome.assembled.release();
    expect(seenInnerRefs).toEqual([innerFeatureSha, outerFeatureSha]);
    expect(seenInnerRefs).not.toContain(innerBranch);
    expect(seenInnerRefs).not.toContain(outerBranch);
    expect(outcome.Ri).toMatch(/^[0-9a-f]{40}$/);
    expect(outcome.Ro).toMatch(/^[0-9a-f]{40}$/);
  }, 30_000);

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
    const outcome = await runGroupIntegration({ id: "grp-2", members: state.group.members }, deps);

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
    expect((failedBody!.steps as { stepId: string }[]).map((s) => s.stepId)).toEqual(["verify"]);

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
    const outcome = await runGroupIntegration({ id: "grp-3", members: state.group.members }, deps);

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
    const outcome = await runGroupIntegration({ id: "grp-4", members: state.group.members }, deps);

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
    const outcome = await runGroupIntegration({ id: "grp-5a", members: state.group.members }, deps);
    expect(outcome.kind).toBe("ready_to_land");
    if (outcome.kind !== "ready_to_land") throw new Error("not ready");

    // The bound inner/outer members are correct DESPITE the swapped order.
    expect(outcome.innerMember.id).toBe("req-inner");
    expect(outcome.outerMember.id).toBe("req-outer");

    // The committed outer gitlink points at the INNER member's Ri (not outer).
    const readBack = await outcome.assembled.outerGitOps.readSubmoduleGitlink(GITLINK_PATH);
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
    const outcome = await runGroupIntegration({ id: "grp-5b", members: state.group.members }, deps);
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
  it("FIX 1: a member ref resolving in NEITHER repo → rejected (no guess), P3 posts a merge_rejection comment", async () => {
    // P3: give the (would-be) inner member a taskId so the binding-failure
    // choke-point targets it (a null-taskId member is skipped).
    const inner = makeMember({ id: "req-inner", commitSha: innerFeatureSha, taskId: "task-inner" });
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
    const outcome = await runGroupIntegration({ id: "grp-5c", members: state.group.members }, deps);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toMatch(/could not unambiguously bind/);
    }
    expect(state.calls).not.toContain("markGroupIntegrating");
    // P3 legibility: exactly ONE merge_rejection comment on the taskId-carrying
    // member (the binding-failure silent-drain fix). The null-taskId outer is skipped.
    expect(state.calls.filter((c) => c === "postTaskComment").length).toBe(1);
    expect(state.taskComments).toHaveLength(1);
    const comment = state.taskComments![0];
    expect(comment.taskId).toBe("task-inner");
    expect(comment.commentType).toBe("merge_rejection");
    expect(comment.metadata?.category).toBe("other");
    expect(comment.metadata?.groupId).toBe("grp-5c");
    expect(comment.body).toContain("could not unambiguously bind");
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
          ref === "feature/does-not-exist-in-pool" ? null : resolveVerified(outerBindGit, ref),
      }),
    });
    const outcome = await runGroupIntegration({ id: "grp-6", members: state.group.members }, deps);
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

    // Campaign 2026-08-15 §S4: the reject must tell the author what to DO, not
    // only what broke. A bare "group assembly failed (inner_conflict)" reads as
    // a train fault; the eligibility taxonomy's sentence is what makes it
    // actionable, and it is the same source of truth that decides whether a
    // resolver is worth spinning.
    // Asserted generically over WHICH reason the fixture produced (it can be
    // inner_conflict or gitlink_mismatch depending on how far assembly gets):
    // the property is that whatever failed, its guidance sentence reached the
    // author — not that this fixture fails one particular way.
    const rejectReason = state.rejectPayload?.reason ?? "";
    const code = rejectReason.match(/^group assembly failed \((\w+)\)/)?.[1];
    expect(code, rejectReason).toBeDefined();
    expect(rejectReason).toContain(assemblyResolutionEligibility(code as GroupAssemblyReason).why);
  }, 30_000);

  // ── 6b. FIX 2: post-pickup verify-fail → integrating-reject ──
  it("FIX 2: post-pickup verify-fail rejects from INTEGRATING (markGroupIntegrating first)", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: "exit 1" },
      outer: { verifyCmd: "echo ok" },
    });
    const deps = depsFor(state);
    const outcome = await runGroupIntegration({ id: "grp-6b", members: state.group.members }, deps);
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

  // ── Campaign 2026-08-03 §P2 ────────────────────────────────────────
  it("P2: the assembly's materialize rows survive a group REJECTED at verify", async () => {
    const state = makeGroupState({
      inner: { verifyCmd: "exit 1" },
      outer: { verifyCmd: "echo outer-ok" },
    });
    const probe = makePhaseProbe();
    const deps = depsFor(state, { phases: probe.recorder.scope({ groupId: "grp-p2-rej" }) });
    const outcome = await runGroupIntegration(
      { id: "grp-p2-rej", members: state.group.members },
      deps,
    );
    expect(outcome.kind).toBe("rejected");

    const labels = probe.labels();
    // The assembly cost was SPENT regardless of the verdict — binding, both
    // rebases and the whole materialize. A store that only recorded successful
    // groups would systematically under-report the expensive failures.
    expect(labels).toContain("assemble/bind");
    expect(labels).toContain("materialize/objects");
    expect(labels).toContain("materialize/gitlink");
    expect(labels).toContain("materialize/worktree");
    expect(labels).toContain("verify/inner:verify");
    expect(labels).toContain("verify/outer:verify");

    const rows = probe.rows();
    expect(rows.find((r) => r.label === "bind")!.detail).toMatchObject({ ok: true });
    // Both repos verify concurrently, so their durations OVERLAP and must never
    // be summed into an elapsed time — the row says so itself.
    const innerVerify = rows.find((r) => r.phase === "verify" && r.label === "inner:verify")!;
    expect(innerVerify.detail).toMatchObject({ role: "inner", concurrent: true, outcome: "fail" });
    expect(innerVerify.requestId).toBe("req-inner");
    for (const row of rows) expect(row.groupId).toBe("grp-p2-rej");
  }, 30_000);
});
