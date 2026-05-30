/**
 * Phase 7.5 Step 5/6 — the verify-pipeline DAG executor, cache-aware (Step 6).
 *
 * `runPipeline(steps, ctx)` runs a verify DAG of `VerifyStep`s in topological
 * WAVES with fail-fast: every step whose `depends_on` is satisfied runs
 * CONCURRENTLY in a wave; the FIRST step to resolve as a failure aborts the rest
 * of the in-flight pass (a per-pass child `AbortController`) and is reported as
 * the TRUE `failingStep` — the post-abort SIGTERM casualties are discarded.
 *
 * STEP 6 (the cache): each step is run through `runStep`, which — when `ctx.cache`
 * is present and enabled and not `mode:"off"` — probes the PM-owned verify_cache
 * before running (§5.3). The cache is a STRICT no-false-pass gate (design §4):
 *  - `off` / `cache:undefined` / `enabled:false` → BYTE-IDENTICAL Step 5: run,
 *    no lookup, no record (the kill-switch true no-op).
 *  - `on` + HIT → SKIP the run, reuse the cached verdict (synthesized into a
 *    VerifyResult so downstream classify/reject works identically).
 *  - `on` + MISS → run, then record (UNLESS the verdict is transient — §5.6).
 *  - `shadow` → ALWAYS run, compare to the cached row, emit `verify.cache_mismatch`
 *    on disagreement, then record the REAL verdict; the member ALWAYS uses the
 *    real verdict (NEVER the cached one — the verifiable proof, §4.4).
 * All cache I/O is BEST-EFFORT (§11): a lookup throw → MISS; a record/emit throw →
 * warn + continue. The member's verdict is ALWAYS the real run's (or the trusted
 * cached row on a HIT); a cache I/O failure NEVER fails a member or blocks a land.
 *
 * This is a pure function over an injected `GitOps.runVerify` seam plus an
 * injected `cache.pmClient` seam (no git of its own). The CALLER (batch.ts /
 * group-integration.ts / group-recovery.ts) builds the `steps` array — for the
 * legacy single-command case it passes a single synthetic step `{ id: "verify",
 * ... }`, which this executor maps to the EXACT today log path (byte-identical
 * backward compat).
 */
import path from "node:path";
import type { GitOps, VerifyResult } from "./git-ops.js";
import type { CacheMode, VerifyStep, VerifyStepResult } from "@pm/shared";
import type { PmClient } from "./pm-client.js";
import { stepConfigSha } from "./step-config-sha.js";
import { classifyVerifyFailure } from "./categorize.js";

/** The synthetic single-step id the caller uses for the legacy verify_command. */
const SYNTHETIC_STEP_ID = "verify";

export interface PipelineStepResult {
  stepId: string;
  outcome: "pass" | "fail";
  durationMs: number;
  /**
   * STEP 6: true iff a cache HIT served this verdict (the real run was SKIPPED).
   * false on an off-path run, a MISS, or any shadow run (shadow ALWAYS runs).
   */
  cached: boolean;
  /** The tree SHA this step verified (the strict cache key's `tree_sha`, §3.2). */
  treeSha: string;
  /** The step's config fingerprint (the strict cache key's `step_config_sha`). */
  stepConfigSha: string;
  /**
   * STEP 6 sharpens design §5.2's `verify: VerifyResult | null` to NON-NULL: on a
   * HIT a SYNTHESIZED VerifyResult is populated from the cached row (§5.3). This
   * is a §13 deviation — the two downstream `.verify` consumers (batch.ts ~1455,
   * group-integration.ts ~420-421) have NO null-guard, so verify must never be
   * null. The synthetic preserves PASS()/classifyVerifyFailure/categorize parity.
   */
  verify: VerifyResult;
}

export interface PipelineResult {
  outcome: "pass" | "fail";
  steps: PipelineStepResult[];
  /** The TRUE failure trigger (never an abort-casualty); null on a clean pass. */
  failingStep: PipelineStepResult | null;
}

/**
 * FOLDED-FIX C2 (Phase 7.5 Step 7): map the executor's `PipelineStepResult[]` to
 * the wire `VerifyStepResult[]` carried on `completeAttempt` (design §7.3). The
 * `verify` field is internal-only and is DROPPED after extracting its `logPath`
 * into `logUrl` — note `logUrl` is NOT a top-level field on PipelineStepResult;
 * it lives on `step.verify.logPath` (git-ops VerifyResult.logPath, a string that
 * may be ""), mapped to `|| undefined` to satisfy the optional schema field.
 */
