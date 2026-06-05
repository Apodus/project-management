/**
 * Phase 7.6.1 — resolver-loop END-TO-END integration (P5 campaign seal).
 *
 * Wires the REAL resolver pool (`createResolverPool`) to the REAL onOutcome
 * handler (`makeOnOutcome`, resolution-outcome.ts) and drains a job through the
 * whole seam: pool → runResolution → onOutcome → resubmit | escalate. The only
 * fakes are the LEAVES:
 *   - the INJECTABLE `ResolverRunner` (scripts the agent's terminal result —
 *     `complete` ⇒ verified-in-session, `give_up` ⇒ author decision needed),
 *   - the worktree module (mocked to noop ensureExists/resetForAttempt so NO real
 *     git clone runs — the conflict + commit are produced by the fake gitOps),
 *   - the gitOps factory the pool uses (materializeConflict → files,
 *     commitResolution → sha),
 *   - the gitOps factory the onOutcome handler uses for the push (push → ok),
 *   - the pmClient (vi.fn recorders so we can assert the exact resubmit / escalate
 *     wiring).
 *
 * This is a campaign cross-check that the in-session loop's resolved/escalate
 * paths are wired end-to-end. The exhaustive pool-internal suite is
 * resolver-worker.test.ts (real git) and the reclaim sweep's exhaustive suite is
 * reclaim-resolutions.test.ts (P4); case 3 here is a deliberate cross-check of
 * the reclaim direction, not a re-derivation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock the worktree module so the pool builds fake worktrees (no real git
//    clone). ensureExists / resetForAttempt are noops; path + logsDir are stable
//    per-slot strings. The conflict + commit are produced by the injected
//    gitOps factory, so the worktree itself never touches git. ──
vi.mock("../src/worktree.js", () => {
  return {
    createWorktree: (opts: { worktreeRoot: string; worktreeName: string }) => {
      const wtPath = `${opts.worktreeRoot}/${opts.worktreeName}`;
      return {
        path: wtPath,
        logsDir: `${wtPath}/logs`,
        async ensureExists() {
          /* noop — no clone */
        },
        async resetForAttempt() {
          /* noop — fake gitOps materializes the conflict */
        },
        async repair() {
          /* noop */
        },
      };
    },
  };
});

import { createResolverPool, type ResolutionOutcome } from "../src/resolver-pool.js";
import { makeOnOutcome } from "../src/resolution-outcome.js";
import { reclaimResolvingResolutions } from "../src/reclaim-resolutions.js";
import type { ResolverRunner, ResolverRunResult } from "../src/resolver-runner.js";
import type { GitOps, MaterializeConflictResult, PushResult } from "../src/git-ops.js";
import { createLogger } from "../src/logger.js";
import type { MergeRequestDetailView } from "../src/pm-client.js";
import type { MergeRequestView, MergeResolutionView } from "@pm/shared";

const logger = createLogger("error");

const ORIGIN_VERIFY_CMD = "pnpm verify:special"; // sentinel to assert propagation
const PROJECT_ID = "proj-1";

/** A fake injectable runner that returns the scripted terminal result. */
function makeRunner(result: ResolverRunResult): ResolverRunner {
  return {
    async run(): Promise<ResolverRunResult> {
      return result;
    },
  };
}

/** A fake gitOps the POOL uses: materializeConflict → files, commitResolution
 *  → a stable sha. Only the two methods runResolution touches are real. */
function makePoolGitOps(): Pick<GitOps, "materializeConflict" | "commitResolution"> {
  return {
    async materializeConflict(): Promise<MaterializeConflictResult> {
      return { conflictingFiles: ["feature.txt"] };
    },
    async commitResolution(): Promise<string> {
      return "resolvedsha0000000000000000000000000000";
    },
  };
}

/** A fake origin merge request the onOutcome handler fetches (for taskId +
 *  verifyCmd). The verifyCmd sentinel MUST propagate to the resubmit. */
function makeOrigin(): MergeRequestDetailView {
  return {
    id: "req-origin",
    projectId: PROJECT_ID,
    resource: "main",
    taskId: "task-1",
    status: "rejected",
    submittedBy: "worker-1",
    branch: "feature/collide",
    commitSha: null,
    verifyCmd: ORIGIN_VERIFY_CMD,
    resolvedFrom: null,
    groupId: null,
    landedSha: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: [],
  } as unknown as MergeRequestDetailView;
}

interface PmFakes {
  startResolution: ReturnType<typeof vi.fn>;
  getMergeRequest: ReturnType<typeof vi.fn>;
  submitMergeRequest: ReturnType<typeof vi.fn>;
  resolvedResolution: ReturnType<typeof vi.fn>;
  escalateResolution: ReturnType<typeof vi.fn>;
  postTaskComment: ReturnType<typeof vi.fn>;
}

