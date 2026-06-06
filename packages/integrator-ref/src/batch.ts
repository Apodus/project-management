/**
 * Single-member-at-a-time batch scheduler (phase 7.2 Step 4).
 *
 * Subsumes 7.1's `runOnce` for the N=1 case but hoists the lane lock to BATCH
 * scope (design §9): the lock is acquired once when a batch starts and released
 * once when the batch drains, with a single batch-lifetime heartbeat. The
 * per-member machinery (pickup → reset → speculative base → startAttempt →
 * rebase → verify → land) mirrors `loop.ts` exactly so the per-member behavior
 * is byte-identical to runOnce for N=1; `loop.ts` remains the live path and the
 * behavioral oracle.
 *
 * This file is net-new scaffolding. Steps 5/6/8 grow it at the marked seams
 * (`computeSpeculativeBase` → predecessor chaining; `onMemberFailed` → suffix
 * invalidation; retry policy). It deliberately carries ONLY the fields and code
 * paths the single-member case needs — no `verifyHandle`/`retryCount` (Step 5/8)
 * and no multi-member concurrency.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import type { GitOps } from "./git-ops.js";
import type { Worktree } from "./worktree.js";
import type { CacheMode, MergeRequestView, VerifyStep, VerifyStepResult } from "@pm/shared";
import { type PmClient } from "./pm-client.js";
import { categorize, classifyVerifyFailure } from "./categorize.js";
import { runPipeline, toVerifyStepResults } from "./verify-pipeline.js";
import { isApiError, errMessage } from "./loop.js";
import {
  runGroupIntegration,
  type RepoLane,
  type GroupIntegrationOutcome,
} from "./group-integration.js";
import { landAssembledGroup, type GroupLandResult } from "./group-land.js";
import { recoverOrphanedInner, type RecoverResult } from "./group-recovery.js";
import { reclaimResolvingResolutions } from "./reclaim-resolutions.js";

const LOG_EXCERPT_CAP = 4096;

// Verify-retry policy defaults (design §10.2). The cap is 3 retries per member.
// The backoff schedule is the authoritative literal 1s / 5s / 15s (design §10.2).
const DEFAULT_MAX_VERIFY_RETRIES = 3;
const VERIFY_RETRY_BACKOFF_MS = [1000, 5000, 15000] as const;

// ─── In-memory batch model (design §3.1) ──────────────────────────

export type MemberState =
  | "pending" // admitted, not yet rebased
  | "rebasing" // rebase onto speculative base in progress
  | "verifying" // runVerify spawned
  | "verified" // verify passed; waiting for land-gate (predecessors)
  | "failed" // verify non-zero OR rebase conflict → rejected (terminal)
  | "invalidated" // a predecessor failed; speculation void → re-admit
  | "landed"; // pushed to main + PM land() succeeded (terminal)

/**
 * The speculative base a member rebased on top of. `liveMainSha` is the `main`
 * HEAD member 0 anchored to. `predecessorChain` is the ordered list of the
 * members this one assumes land *before* it — it IS the structural dependency
 * set (design §4, §7). For member 0 the chain is empty.
 */
export interface SpeculativeBase {
  liveMainSha: string;
  predecessorChain: { requestId: string; rebasedTreeSha: string }[];
}

/**
 * A killable in-flight verify (phase 7.2 Step 6). `done` is the settle promise
 * the drain loop races; `kill()` aborts the verify child's process tree (via the
 * `AbortSignal` → git-ops `killTree` seam) so a failed predecessor can tear down
 * a still-running suffix verify. A killed verify resolves `done` cleanly (the
 * killed child exits → git-ops `finish()` resolves), so the race is unaffected.
 */
export interface VerifyHandle {
  done: Promise<void>;
  kill: () => void;
}

export interface Member {
  request: MergeRequestView;
  speculativePosition: number; // strictly-monotonic admission index (never reused)
  state: MemberState;
  worktree: Worktree | null; // leased slot; null once freed
  base: SpeculativeBase | null;
  rebasedTreeSha: string | null; // this member's rebased HEAD; base for K+1
  landedSha: string | null;
  attemptId: string | null; // current open attempt
  predecessorChain: { requestId: string; rebasedTreeSha: string }[];
  /**
   * STEP 8 (design §10): count of transient verify retries already taken for
   * this member IN PLACE (same base, same worktree). Initialized to 0 at
   * admission. Once it reaches `maxVerifyRetries` a further transient failure is
   * treated as REAL (reject + suffix-invalidate).
   */
  retryCount: number;
  /**
   * PHASE 7.5 (design §7.3): the per-step pipeline results from this member's
   * most recent verify pass, mapped to the wire VerifyStepResult[] shape. The
   * pipeline runs in runVerifyTask but the passing completeAttempt fires at
   * land, so the slot bridges that gap. Null at admission / until the first
   * pipeline pass settles. Single slot is correct for single-repo: a verified
   * member never re-runs runPipeline before land, and a transient-fail completes
   * its own attempt synchronously with its run's steps before any overwrite.
   */
  steps: VerifyStepResult[] | null;
  /**
   * The in-flight rebase+verify task for this member (null until launched and
   * again once it settles — the settled task clears this in a `finally`). The
   * `verify === null`-on-settle convention is the source of truth the drain
   * loop uses to rebuild its in-flight set, so no separate promise bookkeeping
   * is needed.
   *
   * STEP 6: this is a `VerifyHandle` carrying a `kill()` for suffix invalidation
   * (so a failed predecessor can tear down a still-running suffix verify). The
   * `verify === null`-on-settle convention is preserved — the settled task clears
   * this in a `finally`.
   */
  verify: VerifyHandle | null;
}

export interface Batch {
  batchId: string; // integrator-minted
  projectId: string;
  resource: string;
  members: Member[]; // ordered by speculativePosition
  lockHeld: boolean; // true once acquireLock returned held/already_held
  createdAt: string; // ISO 8601
  /**
   * Strictly-monotonic admission counter. Each admitted member takes the next
   * value as its `speculativePosition`; the counter NEVER decrements or reuses
   * an index, so a failed member (left in `members` until Step 6 compaction)
   * can never collide with a later admission's position. Predecessor lookups
   * derive from the SURVIVING prefix (see `survivingPredecessor`), not from
   * `position - 1`, so stale failed positions don't corrupt the chain.
   */
  nextPosition: number;
}

// ─── Batch marker events (design §13.2 — Step-7 SEAM) ─────────────

/**
 * The four batch-marker event payloads (design §13.2). Field names match the
 * design table exactly. Step 6 only ADDS the `onBatchEvent` emission seam; the
 * PM relay endpoint, `EVENT_NAMES` additions, and `batchId`/`speculativePosition`
 * tagging on pickup/startAttempt are ALL Step 7. When `onBatchEvent` is absent
 * every call site is a no-op.
 */
export type BatchEvent =
  | {
      type: "started";
      batchId: string;
      resource: string;
      memberCount: number;
      memberRequestIds: string[];
    }
  | {
      type: "member_landed";
      batchId: string;
      requestId: string;
      speculativePosition: number;
      landedSha: string;
    }
  | {
      type: "member_invalidated";
      batchId: string;
      requestId: string;
      speculativePosition: number;
      reason: string;
      failedPredecessorRequestId: string;
    }
  | {
      type: "completed";
      batchId: string;
      landed: number;
      rejected: number;
      invalidated: number;
    };

// ─── Dependencies + outcome types ─────────────────────────────────

/**
 * Mirrors `RunOnceDeps` in loop.ts but with the lane lock hoisted to batch
 * scope and `gitOps` provided as a FACTORY: each member runs in its own pool
 * worktree, so the scheduler builds a `GitOps` bound to that worktree's path.
 */
export interface BatchDeps {
  pmClient: PmClient;
  pool: WorktreePool;
  gitOps: (worktreePath: string) => GitOps;
  logger: Logger;
  projectId: string;
  resource: string;
  defaultVerifyCommand: string;
  verifyTimeoutSec: number;
  gitRemote: string;
  gitMainBranch: string;
  /** Override the batch-id minter (tests). Defaults to a random UUID. */
  newBatchId?: () => string;
  /** Lock heartbeat cadence; defaults to 60s (design §9.2). */
  heartbeatIntervalMs?: number;
  /**
   * STEP 8 (design §10.2): max transient verify retries per member before a
   * transient failure is treated as real. Defaults to
   * `DEFAULT_MAX_VERIFY_RETRIES` (3).
   */
  maxVerifyRetries?: number;
  /**
   * STEP 8 (design §10.2): the literal retry-backoff schedule. The Kth retry
   * (1-indexed) waits `retryBackoffMs[K - 1]` ms (clamped to the last entry once
   * K exceeds the array length). Defaults to `VERIFY_RETRY_BACKOFF_MS`
   * ([1000, 5000, 15000] → 1s / 5s / 15s).
   */
  retryBackoffMs?: number[];
  /**
   * PHASE 7.5 Step 5: the project's verify_steps DAG (design §2.1/§8.1). When
   * present AND non-empty, `runVerifyTask` runs the DAG via `runPipeline`
   * instead of the single `verify_command`. Empty / absent → the synthetic
   * single-step fallback over `verifyCommand` (byte-identical to 7.4).
   */
  verifySteps?: VerifyStep[];
  /**
   * PHASE 7.5 Step 6 (design §4.2/§4.3): the verify-cache kill-switch + mode.
   * When `cacheEnabled` is true AND `cacheMode !== "off"`, the pipeline runs
   * cache-aware (lookup/record/shadow, §5.3); otherwise it is the byte-identical
   * off-path. Absent/false → no cache (the shipped default). Threaded into BOTH
   * the single-repo runVerifyTask cache ctx and the group lane's per-repo ctx.
   */
  cacheEnabled?: boolean;
  cacheMode?: CacheMode;
  /**
   * STEP-7 SEAM (design §13.2): optional batch-marker sink. Step 6 emits the
   * four markers (`started`/`member_landed`/`member_invalidated`/`completed`)
   * here; Step 7 wires this to the PM relay endpoint. No-op when absent.
   */
  onBatchEvent?: (event: BatchEvent) => void;
  /**
   * PHASE 7.4 §3.2 (Step 12): the shared, MUTABLE in-flight counters the
   * heartbeat (`index.ts`) reads to mint the `in_flight` payload + derive
   * `status`. The single-threaded loop mutates this synchronously (no races):
   * `runBatchOnce` sets `batches=1` after the lock is held and recomputes
   * `requests` each drain pass; `runGroupLaneOnce` sets `groups=1` while
   * integrating. BOTH reset their fields to 0 in their `finally` so a throw can
   * never leave the status stuck "integrating". Absent (tests) → no-op.
   */
  inFlight?: { requests: number; batches: number; groups: number };
  /**
   * PHASE 7.6 Step 5 (design §5.1): the conflict-resolution seam. Present ONLY
   * when `settings.integrator.resolver.enabled` (index.ts constructs the
   * resolver pool and the open+enqueue handle only then). Absent / `enabled:
   * false` ⇒ the conflict path is byte-identical to 7.5 (plain `conflict`
   * reject, no resolution opened). `openAndEnqueue` is the NON-FATAL handle:
   * it opens a PM resolution row and enqueues a job onto the resolver pool —
   * a throw inside it MUST NOT propagate (the origin is already cleanly
   * rejected as a plain conflict). See `maybeOpenResolution`.
   */
  resolver?: {
    enabled: boolean;
    /**
     * Open a resolution (PM `pending` row + `merge.resolution.pending`) for the
     * origin request, then enqueue the resolution job onto the resolver pool.
     * Returns the resolution id on success. MUST be non-fatal: any throw is
     * caught + logged inside `maybeOpenResolution`, never surfaced.
     */
    openAndEnqueue: (args: {
      originRequestId: string;
      conflictingFiles: string[];
      baseSha: string;
      ref: string;
    }) => Promise<string>;
  };
}