export function toVerifyStepResults(
  steps: PipelineStepResult[],
): VerifyStepResult[] {
  return steps.map((step) => ({
    stepId: step.stepId,
    outcome: step.outcome,
    cached: step.cached,
    durationMs: step.durationMs,
    treeSha: step.treeSha,
    stepConfigSha: step.stepConfigSha,
    logUrl: step.verify.logPath || undefined,
  }));
}

/**
 * The executor context. NOTE (FOLDED-FIX-1): `ctx` carries `logsDir` + `attemptId`
 * (NOT a single pre-minted logPath) — the per-step logPath is minted INSIDE
 * `runPipeline` so each concurrent step gets a DISTINCT file and the single
 * synthetic step preserves the exact today path.
 */
/**
 * STEP 6 (design §5.3): the per-step cache sub-context. OPTIONAL on PipelineCtx —
 * when absent OR `enabled:false` OR `mode:"off"`, runStep is the byte-identical
 * Step-5 off-path (no lookup, no record — the kill-switch true no-op).
 *
 * `pmClient` is narrowed to exactly the three cache methods (the lookup/record/
 * mismatch seam, §8.5) so tests can stub a 3-method fake. `treeSha` is the
 * CONTENT-ADDRESSED tree sha (NOT a commit sha — the caller derives it via
 * `resolveRef("<ref>^{tree}")` so the key is timestamp-free / stable across
 * re-assembly, CLARIFICATION A). `requestId`/the ctx.attemptId tag the mismatch.
 */
export interface PipelineCacheCtx {
  enabled: boolean;
  mode: CacheMode;
  pmClient: Pick<
    PmClient,
    "lookupVerifyCache" | "recordVerifyCache" | "emitVerifyCacheMismatch"
  >;
  projectId: string;
  resource: string;
  treeSha: string;
  requestId?: string;
}

export interface PipelineCtx {
  gitOps: GitOps;
  cwd: string;
  verifyTimeoutSec: number;
  signal?: AbortSignal;
  logsDir: string;
  attemptId: string;
  /** STEP 6: the verify-cache seam (§5.3). Absent → off-path (byte-identical 5). */
  cache?: PipelineCacheCtx;
  /** STEP 6: best-effort cache-I/O failure logger (§11). Absent → silent. */
  logger?: { warn?: (msg: string) => void };
}

/** The exact today log path for a single-command verify (matches batch.ts:339). */
function bareLogPath(logsDir: string, attemptId: string): string {
  return path.join(logsDir, `${attemptId}.log`);
}

/**
 * Mint the per-step log path. The SINGLE synthetic step keeps the BARE today
 * path (byte-identical single-command log); every real step gets a `-${stepId}`
 * suffix before the `.log` extension so concurrent steps never share a file.
 */
function logPathForStep(
  logsDir: string,
  attemptId: string,
  stepId: string,
  isSyntheticSingle: boolean,
): string {
  if (isSyntheticSingle) return bareLogPath(logsDir, attemptId);
  return path.join(logsDir, `${attemptId}-${stepId}.log`);
}

const PASS = (v: VerifyResult): boolean => v.exitCode === 0 && !v.timedOut;

/**
 * A SYNTHETIC real-fail step result for a defensive dependency-cycle escape
 * (the config-time 400-gate should have caught it). `timedOut:false` +
 * `exitCode:1` so `classifyVerifyFailure` → "real" (no transient retry on a
 * structural bug). `signal:null` keeps `categorize` off the timeout branch.
 */
function cycleFailStep(): PipelineStepResult {
  const verify: VerifyResult = {
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "verify-pipeline: dependency cycle",
    durationMs: 0,
    timedOut: false,
    logPath: "",
  };
  return {
    stepId: SYNTHETIC_STEP_ID,
    outcome: "fail",
    durationMs: 0,
    cached: false,
    treeSha: "",
    stepConfigSha: "",
    verify,
  };
}

/**
 * STEP 6 (design §5.3): synthesize a VerifyResult-shaped object from a cache HIT
 * row so a HIT feeds the SAME downstream path (PASS / classifyVerifyFailure /
 * categorize / onMemberFailed) as a real run. CRITICAL: `timedOut:false` +
 * `exitCode: hit.result==="fail" ? 1 : 0` → a cached FAIL classifies as "real"
 * (NEVER transient) → it goes STRAIGHT to onMemberFailed, never the transient
 * retry (§5.6); a cached PASS is exitCode:0 + !timedOut → PASS() true. Every
 * field VerifyResult declares is populated (exitCode/signal/stdout/stderr/
 * durationMs/timedOut/logPath), and the categorize reads (exitCode/signal/stdout/
 * stderr/timedOut) all resolve to the cached verdict's shape.
 */
