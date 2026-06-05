/**
 * Phase 7.3 Step 12 — orphaned-inner recovery (the §7 auto-rollforward +
 * human-fallback state machine, the proof-level-care part of the phase).
 *
 * An open `orphaned_inner` incident means: inner main is at `orphanedSha` (call
 * it `O`), and outer main's gitlink references some earlier inner SHA. Recovery
 * makes outer's gitlink absorb `O` — WITHOUT ever advancing outer main past an
 * unverified assembled tree (INVARIANT R1, §7.1).
 *
 * Design references:
 *   §7.1 R1               — outer main advances ONLY by a verify-gated FF push of
 *                           an assembled tree. Holds in recovery exactly as land.
 *   §7.2 detection        — PM-KEYED: open incidents are queried from PM
 *                           (`listMergeIncidents`), NEVER reconstructed from git
 *                           SHA comparison. No open incident → recovery does
 *                           NOTHING (the list gates it).
 *   §7.3 auto-rollforward — the 6-step algorithm (lease → reconcile → assemble →
 *                           VERIFY (the R1 gate) → verify-gated FF push → resolve).
 *   §7.4 RECONCILABLE      — `isAncestor(currentGitlink, O)` in the INNER repo;
 *                           direction: currentGitlink is the ANCESTOR arg, O the
 *                           DESCENDANT. False → divergent intervening outer
 *                           history → ESCALATE. THROW (bad object / 128) →
 *                           ESCALATE.
 *   §7.5 escalate          — NEVER mutate the incident: it stays `open`, surfaced
 *                           louder via `logger.warn({escalation:true})`. Deferred
 *                           (transient: pool exhaustion / drift / push-race) →
 *                           `logger.debug`, no escalation, retried next pass.
 *   §7.7 R1 proof          — every outer-main advance is step-5's push, reached
 *                           ONLY after step-4 verify passed; every failure branch
 *                           leaves outer main untouched.
 *
 * CONSTRAINT (worktree discipline): the WHOLE rollforwardOne body is wrapped in
 * try/finally releasing BOTH leased worktrees EXACTLY ONCE on every path
 * (escalate / defer / auto-resolve / throw). The detection loop never leaks a
 * lease.
 */
import type { Logger } from "./logger.js";
import type { PmClient } from "./pm-client.js";
import type { RepoLane } from "./group-integration.js";
import type { MergeIncidentView, VerifyStep } from "@pm/shared";
import { runPipeline } from "./verify-pipeline.js";

// ─── Args + deps ──────────────────────────────────────────────────────

export interface RecoverOrphanedInnerArgs {
  projectId: string;
  resource: string;
  /** The forming group being integrated this pass (if any) — recorded as
   *  `resolvedByGroupId` on an auto-resolution. Undefined for a recovery-only
   *  pass (no forming group). */
  currentGroupId?: string;
}

export interface RecoverOrphanedInnerDeps {
  pmClient: PmClient;
  logger: Logger;
  /** The inner repo's lane (gitlinkPath lives here; used for the ancestry check
   *  against a fresh-fetched inner main). */
  innerLane: RepoLane;
  /** The outer repo's lane (where the gitlink rolls forward + the verify runs). */
  outerLane: RepoLane;
  gitRemote: string;
  gitMainBranch: string;
  /** Fallback verify when the incident-linked outer member's verifyCmd is not
   *  available (the orphan recovery may not have the member handy — by §7.3 step
   *  4 we use defaultVerifyCommand). */
  defaultVerifyCommand: string;
  verifyTimeoutSec: number;
  /** Path to the local inner clone/remote `O` is fetched FROM (§7.3 step 3). `O`
   *  is on inner main, so a fetch of the remote also suffices; we fetch from
   *  this path for parity with the inner clone the lane resolves against. When
   *  absent, recovery fetches `O` from `gitRemote` (it is published on inner
   *  main). */
  innerRemotePath?: string;
  innerLogsDir?: string;
  outerLogsDir?: string;
}

