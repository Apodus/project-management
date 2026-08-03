import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  createId,
  deriveForming,
  deriveQueueWait,
  type DerivedPhaseEntry,
  type MergeObservedPhase,
  type MergePhaseRowView,
  type MergePhaseSample,
  type PhaseTraceEntry,
} from "@pm/shared";
import {
  auditLog,
  getDb,
  mergeAttempts,
  mergePhaseTimings,
  mergeRequestGroups,
  mergeRequests,
  projects,
} from "../db/index.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";
import { AppError } from "../types.js";

// ═══════════════════════════════════════════════════════════════════
// Train phase timings (campaign 2026-08-03 §P1) — the append-only store of
// where a merge request's wall clock went, plus the two phases PM derives on
// read (queue_wait / forming).
//
// DESIGN LOCK 1 IS STRUCTURAL HERE, and must stay that way: this service's ONLY
// write is a single insert into merge_phase_timings. Everything else is
// select-only, and NO merge-path service (merge-request / merge-group /
// merge-attempt / merge-lock / merge-resolution) imports it — so no telemetry
// path can fail, delay, or abort a merge. `tests/merge-phase-seal.test.ts` pins
// both halves at the source level.
//
// The one legal throw is a 404 for an unknown project/request/group. Everything
// a wrong-but-well-formed emitter can send (a skewed duration, a fat label, a
// dangling id) is NORMALIZED and counted in `adjusted` rather than rejected: a
// telemetry POST that 500s on a stale id would be a telemetry POST that costs
// the daemon a retry loop it does not have (P2 is fire-and-forget).
// ═══════════════════════════════════════════════════════════════════

const LABEL_MAX = 120;
const DETAIL_MAX_BYTES = 4096;
/** Per-entity trace cap — these reads are unpaginated by contract. */
const TRACE_CAP = 500;

// ─── Public arg / result types ────────────────────────────────────

/**
 * The recorder — the authenticated integrator. Declared locally (the
 * per-service Actor idiom) rather than imported from merge-request.service: the
 * seal forbids an edge between this service and any merge-path service.
 */
export interface Actor {
  id: string;
}

