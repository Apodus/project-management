/**
 * Phase 7.6 Step 7 — the resolver `onOutcome` handler (design §5.3/§5.4/§8).
 *
 * This is the STEP-7 SEAM the resolver pool (`resolver-pool.ts`) hands its
 * terminal `ResolutionOutcome` to, BEFORE it releases the worktree slot (the
 * resolved path needs the resolver clone alive to push). It is extracted out of
 * `index.ts` into a `makeOnOutcome(deps)` factory so it is unit-testable with a
 * fake pmClient + fake gitOps.
 *
 * Two terminal shapes, per the contract (`resolver-pool.ts` ResolutionOutcome):
 *
 *  - "resolved": the agent produced a tree that PASSED the local verify gate.
 *    The resolved commit lives ONLY in the resolver clone. We:
 *      1. fetch the origin request (for its taskId + verifyCmd),
 *      2. PUSH the resolved commit from `worktreePath` to a stable resolution
 *         branch (`pm/resolution-<id>`),
 *      3. RESUBMIT it as a new merge request carrying `resolvedFrom = originId`
 *         (the no-recursion marker, §5.4) and — CRITICALLY — `verifyCmd =
 *         origin.verifyCmd` (omitting it silently uses the project default = the
 *         WRONG gate),
 *      4. record the resolution `resolved` cross-linking the new request.
 *    A push/submit failure ESCALATES (`failed`, resubmit_push_failed /
 *    resubmit_submit_failed) + posts the merge_rejection comment — the resolution
 *    is still `resolving`, so `failed` is a legal transition.
 *
 *  - "escalate": the resolution could not land (verify failed / budget / infra).
 *    We transition the resolution (escalated | failed) and post a
 *    `merge_rejection` comment on the origin task so the author fixes forward.
 *
 * NON-FATAL DISCIPLINE: nothing thrown escapes this handler (the pool catches
 * too, but we are defensive). A push/submit failure escalates; a
 * `resolvedResolution` failure AFTER a successful submit is LOG-ONLY (escalating
 * there would be a lie — the resubmitted request already rides the train).
 */
import type { ResolutionOutcome } from "./resolver-pool.js";
import type { GitOps } from "./git-ops.js";
import type { PmClient } from "./pm-client.js";
import type { Logger } from "./logger.js";
import type { MergeRequestDetailView } from "./pm-client.js";
import { errMessage } from "./loop.js";

/**
 * The slice of the integrator config the handler needs: the project + lane it
 * serves and the git remote it pushes resolution branches to.
 */
export interface ResolutionOutcomeCfg {
  projectId: string;
  gitRemote: string;
}

export interface ResolutionOutcomeDeps {
  /** Narrowed to exactly the PM calls the handler makes. */
  pmClient: Pick<
    PmClient,
    | "getMergeRequest"
    | "submitMergeRequest"
    | "resolvedResolution"
    | "escalateResolution"
    | "postTaskComment"
  >;
  /** Per-worktree GitOps factory (mirrors index.ts `makeGitOps`). */
  makeGitOps: (worktreePath: string) => Pick<GitOps, "push">;
  logger: Logger;
  cfg: ResolutionOutcomeCfg;
}

/** Stable resolution branch name (one per resolution id). */
function resolutionBranch(resolutionId: string): string {
  return `pm/resolution-${resolutionId}`;
}

/**
 * Build the `merge_rejection` comment body posted on the origin task when a
 * resolution escalates. Carries the conflicting files + the verdict/budget
 * reason + the literal fix-forward note so the author knows their original
 * commit is intact and must NOT be redone.
 */
function buildRejectionBody(outcome: ResolutionOutcome, reason: string): string {
  const files = outcome.job.conflictingFiles.length
    ? outcome.job.conflictingFiles.join(", ")
    : "(none reported)";
  return [
    `Auto-resolution of a rebase conflict did not land (${reason}).`,
    `Conflicting files: ${files}.`,
    "auto-resolution attempted; original commit intact — fix forward, don't redo.",
  ].join("\n");
}