// ─── Phase 7.6 conflict-resolution seam (design §5.1) ─────────────
//
// Called from BOTH conflict-reject sites (batch.ts onMemberFailed + loop.ts) —
// AFTER the origin is rejected `conflict` and the lane lock / slot is released,
// BEFORE invalidateSuffix / return. Gated on `resolver.enabled`: with the
// resolver off this is a no-op and the path is byte-identical to 7.5.
//
// REQUIRED-FIX (non-fatal): the openResolution + enqueue is wrapped in
// try/catch HERE. On any throw we log a warning and CONTINUE — the origin is
// already cleanly rejected as a plain conflict; the resolution simply doesn't
// open. A throw must NEVER escape this function: in the batch path it would
// reach the drain-loop catch (~1202) and tear down healthy in-flight
// predecessor verifies. This matches the established non-fatal-I/O pattern
// (heartbeat / onBatchEvent .catch in index.ts; releaseLock catch ~1027).
export async function maybeOpenResolution(
  deps: Pick<BatchDeps, "resolver" | "logger">,
  args: {
    projectId: string;
    resource: string;
    originRequestId: string;
    conflictingFiles: string[];
    baseSha: string;
    ref: string;
    /**
     * Phase 7.6 §5.4 no-recursion guard: the origin request's `resolvedFrom`.
     * Non-null ⇒ the origin is ITSELF a resolution product (a resubmitted
     * resolved tree). A conflict on it must NOT spin another resolution —
     * otherwise a chronically-conflicting change loops the resolver forever.
     * We skip + log instead.
     */
    originResolvedFrom: string | null;
  },
): Promise<void> {
  if (!deps.resolver?.enabled) return;
  if (args.originResolvedFrom != null) {
    deps.logger.info(
      { originRequestId: args.originRequestId },
      "origin is itself a resolution product (resolved_from set); skipping resolution (no-recursion)",
    );
    return;
  }
  try {
    const resolutionId = await deps.resolver.openAndEnqueue({
      originRequestId: args.originRequestId,
      conflictingFiles: args.conflictingFiles,
      baseSha: args.baseSha,
      ref: args.ref,
    });
    deps.logger.info(
      {
        resolutionId,
        originRequestId: args.originRequestId,
        conflictingFiles: args.conflictingFiles,
      },
      "opened conflict resolution",
    );
  } catch (err) {
    // Non-fatal: the origin is already rejected `conflict`. Log + continue.
    deps.logger.warn(
      { err: errMessage(err), originRequestId: args.originRequestId },
      "openResolution failed (non-fatal); origin stays rejected-conflict",
    );
  }
}

// ─── Pause read-side gate (Phase 7.4 §4.2, Step 12) ───────────────
//
// Pause is a SOFT read-side gate the integrator honors before admitting NEW
// work — it is NOT a PM-enforced block. The hard safety is elsewhere: the lane
// lock (single-owner, 7.2 §9), the PM state transitions, and the admin force-*
// overrides (§4.3). This gate ONLY stops new admission; an in-flight batch/group
// drains to completion and releases its lock as usual (the no-abort invariant).
//
// FAIL-OPEN: a failed getTrainState returns `false` (treat as running). A paused
// train that the integrator can't read is far less dangerous than a wedged train
// that can't make progress because a transient GET error read as "paused" — and
// the hard safety above still holds. So a read error never gates admission.
async function isPaused(deps: {
  pmClient: PmClient;
  projectId: string;
  resource: string;
  logger: Logger;
}): Promise<boolean> {
  try {
    const state = await deps.pmClient.getTrainState(deps.projectId, deps.resource);
    return state.state === "paused";
  } catch (err) {
    deps.logger.debug(
      { err: errMessage(err) },
      "getTrainState failed; treating as running (fail-open)",
    );
    return false;
  }
}

export interface RunBatchLoopDeps extends BatchDeps {
  /** Resolves when an SSE/wakeup signal arrives or the poll tick elapses. */
  waitForWork: (pollMs: number) => Promise<void>;
  /** Should the loop keep running? Flipped by the SIGTERM/SIGINT handler. */
  shouldContinue: () => boolean;
  /**
   * Phase 7.3 group lane (Step 10). When present AND non-empty, the loop checks
   * for a FORMING cross-repo group BEFORE falling through to the single-repo
   * speculative `runBatchOnce`. Absent / empty linkedRepos → exact 7.2 behavior
   * (backward compat). The two lanes are the correlated per-repo pools
   * assembleGroup leases from + their binding clones.
   */
  groupLane?: GroupLaneDeps;
  /**
   * Phase 7.6.1 reclaim sweep gate. True ⇒ a throttled, non-fatal sweep at the
   * top of each loop tick reclaims `merge_resolutions` rows stranded in
   * `resolving` (the resolver session died/timed out). False/absent ⇒ no sweep
   * (byte-identical to pre-7.6.1). Threaded from `settings.integrator.resolver`.
   */
  resolverEnabled?: boolean;
  /**
   * Phase 7.6.1: the resolver time budget (settings.integrator.resolver.
   * time_budget_sec). The sweep uses it to compute the reclaim deadline so a
   * still-LIVE resolver session is never reclaimed out from under itself.
   */
  resolverTimeBudgetSec?: number;
}

/**
 * The 7.3 group dispatch surface. `innerLane`/`outerLane` are the role-bound
 * per-repo pools; the verify defaults mirror BatchDeps. Present only when the
 * project declares linkedRepos.
 */
export interface GroupLaneDeps {
  innerLane: RepoLane;
  outerLane: RepoLane;
  integratorId?: string;
  innerLogsDir?: string;
  outerLogsDir?: string;
}

export type RunGroupLaneOutcome =
  | { kind: "no_group" }
  | { kind: "lock_unavailable" }
  | {
      kind: "resolved";
      outcome: GroupIntegrationOutcome;
      /**
       * Step 11: the atomic-land result when `outcome.kind === "ready_to_land"`
       * (landed / rejected / orphaned). Absent for non-land outcomes
       * (rejected / backpressure straight out of integration).
       */
      land?: GroupLandResult;
      /**
       * Step 12: the orphaned-inner recovery sweep result, run FIRST under the
       * lane lock (§7.2) before the forming group integrates. Present whenever
       * the lock was acquired (a forming group existed).
       */
      recovery?: RecoverResult;
    }
  /**
   * Step 12: a recovery-ONLY pass — an open incident existed but NO forming
   * group, so the lane lock was acquired solely to run the rollforward sweep.
   * Treated as work-done by runBatchLoop (loop again immediately).
   */
  | { kind: "recovered"; recovery: RecoverResult }
  | { kind: "error"; message: string };

export interface RunBatchLoopOptions {
  pollIntervalMs?: number;
}

export type RunBatchOutcome =
  | { kind: "idle" }
  | {
      kind: "drained";
      landed: string[];
      rejected: string[];
      requeued: string[];
    }
  | { kind: "lock_unavailable" }
  | { kind: "error"; message: string };

// Imported from worktree-pool.ts; re-declared here only as the dep type the
// scheduler consumes (the concrete impl is createWorktreePool).
import type { WorktreePool } from "./worktree-pool.js";

// ─── Helpers (verify log paths; mirror loop.ts) ───────────────────

function logUrlFor(logsDir: string, attemptId: string): string {
  return pathToFileURL(path.join(logsDir, `${attemptId}.log`)).href;
}

function summaryLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return (line ?? "").trim().slice(0, 500);
}

/**
 * Abortable sleep (phase 7.2 Step 8). Resolves after `ms`, OR immediately when
 * `signal` aborts — so a suffix-invalidation `kill()` during a retry backoff
 * wakes the sleep at once (the post-sleep state guard then makes the retry loop
 * bail before issuing an illegal `startAttempt`). The SAME `controller.signal`
 * threaded into `runVerify` is threaded here, so the kill aborts both.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        res();
      },
      { once: true },
    );
  });
}

/** Per-drain run context: a member-scoped GitOps cache + outcome accumulators. */
interface BatchCtx {
  landed: string[];
  rejected: string[];
  requeued: string[];
}

/**
 * The PM-recorded / rebase base SHA for a speculative base: the last chain
 * entry's rebased tree (member K chains onto K-1's rebased tree) or `liveMainSha`
 * for the prefix anchor. Passed to BOTH `startAttempt` and `rebaseOnto`, which
 * makes "member K's recorded base SHA == member K-1's rebasedTreeSha" hold.
 */
function baseShaOf(base: SpeculativeBase): string {
  return base.predecessorChain.at(-1)?.rebasedTreeSha ?? base.liveMainSha;
}

// ─── Surviving-prefix predecessor ─────────────────────────────────

/**
 * The chaining/land predecessor of `member`: the immediately-preceding member
 * among the SURVIVING prefix — members that are not `failed` and not
 * `invalidated`, ordered ascending by `speculativePosition`. Returns undefined
 * when `member` has no surviving predecessor (it is the prefix anchor and
 * chains on live main — the position-0-equivalent).
 *
 * This is the SAME filter `tryLand` walks. Deriving the predecessor from the
 * surviving prefix (rather than `speculativePosition - 1` over the unfiltered
 * array) is the MANDATORY position/predecessor-collision fix: a failed member
 * left in `members` with a stale position can never be resolved as a
 * predecessor, so neither the speculative base nor the land-time
 * `expectedMainSha` can chain off a rejected member.
 */
export function survivingPredecessor(member: Member, batch: Batch): Member | undefined {
  const surviving = batch.members
    .filter((m) => m.state !== "failed" && m.state !== "invalidated")
    .sort((a, b) => a.speculativePosition - b.speculativePosition);
  let prev: Member | undefined;
  for (const m of surviving) {
    if (m.speculativePosition >= member.speculativePosition) break;
    prev = m;
  }
  return prev;
}

// ─── computeSpeculativeBase ───────────────────────────────────────