// ─── Result types ─────────────────────────────────────────────────────

export type IncidentRecoveryOutcome =
  | { kind: "auto_resolved"; incidentId: string; outerLandedSha: string }
  | { kind: "escalated"; incidentId: string; reason: string }
  | { kind: "deferred"; incidentId: string; reason: string };

export interface RecoverResult {
  outcomes: IncidentRecoveryOutcome[];
}


// ─── recoverOrphanedInner ─────────────────────────────────────────────

/**
 * §7.2 detection (PM-KEYED): list open `orphaned_inner` incidents (oldest-first,
 * server-ordered) and attempt auto-rollforward for each. A git history that
 * LOOKS like an orphan but has NO open incident row produces ZERO outcomes and
 * does nothing — recovery keys SOLELY off the PM incident list.
 */
export async function recoverOrphanedInner(
  args: RecoverOrphanedInnerArgs,
  deps: RecoverOrphanedInnerDeps,
): Promise<RecoverResult> {
  const { pmClient, logger } = deps;
  const outcomes: IncidentRecoveryOutcome[] = [];

  let open: MergeIncidentView[];
  try {
    open = await pmClient.listMergeIncidents(args.projectId, {
      state: "open",
      type: "orphaned_inner",
    });
  } catch (err) {
    // A failed list is transient — surface and bail this pass (nothing leased).
    logger.debug(
      { err: errText(err) },
      "listMergeIncidents failed during recovery; retry next pass",
    );
    return { outcomes };
  }

  for (const incident of open) {
    outcomes.push(await rollforwardOne(incident, args, deps));
  }

  return { outcomes };
}

// ─── rollforwardOne (§7.3) ────────────────────────────────────────────

/**
 * Attempt the §7.3 auto-rollforward for ONE open incident. The WHOLE body is
 * wrapped in try/finally releasing BOTH leased worktrees exactly once on every
 * path. Returns the durable per-incident outcome.
 */