export function makeOnOutcome(
  deps: ResolutionOutcomeDeps,
): (outcome: ResolutionOutcome) => Promise<void> {
  const { pmClient, makeGitOps, logger, cfg } = deps;

  /**
   * Escalate the resolution + post the merge_rejection comment on the origin
   * task. `alreadyEscalated` skips the escalateResolution call when the caller
   * (the "escalate" branch) has already transitioned the row — we then only
   * post the comment. A null origin.taskId skips the comment (mirrors reject()).
   */
  async function escalateAndComment(
    outcome: ResolutionOutcome,
    state: "escalated" | "failed",
    reason: string,
    origin: MergeRequestDetailView | null,
    opts?: { alreadyEscalated?: boolean },
  ): Promise<void> {
    if (!opts?.alreadyEscalated) {
      await pmClient.escalateResolution(outcome.resolutionId, {
        state,
        target: "author",
        reason,
        detail: outcome.detail,
      });
    }
    if (origin?.taskId == null) {
      logger.info(
        { resolutionId: outcome.resolutionId, reason },
        "resolution escalated; origin has no taskId — skipping merge_rejection comment",
      );
      return;
    }
    await pmClient.postTaskComment(origin.taskId, {
      body: buildRejectionBody(outcome, reason),
      commentType: "merge_rejection",
      metadata: {
        resolutionId: outcome.resolutionId,
        originRequestId: outcome.job.originRequestId,
        reason,
      },
    });
  }

  async function handleResolved(outcome: ResolutionOutcome): Promise<void> {
    if (outcome.kind !== "resolved") return;

    // 1. Fetch the origin (for taskId + verifyCmd). If THIS throws, we cannot
    //    even resubmit; escalate `failed` (no origin → null taskId → no comment).
    let origin: MergeRequestDetailView;
    try {
      origin = await pmClient.getMergeRequest(outcome.job.originRequestId);
    } catch (err) {
      logger.error(
        { resolutionId: outcome.resolutionId, err: errMessage(err) },
        "resolved: getMergeRequest(origin) failed; escalating failed",
      );
      await escalateAndComment(outcome, "failed", "resubmit_origin_fetch_failed", null);
      return;
    }

    // 2. Push the resolved commit from the resolver clone to a stable branch.
    const gitOps = makeGitOps(outcome.worktreePath);
    const branch = resolutionBranch(outcome.resolutionId);
    const pushed = await gitOps.push(cfg.gitRemote, branch);
    if (!pushed.ok) {
      logger.warn(
        {
          resolutionId: outcome.resolutionId,
          branch,
          reason: pushed.reason,
        },
        "resolved: push failed; escalating failed (resubmit_push_failed)",
      );
      await escalateAndComment(outcome, "failed", "resubmit_push_failed", origin);
      return;
    }

    // 3. Resubmit as a NEW request linked to the origin. MUST copy
    //    origin.verifyCmd (the train verifies with request.verifyCmd ?? default
    //    — omitting it gates with the WRONG command). resolvedFrom = originId is
    //    the no-recursion marker (§5.4).
    let newReq;
    try {
      newReq = await pmClient.submitMergeRequest({
        projectId: cfg.projectId,
        resource: outcome.job.resource,
        taskId: origin.taskId,
        branch,
        verifyCmd: origin.verifyCmd,
        resolvedFrom: outcome.job.originRequestId,
      });
    } catch (err) {
      logger.warn(
        { resolutionId: outcome.resolutionId, err: errMessage(err) },
        "resolved: submitMergeRequest failed; escalating failed (resubmit_submit_failed)",
      );
      await escalateAndComment(outcome, "failed", "resubmit_submit_failed", origin);
      return;
    }

    // 4. Record the resolution `resolved`, cross-linking the new request.
    //
    //    PARTIAL-FAILURE NUANCE (KNOWN LIMITATION): the submit at step 3 has
    //    ALREADY succeeded — the resubmitted request is on the train. If THIS
    //    call throws we must NOT escalate (that would be a lie: the resolution
    //    DID produce a landable resubmission). The resolution row is stranded in
    //    `resolving`; we log loudly and return. The periodic resolving-reclaim
    //    sweep (reclaim-resolutions.ts, run in batch.ts/runBatchLoop) reconciles
    //    such stranded rows — it finds the resubmission with resolved_from =
    //    origin and marks the resolution `resolved`, else escalates. We do NOT
    //    re-submit here (no double-submit).
    try {
      await pmClient.resolvedResolution(outcome.resolutionId, {
        resolvedRequestId: newReq.id,
        detail: outcome.detail,
      });
    } catch (err) {
      logger.error(
        {
          resolutionId: outcome.resolutionId,
          resolvedRequestId: newReq.id,
          err: errMessage(err),
        },
        "resolved: resolvedResolution failed AFTER successful resubmit; " +
          "resolution row may be stranded in resolving; resubmitted request " +
          `${newReq.id} still rides the train ` +
          "(recovered by the periodic resolving-reclaim sweep — reclaim-resolutions.ts)",
      );
      return;
    }

    logger.info(
      {
        resolutionId: outcome.resolutionId,
        resolvedRequestId: newReq.id,
        branch,
      },
      "resolution resolved: pushed + resubmitted + recorded",
    );
  }

  async function handleEscalate(outcome: ResolutionOutcome): Promise<void> {
    if (outcome.kind !== "escalate") return;
    // Transition the resolution FIRST (escalated | failed).
    await pmClient.escalateResolution(outcome.resolutionId, {
      state: outcome.state,
      target: "author",
      reason: outcome.reason,
      detail: outcome.detail,
    });
    // Then fetch the origin for its taskId and post the merge_rejection comment.
    // A fetch failure here is non-fatal — the resolution is already escalated;
    // we just can't surface the comment. Guard null taskId (mirror reject()).
    let origin: MergeRequestDetailView | null = null;
    try {
      origin = await pmClient.getMergeRequest(outcome.job.originRequestId);
    } catch (err) {
      logger.warn(
        { resolutionId: outcome.resolutionId, err: errMessage(err) },
        "escalate: getMergeRequest(origin) failed; resolution escalated, comment skipped",
      );
      return;
    }
    await escalateAndComment(outcome, outcome.state, outcome.reason, origin, {
      alreadyEscalated: true,
    });
  }

  return async function onOutcome(outcome: ResolutionOutcome): Promise<void> {
    // Defense-in-depth: NO throw escapes onOutcome (the pool also catches, but
    // a throw here would still be logged-and-swallowed there; we keep our own
    // catch so a partial-failure log isn't masked by the pool's generic one).
    try {
      if (outcome.kind === "resolved") {
        await handleResolved(outcome);
      } else {
        await handleEscalate(outcome);
      }
    } catch (err) {
      logger.error(
        { resolutionId: outcome.resolutionId, err: errMessage(err) },
        "resolution onOutcome handler threw (swallowed; non-fatal)",
      );
    }
  };
}