/**
 * The chaining point (design §4). Member 0 (no surviving predecessor) anchors
 * to live `main` with an empty chain. Member K>0 chains onto its surviving
 * predecessor's `rebasedTreeSha`:
 *
 *  - Materialize the predecessor's not-yet-pushed rebased COMMIT into K's
 *    object store via the §4.3 cross-worktree fetch
 *    (`gitOps.fetchFromPath(predecessor.worktree.path, predecessor.rebasedTreeSha)`),
 *    so the subsequent `rebaseOnto(predecessor.rebasedTreeSha, ref)` resolves.
 *  - Extend the predecessor's chain with `{requestId, rebasedTreeSha}` (the
 *    chain IS the structural dependency set, §4.4).
 *  - Anchor `liveMainSha` to the prefix anchor's (`members[0]`) `liveMainSha`.
 *
 * The recorded PM-side base SHA is `predecessorChain.at(-1)?.rebasedTreeSha ??
 * liveMainSha`; the caller passes it to BOTH `startAttempt` and `rebaseOnto`,
 * so member K's recorded base SHA equals member K-1's `rebasedTreeSha`.
 */
export async function computeSpeculativeBase(
  member: Member,
  batch: Batch,
  gitOps: GitOps,
): Promise<SpeculativeBase> {
  const predecessor = survivingPredecessor(member, batch);

  // No surviving predecessor, OR the immediately-preceding surviving member has
  // already LANDED — in either case this member anchors to live `main`. A
  // landed predecessor's rebased tree IS the current remote `main` (which
  // `resetForAttempt` just fetched), so there is nothing to chain onto: the
  // member is a fresh prefix anchor over the post-land main. (Chaining only
  // applies to an IN-FLIGHT predecessor whose tree is not yet on the remote.)
  if (!predecessor || predecessor.state === "landed") {
    const liveMainSha = await gitOps.resolveRef("HEAD");
    return { liveMainSha, predecessorChain: [] };
  }

  if (!predecessor.worktree || predecessor.rebasedTreeSha === null) {
    // An in-flight predecessor must hold its slot and have produced a rebased
    // tree by the time this member is admitted (admission+rebase is awaited in
    // order). This is a defensive guard, not an expected path.
    throw new Error(`predecessor ${predecessor.request.id} has no materializable rebased tree`);
  }

  // §4.3: pull the predecessor's rebased commit from its worktree into ours.
  await gitOps.fetchFromPath(predecessor.worktree.path, predecessor.rebasedTreeSha);

  const liveMainSha = batch.members[0]?.base?.liveMainSha ?? predecessor.base?.liveMainSha ?? "";
  const predecessorChain = [
    ...predecessor.predecessorChain,
    {
      requestId: predecessor.request.id,
      rebasedTreeSha: predecessor.rebasedTreeSha,
    },
  ];
  return { liveMainSha, predecessorChain };
}

// ─── onMemberFailed ───────────────────────────────────────────────

/**
 * Failure reasons handled at member scope. `verify`/`conflict`/`push_other`
 * reject the request (terminal); `drift`/`push_race` cancel + re-queue so the
 * member re-competes on the next list iteration.
 */
export type MemberFailure =
  | {
      kind: "verify";
      // verify outcome fields for categorize + payload parity with loop.ts.
      exitCode: number;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }
  | { kind: "conflict"; conflictingFiles: string[]; stderr: string }
  | { kind: "push_other"; reason: string; stderr: string }
  | { kind: "drift"; reason: string };

/**
 * Drive a single member to its terminal/re-queued state and release its slot.
 *
 * STEP 6: after rejecting member K for a REAL failure (`conflict`/`verify`/
 * `push_other` — NOT `drift`), this invalidates the dependent suffix: every
 * member J where `K.request.id ∈ J.predecessorChain` (design §7.2). The drift
 * branch does NOT cascade — it re-queues only the single drifted member.
 *
 * The reject / cancel payloads are byte-identical to loop.ts's reject paths.
 *
 * `ctx` is required so the cascade can push re-queued suffix ids onto
 * `ctx.requeued` (which the drain loop counts as forward progress). It is also
 * used by `landMember`'s drift path to push the requeued id.
 */
export async function onMemberFailed(
  member: Member,
  batch: Batch,
  deps: BatchDeps,
  failure: MemberFailure,
  ctx: BatchCtx,
): Promise<{ outcome: "rejected" | "requeued"; category?: string }> {
  const { pmClient } = deps;
  const requestId = member.request.id;
  const attemptId = member.attemptId;
  const logUrl =
    member.worktree && attemptId ? logUrlFor(member.worktree.logsDir, attemptId) : undefined;

  const releaseSlot = (): void => {
    if (member.worktree) {
      deps.pool.release(member.worktree);
      member.worktree = null;
    }
  };

  if (failure.kind === "conflict") {
    const reason = "rebase conflict on " + failure.conflictingFiles.join(", ");
    const excerpt = failure.stderr.slice(0, LOG_EXCERPT_CAP);
    if (attemptId) {
      await pmClient.completeAttempt(attemptId, {
        status: "failed",
        failureCategory: "conflict",
        failureReason: reason,
        failedFiles: failure.conflictingFiles,
        logExcerpt: excerpt,
        logUrl,
      });
    }
    await pmClient.rejectMergeRequest(requestId, {
      category: "conflict",
      reason,
      failedFiles: failure.conflictingFiles,
      logExcerpt: excerpt,
      logUrl,
    });
    member.state = "failed";
    releaseSlot();
    // PHASE 7.6 §5.1: AFTER the origin is rejected `conflict` + the slot is
    // released, BEFORE invalidateSuffix — gated on resolver.enabled. Off ⇒
    // no-op (byte-identical to 7.5). Non-fatal (try/catch inside the helper):
    // an openResolution failure must NEVER reach invalidateSuffix / the drain
    // loop. The lane lock is released at batch scope independently; the slot
    // freed above is the verify-pool slot, never held across a resolution.
    await maybeOpenResolution(deps, {
      projectId: deps.projectId,
      resource: deps.resource,
      originRequestId: requestId,
      conflictingFiles: failure.conflictingFiles,
      baseSha: member.base?.liveMainSha ?? "",
      ref: member.request.branch ?? member.request.commitSha ?? "",
      originResolvedFrom: member.request.resolvedFrom ?? null,
    });
    await invalidateSuffix(member, batch, deps, ctx);
    return { outcome: "rejected", category: "conflict" };
  }

  if (failure.kind === "verify") {
    const cat = categorize({
      exitCode: failure.exitCode,
      signal: failure.signal,
      stdout: failure.stdout,
      stderr: failure.stderr,
      timedOut: failure.timedOut,
    });
    const reason = cat.reason || summaryLine(failure.stderr || failure.stdout) || "verify failed";
    const excerpt = `${failure.stdout}\n${failure.stderr}`.slice(0, LOG_EXCERPT_CAP);
    if (attemptId) {
      await pmClient.completeAttempt(attemptId, {
        status: "failed",
        failureCategory: cat.category,
        failureReason: reason,
        failedFiles: cat.failedFiles,
        logExcerpt: excerpt,
        logUrl,
        // PHASE 7.5: the failing pipeline pass's per-step results (the fail-fast
        // short-circuit is visible — later steps absent). undefined pre-verify.
        steps: member.steps ?? undefined,
      });
    }
    await pmClient.rejectMergeRequest(requestId, {
      category: cat.category,
      reason,
      failedFiles: cat.failedFiles,
      logExcerpt: excerpt,
      logUrl,
    });
    member.state = "failed";
    releaseSlot();
    await invalidateSuffix(member, batch, deps, ctx);
    return { outcome: "rejected", category: cat.category };
  }

  if (failure.kind === "push_other") {
    const excerpt = failure.stderr.slice(0, LOG_EXCERPT_CAP);
    if (attemptId) {
      await pmClient.completeAttempt(attemptId, {
        status: "failed",
        failureCategory: "other",
        failureReason: failure.reason,
        logExcerpt: excerpt,
        logUrl,
      });
    }
    await pmClient.rejectMergeRequest(requestId, {
      category: "other",
      reason: failure.reason,
      logExcerpt: excerpt,
      logUrl,
    });
    member.state = "failed";
    releaseSlot();
    await invalidateSuffix(member, batch, deps, ctx);
    return { outcome: "rejected", category: "other" };
  }

  // failure.kind === "drift" (land-time main drift / push non_fast_forward):
  // the verified tree is stale. Cancel the open attempt and re-queue so the
  // member re-competes on the next list iteration (design §6.2).
  if (attemptId) {
    await pmClient.completeAttempt(attemptId, { status: "cancelled" });
  }
  await pmClient.resetToQueued(requestId, failure.reason);
  member.state = "invalidated";
  member.attemptId = null;
  releaseSlot();
  return { outcome: "requeued" };
}

// ─── Suffix invalidation (design §7.2 / §7.3 / §7.4) ──────────────

/**
 * The dependent suffix of failed member K: every other member J that is still
 * in the active race (not `landed`/`failed`/`invalidated`) whose
 * `predecessorChain` STRUCTURALLY contains K (design §7.2). landed members are
 * excluded (their tree is on main, immutable); verified-but-not-landed suffix
 * members ARE included; predecessors of K never carry K in their chain → they
 * are untouched. "Exactly the dependent suffix — never more, never less."
 */
export function computeSuffix(failed: Member, batch: Batch): Member[] {
  return batch.members.filter(
    (j) =>
      j !== failed &&
      j.state !== "landed" &&
      j.state !== "failed" &&
      j.state !== "invalidated" &&
      j.predecessorChain.some((p) => p.requestId === failed.request.id),
  );
}

/**
 * Invalidate the dependent suffix of a REAL-failed member K (design §7.3/§7.4).
 *
 * TWO INTERDEPENDENT MANDATORY FIXES against the cascade race:
 *
 *  - FIX 1 (synchronous first pass): tear down the ENTIRE suffix structurally
 *    BEFORE any `await`. For every J: kill its verify, set `state="invalidated"`,
 *    null `verify`, release its worktree. Marking every suffix member
 *    `invalidated` before any await is what lets a killed verify continuation
 *    (which resumes during a PM await below) observe `state !== "verifying"` and
 *    bail (FIX 2) — so no suffix member's killed verify re-enters onMemberFailed
 *    and double-rejects / double-resets.
 *  - The async second pass then does the PM calls per J (cancel attempt, reset
 *    to queued, emit the marker). State is NEVER mutated interleaved with an
 *    await, which is the whole point of the split.
 *
 * The re-admit itself is the drain loop's job: the `invalidated` members are
 * un-tracked and re-admitted as fresh members with corrected bases over the
 * surviving prefix (§7.4 / §8), so this helper only does teardown + PM reset.
 */
