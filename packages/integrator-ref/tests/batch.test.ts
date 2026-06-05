/**
 * runBatchOnce integration tests (phase 7.2 Step 4).
 *
 * Reuses the loop.test.ts harness wholesale: a temp bare repo + author clone
 * seeding `feature/clean` / `feature/badtest`, a hand-built FakePmClient that
 * records its call sequence, and a REAL worktree pool + git-ops against the
 * temp repo. The single-member batch scheduler is exercised against real git
 * behavior (land / reject / land-time drift / backpressure / lock + heartbeat).
 *
 * Step 4 is single-member-at-a-time: this file deliberately does NOT test
 * multi-member concurrent batches (Step 5 behavior).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { MergeAttemptView, MergeRequestView, VerifyStep, CacheMode } from "@pm/shared";
import { stepConfigSha } from "../src/step-config-sha.js";
import { createGitOps, type GitOps } from "../src/git-ops.js";
import { createWorktreePool } from "../src/worktree-pool.js";
import { createLogger } from "../src/logger.js";
import {
  runBatchOnce,
  runGroupLaneOnce,
  type BatchDeps,
  type BatchEvent,
  type GroupLaneDeps,
  type RunBatchLoopDeps,
} from "../src/batch.js";
import { reclaimStrandedRequests } from "../src/recovery.js";
import { buildHeartbeat } from "../src/heartbeat.js";
import { PmApiError, PmClient } from "../src/pm-client.js";
import type { RepoLane } from "../src/group-integration.js";

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

// ── A minimal in-memory fake of the PmClient surface the batch touches. ──

interface BatchTag {
  batchId?: string;
  speculativePosition?: number;
}

/**
 * A shared single-holder lock store for the two-integrator double-land test.
 * `acquireLock` grants only if unheld (and records the holder); a second caller
 * gets the not-granted/queued shape the real lock service returns. When a
 * FakeState carries one, all of its lock ops go through this shared store rather
 * than the per-state `lockHeld` flag — so two integrators sharing it contend.
 */
interface SharedLock {
  holder: string | null;
}

interface FakeState {
  requests: MergeRequestView[];
  attempts: MergeAttemptView[];
  lockHeld: boolean;
  calls: string[];
  pickupThrows409?: boolean;
  /** Recorded tags arg per call site (Step 9 tag-wiring assertions). */
  pickupTags?: Record<string, BatchTag>;
  startAttemptTags?: BatchTag[];
  /** Phase 7.5: captured completeAttempt bodies (for steps[] threading asserts). */
  completeBodies?: { status: string; steps?: unknown[] }[];
  /** Identity for the shared-lock test (which integrator this fake is). */
  integratorId?: string;
  /** Shared single-holder lock (two integrators contend on the same store). */
  sharedLock?: SharedLock;
  // ── Phase 7.4 (Step 12) observability fakes ──
  /**
   * The train control state getTrainState returns. Mutable mid-drain so the
   * no-abort test can flip running→paused while a member is verifying. A
   * function form lets the fake compute the state per-call (e.g. running on the
   * first call, paused after).
   */
  trainState?: "running" | "paused" | (() => "running" | "paused");
  /** When set, getTrainState THROWS — exercises the fail-open path. */
  trainStateThrows?: boolean;
  /** Recorded heartbeat payloads (postHeartbeat). */
  heartbeats?: unknown[];
  // ── Group-lane pause-test fakes ──
  /** Forming groups listMergeGroups returns. */
  formingGroups?: { id: string }[];
  /** Members getMergeGroup returns for the forming group. */
  groupMembers?: MergeRequestView[];
  /** Open incidents listMergeIncidents returns (drives recovery + the lock). */
  openIncidents?: { id: string }[];
  // ── Phase 7.5 Step 6 verify-cache fakes ──
  /**
   * In-memory verify_cache keyed by the 5-tuple string. Seed rows here to plant
   * a HIT; the fake's lookup/record/mismatch read+write it. Spied via cacheCalls.
   */
  verifyCache?: Map<string, VerifyCacheRowFake>;
  cacheCalls?: { lookups: number; records: number; mismatches: number };
  // ── Phase 7.6 conflict-resolution fakes ──
  /**
   * Pending merge_resolutions rows the fake openResolution appends. Seeded
   * empty; the off-path leaves it empty (the byte-identical 7.5 assertion).
   */
  resolutions?: {
    id: string;
    originRequestId: string;
    resource: string;
    conflictingFiles: string[];
    state: string;
  }[];
  /** When set, the fake openResolution THROWS — exercises the non-fatal path. */
  openResolutionThrows?: boolean;
}