/** One completed observed phase, as the integrator reports it. */
export interface PhaseEntryInput {
  phase: MergeObservedPhase;
  startedAt: string;
  durationMs: number;
  requestId?: string | null;
  groupId?: string | null;
  attemptId?: string | null;
  label?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface RecordArgs {
  resource: string;
  phases: PhaseEntryInput[];
}

/** The ingest ack — see mergePhaseIngestResultSchema for what `adjusted` means. */
export interface RecordResult {
  recorded: number;
  adjusted: number;
}

/** Filters + pagination for the recent list (stored rows only). */
export interface ListRecentArgs {
  resource?: string;
  phase?: MergeObservedPhase;
  requestId?: string;
  groupId?: string;
  since?: string;
  until?: string;
  page: number;
  perPage: number;
}

export interface ListRecentResult {
  rows: MergePhaseRowView[];
  total: number;
}

// ─── Internal row shape ───────────────────────────────────────────

interface PhaseRow {
  id: string;
  projectId: string;
  resource: string;
  requestId: string | null;
  groupId: string | null;
  attemptId: string | null;
  phase: string;
  label: string | null;
  startedAt: string;
  durationMs: number;
  detail: Record<string, unknown> | null;
  recordedBy: string | null;
  createdAt: string;
}

function toRowView(row: PhaseRow): MergePhaseRowView {
  return {
    derived: false,
    id: row.id,
    projectId: row.projectId,
    resource: row.resource,
    requestId: row.requestId,
    groupId: row.groupId,
    attemptId: row.attemptId,
    // Only `record` (enum-validated) ever writes this column, so narrowing the
    // row string to the enum union is sound by construction (the audit.service
    // toView convention).
    phase: row.phase as MergeObservedPhase,
    label: row.label,
    startedAt: row.startedAt,
    durationMs: row.durationMs,
    detail: row.detail,
    recordedBy: row.recordedBy,
    createdAt: row.createdAt,
  };
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

/** Distinct non-null values of one optional id field across the batch. */
function distinctIds(
  phases: PhaseEntryInput[],
  pick: (p: PhaseEntryInput) => string | null,
): string[] {
  const out = new Set<string>();
  for (const p of phases) {
    const v = pick(p);
    if (v !== null && v !== "") out.add(v);
  }
  return [...out];
}

/**
 * The ids of `candidates` that exist AND belong to `projectId`. Anything else —
 * deleted, never-existed, or another project's — is dropped, so an integrator
 * cannot attribute a phase across a project boundary and a stale id degrades to
 * a lane-level (id-less) observation instead of an error.
 */
function resolveRequestIds(projectId: string, candidates: string[]): Set<string> {
  if (candidates.length === 0) return new Set();
  const rows = getDb()
    .select({ id: mergeRequests.id })
    .from(mergeRequests)
    .where(and(inArray(mergeRequests.id, candidates), eq(mergeRequests.projectId, projectId)))
    .all();
  return new Set(rows.map((r) => r.id));
}

function resolveGroupIds(projectId: string, candidates: string[]): Set<string> {
  if (candidates.length === 0) return new Set();
  const rows = getDb()
    .select({ id: mergeRequestGroups.id })
    .from(mergeRequestGroups)
    .where(
      and(inArray(mergeRequestGroups.id, candidates), eq(mergeRequestGroups.projectId, projectId)),
    )
    .all();
  return new Set(rows.map((r) => r.id));
}

/** merge_attempts carries no project_id — it inherits the project of its request. */
function resolveAttemptIds(projectId: string, candidates: string[]): Set<string> {
  if (candidates.length === 0) return new Set();
  const rows = getDb()
    .select({ id: mergeAttempts.id })
    .from(mergeAttempts)
    .innerJoin(mergeRequests, eq(mergeAttempts.requestId, mergeRequests.id))
    .where(and(inArray(mergeAttempts.id, candidates), eq(mergeRequests.projectId, projectId)))
    .all();
  return new Set(rows.map((r) => r.id));
}

function detailWithinBudget(detail: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(detail).length <= DETAIL_MAX_BYTES;
  } catch {
    // Unserializable (cyclic) — treat as over budget rather than throwing.
    return false;
  }
}

// ─── Prior-integration evidence (the requeue anchor) ──────────────

/**
 * Candidate END-of-prior-integration instants per request, as epoch ms.
 *
 * ANCHOR CORRECTNESS (the rule this whole helper exists to enforce): evidence
 * must mark where a prior integration ENDED, never where it began.
 * `merge_attempts.created_at` is when the attempt row was created — the START of
 * the prior verify — so using it would fold an entire 39-minute verify into
 * "queue wait", the exact dishonesty this campaign removes. Hence:
 *
 *  - `audit_log` action=`requeue` — the canonical signal, co-written inside the
 *    requeue transaction (merge-request.service resetToQueued) and therefore
 *    strictly later than the integration it terminates.
 *  - `merge_attempts` — COALESCE(completed_at, started_at). completed_at IS the
 *    verify end; started_at is the fallback for an attempt that never completed
 *    (a crashed integrator), where it is the best available LOWER bound on the
 *    end and still strictly later than the attempt's creation.
 *  - `merge_phase_timings` — started_at + duration_ms, i.e. the phase END. Never
 *    bare started_at, for the same reason.
 *
 * Any candidate at or outside the queue window is discarded by the derivation
 * helper (it re-anchors only on evidence STRICTLY between origin and pickup).
 */
function integrationEndsByRequest(requestIds: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (requestIds.length === 0) return out;
  const db = getDb();

  const push = (requestId: string | null, at: string | null): void => {
    if (requestId === null || at === null) return;
    const ms = Date.parse(at);
    if (!Number.isFinite(ms)) return;
    const list = out.get(requestId);
    if (list) list.push(ms);
    else out.set(requestId, [ms]);
  };

  for (const row of db
    .select({ targetId: auditLog.targetId, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "merge_request"),
        eq(auditLog.action, "requeue"),
        inArray(auditLog.targetId, requestIds),
      ),
    )
    .all()) {
    push(row.targetId, row.createdAt);
  }