function makePmFakes(over: Partial<PmFakes> = {}): PmFakes {
  return {
    startResolution: over.startResolution ?? vi.fn(async () => ({}) as MergeResolutionView),
    getMergeRequest: over.getMergeRequest ?? vi.fn(async () => makeOrigin()),
    submitMergeRequest:
      over.submitMergeRequest ??
      vi.fn(async () => ({ id: "req-resolved-new" }) as unknown as MergeRequestView),
    resolvedResolution: over.resolvedResolution ?? vi.fn(async () => ({}) as MergeResolutionView),
    escalateResolution: over.escalateResolution ?? vi.fn(async () => ({}) as MergeResolutionView),
    postTaskComment: over.postTaskComment ?? vi.fn(async () => undefined),
  };
}

/** Build the real onOutcome handler over the fakes + a fake push gitOps. */
function makeRealOnOutcome(fakes: PmFakes): (o: ResolutionOutcome) => Promise<void> {
  return makeOnOutcome({
    pmClient: {
      getMergeRequest: fakes.getMergeRequest as unknown as never,
      submitMergeRequest: fakes.submitMergeRequest as unknown as never,
      resolvedResolution: fakes.resolvedResolution as unknown as never,
      escalateResolution: fakes.escalateResolution as unknown as never,
      postTaskComment: fakes.postTaskComment as unknown as never,
    },
    // The push gitOps factory (onOutcome's makeGitOps): push always succeeds.
    makeGitOps: () => ({
      async push(): Promise<PushResult> {
        return { ok: true, pushedSha: "pushedsha000000000000000000000000000000" };
      },
    }),
    logger,
    cfg: { projectId: PROJECT_ID, gitRemote: "origin" },
  });
}

/**
 * Build a real pool wired with the injectable runner + real onOutcome, enqueue
 * ONE job, and await drain quiescence (no leased slots, empty queue).
 */
