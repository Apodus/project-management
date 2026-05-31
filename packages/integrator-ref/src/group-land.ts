/**
 * Phase 7.3 Step 11 — atomic land + orphan detection (the HEART of the phase).
 *
 * Lands an assembled, verify-passed cross-repo group inner-first, then outer,
 * under the lane lock the scheduler already holds. The three failure points of
 * design §6 are pinned here:
 *
 *   §6.1 drift guard      — re-fetch + re-resolve BOTH live mains; any drift →
 *                           reject the group cleanly (no push, no incident).
 *   §6.2 PUSH 1 (inner)   — fast-forward inner main Mi → Ri.
 *   §6.3 failure (a)      — inner push failed → reject group, OUTER NEVER TOUCHED.
 *   §6.2 PUSH 2 (outer)   — fast-forward outer main Mo → Ro (gitlink → Ri).
 *   §6.7 clean land       — both pushed → completeAttempts(passed) BEFORE
 *                           landGroup (landGroup does NOT touch attempts).
 *   §6.5 failure (b)      — outer push failed AFTER inner landed → THE ORPHAN:
 *                           outer main UNCHANGED (no half-landed gitlink); mark
 *                           inner orphaned, open the durable incident, reject the
 *                           outer member, mark the group partially_landed.
 *
 * R1 (§7.1): outer main is advanced ONLY by a verify-gated fast-forward push of
 * the assembled tree. The single pre-PUSH-1 drift check + the FF HEAD:branch
 * push (which REJECTS a non-fast-forward → orphan, safe) are together the R1
 * backstop — there is deliberately NO second outer-drift recheck between the two
 * pushes (CONSTRAINT A): the lane lock holds both pushes and the FF push gates
 * outer drift.
 *
 * CONSTRAINT D: the ENTIRE land body is wrapped in
 *   try { ... } finally { args.ready.assembled.release() }
 * so the correlated worktrees are released EXACTLY ONCE on every path (drift,
 * push-1-fail, clean-land, orphan, throw). The scheduler (batch.ts) no longer
 * releases them — that would double-release.
 */
import type { Logger } from "./logger.js";
import type { PmClient, RejectCategory } from "./pm-client.js";
import type { GroupIntegrationOutcome } from "./group-integration.js";
import { chaosCrashPoint } from "./chaos.js";

// ─── ready_to_land outcome (narrowed) ─────────────────────────────────

type ReadyToLand = Extract<GroupIntegrationOutcome, { kind: "ready_to_land" }>;

// ─── Args + deps ──────────────────────────────────────────────────────

export interface LandAssembledGroupArgs {
  groupId: string;
  projectId: string;
  /** The ready_to_land outcome from runGroupIntegration (worktrees still held). */
  ready: ReadyToLand;
  /** linkedRepos[].name for the inner repo (recorded on the incident). */
  innerRepoName: string;
  /** linkedRepos[].name for the outer repo (recorded on the incident). */
  outerRepoName: string;
}

export interface LandAssembledGroupDeps {
  pmClient: PmClient;
  logger: Logger;
  gitRemote: string;
  gitMainBranch: string;
}

// ─── Result union ─────────────────────────────────────────────────────

export type GroupLandResult =
  | { kind: "landed"; innerLandedSha: string; outerLandedSha: string }
  | { kind: "rejected"; reason: string }
  | {
      kind: "orphaned";
      incidentId: string;
      orphanedSha: string;
      reason: string;
    };

// ─── Push-reason → reject category ────────────────────────────────────

/**
 * Map a git push failure reason to a merge reject category. A push failure is
 * not a verify failure, so `categorize` (which parses verify output) does not
 * apply; this is the structural mapping for the §6.3/§6.5 attempt-complete
 * payloads.
 */
function categorizePushReason(
  reason: "non_fast_forward" | "auth" | "network" | "other",
): RejectCategory {
  switch (reason) {
    case "non_fast_forward":
      return "conflict";
    case "auth":
      return "policy";
    case "network":
      return "other";
    default:
      return "other";
  }
}