async function invalidateSuffix(
  failed: Member,
  batch: Batch,
  deps: BatchDeps,
  ctx: BatchCtx,
): Promise<void> {
  const suffix = computeSuffix(failed, batch);
  if (suffix.length === 0) return;

  // ── FIX 1: synchronous first pass over the ENTIRE suffix — NO await. ──
  for (const j of suffix) {
    j.verify?.kill();
    j.state = "invalidated";
    j.verify = null;
    if (j.worktree) {
      deps.pool.release(j.worktree);
      j.worktree = null;
    }
  }

  // ── Second pass: the async PM calls per member. Safe to await now —
  //    every suffix member is already `invalidated`, so any killed verify
  //    continuation that resumes here bails on the FIX-2 post-await guard. ──
  const reason = `predecessor ${failed.request.id} failed; speculation invalidated`;
  for (const j of suffix) {
    const attemptId = j.attemptId;
    if (attemptId) {
      await deps.pmClient.completeAttempt(attemptId, { status: "cancelled" });
    }
    await deps.pmClient.resetToQueued(j.request.id, reason);
    j.attemptId = null;
    ctx.requeued.push(j.request.id);
    deps.onBatchEvent?.({
      type: "member_invalidated",
      batchId: batch.batchId,
      requestId: j.request.id,
      speculativePosition: j.speculativePosition,
      reason,
      failedPredecessorRequestId: failed.request.id,
    });
  }
}

// ─── tryLand ──────────────────────────────────────────────────────

/**
 * Structural ordered land walk (design §6.1): iterate members ascending by
 * `speculativePosition`, skip already-`landed`, break at the first non-`verified`
 * member (never skip ahead — a member lands only after every predecessor), and
 * land each `verified` member in turn. If a land returns false (main drifted),
 * stop the walk; the re-queued member re-competes on the next drain iteration.
 *
 * Step 6 grows the failure handling here (richer drift/invalidation), but the
 * ordered-walk skeleton is final.
 */
export async function tryLand(batch: Batch, deps: BatchDeps, ctx: BatchCtx): Promise<void> {
  // Walk only members still in the active land race — `failed`/`invalidated`
  // members have left the batch (rejected / re-queued) and are not part of the
  // land order. Ordered ascending by position; land each `verified` member and
  // halt at the first non-`verified` (never skip ahead).
  const ordered = batch.members
    .filter((m) => m.state !== "failed" && m.state !== "invalidated")
    .sort((a, b) => a.speculativePosition - b.speculativePosition);
  for (const member of ordered) {
    if (member.state === "landed") continue;
    if (member.state !== "verified") break;
    const landed = await landMember(member, batch, deps, ctx);
    if (!landed) break;
  }
}

// ─── landMember ───────────────────────────────────────────────────

/**
 * Fast-forward-or-drift land for a single verified member (design §6.2).
 *
 * Returns true on a successful land, false on main drift (in which case the
 * member has been re-queued via onMemberFailed and must re-compete).
 */
export async function landMember(
  member: Member,
  batch: Batch,
  deps: BatchDeps,
  ctx: BatchCtx,
): Promise<boolean> {
  const { gitRemote, gitMainBranch } = deps;
  const worktree = member.worktree;
  if (!worktree || !member.base) {
    // Defensive: a verified member always holds its slot + base in Step 4.
    return false;
  }
  const gitOps = deps.gitOps(worktree.path);

  // Expected main SHA (design §6.2): the prefix anchor expects live main; a
  // chained member expects its SURVIVING predecessor's landedSha (the land loop
  // guarantees that predecessor is already `landed`). Derived from the surviving
  // prefix — NOT `position - 1` over the unfiltered array — so a stale failed
  // member can never be mistaken for the predecessor (MANDATORY position fix).
  const predecessor = survivingPredecessor(member, batch);
  const expectedMainSha = predecessor
    ? (predecessor.landedSha ?? member.base.liveMainSha)
    : member.base.liveMainSha;

  // Fetch + re-resolve remote main to detect drift before pushing.
  await gitOps.fetch(gitRemote);
  const actualMainSha = await gitOps.resolveRef(`${gitRemote}/${gitMainBranch}`);

  if (actualMainSha !== expectedMainSha) {
    const res = await onMemberFailed(
      member,
      batch,
      deps,
      { kind: "drift", reason: "main drifted at land; re-verify" },
      ctx,
    );
    if (res.outcome === "requeued") ctx.requeued.push(member.request.id);
    return false;
  }

  // ── No-op / already-landed guard ──
  // If the rebased HEAD's tree is byte-identical to live main's, this request
  // contributes NO net change — its content is already on main (landed
  // out-of-band under a different SHA, or fully redundant with a predecessor).
  // Pushing would either be a literal no-op or, worse (an originally-empty
  // commit that survived rebase), advance main by an empty commit. Record a
  // no-op land instead: mark the request landed at the CURRENT main SHA without
  // pushing. Suffix members chain onto this member's landedSha (= current main,
  // unmoved), so the speculative land order stays correct — a zero-advance land.
  if (await gitOps.treesIdentical("HEAD", actualMainSha)) {
    deps.logger.info(
      { requestId: member.request.id, mainSha: actualMainSha },
      "rebased tree identical to main; content already landed — recording no-op land (no push)",
    );
    if (member.attemptId) {
      await deps.pmClient.completeAttempt(member.attemptId, {
        status: "passed",
        treeSha: actualMainSha,
        steps: member.steps ?? undefined,
      });
    }
    await deps.pmClient.landMergeRequest(member.request.id, actualMainSha);
    member.state = "landed";
    member.landedSha = actualMainSha;
    deps.pool.release(worktree);
    member.worktree = null;
    ctx.landed.push(member.request.id);
    deps.onBatchEvent?.({
      type: "member_landed",
      batchId: batch.batchId,
      requestId: member.request.id,
      speculativePosition: member.speculativePosition,
      landedSha: actualMainSha,
    });
    return true;
  }

  const push = await gitOps.push(gitRemote, gitMainBranch);
  if (!push.ok) {
    if (push.reason === "non_fast_forward") {
      const res = await onMemberFailed(
        member,
        batch,
        deps,
        { kind: "drift", reason: "push race; main moved during verify" },
        ctx,
      );
      if (res.outcome === "requeued") ctx.requeued.push(member.request.id);
      return false;
    }
    // auth / network / other → terminal reject.
    const reason = `push failed (${push.reason}): ${summaryLine(push.stderr)}`;
    await onMemberFailed(
      member,
      batch,
      deps,
      { kind: "push_other", reason, stderr: push.stderr },
      ctx,
    );
    ctx.rejected.push(member.request.id);
    return false;
  }

  // Successful land. No re-verify — the verified tree IS what we pushed.
  if (member.attemptId) {
    await deps.pmClient.completeAttempt(member.attemptId, {
      status: "passed",
      treeSha: push.pushedSha,
      // PHASE 7.5: the per-step results captured at verify time (the slot bridges
      // runVerifyTask → land). undefined on a 7.4 / cache-off-no-steps path.
      steps: member.steps ?? undefined,
    });
  }
  await deps.pmClient.landMergeRequest(member.request.id, push.pushedSha);
  member.state = "landed";
  member.landedSha = push.pushedSha;
  deps.pool.release(worktree);
  member.worktree = null;
  ctx.landed.push(member.request.id);
  deps.onBatchEvent?.({
    type: "member_landed",
    batchId: batch.batchId,
    requestId: member.request.id,
    speculativePosition: member.speculativePosition,
    landedSha: push.pushedSha,
  });
  return true;
}

// ─── runBatchOnce ─────────────────────────────────────────────────

/**
 * Process one batch: acquire the lane lock once, drain queued requests one
 * member at a time, release the lock once. The N=1 per-member sequence is
 * byte-identical to runOnce (acquire IS before pickup in both).
 */
