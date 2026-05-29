import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import type { GitOps } from "./git-ops.js";
import type { Worktree } from "./worktree.js";
import { PmApiError, type PmClient } from "./pm-client.js";
import { categorize } from "./categorize.js";

const LOG_EXCERPT_CAP = 4096;

// ─── Dependencies + outcome types ─────────────────────────────────

export interface RunOnceDeps {
  pmClient: PmClient;
  gitOps: GitOps;
  worktree: Worktree;
  logger: Logger;
  projectId: string;
  resource: string;
  defaultVerifyCommand: string;
  verifyTimeoutSec: number;
  gitRemote: string;
  gitMainBranch: string;
}

export type RunOnceOutcome =
  | { kind: "idle" }
  | { kind: "landed"; requestId: string; landedSha: string }
  | { kind: "rejected"; requestId: string; category: string }
  | { kind: "push_race_requeued"; requestId: string }
  | { kind: "lock_unavailable"; requestId: string }
  | { kind: "transition_lost"; requestId: string }
  | { kind: "error"; requestId?: string; message: string };

export interface RunLoopDeps extends RunOnceDeps {
  /** Resolves when an SSE/wakeup signal arrives or the poll tick elapses. */
  waitForWork: (pollMs: number) => Promise<void>;
  /** Should the loop keep running? Flipped by the SIGTERM/SIGINT handler. */
  shouldContinue: () => boolean;
}