// ─── landAssembledGroup ───────────────────────────────────────────────

/**
 * Land one assembled, verify-passed group (§6). The lane lock is held by the
 * scheduler; this function never touches it. Returns the durable outcome:
 * `landed` (both remotes advanced), `rejected` (nothing landed — drift or
 * inner-push-fail), or `orphaned` (inner landed, outer push failed — incident
 * open). CONSTRAINT D: the worktrees are released exactly once in the finally.
 */
export async function landAssembledGroup(
  args: LandAssembledGroupArgs,
  deps: LandAssembledGroupDeps,
): Promise<GroupLandResult> {
  const { pmClient, logger, gitRemote, gitMainBranch } = deps;
  const { groupId, projectId, ready, innerRepoName, outerRepoName } = args;
  const asm = ready.assembled;
  const {
    innerMember,
    outerMember,
    innerAttemptId,
    outerAttemptId,
    innerSteps,
    outerSteps,
  } = ready;
  const Mi = asm.baseInnerSha;
  const Mo = asm.baseOuterSha;

  try {
    // ── §6.1 drift guard: re-fetch + re-resolve BOTH live mains. ──
    await asm.innerGitOps.fetch(gitRemote);
    await asm.outerGitOps.fetch(gitRemote);
    const liveInner = await asm.innerGitOps.resolveRef(
      `${gitRemote}/${gitMainBranch}`,
    );
    const liveOuter = await asm.outerGitOps.resolveRef(
      `${gitRemote}/${gitMainBranch}`,
    );

    if (liveInner !== Mi || liveOuter !== Mo) {
      const reason = "live main drifted before land; re-verify next pass";
      logger.info(
        { groupId, liveInner, Mi, liveOuter, Mo },
        "group land drift detected; rejecting cleanly (no push, no incident)",
      );
      // Cancel BOTH attempts; reject the whole group. Nothing landed.
      await pmClient.completeAttempt(innerAttemptId, { status: "cancelled" });
      await pmClient.completeAttempt(outerAttemptId, { status: "cancelled" });
      await pmClient.rejectGroup(groupId, { reason, category: "other" });
      return { kind: "rejected", reason };
    }

    // NOTE — no-op / already-landed groups: a re-submitted group whose content
    // is already on both remotes is handled by the fast-forward pushes below
    // (PUSH 1 / PUSH 2 are `HEAD:main` — an up-to-date push is a safe no-op that
    // returns ok and lands at the current mains, no double-apply, no regression).
    // The explicit single-repo no-op guard (batch.ts landMember) is NOT mirrored
    // here on purpose: the assembled-worktree HEAD state makes a pre-push tree
    // comparison ambiguous, and the FF push already gives the correct outcome.

    // ── §6.2 PUSH 1: inner (fast-forwards inner main Mi → Ri). ──
    const push1 = await asm.innerGitOps.push(gitRemote, gitMainBranch);
    if (!push1.ok) {
      // §6.3 failure point (a): inner push failed. NOTHING landed. Outer NEVER
      // touched. Reject the whole group cleanly. No incident.
      const cat = categorizePushReason(push1.reason);
      const failureReason = `inner push failed (${push1.reason})`;
      logger.warn(
        { groupId, reason: push1.reason },
        "inner push failed; rejecting group (outer never touched)",
      );
      await pmClient.completeAttempt(innerAttemptId, {
        status: "failed",
        failureCategory: cat,
        failureReason,
      });
      await pmClient.completeAttempt(outerAttemptId, { status: "cancelled" });
      const reason = "inner push failed; nothing landed";
      await pmClient.rejectGroup(groupId, { reason, category: "other" });
      return { kind: "rejected", reason };
    }
    const innerLandedSha = push1.pushedSha; // = Ri

    // ── CHAOS (test-only, §6.4): crash AFTER inner push, BEFORE completeAttempt /
    //    landGroup / openIncident. No finally runs (process.exit) → worktrees not
    //    released, no incident, group still integrating = the §6.4 window. The
    //    inner DID land on its remote; PM has not yet recorded anything. Recovery
    //    is stranded-group reset (reclaimStrandedGroups) → re-integration. ──
    chaosCrashPoint("after_inner_push");

    // ── §6.2 PUSH 2: outer (fast-forwards outer main Mo → Ro, gitlink → Ri). ──
    const push2 = await asm.outerGitOps.push(gitRemote, gitMainBranch);

    if (push2.ok) {
      // ── §6.7 CLEAN LAND (R1 satisfied — both trees passed §5.3 verify). ──
      const outerLandedSha = push2.pushedSha; // = Ro
      // CONSTRAINT C: complete BOTH attempts as passed BEFORE landGroup
      // (landGroup does NOT complete attempts).
      await pmClient.completeAttempt(innerAttemptId, {
        status: "passed",
        treeSha: innerLandedSha,
        // PHASE 7.5 FOLDED-FIX M1: the inner repo's pipeline steps from the
        // assembled verify (threaded via ready_to_land — out of scope here).
        steps: innerSteps ?? undefined,
      });
      await pmClient.completeAttempt(outerAttemptId, {
        status: "passed",
        treeSha: outerLandedSha,
        steps: outerSteps ?? undefined,
      });
      await pmClient.landGroup(groupId, {
        members: [
          { requestId: innerMember.id, landedSha: innerLandedSha, role: "inner" },
          { requestId: outerMember.id, landedSha: outerLandedSha, role: "outer" },
        ],
      });
      logger.info(
        { groupId, innerLandedSha, outerLandedSha },
        "group landed atomically (inner + outer pushed)",
      );
      return { kind: "landed", innerLandedSha, outerLandedSha };
    }

    // ── §6.5 ORPHAN: outer push failed AFTER inner landed (the heart case). ──
    // Outer main is UNCHANGED (the push rejected → no half-landed gitlink).
    // EXACT order (CONSTRAINT B: the outer reject is the PLAIN per-request
    // rejectMergeRequest — the G1 guard is on the LAND route, not reject):
    logger.warn(
      { groupId, reason: push2.reason, orphanedSha: innerLandedSha },
      "outer push failed after inner landed; orphaning inner + opening incident",
    );
    // a. inner attempt passed (the inner really landed @Ri).
    await pmClient.completeAttempt(innerAttemptId, {
      status: "passed",
      treeSha: innerLandedSha,
      // PHASE 7.5 FOLDED-FIX M1: the inner repo's pipeline steps (it passed verify).
      steps: innerSteps ?? undefined,
    });
    // b. inner member → orphaned (group-land-family op).
    await pmClient.markInnerOrphaned(innerMember.id, innerLandedSha);
    // c. THE durable orphan record — capture incident.id.
    const incident = await pmClient.openIncident({
      projectId,
      type: "orphaned_inner",
      innerRepo: innerRepoName,
      orphanedSha: innerLandedSha,
      outerRepo: outerRepoName,
      groupId,
      innerRequestId: innerMember.id,
      taskId: innerMember.taskId,
    });
    // d. outer attempt failed.
    await pmClient.completeAttempt(outerAttemptId, {
      status: "failed",
      failureCategory: categorizePushReason(push2.reason),
      failureReason: "outer push failed after inner landed",
    });
    // e. outer member → rejected (PLAIN per-request reject, not 409 for grouped).
    const reason = `outer push failed after inner landed @${innerLandedSha}`;
    await pmClient.rejectMergeRequest(outerMember.id, {
      category: "other",
      reason,
    });
    // f. group → partially_landed (cross-links the incident).
    await pmClient.markPartiallyLanded(groupId, {
      reason: `outer push failed after inner landed; orphaned inner @${innerLandedSha}; incident ${incident.id}`,
      incidentId: incident.id,
    });
    return {
      kind: "orphaned",
      incidentId: incident.id,
      orphanedSha: innerLandedSha,
      reason,
    };
  } finally {
    // CONSTRAINT D: release the correlated worktrees EXACTLY ONCE on every path.
    asm.release();
  }
}
