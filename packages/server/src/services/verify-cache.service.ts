import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { createId, type VerifyResultValue, type VerifyCacheRowView } from "@pm/shared";
import { getDb, verifyCache, projects } from "../db/index.js";
import { AppError } from "../types.js";

// ═══════════════════════════════════════════════════════════════════
// Phase 7.5 (§3, §8.5): the PM-owned verify-result cache service. A pure
// strict-keyed key-value store over the verify_cache table — NO cache_enabled
// / cache_mode / TTL knobs live here. Those are settings the INTEGRATOR reads
// (§4.2/§4.3) to decide WHETHER to call lookup/record; this service only owns
// the durable storage + the PM-owned hit bump (§8.5). Mirrors the 7.4
// health.service upsert precedent (read-then-insert-in-try/catch-else-update).
//
// The cache key is the strict 5-tuple (project_id, resource, tree_sha, step_id,
// step_config_sha), enforced unique by idx_verify_cache_key. A lookup is a
// single equality probe — ANY of the 5 fields differing is a MISS, so no stale
// row can ever false-pass (§4.1, THE load-bearing invariant).
// ═══════════════════════════════════════════════════════════════════

// ─── Public arg / result types ───────────────────────────────────

/** The strict 5-tuple lookup key (§3.2). */
export interface LookupArgs {
  projectId: string;
  resource: string;
  treeSha: string;
  stepId: string;
  stepConfigSha: string;
}

/** A record write: the 5-tuple key + the verdict + optional run metadata. */
export interface RecordArgs {
  projectId: string;
  resource: string;
  treeSha: string;
  stepId: string;
  stepConfigSha: string;
  result: VerifyResultValue;
  durationMs?: number | null;
  logExcerpt?: string | null;
  logUrl?: string | null;
}

/** The §7.2 cache-hit-rate metric shape. */
export interface CacheHitRate {
  ratio: number | null;
  hits: number;
  lookups: number;
}

/** Filters + pagination for the debug list GET (§8.4). */
export interface ListArgs {
  resource?: string;
  stepId?: string;
  result?: VerifyResultValue;
  page: number;
  perPage: number;
}

/** A paginated page of cache rows (§8.4). */
export interface ListResult {
  rows: VerifyCacheRowView[];
  total: number;
}

/** The §7.2 per-step metric shape (one entry per step_id over the window). */
export interface PerStepMetric {
  stepId: string;
  runs: number;
  cached: number;
  passRate: number | null;
  avgDurationMs: number | null;
  failCount: number;
}

// ─── Internal row shape ───────────────────────────────────────────

interface VerifyCacheRow {
  id: string;
  projectId: string;
  resource: string;
  treeSha: string;
  stepId: string;
  stepConfigSha: string;
  result: string;
  durationMs: number | null;
  logExcerpt: string | null;
  logUrl: string | null;
  createdAt: string;
  lastHitAt: string | null;
  hitCount: number;
  updatedAt: string;
}

// ─── Internal helpers ─────────────────────────────────────────────

function ensureProjectExists(projectId: string): void {
  const db = getDb();
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }
}

/**
 * The strict 5-tuple probe (§3.2). Returns the single row matching the exact
 * (project, resource, tree_sha, step_id, step_config_sha) tuple, or undefined.
 */
function readRow(
  projectId: string,
  resource: string,
  treeSha: string,
  stepId: string,
  stepConfigSha: string,
): VerifyCacheRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(verifyCache)
    .where(
      and(
        eq(verifyCache.projectId, projectId),
        eq(verifyCache.resource, resource),
        eq(verifyCache.treeSha, treeSha),
        eq(verifyCache.stepId, stepId),
        eq(verifyCache.stepConfigSha, stepConfigSha),
      ),
    )
    .get() as VerifyCacheRow | undefined;
}

