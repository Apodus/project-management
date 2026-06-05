/**
 * Resolver worker tests (Phase 7.6 Step 6 / 7.6.1 in-session-loop).
 *
 * Drives the real worker against a GENUINE textual conflict (real git,
 * bare-repo + author-clone fixture) with an INJECTED fake `ResolverRunner` (no
 * real Claude binary). The fake scripts the agent's outcome and, in clean cases,
 * writes a resolved file (markers removed) so the subsequent commit exercises the
 * real path.
 *
 * Asserts the design contract:
 *  - startResolution is called FIRST, before any fallible work, in every case.
 *  - A `complete` runner result ⇒ the agent already verified the FULL suite
 *    IN-SESSION (7.6.1); the pool COMMITS and returns `resolved` UNCONDITIONALLY
 *    — it runs no verify gate of its own. The train re-verify is the real gate.
 *  - escalate states map per §4.3: timeout/unresolved/give_up → escalated,
 *    spawn_error → failed.
 *  - NO worker throw ever escapes into the train (onOutcome throw → slot still
 *    released, no escape; startResolution throw → abandon, no escalate, no
 *    onOutcome).
 *  - drain reentrancy: one slot, two jobs → both processed, none lost.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { createGitOps } from "../src/git-ops.js";
import {
  createResolverPool,
  type ResolutionJob,
  type ResolutionOutcome,
} from "../src/resolver-pool.js";
import type { ResolverRunner, ResolverRunResult } from "../src/resolver-runner.js";
import { createLogger } from "../src/logger.js";

function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();
const silentLogger = createLogger("silent");

/** A pmClient stub that records the startResolution call + a monotonic order. */
function makePmClient() {
  const calls: { resolutionId: string; at: number; order: number }[] = [];
  let order = 0;
  let mode: "ok" | "throw" = "ok";
  return {
    setThrow() {
      mode = "throw";
    },
    startCalls: calls,
    async startResolution(resolutionId: string) {
      const rec = { resolutionId, at: Date.now(), order: order++ };
      calls.push(rec);
      if (mode === "throw") throw new Error("startResolution boom");
      // Minimal MergeResolutionView shape (only `.id`-ish fields read upstream).
      return {
        id: resolutionId,
        projectId: "p1",
        resource: "main",
        originRequestId: "req-1",
        resolvedRequestId: null,
        state: "resolving" as const,
        conflictingFiles: null,
        attemptStartedAt: new Date().toISOString(),
        attemptEndedAt: null,
        escalationTarget: null,
        detail: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
  };
}

/**
 * A fake runner that records when it ran (order) and either writes a resolved
 * file (clean cases) or leaves the conflict, then returns the scripted result.
 */
function makeRunner(opts: {
  result: ResolverRunResult;
  resolveFile?: { rel: string; content: string };
  order?: { value: number };
}): ResolverRunner & { ranAtOrder: number | null } {
  const state = { ranAtOrder: null as number | null };
  return {
    get ranAtOrder() {
      return state.ranAtOrder;
    },
    async run(input): Promise<ResolverRunResult> {
      if (opts.order) state.ranAtOrder = opts.order.value++;
      if (opts.resolveFile) {
        await writeFile(
          path.join(input.worktreePath, opts.resolveFile.rel),
          opts.resolveFile.content,
        );
      }
      return opts.result;
    },
  };
}

describe.skipIf(!GIT_AVAILABLE)("resolver worker (real git, fake runner)", () => {
  let tmpRoot: string;
  let bareRepo: string;
  let mainSha: string; // live main HEAD (the rebase base)
  const featureRef = "feature/collide";

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-resworker-"));
    bareRepo = path.join(tmpRoot, "bare.git");
    const authorClone = path.join(tmpRoot, "author");
    await simpleGit().init(["--bare", "--initial-branch=main", bareRepo]);
    await simpleGit().clone(bareRepo, authorClone);
    const author = simpleGit(authorClone);
    await author.addConfig("user.email", "int@test.local");
    await author.addConfig("user.name", "Integrator Test");
    await author.addConfig("commit.gpgsign", "false");

    // Base commit.
    writeFileSync(path.join(authorClone, "feature.txt"), "line-base\n");
    await author.add(["feature.txt"]);
    await author.commit("initial");
    await author.branch(["-M", "main"]);
    await author.push(["-u", "origin", "main"]);

    // Feature branch edits the line one way.
    await author.checkoutLocalBranch(featureRef);
    writeFileSync(path.join(authorClone, "feature.txt"), "line-from-feature\n");
    await author.add(["feature.txt"]);
    await author.commit("feature edit");
    await author.push(["-u", "origin", featureRef]);

    // main advances with a CONFLICTING edit to the same line.
    await author.checkout("main");
    writeFileSync(path.join(authorClone, "feature.txt"), "line-from-main\n");
    await author.add(["feature.txt"]);
    await author.commit("main edit");
    await author.push(["origin", "main"]);
    mainSha = (await author.revparse(["HEAD"])).trim();
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function baseJob(resolutionId: string): ResolutionJob {
    return {
      resolutionId,
      originRequestId: "req-1",
      conflictingFiles: ["feature.txt"],
      baseSha: mainSha,
      ref: `origin/${featureRef}`,
      resource: "main",
    };
  }

  function makePool(args: {
    root: string;
    maxConcurrent: number;
    pmClient: ReturnType<typeof makePmClient>;
    runner: ResolverRunner;
    verifyCommand: string;
    onOutcome: (o: ResolutionOutcome) => void | Promise<void>;
  }) {
    return createResolverPool({
      worktreeRoot: args.root,
      worktreeName: "wt",
      gitRepoUrl: bareRepo,
      gitRemote: "origin",
      gitMainBranch: "main",
      cleanKeep: [],
      maxConcurrent: args.maxConcurrent,
      pmClient: args.pmClient,
      logger: silentLogger,
      gitOps: (p) => createGitOps(simpleGit(p)),
      verifySteps: [],
      defaultVerifyCommand: args.verifyCommand,
      runner: args.runner,
      timeBudgetSec: 60,
      onOutcome: args.onOutcome,
    });
  }

  /** Wait until `outcomes` has at least `n` entries (or time out). */
  async function waitForOutcomes(
    outcomes: ResolutionOutcome[],
    n: number,
    timeoutMs = 30000,
  ): Promise<void> {
    const start = Date.now();
    while (outcomes.length < n) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${n} outcomes (got ${outcomes.length})`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("(a) resolved: complete agent (verified in-session) → outcome resolved with a real sha, UNCONDITIONALLY", async () => {
    const root = path.join(tmpRoot, "wt-a");
    const pmClient = makePmClient();
    const outcomes: ResolutionOutcome[] = [];
    const runner = makeRunner({
      result: { kind: "complete", durationMs: 10 },
      resolveFile: { rel: "feature.txt", content: "line-merged\n" },
    });
    const pool = makePool({
      root,
      maxConcurrent: 1,
      pmClient,
      runner,
      // The verifyCommand is now irrelevant to the outcome — the pool runs no
      // verify of its own; a `complete` result lands as `resolved` regardless.
      verifyCommand: process.platform === "win32" ? "cmd /c exit 1" : "exit 1",
      onOutcome: (o) => void outcomes.push(o),
    });
    await pool.ensureAll();
    pool.enqueue(baseJob("res-a"));
    await waitForOutcomes(outcomes, 1);

    expect(pmClient.startCalls.map((c) => c.resolutionId)).toContain("res-a");
    const o = outcomes[0];
    expect(o.kind).toBe("resolved");
    if (o.kind === "resolved") {
      expect(o.resolvedCommitSha).toMatch(/^[0-9a-f]{7,40}$/);
      expect(o.worktreePath).toContain("wt-resolver-0");
    }
    expect(pool.leasedCount).toBe(0);
  });

  it("(b) give_up: runner give_up → escalate/escalated with the agent's reason", async () => {
    const root = path.join(tmpRoot, "wt-giveup");
    const pmClient = makePmClient();
    const outcomes: ResolutionOutcome[] = [];
    const runner = makeRunner({
      result: { kind: "give_up", reason: "cannot reconcile", durationMs: 5 },
    });
    const pool = makePool({
      root,
      maxConcurrent: 1,
      pmClient,
      runner,
      verifyCommand: "exit 0",
      onOutcome: (o) => void outcomes.push(o),
    });
    await pool.ensureAll();
    pool.enqueue(baseJob("res-giveup"));
    await waitForOutcomes(outcomes, 1);

    const o = outcomes[0];
    expect(o.kind).toBe("escalate");
    if (o.kind === "escalate") {
      expect(o.state).toBe("escalated");
      expect(o.reason).toBe("cannot reconcile");
    }
    expect(pool.leasedCount).toBe(0);
  });

  it("(c) timeout: runner incomplete reason timeout → escalate/escalated", async () => {
    const root = path.join(tmpRoot, "wt-c");
    const pmClient = makePmClient();
    const outcomes: ResolutionOutcome[] = [];
    const runner = makeRunner({
      result: { kind: "incomplete", reason: "timeout", durationMs: 60000 },
    });
    const pool = makePool({
      root,
      maxConcurrent: 1,
      pmClient,
      runner,
      verifyCommand: "exit 0",
      onOutcome: (o) => void outcomes.push(o),
    });
    await pool.ensureAll();
    pool.enqueue(baseJob("res-c"));
    await waitForOutcomes(outcomes, 1);

    const o = outcomes[0];
    expect(o.kind).toBe("escalate");
    if (o.kind === "escalate") {
      expect(o.state).toBe("escalated");
      expect(o.reason).toBe("budget_exceeded");
    }
    expect(pool.leasedCount).toBe(0);
  });

  it("(d) spawn_error: runner incomplete reason spawn_error → escalate/failed", async () => {
    const root = path.join(tmpRoot, "wt-d");
    const pmClient = makePmClient();
    const outcomes: ResolutionOutcome[] = [];
    const runner = makeRunner({
      result: { kind: "incomplete", reason: "spawn_error", durationMs: 5 },
    });
    const pool = makePool({
      root,
      maxConcurrent: 1,
      pmClient,
      runner,
      verifyCommand: "exit 0",
      onOutcome: (o) => void outcomes.push(o),
    });
    await pool.ensureAll();
    pool.enqueue(baseJob("res-d"));
    await waitForOutcomes(outcomes, 1);

    const o = outcomes[0];
    expect(o.kind).toBe("escalate");
    if (o.kind === "escalate") {
      expect(o.state).toBe("failed");
      expect(o.reason).toBe("spawn_error");
    }
    expect(pool.leasedCount).toBe(0);
  });

  it("start-before-fallible: startResolution precedes the runner in every case", async () => {
    const root = path.join(tmpRoot, "wt-order");
    const pmClient = makePmClient();
    const outcomes: ResolutionOutcome[] = [];
    const order = { value: 0 };
    // Patch the pmClient so startResolution stamps the shared order counter.
    const origStart = pmClient.startResolution.bind(pmClient);
    let startOrder = -1;
    (pmClient as { startResolution: typeof pmClient.startResolution }).startResolution = async (
      id: string,
    ) => {
      startOrder = order.value++;
      return origStart(id);
    };
    const runner = makeRunner({
      result: { kind: "incomplete", reason: "markers", durationMs: 5 },
      order,
    });
    const pool = makePool({
      root,
      maxConcurrent: 1,
      pmClient,
      runner,
      verifyCommand: "exit 0",
      onOutcome: (o) => void outcomes.push(o),
    });
    await pool.ensureAll();
    pool.enqueue(baseJob("res-order"));
    await waitForOutcomes(outcomes, 1);

    expect(startOrder).toBeGreaterThanOrEqual(0);
    expect(runner.ranAtOrder).toBeGreaterThanOrEqual(0);
    expect(startOrder).toBeLessThan(runner.ranAtOrder as number);
  });

  it("start-throws: startResolution rejects → no onOutcome, no escalate, slot released", async () => {
    const root = path.join(tmpRoot, "wt-startthrow");
    const pmClient = makePmClient();
    pmClient.setThrow();
    const outcomes: ResolutionOutcome[] = [];
    let runnerRan = false;
    const runner: ResolverRunner = {
      async run() {
        runnerRan = true;
        return { kind: "complete", durationMs: 1 };
      },
    };
    const pool = makePool({
      root,
      maxConcurrent: 1,
      pmClient,
      runner,
      verifyCommand: "exit 0",
      onOutcome: (o) => void outcomes.push(o),
    });
    await pool.ensureAll();
    pool.enqueue(baseJob("res-startthrow"));

    // Give the drain time to run + settle.
    await new Promise((r) => setTimeout(r, 500));

    expect(pmClient.startCalls.length).toBe(1); // it was attempted
    expect(runnerRan).toBe(false); // abandoned before the runner
    expect(outcomes.length).toBe(0); // no onOutcome
    expect(pool.leasedCount).toBe(0); // slot released
  });

  it("slot released even when onOutcome throws (no escape)", async () => {
    const root = path.join(tmpRoot, "wt-onout-throw");
    const pmClient = makePmClient();
    const runner = makeRunner({
      result: { kind: "incomplete", reason: "markers", durationMs: 5 },
    });
    let sawOutcome = false;
    const pool = makePool({
      root,
      maxConcurrent: 1,
      pmClient,
      runner,
      verifyCommand: "exit 0",
      onOutcome: () => {
        sawOutcome = true;
        throw new Error("onOutcome boom");
      },
    });
    await pool.ensureAll();
    // If a throw escaped the fire-and-forget drain it would surface as an
    // unhandled rejection; the test simply asserting clean settle covers it.
    pool.enqueue(baseJob("res-onout"));
    await new Promise((r) => setTimeout(r, 800));

    expect(sawOutcome).toBe(true);
    expect(pool.leasedCount).toBe(0);
  });

  it("drain reentrancy: two jobs, one slot → both processed, none lost", async () => {
    const root = path.join(tmpRoot, "wt-reentry");
    const pmClient = makePmClient();
    const outcomes: ResolutionOutcome[] = [];
    const runner = makeRunner({
      result: { kind: "incomplete", reason: "markers", durationMs: 5 },
    });
    const pool = makePool({
      root,
      maxConcurrent: 1,
      pmClient,
      runner,
      verifyCommand: "exit 0",
      onOutcome: (o) => void outcomes.push(o),
    });
    await pool.ensureAll();
    pool.enqueue(baseJob("res-r1"));
    pool.enqueue({ ...baseJob("res-r2"), originRequestId: "req-2" });
    await waitForOutcomes(outcomes, 2);

    const ids = outcomes.map((o) => o.resolutionId).sort();
    expect(ids).toEqual(["res-r1", "res-r2"]);
    expect(pool.leasedCount).toBe(0);
  });
});