async function rollforwardOne(
  incident: MergeIncidentView,
  args: RecoverOrphanedInnerArgs,
  deps: RecoverOrphanedInnerDeps,
): Promise<IncidentRecoveryOutcome> {
  const { pmClient, logger, innerLane, outerLane, gitRemote, gitMainBranch } =
    deps;
  const O = incident.orphanedSha;
  const gitlinkPath = innerLane.gitlinkPath;

  // The inner lane MUST carry a gitlinkPath (it is the role:"inner" lane). A
  // missing path is a config defect — escalate (never silently mutate).
  if (!gitlinkPath) {
    logger.warn(
      { incidentId: incident.id, reason: "inner lane has no gitlinkPath", escalation: true },
      "orphaned-inner recovery escalated to human",
    );
    return {
      kind: "escalated",
      incidentId: incident.id,
      reason: "inner lane has no gitlinkPath",
    };
  }

  // ── Lease BOTH worktrees (§7.3). Inner first (fixed order, mirrors assembly's
  //    correlated acquire); on partial failure release what was taken. ──
  const outerWt = outerLane.acquire();
  if (!outerWt) {
    logger.debug(
      { incidentId: incident.id },
      "recovery deferred: outer pool exhausted; retry next pass",
    );
    return { kind: "deferred", incidentId: incident.id, reason: "pool exhaustion" };
  }
  const innerWt = innerLane.acquire();
  if (!innerWt) {
    outerLane.release(outerWt);
    logger.debug(
      { incidentId: incident.id },
      "recovery deferred: inner pool exhausted; retry next pass",
    );
    return { kind: "deferred", incidentId: incident.id, reason: "pool exhaustion" };
  }

  try {
    const innerGit = innerLane.gitOps(innerWt.path);
    const outerGit = outerLane.gitOps(outerWt.path);

    // ── Reachability precondition (§7.4): fresh inner main has both O and the
    //    currentGitlink present for the ancestry check. ──
    await innerWt.resetForAttempt();
    await innerGit.fetch(gitRemote);

    // ── §7.3 step 1: outer at live main Mo'. ──
    await outerWt.resetForAttempt();
    const MoPrime = await outerGit.resolveRef("HEAD");

    // ── §7.4 RECONCILABLE: currentGitlink is ANCESTOR arg, O the DESCENDANT;
    //    the ancestry check runs in the INNER repo. ──
    const currentGitlink = await outerGit.readSubmoduleGitlink(gitlinkPath);
    let reconcilable: boolean;
    try {
      reconcilable = await innerGit.isAncestor(currentGitlink, O);
    } catch (err) {
      // Bad object / 128 / corrupt — the ancestry check FAILED to decide.
      // ESCALATE (never auto-push on an undecided ancestry).
      const reason = `ancestry check failed: ${errText(err)}`;
      return escalate(incident, reason, logger);
    }
    if (!reconcilable) {
      // currentGitlink is NOT an ancestor of O → divergent intervening outer
      // history → rolling the gitlink to O would regress/diverge. ESCALATE.
      return escalate(
        incident,
        "currentGitlink not ancestor of O (divergent intervening outer history)",
        logger,
      );
    }

    // ── §7.3 step 3: assemble the roll-forward outer tree (gitlink → O). ──
    // O is published on inner main, so fetch it from the inner remote (or the
    // configured inner clone path) into the OUTER store so updateSubmoduleGitlink
    // + (the post-assembly read) can resolve it.
    //
    // The whole assemble window is wrapped in try/catch: ANY throw (smudge
    // failure, the P4 fail-loud pointer guard, a bad object) → clean escalate
    // (incident stays OPEN, nothing pushed). The deferred returns above (pool
    // exhaustion) and below (drift, push race) live OUTSIDE this window.
    try {
      // Check O out in the inner worktree so the overlay sources O's
      // correctly-smudged real LFS binaries. resetForAttempt (above) left
      // innerWt at inner MAIN, which can be AHEAD of O in production — the
      // overlay must copy O's versions (`git lfs ls-files` reflects the
      // checked-out HEAD), not inner-main's. O is reachable in innerWt (it is
      // on inner main's history; the ancestry check above already required it).
      // The inner clone's LFS filter smudges (fetching O's objects from origin;
      // a local bare in tests = offline).
      await innerGit.checkout(O);

      await outerGit.fetchFromPath(deps.innerRemotePath ?? gitRemote, O);
      await outerGit.updateSubmoduleGitlink(gitlinkPath, O);
      // Materialize WITH the LFS overlay: pass the inner worktree (checked out
      // at O) as the 3rd arg so the real inner LFS binaries are copied into the
      // outer working tree (as the LAND assemble does). The P4 fail-loud pointer
      // guard refuses to overlay an unsmudged pointer → throws → escalate.
      await outerGit.materializeSubmoduleWorktree(gitlinkPath, O, innerWt.path);

      // Post-assembly assertion (§11): the committed gitlink must reference O.
      const assembledGitlink = await outerGit.readSubmoduleGitlink(gitlinkPath);
      if (assembledGitlink !== O) {
        return escalate(incident, "post-assembly gitlink mismatch", logger);
      }
    } catch (err) {
      // ANY throw in the assemble window (smudge 404, P4 fail-loud pointer
      // guard, bad object) → ESCALATE cleanly: incident stays open, nothing
      // pushed. (A `return` inside this try — e.g. the gitlink-mismatch escalate
      // above — is NOT intercepted; only throws reach this catch.)
      return escalate(incident, `roll-forward assemble failed: ${errText(err)}`, logger);
    }

    // ── §7.3 step 4: VERIFY the assembled roll-forward tree (THE R1 GATE). ──
    // outerVerifyCmd: the orphan recovery may not have the outer member handy,
    // so we use the configured defaultVerifyCommand (§7.3 step 4, documented).
    const outerVerifyCmd = deps.defaultVerifyCommand;
    // PHASE 7.5 Step 5: route the R1 roll-forward verify through runPipeline for
    // consistency. Synthetic single step over the configured default command —
    // byte-identical to today (the synthetic bare logPath uses the per-incident
    // `recovery-<id>` base so the file path matches the old verifyLogPath output).
    const recoverySteps: VerifyStep[] = [
      {
        id: "verify",
        command: outerVerifyCmd,
        depends_on: [],
        cache_key_inputs: [],
      },
    ];
    // PHASE 7.5 Step 6 (CLARIFICATION B): recovery is INTENTIONALLY cache-disabled
    // (no `cache` ctx → runStep takes the off-path, byte-identical to today). The
    // R1 roll-forward has no stable assembled TREE sha in hand (the assembled Ro is
    // dropped), orphan recovery is rare, and gains nothing from caching — so we do
    // NOT contrive a treeSha here. Zero false-pass risk on the R1 gate.
    const recoveryPipe = await runPipeline(recoverySteps, {
      gitOps: outerGit,
      cwd: outerWt.path,
      verifyTimeoutSec: deps.verifyTimeoutSec,
      signal: undefined,
      logsDir: deps.outerLogsDir ?? ".",
      attemptId: `recovery-${incident.id}`,
    });
    if (recoveryPipe.outcome !== "pass") {
      // R1: the assembled tree does NOT pass verify → DO NOT push outer.
      return escalate(incident, "rollforward tree failed verify", logger);
    }

    // ── §7.3 step 5: verify-gated FF push (drift recheck first — mirror land). ──
    await outerGit.fetch(gitRemote);
    const liveOuter = await outerGit.resolveRef(`${gitRemote}/${gitMainBranch}`);
    if (liveOuter !== MoPrime) {
      // Outer drifted between the §7.3-step-1 read and the push → the verified
      // tree's FF target moved. Defer (transient): incident stays open, retry.
      logger.debug(
        { incidentId: incident.id, liveOuter, MoPrime },
        "recovery deferred: outer drifted before recovery push; retry next pass",
      );
      return {
        kind: "deferred",
        incidentId: incident.id,
        reason: "outer drifted before recovery push",
      };
    }
    const push = await outerGit.push(gitRemote, gitMainBranch);
    if (!push.ok) {
      if (push.reason === "non_fast_forward") {
        // A push race — transient. Defer; incident stays open, retry next pass.
        logger.debug(
          { incidentId: incident.id },
          "recovery deferred: push race (non_fast_forward); retry next pass",
        );
        return { kind: "deferred", incidentId: incident.id, reason: "push race" };
      }
      // auth / network / other — ESCALATE (not transiently self-healing).
      return escalate(incident, `push failed: ${push.reason}`, logger);
    }

    // ── §7.3 step 6: resolve the incident as auto_resolved. ──
    await pmClient.resolveIncident(incident.id, {
      mode: "auto_rollforward",
      outerLandedSha: push.pushedSha,
      resolvedByGroupId: args.currentGroupId,
    });
    logger.info(
      { incidentId: incident.id, outerLandedSha: push.pushedSha },
      "orphaned-inner incident auto-resolved by rollforward (R1 held: verify-gated push)",
    );
    return {
      kind: "auto_resolved",
      incidentId: incident.id,
      outerLandedSha: push.pushedSha,
    };
  } finally {
    // Release BOTH leased worktrees EXACTLY ONCE on every path.
    innerLane.release(innerWt);
    outerLane.release(outerWt);
  }
}

// ─── escalate (§7.5) ──────────────────────────────────────────────────

/**
 * ESCALATE: the incident STAYS open (no `resolveIncident`); surface it louder
 * via the escalation log. Returns the `escalated` outcome. NEVER mutates PM
 * state (escalate-never-mutate).
 */
function escalate(
  incident: MergeIncidentView,
  reason: string,
  logger: Logger,
): IncidentRecoveryOutcome {
  logger.warn(
    { incidentId: incident.id, reason, escalation: true },
    "orphaned-inner recovery escalated to human",
  );
  return { kind: "escalated", incidentId: incident.id, reason };
}

// ─── local error stringifier ──────────────────────────────────────────

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
