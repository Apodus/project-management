import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type {
  AuditAction,
  DerivedPhaseEntry,
  MergeGroupState,
  MergePhase,
  TrainTraceElapsed,
  TrainTraceEntry,
  TrainTraceKind,
  TrainTraceSource,
  TrainTraceSubjectType,
} from "@pm/shared";
import {
  auditLog,
  getDb,
  mergeIncidents,
  mergePhaseTimings,
  mergeRequestGroups,
  mergeRequests,
  projects,
  tasks,
  users,
} from "../db/index.js";
import * as mergePhaseService from "./merge-phase.service.js";
import { AppError } from "../types.js";

// ═══════════════════════════════════════════════════════════════════
// The train event trace (campaign 2026-08-03 §P5) — "what happened on this
// lane lately, and what took how long".
//
// SELECT-ONLY. This service writes nothing, ever: it is a read over telemetry
// (merge_phase_timings), the audit log, and the entity tables. It imports
// merge-phase.service for the two derived-phase helpers, which is why it had to
// come to tests/merge-phase-seal.test.ts and justify itself — and why that seal
// ALSO pins that nothing in src/events, and no merge-path service, imports THIS
// file. That second assertion is the whole point: without it a future listener
// could import train-trace.service and reach the telemetry store transitively,
// passing both seals. An events listener runs synchronously inside the emitting
// service's commit path, so a read that throws there breaks a land; a
// request-path read like this one can only ever fail a GET.
//
// TWO ARMS, NOT THREE. The roadmap sketched activity_log as a third source; it
// cannot be one:
//   - A partially-landed group is UNRECOVERABLE from activity_log. The partial
//     land reuses MERGE_GROUP_REJECTED with outcome:"partially_landed" on the
//     event payload's `entity`, and activity.service persists only
//     entityType/entityId/action/changes — the payload entity never reaches a
//     row. The orphaned-inner case, the one an operator most needs this feed
//     for, would read "group rejected".
//   - Everything else that arm could offer is in the ENTITY TABLES, with full
//     retroactive history: group outcomes from merge_request_groups.state /
//     resolved_at / resolution_reason, group_started from the earliest member
//     pickup, incident_opened from merge_incidents.opened_at. Entity reads
//     populate the window on day one; activity rows written before any mapping
//     change would read action:"unknown" and be dropped.
// Dropping the arm also drops the reconciliation it would have needed (the same
// land is an audit row AND an activity row): two disjoint arms cannot
// double-count.
// ═══════════════════════════════════════════════════════════════════

/** The default lane, matching merge_requests.resource's column default. */
const DEFAULT_RESOURCE = "main";

/** How far back the feed looks when the caller names no `since`. */
const DEFAULT_WINDOW_MS = 24 * 3600_000;

/**
 * Hard per-arm row cap. A 24h window on a busy lane is thousands of phase rows
 * per poll while the union is sliced to at most 200, so every row past the cap
 * is work thrown away. 500 is ≥ 2.5× the largest legal `limit`, so the cap can
 * only bite entries that would have been sliced off anyway — and when it bites,
 * `truncated` says so. (Precedent: TRACE_CAP in merge-phase.service.)
 */
const ARM_CAP = 500;

/**
 * Cross-source tiebreak for entries sharing an instant. Arbitrary but FIXED:
 * the point is that two renders of the same data produce the same order, so
 * React keys and scroll position do not thrash across a refetch.
 */
const SOURCE_RANK: Record<TrainTraceSource, number> = { phase: 0, audit: 1, entity: 2 };

/**
 * audit_log action → trace kind. A TOTAL Record over AuditAction, so adding an
 * audit action anywhere in the system fails THIS build until someone decides
 * whether the merge train should narrate it. `null` = deliberately excluded.
 */
export const AUDIT_ACTION_KIND: Record<AuditAction, TrainTraceKind | null> = {
  pause: "paused",
  resume: "resumed",
  force_release_lock: "lock_force_released",
  force_land: "force_landed",
  force_reject: "force_rejected",
  force_cancel: "force_cancelled",
  land: "landed",
  reject: "rejected",
  requeue: "requeued",
  cancel: "cancelled",
  // Not train events: a work-item claim takeover and the claim-lease sweep.
  // They target tasks/epics/proposals and belong to the claims surface.
  force_claim: null,
  claim_reclaimed: null,
  outer_converted: "outer_converted",
  outer_gitlink_normalized: "outer_gitlink_normalized",
};