export async function runBatchOnce(deps: BatchDeps): Promise<RunBatchOutcome> {
  const { pmClient, pool, logger, projectId, resource, defaultVerifyCommand } = deps;

  // 1. List queued, oldest first. Empty → idle (NO lock acquired).
  let queued: MergeRequestView[];
  try {
    queued = await pmClient.listMergeRequests(projectId, {
      resource,
      status: "queued",
      // §9 finding 3: never admit a grouped member into the single-repo
      // speculative drain — grouped members integrate only as a unit via the
      // group lane. Excluding them here closes the submit→group race window.
      ungrouped: true,
    });
  } catch (err) {
    logger.warn({ err: errMessage(err) }, "Failed to list queued requests");
    return { kind: "error", message: errMessage(err) };
  }
  if (queued.length === 0) return { kind: "idle" };

  // 1b. PAUSE GATE (Phase 7.4 §4.2, Step 12) — read ONCE per pass, at the
  //     top, BEFORE the lock + any pickup. There is no batch in flight yet at
  //     this point (the lock is not held, nothing is admitted), so returning
  //     `idle` here strands NOTHING — it simply declines to START a new batch
  //     while paused. The per-member admit gate below reuses this same flag so
  //     pause is evaluated per-pass, NOT per-member.
  const paused = await isPaused(deps);
  if (paused) {
    logger.info({ resource }, "Train paused; skipping new batch admission");
    return { kind: "idle" };
  }

  // 2. Acquire the lane lock ONCE for the whole batch (design §9.1). Built
  //    from the representative first member's intent. OUTSIDE the try block so
  //    a failed/unavailable acquire never enters the finally release.
  const head = queued[0];
  try {
    const lock = await pmClient.acquireLock(projectId, resource, {
      taskId: head.taskId,
      branch: head.branch,
      commitSha: head.commitSha,
      verifyCmd: head.verifyCmd ?? defaultVerifyCommand,
      worktreePath: null,
    });
    if (!lock.ok || lock.status === "queued") {
      logger.info(
        { lockStatus: lock.status },
        "Lock unavailable; another integrator holds the lane",
      );
      return { kind: "lock_unavailable" };
    }
  } catch (err) {
    logger.warn({ err: errMessage(err) }, "acquireLock failed");
    return { kind: "error", message: errMessage(err) };
  }

  const batch: Batch = {
    batchId: deps.newBatchId?.() ?? randomUUID(),
    projectId,
    resource,
    members: [],
    lockHeld: true,
    createdAt: new Date().toISOString(),
    nextPosition: 0,
  };

  // STEP-7 SEAM (§13.2): emit `started` after the lane lock is held. The member
  // list is advisory — it reflects the queued snapshot at batch start; members
  // admitted later (or re-admitted after invalidation) needn't be in this list.
  deps.onBatchEvent?.({
    type: "started",
    batchId: batch.batchId,
    resource,
    memberCount: queued.length,
    memberRequestIds: queued.map((r) => r.id),
  });

  // 3. Single batch-lifetime heartbeat (design §9.2).
  const heartbeat = setInterval(() => {
    void pmClient.heartbeatLock(projectId, resource).catch((err: unknown) => {
      logger.debug({ err: errMessage(err) }, "heartbeat failed");
    });
  }, deps.heartbeatIntervalMs ?? 60_000);
  heartbeat.unref?.();

  let released = false;
  const releaseLock = async (opts: { landedSha?: string; reason?: string }): Promise<void> => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    batch.lockHeld = false;
    try {
      await pmClient.releaseLock(projectId, resource, opts);
    } catch (err) {
      // A failed release is NOT cosmetic: the lane lock stays held server-side
      // with a now-idle/dead holder, so the next `runBatchOnce` sees the lane
      // occupied → `lock_unavailable` → backs off → NEVER re-picks queued work
      // until the lock's staleness sweep or a manual force-release. That is the
      // classic "integrator needs a re-kick" stall (the live game_one report).
      // WARN (not debug) so it surfaces in the operator's logs as the cause.
      logger.warn(
        { err: errMessage(err), resource },
        "releaseLock FAILED — lane lock may be stuck held; queued work will not be re-picked until the staleness sweep or a force-release",
      );
    }
  };

  const ctx: BatchCtx = { landed: [], rejected: [], requeued: [] };

  // PHASE 7.4 §3.2 (Step 12): the lock is held → a batch is now in flight. The
  // heartbeat reads these counters to derive status="integrating". `requests`
  // is recomputed each drain pass (members still holding a worktree). BOTH are
  // reset to 0 in the FINALLY so a throw can't leave the status stuck.
  if (deps.inFlight) deps.inFlight.batches = 1;

  // Request ids already admitted into THIS drain — so the FIFO-head re-list
  // doesn't re-admit a member that is still `integrating` (pickup flips the PM
  // status off `queued`, but a re-listed snapshot taken before that may still
  // show it). Members that drift-requeue flip to `invalidated` + reset PM to
  // `queued`; they re-compete as a fresh admission, so they are intentionally
  // NOT tracked here (mirrors the Step-4 re-admit-on-drift behavior).
  const admittedIds = new Set<string>();
  // Members that drift-requeued and have already been un-tracked for re-admit —
  // so the prune step processes each invalidated member exactly once and can't
  // strip the re-admitted member's fresh tracking.
  const reAdmitted = new WeakSet<Member>();

  try {
    // 4. Drain loop (design §5/§9.3/§11): rebase-sequential, verify-parallel.
    //
    // Each iteration: ADMIT as many FIFO-head requests as there are idle slots
    // (awaited in order), run the land-gate, then — only if work remains in
    // flight — race the in-flight verifies. Termination is when an iteration
    // both admits nothing new AND has nothing in flight (and nothing left to
    // land, which `tryLand` already drained).
    //
    //   - ADMIT (ordered, backpressure): while a pool slot is free AND a
    //     not-yet-admitted FIFO-head request exists, AWAIT admit+rebase IN
    //     ORDER. Awaiting in order is load-bearing: member K's
    //     `computeSpeculativeBase` reads member K-1's already-set
    //     `rebasedTreeSha` (the rebases serialize; only the verifies overlap,
    //     §4.2). A member that reaches `verifying` launches its verify as a
    //     tracked, un-awaited promise; a member that fails at admit (conflict /
    //     lost pickup) frees its slot and is terminal — keep admitting.
    //   - The in-flight set is rebuilt each pass from `member.verify !== null`
    //     (the settle-clears-to-null convention is the source of truth — avoids
    //     separate promise bookkeeping). A verify that settled DURING the admit
    //     phase is already reflected; `tryLand` runs BEFORE the in-flight check
    //     so a member that finished verifying mid-admit still lands rather than
    //     stranding the loop.
    for (;;) {
      // A member that drift-requeued (state `invalidated`: `resetToQueued`'d in
      // PM, slot freed) must re-compete as a FRESH admission — un-track its id
      // so the FIFO-head re-list re-admits it (a new Member with a new monotonic
      // position; the stale invalidated one stays in `members`, filtered out of
      // the surviving prefix). Mirrors the Step-4 drift re-admit.
      for (const m of batch.members) {
        if (m.state === "invalidated" && !reAdmitted.has(m)) {
          reAdmitted.add(m);
          admittedIds.delete(m.request.id);
        }
      }

      // PHASE 7.4 §4.2 NO-ABORT GATE (Step 12): re-read pause ONCE per drain
      // pass (NOT per-member). If the train was paused MID-DRAIN, this pass
      // stops admitting NEW members — but the rest of the loop is UNTOUCHED:
      // tryLand still lands the already-admitted members, the in-flight verifies
      // still settle via Promise.race, and the FINALLY still releases the lock.
      // That is the whole no-abort invariant: pause gates ONLY the admission
      // edge; in-flight work drains and the lock releases on drain.
      const pausedThisPass = await isPaused(deps);

      // ── ADMIT phase ──────────────────────────────────────────────
      let admittedThisPass = 0;
      for (;;) {
        const wt = pool.acquire();
        if (!wt) break; // backpressure: no idle slot → stop admitting for now
        // NO-ABORT GATE: a paused train admits NOTHING new — release the slot we
        // just leased and stop the admit loop. We break (not short-circuit
        // runBatchOnce) so the drain below still lands/settles in-flight members.
        if (pausedThisPass) {
          pool.release(wt);
          break;
        }
        const list = await pmClient.listMergeRequests(projectId, {
          resource,
          status: "queued",
          ungrouped: true,
        });
        const req = list.find((r) => !admittedIds.has(r.id));
        if (!req) {
          pool.release(wt);
          break; // nothing un-admitted at the FIFO head → done admitting
        }
        admittedIds.add(req.id);
        admittedThisPass += 1;
        const position = batch.nextPosition;
        batch.nextPosition += 1;
        // Admission + rebase is AWAITED in order so the predecessor's
        // rebasedTreeSha is set before this member's base is computed.
        const member = await admitAndRebase(req, wt, position, batch, deps, ctx);
        // If the member reached `verifying`, launch verify (do NOT await).
        // Build an AbortController so a failed predecessor can kill this verify
        // (suffix invalidation, §7.3); expose `controller.abort()` as the
        // VerifyHandle's `kill`.
        if (member && member.state === "verifying") {
          const controller = new AbortController();
          member.verify = {
            done: runVerifyTask(member, batch, deps, ctx, controller.signal),
            kill: () => controller.abort(),
          };
        }
        // A member that failed at admit (conflict / lost pickup / no ref) has
        // already freed its slot and is terminal — continue admitting.
      }

      // ── Land-gate: land every ready member, freeing slots for refill. Run
      //    BEFORE the in-flight check so a verify that settled during admit
      //    still lands rather than stranding the drain. ───────────────
      const landedBefore = ctx.landed.length;
      const requeuedBefore = ctx.requeued.length;
      await tryLand(batch, deps, ctx);
      const landedThisPass = ctx.landed.length - landedBefore;
      // A drift-requeue (member → `invalidated`, slot freed, PM `resetToQueued`)
      // also frees a slot and re-queues work, so it counts as forward progress
      // that must keep the drain alive to re-admit the requeued member.
      const requeuedThisPass = ctx.requeued.length - requeuedBefore;

      // ── In-flight set (source of truth: member.verify !== null) ──
      const inFlight = batch.members
        .filter((m) => m.verify)
        .map((m) => (m.verify as VerifyHandle).done);

      // PHASE 7.4 §3.2 (Step 12): recompute the heartbeat's in-flight request
      // count each drain pass — members that are non-terminal AND still hold a
      // worktree (admitted, not yet landed/failed/invalidated). The heartbeat
      // reads this between passes to report how many requests are integrating.
      if (deps.inFlight) {
        deps.inFlight.requests = batch.members.filter(
          (m) =>
            m.worktree !== null &&
            m.state !== "landed" &&
            m.state !== "failed" &&
            m.state !== "invalidated",
        ).length;
      }

      if (inFlight.length === 0) {
        // Nothing is verifying. Loop again only if this pass made forward
        // progress that may have UNBLOCKED more admission — either it admitted
        // a member (whose verify may have already settled, e.g. a fast no-op /
        // failed-at-admit member) OR it landed a member and thereby freed a
        // pool slot for a previously backpressured queued request. Otherwise
        // the queue is drained and every member is terminal → done.
        if (admittedThisPass > 0 || landedThisPass > 0 || requeuedThisPass > 0) continue;
        break;
      }

      // Wait for the next verify to settle, then loop: the top re-admits into
      // freed slots and re-runs the land-gate.
      await Promise.race(inFlight);
    }

    return {
      kind: "drained",
      landed: ctx.landed,
      rejected: ctx.rejected,
      requeued: ctx.requeued,
    };
  } catch (err) {
    logger.error({ err: errMessage(err) }, "Unexpected error draining batch");
    return { kind: "error", message: errMessage(err) };
  } finally {
    // PHASE 7.4 §3.2 (Step 12): the batch has drained (or threw) — clear the
    // in-flight counters so the heartbeat reports `status: "idle"` again. MUST
    // run in the finally: a batch that THROWS must still reset, else the status
    // sticks "integrating" forever after a single error.
    if (deps.inFlight) {
      deps.inFlight.batches = 0;
      deps.inFlight.requests = 0;
    }

    // 5. Release the lane lock exactly once on any post-acquire exit (§9.3).
    const lastLanded = ctx.landed.at(-1);
    if (lastLanded) {
      const landedSha =
        batch.members.find((m) => m.request.id === lastLanded)?.landedSha ?? undefined;
      await releaseLock({ landedSha });
    } else {
      await releaseLock({ reason: "batch drained with no land" });
    }

    // STEP-7 SEAM (§13.2): emit `completed`. Counts come from the FINAL member
    // states — `landed`/`failed` are terminal; `invalidated` counts members
    // left in the `invalidated` state (their speculation was voided; any
    // re-admitted replacement is a distinct member that lands/fails on its own).
    const count = (s: MemberState): number => batch.members.filter((m) => m.state === s).length;
    deps.onBatchEvent?.({
      type: "completed",
      batchId: batch.batchId,
      landed: count("landed"),
      rejected: count("failed"),
      invalidated: count("invalidated"),
    });
  }
}

// ─── Member admission + processing ────────────────────────────────

/**
 * Admit a queued request as a new member and rebase it onto its speculative
 * base: pickup → reset → speculative base (§4.2/§4.3 cross-worktree fetch) →
 * startAttempt → rebaseOnto. Admission+rebase is AWAITED in order by the drain
 * loop so member K's base reads member K-1's already-set `rebasedTreeSha`.
 *
 * Returns:
 *   - `null` if the request lost the pickup race (409): its slot is released,
 *     no member is added (mirrors loop.ts:176-186).
 *   - the `Member` otherwise. The caller inspects `member.state`: `verifying`
 *     means rebase succeeded → launch verify; any terminal state (`failed`)
 *     means the slot is already freed → keep admitting.
 *
 * Both `startAttempt` and `rebaseOnto` use `baseShaOf(base)` — for the prefix
 * anchor this is `liveMainSha` (identical to Step 4); for a chained member it
 * is the predecessor's `rebasedTreeSha`, so the recorded base SHA matches.
 */