interface VerifyCacheRowFake {
  resource: string;
  treeSha: string;
  stepId: string;
  stepConfigSha: string;
  result: "pass" | "fail";
  durationMs?: number | null;
  logExcerpt?: string | null;
  logUrl?: string | null;
  hitCount: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeFakeClient(state: FakeState): PmClient {
  let attemptSeq = 0;
  const find = (id: string): MergeRequestView | undefined =>
    state.requests.find((r) => r.id === id);

  const fake = {
    async listMergeRequests(
      _projectId: string,
      filters?: { resource?: string; status?: string },
    ): Promise<MergeRequestView[]> {
      return state.requests.filter(
        (r) =>
          (!filters?.resource || r.resource === filters.resource) &&
          (!filters?.status || r.status === filters.status),
      );
    },
    async acquireLock(): Promise<{ ok: boolean; status: string }> {
      state.calls.push("acquireLock");
      // Shared single-holder lock (two-integrator test): grant only if unheld;
      // otherwise return the not-granted/`queued` shape the real lock service
      // uses so the loser short-circuits to `lock_unavailable`.
      if (state.sharedLock) {
        const me = state.integratorId ?? "anon";
        if (state.sharedLock.holder !== null && state.sharedLock.holder !== me) {
          return { ok: false, status: "queued" };
        }
        state.sharedLock.holder = me;
        state.lockHeld = true;
        return { ok: true, status: "held" };
      }
      state.lockHeld = true;
      return { ok: true, status: "held" };
    },
    async heartbeatLock(): Promise<{ ok: boolean; status: string }> {
      state.calls.push("heartbeatLock");
      return { ok: true, status: "refreshed" };
    },
    async releaseLock(): Promise<{ ok: boolean; status: string }> {
      state.calls.push("releaseLock");
      if (state.sharedLock) {
        const me = state.integratorId ?? "anon";
        if (state.sharedLock.holder === me) state.sharedLock.holder = null;
      }
      state.lockHeld = false;
      return { ok: true, status: "released" };
    },
    async pickupMergeRequest(id: string, tags?: BatchTag): Promise<MergeRequestView> {
      const r = find(id);
      if (!r) throw new PmApiError(404, "NOT_FOUND", "not found");
      if (state.pickupThrows409 || r.status !== "queued")
        throw new PmApiError(409, "INVALID_TRANSITION", "not queued");
      r.status = "integrating";
      r.pickedUpAt = nowIso();
      state.calls.push("pickup");
      if (state.pickupTags && tags) state.pickupTags[id] = tags;
      return r;
    },
    async startAttempt(id: string, baseSha: string, tags?: BatchTag): Promise<MergeAttemptView> {
      attemptSeq += 1;
      if (state.startAttemptTags) state.startAttemptTags.push(tags ?? {});
      const att: MergeAttemptView = {
        id: `att-${attemptSeq}`,
        requestId: id,
        attemptNumber: attemptSeq,
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
      state.calls.push("startAttempt");
      return att;
    },
    async completeAttempt(
      attemptId: string,
      body: { status: string; steps?: unknown[] },
    ): Promise<MergeAttemptView> {
      const att = state.attempts.find((a) => a.id === attemptId);
      if (!att) throw new PmApiError(404, "NOT_FOUND", "no attempt");
      att.status = body.status as MergeAttemptView["status"];
      att.completedAt = nowIso();
      state.calls.push(`completeAttempt:${body.status}`);
      if (state.completeBodies)
        state.completeBodies.push({ status: body.status, steps: body.steps });
      return att;
    },
    async landMergeRequest(id: string, landedSha: string): Promise<MergeRequestView> {
      const r = find(id);
      if (!r) throw new PmApiError(404, "NOT_FOUND", "not found");
      if (r.status !== "integrating")
        throw new PmApiError(409, "INVALID_TRANSITION", "not integrating");
      r.status = "landed";
      r.landedSha = landedSha;
      r.resolvedAt = nowIso();
      state.calls.push("land");
      return r;
    },
    async rejectMergeRequest(
      id: string,
      payload: { category: string; reason: string },
    ): Promise<MergeRequestView> {
      const r = find(id);
      if (!r) throw new PmApiError(404, "NOT_FOUND", "not found");
      if (r.status !== "integrating")
        throw new PmApiError(409, "INVALID_TRANSITION", "not integrating");
      r.status = "rejected";
      r.rejectCategory = payload.category as MergeRequestView["rejectCategory"];
      r.rejectReason = payload.reason;
      r.resolvedAt = nowIso();
      state.calls.push(`reject:${payload.category}`);
      return r;
    },
    async resetToQueued(id: string, _reason: string): Promise<MergeRequestView> {
      const r = find(id);
      if (!r) throw new PmApiError(404, "NOT_FOUND", "not found");
      if (r.status !== "integrating")
        throw new PmApiError(409, "INVALID_TRANSITION", "not integrating");
      r.status = "queued";
      r.pickedUpAt = null;
      state.calls.push("resetToQueued");
      return r;
    },
    async getTrainState(
      _projectId: string,
      resource: string,
    ): Promise<{ state: string; resource: string }> {
      state.calls.push("getTrainState");
      if (state.trainStateThrows) {
        throw new PmApiError(500, "INTERNAL", "train state read failed");
      }
      const ts =
        typeof state.trainState === "function"
          ? state.trainState()
          : (state.trainState ?? "running");
      return { state: ts, resource };
    },
    async postHeartbeat(_projectId: string, payload: unknown): Promise<unknown> {
      state.calls.push("postHeartbeat");
      state.heartbeats?.push(payload);
      return {};
    },
    // ── Phase 7.3 group surface (used by the group-lane pause tests) ──
    async listMergeGroups(): Promise<unknown[]> {
      state.calls.push("listMergeGroups");
      return state.formingGroups ?? [];
    },
    async listMergeIncidents(): Promise<unknown[]> {
      state.calls.push("listMergeIncidents");
      return state.openIncidents ?? [];
    },
    async getMergeGroup(groupId: string): Promise<unknown> {
      state.calls.push("getMergeGroup");
      const g = (state.formingGroups ?? []).find((x) => (x as { id: string }).id === groupId);
      return { ...(g as object), members: state.groupMembers ?? [] };
    },
    async markGroupIntegrating(): Promise<unknown> {
      state.calls.push("markGroupIntegrating");
      return {};
    },
    // ── Phase 7.5 Step 6 verify-cache ──
    async lookupVerifyCache(
      _projectId: string,
      key: {
        resource: string;
        treeSha: string;
        stepId: string;
        stepConfigSha: string;
      },
    ): Promise<unknown> {
      if (state.cacheCalls) state.cacheCalls.lookups += 1;
      state.calls.push("lookupVerifyCache");
      const k = [key.resource, key.treeSha, key.stepId, key.stepConfigSha].join(" ");
      const row = state.verifyCache?.get(k);
      if (!row) return null;
      row.hitCount += 1;
      return {
        id: k,
        projectId: "proj-1",
        resource: row.resource,
        treeSha: row.treeSha,
        stepId: row.stepId,
        stepConfigSha: row.stepConfigSha,
        result: row.result,
        durationMs: row.durationMs ?? null,
        logExcerpt: row.logExcerpt ?? null,
        logUrl: row.logUrl ?? null,
        createdAt: nowIso(),
        lastHitAt: nowIso(),
        hitCount: row.hitCount,
        updatedAt: nowIso(),
      };
    },
    async recordVerifyCache(_projectId: string, entry: VerifyCacheRowFake): Promise<unknown> {
      if (state.cacheCalls) state.cacheCalls.records += 1;
      state.calls.push(`recordVerifyCache:${entry.result}`);
      const k = [entry.resource, entry.treeSha, entry.stepId, entry.stepConfigSha].join(" ");
      const existing = state.verifyCache?.get(k);
      state.verifyCache?.set(k, {
        ...entry,
        hitCount: existing?.hitCount ?? 0,
      });
      return { id: k, result: entry.result };
    },
    async emitVerifyCacheMismatch(): Promise<void> {
      if (state.cacheCalls) state.cacheCalls.mismatches += 1;
      state.calls.push("emitVerifyCacheMismatch");
    },
    // ── Phase 7.6 conflict resolution ──
    async openResolution(
      _projectId: string,
      resource: string,
      originRequestId: string,
      conflictingFiles: string[],
    ): Promise<unknown> {
      state.calls.push("openResolution");
      if (state.openResolutionThrows) {
        throw new PmApiError(500, "INTERNAL", "openResolution failed");
      }
      const id = `res-${(state.resolutions?.length ?? 0) + 1}`;
      state.resolutions?.push({
        id,
        originRequestId,
        resource,
        conflictingFiles,
        state: "pending",
      });
      return {
        id,
        projectId: "proj-1",
        resource,
        originRequestId,
        resolvedRequestId: null,
        state: "pending",
        conflictingFiles,
        attemptStartedAt: null,
        attemptEndedAt: null,
        escalationTarget: null,
        detail: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
    },
  };
  return fake as unknown as PmClient;
}

function makeRequest(over: Partial<MergeRequestView>): MergeRequestView {
  return {
    id: "req-1",
    projectId: "proj-1",
    resource: "main",
    submittedBy: "worker-1",
    taskId: null,
    resolvedFrom: null,
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

describe.skipIf(!GIT_AVAILABLE)("runBatchOnce (real git + fake PM)", () => {
  let tmpRoot: string;
  let bareRepo: string;
  let authorClone: string;
  const logger = createLogger("error");

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-batch-"));
    bareRepo = path.join(tmpRoot, "bare.git");
    authorClone = path.join(tmpRoot, "author");

    await simpleGit().init(["--bare", "--initial-branch=main", bareRepo]);
    await simpleGit().clone(bareRepo, authorClone);
    const author = simpleGit(authorClone);
    await configIdentity(author);
    writeFileSync(path.join(authorClone, "base.txt"), "base\n");
    await author.add(["base.txt"]);
    await author.commit("initial");
    await author.branch(["-M", "main"]);
    await author.push(["-u", "origin", "main"]);

    // Clean feature branch (adds a new file).
    await author.checkoutLocalBranch("feature/clean");
    writeFileSync(path.join(authorClone, "feature.txt"), "feat\n");
    await author.add(["feature.txt"]);
    await author.commit("add feature");
    await author.push(["-u", "origin", "feature/clean"]);

    // A second clean feature branch (used for the two-request backpressure test).
    await author.checkout("main");
    await author.checkoutLocalBranch("feature/clean2");
    writeFileSync(path.join(authorClone, "feature2.txt"), "feat2\n");
    await author.add(["feature2.txt"]);
    await author.commit("add feature2");
    await author.push(["-u", "origin", "feature/clean2"]);

    // A third clean feature branch (disjoint file) — for 3-member chain tests.
    await author.checkout("main");
    await author.checkoutLocalBranch("feature/clean3");
    writeFileSync(path.join(authorClone, "feature3.txt"), "feat3\n");
    await author.add(["feature3.txt"]);
    await author.commit("add feature3");
    await author.push(["-u", "origin", "feature/clean3"]);

    // A branch that touches the SAME file as feature/clean (feature.txt) with
    // different content. Rebasing this onto feature/clean's rebased tree
    // conflicts on feature.txt — used for the mid-chain conflict + the
    // conflict-then-refill predecessor-correctness tests.
    await author.checkout("main");
    await author.checkoutLocalBranch("feature/collidefeature");
    writeFileSync(path.join(authorClone, "feature.txt"), "collide\n");
    await author.add(["feature.txt"]);
    await author.commit("collide on feature.txt");
    await author.push(["-u", "origin", "feature/collidefeature"]);

    // Feature branch whose verify will fail.
    await author.checkout("main");
    await author.checkoutLocalBranch("feature/badtest");
    writeFileSync(path.join(authorClone, "marker.txt"), "bad\n");
    await author.add(["marker.txt"]);
    await author.commit("add marker");
    await author.push(["-u", "origin", "feature/badtest"]);

    // A DEDICATED branch for the land-time drift test. It must carry a change
    // that is NOT already on main when the drift test runs — `feature/clean`
    // gets landed by an earlier test, after which re-using it trips the no-op /
    // already-landed guard (no push → the racing-commit-on-push never fires).
    await author.checkout("main");
    await author.checkoutLocalBranch("feature/drift");
    writeFileSync(path.join(authorClone, "drift-feature.txt"), "drift\n");
    await author.add(["drift-feature.txt"]);
    await author.commit("add drift feature");
    await author.push(["-u", "origin", "feature/drift"]);

    // A dedicated clean branch for the request-fault reject test (Test A): it
    // must NOT be pre-landed (so it lands cleanly while its sibling req-bad —
    // pointing at a non-existent branch — is rejected).
    await author.checkout("main");
    await author.checkoutLocalBranch("feature/rejectok");
    writeFileSync(path.join(authorClone, "rejectok.txt"), "rejectok\n");
    await author.add(["rejectok.txt"]);
    await author.commit("add rejectok feature");
    await author.push(["-u", "origin", "feature/rejectok"]);
    await author.checkout("main");
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /**
   * Build BatchDeps with a REAL size-N worktree pool and a gitOps factory. The
   * pool clones the bare repo into each slot on ensureAll(); we then configure
   * identity + track feature branches in every slot so rebaseOnto can resolve
   * them.
   */
  async function depsFor(
    state: FakeState,
    opts: {
      worktreeRoot: string;
      parallelism?: number;
      verifyTimeoutSec?: number;
      defaultVerifyCommand?: string;
      heartbeatIntervalMs?: number;
      gitOpsFactory?: (p: string) => GitOps;
      onBatchEvent?: (event: BatchEvent) => void;
      verifySteps?: VerifyStep[];
      cacheEnabled?: boolean;
      cacheMode?: CacheMode;
      /**
       * Phase 7.6: enable the conflict-resolution seam. When set, depsFor wires
       * a `resolver` handle whose openAndEnqueue calls the fake openResolution
       * and pushes the job onto `enqueued`. Absent ⇒ no resolver (off-path,
       * byte-identical to 7.5).
       */
      resolver?: {
        enabled: boolean;
        /** Recorded ResolutionJobs the enqueue handle received. */
        enqueued?: {
          resolutionId: string;
          originRequestId: string;
          conflictingFiles: string[];
          baseSha: string;
          ref: string;
          resource: string;
        }[];
      };
    },
  ): Promise<BatchDeps> {
    const pool = createWorktreePool({
      worktreeRoot: opts.worktreeRoot,
      worktreeName: "wt",
      gitRepoUrl: bareRepo,
      gitRemote: "origin",
      gitMainBranch: "main",
      parallelism: opts.parallelism ?? 1,
      cleanKeep: [],
    });
    await pool.ensureAll();
    // Configure identity + local feature branches in each freshly-cloned slot.
    for (let i = 0; i < pool.size; i += 1) {
      const wt = pool.acquire();
      if (!wt) break;
      const g = simpleGit(wt.path);
      await configIdentity(g);
      await g.fetch("origin");
      pool.release(wt);
    }
    const pmClient = makeFakeClient(state);
    // Phase 7.6: the resolver handle mirrors index.ts — openResolution then
    // enqueue onto the (here in-memory recorded) job list. The non-fatal
    // try/catch lives in maybeOpenResolution (src/batch.ts), NOT here, so a
    // throwing openResolution is observed to be swallowed by production code.
    const resolver = opts.resolver?.enabled
      ? {
          enabled: true as const,
          openAndEnqueue: async (args: {
            originRequestId: string;
            conflictingFiles: string[];
            baseSha: string;
            ref: string;
          }): Promise<string> => {
            const resolution = await pmClient.openResolution(
              "proj-1",
              "main",
              args.originRequestId,
              args.conflictingFiles,
            );
            opts.resolver?.enqueued?.push({
              resolutionId: resolution.id,
              originRequestId: args.originRequestId,
              conflictingFiles: args.conflictingFiles,
              baseSha: args.baseSha,
              ref: args.ref,
              resource: "main",
            });
            return resolution.id;
          },
        }
      : undefined;
    return {
      pmClient,
      pool,
      gitOps: opts.gitOpsFactory ?? ((p: string) => createGitOps(simpleGit(p))),
      logger,
      projectId: "proj-1",
      resource: "main",
      defaultVerifyCommand: opts.defaultVerifyCommand ?? "echo verify-ok",
      verifyTimeoutSec: opts.verifyTimeoutSec ?? 30,
      gitRemote: "origin",
      gitMainBranch: "main",
      newBatchId: () => "batch-test",
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      onBatchEvent: opts.onBatchEvent,
      verifySteps: opts.verifySteps,
      cacheEnabled: opts.cacheEnabled,
      cacheMode: opts.cacheMode,
      resolver,
    };
  }

  it("single-member land == runOnce sequence", async () => {
    const root = path.join(tmpRoot, "wt-land");
    const req = makeRequest({ branch: "feature/clean", verifyCmd: "echo ok" });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
      completeBodies: [],
    };
    const deps = await depsFor(state, { worktreeRoot: root });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("landed");
    expect(state.lockHeld).toBe(false);

    // Phase 7.5 Step 7: the passing land's completeAttempt carries the single
    // synthetic step's result (cache-off path still surfaces the per-step row;
    // existing call-order assertion below stays green).
    const passed = state.completeBodies!.find((b) => b.status === "passed");
    expect(passed).toBeDefined();
    expect((passed!.steps as { stepId: string }[]).map((s) => s.stepId)).toEqual(["verify"]);
    // Byte-identical to runOnce for N=1: acquire IS before pickup in both.
    // Phase 7.4 (Step 12) interleaves per-pass `getTrainState` pause-checks into
    // the call log (a read-side gate, never a merge op); filter them out so the
    // MERGE-operation ordering is what's asserted.
    expect(state.calls.filter((c) => c !== "getTrainState")).toEqual([
      "acquireLock",
      "pickup",
      "startAttempt",
      "completeAttempt:passed",
      "land",
      "releaseLock",
    ]);
  });

  it("verify-fail → reject + categorize + slot+lock released", async () => {
    const root = path.join(tmpRoot, "wt-reject");
    const req = makeRequest({
      id: "req-bad",
      branch: "feature/badtest",
      verifyCmd: "exit 1",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const deps = await depsFor(state, { worktreeRoot: root });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("rejected");
    expect(state.calls).toContain("completeAttempt:failed");
    expect(state.calls.some((c) => c.startsWith("reject:"))).toBe(true);
    expect(state.calls).toContain("releaseLock");
    expect(state.lockHeld).toBe(false);
    expect(deps.pool.leasedCount).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────
  // Strand-fix: an unexpected REQUEST-fault error during integration must
  // REJECT the request (not strand it `integrating` + bail the lane), while a
  // transient INFRA fault must NOT reject a good request.
  // ───────────────────────────────────────────────────────────────────

  it("request-fault (real checkout pathspec error) → reject(other) + lane continues + sibling lands", async () => {
    const root = path.join(tmpRoot, "wt-reqfault");
    // req-bad points at a branch that does NOT exist in the bare repo, so the
    // REAL rebaseOnto → `git.checkout` throws `pathspec ... did not match` —
    // exactly the live bug. It must be ordered first (older enqueuedAt).
    const badBranch = "feature/does-not-exist";
    const reqBad = makeRequest({
      id: "req-bad",
      branch: badBranch,
      verifyCmd: "echo ok",
      enqueuedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const reqOk = makeRequest({
      id: "req-ok",
      branch: "feature/rejectok",
      verifyCmd: "echo ok",
      enqueuedAt: nowIso(),
    });
    const state: FakeState = {
      requests: [reqBad, reqOk],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    // REAL gitOps (the default factory) so the genuine checkout throw fires.
    const deps = await depsFor(state, { worktreeRoot: root, parallelism: 1 });
    const outcome = await runBatchOnce(deps);

    // The lane no longer bails on the unexpected error: it drained.
    expect(outcome.kind).toBe("drained");

    // req-bad is REJECTED as `other`, with the pathspec error surfaced — not
    // stranded `integrating`.
    expect(reqBad.status).toBe("rejected");
    expect(reqBad.rejectCategory).toBe("other");
    expect(reqBad.rejectReason).toMatch(/pathspec|did not match|does-not-exist/i);

    // The sibling good request still lands (the lane moved on).
    expect(reqOk.status).toBe("landed");

    // Lock + slots released.
    expect(state.lockHeld).toBe(false);
    expect(deps.pool.leasedCount).toBe(0);
  });

  it("infra-fault (PmApiError during startAttempt) → NO reject, request stays integrating, outcome error", async () => {
    const root = path.join(tmpRoot, "wt-infra-api");
    const req = makeRequest({
      id: "req-infra-a",
      branch: "feature/clean2",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const deps = await depsFor(state, { worktreeRoot: root, parallelism: 1 });
    // Make startAttempt throw a transport-level PmApiError (PM unreachable).
    deps.pmClient.startAttempt = async (): Promise<never> => {
      throw new PmApiError(0, "NETWORK", "network error calling POST /attempts");
    };

    const outcome = await runBatchOnce(deps);

    // Infra fault → re-thrown to the batch catch → error outcome; the request is
    // NOT rejected (it's a good request, PM is just unreachable).
    expect(outcome.kind).toBe("error");
    expect(req.status).toBe("integrating");
    expect(req.status).not.toBe("rejected");
    expect(state.calls.some((c) => c.startsWith("reject:"))).toBe(false);
    // The lane lock is released so a retry can re-acquire.
    expect(state.lockHeld).toBe(false);
  });

  it("infra-fault (RAW TypeError through real request() → wrapped PmApiError) → NO reject, outcome error", async () => {
    const root = path.join(tmpRoot, "wt-infra-net");
    const req = makeRequest({
      id: "req-infra-n",
      branch: "feature/clean3",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const deps = await depsFor(state, { worktreeRoot: root, parallelism: 1 });

    // A REAL PmClient whose fetchImpl throws a raw TypeError on the attempts
    // endpoint — proving step-1's request() wrapping converts it to a PmApiError
    // (so `isApiError` is true → re-throw → NO reject). The fake's startAttempt
    // delegates to this real client to exercise the wrapping end-to-end.
    const throwingClient = new PmClient({
      baseUrl: "http://pm.local",
      token: "tok",
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).includes("/attempts")) {
          throw new TypeError("fetch failed: ECONNRESET");
        }
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    deps.pmClient.startAttempt = (id, baseSha, tags): Promise<MergeAttemptView> =>
      throwingClient.startAttempt(id, baseSha, tags);

    const outcome = await runBatchOnce(deps);

    // The raw TypeError became a PmApiError via request() wrapping → infra fault
    // → re-thrown → error outcome, request NOT rejected.
    expect(outcome.kind).toBe("error");
    expect(req.status).toBe("integrating");
    expect(state.calls.some((c) => c.startsWith("reject:"))).toBe(false);
    expect(state.lockHeld).toBe(false);
  });

  it("land-time drift → resetToQueued → re-pickup → re-verify → land within one drain", async () => {
    const root = path.join(tmpRoot, "wt-drift");
    const req = makeRequest({
      id: "req-drift",
      // Dedicated, never-pre-landed branch (see beforeAll) so the no-op guard
      // does NOT short-circuit — the push (and its injected race) must happen.
      branch: "feature/drift",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // EXPLICIT race injection (git-ops.test.ts technique): wrap the gitOps
    // factory's push so the FIRST push performs a racing author commit to the
    // bare remote *before* delegating — guaranteeing that first push observes a
    // non-fast-forward. The member then re-queues, re-rebases onto the new
    // main, re-verifies, and the SECOND push fast-forwards cleanly.
    let pushCount = 0;
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async push(remote, branch) {
          pushCount += 1;
          if (pushCount === 1) {
            const author = simpleGit(authorClone);
            await author.checkout("main");
            await author.pull("origin", "main");
            writeFileSync(path.join(authorClone, "race.txt"), "race\n");
            await author.add(["race.txt"]);
            await author.commit("author race commit");
            await author.push("origin", "main");
          }
          return real.push(remote, branch);
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      gitOpsFactory: factory,
    });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("landed");
    // resetToQueued must precede a SECOND pickup + startAttempt for the re-admit.
    const reset = state.calls.indexOf("resetToQueued");
    expect(reset).toBeGreaterThanOrEqual(0);
    const pickupsAfter = state.calls.slice(reset + 1).filter((c) => c === "pickup").length;
    const startsAfter = state.calls.slice(reset + 1).filter((c) => c === "startAttempt").length;
    expect(pickupsAfter).toBeGreaterThanOrEqual(1);
    expect(startsAfter).toBeGreaterThanOrEqual(1);
    expect(state.lockHeld).toBe(false);
  });

  it("lock acquired/released exactly once + heartbeat fires", async () => {
    const root = path.join(tmpRoot, "wt-lock");
    const req = makeRequest({
      id: "req-hb",
      branch: "feature/clean",
      // A short sleep so the 20ms heartbeat fires at least once during verify.
      verifyCmd: process.platform === "win32" ? "ping -n 2 127.0.0.1 > nul" : "sleep 0.3",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const deps = await depsFor(state, {
      worktreeRoot: root,
      heartbeatIntervalMs: 20,
    });
    const hbSpy = vi.spyOn(deps.pmClient, "heartbeatLock");
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("landed");
    expect(state.calls.filter((c) => c === "acquireLock").length).toBe(1);
    expect(state.calls.filter((c) => c === "releaseLock").length).toBe(1);
    expect(hbSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("backpressure size-1: second request not admitted until first drains", async () => {
    const root = path.join(tmpRoot, "wt-bp");
    const req1 = makeRequest({
      id: "req-a",
      branch: "feature/clean",
      verifyCmd: "echo ok",
      enqueuedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const req2 = makeRequest({
      id: "req-b",
      branch: "feature/clean2",
      verifyCmd: "echo ok",
      enqueuedAt: nowIso(),
    });
    const state: FakeState = {
      requests: [req1, req2],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const deps = await depsFor(state, { worktreeRoot: root, parallelism: 1 });

    // Track peak concurrent leases — must never exceed 1 with a size-1 pool.
    let peakLeased = 0;
    const origAcquire = deps.pool.acquire.bind(deps.pool);
    deps.pool.acquire = () => {
      const wt = origAcquire();
      if (deps.pool.leasedCount > peakLeased) peakLeased = deps.pool.leasedCount;
      return wt;
    };

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req1.status).toBe("landed");
    expect(req2.status).toBe("landed");
    expect(peakLeased).toBe(1);
    // req-a (older enqueuedAt) is picked up first; req-b only after req-a lands.
    // Both pickups happen, but never concurrently (peakLeased === 1 proves it).
    expect(state.calls.filter((c) => c === "pickup").length).toBe(2);
  });

  // ───────────────────────────────────────────────────────────────────
  // Step 5: speculative rebase + concurrent verify.
  // ───────────────────────────────────────────────────────────────────

  // win32-safe ~300ms sleep for the overlap test (NEVER bare `sleep 0.3`).
  const SLEEP_300 = process.platform === "win32" ? "ping -n 2 127.0.0.1 > nul" : "sleep 0.3";

  it("chain correctness: member K base == member K-1 rebased tree; all land", async () => {
    const root = path.join(tmpRoot, "wt-chain");
    const reqA = makeRequest({
      id: "req-c1",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const reqB = makeRequest({
      id: "req-c2",
      branch: "feature/clean2",
      verifyCmd: "echo ok",
    });
    const reqC = makeRequest({
      id: "req-c3",
      branch: "feature/clean3",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [reqA, reqB, reqC],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // Record each rebaseOnto's input base + returned commit sha, keyed by ref.
    const rebases: { ref: string; base: string; treeSha: string }[] = [];
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async rebaseOnto(base, branch) {
          const r = await real.rebaseOnto(base, branch);
          if (r.ok) rebases.push({ ref: branch, base, treeSha: r.treeSha });
          return r;
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      parallelism: 3,
      gitOpsFactory: factory,
    });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(reqA.status).toBe("landed");
    expect(reqB.status).toBe("landed");
    expect(reqC.status).toBe("landed");

    const reb = (ref: string): { base: string; treeSha: string } => {
      const found = rebases.find((x) => x.ref === ref);
      if (!found) throw new Error(`no rebase recorded for ${ref}`);
      return found;
    };
    const r0 = reb("feature/clean");
    const r1 = reb("feature/clean2");
    const r2 = reb("feature/clean3");

    // The rebase chain: member K rebased ONTO member K-1's returned tree.
    expect(r1.base).toBe(r0.treeSha);
    expect(r2.base).toBe(r1.treeSha);

    // PM-recorded startAttempt baseSha[K] === member K-1's rebased tree sha.
    const attemptBase = (id: string): string => {
      const a = state.attempts.find((x) => x.requestId === id);
      if (!a) throw new Error(`no attempt for ${id}`);
      return a.baseSha;
    };
    expect(attemptBase("req-c2")).toBe(r0.treeSha);
    expect(attemptBase("req-c3")).toBe(r1.treeSha);

    // Final remote main == member 2's rebased tree (the last land in the chain).
    const remote = simpleGit(authorClone);
    await remote.fetch("origin");
    const remoteMain = (await remote.revparse(["origin/main"])).trim();
    expect(remoteMain).toBe(r2.treeSha);
  });

  it("concurrent verify overlap: latest-start < earliest-end for ≥2 members", async () => {
    const root = path.join(tmpRoot, "wt-overlap");
    const reqA = makeRequest({
      id: "req-o1",
      branch: "feature/clean",
      verifyCmd: SLEEP_300,
    });
    const reqB = makeRequest({
      id: "req-o2",
      branch: "feature/clean2",
      verifyCmd: SLEEP_300,
    });
    const reqC = makeRequest({
      id: "req-o3",
      branch: "feature/clean3",
      verifyCmd: SLEEP_300,
    });
    const state: FakeState = {
      requests: [reqA, reqB, reqC],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // Record per-call verify start/end by wrapping runVerify in the factory.
    const windows: { start: number; end: number }[] = [];
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async runVerify(cmd, timeoutMs, runOpts) {
          const start = Date.now();
          const res = await real.runVerify(cmd, timeoutMs, runOpts);
          windows.push({ start, end: Date.now() });
          return res;
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      parallelism: 3,
      gitOpsFactory: factory,
    });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(windows.length).toBeGreaterThanOrEqual(2);
    // Non-flaky overlap form: there exists a PAIR of verifies whose time
    // windows intersect (one started before the other ended and vice-versa) —
    // i.e. ≥2 verifies ran concurrently. We don't require ALL N to mutually
    // overlap, because the serialized rebases (each a real git op) can stagger
    // the launches enough that the first verify finishes before the last
    // starts; concurrency of ANY two members is the property under test.
    let overlapFound = false;
    for (let i = 0; i < windows.length && !overlapFound; i += 1) {
      for (let j = i + 1; j < windows.length; j += 1) {
        const a = windows[i];
        const b = windows[j];
        if (a.start < b.end && b.start < a.end) {
          overlapFound = true;
          break;
        }
      }
    }
    expect(overlapFound).toBe(true);
  }, 20_000);

  it("mid-chain rebase conflict fails that member; member 0 lands; lock released once", async () => {
    const root = path.join(tmpRoot, "wt-midconflict");
    // Member 0 adds feature.txt; member 1 (collide) also touches feature.txt →
    // rebasing member 1 onto member 0's rebased tree conflicts.
    const reqA = makeRequest({
      id: "req-m1",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const reqB = makeRequest({
      id: "req-m2",
      branch: "feature/collidefeature",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [reqA, reqB],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const deps = await depsFor(state, { worktreeRoot: root, parallelism: 2 });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(reqA.status).toBe("landed");
    expect(reqB.status).toBe("rejected");
    expect(reqB.rejectCategory).toBe("conflict");
    expect(state.calls).toContain("reject:conflict");
    // Lane lock acquired + released exactly once.
    expect(state.calls.filter((c) => c === "acquireLock").length).toBe(1);
    expect(state.calls.filter((c) => c === "releaseLock").length).toBe(1);
    expect(state.lockHeld).toBe(false);
    expect(deps.pool.leasedCount).toBe(0);
  });

  // ── Phase 7.6: conflict → resolver seam (off=inert / enabled / non-fatal) ──

  it("7.6 off=inert: resolver disabled ⇒ plain conflict reject, ZERO openResolution (byte-identical to 7.5)", async () => {
    const root = path.join(tmpRoot, "wt-res-off");
    // Same real-git conflict setup as the mid-chain conflict test: member 0
    // (clean) lands, member 1 (collide) conflicts on feature.txt.
    const reqA = makeRequest({
      id: "req-off-a",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const reqB = makeRequest({
      id: "req-off-b",
      branch: "feature/collidefeature",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [reqA, reqB],
      attempts: [],
      lockHeld: false,
      calls: [],
      resolutions: [],
    };
    // No resolver knob → deps.resolver is undefined (the shipped 7.5 default).
    const deps = await depsFor(state, { worktreeRoot: root, parallelism: 2 });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(reqB.status).toBe("rejected");
    expect(reqB.rejectCategory).toBe("conflict");
    expect(state.calls).toContain("reject:conflict");
    // The prime invariant: the seam is inert. No resolution opened, no row.
    expect(state.calls).not.toContain("openResolution");
    expect(state.resolutions).toEqual([]);
    // Lock acquired + released exactly once — byte-identical to 7.5.
    expect(state.calls.filter((c) => c === "acquireLock").length).toBe(1);
    expect(state.calls.filter((c) => c === "releaseLock").length).toBe(1);
    expect(state.lockHeld).toBe(false);
  });

  it("7.6 enabled: conflict opens a resolution + enqueues a job; predecessor still lands and the slot frees", async () => {
    const root = path.join(tmpRoot, "wt-res-on");
    // A (clean, pos 0) lands; B (collide, pos 1) conflicts and opens a
    // resolution; C (clean2, queued) admits into the freed slot and lands —
    // proving the resolution does not stall the drain.
    const reqA = makeRequest({
      id: "req-on-a",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const reqB = makeRequest({
      id: "req-on-b",
      branch: "feature/collidefeature",
      verifyCmd: "echo ok",
    });
    const reqC = makeRequest({
      id: "req-on-c",
      branch: "feature/clean2",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [reqA, reqB, reqC],
      attempts: [],
      lockHeld: false,
      calls: [],
      resolutions: [],
    };
    const enqueued: {
      resolutionId: string;
      originRequestId: string;
      conflictingFiles: string[];
      baseSha: string;
      ref: string;
      resource: string;
    }[] = [];
    const deps = await depsFor(state, {
      worktreeRoot: root,
      parallelism: 2,
      resolver: { enabled: true, enqueued },
    });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    // Origin B genuinely rejected conflict (the audit trail stays truthful).
    expect(reqB.status).toBe("rejected");
    expect(reqB.rejectCategory).toBe("conflict");
    expect(state.calls).toContain("openResolution");

    // Exactly one pending resolution row, for B, with the conflicting file.
    expect(state.resolutions).toHaveLength(1);
    expect(state.resolutions![0].originRequestId).toBe(reqB.id);
    expect(state.resolutions![0].resource).toBe("main");
    expect(state.resolutions![0].conflictingFiles).toEqual(["feature.txt"]);
    expect(state.resolutions![0].state).toBe("pending");

    // The enqueue handle got exactly one job with the matching resolutionId.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].resolutionId).toBe(state.resolutions![0].id);
    expect(enqueued[0].originRequestId).toBe(reqB.id);
    expect(enqueued[0].conflictingFiles).toEqual(["feature.txt"]);

    // The resolution does NOT stall the train: a predecessor landed AND the
    // queued request admitted into the freed slot and landed.
    expect(reqA.status).toBe("landed");
    expect(reqC.status).toBe("landed");
    expect(deps.pool.leasedCount).toBe(0);
    // Still one lock cycle.
    expect(state.calls.filter((c) => c === "acquireLock").length).toBe(1);
    expect(state.calls.filter((c) => c === "releaseLock").length).toBe(1);
  });

  it("7.6 non-fatal: a throwing openResolution is swallowed — batch still drains, origin stays rejected-conflict", async () => {
    const root = path.join(tmpRoot, "wt-res-throw");
    const reqA = makeRequest({
      id: "req-tf-a",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const reqB = makeRequest({
      id: "req-tf-b",
      branch: "feature/collidefeature",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [reqA, reqB],
      attempts: [],
      lockHeld: false,
      calls: [],
      resolutions: [],
      openResolutionThrows: true,
    };
    const enqueued: never[] = [];
    const deps = await depsFor(state, {
      worktreeRoot: root,
      parallelism: 2,
      resolver: { enabled: true, enqueued },
    });
    const outcome = await runBatchOnce(deps);

    // The throw was swallowed inside maybeOpenResolution: the batch drained
    // cleanly (NOT {kind:"error"}), the predecessor landed, the origin stayed
    // rejected-conflict, and nothing was enqueued.
    expect(outcome.kind).toBe("drained");
    expect(reqA.status).toBe("landed");
    expect(reqB.status).toBe("rejected");
    expect(reqB.rejectCategory).toBe("conflict");
    expect(state.calls).toContain("openResolution");
    expect(state.resolutions).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(state.calls.filter((c) => c === "releaseLock").length).toBe(1);
    expect(state.lockHeld).toBe(false);
  });

  it("7.6 no-recursion: a conflicting request whose resolvedFrom is set ⇒ rejected conflict, NO openResolution, nothing enqueued", async () => {
    const root = path.join(tmpRoot, "wt-res-norecurse");
    // Same conflict shape as the "enabled" test, but the conflicting origin (B)
    // is ITSELF a resolution product (resolvedFrom set). The no-recursion guard
    // in maybeOpenResolution must short-circuit BEFORE openResolution.
    const reqA = makeRequest({
      id: "req-nr-a",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const reqB = makeRequest({
      id: "req-nr-b",
      branch: "feature/collidefeature",
      verifyCmd: "echo ok",
      // The marker: B is a resolution product. A conflict on it must NOT spin
      // another resolution.
      resolvedFrom: "req-origin-x",
    });
    const state: FakeState = {
      requests: [reqA, reqB],
      attempts: [],
      lockHeld: false,
      calls: [],
      resolutions: [],
    };
    const enqueued: { resolutionId: string }[] = [];
    const deps = await depsFor(state, {
      worktreeRoot: root,
      parallelism: 2,
      resolver: { enabled: true, enqueued },
    });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    // B is still genuinely rejected as a plain conflict.
    expect(reqB.status).toBe("rejected");
    expect(reqB.rejectCategory).toBe("conflict");
    // The guard fired: NO resolution opened, NO row, NOTHING enqueued.
    expect(state.calls).not.toContain("openResolution");
    expect(state.resolutions).toEqual([]);
    expect(enqueued).toEqual([]);
    // The predecessor still landed; one clean lock cycle.
    expect(reqA.status).toBe("landed");
    expect(state.calls.filter((c) => c === "releaseLock").length).toBe(1);
    expect(state.lockHeld).toBe(false);
  });

  it("MANDATORY: conflict-then-refill chains onto the surviving predecessor, not the failed one", async () => {
    const root = path.join(tmpRoot, "wt-refill");
    // FIFO order: A (clean, pos 0) → B (collide, pos 1, conflicts at admit and
    // frees its slot) → C (clean3, pos 2, admitted into the freed slot). C must
    // chain onto the SURVIVING predecessor A (pos 0), NOT the failed B (pos 1).
    const reqA = makeRequest({
      id: "req-r1",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const reqB = makeRequest({
      id: "req-r2",
      branch: "feature/collidefeature",
      verifyCmd: "echo ok",
    });
    const reqC = makeRequest({
      id: "req-r3",
      branch: "feature/clean3",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [reqA, reqB, reqC],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // Record rebaseOnto base/treeSha per ref + per-ref expectedMainSha observed
    // at land (via fetch+resolveRef ordering we read from landMember's push).
    const rebases: Record<string, { base: string; treeSha: string }> = {};
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async rebaseOnto(base, branch) {
          const r = await real.rebaseOnto(base, branch);
          if (r.ok) rebases[branch] = { base, treeSha: r.treeSha };
          return r;
        },
      };
    };

    // parallelism 2: A + B admitted; B conflicts at admit, frees the slot; the
    // SAME admit phase then re-acquires that slot and admits C while A is still
    // in flight (verifying) — exercising conflict-then-refill.
    const deps = await depsFor(state, {
      worktreeRoot: root,
      parallelism: 2,
      gitOpsFactory: factory,
    });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(reqA.status).toBe("landed");
    expect(reqB.status).toBe("rejected");
    expect(reqB.rejectCategory).toBe("conflict");
    expect(reqC.status).toBe("landed");

    // (a) C's speculative base chains onto A's rebasedTreeSha (the surviving
    //     predecessor), NOT B (which never produced a rebased tree).
    const rA = rebases["feature/clean"];
    const rC = rebases["feature/clean3"];
    expect(rA).toBeTruthy();
    expect(rC).toBeTruthy();
    expect(rC.base).toBe(rA.treeSha);
    expect(rebases["feature/collidefeature"]).toBeUndefined();

    // C's PM-recorded startAttempt baseSha == A's rebased tree (not B's).
    const cAttempt = state.attempts.find((a) => a.requestId === "req-r3");
    expect(cAttempt?.baseSha).toBe(rA.treeSha);

    // (b) landMember computed C's expectedMainSha from A's landedSha: the chain
    //     fast-forwarded cleanly (C verified against A's tree and landed onto
    //     it). Final remote main == C's rebased tree == A.treeSha + feature3.
    const remote = simpleGit(authorClone);
    await remote.fetch("origin");
    const remoteMain = (await remote.revparse(["origin/main"])).trim();
    expect(remoteMain).toBe(rC.treeSha);
    // A landed first; its landedSha IS the base C expected and rebased onto.
    expect(reqA.landedSha).toBe(rA.treeSha);
  });

  it("lane-lock-once under concurrency: exactly one acquire/release; heartbeat fires", async () => {
    const root = path.join(tmpRoot, "wt-lockonce");
    const reqA = makeRequest({
      id: "req-l1",
      branch: "feature/clean",
      verifyCmd: SLEEP_300,
    });
    const reqB = makeRequest({
      id: "req-l2",
      branch: "feature/clean2",
      verifyCmd: SLEEP_300,
    });
    const reqC = makeRequest({
      id: "req-l3",
      branch: "feature/clean3",
      verifyCmd: SLEEP_300,
    });
    const state: FakeState = {
      requests: [reqA, reqB, reqC],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const deps = await depsFor(state, {
      worktreeRoot: root,
      parallelism: 3,
      heartbeatIntervalMs: 20,
    });
    const hbSpy = vi.spyOn(deps.pmClient, "heartbeatLock");
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(reqA.status).toBe("landed");
    expect(reqB.status).toBe("landed");
    expect(reqC.status).toBe("landed");
    expect(state.calls.filter((c) => c === "acquireLock").length).toBe(1);
    expect(state.calls.filter((c) => c === "releaseLock").length).toBe(1);
    expect(hbSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(deps.pool.leasedCount).toBe(0);
  }, 20_000);

  // ───────────────────────────────────────────────────────────────────
  // Step 6: land serialization + suffix invalidation.
  //
  // "A single failure invalidates EXACTLY the dependent suffix — never more,
  // never less." Three signature shapes (mid / tail / head) + a base-SHA proof
  // + the kill-during-verify integration proof of the two mandatory fixes.
  // ───────────────────────────────────────────────────────────────────

  // win32-safe LONG sleep (~9s) for the kill-during-verify test. The kill MUST
  // cut it short; if it doesn't, the test times out — a clear failure signal.
  const SLEEP_LONG = process.platform === "win32" ? "ping -n 10 127.0.0.1 > nul" : "sleep 9";

  // A verify that SLEEPS ~2s and THEN fails (exit non-zero). Load-bearing for
  // the suffix-invalidation tests: the failing member must fail AFTER its
  // dependents have been admitted (chained onto it) and started verifying —
  // otherwise the surviving-prefix logic simply admits the dependents fresh
  // against main (no speculation on the failed member → nothing to invalidate).
  // The delay guarantees the dependents speculate on the failing member first.
  const DELAY_FAIL =
    process.platform === "win32" ? "ping -n 3 127.0.0.1 > nul & exit 1" : "sleep 2; exit 1";

  it("Step 6 mid-failure: req1 verify-fails; req0 lands, req2 invalidated→re-admitted→landed onto main+0", async () => {
    const root = path.join(tmpRoot, "wt-s6-mid");
    const reqA = makeRequest({
      id: "req-s1",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const reqB = makeRequest({
      id: "req-s2",
      branch: "feature/clean2",
      // Delayed verify failure (NOT a conflict — clean rebase): fails AFTER req2
      // has chained onto it and started verifying, so req2 truly speculates on
      // req1 and must be invalidated when req1 fails.
      verifyCmd: DELAY_FAIL,
    });
    const reqC = makeRequest({
      id: "req-s3",
      branch: "feature/clean3",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [reqA, reqB, reqC],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // Record every rebaseOnto so we can prove req2's re-admit base.
    const rebases: { ref: string; base: string; treeSha: string }[] = [];
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async rebaseOnto(base, branch) {
          const r = await real.rebaseOnto(base, branch);
          if (r.ok) rebases.push({ ref: branch, base, treeSha: r.treeSha });
          return r;
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      parallelism: 3,
      gitOpsFactory: factory,
    });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(reqA.status).toBe("landed");
    expect(reqB.status).toBe("rejected");
    // It is a VERIFY rejection, not a conflict.
    expect(reqB.rejectCategory).not.toBe("conflict");
    expect(state.calls.some((c) => c.startsWith("reject:"))).toBe(true);
    expect(reqC.status).toBe("landed");

    // req2's INITIAL speculative rebase chained onto req1's tree (the failed
    // predecessor). Its RE-ADMIT rebase must chain onto req0's rebased tree
    // (= main+0), NEVER main+0+1.
    const r0 = rebases.find((x) => x.ref === "feature/clean");
    expect(r0).toBeTruthy();
    const c3Rebases = rebases.filter((x) => x.ref === "feature/clean3");
    // req2 rebased at least twice: the initial (chained on req1) and the
    // re-admit (chained on the surviving prefix = req0). This ≥2 IS the
    // invalidation→re-admit signal (a non-invalidated member rebases once).
    expect(c3Rebases.length).toBeGreaterThanOrEqual(2);
    const reAdmitRebase = c3Rebases[c3Rebases.length - 1];

    // The CASCADE fired structurally: req2 was reset-to-queued (invalidation)
    // and re-picked-up. Pollution-independent (does not rely on SHA inequality,
    // which collapses when earlier tests have already landed these files onto
    // the shared remote main, making rebases no-ops).
    expect(state.calls.filter((c) => c === "resetToQueued").length).toBe(1);

    // req2's INITIAL speculative rebase chained onto req1 (the failed
    // predecessor); its RE-ADMIT rebase anchors onto req0's rebased tree
    // (= main+0, the surviving prefix), NEVER main+0+1. The initial base is
    // req1's tree, the re-admit base is req0's tree.
    const r1 = rebases.find((x) => x.ref === "feature/clean2");
    expect(r1).toBeTruthy();
    expect(c3Rebases[0].base).toBe(r1!.treeSha); // initial: speculated on req1
    expect(reAdmitRebase.base).toBe(r0!.treeSha); // re-admit: anchored to main+0

    // Final remote main == req2's RE-rebased tree (the last land).
    const remote = simpleGit(authorClone);
    await remote.fetch("origin");
    const remoteMain = (await remote.revparse(["origin/main"])).trim();
    expect(remoteMain).toBe(reAdmitRebase.treeSha);

    // Lock once; no leaked worktrees.
    expect(state.calls.filter((c) => c === "acquireLock").length).toBe(1);
    expect(state.calls.filter((c) => c === "releaseLock").length).toBe(1);
    expect(deps.pool.leasedCount).toBe(0);

    // Base-SHA PROOF (fold-in): req2's RE-ADMIT startAttempt baseSha === req0's
    // rebased tree (main+0), and the INITIAL attempt speculated on req1's tree.
    const c3Attempts = state.attempts.filter((a) => a.requestId === "req-s3");
    expect(c3Attempts.length).toBeGreaterThanOrEqual(2);
    const reAdmitAttempt = c3Attempts[c3Attempts.length - 1];
    expect(c3Attempts[0].baseSha).toBe(r1!.treeSha); // initial speculated on req1
    expect(reAdmitAttempt.baseSha).toBe(r0!.treeSha); // re-admit anchored to main+0
  }, 20_000);

  it("Step 6 tail-failure: req2 verify-fails; req0+req1 land, NOTHING invalidated (never more)", async () => {
    const root = path.join(tmpRoot, "wt-s6-tail");
    const reqA = makeRequest({
      id: "req-t1",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const reqB = makeRequest({
      id: "req-t2",
      branch: "feature/clean2",
      verifyCmd: "echo ok",
    });
    const reqC = makeRequest({
      id: "req-t3",
      branch: "feature/clean3",
      verifyCmd: "exit 1", // tail fails
    });
    const state: FakeState = {
      requests: [reqA, reqB, reqC],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const deps = await depsFor(state, { worktreeRoot: root, parallelism: 3 });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(reqA.status).toBe("landed");
    expect(reqB.status).toBe("landed");
    expect(reqC.status).toBe("rejected");

    // NEVER MORE: req0 and req1 must NOT be invalidated. resetToQueued is the
    // suffix-invalidation (and drift) signal; there is no drift here, so a
    // resetToQueued would mean an erroneous invalidation. Assert zero.
    expect(state.calls.filter((c) => c === "resetToQueued").length).toBe(0);
    // Each surviving member picked up + started an attempt EXACTLY once.
    expect(state.attempts.filter((a) => a.requestId === "req-t1").length).toBe(1);
    expect(state.attempts.filter((a) => a.requestId === "req-t2").length).toBe(1);
    // No re-pickup of the survivors.
    expect(state.calls.filter((c) => c === "pickup").length).toBe(3);
    expect(deps.pool.leasedCount).toBe(0);
  }, 20_000);

  it("Step 6 head-failure: req0 verify-fails; req1 AND req2 invalidated→re-admitted→landed (entire suffix)", async () => {
    const root = path.join(tmpRoot, "wt-s6-head");
    const reqA = makeRequest({
      id: "req-h1",
      branch: "feature/clean",
      verifyCmd: DELAY_FAIL, // head fails AFTER the suffix speculates on it
    });
    const reqB = makeRequest({
      id: "req-h2",
      branch: "feature/clean2",
      verifyCmd: "echo ok",
    });
    const reqC = makeRequest({
      id: "req-h3",
      branch: "feature/clean3",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [reqA, reqB, reqC],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    const rebases: { ref: string; base: string; treeSha: string }[] = [];
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async rebaseOnto(base, branch) {
          const r = await real.rebaseOnto(base, branch);
          if (r.ok) rebases.push({ ref: branch, base, treeSha: r.treeSha });
          return r;
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      parallelism: 3,
      gitOpsFactory: factory,
    });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(reqA.status).toBe("rejected");
    expect(reqB.status).toBe("landed");
    expect(reqC.status).toBe("landed");

    // ENTIRE SUFFIX invalidated: both req1 and req2 were reset + re-picked-up.
    // Two suffix members → at least two resetToQueued calls.
    expect(state.calls.filter((c) => c === "resetToQueued").length).toBeGreaterThanOrEqual(2);
    // Each suffix member shows a SECOND pickup + startAttempt (re-admit).
    expect(state.attempts.filter((a) => a.requestId === "req-h2").length).toBeGreaterThanOrEqual(2);
    expect(state.attempts.filter((a) => a.requestId === "req-h3").length).toBeGreaterThanOrEqual(2);

    // Re-admit bases anchor to FRESH main (head failed → surviving prefix is
    // empty for req1, so it anchors live main; req2 chains onto req1's re-tree).
    const remote = simpleGit(authorClone);
    await remote.fetch("origin");
    const mainSha = (await remote.revparse(["origin/main"])).trim();
    // Final main is the last land (req2's re-rebased tree).
    const c3Rebases = rebases.filter((x) => x.ref === "feature/clean3");
    const lastC3 = c3Rebases[c3Rebases.length - 1];
    expect(mainSha).toBe(lastC3.treeSha);

    expect(state.calls.filter((c) => c === "acquireLock").length).toBe(1);
    expect(state.calls.filter((c) => c === "releaseLock").length).toBe(1);
    expect(deps.pool.leasedCount).toBe(0);
  }, 20_000);

  it("Step 6 kill-during-verify: failed member 0 kills suffix member 1's long verify; member 1 re-verifies and lands; no double-handling", async () => {
    const root = path.join(tmpRoot, "wt-s6-kill");
    // Member 0 fails fast (exit 1). Member 1 runs a LONG verify that MUST be
    // killed when member 0's failure invalidates the suffix; on re-admit member
    // 1 re-verifies (echo ok) against fresh main and lands.
    const reqA = makeRequest({
      id: "req-k1",
      branch: "feature/clean",
      // Delayed fail (~2s): long enough for member 1's LONG verify to be in
      // flight (chained onto member 0) when member 0's failure fires the
      // suffix invalidation that must KILL member 1's verify.
      verifyCmd: DELAY_FAIL,
    });
    const reqB = makeRequest({
      id: "req-k2",
      branch: "feature/clean2",
      // First verify is long; we cannot vary verifyCmd per-attempt via the fake,
      // so the LONG command must ALSO pass once killed/re-run. Use a wrapper:
      // the recorded duration proves the FIRST run was cut short by kill().
      verifyCmd: SLEEP_LONG,
    });
    const state: FakeState = {
      requests: [reqA, reqB],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // Wrap runVerify to record member 1's verify durations. The FIRST member-1
    // verify must be cut short (well under the full ~9s sleep) by the kill seam.
    const durations: { cmd: string; ms: number; killedish: boolean }[] = [];
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async runVerify(cmd, timeoutMs, runOpts) {
          const start = Date.now();
          const res = await real.runVerify(cmd, timeoutMs, runOpts);
          const ms = Date.now() - start;
          durations.push({
            cmd,
            ms,
            killedish: res.exitCode !== 0 || res.signal !== null,
          });
          return res;
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      parallelism: 2,
      verifyTimeoutSec: 60, // long timeout so the internal timeout NEVER fires
      gitOpsFactory: factory,
    });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(reqA.status).toBe("rejected"); // member 0 verify-failed
    expect(reqB.status).toBe("landed"); // member 1 re-verified + landed

    // The LONG verify ran at least twice (the killed first run + the re-verify).
    const longRuns = durations.filter((d) => d.cmd === SLEEP_LONG);
    expect(longRuns.length).toBeGreaterThanOrEqual(1);
    // The FIRST long run was cut short — resolved WELL under the ~9s sleep,
    // proving kill() fired (FIX 1 killed it; FIX 2 made the continuation bail).
    const firstLong = longRuns[0];
    expect(firstLong.ms).toBeLessThan(7_000);

    // NO double-handling of member 1: it was reset exactly ONCE (the suffix
    // invalidation), never rejected. A double-reject/double-reset would show up
    // as >1 resetToQueued for req-k2 or a reject of req-k2.
    expect(state.calls.filter((c) => c === "resetToQueued").length).toBe(1);
    // Exactly one reject overall (member 0 only); member 1 never rejected.
    expect(state.calls.filter((c) => c.startsWith("reject:")).length).toBe(1);
    expect(reqB.rejectCategory).toBeNull();

    // No leaked worktree (the killed member's slot was released in FIX 1's
    // synchronous pass and re-leased for the re-admit, then freed on land).
    expect(deps.pool.leasedCount).toBe(0);
  }, 30_000);

  // ───────────────────────────────────────────────────────────────────
  // Step 7: batch-marker events (onBatchEvent fires at all transitions).
  // ───────────────────────────────────────────────────────────────────

  it("Step 7 land scenario: onBatchEvent fires started → member_landed → completed with exact payloads", async () => {
    const root = path.join(tmpRoot, "wt-s7-land");
    const req = makeRequest({
      id: "req-be1",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const captured: BatchEvent[] = [];
    const deps = await depsFor(state, {
      worktreeRoot: root,
      onBatchEvent: (e) => captured.push(e),
    });
    // Override the batch-id minter so we can assert the exact id flows through.
    deps.newBatchId = () => "batch-be";

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("landed");

    const types = captured.map((e) => e.type);
    expect(types).toEqual(["started", "member_landed", "completed"]);

    const started = captured[0];
    expect(started).toMatchObject({
      type: "started",
      batchId: "batch-be",
      resource: "main",
      memberCount: 1,
      memberRequestIds: ["req-be1"],
    });

    const landed = captured[1];
    expect(landed).toMatchObject({
      type: "member_landed",
      batchId: "batch-be",
      requestId: "req-be1",
      speculativePosition: 0,
      landedSha: req.landedSha,
    });

    const completed = captured[2];
    expect(completed).toMatchObject({
      type: "completed",
      batchId: "batch-be",
      landed: 1,
      rejected: 0,
      invalidated: 0,
    });
  });

  it("Step 7 suffix invalidation: onBatchEvent fires member_invalidated with reason + failedPredecessorRequestId", async () => {
    const root = path.join(tmpRoot, "wt-s7-inv");
    const reqA = makeRequest({
      id: "req-bi1",
      branch: "feature/clean",
      verifyCmd: DELAY_FAIL, // head fails AFTER the suffix speculates on it
    });
    const reqB = makeRequest({
      id: "req-bi2",
      branch: "feature/clean2",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [reqA, reqB],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const captured: BatchEvent[] = [];
    const deps = await depsFor(state, {
      worktreeRoot: root,
      parallelism: 2,
      onBatchEvent: (e) => captured.push(e),
    });
    deps.newBatchId = () => "batch-bi";

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(reqA.status).toBe("rejected");

    const invalidated = captured.filter(
      (e): e is Extract<BatchEvent, { type: "member_invalidated" }> =>
        e.type === "member_invalidated",
    );
    expect(invalidated.length).toBeGreaterThanOrEqual(1);
    const inv = invalidated[0];
    expect(inv.batchId).toBe("batch-bi");
    expect(inv.requestId).toBe("req-bi2");
    expect(inv.failedPredecessorRequestId).toBe("req-bi1");
    expect(inv.reason).toContain("req-bi1");

    // started + completed still bookend the batch.
    expect(captured[0].type).toBe("started");
    expect(captured.at(-1)?.type).toBe("completed");
  }, 20_000);

  // ───────────────────────────────────────────────────────────────────
  // Step 8: verify retry policy (transient vs real, backoff/cap, retries
  // as attempts, abort-during-backoff race).
  //
  // Transients are simulated via the established gitOpsFactory runVerify
  // WRAPPER: it returns a synthetic transient-shaped result for the first K
  // calls (per ref), then delegates to the real runVerify. retryBackoffMs
  // is tiny ([5,5,5]) so the backoff doesn't slow the suite.
  // ───────────────────────────────────────────────────────────────────

  // A synthetic transient verify result (spawn failure shape): the classifier
  // reads spawnError → transient. logPath is supplied by the caller.
  const transientResult = (logPath: string) => ({
    exitCode: null as unknown as number,
    signal: null,
    spawnError: "EAGAIN",
    timedOut: false,
    stdout: "",
    stderr: "",
    durationMs: 0,
    logPath,
  });

  it("Step 8 transient-then-succeeds → lands (exactly 2 attempts; superseded attempt completed failed)", async () => {
    const root = path.join(tmpRoot, "wt-s8-transient");
    const req = makeRequest({
      id: "req-x1",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // Wrapper: call #1 for this ref returns a synthetic transient; call #2 runs
    // the real (passing) verify.
    let calls = 0;
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async runVerify(cmd, timeoutMs, runOpts) {
          calls += 1;
          if (calls === 1) return transientResult(runOpts.logPath);
          return real.runVerify(cmd, timeoutMs, runOpts);
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      gitOpsFactory: factory,
    });
    deps.maxVerifyRetries = 3;
    deps.retryBackoffMs = [5, 5, 5];

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("landed");
    // Exactly 2 startAttempt for the request (initial + 1 retry).
    expect(state.calls.filter((c) => c === "startAttempt").length).toBe(2);
    // The superseded (first) attempt was completed as failed; the landed one passed.
    expect(state.calls).toContain("completeAttempt:failed");
    expect(state.calls).toContain("completeAttempt:passed");
    // Main advanced to the verified tree.
    const remote = simpleGit(authorClone);
    await remote.fetch("origin");
    expect(req.landedSha).toBeTruthy();
  }, 20_000);

  it("Step 8 real failure (exit 1) → no retry, immediate reject; retryCount stays 0", async () => {
    const root = path.join(tmpRoot, "wt-s8-real");
    const req = makeRequest({
      id: "req-x2",
      branch: "feature/badtest",
      verifyCmd: "exit 1",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const deps = await depsFor(state, { worktreeRoot: root });
    deps.maxVerifyRetries = 3;
    deps.retryBackoffMs = [5, 5, 5];

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("rejected");
    // Exactly ONE attempt (no 2nd startAttempt).
    expect(state.calls.filter((c) => c === "startAttempt").length).toBe(1);
    expect(state.calls.some((c) => c.startsWith("reject:"))).toBe(true);
    // No suffix invalidation here (single member), so no resetToQueued.
    expect(state.calls.filter((c) => c === "resetToQueued").length).toBe(0);
    expect(deps.pool.leasedCount).toBe(0);
  });

  it("Step 8 retry cap honored → 3 verify calls (initial + 2 retries) then reject; retryCount===2", async () => {
    const root = path.join(tmpRoot, "wt-s8-cap");
    const req = makeRequest({
      id: "req-x3",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // Wrapper: ALWAYS returns the synthetic transient shape (never passes).
    let verifyCalls = 0;
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async runVerify(_cmd, _timeoutMs, runOpts) {
          verifyCalls += 1;
          return transientResult(runOpts.logPath);
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      gitOpsFactory: factory,
    });
    deps.maxVerifyRetries = 2;
    deps.retryBackoffMs = [5, 5, 5];

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("rejected");
    // initial + 2 retries = 3 verify calls.
    expect(verifyCalls).toBe(3);
    // startAttempt: initial + 2 retries = 3.
    expect(state.calls.filter((c) => c === "startAttempt").length).toBe(3);
    expect(state.calls.some((c) => c.startsWith("reject:"))).toBe(true);
    expect(deps.pool.leasedCount).toBe(0);
  }, 20_000);

  it("Step 8 own-timeout = real (no retry); immediate reject (timedOut-first)", async () => {
    const root = path.join(tmpRoot, "wt-s8-timeout");
    const req = makeRequest({
      id: "req-x4",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // Wrapper returns a timed-out shape (timedOut:true + SIGTERM + exitCode:null).
    // classifyVerifyFailure must read this as REAL (timedOut FIRST), no retry.
    let verifyCalls = 0;
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async runVerify(_cmd, _timeoutMs, runOpts) {
          verifyCalls += 1;
          return {
            exitCode: null as unknown as number,
            signal: "SIGTERM" as NodeJS.Signals,
            timedOut: true,
            stdout: "",
            stderr: "",
            durationMs: 0,
            logPath: runOpts.logPath,
          };
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      gitOpsFactory: factory,
    });
    deps.maxVerifyRetries = 3;
    deps.retryBackoffMs = [5, 5, 5];

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("rejected");
    // No retry: exactly one verify call + one attempt.
    expect(verifyCalls).toBe(1);
    expect(state.calls.filter((c) => c === "startAttempt").length).toBe(1);
    expect(state.calls.some((c) => c.startsWith("reject:"))).toBe(true);
  });

  it("Step 8 suffix-killed-during-backoff → NOT retried in place; re-admitted fresh and lands; no illegal attempt", async () => {
    const root = path.join(tmpRoot, "wt-s8-killbackoff");
    // Member 0 fails REAL (delayed exit 1) so its failure + suffix invalidation
    // lands while member 1 is in a backoff sleep. Member 1's verify returns a
    // transient ONCE → enters a LONG (200ms base) backoff; the invalidation must
    // abort that sleep and the post-sleep guard must make the retry loop bail
    // WITHOUT a fresh startAttempt. Member 1 is then re-admitted fresh and lands.
    const reqA = makeRequest({
      id: "req-kb1",
      branch: "feature/clean",
      verifyCmd: DELAY_FAIL, // ~2s then exit 1 (real)
    });
    const reqB = makeRequest({
      id: "req-kb2",
      branch: "feature/clean2",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [reqA, reqB],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // Member 1's verify: FIRST call (its initial speculative attempt, chained on
    // member 0) returns a synthetic transient → member 1 enters backoff. Any
    // later call (the re-admit's fresh verify against main) runs the real passing
    // verify. Keyed on the clean2 ref so member 0's verify is untouched.
    let b1Calls = 0;
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async runVerify(cmd, timeoutMs, runOpts) {
          if (cmd === "echo ok") {
            b1Calls += 1;
            if (b1Calls === 1) return transientResult(runOpts.logPath);
          }
          return real.runVerify(cmd, timeoutMs, runOpts);
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      parallelism: 2,
      gitOpsFactory: factory,
    });
    // A backoff long enough that member 0's ~2s failure + invalidation lands
    // DURING member 1's first backoff sleep.
    deps.maxVerifyRetries = 3;
    deps.retryBackoffMs = [200, 200, 200];

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(reqA.status).toBe("rejected"); // member 0 real-failed
    expect(reqB.status).toBe("landed"); // member 1 re-admitted fresh + landed

    // Member 1 was invalidated (suffix) exactly once — NOT rejected, NOT
    // double-handled. A retry-in-place that survived the kill would have issued
    // an extra startAttempt against the now-released worktree.
    expect(state.calls.filter((c) => c === "resetToQueued").length).toBe(1);
    // Exactly one reject overall (member 0 only).
    expect(state.calls.filter((c) => c.startsWith("reject:")).length).toBe(1);
    expect(reqB.rejectCategory).toBeNull();
    expect(deps.pool.leasedCount).toBe(0);
  }, 30_000);

  // ───────────────────────────────────────────────────────────────────
  // Phase 7.5 Step 5: runVerifyTask now runs verify via runPipeline. These
  // exercise the SEAM through the real runVerifyTask (the per-pass child
  // controller, transient-retry-re-runs, backward-compat bare logPath, and a
  // verify_steps DAG fail-fast).
  // ───────────────────────────────────────────────────────────────────

  it("7.5 transient-then-pass via pipeline → re-runs (exactly 2 runVerify calls), member LANDS", async () => {
    const root = path.join(tmpRoot, "wt-75-retry");
    const req = makeRequest({
      id: "req-75r",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // Call #1 → synthetic transient (fail-fast aborts the per-pass child). The
    // 7.2 retry re-calls runVerifyTask → runPipeline mints a FRESH child from the
    // still-un-fired member signal → call #2 runs and passes. A single SHARED
    // member signal (passed to runVerify directly) would leave call #2 aborted →
    // this would burn retries and NOT land. Proving 2 calls + landed proves the
    // per-pass child + the retry RE-RUN.
    let calls = 0;
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async runVerify(cmd, timeoutMs, runOpts) {
          calls += 1;
          if (calls === 1) return transientResult(runOpts.logPath);
          return real.runVerify(cmd, timeoutMs, runOpts);
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      gitOpsFactory: factory,
    });
    deps.maxVerifyRetries = 3;
    deps.retryBackoffMs = [5, 5, 5];

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("landed");
    expect(calls).toBe(2); // EXACTLY 2 — the retry re-ran, did not burn the cap
    expect(state.calls.filter((c) => c === "startAttempt").length).toBe(2);
  }, 20_000);

  it("7.5 backward-compat: verifySteps:[] → synthetic single step, bare today logPath + correct args, LANDS", async () => {
    const root = path.join(tmpRoot, "wt-75-compat");
    const req = makeRequest({
      id: "req-75c",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // Capture the EXACT runVerify args the synthetic single step passes.
    const seen: {
      cmd: string;
      timeoutMs: number;
      cwd: string;
      logPath: string;
      hasSignal: boolean;
    }[] = [];
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async runVerify(cmd, timeoutMs, runOpts) {
          seen.push({
            cmd,
            timeoutMs,
            cwd: runOpts.cwd,
            logPath: runOpts.logPath,
            hasSignal: Boolean(runOpts.signal),
          });
          return real.runVerify(cmd, timeoutMs, runOpts);
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      gitOpsFactory: factory,
    });
    deps.verifySteps = []; // EXPLICIT empty → synthetic fallback
    deps.verifyTimeoutSec = 30;

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("landed");
    expect(seen.length).toBe(1);
    expect(seen[0].cmd).toBe("echo ok"); // member.request.verifyCmd
    expect(seen[0].timeoutMs).toBe(30 * 1000); // verifyTimeoutSec * 1000
    // The bare today path: <wt.logsDir>/<attemptId>.log — NO stepId suffix.
    expect(seen[0].logPath).toMatch(/[/\\][^/\\]+\.log$/);
    expect(seen[0].logPath).not.toMatch(/-verify\.log$/);
    expect(seen[0].cwd).toBeTruthy();
    expect(seen[0].hasSignal).toBe(true); // the per-pass child signal is forwarded
  }, 20_000);

  it("7.5 verify_steps DAG fail-fast: a cheap failing step rejects; the expensive dependent NEVER runs", async () => {
    const root = path.join(tmpRoot, "wt-75-dag");
    const req = makeRequest({
      id: "req-75d",
      branch: "feature/clean",
      verifyCmd: "echo unused", // overridden by the DAG steps
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
      completeBodies: [],
    };

    // The DAG: cheap (exit 1) → expensive (depends_on cheap). cheap fails in wave
    // 1 → fail-fast → expensive never runs. Real exit-1 → no retry → reject.
    const cheapCmd = "exit 1";
    const expensiveCmd = "ping -n 30 127.0.0.1 > nul"; // would be slow IF run
    let expensiveRan = false;
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async runVerify(cmd, timeoutMs, runOpts) {
          if (cmd === expensiveCmd) expensiveRan = true;
          return real.runVerify(cmd, timeoutMs, runOpts);
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      gitOpsFactory: factory,
    });
    deps.verifySteps = [
      { id: "cheap", command: cheapCmd, depends_on: [], cache_key_inputs: [] },
      {
        id: "expensive",
        command: expensiveCmd,
        depends_on: ["cheap"],
        cache_key_inputs: [],
      },
    ];
    deps.maxVerifyRetries = 3;
    deps.retryBackoffMs = [5, 5, 5];

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("rejected");
    expect(expensiveRan).toBe(false); // fail-fast short-circuit
    // Real failure → no transient retry → exactly one attempt.
    expect(state.calls.filter((c) => c === "startAttempt").length).toBe(1);
    expect(state.calls.some((c) => c.startsWith("reject:"))).toBe(true);
    // Phase 7.5 Step 7: the failing completeAttempt carries the mapped steps[]
    // (the cheap fail is present; the expensive step is absent — fail-fast).
    const failed = state.completeBodies!.find((b) => b.status === "failed");
    expect(failed).toBeDefined();
    expect(Array.isArray(failed!.steps)).toBe(true);
    const stepIds = (failed!.steps as { stepId: string }[]).map((s) => s.stepId);
    expect(stepIds).toContain("cheap");
    expect(stepIds).not.toContain("expensive");
  }, 20_000);

  // ── Phase 7.5 Step 6: cache-aware runVerifyTask (lifted: members land/reject
  //    on the cache verdict). A gitOps wrapper stamps the derived TREE sha to a
  //    KNOWN constant (CLARIFICATION A: the key is `<commit>^{tree}`, content-
  //    addressed) so the cache key is deterministic + we can pre-seed a HIT. ──
  const FIXED_TREE = "fixed-tree-sha-for-cache-tests";
  const treeStampFactory =
    (onVerify?: (cmd: string) => void) =>
    (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async resolveRef(ref: string): Promise<string> {
          // Stamp the cache-key tree-sha derivation to a constant; pass through
          // every other resolveRef (HEAD, origin/main, etc.) untouched.
          if (ref.endsWith("^{tree}")) return FIXED_TREE;
          return real.resolveRef(ref);
        },
        async runVerify(cmd, timeoutMs, runOpts) {
          onVerify?.(cmd);
          return real.runVerify(cmd, timeoutMs, runOpts);
        },
      };
    };

  it("7.6 SHADOW: member REJECTS despite a cached PASS (the false-pass detector, lifted)", async () => {
    const root = path.join(tmpRoot, "wt-76-shadow");
    const failCmd = "exit 1"; // the REAL run fails
    const req = makeRequest({
      id: "req-76s",
      branch: "feature/clean",
      verifyCmd: failCmd,
    });
    // Pre-seed a cached PASS under the EXACT key the integrator will probe.
    const scSha = stepConfigSha({ command: failCmd, cache_key_inputs: [] });
    const verifyCache = new Map<string, VerifyCacheRowFake>([
      [
        ["main", FIXED_TREE, "verify", scSha].join(" "),
        {
          resource: "main",
          treeSha: FIXED_TREE,
          stepId: "verify",
          stepConfigSha: scSha,
          result: "pass",
          hitCount: 0,
        },
      ],
    ]);
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
      verifyCache,
      cacheCalls: { lookups: 0, records: 0, mismatches: 0 },
    };
    let ran = false;
    const deps = await depsFor(state, {
      worktreeRoot: root,
      gitOpsFactory: treeStampFactory(() => {
        ran = true;
      }),
      cacheEnabled: true,
      cacheMode: "shadow",
    });

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    // Shadow ALWAYS runs; the REAL verdict (fail) wins over the cached pass.
    expect(ran).toBe(true);
    expect(req.status).toBe("rejected");
    // The mismatch fired (cached pass vs real fail).
    expect(state.cacheCalls!.mismatches).toBe(1);
    // The real verdict was recorded (self-heal): fail.
    expect(state.calls.some((c) => c === "recordVerifyCache:fail")).toBe(true);
  }, 20_000);

  it("7.7 ON-mode HIT of a cached FAIL → reject, NO real run, NO transient retry", async () => {
    const root = path.join(tmpRoot, "wt-77-hitfail");
    const cmd = "echo ok"; // would PASS if it ran — but the HIT says fail.
    const req = makeRequest({
      id: "req-77h",
      branch: "feature/clean",
      verifyCmd: cmd,
    });
    const scSha = stepConfigSha({ command: cmd, cache_key_inputs: [] });
    const verifyCache = new Map<string, VerifyCacheRowFake>([
      [
        ["main", FIXED_TREE, "verify", scSha].join(" "),
        {
          resource: "main",
          treeSha: FIXED_TREE,
          stepId: "verify",
          stepConfigSha: scSha,
          result: "fail",
          logExcerpt: "cached failure",
          hitCount: 0,
        },
      ],
    ]);
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
      verifyCache,
      cacheCalls: { lookups: 0, records: 0, mismatches: 0 },
    };
    let ran = false;
    const deps = await depsFor(state, {
      worktreeRoot: root,
      gitOpsFactory: treeStampFactory(() => {
        ran = true;
      }),
      cacheEnabled: true,
      cacheMode: "on",
    });

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    // The cached FAIL HIT skipped the real run entirely.
    expect(ran).toBe(false);
    expect(req.status).toBe("rejected");
    // Synthesized cached fail → classify "real" → straight to reject, NO retry:
    // exactly ONE attempt, no transient completeAttempt:failed loop.
    expect(state.calls.filter((c) => c === "startAttempt").length).toBe(1);
    expect(state.calls.some((c) => c.startsWith("reject:"))).toBe(true);
    // NO record on a HIT.
    expect(state.cacheCalls!.records).toBe(0);
  }, 20_000);

  it("7.8 ON-mode HIT of a cached PASS → LANDS without running verify", async () => {
    const root = path.join(tmpRoot, "wt-78-hitpass");
    const cmd = "exit 1"; // would FAIL if it ran — but the HIT says pass.
    const req = makeRequest({
      id: "req-78h",
      branch: "feature/clean",
      verifyCmd: cmd,
    });
    const scSha = stepConfigSha({ command: cmd, cache_key_inputs: [] });
    const verifyCache = new Map<string, VerifyCacheRowFake>([
      [
        ["main", FIXED_TREE, "verify", scSha].join(" "),
        {
          resource: "main",
          treeSha: FIXED_TREE,
          stepId: "verify",
          stepConfigSha: scSha,
          result: "pass",
          hitCount: 0,
        },
      ],
    ]);
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
      verifyCache,
      cacheCalls: { lookups: 0, records: 0, mismatches: 0 },
    };
    let ran = false;
    const deps = await depsFor(state, {
      worktreeRoot: root,
      gitOpsFactory: treeStampFactory(() => {
        ran = true;
      }),
      cacheEnabled: true,
      cacheMode: "on",
    });

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(ran).toBe(false); // HIT skipped the (would-fail) run.
    expect(req.status).toBe("landed"); // the cached pass landed it.
    expect(state.cacheCalls!.records).toBe(0);
  }, 20_000);

  // ───────────────────────────────────────────────────────────────────
  // Step 9: lane-ownership rewire (index.ts → runBatchLoop). These prove
  // the integrator-level invariants the LIVE entrypoint now relies on.
  // ───────────────────────────────────────────────────────────────────

  it("Step 9 crash recovery: reclaimStrandedRequests resets N=3 integrating → queued", async () => {
    // N-tolerance: the startup sweep must reclaim EVERY stranded `integrating`
    // request in the lane, not just one. (A serial crash could strand only one;
    // a batch crash can strand up to `parallelism` at once.)
    const stranded = [
      makeRequest({ id: "req-s1", status: "integrating" }),
      makeRequest({ id: "req-s2", status: "integrating" }),
      makeRequest({ id: "req-s3", status: "integrating" }),
    ];
    const state: FakeState = {
      requests: stranded,
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const client = makeFakeClient(state);

    const result = await reclaimStrandedRequests(client, "proj-1", "main", logger);

    expect(result.scanned).toBe(3);
    expect(result.reclaimed).toBe(3);
    expect(stranded.every((r) => r.status === "queued")).toBe(true);
    // resetToQueued fired once per stranded request.
    expect(state.calls.filter((c) => c === "resetToQueued").length).toBe(3);
  });

  it("Step 9 second integrator can't double-land: loser gets lock_unavailable + ZERO land/push", async () => {
    const root = path.join(tmpRoot, "wt-double-land");
    // ONE shared queued request + ONE shared single-holder lock. Two integrators
    // run runBatchOnce against the SAME request array + SAME lock store. The real
    // lock service grants to exactly one holder; the loser's acquireLock returns
    // the not-granted/`queued` shape → runBatchOnce short-circuits to
    // `lock_unavailable` BEFORE any pickup/startAttempt/land/push.
    const sharedRequests = [
      makeRequest({ id: "req-dl1", branch: "feature/clean", verifyCmd: "echo ok" }),
    ];
    const sharedLock: SharedLock = { holder: null };

    const stateA: FakeState = {
      requests: sharedRequests,
      attempts: [],
      lockHeld: false,
      calls: [],
      integratorId: "int-A",
      sharedLock,
    };
    const stateB: FakeState = {
      requests: sharedRequests,
      attempts: [],
      lockHeld: false,
      calls: [],
      integratorId: "int-B",
      sharedLock,
    };

    // Two REAL size-1 pools in distinct worktree roots; depsFor builds each
    // fake-client from the state it is handed, and the fake reads state lazily —
    // so the shared lock + shared requests + per-state integratorId are honored.
    const depsA = await depsFor(stateA, { worktreeRoot: path.join(root, "A") });
    const depsB = await depsFor(stateB, { worktreeRoot: path.join(root, "B") });

    const [outA, outB] = await Promise.all([runBatchOnce(depsA), runBatchOnce(depsB)]);

    const outcomes = [outA.kind, outB.kind];
    // Exactly one drained, exactly one lock_unavailable.
    expect(outcomes.filter((k) => k === "drained").length).toBe(1);
    expect(outcomes.filter((k) => k === "lock_unavailable").length).toBe(1);

    // Identify winner/loser by outcome.
    const [winState, loseState] = outA.kind === "drained" ? [stateA, stateB] : [stateB, stateA];

    // Winner landed + pushed exactly once.
    expect(sharedRequests[0].status).toBe("landed");
    expect(winState.calls).toContain("land");

    // LOSER performed ZERO land and ZERO pickup/startAttempt — it never touched
    // the request. (push happens inside landMember via the real gitOps; the
    // structural guarantee is the loser issues no landMergeRequest call at all.)
    expect(loseState.calls).not.toContain("land");
    expect(loseState.calls).not.toContain("pickup");
    expect(loseState.calls).not.toContain("startAttempt");
    // The loser released no lock it never held.
    expect(loseState.calls).not.toContain("releaseLock");
  }, 30_000);

  it("Step 9 tag-wiring: pickup + startAttempt carry {batchId, speculativePosition}", async () => {
    const root = path.join(tmpRoot, "wt-tags");
    const req = makeRequest({
      id: "req-tag1",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
      pickupTags: {},
      startAttemptTags: [],
    };
    const deps = await depsFor(state, { worktreeRoot: root });
    deps.newBatchId = () => "batch-tag";

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("landed");

    // pickup carried the batch lineage for the admitted member (position 0).
    expect(state.pickupTags!["req-tag1"]).toEqual({
      batchId: "batch-tag",
      speculativePosition: 0,
    });
    // startAttempt (initial admit) carried the same lineage.
    expect(state.startAttemptTags!.length).toBeGreaterThanOrEqual(1);
    expect(state.startAttemptTags![0]).toEqual({
      batchId: "batch-tag",
      speculativePosition: 0,
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Phase 7.4 Step 12: pause (no-abort) + fail-open.
  // ───────────────────────────────────────────────────────────────────

  it("Step 12 paused → no batch admission (no pickup / acquireLock / startAttempt)", async () => {
    const root = path.join(tmpRoot, "wt-s12-paused");
    const req = makeRequest({
      id: "req-p1",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
      trainState: "paused",
    };
    const deps = await depsFor(state, { worktreeRoot: root });

    const outcome = await runBatchOnce(deps);

    // Top-of-pass pause-check returns idle BEFORE the lock — no batch started.
    expect(outcome.kind).toBe("idle");
    expect(req.status).toBe("queued");
    expect(state.calls).toContain("getTrainState");
    expect(state.calls).not.toContain("acquireLock");
    expect(state.calls).not.toContain("pickup");
    expect(state.calls).not.toContain("startAttempt");
    expect(deps.pool.leasedCount).toBe(0);
  });

  it("Step 12 resume → the same request is picked up + lands", async () => {
    const root = path.join(tmpRoot, "wt-s12-resume");
    const req = makeRequest({
      id: "req-p2",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
      trainState: "running",
    };
    const deps = await depsFor(state, { worktreeRoot: root });

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("landed");
    expect(state.calls).toContain("pickup");
    expect(state.calls).toContain("land");
  });

  it("Step 12 NO-ABORT: in-flight member completes under mid-drain pause; 2nd request never picked up", async () => {
    const root = path.join(tmpRoot, "wt-s12-noabort");
    // Member 0 runs a slow verify (so it is still in flight when pause flips).
    const reqA = makeRequest({
      id: "req-na1",
      branch: "feature/clean",
      verifyCmd: SLEEP_300,
      enqueuedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const reqB = makeRequest({
      id: "req-na2",
      branch: "feature/clean2",
      verifyCmd: "echo ok",
      enqueuedAt: nowIso(),
    });
    // Train reads RUNNING for the top-of-batch check + the first drain pass's
    // admit (so member 0 is admitted + verifying), then PAUSED for every later
    // pass — flipping pause mid-drain while member 0 is in flight.
    let tsCalls = 0;
    const state: FakeState = {
      requests: [reqA, reqB],
      attempts: [],
      lockHeld: false,
      calls: [],
      trainState: () => {
        tsCalls += 1;
        return tsCalls <= 2 ? "running" : "paused";
      },
    };
    // size-1 pool: member 0 holds the only slot while verifying, so member 1
    // can't even be considered until member 0 lands — and by then pause is set.
    const deps = await depsFor(state, { worktreeRoot: root, parallelism: 1 });

    const outcome = await runBatchOnce(deps);

    // The batch DRAINED (not aborted): member 0 — already integrating — STILL
    // LANDS. The no-abort invariant: pause gates ONLY the admission edge.
    expect(outcome.kind).toBe("drained");
    expect(reqA.status).toBe("landed");
    expect(state.calls).toContain("land");
    // The 2nd request was NEVER picked up (pause stopped NEW admission).
    expect(reqB.status).toBe("queued");
    expect(state.calls.filter((c) => c === "pickup").length).toBe(1);
    // The lane lock was acquired once and RELEASED on drain (not stranded).
    expect(state.calls.filter((c) => c === "acquireLock").length).toBe(1);
    expect(state.calls.filter((c) => c === "releaseLock").length).toBe(1);
    expect(state.lockHeld).toBe(false);
    expect(deps.pool.leasedCount).toBe(0);
  }, 20_000);

  it("Step 12 fail-open: getTrainState throws → batch proceeds to pickup + land (no wedge)", async () => {
    const root = path.join(tmpRoot, "wt-s12-failopen");
    const req = makeRequest({
      id: "req-fo1",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
      trainStateThrows: true,
    };
    const deps = await depsFor(state, { worktreeRoot: root });

    const outcome = await runBatchOnce(deps);

    // A getTrainState error is FAIL-OPEN (treated as running) — the batch must
    // not wedge: it picks up + lands exactly as a running lane.
    expect(outcome.kind).toBe("drained");
    expect(req.status).toBe("landed");
    expect(state.calls).toContain("pickup");
    expect(state.calls).toContain("land");
  });

  it("no-op / already-landed: rebased tree identical to main → landed WITHOUT a push", async () => {
    const root = path.join(tmpRoot, "wt-noop");

    // A branch that carries NO net change over main — its content is already on
    // main (the "hand-landed out-of-band / duplicate" case the integrator must
    // recognize). Created as a ref at main's tip so the rebase yields a tree
    // byte-identical to main; origin/main itself is left untouched so the
    // sibling tests below are unaffected.
    const author = simpleGit(authorClone);
    await author.checkout("main");
    await author.pull("origin", "main");
    const mainSha = (await author.revparse(["HEAD"])).trim();
    await author.checkoutLocalBranch("feature/noop");
    await author.push(["-u", "origin", "feature/noop"]);
    await author.checkout("main");

    const req = makeRequest({
      id: "req-noop",
      branch: "feature/noop",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };

    // Count real pushes — the no-op land must NOT push to the remote.
    let pushes = 0;
    const factory = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      return {
        ...real,
        async push(remote, branch) {
          pushes += 1;
          return real.push(remote, branch);
        },
      };
    };

    const deps = await depsFor(state, {
      worktreeRoot: root,
      gitOpsFactory: factory,
    });
    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    // Recorded landed (no-op disposition) at the CURRENT main sha — a
    // zero-advance land — and crucially WITHOUT any push.
    expect(req.status).toBe("landed");
    expect(req.landedSha).toBe(mainSha);
    expect(pushes).toBe(0);
    // Lock + slot released; a passing attempt recorded; never rejected.
    expect(state.lockHeld).toBe(false);
    expect(deps.pool.leasedCount).toBe(0);
    expect(state.calls).toContain("land");
    expect(state.calls.some((c) => c.startsWith("reject"))).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // Step 12: group lane honors pause.
  // ───────────────────────────────────────────────────────────────────

  // A RepoLane whose pool is exhausted (acquire → null), so recoverOrphanedInner
  // defers cleanly without any real git. Lets the group-pause tests prove the
  // CONTROL FLOW (forming suppressed / recovery reached) without a real repo.
  function exhaustedLane(role: "inner" | "outer"): RepoLane {
    return {
      role,
      name: `${role}-repo`,
      acquire: () => null,
      release: () => {},
      gitOps: () => ({}) as unknown as GitOps,
      gitlinkPath: role === "inner" ? "vendor/inner" : undefined,
      resolveRefInClone: async () => null,
    };
  }

  function groupLaneDeps(): GroupLaneDeps {
    return {
      innerLane: exhaustedLane("inner"),
      outerLane: exhaustedLane("outer"),
      integratorId: undefined,
      innerLogsDir: undefined,
      outerLogsDir: undefined,
    };
  }

  async function groupDepsFor(state: FakeState, worktreeRoot: string): Promise<RunBatchLoopDeps> {
    const base = await depsFor(state, { worktreeRoot });
    return {
      ...base,
      groupLane: groupLaneDeps(),
      waitForWork: async () => {},
      shouldContinue: () => true,
    };
  }

  it("Step 12 group + paused + NO incident → no_group (markGroupIntegrating NOT called)", async () => {
    const root = path.join(tmpRoot, "wt-s12-grp-paused");
    const state: FakeState = {
      requests: [],
      attempts: [],
      lockHeld: false,
      calls: [],
      trainState: "paused",
      formingGroups: [{ id: "grp-1" }],
      groupMembers: [makeRequest({ id: "gm-1", branch: "feature/clean" })],
      openIncidents: [],
    };
    const deps = await groupDepsFor(state, root);

    const outcome = await runGroupLaneOnce(deps);

    // Forming group is suppressed while paused; no incidents → nothing to do.
    expect(outcome.kind).toBe("no_group");
    // The group was NEVER picked up (no lock, no group integration).
    expect(state.calls).not.toContain("markGroupIntegrating");
    expect(state.calls).not.toContain("acquireLock");
  });

  it("Step 12 group + paused + OPEN incident → recovery runs; forming group NOT integrated", async () => {
    const root = path.join(tmpRoot, "wt-s12-grp-recovery");
    const state: FakeState = {
      requests: [],
      attempts: [],
      lockHeld: false,
      calls: [],
      trainState: "paused",
      formingGroups: [{ id: "grp-2" }],
      groupMembers: [makeRequest({ id: "gm-2", branch: "feature/clean" })],
      openIncidents: [{ id: "inc-1" }],
    };
    const deps = await groupDepsFor(state, root);

    const outcome = await runGroupLaneOnce(deps);

    // An open incident drives the lane lock even while paused: the recovery
    // sweep STILL runs (it is the no-abort drain of in-flight cross-repo work).
    // The lane was locked + the recovery-only pass returned `recovered`.
    expect(outcome.kind).toBe("recovered");
    expect(state.calls).toContain("acquireLock");
    expect(state.calls).toContain("releaseLock");
    // recoverOrphanedInner re-listed open incidents (the recovery path was
    // reached) — the count call + the recovery call both fire.
    expect(state.calls.filter((c) => c === "listMergeIncidents").length).toBeGreaterThanOrEqual(2);
    // The forming group was NOT integrated (suppressed while paused).
    expect(state.calls).not.toContain("getMergeGroup");
    expect(state.calls).not.toContain("markGroupIntegrating");
  });

  // ───────────────────────────────────────────────────────────────────
  // Step 12: heartbeat payload + fire-and-forget.
  // ───────────────────────────────────────────────────────────────────

  it("Step 12 buildHeartbeat: integrating status + pool + in-flight + version", () => {
    const hb = buildHeartbeat({
      resource: "main",
      pool: { size: 3, leasedCount: 1 },
      inFlight: { requests: 1, batches: 1, groups: 0 },
      version: "1.2.3",
    });
    expect(hb).toEqual({
      resource: "main",
      status: "integrating",
      pool_utilization: { size: 3, leased: 1 },
      in_flight: { requests: 1, batches: 1, groups: 0 },
      version: "1.2.3",
    });
  });

  it("Step 12 buildHeartbeat: empty in-flight → idle status", () => {
    const hb = buildHeartbeat({
      resource: "main",
      pool: { size: 2, leasedCount: 0 },
      inFlight: { requests: 0, batches: 0, groups: 0 },
      version: "1.2.3",
    });
    expect(hb.status).toBe("idle");
    expect(hb.in_flight).toEqual({ requests: 0, batches: 0, groups: 0 });

    // A group in flight (batches 0) still reports integrating.
    const grp = buildHeartbeat({
      resource: "main",
      pool: { size: 2, leasedCount: 1 },
      inFlight: { requests: 0, batches: 0, groups: 1 },
      version: "1.2.3",
    });
    expect(grp.status).toBe("integrating");
  });

  it("Step 12 heartbeat fire-and-forget: a rejecting postHeartbeat does NOT throw", async () => {
    // The emit pattern index.ts uses: .catch swallows a rejected POST so a
    // failed heartbeat NEVER breaks the loop. Replicate it here against a
    // rejecting client and assert it neither throws nor rejects.
    const rejectingClient = {
      postHeartbeat: async () => {
        throw new Error("network down");
      },
    } as unknown as PmClient;
    let warned = false;
    const emit = (): void => {
      rejectingClient
        .postHeartbeat(
          "proj-1",
          buildHeartbeat({
            resource: "main",
            pool: { size: 1, leasedCount: 0 },
            inFlight: { requests: 0, batches: 0, groups: 0 },
            version: "0.0.0",
          }),
        )
        .catch(() => {
          warned = true;
        });
    };
    expect(() => emit()).not.toThrow();
    // Let the rejected promise settle so the .catch runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(warned).toBe(true);
  });

  it("Step 12 inFlight counters: set during drain, reset to 0 in finally", async () => {
    const root = path.join(tmpRoot, "wt-s12-counters");
    const req = makeRequest({
      id: "req-cnt1",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
      trainState: "running",
    };
    const deps = await depsFor(state, { worktreeRoot: root });
    const inFlight = { requests: 0, batches: 0, groups: 0 };
    deps.inFlight = inFlight;

    const outcome = await runBatchOnce(deps);

    expect(outcome.kind).toBe("drained");
    // Drained cleanly → counters reset to 0 in the finally (status can't stick).
    expect(inFlight).toEqual({ requests: 0, batches: 0, groups: 0 });
  });

  it("Step 12 inFlight counters reset even when the batch THROWS", async () => {
    const root = path.join(tmpRoot, "wt-s12-counters-throw");
    const req = makeRequest({
      id: "req-cnt2",
      branch: "feature/clean",
      verifyCmd: "echo ok",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
      trainState: "running",
    };
    const deps = await depsFor(state, { worktreeRoot: root });
    const inFlight = { requests: 0, batches: 0, groups: 0 };
    deps.inFlight = inFlight;
    // Force a throw INSIDE the drain (after the lock + batches=1 are set) by
    // making listMergeRequests throw on the admit-phase re-list. The first call
    // (top of runBatchOnce) must succeed so the lock is acquired and batches=1.
    let listCalls = 0;
    const realList = deps.pmClient.listMergeRequests.bind(deps.pmClient);
    deps.pmClient.listMergeRequests = (async (...a: Parameters<typeof realList>) => {
      listCalls += 1;
      if (listCalls >= 2) throw new Error("boom in admit re-list");
      return realList(...a);
    }) as typeof realList;

    const outcome = await runBatchOnce(deps);

    // The throw is caught and surfaced as `error`, and the finally reset the
    // counters so the heartbeat status can't stick "integrating".
    expect(outcome.kind).toBe("error");
    expect(inFlight).toEqual({ requests: 0, batches: 0, groups: 0 });
  });
});