  for (const row of db
    .select({
      requestId: mergeAttempts.requestId,
      endedAt: sql<
        string | null
      >`coalesce(${mergeAttempts.completedAt}, ${mergeAttempts.startedAt})`,
    })
    .from(mergeAttempts)
    .where(inArray(mergeAttempts.requestId, requestIds))
    .all()) {
    push(row.requestId, row.endedAt);
  }

  for (const row of db
    .select({
      requestId: mergePhaseTimings.requestId,
      startedAt: mergePhaseTimings.startedAt,
      durationMs: mergePhaseTimings.durationMs,
    })
    .from(mergePhaseTimings)
    .where(inArray(mergePhaseTimings.requestId, requestIds))
    .all()) {
    const started = Date.parse(row.startedAt);
    if (!Number.isFinite(started)) continue;
    push(row.requestId, new Date(started + row.durationMs).toISOString());
  }

  return out;
}

/** The latest candidate strictly before `beforeAt`, as an ISO string. */
function latestBefore(candidates: number[] | undefined, beforeAt: string | null): string | null {
  if (!candidates || candidates.length === 0 || beforeAt === null) return null;
  const bound = Date.parse(beforeAt);
  if (!Number.isFinite(bound)) return null;
  let best: number | null = null;
  for (const ms of candidates) {
    if (ms < bound && (best === null || ms > best)) best = ms;
  }
  return best === null ? null : new Date(best).toISOString();
}

// ─── Write (the ONLY write in this service) ───────────────────────

/**
 * Record a batch of completed phases (integrator ingest).
 *
 * Normalizations, each counted ONCE per row in `adjusted` (a row that trips two
 * of them still counts once):
 *  - `durationMs` → max(0, round(n)); non-finite → 0 (a skewed clock is data
 *    loss, not a failed merge),
 *  - `label` truncated to 120 chars,
 *  - `detail` dropped to null above 4KB,
 *  - a request/group/attempt id that does not exist OR belongs to another
 *    project → null.
 *
 * `recordedBy` comes from the authenticated session, never the body. The whole
 * batch is one transaction, and exactly ONE merge.phase.recorded event is
 * emitted after it commits (a per-row emit would flood the SSE stream that P5
 * renders).
 */
export function record(
  projectId: string,
  args: RecordArgs,
  actor: Actor,
  now: string,
): RecordResult {
  ensureProjectExists(projectId);
  const db = getDb();

  const knownRequests = resolveRequestIds(
    projectId,
    distinctIds(args.phases, (p) => p.requestId ?? null),
  );
  const knownGroups = resolveGroupIds(
    projectId,
    distinctIds(args.phases, (p) => p.groupId ?? null),
  );
  const knownAttempts = resolveAttemptIds(
    projectId,
    distinctIds(args.phases, (p) => p.attemptId ?? null),
  );

  let adjusted = 0;
  const rows = args.phases.map((entry) => {
    let normalized = false;

    const rawDuration = entry.durationMs;
    const durationMs = Number.isFinite(rawDuration) ? Math.max(0, Math.round(rawDuration)) : 0;
    if (durationMs !== rawDuration) normalized = true;

    let label = entry.label ?? null;
    if (label !== null && label.length > LABEL_MAX) {
      label = label.slice(0, LABEL_MAX);
      normalized = true;
    }

    let detail = entry.detail ?? null;
    if (detail !== null && !detailWithinBudget(detail)) {
      detail = null;
      normalized = true;
    }

    const requestId = entry.requestId ?? null;
    const groupId = entry.groupId ?? null;
    const attemptId = entry.attemptId ?? null;
    const resolvedRequestId = requestId !== null && knownRequests.has(requestId) ? requestId : null;
    const resolvedGroupId = groupId !== null && knownGroups.has(groupId) ? groupId : null;
    const resolvedAttemptId = attemptId !== null && knownAttempts.has(attemptId) ? attemptId : null;
    if (
      resolvedRequestId !== requestId ||
      resolvedGroupId !== groupId ||
      resolvedAttemptId !== attemptId
    ) {
      normalized = true;
    }

    if (normalized) adjusted++;

    return {
      id: createId(),
      projectId,
      resource: args.resource,
      requestId: resolvedRequestId,
      groupId: resolvedGroupId,
      attemptId: resolvedAttemptId,
      phase: entry.phase,
      label,
      startedAt: entry.startedAt,
      durationMs,
      detail,
      recordedBy: actor.id,
      createdAt: now,
    };
  });

  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(mergePhaseTimings).values(row).run();
    }
  });

  // One event per BATCH. The ids ride only when the batch speaks about exactly
  // one of each — a mixed batch is a lane-level observation, not a per-request
  // one, and inventing a "primary" id would mislead P5's trace.
  const single = (values: (string | null)[]): string | null => {
    const distinct = new Set(values.filter((v): v is string => v !== null));
    return distinct.size === 1 ? [...distinct][0]! : null;
  };
  const eventRequestId = single(rows.map((r) => r.requestId));
  const eventGroupId = single(rows.map((r) => r.groupId));

  getEventBus().emit(EVENT_NAMES.MERGE_PHASE_RECORDED, {
    entity: {
      projectId,
      resource: args.resource,
      requestId: eventRequestId,
      groupId: eventGroupId,
      attemptId: single(rows.map((r) => r.attemptId)),
      recorded: rows.length,
      adjusted,
      // Distinct phase NAMES, not rows — the frame is a signal to refetch, not
      // a second copy of the store.
      phases: [...new Set(rows.map((r) => r.phase))],
    },
    entityType: "merge_phase",
    entityId: eventRequestId ?? eventGroupId ?? `${projectId}:${args.resource}`,
    projectId,
    actorId: actor.id,
    timestamp: now,
  });

  return { recorded: rows.length, adjusted };
}

