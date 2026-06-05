import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  integratorHealth,
  mergeAttempts,
  mergeRequests,
  mergeResolutions,
  projects,
} from "../db/index.js";
import type { MergeResolutionDetail } from "@pm/shared";
import { AppError } from "../types.js";
import { getHealth, type IntegratorHealthView } from "./health.service.js";
import { readAlertLatch, setAlertLatch } from "./train.service.js";
import * as mergeGroupService from "./merge-group.service.js";
import * as verifyCacheService from "./verify-cache.service.js";
import type { CacheHitRate, PerStepMetric } from "./verify-cache.service.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";
import type { MergeRequestGroupView } from "@pm/shared";

// ─── Constants ────────────────────────────────────────────────────

// The metric window: the last 24 hours (design §5.4/§5.5).
const WINDOW_HOURS = 24;
const WINDOW_MS = WINDOW_HOURS * 3600_000;

// On-read alert thresholds (design §7.3). Edge-triggered, no sweep.
const STUCK_THRESHOLD_MS = 600_000; // 10 min — oldest queued sat un-picked-up.
const ABANDON_ALERT_THRESHOLD = 0.3; // 24h abandon ratio.
const ABANDON_MIN_SAMPLE = 5; // don't alert on a tiny sample (1-of-1).

// train.integration_stalled (design §7.3 follow-up). A single-repo request
// stranded `integrating` — the integrator started an attempt and never
// finished it (e.g. rebaseOnto threw and the request stayed integrating),
// while train.stuck (needs in-flight=0) and integrator_unhealthy (needs a
// stale heartbeat) both miss it. The floor is generous (20 min) so a normal
// long verify never trips it; the threshold scales with verify_timeout_sec.
const STALL_FLOOR_MS = 1_200_000; // 20 min — minimum stall age before firing.
const STALL_GRACE_SEC = 600; // 10 min added atop verify_timeout_sec.

// ─── Types ────────────────────────────────────────────────────────

export interface TimeToLandMetric {
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  sampleSize: number;
}

export interface VerifySuccessRateMetric {
  ratio: number | null;
  passed: number;
  total: number;
}

export interface AbandonRateMetric {
  ratio: number | null;
  abandoned: number;
  resolved: number;
}

export interface PoolUtilizationMetric {
  size: number | null;
  leased: number | null;
  ratio: number | null;
}

export interface SloDimension {
  targetSec?: number;
  target?: number;
  measuredMs?: number | null;
  measured?: number | null;
  compliant: boolean;
}

export interface SloBlock {
  p95TimeToLand?: SloDimension;
  verifySuccessRate?: SloDimension;
  abandonRate?: SloDimension;
  overallCompliant: boolean | null;
}

/**
 * The Phase 7.5 §7.2 verify sub-block. ADDITIVE — a NEW field on the bundle;
 * every existing 7.4 field is unchanged. cacheEnabled/cacheMode are read off
 * projects.settings.integrator; cacheHitRate/timeSavedMs/perStep are derived
 * from the verify_cache rows over the same 24h window. cacheMismatches is
 * surfaced 0 — the mismatch is a NON-persisted relay (§9), so the live count
 * is dashboard-side; 0 is the honest default (healthy on-mode).
 */
export interface VerifyMetric {
  cacheEnabled: boolean;
  cacheMode: string;
  cacheHitRate: CacheHitRate;
  timeSavedMs: number;
  perStep: PerStepMetric[];
  cacheMismatches: number;
}

/**
 * The Phase 7.6 §7 resolution sub-block. ADDITIVE — a NEW field on the bundle,
 * derived from the merge_resolutions rows over the same 24h window. Inert when
 * the resolver is disabled: no rows ⇒ attempts 0, every ratio null. No SLO
 * enforcement (recorded only, like the 7.4/7.5 blocks).
 *
 *   attempts                — resolution rows created in the window.
 *   autoResolveSuccessRate  — (resolved rows whose resolved request LANDED) /
 *                             attempts. An innerJoin to mergeRequests.status
 *                             ===='landed' mirrors computeVerifySuccessRate.
 *   escalationRate          — (escalated|failed rows) / attempts.
 *   meanWallClockMs         — mean(attemptEndedAt − attemptStartedAt) over rows
 *                             where BOTH timestamps are set (the null filter
 *                             mirrors computeTimeToLand); null if none.
 *   budgetUtilization       — mean(detail.budgetConsumedSec) and its ratio
 *                             against settings.integrator.resolver.time_budget_sec.
 */