function toView(row: VerifyCacheRow): VerifyCacheRowView {
  return {
    id: row.id,
    projectId: row.projectId,
    resource: row.resource,
    treeSha: row.treeSha,
    stepId: row.stepId,
    stepConfigSha: row.stepConfigSha,
    // The DB stores result as plain text but only `record` (enum-validated)
    // ever writes it, so narrowing the row string to the enum union is sound
    // by construction (the audit.service toView convention).
    result: row.result as VerifyResultValue,
    durationMs: row.durationMs,
    logExcerpt: row.logExcerpt,
    logUrl: row.logUrl,
    createdAt: row.createdAt,
    lastHitAt: row.lastHitAt,
    hitCount: row.hitCount,
    updatedAt: row.updatedAt,
  };
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Strict cache lookup (§3.2, §4.3). Probes the exact 5-tuple:
 * - MISS (no exact-key row) → returns null. The integrator runs the step.
 * - HIT → bumps hit_count (+1) + last_hit_at = now + updated_at = now, then
 *   returns the bumped row's view (the cached verdict + duration + log). The
 *   hit bump is PM-owned (§8.5): the integrator never writes the counter, so
 *   the cache-hit-rate metric (§7.2) is authoritative.
 *
 * There is no fuzzy/prefix match — a hit is an exact-tuple equality probe, so
 * no stale row can ever serve a verdict for a different tree/step/config.
 */
export function lookup(args: LookupArgs, now: string): VerifyCacheRowView | null {
  ensureProjectExists(args.projectId);
  const db = getDb();

  const existing = readRow(
    args.projectId,
    args.resource,
    args.treeSha,
    args.stepId,
    args.stepConfigSha,
  );
  if (!existing) return null; // MISS

  // HIT — PM-owned hit bump (§8.5).
  db.update(verifyCache)
    .set({
      hitCount: sql`${verifyCache.hitCount} + 1`,
      lastHitAt: now,
      updatedAt: now,
    })
    .where(eq(verifyCache.id, existing.id))
    .run();

  const bumped = db
    .select()
    .from(verifyCache)
    .where(eq(verifyCache.id, existing.id))
    .get() as VerifyCacheRow;
  return toView(bumped);
}

/**
 * Record a verdict for the 5-tuple key (§8.5): a read-then-write upsert on the
 * unique key.
 * - Absent → INSERT (new id, created_at = updated_at = now, hit_count default
 *   0, last_hit_at null), guarded by try/catch for the unique-index race (a
 *   concurrent insert of the same key falls through to the UPDATE path).
 * - Present → UPDATE the verdict ONLY (result / duration / log / updated_at).
 *
 * PRESERVE-ON-RE-RECORD (the shadow self-heal + metric integrity): on a
 * re-record the running hit_count, the first-recorded created_at, and
 * last_hit_at are NOT touched. The shadow mode overwrites a flipped verdict
 * (§4.4) but the cumulative hit tally + first-recorded timestamp must survive,
 * or the cache-hit-rate / time-saved metrics (§7.2) would be corrupted.
 */
export function record(args: RecordArgs, now: string): VerifyCacheRowView {
  ensureProjectExists(args.projectId);
  const db = getDb();

  const existing = readRow(
    args.projectId,
    args.resource,
    args.treeSha,
    args.stepId,
    args.stepConfigSha,
  );

  if (!existing) {
    try {
      db.insert(verifyCache)
        .values({
          id: createId(),
          projectId: args.projectId,
          resource: args.resource,
          treeSha: args.treeSha,
          stepId: args.stepId,
          stepConfigSha: args.stepConfigSha,
          result: args.result,
          durationMs: args.durationMs ?? null,
          logExcerpt: args.logExcerpt ?? null,
          logUrl: args.logUrl ?? null,
          createdAt: now,
          lastHitAt: null,
          hitCount: 0,
          updatedAt: now,
        })
        .run();
    } catch {
      // Race: another caller inserted the same key between our SELECT and
      // INSERT. The unique index rejected us — fall through to the UPDATE
      // path (preserve-on-re-record: verdict/duration/log only).
      db.update(verifyCache)
        .set({
          result: args.result,
          durationMs: args.durationMs ?? null,
          logExcerpt: args.logExcerpt ?? null,
          logUrl: args.logUrl ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(verifyCache.projectId, args.projectId),
            eq(verifyCache.resource, args.resource),
            eq(verifyCache.treeSha, args.treeSha),
            eq(verifyCache.stepId, args.stepId),
            eq(verifyCache.stepConfigSha, args.stepConfigSha),
          ),
        )
        .run();
    }
  } else {
    // Re-record: overwrite the verdict + run metadata ONLY. hit_count,
    // last_hit_at, and created_at are PRESERVED (metric integrity).
    db.update(verifyCache)
      .set({
        result: args.result,
        durationMs: args.durationMs ?? null,
        logExcerpt: args.logExcerpt ?? null,
        logUrl: args.logUrl ?? null,
        updatedAt: now,
      })
      .where(eq(verifyCache.id, existing.id))
      .run();
  }

  const fresh = readRow(
    args.projectId,
    args.resource,
    args.treeSha,
    args.stepId,
    args.stepConfigSha,
  )!;
  return toView(fresh);
}

/**
 * The cache-hit-rate over a window (§7.2). Per-(project, resource):
 * - hits = Σ hit_count for rows whose last_hit_at is in [from, to].
 * - misses = count of rows whose created_at is in [from, to] (a row's creation
 *   = a miss that ran).
 * - lookups = hits + misses; ratio = lookups === 0 ? null : hits / lookups
 *   (the 7.4 null-percentile convention).
 *
 * Window bounds are JS-ISO inclusive strings (the metrics.service convention).
 */
export function cacheHitRate(
  projectId: string,
  resource: string,
  from: string,
  to: string,
): CacheHitRate {
  const db = getDb();

  const hits = Number(
    db
      .select({ s: sql<number>`coalesce(sum(${verifyCache.hitCount}), 0)` })
      .from(verifyCache)
      .where(
        and(
          eq(verifyCache.projectId, projectId),
          eq(verifyCache.resource, resource),
          gte(verifyCache.lastHitAt, from),
          lte(verifyCache.lastHitAt, to),
        ),
      )
      .get()?.s ?? 0,
  );

  const misses = Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(verifyCache)
      .where(
        and(
          eq(verifyCache.projectId, projectId),
          eq(verifyCache.resource, resource),
          gte(verifyCache.createdAt, from),
          lte(verifyCache.createdAt, to),
        ),
      )
      .get()?.c ?? 0,
  );

  const lookups = hits + misses;
  return {
    ratio: lookups === 0 ? null : hits / lookups,
    hits,
    lookups,
  };
}

