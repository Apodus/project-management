/**
 * Resolver worktree pool + job queue + worker (Phase 7.6 Step 5 skeleton +
 * Step 6 worker).
 *
 * Mirrors `worktree-pool.ts` but is a SEPARATE pool dedicated to merge-conflict
 * resolution (design §3 / §5.2). It exists only when
 * `settings.integrator.resolver.enabled = true`; with the resolver off the pool
 * is never constructed and the train is byte-identical to 7.5.
 *
 * Two reasons this is its own module, not a flag on the verify pool:
 *   1. Sizing is independent — `resolver.max_concurrent` (design §3), not the
 *      verify `parallelism`.
 *   2. The worktrees must NOT collide on disk with verify-pool slots, so they
 *      carry a distinct `-resolver-<i>` name suffix (the verify pool uses
 *      `-<i>`). A resolution running in `<name>-resolver-0` and a verify member
 *      in `<name>-0` are different directories.
 *
 * Step 6 (THIS) implements the job PROCESSOR that drains the queue: per job it
 * transitions the resolution `pending → resolving` FIRST, materializes the
 * conflict in an isolated worktree, spawns an INJECTABLE headless resolver
 * bounded by budget (ONE attempt), runs the 7.5 verify pipeline with cache OFF
 * as the SOLE arbiter, and produces a `ResolutionOutcome` handed to an
 * `onOutcome` callback — the Step-7 seam (resubmit / escalate live in Step 7).
 * The verdict gate is verify-only: a clean agent run that fails verify
 * ESCALATES; the worker never trusts the model's self-assertion.
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWorktree, type Worktree } from "./worktree.js";
import type { GitOps } from "./git-ops.js";
import { runPipeline } from "./verify-pipeline.js";
import type { ResolverRunner } from "./resolver-runner.js";
import type { PmClient } from "./pm-client.js";
import type { Logger } from "./logger.js";
import type { MergeResolutionDetail, VerifyStep } from "@pm/shared";
import { errMessage } from "./loop.js";

const SYNTHETIC_STEP_ID = "verify";

/** A `file://` URL for the resolver log path (Windows-safe, mirrors loop.ts). */
function logUrlOf(logPath: string): string {
  try {
    return pathToFileURL(logPath).href;
  } catch {
    return "";
  }
}

/**
 * A single resolution job enqueued at the conflict seam (design §5.1). Carries
 * exactly what the Step-6 processor needs to reproduce the conflict the rebase
 * hit and run a bounded resolution attempt:
 *   - `resolutionId`     the PM `merge_resolutions` row id (state machine §4.3).
 *   - `originRequestId`  the request that conflicted (rejected `conflict`).
 *   - `conflictingFiles` the files git reported in conflict.
 *   - `baseSha`          live `main` HEAD the rebase was attempted onto.
 *   - `ref`              the origin branch/commit to replay.
 *   - `resource`         the lane.
 */
export interface ResolutionJob {
  resolutionId: string;
  originRequestId: string;
  conflictingFiles: string[];
  baseSha: string;
  ref: string;
  resource: string;
}

/**
 * The terminal outcome of one resolution attempt, handed to `onOutcome`. This is
 * the STEP-7 SEAM CONTRACT — Step 6 produces it; Step 7's `onOutcome` handler
 * consumes it (resubmit on `resolved`, escalate on `escalate`) and the
 * corresponding pm-client calls live in Step 7, NOT here.
 *
 *  - `resolved`: the agent produced a tree that PASSED the local verify gate
 *    (cache OFF — the sole arbiter). It carries the COMMITTED `resolvedCommitSha`
 *    and the live `worktreePath`. CRITICAL: the resolved commit exists ONLY in
 *    the resolver clone until Step 7 pushes it; Step 6 therefore keeps the
 *    worktree LEASED until `onOutcome` resolves (the slot is released in
 *    `processJob`'s finally, AFTER `await onOutcome`). Step 7's handler pushes
 *    the commit from `worktreePath`, then resubmits it as a linked new request.
 *  - `escalate`: resolution could not land. `state` distinguishes `escalated`
 *    (the model/verify couldn't — verify_failed / timeout / unresolved) from
 *    `failed` (the resolver itself broke — spawn_error / infra throw), per §4.3.
 */
export type ResolutionOutcome =
  | {
      kind: "resolved";
      resolutionId: string;
      job: ResolutionJob;
      resolvedCommitSha: string;
      worktreePath: string;
      detail: MergeResolutionDetail;
    }
  | {
      kind: "escalate";
      resolutionId: string;
      job: ResolutionJob;
      state: "escalated" | "failed";
      reason: string;
      detail: MergeResolutionDetail;
    };

/**
 * Worker dependencies (Step 6). The pmClient is narrowed to exactly
 * `startResolution` — the only PM call the worker itself makes (resolved/escalate
 * pm-client calls are Step 7, inside `onOutcome`).
 */