export interface ResolutionAutoResolveMetric {
  ratio: number | null;
  resolvedAndLanded: number;
  attempts: number;
}

export interface ResolutionEscalationMetric {
  ratio: number | null;
  escalated: number;
  attempts: number;
}

export interface ResolutionBudgetMetric {
  ratio: number | null;
  meanConsumedSec: number | null;
  budgetSec: number;
}

export interface ResolutionMetric {
  attempts: number;
  autoResolveSuccessRate: ResolutionAutoResolveMetric;
  escalationRate: ResolutionEscalationMetric;
  meanWallClockMs: number | null;
  budgetUtilization: ResolutionBudgetMetric;
}

export interface MetricsBundle {
  resource: string;
  queueDepth: number;
  inFlight: number;
  timeToLand: TimeToLandMetric;
  verifySuccessRate: VerifySuccessRateMetric;
  abandonRate: AbandonRateMetric;
  poolUtilization: PoolUtilizationMetric;
  health: IntegratorHealthView;
  slo: SloBlock;
  verify: VerifyMetric;
  resolution: ResolutionMetric;
  windowHours: number;
  computedAt: string;
}

export interface InFlightMember {
  id: string;
  groupId: string | null;
  status: string;
  enqueuedAt: string;
  pickedUpAt: string | null;
  attempt: {
    status: string;
    baseSha: string;
    treeSha: string | null;
    startedAt: string | null;
  } | null;
}

export interface InFlightBundle {
  groups: MergeRequestGroupView[];
  members: InFlightMember[];
}

// ─── Internal helpers ─────────────────────────────────────────────

function ensureProjectExists(projectId: string): void {
  const db = getDb();
  const project = db
    .select({ id: projects.id, settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }
}

function readSettings(projectId: string): unknown {
  const db = getDb();
  const row = db
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  return row?.settings ?? null;
}

/**
 * Nearest-rank percentile over an ASCENDING-sorted numeric array (design §5.4).
 * idx = clamp(ceil(p/100 * n) - 1, 0, n - 1). n === 0 → null.
 */
function percentile(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const idx = Math.min(Math.max(Math.ceil((p / 100) * n) - 1, 0), n - 1);
  return sortedAsc[idx];
}

// ─── Metric computations ──────────────────────────────────────────

function computeQueueDepth(
  projectId: string,
  resource: string,
  status: "queued" | "integrating",
): number {
  const db = getDb();
  return Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(mergeRequests)
      .where(
        and(
          eq(mergeRequests.projectId, projectId),
          eq(mergeRequests.resource, resource),
          eq(mergeRequests.status, status),
        ),
      )
      .get()?.c ?? 0,
  );
}

function computeTimeToLand(projectId: string, resource: string, cutoff: string): TimeToLandMetric {
  const db = getDb();
  const rows = db
    .select({
      enqueuedAt: mergeRequests.enqueuedAt,
      resolvedAt: mergeRequests.resolvedAt,
    })
    .from(mergeRequests)
    .where(
      and(
        eq(mergeRequests.projectId, projectId),
        eq(mergeRequests.resource, resource),
        eq(mergeRequests.status, "landed"),
        // JS-ISO cutoff: ISO-vs-ISO lexicographic bound, NOT SQLite datetime().
        sql`${mergeRequests.resolvedAt} >= ${cutoff}`,
      ),
    )
    .all();

  const durations = rows
    .filter((r) => r.resolvedAt !== null)
    .map((r) => Date.parse(r.resolvedAt as string) - Date.parse(r.enqueuedAt))
    .sort((a, b) => a - b);

  const n = durations.length;
  return {
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    sampleSize: n,
  };
}

