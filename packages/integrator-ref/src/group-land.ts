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
 *                           A SYNTHETIC outer member (inner-only group) flows
 *                           through this identical body keyed by requestId: its
 *                           landedSha is Ro (the synthesized gitlink-bump
 *                           commit, or the unchanged outer main on a no-op
 *                           land) — no branch in landGroup's payload or logic.
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
import { NOOP_PHASE_SPANS, type PhaseSpans } from "./phase-recorder.js";

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
  /**
   * Campaign 2026-08-03 §P2: phase-timing spans (already scoped to the group).
   * OPTIONAL and coalesced ONCE at function entry — the 15 inline-literal call
   * sites in the group tests therefore need no edit, and the non-nullable local
   * makes `phases?.time(spec, fn)` — which would short-circuit the whole call
   * and SKIP the push it was measuring — impossible to write.
   */
  phases?: PhaseSpans;
}

// ─── Result union ─────────────────────────────────────────────────────

export type GroupLandResult =
  | { kind: "landed"; innerLandedSha: string; outerLandedSha: string }
  | { kind: "rejected"; reason: string }
  /**
   * Campaign 2026-08-15 §R1: nothing is wrong with the change — main simply
   * moved, or we lost a push race — so the group went back to `forming` and
   * re-integrates against the new main on a later pass. NOT a rejection: no
   * author is told anything, because there is nothing for an author to do.
   *
   * A distinct kind rather than a flag on `rejected` so the compiler finds
   * every consumer that has to tell "this group is finished" from "this group
   * is going around again".
   */
  | { kind: "requeued"; reason: string }
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

// ─── Re-queue bound (campaign 2026-08-15 §R1) ─────────────────────────

/**
 * How many integration passes a group gets before a "nothing is wrong with the
 * change" failure stops being retried and becomes a rejection.
 *
 * The bound is the whole reason a re-queue is safe: without it, a group that
 * can NEVER land (because the lane is busier than it can assemble) would cycle
 * forever, burning the lane and telling nobody — strictly worse than the bounce
 * it replaced. With it, the author eventually hears the truth, and the truth is
 * about lane contention rather than about their code.
 */
const MAX_GROUP_INTEGRATION_ATTEMPTS = 4;

/**
 * How many integration passes this group has already had, derived from a real
 * member's attempt rows (`startAttempt` runs once per member per pass), so no
 * migration and no counter to keep in sync.
 *
 * Counts a REAL member: a lone-outer group's inner is synthetic, and while it
 * does get attempts, deriving from the member an author actually submitted
 * keeps the number meaning what its name says.
 *
 * Returns `null` when the count cannot be read. The caller treats that as
 * "unknown, proceed with the re-queue": a PM read failure is transient and the
 * drift that triggered it is a race, whereas rejecting on a failed read would
 * reintroduce exactly the bounce this campaign removes. A group that is
 * persistently unlandable will get a successful read on some later pass and be
 * stopped then.
 */