// ─── Reads ────────────────────────────────────────────────────────

/**
 * The recent-phase page for a lane. STORED ROWS ONLY, deliberately: a derived
 * entry is synthesized after the query and so cannot participate in SQL
 * LIMIT/OFFSET — mixing it in would either break the page totals or duplicate an
 * entry across pages. Callers wanting the derived phases use the per-request /
 * per-group reads (bounded, unpaginated) or `derivedSamples`.
 *
 * Newest-first by (started_at, id) — the ULID tiebreaker keeps paging stable
 * when a batch lands many rows on the same instant.
 */
export function listRecent(projectId: string, args: ListRecentArgs): ListRecentResult {
  ensureProjectExists(projectId);
  const db = getDb();

  const conditions = [eq(mergePhaseTimings.projectId, projectId)];
  if (args.resource !== undefined) {
    conditions.push(eq(mergePhaseTimings.resource, args.resource));
  }
  if (args.phase !== undefined) conditions.push(eq(mergePhaseTimings.phase, args.phase));
  if (args.requestId !== undefined) {
    conditions.push(eq(mergePhaseTimings.requestId, args.requestId));
  }
  if (args.groupId !== undefined) conditions.push(eq(mergePhaseTimings.groupId, args.groupId));
  if (args.since !== undefined) conditions.push(gte(mergePhaseTimings.startedAt, args.since));
  if (args.until !== undefined) conditions.push(lte(mergePhaseTimings.startedAt, args.until));
  const where = and(...conditions);

  const rows = db
    .select()
    .from(mergePhaseTimings)
    .where(where)
    .orderBy(desc(mergePhaseTimings.startedAt), desc(mergePhaseTimings.id))
    .limit(args.perPage)
    .offset((args.page - 1) * args.perPage)
    .all() as PhaseRow[];

  const total = Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(mergePhaseTimings)
      .where(where)
      .get()?.c ?? 0,
  );

  return { rows: rows.map(toRowView), total };
}

/**
 * The full phase trace for one request: the derived `queue_wait` FOLLOWED BY the
 * stored rows in started_at ASC order. The derived entry is the head by
 * construction — queue_wait ends at pickup, and nothing observable happens
 * before pickup. Bounded (no pagination) at {@link TRACE_CAP} rows.
 */