function computeVerifySuccessRate(
  projectId: string,
  resource: string,
  cutoff: string,
): VerifySuccessRateMetric {
  const db = getDb();
  // Attempts join their request to scope by (project, resource). cancelled
  // attempts are EXCLUDED from the denominator (they are re-admit artifacts,
  // not verify outcomes — design §5.5).
  const passed = Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(mergeAttempts)
      .innerJoin(mergeRequests, eq(mergeAttempts.requestId, mergeRequests.id))
      .where(
        and(
          eq(mergeRequests.projectId, projectId),
          eq(mergeRequests.resource, resource),
          eq(mergeAttempts.status, "passed"),
          sql`${mergeAttempts.completedAt} >= ${cutoff}`,
        ),
      )
      .get()?.c ?? 0,
  );
  const total = Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(mergeAttempts)
      .innerJoin(mergeRequests, eq(mergeAttempts.requestId, mergeRequests.id))
      .where(
        and(
          eq(mergeRequests.projectId, projectId),
          eq(mergeRequests.resource, resource),
          inArray(mergeAttempts.status, ["passed", "failed"]),
          sql`${mergeAttempts.completedAt} >= ${cutoff}`,
        ),
      )
      .get()?.c ?? 0,
  );

  return {
    ratio: total === 0 ? null : passed / total,
    passed,
    total,
  };
}

function computeAbandonRate(
  projectId: string,
  resource: string,
  cutoff: string,
): AbandonRateMetric {
  const db = getDb();
  const abandoned = Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(mergeRequests)
      .where(
        and(
          eq(mergeRequests.projectId, projectId),
          eq(mergeRequests.resource, resource),
          eq(mergeRequests.status, "abandoned"),
          sql`${mergeRequests.resolvedAt} >= ${cutoff}`,
        ),
      )
      .get()?.c ?? 0,
  );
  const resolved = Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(mergeRequests)
      .where(
        and(
          eq(mergeRequests.projectId, projectId),
          eq(mergeRequests.resource, resource),
          inArray(mergeRequests.status, ["landed", "rejected", "abandoned"]),
          sql`${mergeRequests.resolvedAt} >= ${cutoff}`,
        ),
      )
      .get()?.c ?? 0,
  );

  return {
    ratio: resolved === 0 ? null : abandoned / resolved,
    abandoned,
    resolved,
  };
}

function computePoolUtilization(projectId: string, resource: string): PoolUtilizationMetric {
  const db = getDb();
  const row = db
    .select({
      poolSize: integratorHealth.poolSize,
      poolLeased: integratorHealth.poolLeased,
    })
    .from(integratorHealth)
    .where(and(eq(integratorHealth.projectId, projectId), eq(integratorHealth.resource, resource)))
    .get();

  if (!row) {
    return { size: null, leased: null, ratio: null };
  }
  const size = row.poolSize;
  const leased = row.poolLeased;
  const ratio = size !== null && size > 0 && leased !== null ? leased / size : null;
  return { size, leased, ratio };
}

/**
 * SLO compliance (design §6.2). Reads projects.settings.integrator.slo as plain
 * JSON (defensive — Step 6 adds the canonical config; this reads it if present).
 * A dimension is OMITTED when its target is unconfigured OR its measured value
 * is null (no false red). overall = AND of present dimensions, or null if none.
 */
function computeSlo(
  projectId: string,
  timeToLand: TimeToLandMetric,
  verify: VerifySuccessRateMetric,
  abandon: AbandonRateMetric,
): SloBlock {
  const settings = readSettings(projectId) as {
    integrator?: { slo?: Record<string, unknown> };
  } | null;
  const slo = settings?.integrator?.slo ?? null;

  const block: SloBlock = { overallCompliant: null };
  if (!slo || typeof slo !== "object") {
    return block;
  }

  const dims: boolean[] = [];

  const targetP95 = slo["target_p95_time_to_land_sec"];
  if (typeof targetP95 === "number" && timeToLand.p95Ms !== null) {
    const compliant = timeToLand.p95Ms <= targetP95 * 1000;
    block.p95TimeToLand = {
      targetSec: targetP95,
      measuredMs: timeToLand.p95Ms,
      compliant,
    };
    dims.push(compliant);
  }

  const targetVerify = slo["target_verify_success_rate"];
  if (typeof targetVerify === "number" && verify.ratio !== null) {
    const compliant = verify.ratio >= targetVerify;
    block.verifySuccessRate = {
      target: targetVerify,
      measured: verify.ratio,
      compliant,
    };
    dims.push(compliant);
  }

  const targetAbandon = slo["target_abandon_rate"];
  if (typeof targetAbandon === "number" && abandon.ratio !== null) {
    const compliant = abandon.ratio <= targetAbandon;
    block.abandonRate = {
      target: targetAbandon,
      measured: abandon.ratio,
      compliant,
    };
    dims.push(compliant);
  }

  block.overallCompliant = dims.length === 0 ? null : dims.every((d) => d);
  return block;
}