async function admitAndRebase(
  req: MergeRequestView,
  wt: Worktree,
  position: number,
  batch: Batch,
  deps: BatchDeps,
  ctx: BatchCtx,
): Promise<Member | null> {
  const { pmClient, logger } = deps;

  // Pickup (queued → integrating). 409 = lost race; drop the member. Tagged
  // with the batch lineage (Step 7) so PM can correlate the pickup with the
  // batch + this member's strictly-monotonic admission index.
  try {
    await pmClient.pickupMergeRequest(req.id, {
      batchId: batch.batchId,
      speculativePosition: position,
    });
  } catch (err) {
    if (isApiError(err, 409)) {
      logger.info({ requestId: req.id }, "Pickup returned 409; request no longer queued");
      deps.pool.release(wt);
      return null;
    }
    deps.pool.release(wt);
    throw err;
  }

  const member: Member = {
    request: req,
    speculativePosition: position,
    state: "pending",
    worktree: wt,
    base: null,
    rebasedTreeSha: null,
    landedSha: null,
    attemptId: null,
    predecessorChain: [],
    retryCount: 0,
    steps: null,
    verify: null,
  };
  // STEP-6 CASCADE-RACE FIX: do NOT push the member into `batch.members` with an
  // empty `predecessorChain`. A predecessor's verify can fail (and run suffix
  // invalidation) DURING this member's still-in-progress admit; if the member
  // were already visible with an empty chain, `computeSuffix` would miss it and
  // a dependent member would wrongly survive on a stale base. The member is
  // pushed below, only AFTER its `predecessorChain` is materialized — so it is
  // either invisible (correctly excluded) or visible WITH a correct chain. A
  // not-yet-pushed member is also correctly absent from `survivingPredecessor`.

  // Materialize the request: reset the worktree, compute the speculative base,
  // open the attempt, and rebase the submitted branch/commit. ANY unexpected
  // throw from these git/worktree/PM ops must NOT escape to the batch-level
  // drain catch (which would log + bail, STRANDING this request `integrating`
  // forever and blocking the lane). We catch here and discriminate:
  //   • cascade-race (a predecessor invalidated us mid-await) → already handled.
  //   • infra/PM fault (PmApiError — now TOTAL after pm-client wraps network +
  //     parse failures) → re-throw so the request stays `integrating`, the loop
  //     backs off + retries, and crash-recovery reclaims it. NEVER reject a good
  //     request for a transient PM outage.
  //   • request fault (a genuine throw from THIS request's own git ops — e.g.
  //     `git checkout <branch>` pathspec-not-found on a branch that doesn't
  //     exist in the base repo, a bad ref, a corrupt submitted commit) → the
  //     request is unprocessable; REJECT it via the existing onMemberFailed /
  //     push_other terminal path (→ category `other`) so the lane moves on.
  // The result-handling sub-blocks below (`!ref` reject, `!rebase.ok` conflict)
  // already TERMINATE the member; they are NOT inside this catch (re-running
  // their completeAttempt would 409 and re-strand). Any PM throw from them is a
  // PmApiError → re-thrown, never double-rejected.
  let rebase: Awaited<ReturnType<ReturnType<BatchDeps["gitOps"]>["rebaseOnto"]>> | null = null;
  let ref: string | null;
  try {
    // Reset the worktree to clean main (with corruption-repair fallback).
    try {
      await wt.resetForAttempt();
    } catch (err) {
      logger.warn(
        { requestId: req.id, err: errMessage(err) },
        "Worktree reset failed; checking for corruption",
      );
      if (await wt.detectCorruption()) {
        logger.warn({ requestId: req.id }, "Worktree corrupt; repairing");
        await deps.pool.repair(wt);
        await wt.resetForAttempt();
      } else {
        throw err;
      }
    }

    const gitOps = deps.gitOps(wt.path);
    const base = await computeSpeculativeBase(member, batch, gitOps);
    member.base = base;
    member.predecessorChain = base.predecessorChain;
    // Chain is now set — publish the member. From here on it is visible to
    // `computeSuffix` (with a correct chain) and to later members'
    // `survivingPredecessor`. Pushing is synchronous (no await between the chain
    // assignment and the push), so no predecessor-failure can interleave into the
    // empty-chain window.
    batch.members.push(member);
    const baseSha = baseShaOf(base);

    const attempt = await pmClient.startAttempt(req.id, baseSha, {
      batchId: batch.batchId,
      speculativePosition: member.speculativePosition,
    });
    // CASCADE-RACE GUARD: a predecessor's verify may have failed during the
    // `startAttempt` await and invalidated this member (state → `invalidated`,
    // worktree released, PM `resetToQueued`'d). If so, abandon the admit — the
    // attempt we just started is stale; cancel it and bail. The drain loop will
    // re-admit this member as a fresh one. (Without this, we'd rebase/verify on a
    // released worktree against a base that no longer holds.)
    //
    // The cast defeats TS control-flow narrowing: `member.state` is mutated
    // through an aliased reference (invalidateSuffix) DURING the await above, so
    // its static type at this point is stale. The runtime value can be
    // "invalidated"; the cast tells TS that's a legitimate comparison.
    if ((member.state as MemberState) === "invalidated") {
      try {
        await pmClient.completeAttempt(attempt.id, { status: "cancelled" });
      } catch {
        /* best-effort: the request may already be back to queued */
      }
      return member;
    }
    member.attemptId = attempt.id;
    member.state = "rebasing";

    // Rebase the request's branch/commit onto the speculative base. Do it INSIDE
    // the try (rebaseOnto's `git.checkout` can throw a pathspec error — the live
    // bug). The `!ref` and `!rebase.ok` handling happens AFTER the try (below),
    // so `rebase` is only computed when there IS something to integrate.
    ref = req.branch ?? req.commitSha;
    if (ref) rebase = await gitOps.rebaseOnto(baseSha, ref);
  } catch (err) {
    // 1) Cascade-race guard FIRST: a predecessor invalidated this member during
    //    an await — already handled (attempt cancelled, worktree released, PM
    //    reset-to-queued); do not double-reject. (Mirrors the in-flow guards.)
    if ((member.state as MemberState) === "invalidated") return member;
    // 2) Infra fault: any PM/transport error (now ALL PmApiError after the
    //    pm-client wrapping) means the REQUEST is fine and PM is unreachable —
    //    re-throw to the batch catch (→ {kind:"error"} → loop backs off +
    //    retries; the request stays `integrating` and is reclaimed by
    //    crash-recovery if needed). Do NOT reject a good request.
    if (isApiError(err)) throw err;
    // 3) Request fault: an unexpected throw from THIS request's own git/worktree
    //    ops (checkout pathspec-not-found, bad ref, corrupt submitted commit) →
    //    the request is genuinely unprocessable. Reject it via the existing
    //    terminal path (category `other`) so the lane moves on, then continue
    //    the drain.
    await onMemberFailed(
      member,
      batch,
      deps,
      {
        kind: "push_other",
        reason: `integration error: ${summaryLine(errMessage(err))}`,
        stderr: errMessage(err),
      },
      ctx,
    );
    ctx.rejected.push(req.id);
    return member;
  }

  if (!ref) {
    // No branch and no commit: nothing to integrate. Reject as "other"
    // (payload parity with loop.ts).
    if (member.attemptId) {
      await pmClient.completeAttempt(member.attemptId, {
        status: "failed",
        failureCategory: "other",
        failureReason: "request has neither branch nor commitSha",
      });
    }
    await pmClient.rejectMergeRequest(req.id, {
      category: "other",
      reason: "request has neither branch nor commitSha",
    });
    member.state = "failed";
    deps.pool.release(wt);
    member.worktree = null;
    ctx.rejected.push(req.id);
    return member;
  }

  // CASCADE-RACE GUARD (again, post-rebase await): a predecessor may have failed
  // and invalidated this member while we rebased (the rebaseOnto await is inside
  // the try above). invalidateSuffix already cancelled its attempt + reset it;
  // do not interpret the rebase result.
  // (Cast defeats TS narrowing — see the startAttempt guard above.)
  if ((member.state as MemberState) === "invalidated") {
    return member;
  }
  // `ref` is truthy here (the `!ref` branch returned above), so the rebase ran.
  if (!rebase || !rebase.ok) {
    const res = await onMemberFailed(
      member,
      batch,
      deps,
      {
        kind: "conflict",
        conflictingFiles: rebase?.conflictingFiles ?? [],
        stderr: rebase?.stderr ?? "",
      },
      ctx,
    );
    if (res.outcome === "rejected") ctx.rejected.push(req.id);
    return member;
  }
  member.rebasedTreeSha = rebase.treeSha;
  member.state = "verifying";
  return member;
}

/**
 * Run verify for a member that finished rebasing, as a self-contained task the
 * drain loop tracks via `member.verify` and races. NEVER throws out of the race
 * (any error is funneled to `onMemberFailed`), and ALWAYS clears `member.verify`
 * in a `finally` so the loop's "in-flight = members with verify !== null" view
 * stays accurate.
 *
 * On pass → `verified` (the land-gate, run by the drain loop after the race,
 * does the `completeAttempt:passed` + `land`; this task must NOT land — see the
 * ordering caveat in `landMember`). On fail/timeout → reject via onMemberFailed.
 *
 * STEP 6: the spawned verify is killable via a `VerifyHandle` — the launch site
 * builds an `AbortController`, passes `signal` here (forwarded to `runVerify`),
 * and exposes `controller.abort()` as `VerifyHandle.kill`. A failed predecessor
 * tears down this still-running verify by aborting the signal.
 *
 * MANDATORY FIX 2 — post-await bail-guard. After `runVerify` returns, BEFORE
 * inspecting the result / mutating state / calling onMemberFailed, re-check
 * `member.state !== "verifying"`. If a suffix invalidation killed this verify,
 * `invalidateSuffix` already flipped state to `"invalidated"` (synchronously,
 * FIX 1) BEFORE awaiting; the killed child resolves `runVerify` and this guard
 * makes the continuation bail — so it does NOT re-enter onMemberFailed and
 * double-reject / double-resetToQueued. Interdependent with FIX 1.
 */
