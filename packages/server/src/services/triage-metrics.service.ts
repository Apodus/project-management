import { and, count, eq, gte, inArray } from "drizzle-orm";
import { resolveNotesTriage, TRIAGE_DECISION_KINDS, TRIAGE_STALL_THRESHOLD_MS } from "@pm/shared";
import type { TriageDecisionKind } from "@pm/shared";
import { getDb, notes, projects, triageDecisions } from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";
import {
  computeNotesHealth,
  readNotesAlertLatch,
  setNotesTriageStallLatch,
  type NotesHealth,
} from "./notes-health.service.js";

// ─── Triage metrics service (T3·P3) ───────────────────────────────
// The on-read metric bundle for the notes-triage side-log — the triage-side
// mirror of escalation-metrics.service. NO new table: every figure is derived
// live from the triage_decisions side-log (+ notes for latency/lane counts) for
// a project, single-fetch-then-aggregate (no N+1). camelCase internally (the
// route maps to snake_case on the wire, escalation-metrics precedent).
//
// SCOPE — read DIRECTLY off projects.settings.notesTriage.triageAgentId (NOT
// resolveNotesTriage): metrics MUST work while triage is enabled=false/shadow,
// so scope deliberately does NOT depend on the enabled/mode composition. When a
// triageAgentId is designated, the decision-mix/latency/heartbeat figures are
// SCOPED to that identity (operator intent = this identity is the daemon;
// exclude rogue/other-actor rows that would skew shadow calibration). When it is
// unset (early-shadow state — we can't yet know the daemon), ALL actors are
// included and a by_actor breakdown surfaces who is writing. lane counts are
// ALWAYS project-wide (a backlog fact, not an agent fact).
//
// ALERT SIDE EFFECT (T3·P4 — no longer a pure read, mirroring
// computeEscalationMetrics' SLA latch): computeTriageMetrics now ALSO drives two
// edge-triggered alerts as guarded side effects of the read —
//   (1) the EXISTING notes backlog-age alert (computeNotesHealth), now fired
//       from the triage read path too (reuse, not a second mechanism), and
//   (2) the NEW triage.stalled ("triage not draining") alert.
// Both are best-effort + fully try/catch-guarded so the metrics GET (the
// dashboard polls it ~every 30s) can NEVER 500 on the alert path. The RETURNED
// metric SHAPE is unchanged (side-effect only ⇒ zero openapi/web regen).

// ─── Types ────────────────────────────────────────────────────────

export type TriageDecisionMatrix = Record<TriageDecisionKind, number>;

export interface TriageDecisionMix {
  shadow: TriageDecisionMatrix;
  on: TriageDecisionMatrix;
  shadowTotal: number;
  onTotal: number;
  total: number;
}

export interface TriageLatencyMetric {
  p50Ms: number | null;
  p95Ms: number | null;
  sampleSize: number;
}

export interface TriageLaneCounts {
  open: number;
  needsHuman: number;
  triaged: number;
}

export interface TriageActorCount {
  actorId: string;
  count: number;
}

export interface TriageScope {
  triageAgentId: string | null;
  filtered: boolean;
  byActor: TriageActorCount[];
}

export interface TriageHeartbeat {
  // The createdAt of the newest scoped decision — LAST-DECISION freshness, NOT
  // daemon liveness. A quiet-but-alive daemon records nothing, so a stale
  // ageMs does NOT prove the daemon is down (do not drive a daemon-down alert
  // off this — see the T3·P4 note).
  lastDecisionAt: string | null;
  ageMs: number | null;
}

