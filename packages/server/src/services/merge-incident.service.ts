import { and, asc, eq, isNull } from "drizzle-orm";
import { createId, MERGE_INCIDENT_TYPE_INFO, mergeIncidentTypeInfo } from "@pm/shared";
import type {
  MergeIncidentResolution,
  MergeIncidentResolutionMode,
  MergeIncidentType,
  MergeIncidentView,
} from "@pm/shared";
import { comments, getDb, mergeIncidents, projects } from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";
import type { Actor } from "./merge-request.service.js";

// ─── Types ────────────────────────────────────────────────────────

export type { Actor };

export interface OpenIncidentParams {
  projectId: string;
  groupId?: string | null;
  type: MergeIncidentType;
  innerRepo: string;
  orphanedSha: string;
  outerRepo: string;
  innerRequestId?: string | null;
  taskId?: string | null;
}

export interface ListIncidentsParams {
  state?: string;
  type?: string;
  groupId?: string;
}

export interface OpenIncidentResult {
  incident: MergeIncidentView;
  /**
   * False when an identical OPEN incident already existed and was reused. The
   * integrator uses it to log "already open" instead of re-announcing an
   * opening on every gate pass of a blocked lane.
   */
  created: boolean;
}

export interface ResolveIncidentParams {
  mode: MergeIncidentResolutionMode;
  outerLandedSha?: string;
  resolvedByGroupId?: string;
  note?: string;
}

// ─── Internal row shape ───────────────────────────────────────────