async function runVerifyTask(
  member: Member,
  batch: Batch,
  deps: BatchDeps,
  ctx: BatchCtx,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (member.state !== "verifying") return;
    const wt = member.worktree;
    if (!wt || !member.attemptId) return;

    const gitOps = deps.gitOps(wt.path);
    const verifyCommand = member.request.verifyCmd ?? deps.defaultVerifyCommand;
    const maxVerifyRetries = deps.maxVerifyRetries ?? DEFAULT_MAX_VERIFY_RETRIES;
    const schedule = deps.retryBackoffMs ?? VERIFY_RETRY_BACKOFF_MS;
    // The SAME batch tags the original startAttempt used (reconstructed here so a
    // retry's fresh attempt carries identical batch lineage — FIX C).
    const tags = {
      batchId: batch.batchId,
      speculativePosition: member.speculativePosition,
    };

    // ── Verify + transient-retry loop (design §10). The loop runs INSIDE the
    //    single runVerifyTask (= member.verify.done), so the handle/controller —
    //    and thus `signal` — is stable across iterations. A transient failure
    //    under cap re-runs ONLY runVerify (same base, same worktree, NO re-rebase)
    //    after an abortable backoff. ──
    // PHASE 7.5 Step 5: the verify steps for this member. A non-empty project
    // verify_steps DAG runs via runPipeline; otherwise the synthetic single step
    // over `verifyCommand` reproduces the exact 7.4 single-command behavior
    // (including the bare today log path). Built once — stable across retries.
    const steps: VerifyStep[] =
      deps.verifySteps && deps.verifySteps.length > 0
        ? deps.verifySteps
        : [
            {
              id: "verify",
              command: verifyCommand,
              depends_on: [],
              cache_key_inputs: [],
            },
          ];

    // PHASE 7.5 Step 6: build the cache ctx ONCE outside the retry loop — the
    // tree sha is STABLE across retries (a transient retry does NOT re-rebase;
    // the worktree still holds the same rebased tree). CLARIFICATION A:
    // member.rebasedTreeSha is the rebased HEAD = a COMMIT sha (rebaseOnto returns
    // `git rev-parse HEAD`), which carries a committer timestamp → it is NOT a
    // valid content-addressed cache key (it differs on every re-assembly). So we
    // derive the actual TREE sha (`<commit>^{tree}`, content-addressed / stable)
    // for the cache key. Cache is engaged only when enabled AND mode !== "off".
    const cacheOn = (deps.cacheEnabled ?? false) && (deps.cacheMode ?? "off") !== "off";
    let cacheCtx:
      | {
          enabled: true;
          mode: CacheMode;
          pmClient: PmClient;
          projectId: string;
          resource: string;
          treeSha: string;
          requestId: string;
        }
      | undefined;
    if (cacheOn) {
      // member.rebasedTreeSha is set before this task runs (state === "verifying"
      // only after batch.ts:1351). Derive the content-addressed tree sha.
      const treeSha = await gitOps.resolveRef(`${member.rebasedTreeSha as string}^{tree}`);
      cacheCtx = {
        enabled: true,
        mode: deps.cacheMode as CacheMode,
        pmClient: deps.pmClient,
        projectId: deps.projectId,
        resource: deps.resource,
        treeSha,
        requestId: member.request.id,
      };
    }

    for (;;) {
      // attemptId changes across retries (each retry starts a fresh attempt), so
      // the log path basis (logsDir + attemptId) is forwarded per iteration; the
      // per-step path is minted INSIDE runPipeline (FOLDED-FIX-1).
      const pipeline = await runPipeline(steps, {
        gitOps,
        cwd: wt.path,
        verifyTimeoutSec: deps.verifyTimeoutSec,
        // The member-level signal (NOT passed to runVerify directly): runPipeline
        // mints a FRESH per-pass child from it each iteration, so a transient
        // retry's runPipeline call RE-RUNS rather than seeing a fired controller.
        signal,
        logsDir: wt.logsDir,
        attemptId: member.attemptId as string,
        // PHASE 7.5 Step 6: the cache ctx (undefined → off-path, byte-identical
        // Step 5). Stable across retries (built once above; same tree/config).
        cache: cacheCtx,
        logger: deps.logger,
      });

      // BAIL-GUARD (FIX 2): a suffix invalidation may have killed this verify
      // while it ran. If so, state is already "invalidated" (set synchronously
      // by invalidateSuffix before any await) — bail without touching it. (Cast
      // defeats TS narrowing: `member.state` is mutated via an aliased reference
      // across the `runPipeline` await, so its static type here is stale.)
      if (member.state !== "verifying") return;

      // PHASE 7.5 (design §7.3): capture this pass's per-step results on the
      // member so the verdict's completeAttempt carries them — for the passing
      // path that fires later at LAND (the slot bridges runVerifyTask → land);
      // for the transient-fail/real-fail paths below it carries this run's steps.
      member.steps = toVerifyStepResults(pipeline.steps);

      if (pipeline.outcome === "pass") {
        member.state = "verified";
        return;
      }

      // A real VerifyResult — the SAME shape the single-command path branched on
      // (the captured failing-step trigger, never an abort-casualty).
      const verify = pipeline.failingStep!.verify;
      const disposition = classifyVerifyFailure(verify);
      if (disposition === "real" || member.retryCount >= maxVerifyRetries) {
        // Real failure, OR transient but the cap is reached → reject + suffix
        // invalidate (Step 6). The final failure is categorized normally for the
        // reject payload.
        const res = await onMemberFailed(
          member,
          batch,
          deps,
          {
            kind: "verify",
            exitCode: verify.exitCode,
            signal: verify.signal,
            stdout: verify.stdout,
            stderr: verify.stderr,
            timedOut: verify.timedOut,
          },
          ctx,
        );
        if (res.outcome === "rejected") ctx.rejected.push(member.request.id);
        return;
      }

      // Transient and under cap → retry IN PLACE: same speculative base, same
      // worktree (the rebased tree is still checked out), NO re-rebase.
      member.retryCount += 1;
      // Supersede the failed attempt. FIX A: "failed" (the complete endpoint enum
      // is [passed, failed, cancelled]; the design records the transient outcome).
      if (member.attemptId) {
        await deps.pmClient.completeAttempt(member.attemptId, {
          status: "failed",
          failureCategory: "other",
          failureReason: "transient verify failure; retrying",
          steps: member.steps ?? undefined,
        });
      }
      // member.retryCount is already incremented (1-based) above; index
      // retryCount-1 → first retry waits schedule[0]=1s, etc. (design §10.2:
      // 1s / 5s / 15s). Clamp to the last entry once we exceed the schedule.
      const backoffMs = schedule[member.retryCount - 1] ?? schedule[schedule.length - 1]; // 1s, 5s, 15s
      deps.logger.warn?.(
        `verify transient failure (retry ${member.retryCount}/${maxVerifyRetries}) for ${member.request.id}; backing off ${backoffMs}ms`,
      );
      // Re-check BEFORE sleep: a suffix invalidation may already have fired.
      if (member.state !== "verifying") return;
      await sleep(backoffMs, signal);
      // FIX C: re-check AFTER sleep, BEFORE startAttempt — the member may have
      // been invalidated (and its worktree released) during the backoff. This
      // guard MUST be the line immediately before startAttempt with NO await
      // between them.
      if (member.state !== "verifying") return;
      // FIX B: reuse the EXACT base expression the original startAttempt used —
      // baseShaOf(member.base) (the prefix anchor's liveMainSha or the chained
      // predecessor's rebasedTreeSha). member.base is non-null in `verifying`.
      const baseSha = baseShaOf(member.base as SpeculativeBase);
      const att = await deps.pmClient.startAttempt(member.request.id, baseSha, tags);
      member.attemptId = att.id;
      // loop: re-run ONLY runVerify (the worktree still holds the rebased tree).
    }
  } catch (err) {
    // If a suffix invalidation already tore this member down (state flipped off
    // "verifying"), do NOT funnel to the failure path — that would double-handle
    // an already-invalidated member. Same bail-guard as the happy path (FIX 2).
    if ((member.state as MemberState) !== "verifying") return;
    // The task must NEVER reject out of `Promise.race` — funnel any unexpected
    // error (e.g. a runVerify/onMemberFailed throw) to the failure path so the
    // member terminates and its slot is freed, instead of poisoning the drain.
    deps.logger.error(
      { requestId: member.request.id, err: errMessage(err) },
      "verify task threw; failing member",
    );
    try {
      const res = await onMemberFailed(
        member,
        batch,
        deps,
        {
          kind: "verify",
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: errMessage(err),
          timedOut: false,
        },
        ctx,
      );
      if (res.outcome === "rejected") ctx.rejected.push(member.request.id);
    } catch (failErr) {
      deps.logger.error(
        { requestId: member.request.id, err: errMessage(failErr) },
        "onMemberFailed threw while handling verify task error",
      );
    }
  } finally {
    // Source-of-truth convention: clearing `verify` on settle is how the drain
    // loop knows this member is no longer in flight.
    member.verify = null;
  }
}

// ─── runGroupLaneOnce (Phase 7.3 Step 10) ─────────────────────────

/**
 * Process ONE forming cross-repo group as an atomic step, with the lane lock
 * acquired once / released once (mirrors runBatchOnce's lock discipline — one
 * lane lock, §8). Returns `no_group` when nothing is forming (the caller then
 * falls through to the single-repo `runBatchOnce`), `lock_unavailable` when
 * another integrator holds the lane, or `resolved` with the group outcome.
 *
 * STEP-10/11 SEAM: a `ready_to_land` outcome means the assembled worktrees are
 * STILL HELD (Step 11 lands from them). Step 11 is not wired yet, so the live
 * loop must NOT leak the slots — it releases them here with a clear log + TODO.
 * Step 11 replaces that release with the actual atomic land.
 */