/**
 * The debug list (§8.4): recent cache rows for a project, newest-first by
 * created_at, paginated, with optional resource/step_id/result filters. Backs
 * the debug GET + the dashboard cache panel. Returns the page rows + the total
 * matching count (a parallel count(*) over the same filter, for pagination).
 */
export function list(projectId: string, args: ListArgs): ListResult {
  ensureProjectExists(projectId);
  const db = getDb();

  const conditions = [eq(verifyCache.projectId, projectId)];
  if (args.resource !== undefined) {
    conditions.push(eq(verifyCache.resource, args.resource));
  }
  if (args.stepId !== undefined) {
    conditions.push(eq(verifyCache.stepId, args.stepId));
  }
  if (args.result !== undefined) {
    conditions.push(eq(verifyCache.result, args.result));
  }
  const where = and(...conditions);

  const offset = (args.page - 1) * args.perPage;
  const rows = db
    .select()
    .from(verifyCache)
    .where(where)
    .orderBy(desc(verifyCache.createdAt))
    .limit(args.perPage)
    .offset(offset)
    .all() as VerifyCacheRow[];

  const total = Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(verifyCache)
      .where(where)
      .get()?.c ?? 0,
  );

  return { rows: rows.map(toView), total };
}

/**
 * The §7.2 time-saved metric: Σ(hit_count × duration_ms) over hit rows whose
 * last_hit_at is in [from, to] AND duration_ms is non-null — each hit skipped a
 * run that would have cost duration_ms. The last_hit_at window agrees with
 * cacheHitRate's hits basis (§7.2). coalesce → 0 on an empty lane.
 */
export function timeSaved(projectId: string, resource: string, from: string, to: string): number {
  const db = getDb();
  return Number(
    db
      .select({
        s: sql<number>`coalesce(sum(${verifyCache.hitCount} * ${verifyCache.durationMs}), 0)`,
      })
      .from(verifyCache)
      .where(
        and(
          eq(verifyCache.projectId, projectId),
          eq(verifyCache.resource, resource),
          gte(verifyCache.lastHitAt, from),
          lte(verifyCache.lastHitAt, to),
          sql`${verifyCache.durationMs} IS NOT NULL`,
        ),
      )
      .get()?.s ?? 0,
  );
}

/**
 * The §7.2 per-step metrics, grouped by step_id over the window. A row is a
 * window row when its created_at is in [from, to] (its creation = a real run /
 * miss in the window). Per step_id:
 * - runs       = count of window rows (each created row = one real run).
 * - cached     = Σ hit_count of window rows (skips this step's verdict served).
 * - pass_rate  = pass-runs / runs (null when runs === 0 — the null convention).
 * - avg_duration_ms = avg(duration_ms) over window rows with a non-null duration
 *   (null when none).
 * - fail_count = count of window rows whose result is "fail".
 */
export function perStep(
  projectId: string,
  resource: string,
  from: string,
  to: string,
): PerStepMetric[] {
  const db = getDb();
  const rows = db
    .select({
      stepId: verifyCache.stepId,
      runs: sql<number>`count(*)`,
      cached: sql<number>`coalesce(sum(${verifyCache.hitCount}), 0)`,
      passes: sql<number>`sum(case when ${verifyCache.result} = 'pass' then 1 else 0 end)`,
      fails: sql<number>`sum(case when ${verifyCache.result} = 'fail' then 1 else 0 end)`,
      avgDuration: sql<number | null>`avg(${verifyCache.durationMs})`,
    })
    .from(verifyCache)
    .where(
      and(
        eq(verifyCache.projectId, projectId),
        eq(verifyCache.resource, resource),
        gte(verifyCache.createdAt, from),
        lte(verifyCache.createdAt, to),
      ),
    )
    .groupBy(verifyCache.stepId)
    .orderBy(asc(verifyCache.stepId))
    .all();

  return rows.map((r) => {
    const runs = Number(r.runs);
    const passes = Number(r.passes ?? 0);
    return {
      stepId: r.stepId,
      runs,
      cached: Number(r.cached),
      passRate: runs === 0 ? null : passes / runs,
      avgDurationMs: r.avgDuration === null ? null : Number(r.avgDuration),
      failCount: Number(r.fails ?? 0),
    };
  });
}
