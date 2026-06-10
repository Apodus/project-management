import { and, asc, eq } from "drizzle-orm";
import { createId } from "@pm/shared";
import type {
  MergeIncidentResolution,
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

export interface ResolveIncidentParams {
  mode: "auto_rollforward" | "human";
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

function readIncident(id: string): MergeIncidentRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(mergeIncidents)
    .where(eq(mergeIncidents.id, id))
    .get();
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
 * Open an orphaned-inner incident — the durable PM record that inner main
 * landed at `orphanedSha` but the outer gitlink was NOT updated (§6.5 / §4.3).
 *
 * Authz: integrator (actor.type === "ai_agent").
 *
 * Side effects (atomic — §4.3, mirrors 7.1's merge_rejection comment):
 *   1. INSERT the merge_incidents row at state "open".
 *   2. If taskId !== null: INSERT a comments row (commentType "merge_incident",
 *      templated body, structured metadata) — the "detectable from PM alone"
 *      surfacing, committed in the SAME txn as the incident row.
 *
 * Event MERGE_INCIDENT_OPENED emits AFTER the txn commits (§10).
 */
export function openIncident(
  params: OpenIncidentParams,
  actor: Actor,
): MergeIncidentView {
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

  db.transaction((tx) => {
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
      const commentBody =
        `Orphaned inner: ${params.innerRepo}@${params.orphanedSha} landed but ` +
        `${params.outerRepo} gitlink was not updated. Awaiting auto-rollforward ` +
        `on the next group integration, or human resolution.`;
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
  return toView(row);
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
 * This is the Step-12 recovery query: `state="open"` + `type="orphaned_inner"`
 * + openedAt asc hits idx_merge_incidents_open (§4.1, §7.2) — the oldest-first
 * sweep order is load-bearing.
 */
export function list(
  projectId: string,
  params: ListIncidentsParams = {},
): MergeIncidentView[] {
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
 * Resolve an incident — open → auto_resolved (auto-rollforward, §7) OR
 * open → human_resolved (manual, §7.5).
 *
 * Authz is SPLIT (pinned, §4.2): the asymmetry is deliberate.
 *   - auto_rollforward requires actor.type === "ai_agent" (the integrator
 *     recovery path); a human admin CANNOT auto-resolve.
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
  if (params.mode === "auto_rollforward") {
    if (actor.type !== "ai_agent") {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only integrator (ai_agent) users may auto-resolve a merge incident.",
      );
    }
  } else {
    if (actor.role !== "admin") {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only admins may human-resolve a merge incident.",
      );
    }
  }

  const row = readIncidentOrThrow(id);
  const op = params.mode === "auto_rollforward" ? "resolveAuto" : "resolveHuman";
  const result = assertCanTransition(row.state, op, id);
  if (result.kind === "idempotent_noop") {
    return toView(row);
  }

  const terminal =
    params.mode === "auto_rollforward" ? "auto_resolved" : "human_resolved";
  const resolution: MergeIncidentResolution = {
    mode: params.mode,
    ...(params.outerLandedSha ? { outerLandedSha: params.outerLandedSha } : {}),
    ...(params.resolvedByGroupId
      ? { resolvedByGroupId: params.resolvedByGroupId }
      : {}),
    ...(params.note ? { note: params.note } : {}),
  };

  const db = getDb();
  const now = new Date().toISOString();

  db.transaction((tx) => {
    applyResolveInTx(tx, row, terminal, resolution, params, actor.id, now);
  });

  const updated = readIncidentOrThrow(id);
  if (params.mode === "auto_rollforward") {
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
      ...(params.outerLandedSha
        ? { outerLandedSha: params.outerLandedSha }
        : {}),
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
type TxHandle = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

/**
 * The minimal incident-row shape the tx-internal resolve needs. A full
 * `merge_incidents` row (read inside the caller's tx) satisfies it.
 */
export interface ResolvableIncidentRow {
  id: string;
  groupId: string | null;
  taskId: string | null;
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
    const commentBody =
      `Incident resolved (${params.mode}): ${row.outerRepo} gitlink now at ` +
      `${params.outerLandedSha ?? "(unspecified)"}.`;
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
          mode: params.mode,
          ...(params.outerLandedSha
            ? { outerLandedSha: params.outerLandedSha }
            : {}),
          ...(params.resolvedByGroupId
            ? { resolvedByGroupId: params.resolvedByGroupId }
            : {}),
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
    ...(params.resolvedByGroupId
      ? { resolvedByGroupId: params.resolvedByGroupId }
      : {}),
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