export function listForRequest(requestId: string): PhaseTraceEntry[] {
  const db = getDb();
  const request = db
    .select({
      id: mergeRequests.id,
      projectId: mergeRequests.projectId,
      resource: mergeRequests.resource,
      enqueuedAt: mergeRequests.enqueuedAt,
      pickedUpAt: mergeRequests.pickedUpAt,
    })
    .from(mergeRequests)
    .where(eq(mergeRequests.id, requestId))
    .get();
  if (!request) {
    throw new AppError(404, "NOT_FOUND", `Merge request not found: ${requestId}`);
  }

  const queueWait = deriveQueueWait({
    projectId: request.projectId,
    resource: request.resource,
    requestId: request.id,
    enqueuedAt: request.enqueuedAt,
    pickedUpAt: request.pickedUpAt,
    priorIntegrationAt: latestBefore(
      integrationEndsByRequest([request.id]).get(request.id),
      request.pickedUpAt,
    ),
  });

  const stored = db
    .select()
    .from(mergePhaseTimings)
    .where(eq(mergePhaseTimings.requestId, request.id))
    .orderBy(asc(mergePhaseTimings.startedAt), asc(mergePhaseTimings.id))
    .limit(TRACE_CAP)
    .all() as PhaseRow[];

  return [...(queueWait ? [queueWait] : []), ...stored.map(toRowView)];
}

/**
 * The full phase trace for one group: the derived `forming` (from the EARLIEST
 * member pickup — the group is being assembled until the first member moves)
 * followed by the stored rows of the group AND of its members, started_at ASC.
 * Bounded (no pagination) at {@link TRACE_CAP} rows.
 */
export function listForGroup(groupId: string): PhaseTraceEntry[] {
  const db = getDb();
  const group = db
    .select({
      id: mergeRequestGroups.id,
      projectId: mergeRequestGroups.projectId,
      resource: mergeRequestGroups.resource,
      createdAt: mergeRequestGroups.createdAt,
    })
    .from(mergeRequestGroups)
    .where(eq(mergeRequestGroups.id, groupId))
    .get();
  if (!group) {
    throw new AppError(404, "NOT_FOUND", `Merge group not found: ${groupId}`);
  }

  const members = db
    .select({ id: mergeRequests.id, pickedUpAt: mergeRequests.pickedUpAt })
    .from(mergeRequests)
    .where(eq(mergeRequests.groupId, group.id))
    .all();
  const memberIds = members.map((m) => m.id);
  const pickups = members
    .map((m) => m.pickedUpAt)
    .filter((p): p is string => p !== null)
    .sort();
  const firstPickup = pickups[0] ?? null;

  const evidence = integrationEndsByRequest(memberIds);
  const priorIntegrationAt = latestBefore(
    memberIds.flatMap((id) => evidence.get(id) ?? []),
    firstPickup,
  );

  const forming = deriveForming({
    projectId: group.projectId,
    resource: group.resource,
    groupId: group.id,
    groupCreatedAt: group.createdAt,
    firstMemberPickupAt: firstPickup,
    priorIntegrationAt,
  });

  const scope =
    memberIds.length === 0
      ? eq(mergePhaseTimings.groupId, group.id)
      : sql`(${mergePhaseTimings.groupId} = ${group.id} OR ${inArray(mergePhaseTimings.requestId, memberIds)})`;
  const stored = db
    .select()
    .from(mergePhaseTimings)
    .where(scope)
    .orderBy(asc(mergePhaseTimings.startedAt), asc(mergePhaseTimings.id))
    .limit(TRACE_CAP)
    .all() as PhaseRow[];

  return [...(forming ? [forming] : []), ...stored.map(toRowView)];
}

/**
 * STORED samples for a lane window — the minimal projection the aggregation
 * consumes. A sample belongs to the window when its phase STARTED in it. Pairs
 * with {@link derivedSamples}, which applies the same rule to the derived
 * phases; the two are disjoint by `phase` (the enum partition), so a caller
 * concatenates them without double-counting.
 */
export function samples(
  projectId: string,
  resource: string,
  from: string,
  to: string,
): MergePhaseSample[] {
  return getDb()
    .select({
      phase: mergePhaseTimings.phase,
      durationMs: mergePhaseTimings.durationMs,
      startedAt: mergePhaseTimings.startedAt,
      requestId: mergePhaseTimings.requestId,
      groupId: mergePhaseTimings.groupId,
      label: mergePhaseTimings.label,
    })
    .from(mergePhaseTimings)
    .where(
      and(
        eq(mergePhaseTimings.projectId, projectId),
        eq(mergePhaseTimings.resource, resource),
        gte(mergePhaseTimings.startedAt, from),
        lte(mergePhaseTimings.startedAt, to),
      ),
    )
    .orderBy(asc(mergePhaseTimings.startedAt), asc(mergePhaseTimings.id))
    .all()
    .map((r) => ({ ...r, phase: r.phase as MergePhaseSample["phase"] }));
}