export interface TriageMetricsBundle {
  decisionMix: TriageDecisionMix;
  latency: TriageLatencyMetric;
  laneCounts: TriageLaneCounts;
  scope: TriageScope;
  heartbeat: TriageHeartbeat;
  windowSince: string | null;
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

/**
 * Nearest-rank percentile over an ASCENDING-sorted numeric array (the
 * escalation-metrics.service precedent — kept PRIVATE here, not imported, so
 * neither service depends on the other). idx = clamp(ceil(p/100 * n) - 1, 0,
 * n - 1). n === 0 → null.
 */
function percentile(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const idx = Math.min(Math.max(Math.ceil((p / 100) * n) - 1, 0), n - 1);
  return sortedAsc[idx];
}

/** A fully zero-filled decision matrix (all TRIAGE_DECISION_KINDS → 0). */
function zeroMatrix(): TriageDecisionMatrix {
  const m = {} as TriageDecisionMatrix;
  for (const k of TRIAGE_DECISION_KINDS) m[k] = 0;
  return m;
}

/** The per-project notes-triage settings block (shape resolveNotesTriage reads). */
type NotesTriageSettings = { enabled?: boolean; mode?: string; triageAgentId?: string } | null;

/**
 * Read the project's settings.notesTriage block off the settings JSON. Returned
 * RAW (not run through resolveNotesTriage) so callers can use it two ways:
 *   - SCOPE (triageAgentId) uses it directly — scope must be independent of
 *     enabled/mode so metrics work while triage is off/shadow.
 *   - the T3·P4 alert FIRE-GATE folds it through resolveNotesTriage (with the
 *     env-master) so a stalled-drain alert only fires on resolved enabled+on.
 * Read ONCE per computeTriageMetrics call.
 */
function readNotesTriageSettings(projectId: string): NotesTriageSettings {
  const db = getDb();
  const project = db
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  const settings = project?.settings as { notesTriage?: NotesTriageSettings } | null | undefined;
  return settings?.notesTriage ?? null;
}

// ─── Alert side effects (T3·P4) ───────────────────────────────────
//
// Two edge-triggered alerts driven as a guarded side effect of the on-read
// metrics, mirroring computeEscalationMetrics' SLA latch. NEITHER may throw out
// of the metrics read (the dashboard polls it ~every 30s), so each is wrapped in
// its own try/catch — a backlog-health throw can't 500 the GET, and a
// latch/emit failure can't break the read either.

/**
 * Fire the (1) reused backlog-age alert + (2) new triage.stalled alert as
 * guarded side effects.
 *
 *   (1) computeNotesHealth fires the EXISTING latched NOTE_BACKLOG_ALERT from
 *       this triage read path AND returns the aggregate {openCount,
 *       oldestUntriagedAgeMs} the stall rule reuses (R3: guarded so a throw here
 *       can't 500 the metrics GET).
 *   (2) triage.stalled — fires ONCE per stall episode (latched on
 *       notes_alert_state.triage_stalled_notified, re-arms on clear) when ALL
 *       hold:
 *         a. resolved.enabled && resolved.mode === "on" (R1 — folds the
 *            env-master force-off via resolveNotesTriage, so
 *            PM_NOTES_TRIAGE_ENABLED=false + DB-on does NOT false-fire);
 *         b. an OPEN note has aged past TRIAGE_STALL_THRESHOLD_MS;
 *         c. NO scoped decision was recorded within that window (the heartbeat
 *            this fn already computed — null/stale ⇒ stalled).
 *       Identity-masked emit (aggregate counts + ages, NO note id).
 */
function fireTriageAlerts(
  projectId: string,
  notesTriageSettings: NotesTriageSettings,
  heartbeat: TriageHeartbeat,
  nowIso: string,
  nowMs: number,
): void {
  // (1) Reuse the backlog alert from the triage path — guarded (R3).
  let health: NotesHealth | null = null;
  try {
    health = computeNotesHealth(projectId, new Date(nowMs));
  } catch (err) {
    console.warn(`[triage-metrics] backlog health side-effect failed: ${err}`);
  }
  if (health === null) return;

  // (2) The triage.stalled edge — whole block guarded (escalation-metrics
  // precedent) so the read never throws on the latch/emit path.
  try {
    // R1 — gate on resolveNotesTriage (env-master ⊗ DB), NOT raw DB enabled/mode.
    const resolved = resolveNotesTriage(process.env.PM_NOTES_TRIAGE_ENABLED, {
      notesTriage: notesTriageSettings ?? undefined,
    });
    const onMode = resolved.enabled && resolved.mode === "on";
    const agingBacklog =
      health.openCount > 0 &&
      health.oldestUntriagedAgeMs != null &&
      health.oldestUntriagedAgeMs > TRIAGE_STALL_THRESHOLD_MS;
    const noRecentDecision =
      heartbeat.lastDecisionAt === null ||
      heartbeat.ageMs == null ||
      heartbeat.ageMs > TRIAGE_STALL_THRESHOLD_MS;
    const fire = onMode && agingBacklog && noRecentDecision;

    const latch = readNotesAlertLatch(projectId);
    if (fire && !latch.triageStalledNotified) {
      setNotesTriageStallLatch(latch.id, true, nowIso);
      getEventBus().emit(EVENT_NAMES.TRIAGE_STALLED, {
        // Identity-masked — aggregate counts + ages only, NO note id.
        entity: {
          projectId,
          openCount: health.openCount,
          oldestUntriagedAgeMs: health.oldestUntriagedAgeMs,
          lastDecisionAgeMs: heartbeat.ageMs,
        },
        entityType: "project",
        entityId: projectId,
        projectId,
        actorId: null,
        timestamp: nowIso,
      });
    } else if (!fire && latch.triageStalledNotified) {
      setNotesTriageStallLatch(latch.id, false, nowIso);
    }
  } catch (err) {
    console.warn(`[triage-metrics] triage-stalled alert side-effect failed: ${err}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Compute the on-read triage metric bundle for a project (T3·P3). Derived live
 * from the triage_decisions side-log (+ notes) — no new table. See the SCOPE
 * note at the top of this file.
 *
 * Query strategy (avoid N+1): resolve scope (1 project read) → ONE scoped
 * triage_decisions fetch → ONE notes fetch (by the decisions' noteIds, for
 * latency) → ONE grouped notes count (lane counts). Everything else aggregates
 * in memory over the single decisions fetch.
 */
export function computeTriageMetrics(
  projectId: string,
  opts?: { since?: string; now?: string },
): TriageMetricsBundle {
  ensureProjectExists(projectId);

  const db = getDb();
  const nowIso = opts?.now ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const since = opts?.since ?? null;

  // ── (1) Resolve scope ──────────────────────────────────────────
  // Read settings.notesTriage ONCE: scope uses triageAgentId RAW (independent of
  // enabled/mode), the T3·P4 alert fire-gate folds the same block through
  // resolveNotesTriage below.
  const notesTriageSettings = readNotesTriageSettings(projectId);
  const triageAgentId = notesTriageSettings?.triageAgentId ?? null;
  const filtered = triageAgentId !== null;

  // ── (2) ONE scoped triage_decisions fetch ──────────────────────
  const conditions = [eq(triageDecisions.projectId, projectId)];
  if (filtered) conditions.push(eq(triageDecisions.actorId, triageAgentId));
  if (since) conditions.push(gte(triageDecisions.createdAt, since));

  const decisionRows = db
    .select({
      noteId: triageDecisions.noteId,
      mode: triageDecisions.mode,
      decision: triageDecisions.decision,
      actorId: triageDecisions.actorId,
      createdAt: triageDecisions.createdAt,
    })
    .from(triageDecisions)
    .where(and(...conditions))
    .all();

  const total = decisionRows.length;

  // ── (3) Decision mix (single pass over a zero-filled matrix) ────
  const shadow = zeroMatrix();
  const on = zeroMatrix();
  let shadowTotal = 0;
  let onTotal = 0;
  // (6) heartbeat: newest createdAt over the scoped fetch (free, in-memory).
  let lastDecisionMs: number | null = null;
  let lastDecisionAt: string | null = null;
  // (7) by_actor: only populated when UNfiltered (no designated agent).
  const byActorMap = new Map<string, number>();

  for (const r of decisionRows) {
    if (r.mode === "shadow") {
      shadow[r.decision]++;
      shadowTotal++;
    } else if (r.mode === "on") {
      on[r.decision]++;
      onTotal++;
    }
    const ms = Date.parse(r.createdAt);
    if (!Number.isNaN(ms) && (lastDecisionMs === null || ms > lastDecisionMs)) {
      lastDecisionMs = ms;
      lastDecisionAt = r.createdAt;
    }
    if (!filtered) {
      byActorMap.set(r.actorId, (byActorMap.get(r.actorId) ?? 0) + 1);
    }
  }

  const decisionMix: TriageDecisionMix = {
    shadow,
    on,
    shadowTotal,
    onTotal,
    total: shadowTotal + onTotal,
  };

  // ── (4) Latency: note.createdAt → decision.createdAt ────────────
  // ONE notes fetch by the decisions' noteIds; a decision whose note no longer
  // resolves is skipped (notes are never hard-deleted, but guard anyway).
  const noteIds = [...new Set(decisionRows.map((r) => r.noteId))];
  const noteCreatedById = new Map<string, string>();
  if (noteIds.length > 0) {
    const noteRows = db
      .select({ id: notes.id, createdAt: notes.createdAt })
      .from(notes)
      .where(inArray(notes.id, noteIds))
      .all();
    for (const n of noteRows) noteCreatedById.set(n.id, n.createdAt);
  }

  const latencies: number[] = [];
  for (const r of decisionRows) {
    const noteCreatedAt = noteCreatedById.get(r.noteId);
    if (noteCreatedAt === undefined) continue;
    const delta = Date.parse(r.createdAt) - Date.parse(noteCreatedAt);
    if (Number.isNaN(delta)) continue;
    latencies.push(delta);
  }
  latencies.sort((a, b) => a - b);

  const latency: TriageLatencyMetric = {
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    sampleSize: latencies.length,
  };

  // ── (5) Lane counts — PROJECT-WIDE (not agent-scoped) ───────────
  const laneRows = db
    .select({ status: notes.status, c: count() })
    .from(notes)
    .where(eq(notes.projectId, projectId))
    .groupBy(notes.status)
    .all();
  const laneCounts: TriageLaneCounts = { open: 0, needsHuman: 0, triaged: 0 };
  for (const row of laneRows) {
    switch (row.status) {
      case "open":
        laneCounts.open = row.c;
        break;
      case "needs_human":
        laneCounts.needsHuman = row.c;
        break;
      case "triaged":
        laneCounts.triaged = row.c;
        break;
    }
  }

  // ── (6) heartbeat ───────────────────────────────────────────────
  const heartbeat: TriageHeartbeat = {
    lastDecisionAt,
    ageMs: lastDecisionMs === null ? null : nowMs - lastDecisionMs,
  };

  // ── (7) by_actor (unfiltered only) ──────────────────────────────
  const byActor: TriageActorCount[] = filtered
    ? []
    : [...byActorMap.entries()]
        .map(([actorId, c]) => ({ actorId, count: c }))
        .sort((a, b) => b.count - a.count);

  // ── (8) Alert side effects (T3·P4) — guarded, best-effort ────────
  fireTriageAlerts(projectId, notesTriageSettings, heartbeat, nowIso, nowMs);

  return {
    decisionMix,
    latency,
    laneCounts,
    scope: { triageAgentId, filtered, byActor },
    heartbeat,
    windowSince: since,
    total,
    computedAt: nowIso,
  };
}