/**
 * merge_request_groups.state → trace kind, TOTAL over MergeGroupState. Only the
 * three terminal states produce an entry: a group's START is its first member
 * PICKUP (which carries a timestamp) rather than the `integrating` flip (which
 * does not).
 */
export const GROUP_STATE_KIND: Record<MergeGroupState, TrainTraceKind | null> = {
  forming: null,
  integrating: null,
  landed: "group_landed",
  rejected: "group_rejected",
  partially_landed: "group_partially_landed",
};

/**
 * The admin break-glass actions (design §4.3) — exactly the set that sets
 * `overridden`. A self-service `cancel` is not one of them; a `force_cancel` is.
 */
const BREAK_GLASS_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  "pause",
  "resume",
  "force_release_lock",
  "force_land",
  "force_reject",
  "force_cancel",
]);

/** The audit actions this feed narrates at all (the non-null half of the map). */
const NARRATED_ACTIONS = (Object.keys(AUDIT_ACTION_KIND) as AuditAction[]).filter(
  (action) => AUDIT_ACTION_KIND[action] !== null,
);

/**
 * The kinds no lookup table produces — the ones the entity arms mint directly.
 * Exported beside the two maps so `tests/services/train-trace.test.ts` can
 * assert the partition is TOTAL (every kind has exactly one producer) and
 * DISJOINT (no kind has two), which is the half of the contract a
 * `Record<…, TrainTraceKind | null>` cannot check at compile time.
 */
export const ENTITY_ARM_KINDS: readonly TrainTraceKind[] = [
  "phase",
  "picked_up",
  "group_started",
  "incident_opened",
];

/**
 * The natural (integrator-written) member outcomes a group entry already
 * accounts for. A 2-member group land writes TWO `land` audit rows, one per
 * member, and a group reject writes one per affected member — rendering those
 * would repeat the group's own entry N times, and the Discord feed makes the
 * same call (a grouped member's land is un-narrated; the ONE group line names
 * every member). The force_* twins are deliberately NOT here: a break-glass act
 * on a member is a separate human decision carrying its own reason, and
 * force-landing the last stuck member of an ALREADY-terminal partially-landed
 * group is covered by no group entry at all.
 */
const COLLAPSED_MEMBER_KINDS: ReadonlySet<TrainTraceKind> = new Set<TrainTraceKind>([
  "landed",
  "rejected",
]);

/** Kinds that END a trip, and so carry a since-pickup age. */
const OUTCOME_KINDS: ReadonlySet<TrainTraceKind> = new Set<TrainTraceKind>([
  "landed",
  "rejected",
  "cancelled",
  "force_landed",
  "force_rejected",
  "force_cancelled",
]);

/**
 * Sentinel for "this entry's lane is whatever its subject's lane is". The audit
 * arm cannot know a merge_request row's resource without a join, so it defers
 * to the naming pass, which has already loaded that row. An arm that knows its
 * own lane never emits this (a real resource is `.min(1)` everywhere).
 */
const LANE_UNKNOWN = "";

/**
 * "This event has no anchored duration." A real member of the elapsed union
 * rather than a null, so the renderer's exhaustive switch must handle it — and
 * so that "no duration" carries no `ms` field to accidentally read as 0. See
 * @pm/shared schemas/train-trace.ts for the generator scar that also forces it.
 */
const NO_ELAPSED: TrainTraceElapsed = { basis: "none" };

// ─── Public arg / result types ────────────────────────────────────

export interface ListArgs {
  resource: string;
  /** ISO lower bound; defaults to 24h before now. */
  since?: string | null;
  /** Max entries returned. Clamped by the route (default 50, max 200). */
  limit: number;
}

export interface ListResult {
  entries: TrainTraceEntry[];
  from: string;
  to: string;
  truncated: boolean;
}

// ─── Small helpers ────────────────────────────────────────────────

function ensureProjectExists(projectId: string): void {
  const project = getDb()
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }
}

function shortSha(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.length > 12 ? value.slice(0, 8) : value;
}