export async function runGroupLaneOnce(deps: RunBatchLoopDeps): Promise<RunGroupLaneOutcome> {
  const { pmClient, logger, projectId, resource } = deps;
  const groupLane = deps.groupLane;
  if (!groupLane) return { kind: "no_group" };

  // 1. Cheap fast path (NO lock): list forming groups AND open orphaned_inner
  //    incidents. Only when EITHER is non-empty do we take the lane lock. Both
  //    empty → no_group (the scheduler then falls through to the single-repo
  //    path), keeping the lock-free fast path of §7.2 / §8.
  let forming;
  let openIncidentCount = 0;
  try {
    const groups = await pmClient.listMergeGroups(projectId, {
      resource,
      state: "forming",
    });
    forming = groups[0];
  } catch (err) {
    logger.warn({ err: errMessage(err) }, "listMergeGroups failed");
    return { kind: "error", message: errMessage(err) };
  }
  try {
    const incidents = await pmClient.listMergeIncidents(projectId, {
      state: "open",
      type: "orphaned_inner",
    });
    openIncidentCount = incidents.length;
  } catch (err) {
    logger.warn({ err: errMessage(err) }, "listMergeIncidents failed (group lane)");
    return { kind: "error", message: errMessage(err) };
  }

  // PHASE 7.4 §4.2 PAUSE GATE (Step 12) — read ONCE near the top. Pause
  // SUPPRESSES the forming group (it is NEW admission of a cross-repo unit) but
  // does NOT suppress incident-driven recovery: an open orphaned-inner incident
  // is IN-FLIGHT cross-repo work (a half-landed group), and the rollforward
  // sweep is the no-abort drain of it — it MUST still run while paused. So a
  // paused lane keeps `openIncidentCount` driving the lock, but treats the
  // forming group as if absent (`formingToIntegrate === undefined`).
  const paused = await isPaused(deps);
  const formingToIntegrate = paused ? undefined : forming;
  if (paused && forming) {
    logger.info(
      { resource, groupId: forming.id },
      "Train paused; skipping new forming-group admission (recovery still runs)",
    );
  }

  // No admissible forming group AND no open incident → nothing to do this pass.
  // (While paused this is reached when the ONLY work was a forming group: the
  // group is suppressed and there are no incidents → no lock, no group pickup.)
  if (!formingToIntegrate && openIncidentCount === 0) {
    return { kind: "no_group" };
  }

  // 2. If a group is forming AND the lane is NOT paused, bind its members
  //    (needed for the lock representative + the integration call). For a
  //    recovery-only pass — OR a paused lane where the forming group is
  //    suppressed (`formingToIntegrate === undefined`) — there is no `group`, so
  //    the run becomes a recovery-only pass: the lock is taken (driven by the
  //    open incidents), recoverOrphanedInner runs, and the forming group is NOT
  //    integrated (markGroupIntegrating/runGroupIntegration never fire).
  let group: Awaited<ReturnType<typeof pmClient.getMergeGroup>> | undefined;
  if (formingToIntegrate) {
    try {
      group = await pmClient.getMergeGroup(formingToIntegrate.id);
    } catch (err) {
      logger.warn({ groupId: formingToIntegrate.id, err: errMessage(err) }, "getMergeGroup failed");
      return { kind: "error", message: errMessage(err) };
    }
  }

  // 3. Acquire the lane lock ONCE (like runBatchOnce). Representative = the
  //    forming group's first member (its intent seeds the lock) when integrating,
  //    else a recovery-marker (recovery-only pass). OUTSIDE the try/finally so a
  //    failed/unavailable acquire never enters the release.
  const rep = group?.members[0];
  try {
    const lock = await pmClient.acquireLock(projectId, resource, {
      taskId: rep?.taskId ?? null,
      branch: rep?.branch ?? null,
      commitSha: rep?.commitSha ?? null,
      verifyCmd: rep?.verifyCmd ?? deps.defaultVerifyCommand,
      worktreePath: null,
    });
    if (!lock.ok || lock.status === "queued") {
      logger.info(
        { lockStatus: lock.status },
        "Lock unavailable; another integrator holds the lane (group)",
      );
      return { kind: "lock_unavailable" };
    }
  } catch (err) {
    logger.warn({ err: errMessage(err) }, "acquireLock failed (group)");
    return { kind: "error", message: errMessage(err) };
  }

  // 4. Single group-lifetime heartbeat (mirrors runBatchOnce §9.2).
  const heartbeat = setInterval(() => {
    void pmClient.heartbeatLock(projectId, resource).catch((err: unknown) => {
      logger.debug({ err: errMessage(err) }, "heartbeat failed (group)");
    });
  }, deps.heartbeatIntervalMs ?? 60_000);
  heartbeat.unref?.();

  let released = false;
  const releaseLock = async (opts: { landedSha?: string; reason?: string }): Promise<void> => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    try {
      await pmClient.releaseLock(projectId, resource, opts);
    } catch (err) {
      logger.debug({ err: errMessage(err) }, "releaseLock failed (group, non-fatal)");
    }
  };

  let landResult: GroupLandResult | undefined;
  try {
    // STEP 12 (§7.2): run the orphaned-inner recovery sweep FIRST, under the
    // lane lock (so the rollforward push is serialized against any other land).
    // currentGroupId = the forming group's id when one is integrating this pass,
    // else undefined (recovery-only pass). recoverOrphanedInner is PM-keyed: a
    // git history that LOOKS like an orphan but has no open incident does
    // nothing. It leases/releases the correlated worktrees per incident.
    const recovery = await recoverOrphanedInner(
      { projectId, resource, currentGroupId: group?.id },
      {
        pmClient,
        logger,
        innerLane: groupLane.innerLane,
        outerLane: groupLane.outerLane,
        gitRemote: deps.gitRemote,
        gitMainBranch: deps.gitMainBranch,
        defaultVerifyCommand: deps.defaultVerifyCommand,
        verifyTimeoutSec: deps.verifyTimeoutSec,
        innerLogsDir: groupLane.innerLogsDir,
        outerLogsDir: groupLane.outerLogsDir,
      },
    );

    // Recovery-only pass (no forming group, or a paused-suppressed one): the
    // lane lock was taken solely to sweep incidents. Return `recovered` so
    // runBatchLoop treats it as work-done.
    if (!group) {
      return { kind: "recovered", recovery };
    }

    // PHASE 7.4 §3.2 (Step 12): a group is now integrating — reflect it in the
    // heartbeat in-flight counter (reset to 0 in the finally below so a throw
    // can't leave status stuck "integrating").
    if (deps.inFlight) deps.inFlight.groups = 1;

    const outcome = await runGroupIntegration(
      { id: group.id, members: group.members },
      {
        pmClient,
        logger,
        innerLane: groupLane.innerLane,
        outerLane: groupLane.outerLane,
        defaultVerifyCommand: deps.defaultVerifyCommand,
        verifyTimeoutSec: deps.verifyTimeoutSec,
        integratorId: groupLane.integratorId,
        innerLogsDir: groupLane.innerLogsDir,
        outerLogsDir: groupLane.outerLogsDir,
        // PHASE 7.5 Step 6 (§6): per-repo cache config + the lane key.
        projectId,
        resource,
        cacheEnabled: deps.cacheEnabled,
        cacheMode: deps.cacheMode,
      },
    );

    if (outcome.kind === "ready_to_land") {
      // STEP 11: the atomic land (inner-then-outer, §6) under THIS lane lock.
      // landAssembledGroup releases the correlated worktrees EXACTLY ONCE in its
      // own finally (CONSTRAINT D) — the scheduler must NOT release them here.
      landResult = await landAssembledGroup(
        {
          groupId: group.id,
          projectId,
          ready: outcome,
          innerRepoName: groupLane.innerLane.name,
          outerRepoName: groupLane.outerLane.name,
        },
        { pmClient, logger, gitRemote: deps.gitRemote, gitMainBranch: deps.gitMainBranch },
      );
    }

    return { kind: "resolved", outcome, land: landResult, recovery };
  } catch (err) {
    logger.error(
      { groupId: group?.id, err: errMessage(err) },
      "runGroupLaneOnce threw unexpectedly",
    );
    return { kind: "error", message: errMessage(err) };
  } finally {
    // PHASE 7.4 §3.2 (Step 12): the group step is done (or threw) — clear the
    // in-flight group counter so the heartbeat reports idle again. MUST run in
    // the finally so a throw can't leave the status stuck "integrating".
    if (deps.inFlight) deps.inFlight.groups = 0;

    // On a clean land, release the lock with the outer landedSha (Ro); else a
    // plain reason-based release.
    if (landResult?.kind === "landed") {
      await releaseLock({ landedSha: landResult.outerLandedSha });
    } else {
      await releaseLock({ reason: "group integration step complete" });
    }
  }
}

// ─── runBatchLoop ─────────────────────────────────────────────────

/**
 * Drive `runBatchOnce` forever (mirror of `runLoop`). Crash recovery
 * (`reclaimStrandedRequests`) runs once in index.ts before the loop, not here.
 *
 * Phase 7.3 (Step 10): when a group lane is configured, each iteration FIRST
 * tries `runGroupLaneOnce` (a forming cross-repo group). If a group was found
 * and resolved (or the lane was locked), the iteration is spent on the group;
 * otherwise the loop falls through to the UNCHANGED single-repo `runBatchOnce`.
 * No group lane → exact 7.2 behavior.
 */
export async function runBatchLoop(
  deps: RunBatchLoopDeps,
  opts: RunBatchLoopOptions = {},
): Promise<void> {
  const pollMs = opts.pollIntervalMs ?? 30_000;
  const { logger } = deps;

  // Phase 7.6.1 reclaim-sweep throttle: at most once per RESOLVER_SWEEP_INTERVAL_MS.
  let lastResolverSweepAt = 0;
  const RESOLVER_SWEEP_INTERVAL_MS = 60_000;

  while (deps.shouldContinue()) {
    // ── Phase 7.6.1 reclaim sweep (gated, throttled, NON-FATAL) ──────────
    // Recover `merge_resolutions` rows stranded in `resolving` (resolver session
    // died/timed out). Runs at the TOP of the tick, BEFORE the group/single
    // dispatch, and ALWAYS falls through (never `continue`s / blocks the train).
    // Gated on resolverEnabled; throttled to once a minute; any throw swallowed.
    if (deps.resolverEnabled && Date.now() - lastResolverSweepAt >= RESOLVER_SWEEP_INTERVAL_MS) {
      lastResolverSweepAt = Date.now();
      try {
        await reclaimResolvingResolutions({
          pmClient: deps.pmClient,
          logger: deps.logger,
          projectId: deps.projectId,
          resource: deps.resource,
          timeBudgetSec: deps.resolverTimeBudgetSec ?? 600,
        });
      } catch (err) {
        deps.logger.error({ err: errMessage(err) }, "resolver reclaim sweep threw (swallowed)");
      }
    }

    // ── Phase 7.3 group dispatch (Step 10). Only when a group lane exists. ──
    if (deps.groupLane) {
      let groupOutcome: RunGroupLaneOutcome;
      try {
        groupOutcome = await runGroupLaneOnce(deps);
      } catch (err) {
        logger.error({ err: errMessage(err) }, "runGroupLaneOnce threw unexpectedly");
        groupOutcome = { kind: "error", message: errMessage(err) };
      }
      if (!deps.shouldContinue()) break;

      if (groupOutcome.kind !== "no_group") {
        // A group/recovery was handled (resolved / recovered / lane locked /
        // error). Spend this iteration on it; back off briefly on lock/error,
        // else loop again.
        if (groupOutcome.kind === "lock_unavailable" || groupOutcome.kind === "error") {
          await deps.waitForWork(Math.min(pollMs, 5000));
        }
        // resolved / recovered → loop again immediately (drain further forming
        // groups / queued requests / open incidents).
        continue;
      }
      // no_group → fall through to the single-repo speculative path.
    }

    let outcome: RunBatchOutcome;
    try {
      outcome = await runBatchOnce(deps);
    } catch (err) {
      logger.error({ err: errMessage(err) }, "runBatchOnce threw unexpectedly");
      outcome = { kind: "error", message: errMessage(err) };
    }

    if (!deps.shouldContinue()) break;

    if (outcome.kind === "idle") {
      await deps.waitForWork(pollMs);
    } else if (outcome.kind === "lock_unavailable" || outcome.kind === "error") {
      await deps.waitForWork(Math.min(pollMs, 5000));
    }
    // drained: loop again immediately to drain the queue.
  }
}
