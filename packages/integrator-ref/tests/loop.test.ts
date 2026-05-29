/**
 * runOnce integration tests.
 *
 * APPROACH (documented per the Step 11 plan's cross-package note): rather than
 * wiring an in-process @pm/server app across the package boundary (which makes
 * the integrator-ref tsconfig depend on server test internals), we drive
 * runOnce with a hand-built FakePmClient that implements the PmClient method
 * surface used by the loop, paired with REAL git-ops + worktree against a real
 * temp bare repo. This exercises the full land / reject / push-race code paths
 * with real git behavior. The spawned-process integration.test.ts is the
 * end-to-end regression net against a real PM server.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { MergeAttemptView, MergeRequestView } from "@pm/shared";
import { createGitOps } from "../src/git-ops.js";
import { createWorktree, type Worktree } from "../src/worktree.js";
import { createLogger } from "../src/logger.js";
import { runOnce, type RunOnceDeps } from "../src/loop.js";
import { PmApiError, type PmClient } from "../src/pm-client.js";

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

// ── A minimal in-memory fake of the PmClient surface the loop touches. ──

interface FakeState {
  requests: MergeRequestView[];
  attempts: MergeAttemptView[];
  lockHeld: boolean;
  calls: string[];
  /** When true, pickupMergeRequest throws 409 to model a lost race. */
  pickupThrows409?: boolean;
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
      state.lockHeld = true;
      return { ok: true, status: "held" };
    },
    async heartbeatLock(): Promise<{ ok: boolean; status: string }> {
      return { ok: true, status: "refreshed" };
    },
    async releaseLock(): Promise<{ ok: boolean; status: string }> {
      state.calls.push("releaseLock");
      state.lockHeld = false;
      return { ok: true, status: "released" };
    },
    async pickupMergeRequest(id: string): Promise<MergeRequestView> {
      const r = find(id);
      if (!r) throw new PmApiError(404, "NOT_FOUND", "not found");
      if (state.pickupThrows409 || r.status !== "queued")
        throw new PmApiError(409, "INVALID_TRANSITION", "not queued");
      r.status = "integrating";
      r.pickedUpAt = nowIso();
      state.calls.push("pickup");
      return r;
    },
    async startAttempt(id: string, baseSha: string): Promise<MergeAttemptView> {
      attemptSeq += 1;
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
      body: { status: string },
    ): Promise<MergeAttemptView> {
      const att = state.attempts.find((a) => a.id === attemptId);
      if (!att) throw new PmApiError(404, "NOT_FOUND", "no attempt");
      att.status = body.status as MergeAttemptView["status"];
      att.completedAt = nowIso();
      state.calls.push(`completeAttempt:${body.status}`);
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

describe.skipIf(!GIT_AVAILABLE)("runOnce (real git + fake PM)", () => {
  let tmpRoot: string;
  let bareRepo: string;
  let authorClone: string;
  let worktreeRoot: string;
  const logger = createLogger("error");

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-loop-"));
    bareRepo = path.join(tmpRoot, "bare.git");
    authorClone = path.join(tmpRoot, "author");
    worktreeRoot = path.join(tmpRoot, "wtroot");

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

    // Feature branch whose verify will fail.
    await author.checkout("main");
    await author.checkoutLocalBranch("feature/badtest");
    writeFileSync(path.join(authorClone, "marker.txt"), "bad\n");
    await author.add(["marker.txt"]);
    await author.commit("add marker");
    await author.push(["-u", "origin", "feature/badtest"]);
    await author.checkout("main");
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function setupWorktree(name: string): Promise<Worktree> {
    const wt = createWorktree({
      worktreeRoot,
      worktreeName: name,
      gitRemote: "origin",
      gitMainBranch: "main",
      gitRepoUrl: bareRepo,
    });
    await wt.ensureExists();
    await configIdentity(wt.git);
    // Track feature branches locally so rebaseOnto can check them out.
    await wt.git.fetch("origin");
    return wt;
  }

  function depsFor(state: FakeState, wt: Worktree): RunOnceDeps {
    return {
      pmClient: makeFakeClient(state),
      gitOps: createGitOps(simpleGit(wt.path)),
      worktree: wt,
      logger,
      projectId: "proj-1",
      resource: "main",
      defaultVerifyCommand: "echo verify-ok",
      verifyTimeoutSec: 30,
      gitRemote: "origin",
      gitMainBranch: "main",
    };
  }

  it("idle when no queued requests", async () => {
    const wt = await setupWorktree("idle");
    const state: FakeState = { requests: [], attempts: [], lockHeld: false, calls: [] };
    const outcome = await runOnce(depsFor(state, wt));
    expect(outcome.kind).toBe("idle");
  });

  it("lands a clean branch that passes verify", async () => {
    const wt = await setupWorktree("land");
    await wt.git.checkout(["-B", "feature/clean", "origin/feature/clean"]);
    await wt.git.checkout("main");
    const req = makeRequest({ branch: "feature/clean", verifyCmd: "echo ok" });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const outcome = await runOnce(depsFor(state, wt));
    expect(outcome.kind).toBe("landed");
    expect(req.status).toBe("landed");
    expect(state.lockHeld).toBe(false); // released on every path
    expect(state.calls).toContain("completeAttempt:passed");
    expect(state.calls).toContain("land");
  });

  it("rejects when verify fails", async () => {
    const wt = await setupWorktree("reject");
    await wt.git.checkout(["-B", "feature/badtest", "origin/feature/badtest"]);
    await wt.git.checkout("main");
    const req = makeRequest({
      id: "req-bad",
      branch: "feature/badtest",
      verifyCmd:
        process.platform === "win32" ? "exit 1" : "exit 1",
    });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
    };
    const outcome = await runOnce(depsFor(state, wt));
    expect(outcome.kind).toBe("rejected");
    expect(req.status).toBe("rejected");
    expect(state.lockHeld).toBe(false);
    expect(state.calls).toContain("completeAttempt:failed");
    expect(state.calls.some((c) => c.startsWith("reject:"))).toBe(true);
  });

  it("transition_lost + releases lock when pickup races to 409", async () => {
    const wt = await setupWorktree("lost");
    const req = makeRequest({ id: "req-lost", branch: "feature/clean" });
    const state: FakeState = {
      requests: [req],
      attempts: [],
      lockHeld: false,
      calls: [],
      pickupThrows409: true,
    };
    const outcome = await runOnce(depsFor(state, wt));
    expect(outcome.kind).toBe("transition_lost");
    expect(state.lockHeld).toBe(false); // lock released even on the lost path
    expect(state.calls).toContain("acquireLock");
    expect(state.calls).toContain("releaseLock");
    // No attempt should have been started.
    expect(state.calls).not.toContain("startAttempt");
  });
});
