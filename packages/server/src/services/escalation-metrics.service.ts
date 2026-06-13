import { asc, eq } from "drizzle-orm";
import { createId, ESCALATION_SLA_BREACH_THRESHOLD_MS } from "@pm/shared";
import {
  getDb,
  escalations,
  escalationMessages,
  escalationAlertState,
  projects,
} from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";

// ─── Escalation metrics service (Campaign C4 §P2) ─────────────────
// The on-read metric bundle for the agent escalation channel — the
// escalation-side mirror of train metrics.service. NO new table: every
// figure is derived live from the escalations + escalation_messages rows
// for a project. camelCase internally (the route maps to snake_case on the
// wire, train.ts precedent).
//
// THREE SEMANTIC FLAGS (read these before trusting a number):
//   1. human_escalation_rate is the CURRENT needs_human share, NOT
//      ever-reached: an escalation that passed through needs_human and was
//      then resolved is counted as resolved, not escalated.
//   2. auto_resolve_rate counts an escalation as "answered" if it carries
//      ANY messageType="diagnosis" message — including one a human typed by
//      hand via answer(body). It is a diagnosis-message presence signal, not
//      an autonomy proof.
//   3. NO time window. Unlike train metrics (a 24h window), these figures
//      are ALL-TIME for the project. open_backlog.oldest_age_ms is the only
//      "now"-relative figure.

// ─── Types ────────────────────────────────────────────────────────

export interface EscalationPercentilePair {
  p50Ms: number | null;
  p95Ms: number | null;
  sampleSize: number;
}

export interface EscalationRateMetric {
  rate: number | null;
  answered: number;
  total: number;
}

export interface HumanEscalationRateMetric {
  rate: number | null;
  escalated: number;
  total: number;
}

export interface OpenBacklogMetric {
  count: number;
  oldestAgeMs: number | null;
}

export interface EscalationByStatus {
  open: number;
  acknowledged: number;
  answered: number;
  resolved: number;
  needsHuman: number;
}

export interface EscalationByKind {
  bugReport: number;
  question: number;
  request: number;
  blocked: number;
}

export interface EscalationMetricsBundle {
  timeToFirstResponse: EscalationPercentilePair;
  timeToResolve: EscalationPercentilePair;
  autoResolveRate: EscalationRateMetric;
  humanEscalationRate: HumanEscalationRateMetric;
  openBacklog: OpenBacklogMetric;
  byStatus: EscalationByStatus;
  byKind: EscalationByKind;
  total: number;
  computedAt: string;
}

// ─── Internal helpers ─────────────────────────────────────────────

function ensureProjectExists(projectId: string): void {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }
}

// ─── Unanswered-SLA alert latch surface (Campaign C4 §P3) ─────────
//
// The on-read, edge-triggered unanswered-SLA alert mirrors the notes
// backlog-age alert (notes-health.service) PRECISELY: detection is a side
// effect of computeEscalationMetrics, the alert fires exactly ONCE per breach
// episode (latched on escalation_alert_state.sla_notified) and re-arms when no
// escalation is breaching. There is NO sweep / scheduler — the latch boolean is
// the sole write, and the whole latch/emit path is try/catch-guarded so a
// metrics read can NEVER throw on its account.

/**
 * The escalation_alert_state latch row. Mirrors notes-health.NotesAlertLatchRow
 * — id + the single edge-trigger flag.
 */
export interface EscalationAlertLatchRow {
  id: string;
  slaNotified: boolean;
}

function readEscalationAlertStateRow(projectId: string): EscalationAlertLatchRow | undefined {
  const db = getDb();
  const row = db
    .select({ id: escalationAlertState.id, slaNotified: escalationAlertState.slaNotified })
    .from(escalationAlertState)
    .where(eq(escalationAlertState.projectId, projectId))
    .get();
  return (row as EscalationAlertLatchRow | undefined) ?? undefined;
}

/**
 * Read (lazily creating) the project's escalation_alert_state latch row. The
 * INSERT is guarded by try/catch for the unique-index race (two concurrent
 * first reads) — on rejection we re-read. Mirrors readNotesAlertLatch.
 */
