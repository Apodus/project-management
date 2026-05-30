/**
 * Deterministic, test-only chaos fault hook (Phase 7.3 Step 13).
 *
 * Read ONCE from `process.env.PM_CHAOS_CRASH_AT`. A no-op unless the env var is
 * set, so production behavior is byte-identical (the only cost is one env read
 * at module load + a string compare at each honored transition). Honored ONLY at
 * the §6 group-land transitions that prove the §6.4 / mid-assembly crash-recovery
 * windows. Never enable in production.
 *
 * Crash points:
 *   - "after_inner_push": exit(137) IMMEDIATELY after PUSH 1 (inner) succeeds,
 *     BEFORE completeAttempt / landGroup / openIncident. No finally runs →
 *     worktrees not released, no incident, group still integrating (the §6.4
 *     window).
 *   - "mid_assembly": exit(137) after assembleGroup succeeds, BEFORE
 *     markGroupIntegrating. Group still forming, nothing pushed.
 *
 * Separately, `PM_CHAOS_FAIL_OUTER_PUSH=once` makes the OUTER lane's push return
 * a PushFailure exactly once (the deterministic orphan trigger for flow c). It
 * is honored in index.ts's outer-lane gitOps factory (a one-shot wrapper).
 */

/** The crash point read once at module load. Undefined unless set (= production). */
const CRASH_AT = process.env.PM_CHAOS_CRASH_AT;

export type ChaosCrashPoint = "after_inner_push" | "mid_assembly";

/**
 * Crash the process with exit code 137 (SIGKILL-equivalent) if the configured
 * crash point matches `point`. No-op otherwise (including when CRASH_AT is
 * unset). Used at the §6 transitions in group-land.ts / group-integration.ts.
 */
export function chaosCrashPoint(point: ChaosCrashPoint): void {
  if (CRASH_AT === point) {
    // Hard exit: no finally blocks run, no worktree release, no incident write —
    // exactly the crash window the test recovers from.
    process.exit(137);
  }
}

/** True when PM_CHAOS_FAIL_OUTER_PUSH is set to "once" (the one-shot orphan trigger). */
export function chaosFailOuterPushOnce(): boolean {
  return process.env.PM_CHAOS_FAIL_OUTER_PUSH === "once";
}