export interface ResolverWorkerDeps {
  pmClient: Pick<PmClient, "startResolution">;
  logger: Logger;
  /** Per-worktree GitOps factory (mirrors index.ts `makeGitOps`). */
  gitOps: (worktreePath: string) => GitOps;
  /** The 7.5 verify DAG (empty → synthetic single step over defaultVerifyCommand). */
  verifySteps: VerifyStep[];
  defaultVerifyCommand: string;
  verifyTimeoutSec: number;
  /** Injectable headless resolver (default `createClaudeResolverRunner`). */
  runner: ResolverRunner;
  /** Resolver budget (design §3): wall-clock cap + optional token cap. */
  timeBudgetSec: number;
  tokenBudget?: number;
  /**
   * The STEP-7 SEAM. Invoked with the terminal outcome BEFORE the slot is
   * released (the resolved path needs the worktree alive for Step 7's push).
   * Step 7 supplies the real handler (push + resubmit / escalate). A throw from
   * it is caught + logged; the slot is still released.
   */
  onOutcome?: (outcome: ResolutionOutcome) => Promise<void> | void;
}

export interface ResolverPoolOptions extends Partial<ResolverWorkerDeps> {
  worktreeRoot: string;
  /** The integrator worktree base name (e.g. `<slug>-integrator`). The pool
   *  appends a distinct `-resolver-<i>` suffix so slots never collide with the
   *  verify pool's `-<i>` slots on disk. */
  worktreeName: string;
  gitRepoUrl: string;
  gitRemote: string;
  gitMainBranch: string;
  /** `resolver.max_concurrent` (design §3). Pool size; clamped to ≥ 1. */
  maxConcurrent: number;
}

export interface ResolverPool {
  readonly size: number;
  readonly leasedCount: number;
  readonly queuedCount: number;
  ensureAll(): Promise<void>;
  acquire(): Worktree | null;
  release(wt: Worktree): void;
  repair(wt: Worktree): Promise<void>;
  /** Accept a job onto the in-memory queue (Step 5: accept + store). The
   *  Step-6 processor drains this. */
  enqueue(job: ResolutionJob): void;
  gc(): Promise<void>;
}