async function priorIntegrationAttempts(
  pmClient: PmClient,
  logger: Logger,
  members: { id: string; synthetic?: boolean }[],
): Promise<number | null> {
  const real = members.find((m) => m.synthetic !== true) ?? members[0];
  if (!real) return null;
  try {
    const view = await pmClient.getMergeRequest(real.id);
    return view.attempts?.length ?? null;
  } catch (err) {
    logger.warn(
      { requestId: real.id, err: err instanceof Error ? err.message : String(err) },
      "could not read attempt count for the re-queue bound; proceeding with the re-queue",
    );
    return null;
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
  const { innerMember, outerMember, innerAttemptId, outerAttemptId, innerSteps, outerSteps } =
    ready;
  const Mi = asm.baseInnerSha;
  const Mo = asm.baseOuterSha;
  // Campaign 2026-08-03 §P2. Per-role scopes so each land row names the member
  // and attempt it belongs to — which is what makes an ORPHAN legible after the
  // fact: `inner:push {ok:true}` next to `outer:push {ok:false, reason}` is the
  // whole incident in two rows.
  const phases = deps.phases ?? NOOP_PHASE_SPANS;
  const innerPhases = phases.scope({ requestId: innerMember.id, attemptId: innerAttemptId });
  const outerPhases = phases.scope({ requestId: outerMember.id, attemptId: outerAttemptId });

  try {
    // ── §6.1 drift guard: re-fetch + re-resolve BOTH live mains. ──
    // One span per repo, each covering its fetch AND its re-resolve: the fetch is
    // the network cost and the resolve is how we read its result, so splitting
    // them would name a sub-step nobody can act on. The two are measured
    // separately because a slow remote is usually slow for ONE of the repos.
    const liveInner = await innerPhases.time({ phase: "land", label: "inner:fetch" }, async () => {
      await asm.innerGitOps.fetch(gitRemote);
      return asm.innerGitOps.resolveRef(`${gitRemote}/${gitMainBranch}`);
    });
    const liveOuter = await outerPhases.time({ phase: "land", label: "outer:fetch" }, async () => {
      await asm.outerGitOps.fetch(gitRemote);
      return asm.outerGitOps.resolveRef(`${gitRemote}/${gitMainBranch}`);
    });

    if (liveInner !== Mi || liveOuter !== Mo) {
      // ── Campaign 2026-08-15 §R1. This used to REJECT, while writing the
      //    reason "re-verify next pass" — the intent was always a retry. Main
      //    moving under an assembled group says nothing about the change, and
      //    the single-repo lane has always handled the identical event by
      //    re-queueing (onMemberFailed kind "drift" → resetToQueued), silently
      //    and with nobody notified. This makes the two lanes agree. ──
      // Cancel BOTH attempts either way: neither produced a verdict.
      await pmClient.completeAttempt(innerAttemptId, { status: "cancelled" });
      await pmClient.completeAttempt(outerAttemptId, { status: "cancelled" });

      const attempts = await priorIntegrationAttempts(pmClient, logger, [innerMember, outerMember]);
      if (attempts !== null && attempts >= MAX_GROUP_INTEGRATION_ATTEMPTS) {
        // The bound. Losing the race repeatedly is a real finding — about the
        // LANE, not the change — and saying so is the point of stopping here
        // rather than cycling forever.
        const reason =
          `live main drifted before land on ${attempts} consecutive integration attempts; ` +
          `the lane is landing changes faster than this group can assemble and verify. ` +
          `Re-submit when the lane is quieter, or split the change so it assembles faster.`;
        logger.warn({ groupId, attempts }, "group re-queue bound reached; rejecting");
        await pmClient.rejectGroup(groupId, { reason, category: "other" });
        return { kind: "rejected", reason };
      }

      const reason = "live main drifted before land; re-integrating against the new main";
      logger.info(
        { groupId, liveInner, Mi, liveOuter, Mo, attempts },
        "group land drift detected; re-queueing (no push, no incident, no author notified)",
      );
      // `resetGroup` puts the group back to `forming` and its members back to
      // `queued`, atomically. Its own corruption fence refuses to reset a group
      // carrying an OPEN orphan incident — that case is the §7 rollforward's,
      // and this must not fight it.
      await pmClient.resetGroup(groupId, { reason });
      return { kind: "requeued", reason };
    }

    // NOTE — no-op / already-landed groups: a re-submitted group whose content
    // is already on both remotes is handled by the fast-forward pushes below
    // (PUSH 1 / PUSH 2 are `HEAD:main` — an up-to-date push is a safe no-op that
    // returns ok and lands at the current mains, no double-apply, no regression).
    // The explicit single-repo no-op guard (batch.ts landMember) is NOT mirrored
    // here on purpose: the assembled-worktree HEAD state makes a pre-push tree
    // comparison ambiguous, and the FF push already gives the correct outcome.

    // ── §6.2 PUSH 1: inner (fast-forwards inner main Mi → Ri). ──
    const push1 = await innerPhases.time(
      {
        phase: "land",
        label: "inner:push",
        detail: (p) => ({ ok: p?.ok ?? false, reason: p && !p.ok ? p.reason : null }),
      },
      () => asm.innerGitOps.push(gitRemote, gitMainBranch),
    );
    if (!push1.ok) {
      // §6.3 failure point (a): inner push failed. NOTHING landed. Outer NEVER
      // touched. No incident.
      const cat = categorizePushReason(push1.reason);
      const failureReason = `inner push failed (${push1.reason})`;

      // ── Campaign 2026-08-15 §R1: a `non_fast_forward` push IS a lost race —
      //    someone landed between our drift check and our push — and is the
      //    same non-verdict as the drift above. Every OTHER reason is retried
      //    into a wall: `auth` will not fix itself, `network` and `other` are
      //    unknown, and silently cycling a lane against a broken remote is the
      //    failure mode a bounded retry exists to avoid. So only this one arm
      //    re-queues. ──
      const isRace = push1.reason === "non_fast_forward";
      // Two calls rather than one conditional body: `completeAttempt`'s payload
      // is a discriminated union, and a spread that makes `status` a union
      // defeats the narrowing that keeps `failureCategory`/`failureReason`
      // required exactly where they belong.
      if (isRace) {
        // A lost race produced no verdict, so the attempt is cancelled — not
        // failed. Recording it as failed would put a `conflict` on the author's
        // attempt history for something they did not do.
        await pmClient.completeAttempt(innerAttemptId, { status: "cancelled" });
      } else {
        await pmClient.completeAttempt(innerAttemptId, {
          status: "failed",
          failureCategory: cat,
          failureReason,
        });
      }
      await pmClient.completeAttempt(outerAttemptId, { status: "cancelled" });

      if (isRace) {
        const attempts = await priorIntegrationAttempts(pmClient, logger, [
          innerMember,
          outerMember,
        ]);
        if (attempts === null || attempts < MAX_GROUP_INTEGRATION_ATTEMPTS) {
          const reason =
            "inner push lost a race (non-fast-forward); re-integrating against the new main";
          logger.info(
            { groupId, attempts },
            "inner push non-fast-forward; re-queueing (nothing landed, no author notified)",
          );
          await pmClient.resetGroup(groupId, { reason });
          return { kind: "requeued", reason };
        }
        const reason =
          `inner push lost a race on ${attempts} consecutive integration attempts; ` +
          `the lane is landing changes faster than this group can assemble and verify. ` +
          `Re-submit when the lane is quieter, or split the change so it assembles faster.`;
        logger.warn({ groupId, attempts }, "group re-queue bound reached on push race; rejecting");
        await pmClient.rejectGroup(groupId, { reason, category: "other" });
        return { kind: "rejected", reason };
      }

      logger.warn(
        { groupId, reason: push1.reason },
        "inner push failed; rejecting group (outer never touched)",
      );
      const reason = `inner push failed (${push1.reason}); nothing landed`;
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
    const push2 = await outerPhases.time(
      {
        phase: "land",
        label: "outer:push",
        detail: (p) => ({ ok: p?.ok ?? false, reason: p && !p.ok ? p.reason : null }),
      },
      () => asm.outerGitOps.push(gitRemote, gitMainBranch),
    );

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
    const { incident } = await pmClient.openIncident({
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