async function runOneJob(args: {
  runner: ResolverRunner;
  onOutcome: (o: ResolutionOutcome) => Promise<void>;
  startResolution: ReturnType<typeof vi.fn>;
}): Promise<void> {
  const pool = createResolverPool({
    worktreeRoot: "/tmp/pm-resolver-loop-e2e",
    worktreeName: "wt",
    gitRepoUrl: "file:///dev/null",
    gitRemote: "origin",
    gitMainBranch: "main",
    cleanKeep: [],
    maxConcurrent: 1,
    // The pool's OWN startResolution (the worker's first, before-fallible call).
    pmClient: { startResolution: args.startResolution as unknown as never },
    logger,
    // The pool's per-worktree gitOps factory (materializeConflict + commit).
    gitOps: () => makePoolGitOps() as unknown as GitOps,
    verifySteps: [],
    defaultVerifyCommand: "pnpm verify",
    runner: args.runner,
    timeBudgetSec: 3600,
    onOutcome: args.onOutcome,
  });
  await pool.ensureAll();
  pool.enqueue({
    resolutionId: "res-loop-1",
    originRequestId: "req-origin",
    conflictingFiles: ["feature.txt"],
    baseSha: "basesha00000000000000000000000000000000",
    ref: "origin/feature/collide",
    resource: "main",
  });

  // Await drain quiescence: poll until the queue drains AND no slot is leased.
  const start = Date.now();
  while (pool.queuedCount > 0 || pool.leasedCount > 0) {
    if (Date.now() - start > 10_000) {
      throw new Error(
        `drain did not quiesce (queued=${pool.queuedCount} leased=${pool.leasedCount})`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  // One extra microtask flush so the trailing onOutcome promise settles.
  await new Promise((r) => setTimeout(r, 25));
}

describe("resolver loop e2e (real pool + real onOutcome, fake leaves)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(1) complete → resolved → resubmit with origin.verifyCmd + resolvedFrom, recorded", async () => {
    const fakes = makePmFakes();
    await runOneJob({
      runner: makeRunner({ kind: "complete", durationMs: 1000 }),
      onOutcome: makeRealOnOutcome(fakes),
      startResolution: fakes.startResolution,
    });

    // startResolution ran (the worker's first, before-fallible call).
    expect(fakes.startResolution).toHaveBeenCalledWith("res-loop-1");

    // submitMergeRequest called ONCE, carrying resolvedFrom === origin AND
    // verifyCmd === the sentinel origin.verifyCmd (the load-bearing propagation).
    expect(fakes.submitMergeRequest).toHaveBeenCalledTimes(1);
    const submitArg = fakes.submitMergeRequest.mock.calls[0][0];
    expect(submitArg.resolvedFrom).toBe("req-origin");
    expect(submitArg.verifyCmd).toBe(ORIGIN_VERIFY_CMD);
    expect(submitArg.taskId).toBe("task-1");

    // resolvedResolution cross-links the NEW request.
    expect(fakes.resolvedResolution).toHaveBeenCalledTimes(1);
    expect(fakes.resolvedResolution.mock.calls[0][0]).toBe("res-loop-1");
    expect(fakes.resolvedResolution.mock.calls[0][1]).toMatchObject({
      resolvedRequestId: "req-resolved-new",
    });

    // The resolved path NEVER escalates or comments.
    expect(fakes.escalateResolution).not.toHaveBeenCalled();
    expect(fakes.postTaskComment).not.toHaveBeenCalled();
  });

  it("(2) give_up → escalate (escalated/author) + merge_rejection comment, no resubmit", async () => {
    const fakes = makePmFakes();
    await runOneJob({
      runner: makeRunner({ kind: "give_up", reason: "needs an author decision", durationMs: 5 }),
      onOutcome: makeRealOnOutcome(fakes),
      startResolution: fakes.startResolution,
    });

    // escalateResolution: escalated → author, carrying the agent's stated reason.
    expect(fakes.escalateResolution).toHaveBeenCalledTimes(1);
    expect(fakes.escalateResolution.mock.calls[0][0]).toBe("res-loop-1");
    expect(fakes.escalateResolution.mock.calls[0][1]).toMatchObject({
      state: "escalated",
      target: "author",
      reason: "needs an author decision",
    });

    // A merge_rejection comment is posted on the origin task.
    expect(fakes.postTaskComment).toHaveBeenCalledTimes(1);
    expect(fakes.postTaskComment.mock.calls[0][0]).toBe("task-1");
    expect(fakes.postTaskComment.mock.calls[0][1]).toMatchObject({
      commentType: "merge_rejection",
    });

    // The escalate path NEVER resubmits or records resolved.
    expect(fakes.submitMergeRequest).not.toHaveBeenCalled();
    expect(fakes.resolvedResolution).not.toHaveBeenCalled();
  });

  // ── (3) reclaim cross-check (DIRECT, not via the pool) ────────────────────
  // The fake runner CANNOT strand a `resolving` row (every terminal outcome the
  // pool produces resolves or escalates the row). So the reclaim sweep is
  // cross-checked DIRECTLY here, with a fixed clock past the deadline. The
  // exhaustive reclaim suite is reclaim-resolutions.test.ts (P4) — this is a
  // campaign cross-check of the two reconcile directions only.
  describe("(3) reclaim sweep cross-check", () => {
    const NOW = 10_000_000_000;
    const TIME_BUDGET_SEC = 3600; // budgetMs 3_600_000, grace max(120k, 0.25*=900k)=900k
    const PAST_DEADLINE = new Date(NOW - 5_000_000).toISOString(); // > deadline

    function strandedResolving(): MergeResolutionView {
      return {
        id: "res-stranded",
        projectId: PROJECT_ID,
        resource: "main",
        originRequestId: "req-origin",
        resolvedRequestId: null,
        state: "resolving",
        conflictingFiles: ["feature.txt"],
        attemptStartedAt: PAST_DEADLINE,
        attemptEndedAt: null,
        escalationTarget: null,
        detail: null,
        createdAt: PAST_DEADLINE,
        updatedAt: PAST_DEADLINE,
      } as MergeResolutionView;
    }

    it("(3a) resubmission EXISTS → reconcile to resolved, no escalate", async () => {
      const resolvedResolution = vi.fn(async () => ({}));
      const escalateResolution = vi.fn(async () => ({}));
      const result = await reclaimResolvingResolutions({
        pmClient: {
          listResolutions: vi.fn(async () => [strandedResolving()]),
          listMergeRequests: vi.fn(async () => [
            { id: "req-resub", resolvedFrom: "req-origin" } as unknown as MergeRequestView,
          ]),
          resolvedResolution,
          escalateResolution,
          getMergeRequest: vi.fn(async () => makeOrigin()),
          postTaskComment: vi.fn(async () => undefined),
        } as unknown as never,
        logger,
        projectId: PROJECT_ID,
        resource: "main",
        timeBudgetSec: TIME_BUDGET_SEC,
        now: () => NOW,
      });

      expect(resolvedResolution).toHaveBeenCalledWith("res-stranded", {
        resolvedRequestId: "req-resub",
      });
      expect(escalateResolution).not.toHaveBeenCalled();
      expect(result).toMatchObject({ scanned: 1, reconciled: 1, escalated: 0 });
    });

    it("(3b) NO resubmission → escalate failed/session_died_or_timeout + comment", async () => {
      const escalateResolution = vi.fn(async () => ({}));
      const postTaskComment = vi.fn(async () => undefined);
      const result = await reclaimResolvingResolutions({
        pmClient: {
          listResolutions: vi.fn(async () => [strandedResolving()]),
          listMergeRequests: vi.fn(async () => []),
          resolvedResolution: vi.fn(async () => ({})),
          escalateResolution,
          getMergeRequest: vi.fn(async () => makeOrigin()),
          postTaskComment,
        } as unknown as never,
        logger,
        projectId: PROJECT_ID,
        resource: "main",
        timeBudgetSec: TIME_BUDGET_SEC,
        now: () => NOW,
      });

      expect(escalateResolution).toHaveBeenCalledWith("res-stranded", {
        state: "failed",
        target: "author",
        reason: "session_died_or_timeout",
      });
      expect(postTaskComment).toHaveBeenCalledWith(
        "task-1",
        expect.objectContaining({ commentType: "merge_rejection" }),
      );
      expect(result).toMatchObject({ scanned: 1, escalated: 1, reconciled: 0 });
    });
  });
});