/**
 * The derived `queue_wait` entry for each of the given requests, keyed by
 * request id (absent when the request was never picked up — a half-open wait is
 * not a completed phase, exactly as {@link derivedSamples} treats it).
 *
 * WHY THIS EXISTS RATHER THAN A SECOND DERIVATION IN THE CALLER: the
 * anchor-correctness rule above ("evidence must mark where a prior integration
 * ENDED, never where it began") is long, subtle and load-bearing — a re-derived
 * copy that reached for `merge_attempts.created_at` would silently charge a
 * whole prior verify to queue wait. One copy, batched, no per-entity N+1.
 *
 * NOT `derivedSamples`: that projection drops `originDurationMs` and `basis`,
 * which are precisely the requeue honesty P4/P5 surface.
 */
export function queueWaitsForRequests(requestIds: string[]): Map<string, DerivedPhaseEntry> {
  const out = new Map<string, DerivedPhaseEntry>();
  if (requestIds.length === 0) return out;

  const requests = getDb()
    .select({
      id: mergeRequests.id,
      projectId: mergeRequests.projectId,
      resource: mergeRequests.resource,
      enqueuedAt: mergeRequests.enqueuedAt,
      pickedUpAt: mergeRequests.pickedUpAt,
    })
    .from(mergeRequests)
    .where(inArray(mergeRequests.id, requestIds))
    .all();

  const evidence = integrationEndsByRequest(requests.map((r) => r.id));
  for (const request of requests) {
    const entry = deriveQueueWait({
      projectId: request.projectId,
      resource: request.resource,
      requestId: request.id,
      enqueuedAt: request.enqueuedAt,
      pickedUpAt: request.pickedUpAt,
      priorIntegrationAt: latestBefore(evidence.get(request.id), request.pickedUpAt),
    });
    if (entry) out.set(request.id, entry);
  }
  return out;
}

/**
 * The derived `forming` entry for each of the given groups, keyed by group id
 * (absent when no member has been picked up yet). The window ends at the
 * EARLIEST member pickup — the group is assembled the moment integration
 * begins — matching {@link listForGroup} and the Discord feed's group anchor.
 */
export function formingForGroups(groupIds: string[]): Map<string, DerivedPhaseEntry> {
  const out = new Map<string, DerivedPhaseEntry>();
  if (groupIds.length === 0) return out;
  const db = getDb();

  const groups = db
    .select({
      id: mergeRequestGroups.id,
      projectId: mergeRequestGroups.projectId,
      resource: mergeRequestGroups.resource,
      createdAt: mergeRequestGroups.createdAt,
    })
    .from(mergeRequestGroups)
    .where(inArray(mergeRequestGroups.id, groupIds))
    .all();
  if (groups.length === 0) return out;

  const members = db
    .select({
      id: mergeRequests.id,
      groupId: mergeRequests.groupId,
      pickedUpAt: mergeRequests.pickedUpAt,
    })
    .from(mergeRequests)
    .where(
      inArray(
        mergeRequests.groupId,
        groups.map((g) => g.id),
      ),
    )
    .all();

  const memberIdsByGroup = new Map<string, string[]>();
  const firstPickupByGroup = new Map<string, string>();
  for (const member of members) {
    if (member.groupId === null) continue;
    const list = memberIdsByGroup.get(member.groupId);
    if (list) list.push(member.id);
    else memberIdsByGroup.set(member.groupId, [member.id]);
    if (member.pickedUpAt === null) continue;
    const earliest = firstPickupByGroup.get(member.groupId);
    // ISO-8601 UTC strings compare lexicographically as instants (every writer
    // here is toISOString), so this is a plain min without a parse.
    if (earliest === undefined || member.pickedUpAt < earliest) {
      firstPickupByGroup.set(member.groupId, member.pickedUpAt);
    }
  }

  const evidence = integrationEndsByRequest(members.map((m) => m.id));
  for (const group of groups) {
    const firstPickup = firstPickupByGroup.get(group.id) ?? null;
    const entry = deriveForming({
      projectId: group.projectId,
      resource: group.resource,
      groupId: group.id,
      groupCreatedAt: group.createdAt,
      firstMemberPickupAt: firstPickup,
      priorIntegrationAt: latestBefore(
        (memberIdsByGroup.get(group.id) ?? []).flatMap((id) => evidence.get(id) ?? []),
        firstPickup,
      ),
    });
    if (entry) out.set(group.id, entry);
  }
  return out;
}