export interface RunLoopOptions {
  pollIntervalMs?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────

export function isApiError(err: unknown, status?: number): err is PmApiError {
  if (!(err instanceof PmApiError)) return false;
  return status === undefined || err.status === status;
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

function logUrlFor(logsDir: string, attemptId: string): string {
  const p = path.join(logsDir, `${attemptId}.log`);
  // Normalize backslashes so the file:// URL is well-formed on Windows.
  return pathToFileURL(p).href;
}

function logPathFor(logsDir: string, attemptId: string): string {
  return path.join(logsDir, `${attemptId}.log`);
}

function summaryLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return (line ?? "").trim().slice(0, 500);
}

/**
 * Sleep that resolves early when `wake` fires. Returns a tuple of
 * (promise, resolve) so the caller can wake it.
 */
export function sleepOrWake(ms: number): { promise: Promise<void>; wake: () => void } {
  let resolveFn: () => void = () => {};
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  const wake = (): void => {
    if (timer) clearTimeout(timer);
    resolveFn();
  };
  return { promise, wake };
}

// ─── runOnce ──────────────────────────────────────────────────────

/**
 * Process at most one queued merge request. Mirrors design §14.7.
 * The Stage 1 lock is acquired on pickup and released on every exit path.
 */
export async function runOnce(deps: RunOnceDeps): Promise<RunOnceOutcome> {
  const {
    pmClient,
    gitOps,
    worktree,
    logger,
    projectId,
    resource,
    defaultVerifyCommand,
    verifyTimeoutSec,
    gitRemote,
    gitMainBranch,
  } = deps;

  // 1. Find the next queued request, oldest first.
  let queued;
  try {
    queued = await pmClient.listMergeRequests(projectId, {
      resource,
      status: "queued",
    });
  } catch (err) {
    logger.warn({ err: errMessage(err) }, "Failed to list queued requests");
    return { kind: "error", message: errMessage(err) };
  }
  const request = queued[0];
  if (!request) return { kind: "idle" };

  // 2. Acquire the Stage 1 lock — defense-in-depth against duplicate integrators.
  try {
    const lock = await pmClient.acquireLock(projectId, resource, {
      taskId: request.taskId,
      branch: request.branch,
      commitSha: request.commitSha,
      verifyCmd: request.verifyCmd ?? defaultVerifyCommand,
      worktreePath: worktree.path,
    });
    if (!lock.ok || lock.status === "queued") {
      logger.info(
        { requestId: request.id, lockStatus: lock.status },
        "Lock unavailable; another integrator holds the lane",
      );
      return { kind: "lock_unavailable", requestId: request.id };
    }
  } catch (err) {
    logger.warn(
      { requestId: request.id, err: errMessage(err) },
      "acquireLock failed",
    );
    return { kind: "error", requestId: request.id, message: errMessage(err) };
  }

  // Heartbeat the lock while we work. Cleared on every exit path below.
  const heartbeat = setInterval(() => {
    void pmClient.heartbeatLock(projectId, resource).catch((err: unknown) => {
      logger.debug({ err: errMessage(err) }, "heartbeat failed");
    });
  }, 60_000);
  heartbeat.unref?.();

  const releaseLock = async (opts: {
    landedSha?: string;
    reason?: string;
  }): Promise<void> => {
    clearInterval(heartbeat);
    try {
      await pmClient.releaseLock(projectId, resource, opts);
    } catch (err) {
      logger.debug({ err: errMessage(err) }, "releaseLock failed (non-fatal)");
    }
  };

  try {
    // 3. Pick up the request (queued → integrating).
    try {
      await pmClient.pickupMergeRequest(request.id);
    } catch (err) {
      if (isApiError(err, 409)) {
        // Lost the race / admin force-cancelled. Nothing to do.
        logger.info(
          { requestId: request.id },
          "Pickup returned 409; request no longer queued",
        );
        await releaseLock({ reason: "pickup lost" });
        return { kind: "transition_lost", requestId: request.id };
      }
      throw err;
    }

    // 4. Reset the worktree to a clean main (with corruption recovery).
    try {
      await worktree.resetForAttempt();
    } catch (err) {
      logger.warn(
        { requestId: request.id, err: errMessage(err) },
        "Worktree reset failed; checking for corruption",
      );
      if (await worktree.detectCorruption()) {
        logger.warn({ requestId: request.id }, "Worktree corrupt; repairing");
        await worktree.repair();
        await worktree.resetForAttempt();
      } else {
        throw err;
      }
    }

    // Determine the base SHA (current main HEAD after reset).
    const baseSha = await gitOps.resolveRef("HEAD");

    // 5. Start the first attempt.
    const attempt = await pmClient.startAttempt(request.id, baseSha);
    const attemptId = attempt.id;
    const logPath = logPathFor(worktree.logsDir, attemptId);
    const logUrl = logUrlFor(worktree.logsDir, attemptId);

    // 6. Rebase the request's branch/commit onto baseSha.
    const ref = request.branch ?? request.commitSha;
    if (!ref) {
      // No branch and no commit: nothing to integrate. Reject as "other".
      await pmClient.completeAttempt(attemptId, {
        status: "failed",
        failureCategory: "other",
        failureReason: "request has neither branch nor commitSha",
      });
      await pmClient.rejectMergeRequest(request.id, {
        category: "other",
        reason: "request has neither branch nor commitSha",
      });
      await releaseLock({ reason: "no ref to integrate" });
      return { kind: "rejected", requestId: request.id, category: "other" };
    }

    const rebase = await gitOps.rebaseOnto(baseSha, ref);
    if (!rebase.ok) {
      const reason =
        "rebase conflict on " + rebase.conflictingFiles.join(", ");
      const excerpt = rebase.stderr.slice(0, LOG_EXCERPT_CAP);
      await pmClient.completeAttempt(attemptId, {
        status: "failed",
        failureCategory: "conflict",
        failureReason: reason,
        failedFiles: rebase.conflictingFiles,
        logExcerpt: excerpt,
        logUrl,
      });
      await pmClient.rejectMergeRequest(request.id, {
        category: "conflict",
        reason,
        failedFiles: rebase.conflictingFiles,
        logExcerpt: excerpt,
        logUrl,
      });
      await releaseLock({ reason: "rebase conflict" });
      return { kind: "rejected", requestId: request.id, category: "conflict" };
    }

    // 7. Run verify against the rebased tree.
    const verifyCommand = request.verifyCmd ?? defaultVerifyCommand;
    const verify = await gitOps.runVerify(
      verifyCommand,
      verifyTimeoutSec * 1000,
      { cwd: worktree.path, logPath },
    );

    if (verify.exitCode !== 0 || verify.timedOut) {
      const cat = categorize({
        exitCode: verify.exitCode,
        signal: verify.signal,
        stdout: verify.stdout,
        stderr: verify.stderr,
        timedOut: verify.timedOut,
      });
      const reason =
        cat.reason || summaryLine(verify.stderr || verify.stdout) || "verify failed";
      const excerpt = `${verify.stdout}\n${verify.stderr}`.slice(0, LOG_EXCERPT_CAP);
      await pmClient.completeAttempt(attemptId, {
        status: "failed",
        failureCategory: cat.category,
        failureReason: reason,
        failedFiles: cat.failedFiles,
        logExcerpt: excerpt,
        logUrl,
      });
      await pmClient.rejectMergeRequest(request.id, {
        category: cat.category,
        reason,
        failedFiles: cat.failedFiles,
        logExcerpt: excerpt,
        logUrl,
      });
      await releaseLock({ reason });
      return { kind: "rejected", requestId: request.id, category: cat.category };
    }

    // 8. Verify passed. Push the tree to the remote.
    const push = await gitOps.push(gitRemote, gitMainBranch);
    if (!push.ok) {
      if (push.reason === "non_fast_forward") {
        // Push race: main moved during verify. Cancel + re-queue.
        await pmClient.completeAttempt(attemptId, { status: "cancelled" });
        await pmClient.resetToQueued(
          request.id,
          "push race; main moved during verify",
        );
        await releaseLock({ reason: "push race" });
        return { kind: "push_race_requeued", requestId: request.id };
      }
      // auth / network / other push failure → reject as "other".
      const reason = `push failed (${push.reason}): ${summaryLine(push.stderr)}`;
      await pmClient.completeAttempt(attemptId, {
        status: "failed",
        failureCategory: "other",
        failureReason: reason,
        logExcerpt: push.stderr.slice(0, LOG_EXCERPT_CAP),
        logUrl,
      });
      await pmClient.rejectMergeRequest(request.id, {
        category: "other",
        reason,
        logExcerpt: push.stderr.slice(0, LOG_EXCERPT_CAP),
        logUrl,
      });
      await releaseLock({ reason });
      return { kind: "rejected", requestId: request.id, category: "other" };
    }

    // 9. Successful land.
    await pmClient.completeAttempt(attemptId, {
      status: "passed",
      treeSha: push.pushedSha,
    });
    await pmClient.landMergeRequest(request.id, push.pushedSha);
    await releaseLock({ landedSha: push.pushedSha });
    return { kind: "landed", requestId: request.id, landedSha: push.pushedSha };
  } catch (err) {
    // Catch-all: an unexpected error (incl. a 409 from a force-cancel mid-flight).
    if (isApiError(err, 409)) {
      logger.info(
        { requestId: request.id },
        "Service returned 409 mid-flight (likely admin force-cancel); abandoning local work",
      );
      await releaseLock({ reason: "admin force-cancelled" });
      return { kind: "transition_lost", requestId: request.id };
    }
    logger.error(
      { requestId: request.id, err: errMessage(err) },
      "Unexpected error during integration",
    );
    await releaseLock({ reason: errMessage(err) });
    return { kind: "error", requestId: request.id, message: errMessage(err) };
  }
}

// ─── runLoop ──────────────────────────────────────────────────────

export async function runLoop(
  deps: RunLoopDeps,
  opts: RunLoopOptions = {},
): Promise<void> {
  const pollMs = opts.pollIntervalMs ?? 30_000;
  const { logger } = deps;

  while (deps.shouldContinue()) {
    let outcome: RunOnceOutcome;
    try {
      outcome = await runOnce(deps);
    } catch (err) {
      logger.error({ err: errMessage(err) }, "runOnce threw unexpectedly");
      outcome = { kind: "error", message: errMessage(err) };
    }

    if (!deps.shouldContinue()) break;

    if (outcome.kind === "idle") {
      // Nothing to do — wait for an SSE wakeup or the poll tick.
      await deps.waitForWork(pollMs);
    } else if (
      outcome.kind === "lock_unavailable" ||
      outcome.kind === "error"
    ) {
      // Back off briefly before retrying so we don't hot-loop on a failure.
      await deps.waitForWork(Math.min(pollMs, 5000));
    }
    // landed / rejected / push_race_requeued / transition_lost: loop again
    // immediately to drain the queue.
  }
}