/**
 * The ISO timestamp of the oldest `queued` request in the lane (MIN(enqueuedAt))
 * — null when the queue is empty. The stuck-alert age basis (§7.3).
 */
function computeOldestQueuedAt(projectId: string, resource: string): string | null {
  const db = getDb();
  const row = db
    .select({ oldest: sql<string | null>`MIN(${mergeRequests.enqueuedAt})` })
    .from(mergeRequests)
    .where(
      and(
        eq(mergeRequests.projectId, projectId),
        eq(mergeRequests.resource, resource),
        eq(mergeRequests.status, "queued"),
      ),
    )
    .get();
  return row?.oldest ?? null;
}

/**
 * The oldest single-repo request stranded `integrating` past `thresholdMs`, or
 * null when none. The basis of the train.integration_stalled alert (§7.3
 * follow-up): the integrator started an attempt (or picked the request up) and
 * never finished it — e.g. rebaseOnto threw and the request stayed integrating.
 *
 * Two strandings count, both gated to `groupId IS NULL` (grouped members follow
 * the atomic group lifecycle, not this alert):
 *   (a) the request's LATEST attempt (max attemptNumber) is still `running` and
 *       its startedAt is older than the cutoff; OR
 *   (b) the request has NO attempt rows at all and its pickedUpAt is older than
 *       the cutoff (picked up, attempt never even opened).
 *
 * The latest-attempt-per-request join uses a MAX(attemptNumber) correlated
 * subquery (mirrors merge-attempt.service.getNextAttemptNumber +
 * computeResolution's join shape). The cutoff is an ISO string bound into the
 * query and compared lexicographically — NEVER SQLite datetime() (the stored
 * timestamps are toISOString(), per the §5.4 note at computeMetrics). The
 * caller is responsible for the parallelism===1 + not-paused gates; this helper
 * only enforces the groupId/status/age predicate.
 */