/**
 * DERIVED samples (`queue_wait` + `forming`) for a lane window, so the
 * aggregation concatenates instead of hand-rolling SQL over merge_requests.
 *
 * The SQL selects every request/group whose queue window OVERLAPS [from, to]
 * (a superset — a re-anchored start always lies inside that overlap), then the
 * window rule is applied to the DERIVED startedAt, matching {@link samples}.
 */
export function derivedSamples(
  projectId: string,
  resource: string,
  from: string,
  to: string,
): MergePhaseSample[] {
  const db = getDb();
  const inWindow = (entry: DerivedPhaseEntry): boolean =>
    entry.startedAt >= from && entry.startedAt <= to;
  const out: MergePhaseSample[] = [];

  const requests = db
    .select({
      id: mergeRequests.id,
      enqueuedAt: mergeRequests.enqueuedAt,
      pickedUpAt: mergeRequests.pickedUpAt,
    })
    .from(mergeRequests)
    .where(
      and(
        eq(mergeRequests.projectId, projectId),
        eq(mergeRequests.resource, resource),
        isNotNull(mergeRequests.pickedUpAt),
        lte(mergeRequests.enqueuedAt, to),
        gte(mergeRequests.pickedUpAt, from),
      ),
    )
    .all();

  const requestEvidence = integrationEndsByRequest(requests.map((r) => r.id));
  for (const request of requests) {
    const entry = deriveQueueWait({
      projectId,
      resource,
      requestId: request.id,
      enqueuedAt: request.enqueuedAt,
      pickedUpAt: request.pickedUpAt,
      priorIntegrationAt: latestBefore(requestEvidence.get(request.id), request.pickedUpAt),
    });
    if (entry && inWindow(entry)) {
      out.push({
        phase: entry.phase,
        durationMs: entry.durationMs,
        startedAt: entry.startedAt,
        requestId: entry.requestId,
        groupId: entry.groupId,
        // A derived phase has no sub-step: it is one interval PM computed, not
        // a labelled step an integrator ran. Stated, never omitted.
        label: null,
      });
    }
  }

  const groups = db
    .select({
      id: mergeRequestGroups.id,
      createdAt: mergeRequestGroups.createdAt,
      firstPickup: sql<string | null>`min(${mergeRequests.pickedUpAt})`,
    })
    .from(mergeRequestGroups)
    .innerJoin(mergeRequests, eq(mergeRequests.groupId, mergeRequestGroups.id))
    .where(
      and(
        eq(mergeRequestGroups.projectId, projectId),
        eq(mergeRequestGroups.resource, resource),
        lte(mergeRequestGroups.createdAt, to),
        isNotNull(mergeRequests.pickedUpAt),
      ),
    )
    .groupBy(mergeRequestGroups.id)
    .having(sql`min(${mergeRequests.pickedUpAt}) >= ${from}`)
    .all();

  for (const group of groups) {
    const memberIds = db
      .select({ id: mergeRequests.id })
      .from(mergeRequests)
      .where(eq(mergeRequests.groupId, group.id))
      .all()
      .map((m) => m.id);
    const evidence = integrationEndsByRequest(memberIds);
    const entry = deriveForming({
      projectId,
      resource,
      groupId: group.id,
      groupCreatedAt: group.createdAt,
      firstMemberPickupAt: group.firstPickup,
      priorIntegrationAt: latestBefore(
        memberIds.flatMap((id) => evidence.get(id) ?? []),
        group.firstPickup,
      ),
    });
    if (entry && inWindow(entry)) {
      out.push({
        phase: entry.phase,
        durationMs: entry.durationMs,
        startedAt: entry.startedAt,
        requestId: entry.requestId,
        groupId: entry.groupId,
        label: null,
      });
    }
  }

  return out;
}