function synthesizeCachedVerify(hit: {
  result: "pass" | "fail";
  durationMs?: number | null;
  logExcerpt?: string | null;
  logUrl?: string | null;
}): VerifyResult {
  const isFail = hit.result === "fail";
  return {
    exitCode: isFail ? 1 : 0,
    signal: null,
    stdout: "",
    stderr: hit.logExcerpt ?? (isFail ? "(cached verify fail)" : ""),
    durationMs: hit.durationMs ?? 0,
    timedOut: false,
    logPath: hit.logUrl ?? "",
  };
}

/** A short stderr tail to persist as the cache row's logExcerpt (§3.1). */
function logExcerptOf(v: VerifyResult): string {
  const tail = (v.stderr || v.stdout || "").slice(-2000);
  return tail;
}

/**
 * Run the verify DAG. Assumes `steps` is NON-EMPTY (the caller always supplies
 * at least the synthetic single step). Returns a `PipelineResult`.
 */
export async function runPipeline(
  steps: VerifyStep[],
  ctx: PipelineCtx,
): Promise<PipelineResult> {
  const isSyntheticSingle =
    steps.length === 1 && steps[0].id === SYNTHETIC_STEP_ID;

  const byId = new Map<string, VerifyStep>();
  for (const s of steps) byId.set(s.id, s);

  // ── Per-pass child AbortController (design §5.5). EVERY step's runVerify
  //    receives `passController.signal`, NEVER `ctx.signal` directly — so the
  //    retry loop's fresh runPipeline call mints a fresh child from the still-
  //    un-fired parent and a transient retry RE-RUNS. ──
  const passController = new AbortController();
  if (ctx.signal) {
    if (ctx.signal.aborted) passController.abort();
    else
      ctx.signal.addEventListener("abort", () => passController.abort(), {
        once: true,
      });
  }

  const passed = new Set<string>();
  const allResults: PipelineStepResult[] = [];
  // The FIRST observed real failure (the abort TRIGGER, NOT an abort-casualty).
  let failing: PipelineStepResult | null = null;

  // ── STEP 6: best-effort cache-I/O wrappers (§11). A lookup throw → MISS (null,
  //    NEVER a false hit). A record/emit throw → warn + continue. The try/catch
  //    scopes ONLY the pmClient call — never the runVerify or the verdict. ──
  const cache = ctx.cache;
  const warn = (msg: string): void => ctx.logger?.warn?.(msg);

  const cacheLookup = async (
    stepId: string,
    scSha: string,
  ): Promise<Awaited<ReturnType<PmClient["lookupVerifyCache"]>>> => {
    if (!cache) return null;
    try {
      return await cache.pmClient.lookupVerifyCache(cache.projectId, {
        resource: cache.resource,
        treeSha: cache.treeSha,
        stepId,
        stepConfigSha: scSha,
      });
    } catch (err) {
      warn(`verify-cache lookup failed (treated as MISS): ${String(err)}`);
      return null;
    }
  };

  const cacheRecord = async (
    stepId: string,
    scSha: string,
    v: VerifyResult,
    result: "pass" | "fail",
  ): Promise<void> => {
    if (!cache) return;
    try {
      await cache.pmClient.recordVerifyCache(cache.projectId, {
        resource: cache.resource,
        treeSha: cache.treeSha,
        stepId,
        stepConfigSha: scSha,
        result,
        durationMs: v.durationMs,
        logExcerpt: logExcerptOf(v),
        ...(v.logPath ? { logUrl: v.logPath } : {}),
      });
    } catch (err) {
      warn(`verify-cache record failed (best-effort, ignored): ${String(err)}`);
    }
  };

  const cacheEmitMismatch = async (
    stepId: string,
    scSha: string,
    cachedResult: "pass" | "fail",
    realResult: "pass" | "fail",
  ): Promise<void> => {
    if (!cache) return;
    try {
      await cache.pmClient.emitVerifyCacheMismatch(cache.projectId, {
        resource: cache.resource,
        treeSha: cache.treeSha,
        stepId,
        stepConfigSha: scSha,
        cachedResult,
        realResult,
        requestId: cache.requestId,
        attemptId: ctx.attemptId,
      });
    } catch (err) {
      warn(`verify-cache mismatch emit failed (best-effort, ignored): ${String(err)}`);
    }
  };

  const runStep = async (step: VerifyStep): Promise<PipelineStepResult> => {
    const timeoutMs = (step.timeout_sec ?? ctx.verifyTimeoutSec) * 1000;
    const scSha = stepConfigSha(step);
    const tSha = cache?.treeSha ?? "";
    const logPath = logPathForStep(
      ctx.logsDir,
      ctx.attemptId,
      step.id,
      isSyntheticSingle,
    );

    const runReal = (): Promise<VerifyResult> =>
      ctx.gitOps.runVerify(step.command, timeoutMs, {
        cwd: ctx.cwd,
        logPath,
        signal: passController.signal,
      });

    // ── off / disabled / no cache → BYTE-IDENTICAL Step 5 (no lookup, no record).
    if (!cache || !cache.enabled || cache.mode === "off") {
      const v = await runReal();
      return {
        stepId: step.id,
        outcome: PASS(v) ? "pass" : "fail",
        cached: false,
        durationMs: v.durationMs,
        treeSha: tSha,
        stepConfigSha: scSha,
        verify: v,
      };
    }

    if (cache.mode === "on") {
      const hit = await cacheLookup(step.id, scSha);
      if (hit) {
        // HIT → SKIP the run, reuse the verdict. NO record (the server bumped
        // hit_count on lookup; recording on a HIT would be redundant). The
        // synthesized VerifyResult makes a cached FAIL classify "real" → straight
        // to onMemberFailed, never the transient retry (§5.6).
        const v = synthesizeCachedVerify(hit);
        return {
          stepId: step.id,
          outcome: hit.result,
          cached: true,
          durationMs: hit.durationMs ?? 0,
          treeSha: tSha,
          stepConfigSha: scSha,
          verify: v,
        };
      }
      // MISS → run, then record IFF the verdict is NOT transient (§5.6). A
      // transient (spawnError / external signal-kill) is NOT a verdict; a
      // timedOut:true IS a real fail → recorded.
      const v = await runReal();
      const real: "pass" | "fail" = PASS(v) ? "pass" : "fail";
      if (real === "pass" || classifyVerifyFailure(v) !== "transient") {
        await cacheRecord(step.id, scSha, v, real);
      }
      return {
        stepId: step.id,
        outcome: real,
        cached: false,
        durationMs: v.durationMs,
        treeSha: tSha,
        stepConfigSha: scSha,
        verify: v,
      };
    }

    // ── shadow → ALWAYS run, compare, use the REAL verdict, then record (§4.4).
    const [hit, v] = await Promise.all([
      cacheLookup(step.id, scSha),
      runReal(),
    ]);
    const real: "pass" | "fail" = PASS(v) ? "pass" : "fail";
    // Emit ONLY on hit && disagreement (a MISS in shadow is NOT a mismatch).
    if (hit && hit.result !== real) {
      await cacheEmitMismatch(step.id, scSha, hit.result, real);
    }
    // Record the REAL verdict (the shadow self-heal), same transient-guard.
    if (real === "pass" || classifyVerifyFailure(v) !== "transient") {
      await cacheRecord(step.id, scSha, v, real);
    }
    // outcome is ALWAYS the REAL verdict in shadow — NEVER the cached one.
    return {
      stepId: step.id,
      outcome: real,
      cached: false,
      durationMs: v.durationMs,
      treeSha: tSha,
      stepConfigSha: scSha,
      verify: v,
    };
  };

  // ── Topo waves (FOLDED-FIX-4). A wave = every NOT-YET-RUN step whose
  //    depends_on ⊆ passed. Run the wave concurrently; capture the first fail
  //    race-safely; on fail return the captured TRIGGER (discard casualties). ──
  const remaining = new Set<string>(byId.keys());

  while (remaining.size > 0) {
    const wave: VerifyStep[] = [];
    for (const id of remaining) {
      const step = byId.get(id)!;
      if ((step.depends_on ?? []).every((d) => passed.has(d))) wave.push(step);
    }

    // Defensive cycle check (a cycle slipped past the config-time 400-gate):
    // no step is runnable yet remaining is non-empty → unresolvable deps.
    if (wave.length === 0) {
      return { outcome: "fail", failingStep: cycleFailStep(), steps: [] };
    }

    for (const s of wave) remaining.delete(s.id);

    const wavePromises = wave.map((step) =>
      runStep(step).then((result) => {
        allResults.push(result);
        if (result.outcome === "fail" && !failing) {
          // Race-safe FIRST-fail capture: record the trigger ONCE and abort the
          // rest of the pass. Siblings still settle (as SIGTERM casualties) but
          // are never re-scanned into failingStep.
          failing = result;
          passController.abort();
        }
        return result;
      }),
    );

    await Promise.all(wavePromises);

    if (failing) {
      // Return the CAPTURED trigger (NOT re-scanned from allResults — the
      // post-abort siblings resolve exitCode:null/SIGTERM which also "look" failed).
      return { outcome: "fail", failingStep: failing, steps: allResults };
    }

    for (const s of wave) passed.add(s.id);
  }

  return { outcome: "pass", failingStep: null, steps: allResults };
}
