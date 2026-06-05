/**
 * Phase 7.6.1 — periodic reclaim sweep for stranded `resolving` resolutions.
 *
 * A resolution row is moved `pending → resolving` by the resolver worker BEFORE
 * any fallible work (worktree build, agent spawn, push, resubmit). If the
 * resolver session dies or times out AFTER that transition but BEFORE it records
 * a terminal outcome (`resolved`/`escalated`/`failed`), the row is stranded in
 * `resolving` with no auto-reclaim — the v1 limitation called out in
 * resolution-outcome.ts and phase-7.6 design §"honest limitation".
 *
 * This sweep is the v2 reclaim. On a throttled cadence (wired into runBatchLoop,
 * gated on resolver.enabled) it lists `resolving` rows for its lane and, past a
 * deadline (the resolver time budget + a grace floor — so a still-LIVE session
 * is never reclaimed out from under itself), reconciles each:
 *
 *   - a resubmission EXISTS (a request with resolvedFrom == origin) → the session
 *     DID produce a landable resubmission before it died (the resolvedResolution
 *     call was the only thing that failed). Reconcile the row to `resolved`,
 *     cross-linking that request. NEVER escalate — that would lie to the author
 *     (the work is on the train).
 *   - NO resubmission → the session died before producing anything. Escalate
 *     `failed` → author + post a best-effort merge_rejection comment so the
 *     author fixes forward (their original commit is intact, untouched).
 *
 * Mirrors recovery.ts's non-fatal discipline: a list failure returns zeroes; a
 * per-row failure is caught (a 409 → "handled", another path/daemon won the
 * race; anything else → "skipped" + warn, retried next sweep). NEVER throws.
 */
import type { Logger } from "./logger.js";
import type { PmClient } from "./pm-client.js";
import type { MergeResolutionView } from "@pm/shared";
import { isApiError, errMessage } from "./loop.js";

/**
 * A grace floor added on top of the time budget before a `resolving` row is
 * eligible for reclaim. Guards against reclaiming a session that is still LIVE
 * (just past its budget but not yet torn down). The effective grace is
 * `max(GRACE_FLOOR_MS, 0.25 * budgetMs)`.
 */
const GRACE_FLOOR_MS = 120_000;

export interface ReclaimResolutionsResult {
  scanned: number;
  reconciled: number;
  escalated: number;
  handled: number;
  skipped: number;
}

/** The narrow PM surface the sweep needs (testable with a fake). */
export interface ReclaimResolutionsDeps {
  pmClient: Pick<
    PmClient,
    | "listResolutions"
    | "listMergeRequests"
    | "resolvedResolution"
    | "escalateResolution"
    | "getMergeRequest"
    | "postTaskComment"
  >;
  logger: Logger;
  projectId: string;
  resource: string;
  /** The resolver time budget (settings.integrator.resolver.time_budget_sec). */
  timeBudgetSec: number;
  /** Override "now" (tests). Defaults to Date.now(). */
  now?: () => number;
}

export async function reclaimResolvingResolutions(
  deps: ReclaimResolutionsDeps,
): Promise<ReclaimResolutionsResult> {
  const { pmClient, logger, projectId, resource, timeBudgetSec } = deps;
  const now = (deps.now ?? Date.now)();
  const budgetMs = timeBudgetSec * 1000;
  const grace = Math.max(GRACE_FLOOR_MS, 0.25 * budgetMs);

  let resolving: MergeResolutionView[];
  try {
    resolving = await pmClient.listResolutions(projectId, {
      state: "resolving",
      resource,
    });
  } catch (err) {
    logger.warn({ err: errMessage(err) }, "reclaim: listResolutions failed");
    return { scanned: 0, reconciled: 0, escalated: 0, handled: 0, skipped: 0 };
  }

  let reconciled = 0;
  let escalated = 0;
  let handled = 0;
  let skipped = 0;

  for (const r of resolving) {
    try {
      // No attempt-start timestamp (or unparseable) → cannot judge liveness;
      // leave it for a later sweep (or a human).
      if (!r.attemptStartedAt) {
        skipped += 1;
        continue;
      }
      const startedMs = Date.parse(r.attemptStartedAt);
      if (Number.isNaN(startedMs)) {
        skipped += 1;
        continue;
      }
      // Still inside budget + grace → a live session may still own this row.
      // NEVER reclaim it out from under a running resolver.
      if (now < startedMs + budgetMs + grace) {
        skipped += 1;
        continue;
      }
      // A resolving row with no origin can't be reconciled or have its author
      // commented — defensive skip.
      if (!r.originRequestId) {
        skipped += 1;
        continue;
      }

      // Did the (now-dead) session manage to resubmit before it died? A request
      // with resolvedFrom == origin IS that resubmission.
      const resub = await pmClient.listMergeRequests(projectId, {
        resolvedFrom: r.originRequestId,
      });
      const found = resub[0];

      if (found) {
        // RECONCILE: the work is on the train; only the resolvedResolution call
        // failed. Record the row resolved — NEVER escalate (that would lie).
        await pmClient.resolvedResolution(r.id, { resolvedRequestId: found.id });
        reconciled += 1;
        logger.info(
          { resolutionId: r.id, resolvedRequestId: found.id },
          "reclaim: reconciled stranded resolving row to resolved (resubmission found)",
        );
      } else {
        // ESCALATE: the session died with nothing produced. Hand the conflict
        // back to the author + post a best-effort fix-forward comment.
        await pmClient.escalateResolution(r.id, {
          state: "failed",
          target: "author",
          reason: "session_died_or_timeout",
        });
        let origin = null;
        try {
          origin = await pmClient.getMergeRequest(r.originRequestId);
        } catch {
          // Non-fatal: the row is already escalated; we just can't comment.
        }
        if (origin?.taskId) {
          try {
            await pmClient.postTaskComment(origin.taskId, {
              body:
                "Auto-resolution session died or timed out before it could land. " +
                "Conflicting files unchanged; your original commit is intact — " +
                "fix forward, don't redo.",
              commentType: "merge_rejection",
              metadata: {
                resolutionId: r.id,
                originRequestId: r.originRequestId,
                reason: "session_died_or_timeout",
              },
            });
          } catch (err) {
            logger.warn(
              { resolutionId: r.id, err: errMessage(err) },
              "reclaim: postTaskComment failed (non-fatal); row already escalated",
            );
          }
        }
        escalated += 1;
        logger.info(
          { resolutionId: r.id, originRequestId: r.originRequestId },
          "reclaim: escalated stranded resolving row (no resubmission; session died)",
        );
      }
    } catch (err) {
      // A 409 means another path/daemon already drove this row terminal (it
      // raced us) — count it handled, not a failure. Anything else: skip + warn,
      // retry on the next sweep.
      if (isApiError(err, 409)) {
        handled += 1;
        continue;
      }
      skipped += 1;
      logger.warn({ resolutionId: r.id, err: errMessage(err) }, "reclaim: row failed; will retry");
    }
  }

  return {
    scanned: resolving.length,
    reconciled,
    escalated,
    handled,
    skipped,
  };
}