export function readEscalationAlertLatch(projectId: string): EscalationAlertLatchRow {
  const existing = readEscalationAlertStateRow(projectId);
  if (existing) return existing;

  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.insert(escalationAlertState)
      .values({
        id: createId(),
        projectId,
        slaNotified: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch {
    // Race: another caller inserted the same project between our SELECT and
    // INSERT. The unique index rejected us — re-read below.
  }
  return readEscalationAlertStateRow(projectId)!;
}

/**
 * Single-COLUMN autocommit UPDATE of the SLA latch by row id. Touches ONLY the
 * latch boolean + updatedAt — no clobber of any other column. Mirrors
 * setNotesAlertLatch.
 */
export function setEscalationAlertLatch(rowId: string, value: boolean, now: string): void {
  getDb()
    .update(escalationAlertState)
    .set({ slaNotified: value, updatedAt: now })
    .where(eq(escalationAlertState.id, rowId))
    .run();
}

/**
 * Nearest-rank percentile over an ASCENDING-sorted numeric array (the train
 * metrics.service precedent — kept PRIVATE here, not imported, so neither
 * service depends on the other). idx = clamp(ceil(p/100 * n) - 1, 0, n - 1).
 * n === 0 → null.
 */
function percentile(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const idx = Math.min(Math.max(Math.ceil((p / 100) * n) - 1, 0), n - 1);
  return sortedAsc[idx];
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Compute the on-read escalation metric bundle for a project (Campaign C4
 * §P2). Derived live from escalations + escalation_messages — no new table.
 * See the THREE SEMANTIC FLAGS at the top of this file.
 *
 * Query strategy (avoid N+1): ONE escalations fetch + ONE messages fetch
 * (only the columns needed: escalationId, authorId, messageType, createdAt),
 * then aggregate in memory.
 */
export function computeEscalationMetrics(
  projectId: string,
  now?: string,
): EscalationMetricsBundle {
  ensureProjectExists(projectId);

  const db = getDb();
  const nowIso = now ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);

  // ── ONE escalations fetch ──────────────────────────────────────
  const escRows = db
    .select({
      id: escalations.id,
      kind: escalations.kind,
      status: escalations.status,
      authorId: escalations.authorId,
      createdAt: escalations.createdAt,
      resolvedAt: escalations.resolvedAt,
    })
    .from(escalations)
    .where(eq(escalations.projectId, projectId))
    .all();

  const total = escRows.length;
  const escById = new Map(escRows.map((e) => [e.id, e]));

  // ── ONE messages fetch (scoped to this project's escalations) ──
  // Inner-join to escalations so the project boundary is enforced in SQL.
  // Ordered by (escalationId, seq) so the first non-origin message per
  // thread is the earliest directed reply.
  const msgRows = db
    .select({
      escalationId: escalationMessages.escalationId,
      authorId: escalationMessages.authorId,
      messageType: escalationMessages.messageType,
      createdAt: escalationMessages.createdAt,
    })
    .from(escalationMessages)
    .innerJoin(escalations, eq(escalationMessages.escalationId, escalations.id))
    .where(eq(escalations.projectId, projectId))
    .orderBy(asc(escalationMessages.escalationId), asc(escalationMessages.seq))
    .all();

  // ── time_to_first_response: per escalation, the FIRST message whose
  // authorId != escalation.authorId (a "directed reply"). Escalations with
  // no such message are EXCLUDED from the sample (but counted in backlog).
  // msgRows is seq-ordered, so the first hit per thread wins.
  const firstResponseSeen = new Set<string>();
  const ttfrDurations: number[] = [];
  // ── auto_resolve_rate: answered = escalations with ≥1 diagnosis message.
  const diagnosisEscalations = new Set<string>();

  for (const m of msgRows) {
    const esc = escById.get(m.escalationId);
    if (!esc) continue;
    if (m.messageType === "diagnosis") {
      diagnosisEscalations.add(m.escalationId);
    }
    if (m.authorId !== esc.authorId && !firstResponseSeen.has(m.escalationId)) {
      firstResponseSeen.add(m.escalationId);
      ttfrDurations.push(Date.parse(m.createdAt) - Date.parse(esc.createdAt));
    }
  }
  ttfrDurations.sort((a, b) => a - b);

  const timeToFirstResponse: EscalationPercentilePair = {
    p50Ms: percentile(ttfrDurations, 50),
    p95Ms: percentile(ttfrDurations, 95),
    sampleSize: ttfrDurations.length,
  };

  // ── time_to_resolve: resolvedAt − createdAt over status=resolved with a
  // non-null resolvedAt (the null filter mirrors computeTimeToLand).
  const resolveDurations = escRows
    .filter((e) => e.status === "resolved" && e.resolvedAt !== null)
    .map((e) => Date.parse(e.resolvedAt as string) - Date.parse(e.createdAt))
    .sort((a, b) => a - b);

  const timeToResolve: EscalationPercentilePair = {
    p50Ms: percentile(resolveDurations, 50),
    p95Ms: percentile(resolveDurations, 95),
    sampleSize: resolveDurations.length,
  };

  // ── auto_resolve_rate (FLAG #2): answered = ≥1 diagnosis message.
  const answered = diagnosisEscalations.size;
  const autoResolveRate: EscalationRateMetric = {
    rate: total === 0 ? null : answered / total,
    answered,
    total,
  };

  // ── human_escalation_rate (FLAG #1): CURRENT needs_human, not ever-reached.
  const escalated = escRows.filter((e) => e.status === "needs_human").length;
  const humanEscalationRate: HumanEscalationRateMetric = {
    rate: total === 0 ? null : escalated / total,
    escalated,
    total,
  };

  // ── open_backlog: count of status=open + age of the oldest open one.
  const openRows = escRows.filter((e) => e.status === "open");
  let oldestOpenMs: number | null = null;
  for (const e of openRows) {
    const ms = Date.parse(e.createdAt);
    if (oldestOpenMs === null || ms < oldestOpenMs) oldestOpenMs = ms;
  }
  const openBacklog: OpenBacklogMetric = {
    count: openRows.length,
    oldestAgeMs: oldestOpenMs === null ? null : nowMs - oldestOpenMs,
  };

  // ── by_status / by_kind tallies (single pass).
  const byStatus: EscalationByStatus = {
    open: 0,
    acknowledged: 0,
    answered: 0,
    resolved: 0,
    needsHuman: 0,
  };
  const byKind: EscalationByKind = { bugReport: 0, question: 0, request: 0, blocked: 0 };
  for (const e of escRows) {
    switch (e.status) {
      case "open":
        byStatus.open++;
        break;
      case "acknowledged":
        byStatus.acknowledged++;
        break;
      case "answered":
        byStatus.answered++;
        break;
      case "resolved":
        byStatus.resolved++;
        break;
      case "needs_human":
        byStatus.needsHuman++;
        break;
    }
    switch (e.kind) {
      case "bug_report":
        byKind.bugReport++;
        break;
      case "question":
        byKind.question++;
        break;
      case "request":
        byKind.request++;
        break;
      case "blocked":
        byKind.blocked++;
        break;
    }
  }

  // ── Unanswered-SLA breach (Campaign C4 §P3) — edge-triggered alert ──
  //
  // A breach is a NON-RESOLVED escalation (status != "resolved") with NO
  // directed reply (not in firstResponseSeen — the same set the TTFR loop
  // built above) that has aged past ESCALATION_SLA_BREACH_THRESHOLD_MS. This
  // deliberately uses the per-escalation firstResponseSeen + createdAt the loop
  // ALREADY tracks rather than openBacklog.oldestAgeMs — so an
  // acknowledged-but-unanswered escalation (status="acknowledged", never an
  // "open" backlog row) STILL counts as a breach. The metrics return shape is
  // unchanged (this is a side-effect-only alert), so no openapi/web regen.
  let breachCount = 0;
  let oldestBreachingAgeMs: number | null = null;
  for (const e of escRows) {
    if (e.status === "resolved") continue;
    if (firstResponseSeen.has(e.id)) continue;
    const createdMs = Date.parse(e.createdAt);
    if (Number.isNaN(createdMs)) continue;
    const ageMs = nowMs - createdMs;
    if (ageMs > ESCALATION_SLA_BREACH_THRESHOLD_MS) {
      breachCount++;
      if (oldestBreachingAgeMs === null || ageMs > oldestBreachingAgeMs) {
        oldestBreachingAgeMs = ageMs;
      }
    }
  }

  // Edge-trigger (best-effort): fire ONCE per breach episode (latch true on the
  // rising edge), reset the latch when no escalation is breaching. The masked
  // emit carries NO escalation/holder id — only the aggregate count + oldest
  // age. The whole block is try/catch-guarded so the metrics read can never
  // throw on the latch/emit path (a misshapen latch row, an emit handler, etc.).
  try {
    const fire = breachCount > 0;
    const latch = readEscalationAlertLatch(projectId);
    if (fire && !latch.slaNotified) {
      setEscalationAlertLatch(latch.id, true, nowIso);
      getEventBus().emit(EVENT_NAMES.ESCALATION_SLA_BREACHED, {
        // Identity-masked — aggregate only, NO escalation/holder id.
        entity: { projectId, breachCount, oldestBreachingAgeMs },
        entityType: "project",
        entityId: projectId,
        projectId,
        actorId: null,
        timestamp: nowIso,
      });
    } else if (!fire && latch.slaNotified) {
      setEscalationAlertLatch(latch.id, false, nowIso);
    }
  } catch {
    // Latch/emit failed — never let the SLA alert side effect break the read.
  }

  return {
    timeToFirstResponse,
    timeToResolve,
    autoResolveRate,
    humanEscalationRate,
    openBacklog,
    byStatus,
    byKind,
    total,
    computedAt: nowIso,
  };
}