function computeOldestStalledIntegrating(
  projectId: string,
  resource: string,
  now: string,
  thresholdMs: number,
): { requestId: string; stalenessMs: number } | null {
  const db = getDb();
  const cutoffMs = Date.parse(now) - thresholdMs;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Case (a): integrating + ungrouped + the request's LATEST attempt is running
  // (no attempt with a higher attemptNumber exists) + that attempt's startedAt
  // is older than the cutoff. The join keys the attempt to its request; the
  // NOT EXISTS "no newer attempt" clause pins it to the latest attempt without a
  // correlated MAX() in the JOIN ON (which SQLite rejects as a misused
  // aggregate). The inner subquery uses a distinct alias (`newer`) + raw column
  // names so it references the OUTER merge_attempts row, not itself.
  const caseA = db
    .select({
      requestId: mergeRequests.id,
      basis: mergeAttempts.startedAt,
    })
    .from(mergeRequests)
    .innerJoin(mergeAttempts, eq(mergeAttempts.requestId, mergeRequests.id))
    .where(
      and(
        eq(mergeRequests.projectId, projectId),
        eq(mergeRequests.resource, resource),
        eq(mergeRequests.status, "integrating"),
        sql`${mergeRequests.groupId} IS NULL`,
        sql`${mergeRequests.pickedUpAt} IS NOT NULL`,
        eq(mergeAttempts.status, "running"),
        sql`${mergeAttempts.startedAt} IS NOT NULL`,
        sql`${mergeAttempts.startedAt} < ${cutoffIso}`,
        // The running attempt is the LATEST: no sibling with a higher number.
        sql`NOT EXISTS (
          SELECT 1 FROM ${mergeAttempts} AS newer
          WHERE newer.request_id = ${mergeAttempts.requestId}
            AND newer.attempt_number > ${mergeAttempts.attemptNumber}
        )`,
      ),
    )
    .all() as Array<{ requestId: string; basis: string }>;

  // Case (b): integrating + ungrouped + NO attempt rows + pickedUpAt older than
  // the cutoff. The NOT EXISTS keeps it to requests the integrator picked up but
  // never opened an attempt for.
  const caseB = db
    .select({
      requestId: mergeRequests.id,
      basis: mergeRequests.pickedUpAt,
    })
    .from(mergeRequests)
    .where(
      and(
        eq(mergeRequests.projectId, projectId),
        eq(mergeRequests.resource, resource),
        eq(mergeRequests.status, "integrating"),
        sql`${mergeRequests.groupId} IS NULL`,
        sql`${mergeRequests.pickedUpAt} IS NOT NULL`,
        sql`${mergeRequests.pickedUpAt} < ${cutoffIso}`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${mergeAttempts} AS ma
          WHERE ma.request_id = ${mergeRequests.id}
        )`,
      ),
    )
    .all() as Array<{ requestId: string; basis: string }>;

  // The oldest basis (max staleness) across both sets.
  let best: { requestId: string; stalenessMs: number } | null = null;
  const nowMs = Date.parse(now);
  for (const r of [...caseA, ...caseB]) {
    const stalenessMs = nowMs - Date.parse(r.basis);
    if (best === null || stalenessMs > best.stalenessMs) {
      best = { requestId: r.requestId, stalenessMs };
    }
  }
  return best;
}

/**
 * The Phase 7.5 §7.2 verify sub-block, computed over the same [cutoff, nowIso]
 * window as the rest of the bundle. cache_enabled/cache_mode are read off
 * projects.settings.integrator (defaulting to off/empty — the shipped
 * backward-compat defaults, §10). The hit-rate / time-saved / per-step are
 * derived from the verify_cache rows. cache_mismatches is surfaced 0: the
 * mismatch event is a NON-persisted relay (§9), so there is no durable count to
 * aggregate — the live count is reconstructed dashboard-side from the SSE
 * stream. 0 is the honest healthy-on-mode default.
 */
function computeVerify(
  projectId: string,
  resource: string,
  from: string,
  to: string,
): VerifyMetric {
  const settings = readSettings(projectId) as {
    integrator?: { cache_enabled?: unknown; cache_mode?: unknown };
  } | null;
  const integrator = settings?.integrator ?? null;
  const cacheEnabled =
    typeof integrator?.cache_enabled === "boolean" ? integrator.cache_enabled : false;
  const cacheMode = typeof integrator?.cache_mode === "string" ? integrator.cache_mode : "off";

  return {
    cacheEnabled,
    cacheMode,
    cacheHitRate: verifyCacheService.cacheHitRate(projectId, resource, from, to),
    timeSavedMs: verifyCacheService.timeSaved(projectId, resource, from, to),
    perStep: verifyCacheService.perStep(projectId, resource, from, to),
    // NON-persisted relay (§9) — no durable count; 0 is the honest default.
    cacheMismatches: 0,
  };
}

/**
 * The Phase 7.6 §7 resolution sub-block, computed over the same [cutoff, nowIso]
 * window as the rest of the bundle. Reads merge_resolutions rows scoped by
 * (project, resource) with createdAt >= cutoff.
 *
 * time_budget_sec is read from settings.integrator.resolver.time_budget_sec
 * (default 3600 — the shared schema default). budgetUtilization.ratio is null
 * when there is no consumed-seconds sample.
 *
 * Inert when the resolver is disabled: no rows ⇒ attempts 0, every ratio null.
 */
function computeResolution(projectId: string, resource: string, cutoff: string): ResolutionMetric {
  const db = getDb();

  const settings = readSettings(projectId) as {
    integrator?: { resolver?: { time_budget_sec?: unknown } };
  } | null;
  const budgetSec =
    typeof settings?.integrator?.resolver?.time_budget_sec === "number"
      ? settings.integrator.resolver.time_budget_sec
      : 3600;

  // attempts = every resolution row created in the window for this lane.
  const attempts = Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(mergeResolutions)
      .where(
        and(
          eq(mergeResolutions.projectId, projectId),
          eq(mergeResolutions.resource, resource),
          sql`${mergeResolutions.createdAt} >= ${cutoff}`,
        ),
      )
      .get()?.c ?? 0,
  );

  // resolvedAndLanded = resolved rows whose resolved request actually LANDED.
  // An innerJoin to mergeRequests.status==='landed' mirrors
  // computeVerifySuccessRate's join shape.
  const resolvedAndLanded = Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(mergeResolutions)
      .innerJoin(mergeRequests, eq(mergeResolutions.resolvedRequestId, mergeRequests.id))
      .where(
        and(
          eq(mergeResolutions.projectId, projectId),
          eq(mergeResolutions.resource, resource),
          eq(mergeResolutions.state, "resolved"),
          eq(mergeRequests.status, "landed"),
          sql`${mergeResolutions.createdAt} >= ${cutoff}`,
        ),
      )
      .get()?.c ?? 0,
  );

  // escalated = escalated|failed rows (both route to a human/author — they are
  // the "resolver couldn't auto-resolve" outcomes).
  const escalated = Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(mergeResolutions)
      .where(
        and(
          eq(mergeResolutions.projectId, projectId),
          eq(mergeResolutions.resource, resource),
          inArray(mergeResolutions.state, ["escalated", "failed"]),
          sql`${mergeResolutions.createdAt} >= ${cutoff}`,
        ),
      )
      .get()?.c ?? 0,
  );

  // Wall-clock + budget rows: pull the timestamps + detail for the window.
  const rows = db
    .select({
      attemptStartedAt: mergeResolutions.attemptStartedAt,
      attemptEndedAt: mergeResolutions.attemptEndedAt,
      detail: mergeResolutions.detail,
    })
    .from(mergeResolutions)
    .where(
      and(
        eq(mergeResolutions.projectId, projectId),
        eq(mergeResolutions.resource, resource),
        sql`${mergeResolutions.createdAt} >= ${cutoff}`,
      ),
    )
    .all() as Array<{
    attemptStartedAt: string | null;
    attemptEndedAt: string | null;
    detail: MergeResolutionDetail | null;
  }>;

  // meanWallClockMs: mean(end − start) EXCLUDING rows where either timestamp is
  // null (PRECISION NOTE 2 — mirrors computeTimeToLand's null filter).
  const wallClocks = rows
    .filter((r) => r.attemptStartedAt !== null && r.attemptEndedAt !== null)
    .map((r) => Date.parse(r.attemptEndedAt as string) - Date.parse(r.attemptStartedAt as string));
  const meanWallClockMs =
    wallClocks.length === 0 ? null : wallClocks.reduce((a, b) => a + b, 0) / wallClocks.length;

  // budgetUtilization: mean(detail.budgetConsumedSec) over rows that reported
  // it, and the ratio of that mean against the configured time_budget_sec.
  const consumed = rows
    .map((r) => r.detail?.budgetConsumedSec)
    .filter((s): s is number => typeof s === "number");
  const meanConsumedSec =
    consumed.length === 0 ? null : consumed.reduce((a, b) => a + b, 0) / consumed.length;

  return {
    attempts,
    autoResolveSuccessRate: {
      ratio: attempts === 0 ? null : resolvedAndLanded / attempts,
      resolvedAndLanded,
      attempts,
    },
    escalationRate: {
      ratio: attempts === 0 ? null : escalated / attempts,
      escalated,
      attempts,
    },
    meanWallClockMs,
    budgetUtilization: {
      ratio: meanConsumedSec === null || budgetSec === 0 ? null : meanConsumedSec / budgetSec,
      meanConsumedSec,
      budgetSec,
    },
  };
}

/**
 * The on-read, edge-triggered alert evaluation (§7.3). Called from
 * computeMetrics AFTER the bundle is assembled. Evaluates two conditions
 * against the assembled metrics + the oldest-queued age, latching each on the
 * train_state row so the alert fires exactly ONCE per breach episode and
 * re-arms when the condition clears.
 *
 * The latch UPDATEs are single-statement autocommits (NOT in a txn) and the
 * emit happens AFTER the write returns — mirroring health.service.checkStaleness.
 *
 * STUCK = oldestQueuedAge > STUCK_THRESHOLD_MS AND inFlight === 0 AND the train
 * is NOT paused (a paused train is deliberately held, not stuck — §7.3 + the
 * folded recommendation; the row.state is already read here).
 *
 * ABANDON = abandonRate.ratio > ABANDON_ALERT_THRESHOLD AND resolved >=
 * ABANDON_MIN_SAMPLE.
 */
function checkAlerts(
  projectId: string,
  resource: string,
  metrics: MetricsBundle,
  oldestQueuedAt: string | null,
  now: string,
): void {
  const row = readAlertLatch(projectId, resource);

  // ── STUCK ──────────────────────────────────────────────────────
  const oldestQueuedAgeMs =
    oldestQueuedAt !== null ? Date.parse(now) - Date.parse(oldestQueuedAt) : null;
  const fireStuck =
    oldestQueuedAgeMs !== null &&
    oldestQueuedAgeMs > STUCK_THRESHOLD_MS &&
    metrics.inFlight === 0 &&
    row.state !== "paused"; // a paused train isn't stuck — it's held.

  if (fireStuck && !row.stuckNotified) {
    setAlertLatch(row.id, "stuckNotified", true, now);
    getEventBus().emit(EVENT_NAMES.TRAIN_STUCK, {
      entity: {
        resource,
        oldestQueuedAgeMs,
        queueDepth: metrics.queueDepth,
      },
      entityType: "train",
      entityId: resource,
      projectId,
      actorId: null,
      timestamp: now,
    });
  } else if (!fireStuck && row.stuckNotified) {
    // Condition cleared — reset the latch so the NEXT stuck episode re-fires.
    setAlertLatch(row.id, "stuckNotified", false, now);
  }

  // ── ABANDON ────────────────────────────────────────────────────
  const fireAbandon =
    metrics.abandonRate.ratio !== null &&
    metrics.abandonRate.ratio > ABANDON_ALERT_THRESHOLD &&
    metrics.abandonRate.resolved >= ABANDON_MIN_SAMPLE;

  if (fireAbandon && !row.abandonNotified) {
    setAlertLatch(row.id, "abandonNotified", true, now);
    getEventBus().emit(EVENT_NAMES.TRAIN_ABANDON_RATE_HIGH, {
      entity: {
        resource,
        ratio: metrics.abandonRate.ratio,
        resolved: metrics.abandonRate.resolved,
      },
      entityType: "train",
      entityId: resource,
      projectId,
      actorId: null,
      timestamp: now,
    });
  } else if (!fireAbandon && row.abandonNotified) {
    setAlertLatch(row.id, "abandonNotified", false, now);
  }

  // ── INTEGRATION STALLED ────────────────────────────────────────
  // A single-repo request stranded `integrating` (an attempt started but never
  // completed, older than verify_timeout+grace). GATED so it NEVER false-fires:
  //   GATE 1 — only at parallelism===1. At parallelism>1 a healthy speculative
  //     member holds an OPEN `running` attempt for the whole predecessor
  //     land-chain (verify-pass doesn't complete the attempt; completeAttempt
  //     fires only at land), and there's no DB column to identify speculative
  //     members — so we structurally exclude that case by only evaluating on a
  //     serial lane (parallelism 1 ⇒ no speculative land-chain exists).
  //   GATE 2 — only groupId IS NULL (grouped members follow the atomic group
  //     lifecycle, enforced inside computeOldestStalledIntegrating).
  //   GATE 3 — not paused (a paused lane is deliberately held, mirror STUCK).
  const stalledIntegrator = readSettings(projectId) as {
    integrator?: { parallelism?: unknown; verify_timeout_sec?: unknown };
  } | null;
  const parallelism =
    typeof stalledIntegrator?.integrator?.parallelism === "number"
      ? stalledIntegrator.integrator.parallelism
      : 1;
  const verifyTimeoutSec =
    typeof stalledIntegrator?.integrator?.verify_timeout_sec === "number"
      ? stalledIntegrator.integrator.verify_timeout_sec
      : 600;
  const thresholdMs = Math.max(STALL_FLOOR_MS, (verifyTimeoutSec + STALL_GRACE_SEC) * 1000);

  const stalled =
    parallelism === 1 && row.state !== "paused"
      ? computeOldestStalledIntegrating(projectId, resource, now, thresholdMs)
      : null;
  const fireStalled = stalled !== null;

  if (fireStalled && !row.stalledNotified) {
    setAlertLatch(row.id, "stalledNotified", true, now);
    getEventBus().emit(EVENT_NAMES.TRAIN_INTEGRATION_STALLED, {
      entity: {
        resource,
        requestId: stalled.requestId,
        stalenessMs: stalled.stalenessMs,
      },
      entityType: "train",
      entityId: resource,
      projectId,
      actorId: null,
      timestamp: now,
    });
  } else if (!fireStalled && row.stalledNotified) {
    setAlertLatch(row.id, "stalledNotified", false, now);
  }
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Compute the on-read metric bundle for a (project, resource) lane (design §5).
 *
 * The 24h cutoff is computed ONCE here as a JS-ISO string and bound into every
 * windowed query (NEVER SQLite datetime() — its format is not lexicographically
 * comparable to the stored toISOString() timestamps, design §5.4).
 *
 * The `health` block is sourced from healthService.getHealth (NOT a raw row
 * read) so that a dashboard metrics read fires the train.integrator_unhealthy
 * stale edge exactly once per stale episode (design §3.4 / §7.3).
 */
export function computeMetrics(projectId: string, resource = "main", now?: string): MetricsBundle {
  ensureProjectExists(projectId);

  const nowIso = now ?? new Date().toISOString();
  const cutoff = new Date((now ? Date.parse(now) : Date.now()) - WINDOW_MS).toISOString();

  const queueDepth = computeQueueDepth(projectId, resource, "queued");
  const inFlight = computeQueueDepth(projectId, resource, "integrating");
  const timeToLand = computeTimeToLand(projectId, resource, cutoff);
  const verifySuccessRate = computeVerifySuccessRate(projectId, resource, cutoff);
  const abandonRate = computeAbandonRate(projectId, resource, cutoff);
  const poolUtilization = computePoolUtilization(projectId, resource);
  // Reuse getHealth so the stale edge fires on a dashboard metrics read.
  const health = getHealth(projectId, resource, nowIso);
  const slo = computeSlo(projectId, timeToLand, verifySuccessRate, abandonRate);
  // §7.2 verify sub-block — same [cutoff, nowIso] window as the rest of the
  // bundle. Additive: a NEW field, every existing field unchanged.
  const verify = computeVerify(projectId, resource, cutoff, nowIso);
  // §7 resolution sub-block — same 24h window. Additive: inert (zeros/nulls)
  // when the resolver is disabled / no resolutions exist.
  const resolution = computeResolution(projectId, resource, cutoff);
  const oldestQueuedAt = computeOldestQueuedAt(projectId, resource);

  const bundle: MetricsBundle = {
    resource,
    queueDepth,
    inFlight,
    timeToLand,
    verifySuccessRate,
    abandonRate,
    poolUtilization,
    health,
    slo,
    verify,
    resolution,
    windowHours: WINDOW_HOURS,
    computedAt: nowIso,
  };

  // On-read, edge-triggered alert evaluation (§7.3) — fires train.stuck /
  // train.abandon_rate_high once per breach episode as a side effect of the
  // metrics read. Done AFTER the bundle is assembled (needs inFlight +
  // abandonRate + queueDepth).
  checkAlerts(projectId, resource, bundle, oldestQueuedAt, nowIso);

  return bundle;
}

/**
 * The in-flight composition (design §5.3): the lane's `integrating` requests
 * with each one's latest attempt + groupId, plus the forming/integrating group
 * rows. The server does NOT compute speculativePosition/batchId — the dashboard
 * enriches those from the SSE stream (7.2 events-not-tables contract).
 */
export function getInFlight(projectId: string, resource = "main"): InFlightBundle {
  ensureProjectExists(projectId);
  const db = getDb();

  const requestRows = db
    .select({
      id: mergeRequests.id,
      groupId: mergeRequests.groupId,
      status: mergeRequests.status,
      enqueuedAt: mergeRequests.enqueuedAt,
      pickedUpAt: mergeRequests.pickedUpAt,
    })
    .from(mergeRequests)
    .where(
      and(
        eq(mergeRequests.projectId, projectId),
        eq(mergeRequests.resource, resource),
        eq(mergeRequests.status, "integrating"),
      ),
    )
    .orderBy(asc(mergeRequests.enqueuedAt))
    .all();

  const members: InFlightMember[] = requestRows.map((r) => {
    const latest = db
      .select({
        status: mergeAttempts.status,
        baseSha: mergeAttempts.baseSha,
        treeSha: mergeAttempts.treeSha,
        startedAt: mergeAttempts.startedAt,
      })
      .from(mergeAttempts)
      .where(eq(mergeAttempts.requestId, r.id))
      .orderBy(desc(mergeAttempts.attemptNumber))
      .limit(1)
      .get();
    return {
      id: r.id,
      groupId: r.groupId,
      status: r.status,
      enqueuedAt: r.enqueuedAt,
      pickedUpAt: r.pickedUpAt,
      attempt: latest
        ? {
            status: latest.status,
            baseSha: latest.baseSha,
            treeSha: latest.treeSha,
            startedAt: latest.startedAt,
          }
        : null,
    };
  });

  const groups = mergeGroupService
    .list(projectId, { resource })
    .filter((g) => g.state === "forming" || g.state === "integrating");

  return { groups, members };
}
