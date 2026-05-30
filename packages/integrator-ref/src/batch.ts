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
import type { MergeRequestView } from "@pm/shared";
import { type PmClient } from "./pm-client.js";
import { categorize, classifyVerifyFailure } from "./categorize.js";
import { isApiError, errMessage } from "./loop.js";
import {
  runGroupIntegration,
  type RepoLane,
  type GroupIntegrationOutcome,
} from "./group-integration.js";
import {
  landAssembledGroup,
  type GroupLandResult,
} from "./group-land.js";
import {
  recoverOrphanedInner,
  type RecoverResult,
} from "./group-recovery.js";

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
   * STEP-7 SEAM (design §13.2): optional batch-marker sink. Step 6 emits the
   * four markers (`started`/`member_landed`/`member_invalidated`/`completed`)
   * here; Step 7 wires this to the PM relay endpoint. No-op when absent.
   */
  onBatchEvent?: (event: BatchEvent) => void;
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

function logPathFor(logsDir: string, attemptId: string): string {
  return path.join(logsDir, `${attemptId}.log`);
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
export function survivingPredecessor(
  member: Member,
  batch: Batch,
): Member | undefined {
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
    throw new Error(
      `predecessor ${predecessor.request.id} has no materializable rebased tree`,
    );
  }

  // §4.3: pull the predecessor's rebased commit from its worktree into ours.
  await gitOps.fetchFromPath(
    predecessor.worktree.path,
    predecessor.rebasedTreeSha,
  );

  const liveMainSha =
    batch.members[0]?.base?.liveMainSha ?? predecessor.base?.liveMainSha ?? "";
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
    member.worktree && attemptId
      ? logUrlFor(member.worktree.logsDir, attemptId)
      : undefined;

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
    const reason =
      cat.reason ||
      summaryLine(failure.stderr || failure.stdout) ||
      "verify failed";
    const excerpt = `${failure.stdout}\n${failure.stderr}`.slice(
      0,
      LOG_EXCERPT_CAP,
    );
    if (attemptId) {
      await pmClient.completeAttempt(attemptId, {
        status: "failed",
        failureCategory: cat.category,
        failureReason: reason,
        failedFiles: cat.failedFiles,
        logExcerpt: excerpt,
        logUrl,
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
export async function tryLand(
  batch: Batch,
  deps: BatchDeps,
  ctx: BatchCtx,
): Promise<void> {
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
  const { pmClient, pool, logger, projectId, resource, defaultVerifyCommand } =
    deps;

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
  const releaseLock = async (opts: {
    landedSha?: string;
    reason?: string;
  }): Promise<void> => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    batch.lockHeld = false;
    try {
      await pmClient.releaseLock(projectId, resource, opts);
    } catch (err) {
      logger.debug({ err: errMessage(err) }, "releaseLock failed (non-fatal)");
    }
  };

  const ctx: BatchCtx = { landed: [], rejected: [], requeued: [] };

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

      // ── ADMIT phase ──────────────────────────────────────────────
      let admittedThisPass = 0;
      for (;;) {
        const wt = pool.acquire();
        if (!wt) break; // backpressure: no idle slot → stop admitting for now
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
        const member = await admitAndRebase(
          req,
          wt,
          position,
          batch,
          deps,
          ctx,
        );
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

      if (inFlight.length === 0) {
        // Nothing is verifying. Loop again only if this pass made forward
        // progress that may have UNBLOCKED more admission — either it admitted
        // a member (whose verify may have already settled, e.g. a fast no-op /
        // failed-at-admit member) OR it landed a member and thereby freed a
        // pool slot for a previously backpressured queued request. Otherwise
        // the queue is drained and every member is terminal → done.
        if (admittedThisPass > 0 || landedThisPass > 0 || requeuedThisPass > 0)
          continue;
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
    logger.error(
      { err: errMessage(err) },
      "Unexpected error draining batch",
    );
    return { kind: "error", message: errMessage(err) };
  } finally {
    // 5. Release the lane lock exactly once on any post-acquire exit (§9.3).
    const lastLanded = ctx.landed.at(-1);
    if (lastLanded) {
      const landedSha =
        batch.members.find((m) => m.request.id === lastLanded)?.landedSha ??
        undefined;
      await releaseLock({ landedSha });
    } else {
      await releaseLock({ reason: "batch drained with no land" });
    }

    // STEP-7 SEAM (§13.2): emit `completed`. Counts come from the FINAL member
    // states — `landed`/`failed` are terminal; `invalidated` counts members
    // left in the `invalidated` state (their speculation was voided; any
    // re-admitted replacement is a distinct member that lands/fails on its own).
    const count = (s: MemberState): number =>
      batch.members.filter((m) => m.state === s).length;
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
      logger.info(
        { requestId: req.id },
        "Pickup returned 409; request no longer queued",
      );
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

  // Rebase the request's branch/commit onto the speculative base.
  const ref = req.branch ?? req.commitSha;
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

  const rebase = await gitOps.rebaseOnto(baseSha, ref);
  // CASCADE-RACE GUARD (again, post-rebase await): a predecessor may have failed
  // and invalidated this member while we rebased. invalidateSuffix already
  // cancelled its attempt + reset it; do not interpret the rebase result.
  // (Cast defeats TS narrowing — see the startAttempt guard above.)
  if ((member.state as MemberState) === "invalidated") {
    return member;
  }
  if (!rebase.ok) {
    const res = await onMemberFailed(
      member,
      batch,
      deps,
      {
        kind: "conflict",
        conflictingFiles: rebase.conflictingFiles,
        stderr: rebase.stderr,
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
    const maxVerifyRetries =
      deps.maxVerifyRetries ?? DEFAULT_MAX_VERIFY_RETRIES;
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
    for (;;) {
      // attemptId changes across retries (each retry starts a fresh attempt), so
      // the log path is recomputed per iteration.
      const logPath = logPathFor(wt.logsDir, member.attemptId as string);

      const verify = await gitOps.runVerify(
        verifyCommand,
        deps.verifyTimeoutSec * 1000,
        { cwd: wt.path, logPath, signal },
      );

      // BAIL-GUARD (FIX 2): a suffix invalidation may have killed this verify
      // while it ran. If so, state is already "invalidated" (set synchronously
      // by invalidateSuffix before any await) — bail without touching it. (Cast
      // defeats TS narrowing: `member.state` is mutated via an aliased reference
      // across the `runVerify` await, so its static type here is stale.)
      if (member.state !== "verifying") return;

      if (verify.exitCode === 0 && !verify.timedOut) {
        member.state = "verified";
        return;
      }

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
        });
      }
      // member.retryCount is already incremented (1-based) above; index
      // retryCount-1 → first retry waits schedule[0]=1s, etc. (design §10.2:
      // 1s / 5s / 15s). Clamp to the last entry once we exceed the schedule.
      const backoffMs =
        schedule[member.retryCount - 1] ?? schedule[schedule.length - 1]; // 1s, 5s, 15s
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
      const att = await deps.pmClient.startAttempt(
        member.request.id,
        baseSha,
        tags,
      );
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
export async function runGroupLaneOnce(
  deps: RunBatchLoopDeps,
): Promise<RunGroupLaneOutcome> {
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
  if (!forming && openIncidentCount === 0) return { kind: "no_group" };

  // 2. If a group is forming, bind its members (needed for the lock
  //    representative + the integration call). For a recovery-only pass there is
  //    no group; the lock uses a recovery-marker representative.
  let group: Awaited<ReturnType<typeof pmClient.getMergeGroup>> | undefined;
  if (forming) {
    try {
      group = await pmClient.getMergeGroup(forming.id);
    } catch (err) {
      logger.warn(
        { groupId: forming.id, err: errMessage(err) },
        "getMergeGroup failed",
      );
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
  const releaseLock = async (opts: {
    landedSha?: string;
    reason?: string;
  }): Promise<void> => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    try {
      await pmClient.releaseLock(projectId, resource, opts);
    } catch (err) {
      logger.debug(
        { err: errMessage(err) },
        "releaseLock failed (group, non-fatal)",
      );
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

    // Recovery-only pass (no forming group): the lane lock was taken solely to
    // sweep incidents. Return `recovered` so runBatchLoop treats it as work-done.
    if (!group) {
      return { kind: "recovered", recovery };
    }

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

  while (deps.shouldContinue()) {
    // ── Phase 7.3 group dispatch (Step 10). Only when a group lane exists. ──
    if (deps.groupLane) {
      let groupOutcome: RunGroupLaneOutcome;
      try {
        groupOutcome = await runGroupLaneOnce(deps);
      } catch (err) {
        logger.error(
          { err: errMessage(err) },
          "runGroupLaneOnce threw unexpectedly",
        );
        groupOutcome = { kind: "error", message: errMessage(err) };
      }
      if (!deps.shouldContinue()) break;

      if (groupOutcome.kind !== "no_group") {
        // A group/recovery was handled (resolved / recovered / lane locked /
        // error). Spend this iteration on it; back off briefly on lock/error,
        // else loop again.
        if (
          groupOutcome.kind === "lock_unavailable" ||
          groupOutcome.kind === "error"
        ) {
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