export function createResolverPool(opts: ResolverPoolOptions): ResolverPool {
  const root = opts.worktreeRoot.replace(/[\\/]+$/, "");
  const size = Math.max(1, Math.floor(opts.maxConcurrent));
  // Distinct suffix so resolver slots never collide with verify-pool slots.
  const slotPrefix = `${opts.worktreeName}-resolver-`;

  interface Slot {
    index: number;
    wt: Worktree;
    leased: boolean;
  }
  const slots: Slot[] = Array.from({ length: size }, (_, i) => ({
    index: i,
    leased: false,
    wt: createWorktree({
      worktreeRoot: root,
      worktreeName: `${slotPrefix}${i}`,
      gitRepoUrl: opts.gitRepoUrl,
      gitRemote: opts.gitRemote,
      gitMainBranch: opts.gitMainBranch,
    }),
  }));

  const byPath = new Map<string, Slot>(slots.map((s) => [s.wt.path, s]));

  // In-memory job queue (design §4 — the integrator owns resolution scheduling
  // in memory; `merge_resolutions` is the durable record). Step 5 only stores
  // jobs; the Step-6 processor drains them.
  const queue: ResolutionJob[] = [];

  async function ensureAll(): Promise<void> {
    for (const s of slots) await s.wt.ensureExists();
  }

  function acquire(): Worktree | null {
    const free = slots.find((s) => !s.leased);
    if (!free) return null;
    free.leased = true;
    return free.wt;
  }

  function release(wt: Worktree): void {
    const s = byPath.get(wt.path);
    if (s) s.leased = false;
  }

  async function repair(wt: Worktree): Promise<void> {
    const s = byPath.get(wt.path);
    if (!s) return;
    await s.wt.repair();
  }

  // ── Step-6 worker deps (optional on the options bag so Step-5 skeleton tests
  //    that omit them still construct a valid pool — those pools enqueue but,
  //    lacking a runner, never drain). The drain is gated on `worker` below. ──
  const worker: ResolverWorkerDeps | null =
    opts.runner && opts.pmClient && opts.logger && opts.gitOps
      ? {
          pmClient: opts.pmClient,
          logger: opts.logger,
          gitOps: opts.gitOps,
          verifySteps: opts.verifySteps ?? [],
          defaultVerifyCommand: opts.defaultVerifyCommand ?? "",
          verifyTimeoutSec: opts.verifyTimeoutSec ?? 600,
          runner: opts.runner,
          timeBudgetSec: opts.timeBudgetSec ?? 600,
          tokenBudget: opts.tokenBudget,
          onOutcome: opts.onOutcome,
        }
      : null;

  // The verify DAG to gate resolutions on: the configured steps, or a single
  // synthetic `verify` step over the default verify command (byte-identical to
  // the train's single-command fallback). Cache is ALWAYS off (cache: undefined).
  function buildVerifySteps(): VerifyStep[] {
    if (worker && worker.verifySteps.length > 0) return worker.verifySteps;
    return [
      {
        id: SYNTHETIC_STEP_ID,
        command: worker?.defaultVerifyCommand ?? "",
      } as VerifyStep,
    ];
  }

  // ── Drain machinery. A single `draining` flag serializes the fire-and-forget
  //    drain so two enqueues don't spawn two competing drains; it is re-kicked
  //    whenever a slot is released (a queued job may now have a slot). The drain
  //    acquires a slot per job or stops (leaving the job queued). ──
  let draining = false;

  function kickDrain(): void {
    if (!worker) return; // No worker wired (Step-5 skeleton) → accept-only.
    if (draining) return;
    draining = true;
    void drain().finally(() => {
      draining = false;
    });
  }

  async function drain(): Promise<void> {
    if (!worker) return;
    // Drain as many queued jobs as there are free slots. Each processed job
    // releases its slot + re-kicks the drain in its finally, so a job that
    // could not get a slot now (queue non-empty, all leased) is picked up the
    // moment a slot frees.
    for (;;) {
      if (queue.length === 0) return;
      const wt = acquire();
      if (!wt) return; // No free slot — wait for a release to re-kick.
      const job = queue.shift()!;
      // Fire-and-forget per job: each runs concurrently up to the pool size.
      void processJob(job, wt);
    }
  }

  async function processJob(job: ResolutionJob, wt: Worktree): Promise<void> {
    // The ENTIRE body is wrapped so NO throw escapes into the train (mirrors the
    // batch.ts non-fatal pattern). The slot is released in `finally` and the
    // drain re-kicked so a queued job advances.
    const w = worker!;
    try {
      // (a) startResolution FIRST — pending → resolving. If it THROWS, the row
      //     has no legal transition to escalated/failed (it is still pending),
      //     so we ABANDON the job WITHOUT escalating: log + return. The slot is
      //     released in finally; no onOutcome fires.
      try {
        await w.pmClient.startResolution(job.resolutionId);
      } catch (err) {
        w.logger.warn(
          { resolutionId: job.resolutionId, err: errMessage(err) },
          "startResolution failed; abandoning resolution job (row stays pending)",
        );
        return;
      }

      const outcome = await runResolution(job, wt, w);

      // (c) Hand the outcome to the Step-7 seam BEFORE release (the resolved
      //     path needs the worktree alive for Step 7's push). A throw from
      //     onOutcome is caught + logged; the slot is STILL released in finally.
      if (w.onOutcome) {
        try {
          await w.onOutcome(outcome);
        } catch (err) {
          w.logger.error(
            { resolutionId: job.resolutionId, err: errMessage(err) },
            "resolver onOutcome handler threw (non-fatal; slot released)",
          );
        }
      }
    } catch (err) {
      // Defense-in-depth: runResolution already converts infra throws into a
      // `failed` outcome, so reaching here is unexpected. Never let it escape.
      w.logger.error(
        { resolutionId: job.resolutionId, err: errMessage(err) },
        "resolver processJob threw unexpectedly (swallowed)",
      );
    } finally {
      release(wt);
      kickDrain();
    }
  }

  /**
   * The resolution attempt proper (§5.2). Materialize the conflict, run the
   * INJECTABLE headless resolver (one attempt), and — on a clean agent run —
   * commit the resolution and gate it on the 7.5 verify pipeline with cache OFF
   * (the SOLE arbiter). Returns a ResolutionOutcome; converts ANY infra throw
   * into a `failed` escalate outcome (never throws).
   */
  async function runResolution(
    job: ResolutionJob,
    wt: Worktree,
    w: ResolverWorkerDeps,
  ): Promise<ResolutionOutcome> {
    try {
      const gitOps = w.gitOps(wt.path);
      // Reset the slot to clean live main, then reproduce the conflict in place.
      await wt.resetForAttempt();
      const { conflictingFiles } = await gitOps.materializeConflict(
        job.baseSha,
        job.ref,
      );
      // Prefer the freshly-observed conflicting files; fall back to the job's
      // (the rebase-seam capture) when the replay reported none.
      const files = conflictingFiles.length
        ? conflictingFiles
        : job.conflictingFiles;

      const verifyCommand =
        w.verifySteps.length > 0
          ? w.verifySteps.map((s) => s.command).join(" && ")
          : w.defaultVerifyCommand;

      const logPath = path.join(
        wt.logsDir,
        `${job.resolutionId}-resolver.log`,
      );

      const result = await w.runner.run({
        worktreePath: wt.path,
        conflictingFiles: files,
        verifyCommand,
        budget: {
          timeBudgetSec: w.timeBudgetSec,
          tokenBudget: w.tokenBudget,
        },
        logPath,
      });

      if (!result.ok) {
        // The agent could not produce a clean tree. spawn_error → the resolver
        // itself broke (`failed`); timeout / unresolved → the model couldn't
        // (`escalated`). §4.3.
        const state: "escalated" | "failed" =
          result.reason === "spawn_error" ? "failed" : "escalated";
        const reason =
          result.reason === "timeout"
            ? "budget_exceeded"
            : result.reason === "spawn_error"
              ? "spawn_error"
              : "unresolved";
        return {
          kind: "escalate",
          resolutionId: job.resolutionId,
          job,
          state,
          reason,
          detail: {
            budgetConsumedSec: result.durationMs / 1000,
            escalationReason: result.detail ?? reason,
            ...(logUrlOf(logPath) ? { logUrl: logUrlOf(logPath) } : {}),
          },
        };
      }

      // The agent reports a clean tree. COMMIT the resolution (completes the
      // in-progress rebase non-interactively with explicit identity) so a real
      // commit sha exists, then gate it on verify (cache OFF — the sole arbiter).
      const resolvedCommitSha = await gitOps.commitResolution();

      const pipeline = await runPipeline(buildVerifySteps(), {
        gitOps,
        cwd: wt.path,
        verifyTimeoutSec: w.verifyTimeoutSec,
        logsDir: wt.logsDir,
        attemptId: `resolution-${job.resolutionId}`,
        // cache: undefined → cache OFF. A resolution is novel; verify is the
        // sole arbiter and we neither read nor pollute the cache here (the same
        // stance as group orphan-recovery in 7.5).
        cache: undefined,
        logger: w.logger,
      });

      const verifyVerdict: "pass" | "fail" =
        pipeline.outcome === "pass" ? "pass" : "fail";

      if (verifyVerdict === "pass") {
        return {
          kind: "resolved",
          resolutionId: job.resolutionId,
          job,
          resolvedCommitSha,
          worktreePath: wt.path,
          detail: {
            budgetConsumedSec: result.durationMs / 1000,
            ...(result.tokensConsumed !== undefined
              ? { tokensConsumed: result.tokensConsumed }
              : {}),
            verifyVerdict,
            ...(logUrlOf(logPath) ? { logUrl: logUrlOf(logPath) } : {}),
          },
        };
      }

      // Clean tree but verify FAILED → escalate (escalated, verify_failed). The
      // model reconciled the markers but broke the build/tests — honest "too
      // hard". Verify is the only arbiter; the agent's "ok" does NOT land.
      return {
        kind: "escalate",
        resolutionId: job.resolutionId,
        job,
        state: "escalated",
        reason: "verify_failed",
        detail: {
          budgetConsumedSec: result.durationMs / 1000,
          verifyVerdict,
          escalationReason: "verify_failed",
          ...(logUrlOf(logPath) ? { logUrl: logUrlOf(logPath) } : {}),
        },
      };
    } catch (err) {
      // Any infra throw (worktree reset, materialize, commit, verify spawn) →
      // `failed` escalate. The origin is already cleanly rejected; main is never
      // touched. Never propagate.
      return {
        kind: "escalate",
        resolutionId: job.resolutionId,
        job,
        state: "failed",
        reason: "infra_error",
        detail: { escalationReason: errMessage(err) },
      };
    }
  }

  function enqueue(job: ResolutionJob): void {
    queue.push(job);
    // Kick a fire-and-forget drain (guarded by `draining`). With no worker wired
    // (Step-5 skeleton) this is a no-op accept-only store, preserving the inert
    // default. With a worker, the drain acquires a slot and processes the job
    // off-lane (the lane lock was already released before enqueue — §5.1).
    kickDrain();
  }

  async function gc(): Promise<void> {
    const valid = new Set(slots.map((s) => path.basename(s.wt.path)));
    let entries: string[];
    try {
      entries = await readdir(path.normalize(root));
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(slotPrefix) || valid.has(name)) continue;
      const suffix = name.slice(slotPrefix.length);
      if (!/^\d+$/.test(suffix)) continue;
      const full = path.join(path.normalize(root), name);
      try {
        if ((await stat(full)).isDirectory()) {
          await rm(full, { recursive: true, force: true });
        }
      } catch {
        // best-effort cleanup
      }
    }
  }

  return {
    size,
    get leasedCount() {
      return slots.filter((s) => s.leased).length;
    },
    get queuedCount() {
      return queue.length;
    },
    ensureAll,
    acquire,
    release,
    repair,
    enqueue,
    gc,
  };
}