interface MergeIncidentRow {
  id: string;
  projectId: string;
  groupId: string | null;
  type: string;
  innerRepo: string;
  orphanedSha: string;
  outerRepo: string;
  innerRequestId: string | null;
  taskId: string | null;
  state: string;
  openedAt: string;
  resolvedAt: string | null;
  resolution: MergeIncidentResolution | null;
  createdAt: string;
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
 * Both auto modes (`auto_rollforward` = the train applied a cure,
 * `auto_observed` = the train observed one it did not apply) are ai_agent-gated
 * and terminate at `auto_resolved`. One predicate so the four mode comparisons
 * in resolve() cannot drift apart.
 */
function isAutoMode(mode: MergeIncidentResolutionMode): boolean {
  return mode === "auto_rollforward" || mode === "auto_observed";
}

function readIncident(id: string): MergeIncidentRow | null {
  const db = getDb();
  const row = db.select().from(mergeIncidents).where(eq(mergeIncidents.id, id)).get();
  return (row as MergeIncidentRow | undefined) ?? null;
}

function readIncidentOrThrow(id: string): MergeIncidentRow {
  const row = readIncident(id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Merge incident not found: ${id}`);
  }
  return row;
}

/**
 * Event emission helper. Mirrors merge-group.service.ts:emit — spreads the
 * incident row + extras onto `entity` so downstream SSE consumers see one flat
 * object. Always fires AFTER the txn commits (caller responsibility).
 */
function emit(
  event: string,
  row: MergeIncidentRow,
  actorId: string | null,
  extra?: Record<string, unknown>,
): void {
  getEventBus().emit(event as never, {
    entity: { ...row, ...(extra ?? {}) },
    entityType: "merge_incident",
    entityId: row.id,
    projectId: row.projectId,
    actorId,
    timestamp: new Date().toISOString(),
  });
}

// ─── State-machine guard ──────────────────────────────────────────

/**
 * Central incident transition guard. Mirrors merge-group.service.ts:
 * assertCanTransition — returns one of:
 *   { kind: "proceed" }         — caller should do the UPDATE.
 *   { kind: "idempotent_noop" } — caller should return the row as-is.
 *   throws AppError(409, INVALID_TRANSITION) — illegal transition.
 *
 * The incident state machine in docs/design/phase-7.3-design.md §4.2 is the
 * authoritative spec:
 *   open → auto_resolved | human_resolved
 * Both resolve ops are legal only from "open". A same-terminal resolve is an
 * idempotent noop (resolveAuto on auto_resolved, resolveHuman on
 * human_resolved); cross-terminal or any other → 409.
 */
type TransitionResult = { kind: "proceed" } | { kind: "idempotent_noop" };

function assertCanTransition(
  from: string,
  op: "resolveAuto" | "resolveHuman",
  incidentId: string,
): TransitionResult {
  switch (op) {
    case "resolveAuto":
      // Recovery rollforward: open → auto_resolved. auto_resolved is
      // idempotent; human_resolved (cross-terminal) → 409 (§4.2).
      if (from === "open") return { kind: "proceed" };
      if (from === "auto_resolved") return { kind: "idempotent_noop" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot auto-resolve merge incident ${incidentId} from state "${from}"`,
      );
    case "resolveHuman":
      // Human resolution: open → human_resolved. human_resolved is
      // idempotent; auto_resolved (cross-terminal) → 409 (§4.2).
      if (from === "open") return { kind: "proceed" };
      if (from === "human_resolved") return { kind: "idempotent_noop" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot human-resolve merge incident ${incidentId} from state "${from}"`,
      );
  }
}

// ─── View projection ──────────────────────────────────────────────

function toView(row: MergeIncidentRow): MergeIncidentView {
  return {
    id: row.id,
    projectId: row.projectId,
    groupId: row.groupId,
    type: row.type as MergeIncidentView["type"],
    innerRepo: row.innerRepo,
    orphanedSha: row.orphanedSha,
    outerRepo: row.outerRepo,
    innerRequestId: row.innerRequestId,
    taskId: row.taskId,
    state: row.state as MergeIncidentView["state"],
    openedAt: row.openedAt,
    resolvedAt: row.resolvedAt,
    resolution: row.resolution,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Open a merge incident — the durable PM record that the inner/outer gitlink
 * invariant is broken on main, in whichever direction `params.type` names
 * (§6.5 / §4.3; the per-type wording lives in @pm/shared's
 * MERGE_INCIDENT_TYPE_INFO).
 *
 * Authz: integrator (actor.type === "ai_agent").
 *
 * IDEMPOTENT. A blocked lane re-evaluates its gate on every pass, so this
 * DEDUPS against OPEN incidents on
 * (projectId, type, innerRepo, outerRepo, orphanedSha, groupId) and returns
 * `created: false` with the existing row — no second INSERT, no second comment,
 * no second event. Notes on that key:
 *   - merge_incidents has no `resource` column (see train-trace.service.ts,
 *     which resolves a lane through the group/request FKs instead), so
 *     innerRepo + outerRepo IS the lane's repo pair and the faithful stand-in.
 *   - groupId participates so orphaned_inner is preserved byte-for-byte: two
 *     groups orphaning the same SHA stay two incidents, each with its own
 *     meaningful group link. Lane-scoped types carry groupId null and collapse.
 *   - OPEN-ONLY. A recurrence after a cure opens a FRESH incident; a resolved
 *     incident is a closed fact and is never revived.
 *   - The SELECT and the INSERT share one transaction and better-sqlite3 is
 *     synchronous in a single-process server, so concurrent integrator passes
 *     cannot race. (Several server processes over one DB file is outside this
 *     system's design and is not defended here.)
 *
 * Side effects when it does create (atomic — §4.3, mirrors 7.1's
 * merge_rejection comment):
 *   1. INSERT the merge_incidents row at state "open".
 *   2. If taskId !== null: INSERT a comments row (commentType "merge_incident",
 *      templated body, structured metadata) — the "detectable from PM alone"
 *      surfacing, committed in the SAME txn as the incident row.
 *
 * Event MERGE_INCIDENT_OPENED emits AFTER the txn commits (§10), and only on a
 * real create.
 */
export function openIncident(params: OpenIncidentParams, actor: Actor): OpenIncidentResult {
  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only integrator (ai_agent) users may open a merge incident.",
    );
  }

  ensureProjectExists(params.projectId);

  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();
  const groupId = params.groupId ?? null;
  const innerRequestId = params.innerRequestId ?? null;
  const taskId = params.taskId ?? null;
  let commentId: string | null = null;
  let existingId: string | null = null;

  db.transaction((tx) => {
    const existing = tx
      .select({ id: mergeIncidents.id })
      .from(mergeIncidents)
      .where(
        and(
          eq(mergeIncidents.projectId, params.projectId),
          eq(mergeIncidents.type, params.type),
          eq(mergeIncidents.innerRepo, params.innerRepo),
          eq(mergeIncidents.outerRepo, params.outerRepo),
          eq(mergeIncidents.orphanedSha, params.orphanedSha),
          groupId === null ? isNull(mergeIncidents.groupId) : eq(mergeIncidents.groupId, groupId),
          eq(mergeIncidents.state, "open"),
        ),
      )
      .get();
    if (existing) {
      existingId = existing.id;
      return;
    }

    tx.insert(mergeIncidents)
      .values({
        id,
        projectId: params.projectId,
        groupId,
        type: params.type,
        innerRepo: params.innerRepo,
        orphanedSha: params.orphanedSha,
        outerRepo: params.outerRepo,
        innerRequestId,
        taskId,
        state: "open",
        openedAt: now,
        resolvedAt: null,
        resolution: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    if (taskId !== null) {
      commentId = createId();
      const info = MERGE_INCIDENT_TYPE_INFO[params.type];
      const commentBody =
        `${info.summary({
          innerRepo: params.innerRepo,
          outerRepo: params.outerRepo,
          sha: params.orphanedSha,
        })} ` +
        (info.curedBy === "train"
          ? "Awaiting auto-rollforward on the next group integration, or human resolution."
          : "A human must decide; the train detects this and will not pick a cure.");
      tx.insert(comments)
        .values({
          id: commentId,
          taskId,
          proposalId: null,
          authorId: actor.id,
          body: commentBody,
          commentType: "merge_incident",
          metadata: {
            incidentId: id,
            groupId,
            type: params.type,
            innerRepo: params.innerRepo,
            orphanedSha: params.orphanedSha,
            outerRepo: params.outerRepo,
            innerRequestId,
          },
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  });

  if (existingId !== null) {
    return { incident: toView(readIncidentOrThrow(existingId)), created: false };
  }

  const row = readIncidentOrThrow(id);
  emit(EVENT_NAMES.MERGE_INCIDENT_OPENED, row, actor.id, {
    incidentId: id,
    groupId,
    type: params.type,
    innerRepo: params.innerRepo,
    orphanedSha: params.orphanedSha,
    outerRepo: params.outerRepo,
    innerRequestId,
    taskId,
    commentId,
  });
  return { incident: toView(row), created: true };
}

/**
 * Get an incident by id. 404 if missing.
 */
export function getById(id: string): MergeIncidentView {
  return toView(readIncidentOrThrow(id));
}

/**
 * List incidents for a project, optionally filtered by state/type/groupId,
 * ordered by openedAt asc. 404 if the project is missing.
 *
 * Incidents record the inner/outer gitlink invariant broken in EITHER
 * direction, so a caller that means one direction MUST pass `type` — an
 * unfiltered read of "open incidents" is a read of both.
 *
 * `state` + `type` + openedAt asc hits idx_merge_incidents_open (§4.1, §7.2).
 * For the Step-12 recovery query (`state="open"`, `type="orphaned_inner"`) the
 * oldest-first sweep order is load-bearing.
 */
export function list(projectId: string, params: ListIncidentsParams = {}): MergeIncidentView[] {
  ensureProjectExists(projectId);
  const db = getDb();

  const conditions = [eq(mergeIncidents.projectId, projectId)];
  if (params.state) conditions.push(eq(mergeIncidents.state, params.state));
  if (params.type) conditions.push(eq(mergeIncidents.type, params.type));
  if (params.groupId) {
    conditions.push(eq(mergeIncidents.groupId, params.groupId));
  }

  const rows = db
    .select()
    .from(mergeIncidents)
    .where(and(...conditions))
    .orderBy(asc(mergeIncidents.openedAt))
    .all() as MergeIncidentRow[];

  return rows.map(toView);
}

/**
 * Resolve an incident — open → auto_resolved (either auto mode) OR
 * open → human_resolved (manual, §7.5).
 *
 * The two auto modes differ in WHAT THE TRAIN DID, not in authz or terminal:
 *   - auto_rollforward — the train APPLIED a cure (the §7 follow-up outer land).
 *   - auto_observed    — the train OBSERVED a cure it did not apply: the
 *                        invariant holds again. Design lock 2 — for a dangling
 *                        gitlink only a human cures; recording that as a
 *                        rollforward would narrate a push that never happened.
 *
 * Authz is SPLIT (pinned, §4.2): the asymmetry is deliberate.
 *   - both auto modes require actor.type === "ai_agent" (the integrator);
 *     a human admin CANNOT auto-resolve.
 *   - human requires actor.role === "admin"; an ai_agent CANNOT human-resolve.
 *
 * Side effects (atomic — §4.3):
 *   1. UPDATE state → terminal, resolvedAt, resolution JSON.
 *   2. If taskId !== null: INSERT a follow-up merge_incident comment in the
 *      same txn.
 *
 * Event MERGE_INCIDENT_AUTO_RESOLVED / MERGE_INCIDENT_HUMAN_RESOLVED emits
 * AFTER the txn commits (§10). Same-terminal resolve is an idempotent noop
 * (returns the row, no event).
 */
export function resolve(
  id: string,
  params: ResolveIncidentParams,
  actor: Actor,
): MergeIncidentView {
  const auto = isAutoMode(params.mode);
  if (auto) {
    if (actor.type !== "ai_agent") {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only integrator (ai_agent) users may auto-resolve a merge incident.",
      );
    }
  } else {
    if (actor.role !== "admin") {
      throw new AppError(403, "FORBIDDEN", "Only admins may human-resolve a merge incident.");
    }
  }

  const row = readIncidentOrThrow(id);
  const op = auto ? "resolveAuto" : "resolveHuman";
  const result = assertCanTransition(row.state, op, id);
  if (result.kind === "idempotent_noop") {
    return toView(row);
  }

  const terminal = auto ? "auto_resolved" : "human_resolved";
  const resolution: MergeIncidentResolution = {
    mode: params.mode,
    ...(params.outerLandedSha ? { outerLandedSha: params.outerLandedSha } : {}),
    ...(params.resolvedByGroupId ? { resolvedByGroupId: params.resolvedByGroupId } : {}),
    ...(params.note ? { note: params.note } : {}),
  };

  const db = getDb();
  const now = new Date().toISOString();

  db.transaction((tx) => {
    applyResolveInTx(tx, row, terminal, resolution, params, actor.id, now);
  });

  const updated = readIncidentOrThrow(id);
  if (auto) {
    emit(EVENT_NAMES.MERGE_INCIDENT_AUTO_RESOLVED, updated, actor.id, {
      incidentId: id,
      groupId: updated.groupId,
      outerLandedSha: params.outerLandedSha ?? null,
      resolvedByGroupId: params.resolvedByGroupId ?? null,
    });
  } else {
    emit(EVENT_NAMES.MERGE_INCIDENT_HUMAN_RESOLVED, updated, actor.id, {
      incidentId: id,
      groupId: updated.groupId,
      ...(params.outerLandedSha ? { outerLandedSha: params.outerLandedSha } : {}),
      note: params.note ?? null,
    });
  }
  return toView(updated);
}

// ─── Tx-internal resolve (C2 — shared with train.service.forceLand) ─

/**
 * The tx handle a db.transaction callback receives (same inline pattern as
 * merge-request.service.ts:attachLandedRef / audit.service.ts:record).
 */
type TxHandle = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * The minimal incident-row shape the tx-internal resolve needs. A full
 * `merge_incidents` row (read inside the caller's tx) satisfies it — both
 * callers pass one, so this stays declaration-only. `type` is `string`, not
 * MergeIncidentType, because that is what the DB column is; read it through
 * the total `mergeIncidentTypeInfo()` helper.
 */
export interface ResolvableIncidentRow {
  id: string;
  groupId: string | null;
  taskId: string | null;
  type: string;
  innerRepo: string;
  orphanedSha: string;
  outerRepo: string;
}

/**
 * Shared tx body of resolve(): UPDATE state → terminal + the follow-up
 * merge_incident comment (when the incident has a task). Emits NOTHING — the
 * caller emits after its transaction commits. Extracted byte-identical from
 * resolve(); the caller is responsible for the transition guard (state must
 * be "open").
 */
function applyResolveInTx(
  tx: TxHandle,
  row: ResolvableIncidentRow,
  terminal: "auto_resolved" | "human_resolved",
  resolution: MergeIncidentResolution,
  params: ResolveIncidentParams,
  actorId: string,
  now: string,
): void {
  tx.update(mergeIncidents)
    .set({
      state: terminal,
      resolvedAt: now,
      resolution,
      updatedAt: now,
    })
    .where(eq(mergeIncidents.id, row.id))
    .run();

  if (row.taskId !== null) {
    // Name the incident, then say what the resolution actually DID. The old
    // single sentence claimed "outer gitlink now at <sha>" for every mode,
    // which is false for a cure the train only observed — and it named no
    // incident, so a reader could not tell which direction was resolved.
    const info = mergeIncidentTypeInfo(row.type);
    const modeClause =
      params.mode === "auto_rollforward"
        ? `Outer gitlink now at ${params.outerLandedSha ?? "(unspecified)"}.`
        : params.mode === "auto_observed"
          ? "The invariant holds again; the train observed the cure and applied none."
          : params.outerLandedSha
            ? `Resolved by a human. Outer gitlink now at ${params.outerLandedSha}.`
            : "Resolved by a human.";
    const commentBody =
      `Incident resolved (${params.mode}): ${info?.label ?? row.type} — ` +
      `${row.innerRepo}@${row.orphanedSha} / ${row.outerRepo}. ${modeClause}`;
    tx.insert(comments)
      .values({
        id: createId(),
        taskId: row.taskId,
        proposalId: null,
        authorId: actorId,
        body: commentBody,
        commentType: "merge_incident",
        metadata: {
          incidentId: row.id,
          groupId: row.groupId,
          type: row.type,
          mode: params.mode,
          ...(params.outerLandedSha ? { outerLandedSha: params.outerLandedSha } : {}),
          ...(params.resolvedByGroupId ? { resolvedByGroupId: params.resolvedByGroupId } : {}),
          ...(params.note ? { note: params.note } : {}),
        },
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

/**
 * Tx-internal HUMAN resolve — open → human_resolved INSIDE the caller's
 * transaction (train.service.forceLand resolves a partially-landed group's
 * open incidents atomically with the member's force-land). Non-emitting: the
 * caller MUST emit MERGE_INCIDENT_HUMAN_RESOLVED after commit (use
 * `emitHumanResolved`). The caller is responsible for selecting only OPEN
 * incidents and for authz (forceLand is already admin-gated).
 */
export function resolveHumanInTx(
  tx: TxHandle,
  row: ResolvableIncidentRow,
  params: Omit<ResolveIncidentParams, "mode">,
  actorId: string,
  now: string,
): void {
  const fullParams: ResolveIncidentParams = { ...params, mode: "human" };
  const resolution: MergeIncidentResolution = {
    mode: "human",
    ...(params.outerLandedSha ? { outerLandedSha: params.outerLandedSha } : {}),
    ...(params.resolvedByGroupId ? { resolvedByGroupId: params.resolvedByGroupId } : {}),
    ...(params.note ? { note: params.note } : {}),
  };
  applyResolveInTx(tx, row, "human_resolved", resolution, fullParams, actorId, now);
}

/**
 * Post-commit event half of `resolveHumanInTx`. Re-reads the resolved row and
 * emits MERGE_INCIDENT_HUMAN_RESOLVED with the same extras resolve() uses.
 */
export function emitHumanResolved(
  incidentId: string,
  actorId: string,
  params: Omit<ResolveIncidentParams, "mode">,
): void {
  const updated = readIncidentOrThrow(incidentId);
  emit(EVENT_NAMES.MERGE_INCIDENT_HUMAN_RESOLVED, updated, actorId, {
    incidentId,
    groupId: updated.groupId,
    ...(params.outerLandedSha ? { outerLandedSha: params.outerLandedSha } : {}),
    note: params.note ?? null,
  });
}