function readString(bag: Record<string, unknown> | null, key: string): string | null {
  if (!bag) return null;
  const value = bag[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The ISO instant `ms` after `iso`, or null when either input is unusable. */
function isoPlus(iso: string, ms: number): string | null {
  const base = Date.parse(iso);
  if (!Number.isFinite(base)) return null;
  return new Date(base + ms).toISOString();
}

/**
 * `since_pickup` for an instant that ends a trip: how long after the train
 * picked the work up the outcome arrived. Null — never zero — when there is no
 * pickup to anchor on (a request cancelled while still queued) or when the
 * clocks disagree, because a fabricated 0 would read as "landed instantly".
 */
function sincePickup(pickedUpAt: string | null, at: string): TrainTraceElapsed {
  if (pickedUpAt === null) return NO_ELAPSED;
  const start = Date.parse(pickedUpAt);
  const end = Date.parse(at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return NO_ELAPSED;
  return { basis: "since_pickup", ms: end - start };
}

/** A derived queue_wait/forming entry → the matching elapsed union member. */
function derivedElapsed(
  basis: "queue_wait" | "forming",
  entry: DerivedPhaseEntry | undefined,
): TrainTraceElapsed {
  if (!entry) return NO_ELAPSED;
  return {
    basis,
    ms: entry.durationMs,
    sinceSubmitMs: entry.originDurationMs,
    requeued: entry.basis === "requeued",
  };
}

// ─── Naming (subject resolution) ──────────────────────────────────

interface RequestNameRow {
  id: string;
  taskId: string | null;
  branch: string | null;
  synthetic: boolean;
  groupId: string | null;
  resource: string;
  pickedUpAt: string | null;
}

const REQUEST_NAME_COLUMNS = {
  id: mergeRequests.id,
  taskId: mergeRequests.taskId,
  branch: mergeRequests.branch,
  synthetic: mergeRequests.synthetic,
  groupId: mergeRequests.groupId,
  resource: mergeRequests.resource,
  pickedUpAt: mergeRequests.pickedUpAt,
};

/**
 * Everything the feed needs to name its subjects, loaded in four batched
 * queries rather than per entry. This is one of the reasons the partition is
 * computed server-side at all: in a browser it is an N+1 per row.
 */
interface Naming {
  requests: Map<string, RequestNameRow>;
  requestName: (id: string) => string;
  groupName: (id: string) => string;
  actor: (id: string | null) => { id: string; name: string } | null;
}

function loadNaming(requestIds: Set<string>, groupIds: Set<string>, actorIds: Set<string>): Naming {
  const db = getDb();

  const members =
    groupIds.size === 0
      ? []
      : (db
          .select(REQUEST_NAME_COLUMNS)
          .from(mergeRequests)
          .where(inArray(mergeRequests.groupId, [...groupIds]))
          .all() as RequestNameRow[]);

  const loaded = new Set(members.map((m) => m.id));
  const missing = [...requestIds].filter((id) => !loaded.has(id));
  const direct =
    missing.length === 0
      ? []
      : (db
          .select(REQUEST_NAME_COLUMNS)
          .from(mergeRequests)
          .where(inArray(mergeRequests.id, missing))
          .all() as RequestNameRow[]);

  const requests = new Map<string, RequestNameRow>();
  for (const row of [...members, ...direct]) requests.set(row.id, row);

  const taskIds = [
    ...new Set([...requests.values()].map((r) => r.taskId).filter((t): t is string => t !== null)),
  ];
  const titles = new Map<string, string>();
  if (taskIds.length > 0) {
    for (const row of db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(inArray(tasks.id, taskIds))
      .all()) {
      titles.set(row.id, row.title);
    }
  }

  const actors = new Map<string, string>();
  if (actorIds.size > 0) {
    for (const row of db
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(inArray(users.id, [...actorIds]))
      .all()) {
      actors.set(row.id, row.name);
    }
  }

  /**
   * A merge request has no name of its own, so name it by the work it carries:
   * the linked task's title, then the branch, then "(removed)". A deleted task
   * SET NULLs task_id, so that chain degrades instead of throwing. A synthetic
   * member (inner-only / lone-outer groups) has neither by construction and is
   * named for what it is rather than reported as removed.
   */
  const requestName = (id: string): string => {
    const row = requests.get(id);
    if (!row) return "(removed)";
    if (row.synthetic) return "synthetic member";
    const title = row.taskId === null ? null : (titles.get(row.taskId) ?? null);
    return title ?? row.branch ?? "(removed)";
  };

  const membersByGroup = new Map<string, RequestNameRow[]>();
  for (const member of members) {
    if (member.groupId === null) continue;
    const list = membersByGroup.get(member.groupId);
    if (list) list.push(member);
    else membersByGroup.set(member.groupId, [member]);
  }

  /** A group is named by its REAL members' work (the Discord feed's rule). */
  const groupName = (id: string): string => {
    const all = membersByGroup.get(id) ?? [];
    const real = all.filter((m) => !m.synthetic);
    const pool = real.length > 0 ? real : all;
    if (pool.length === 0) return "(removed)";
    const named = pool.slice(0, 2).map((m) => requestName(m.id));
    const more = pool.length - named.length;
    return more > 0 ? `${named.join(" + ")} +${more} more` : named.join(" + ");
  };

  const actor = (id: string | null): { id: string; name: string } | null =>
    id === null ? null : { id, name: actors.get(id) ?? "(unknown)" };

  return { requests, requestName, groupName, actor };
}

// ─── Arm collection (pre-naming) ──────────────────────────────────

/**
 * An entry whose subject is not yet named. Split from the wire shape so every
 * arm is a plain projection and naming stays ONE batched pass.
 */
interface PendingEntry {
  id: string;
  source: TrainTraceSource;
  kind: TrainTraceKind;
  at: string;
  resource: string;
  phase: MergePhase | null;
  label: string | null;
  subjectType: TrainTraceSubjectType;
  subjectId: string;
  /** Pre-resolved name for a subject the naming pass cannot look up. */
  subjectName: string | null;
  actorId: string | null;
  reason: string | null;
  overridden: boolean;
  detail: string | null;
  elapsed: TrainTraceElapsed;
}

interface ArmResult {
  pending: PendingEntry[];
  capped: boolean;
}

// ─── The read ─────────────────────────────────────────────────────

/**
 * The lane's recent-event feed, newest first.
 *
 * ORDERING is `(at DESC, sourceRank ASC, id DESC)`. ULIDs make `id DESC`
 * time-ordered within a source, and sourceRank makes cross-source ties
 * deterministic — a feed whose row order flickers between polls is a feed whose
 * React keys thrash.
 *
 * NO OFFSET PAGING, deliberately: an offset over a merged, live-invalidated feed
 * both duplicates and drops rows as new entries push the window along. The
 * result shape admits a keyset `before=(at, source, id)` cursor if browsable
 * history is ever wanted here — but the audit log already IS that surface, and
 * this one is deliberately lossy.
 *
 * No `actor` parameter: nothing in the projection depends on WHO is reading (see
 * `reason` on the entry schema — it is carried verbatim, matching the per-request
 * timeline any authenticated user can already read). Authz is the route's.
 */
export function list(projectId: string, args: ListArgs): ListResult {
  ensureProjectExists(projectId);

  const to = new Date().toISOString();
  const from = args.since ?? new Date(Date.parse(to) - DEFAULT_WINDOW_MS).toISOString();
  const resource = args.resource;

  const arms = [
    collectPhases(projectId, resource, from, to),
    collectAudit(projectId, resource, from, to),
    collectPickups(projectId, resource, from, to),
    collectGroupStarts(projectId, resource, from, to),
    collectGroupOutcomes(projectId, resource, from, to),
    collectIncidents(projectId, resource, from, to),
  ];

  const pending = arms.flatMap((a) => a.pending);
  const capped = arms.some((a) => a.capped);

  // ONE batched naming pass over every subject/actor any arm referenced.
  const requestIds = new Set<string>();
  const groupIds = new Set<string>();
  const actorIds = new Set<string>();
  for (const entry of pending) {
    if (entry.subjectType === "request") requestIds.add(entry.subjectId);
    if (entry.subjectType === "group") groupIds.add(entry.subjectId);
    if (entry.actorId !== null) actorIds.add(entry.actorId);
  }
  const naming = loadNaming(requestIds, groupIds, actorIds);

  const entries = pending
    // Two decisions need the request row the naming pass just loaded: is this
    // audit row on THIS lane, and is it a member outcome its group already
    // accounts for. Both are resolved here rather than by an extra query per arm.
    .filter((entry) => keepAfterNaming(entry, naming, resource))
    .map((entry) => toEntry(entry, naming))
    .sort(compareEntries);

  return {
    entries: entries.slice(0, args.limit),
    from,
    to,
    truncated: capped || entries.length > args.limit,
  };
}

function keepAfterNaming(entry: PendingEntry, naming: Naming, resource: string): boolean {
  if (entry.resource !== LANE_UNKNOWN) return true;
  const request = naming.requests.get(entry.subjectId);
  // An audit row whose merge_request no longer exists cannot be placed on a
  // lane, and assuming the queried one would leak another lane's break-glass
  // history into this feed. Drop it; the audit log stays the surface of record.
  if (!request) return false;
  if (request.resource !== resource) return false;
  return !(request.groupId !== null && COLLAPSED_MEMBER_KINDS.has(entry.kind));
}

function toEntry(entry: PendingEntry, naming: Naming): TrainTraceEntry {
  // Only the audit arm defers its lane, and keepAfterNaming has already proved
  // the row exists for every entry that reaches here.
  const request = entry.resource === LANE_UNKNOWN ? naming.requests.get(entry.subjectId)! : null;
  const name =
    entry.subjectName ??
    (entry.subjectType === "request"
      ? naming.requestName(entry.subjectId)
      : entry.subjectType === "group"
        ? naming.groupName(entry.subjectId)
        : entry.subjectId);

  return {
    id: entry.id,
    source: entry.source,
    kind: entry.kind,
    at: entry.at,
    resource: request ? request.resource : entry.resource,
    phase: entry.phase,
    label: entry.label,
    subject: { type: entry.subjectType, id: entry.subjectId, name },
    actor: naming.actor(entry.actorId),
    reason: entry.reason,
    overridden: entry.overridden,
    detail: entry.detail,
    elapsed:
      request && OUTCOME_KINDS.has(entry.kind)
        ? sincePickup(request.pickedUpAt, entry.at)
        : entry.elapsed,
  };
}

function compareEntries(a: TrainTraceEntry, b: TrainTraceEntry): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  const rank = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (rank !== 0) return rank;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// ─── Arm: phase timings ───────────────────────────────────────────

function collectPhases(projectId: string, resource: string, from: string, to: string): ArmResult {
  // WINDOW BY START, ORDER BY END. Membership matches the aggregation's rule
  // ("a sample belongs to the window when its phase STARTED in it", §P3) and
  // uses the indexed column; the entry's `at` is the END, because that is the
  // instant at which "verify took 26m" became a knowable fact. Ordering by
  // start would file a 39-minute verify above everything that happened during it.
  const rows = getDb()
    .select()
    .from(mergePhaseTimings)
    .where(
      and(
        eq(mergePhaseTimings.projectId, projectId),
        eq(mergePhaseTimings.resource, resource),
        gte(mergePhaseTimings.startedAt, from),
        lte(mergePhaseTimings.startedAt, to),
      ),
    )
    .orderBy(desc(mergePhaseTimings.startedAt), desc(mergePhaseTimings.id))
    .limit(ARM_CAP)
    .all();

  const pending: PendingEntry[] = [];
  for (const row of rows) {
    const at = isoPlus(row.startedAt, row.durationMs);
    if (at === null) continue;
    const subject: Pick<PendingEntry, "subjectType" | "subjectId" | "subjectName"> =
      row.requestId !== null
        ? { subjectType: "request", subjectId: row.requestId, subjectName: null }
        : row.groupId !== null
          ? { subjectType: "group", subjectId: row.groupId, subjectName: null }
          : { subjectType: "lane", subjectId: row.resource, subjectName: null };
    pending.push({
      id: `phase:${row.id}`,
      source: "phase",
      kind: "phase",
      at,
      resource: row.resource,
      phase: row.phase as MergePhase,
      label: row.label,
      ...subject,
      actorId: row.recordedBy,
      reason: null,
      overridden: false,
      detail: null,
      elapsed: { basis: "phase", ms: row.durationMs },
    });
  }
  return { pending, capped: rows.length >= ARM_CAP };
}

// ─── Arm: audit log ───────────────────────────────────────────────

function collectAudit(projectId: string, resource: string, from: string, to: string): ArmResult {
  const rows = getDb()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.projectId, projectId),
        gte(auditLog.createdAt, from),
        lte(auditLog.createdAt, to),
        inArray(auditLog.action, NARRATED_ACTIONS),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(ARM_CAP)
    .all();

  const pending: PendingEntry[] = [];
  for (const row of rows) {
    const action = row.action as AuditAction;
    const kind = AUDIT_ACTION_KIND[action];
    // Unreachable — NARRATED_ACTIONS is the SQL filter — but the map is the
    // contract, so honour it rather than assert it away.
    if (kind === null) continue;

    // WHERE A ROW'S LANE COMES FROM, and it is not one column: `train` and
    // `merge_lock` rows carry the RESOURCE ITSELF in target_id (a lane has no
    // row to point at), while `merge_request` / `merge_group` rows must be
    // joined to their subject. Getting this wrong is a lane filter that
    // silently returns another lane's break-glass history.
    let entryResource: string;
    let subjectType: TrainTraceSubjectType;
    if (row.targetType === "train" || row.targetType === "merge_lock") {
      subjectType = "lane";
      entryResource = row.targetId;
      if (entryResource !== resource) continue;
    } else if (row.targetType === "merge_group") {
      subjectType = "group";
      entryResource = LANE_UNKNOWN;
    } else if (row.targetType === "merge_request") {
      subjectType = "request";
      entryResource = LANE_UNKNOWN;
    } else {
      // task/epic/proposal targets — unreachable, their actions map to null.
      continue;
    }

    const after = row.metadataAfter as Record<string, unknown> | null;
    const detail =
      kind === "landed" || kind === "force_landed"
        ? shortSha(after?.landedSha)
        : kind === "rejected" || kind === "force_rejected"
          ? readString(after, "rejectCategory")
          : null;

    pending.push({
      id: `audit:${row.id}`,
      source: "audit",
      kind,
      at: row.createdAt,
      resource: entryResource,
      phase: null,
      label: null,
      subjectType,
      subjectId: row.targetId,
      subjectName: null,
      actorId: row.actorId,
      reason: row.reason,
      overridden: BREAK_GLASS_ACTIONS.has(action),
      detail,
      // A requeue and the two assembly interpretations are MID-TRIP instants:
      // their minutes are accounted once, at the terminal event (the Discord
      // feed makes the same call). Outcome kinds get their since-pickup anchor
      // in the naming pass, where the request row is already loaded.
      elapsed: NO_ELAPSED,
    });
  }

  return { pending: resolveGroupAuditLanes(pending, resource), capped: rows.length >= ARM_CAP };
}

/**
 * Place group-targeted audit rows on their lane. No such row is written today
 * (group land/reject audit rows target each MEMBER), but the audit taxonomy
 * allows targetType `merge_group`, and the alternative to handling it is a row
 * that silently disappears the day someone starts writing one.
 */
function resolveGroupAuditLanes(pending: PendingEntry[], resource: string): PendingEntry[] {
  const deferred = pending.filter((e) => e.subjectType === "group" && e.resource === LANE_UNKNOWN);
  if (deferred.length === 0) return pending;

  const lanes = new Map<string, string>();
  for (const row of getDb()
    .select({ id: mergeRequestGroups.id, resource: mergeRequestGroups.resource })
    .from(mergeRequestGroups)
    .where(inArray(mergeRequestGroups.id, [...new Set(deferred.map((e) => e.subjectId))]))
    .all()) {
    lanes.set(row.id, row.resource);
  }

  return pending.flatMap((entry) => {
    if (entry.subjectType !== "group" || entry.resource !== LANE_UNKNOWN) return [entry];
    const lane = lanes.get(entry.subjectId);
    return lane === resource ? [{ ...entry, resource: lane }] : [];
  });
}

// ─── Arm: pickups (entity) ────────────────────────────────────────

function collectPickups(projectId: string, resource: string, from: string, to: string): ArmResult {
  // SOURCED FROM merge_requests.picked_up_at, which a re-queue NULLS — so this
  // arm reports each request's CURRENT pickup, and a repeat pickup has
  // overwritten its predecessor. The endpoint description says so plainly
  // rather than implying a completeness the column cannot give; buying the
  // historical pickups back would mean reinstating the event-log arm this
  // design removed for the reasons at the top of the file.
  const rows = getDb()
    .select({
      id: mergeRequests.id,
      groupId: mergeRequests.groupId,
      pickedUpAt: mergeRequests.pickedUpAt,
    })
    .from(mergeRequests)
    .where(
      and(
        eq(mergeRequests.projectId, projectId),
        eq(mergeRequests.resource, resource),
        isNotNull(mergeRequests.pickedUpAt),
        gte(mergeRequests.pickedUpAt, from),
        lte(mergeRequests.pickedUpAt, to),
      ),
    )
    .orderBy(desc(mergeRequests.pickedUpAt), desc(mergeRequests.id))
    .limit(ARM_CAP)
    .all();

  // A grouped member's pickup is announced ONCE, by its group — the same rule
  // the Discord feed applies on MERGE_REQUEST_INTEGRATING (`if (e.groupId)
  // return null`).
  const solo = rows.filter((r) => r.groupId === null);
  const queueWaits = mergePhaseService.queueWaitsForRequests(solo.map((r) => r.id));

  return {
    pending: solo.map((row) => ({
      id: `entity:picked_up:${row.id}`,
      source: "entity" as const,
      kind: "picked_up" as const,
      at: row.pickedUpAt!,
      resource,
      phase: null,
      label: null,
      subjectType: "request" as const,
      subjectId: row.id,
      subjectName: null,
      actorId: null,
      reason: null,
      overridden: false,
      detail: null,
      elapsed: derivedElapsed("queue_wait", queueWaits.get(row.id)),
    })),
    capped: rows.length >= ARM_CAP,
  };
}

// ─── Arm: group starts (entity) ───────────────────────────────────

function collectGroupStarts(
  projectId: string,
  resource: string,
  from: string,
  to: string,
): ArmResult {
  // A group STARTS at its oldest member pickup (train-feed-listener's anchor,
  // and the end of the derived `forming` window).
  const rows = getDb()
    .select({
      id: mergeRequestGroups.id,
      firstPickup: sql<string>`min(${mergeRequests.pickedUpAt})`,
    })
    .from(mergeRequestGroups)
    .innerJoin(mergeRequests, eq(mergeRequests.groupId, mergeRequestGroups.id))
    .where(
      and(
        eq(mergeRequestGroups.projectId, projectId),
        eq(mergeRequestGroups.resource, resource),
        isNotNull(mergeRequests.pickedUpAt),
      ),
    )
    .groupBy(mergeRequestGroups.id)
    .having(
      sql`min(${mergeRequests.pickedUpAt}) >= ${from} and min(${mergeRequests.pickedUpAt}) <= ${to}`,
    )
    .limit(ARM_CAP)
    .all();

  const formings = mergePhaseService.formingForGroups(rows.map((r) => r.id));

  return {
    pending: rows.map((row) => ({
      id: `entity:group_started:${row.id}`,
      source: "entity" as const,
      kind: "group_started" as const,
      at: row.firstPickup,
      resource,
      phase: null,
      label: null,
      subjectType: "group" as const,
      subjectId: row.id,
      subjectName: null,
      actorId: null,
      reason: null,
      overridden: false,
      detail: null,
      elapsed: derivedElapsed("forming", formings.get(row.id)),
    })),
    capped: rows.length >= ARM_CAP,
  };
}

// ─── Arm: group outcomes (entity) ─────────────────────────────────

function collectGroupOutcomes(
  projectId: string,
  resource: string,
  from: string,
  to: string,
): ArmResult {
  // FROM THE GROUP ROW, not from an event mapping — this is the arm that made
  // the activity_log arm unusable. `partially_landed` is a STATE here, so the
  // orphaned-inner case is labelled for what it is; via activity_log it would
  // have arrived as an ordinary MERGE_GROUP_REJECTED and read "group rejected".
  const rows = getDb()
    .select({
      id: mergeRequestGroups.id,
      state: mergeRequestGroups.state,
      resolvedAt: mergeRequestGroups.resolvedAt,
      resolutionReason: mergeRequestGroups.resolutionReason,
      integratorId: mergeRequestGroups.integratorId,
    })
    .from(mergeRequestGroups)
    .where(
      and(
        eq(mergeRequestGroups.projectId, projectId),
        eq(mergeRequestGroups.resource, resource),
        isNotNull(mergeRequestGroups.resolvedAt),
        gte(mergeRequestGroups.resolvedAt, from),
        lte(mergeRequestGroups.resolvedAt, to),
      ),
    )
    .orderBy(desc(mergeRequestGroups.resolvedAt), desc(mergeRequestGroups.id))
    .limit(ARM_CAP)
    .all();

  const terminal = rows.flatMap((row) => {
    const kind = GROUP_STATE_KIND[row.state as MergeGroupState] ?? null;
    return kind === null || row.resolvedAt === null ? [] : [{ ...row, kind, at: row.resolvedAt }];
  });
  const pickups = groupPickups(terminal.map((r) => r.id));

  return {
    pending: terminal.map((row) => ({
      id: `entity:group_outcome:${row.id}`,
      source: "entity" as const,
      kind: row.kind,
      at: row.at,
      resource,
      phase: null,
      label: null,
      subjectType: "group" as const,
      subjectId: row.id,
      subjectName: null,
      actorId: row.integratorId,
      reason: row.resolutionReason,
      overridden: false,
      detail: null,
      // The group's clock starts at its OLDEST member pickup — the same anchor
      // train-feed-listener.groupPickedUpAt uses for the Discord line.
      elapsed: sincePickup(pickups.get(row.id) ?? null, row.at),
    })),
    capped: rows.length >= ARM_CAP,
  };
}

/** Oldest member pickup per group (the group's own start instant). */
function groupPickups(groupIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (groupIds.length === 0) return out;
  for (const row of getDb()
    .select({
      groupId: mergeRequests.groupId,
      firstPickup: sql<string | null>`min(${mergeRequests.pickedUpAt})`,
    })
    .from(mergeRequests)
    .where(inArray(mergeRequests.groupId, groupIds))
    .groupBy(mergeRequests.groupId)
    .all()) {
    if (row.groupId !== null && row.firstPickup !== null) out.set(row.groupId, row.firstPickup);
  }
  return out;
}

// ─── Arm: incidents (entity) ──────────────────────────────────────

function collectIncidents(
  projectId: string,
  resource: string,
  from: string,
  to: string,
): ArmResult {
  // merge_incidents has NO resource column, so the lane is resolved through the
  // group, else the inner member request, else the default lane. Both FKs are
  // ON DELETE SET NULL, so the last fallback only fires for an incident whose
  // group AND inner request are both gone — and an incident is precisely the
  // thing an operator must not lose, so it fails OPEN onto the default lane
  // rather than vanishing from every lane.
  const rows = getDb()
    .select({
      id: mergeIncidents.id,
      type: mergeIncidents.type,
      innerRepo: mergeIncidents.innerRepo,
      orphanedSha: mergeIncidents.orphanedSha,
      openedAt: mergeIncidents.openedAt,
      groupResource: mergeRequestGroups.resource,
      requestResource: mergeRequests.resource,
    })
    .from(mergeIncidents)
    .leftJoin(mergeRequestGroups, eq(mergeIncidents.groupId, mergeRequestGroups.id))
    .leftJoin(mergeRequests, eq(mergeIncidents.innerRequestId, mergeRequests.id))
    .where(
      and(
        eq(mergeIncidents.projectId, projectId),
        gte(mergeIncidents.openedAt, from),
        lte(mergeIncidents.openedAt, to),
      ),
    )
    .orderBy(desc(mergeIncidents.openedAt), desc(mergeIncidents.id))
    .limit(ARM_CAP)
    .all();

  const pending: PendingEntry[] = [];
  for (const row of rows) {
    const lane = row.groupResource ?? row.requestResource ?? DEFAULT_RESOURCE;
    if (lane !== resource) continue;
    const sha = shortSha(row.orphanedSha);
    pending.push({
      id: `entity:incident_opened:${row.id}`,
      source: "entity",
      kind: "incident_opened",
      at: row.openedAt,
      resource: lane,
      phase: null,
      label: null,
      subjectType: "incident",
      subjectId: row.id,
      // An incident has no task and no branch — name it by the divergence it
      // records, which is the only thing an operator can act on.
      subjectName: sha === null ? row.innerRepo : `${row.innerRepo} @ ${sha}`,
      actorId: null,
      reason: null,
      overridden: false,
      detail: row.type,
      elapsed: NO_ELAPSED,
    });
  }
  return { pending, capped: rows.length >= ARM_CAP };
}
