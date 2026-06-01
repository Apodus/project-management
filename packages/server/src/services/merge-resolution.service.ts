import { and, asc, eq } from "drizzle-orm";
import { createId } from "@pm/shared";
import type {
  MergeEscalationTarget,
  MergeResolutionDetail,
  MergeResolutionView,
} from "@pm/shared";
import { getDb, mergeResolutions, projects } from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";
import type { Actor } from "./merge-request.service.js";

// ═══════════════════════════════════════════════════════════════════
// Phase 7.6 §4/§6/§7 — the resolver-lifecycle service. Clones the
// merge-incident.service.ts shape:
//   - the ai_agent gate lives IN the service (each mutation throws
//     AppError(403, FORBIDDEN) for a non-ai_agent actor — the resolver is
//     integrator-only machinery, like 7.4/7.5);
//   - read + assertCanTransition guards the state machine
//     (pending → resolving → resolved | escalated | failed, §4.3);
//   - the UPDATE runs inside db.transaction, and the SSE event fires AFTER
//     the commit (caller-of-emit responsibility), so a listener always
//     observes the persisted state;
//   - emit() spreads the row + camelCase extras onto `entity` so the
//     additive wire projection in routes/events.ts can pick up
//     resolutionId / originRequestId / resolvedRequestId.
// ═══════════════════════════════════════════════════════════════════

export type { Actor };

// ─── Params ───────────────────────────────────────────────────────

export interface OpenResolutionParams {
  projectId: string;
  resource?: string;
  originRequestId: string;
  conflictingFiles?: string[] | null;
}

export interface ResolvedResolutionParams {
  resolvedRequestId: string;
  detail?: MergeResolutionDetail | null;
}

export interface EscalateResolutionParams {
  state?: "escalated" | "failed";
  target: MergeEscalationTarget;
  reason: string;
  detail?: MergeResolutionDetail | null;
}

export interface ListResolutionsParams {
  state?: string;
  resource?: string;
}

// ─── Internal row shape ───────────────────────────────────────────

interface MergeResolutionRow {
  id: string;
  projectId: string;
  resource: string;
  originRequestId: string | null;
  resolvedRequestId: string | null;
  state: string;
  conflictingFiles: string[] | null;
  attemptStartedAt: string | null;
  attemptEndedAt: string | null;
  escalationTarget: string | null;
  detail: MergeResolutionDetail | null;
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

function readResolution(id: string): MergeResolutionRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(mergeResolutions)
    .where(eq(mergeResolutions.id, id))
    .get();
  return (row as MergeResolutionRow | undefined) ?? null;
}

function readResolutionOrThrow(id: string): MergeResolutionRow {
  const row = readResolution(id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Merge resolution not found: ${id}`);
  }
  return row;
}

function requireIntegrator(actor: Actor, what: string): void {
  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      `Only integrator (ai_agent) users may ${what}.`,
    );
  }
}

/**
 * Event emission helper. Mirrors merge-incident.service.ts:emit — spreads the
 * resolution row + camelCase extras onto `entity` so the SSE wire projection
 * (routes/events.ts) reads resolution_id / origin_request_id /
 * resolved_request_id off one flat object. Always fires AFTER the txn commits
 * (caller responsibility — guarantees a listener sees the persisted state).
 */
function emit(
  event: string,
  row: MergeResolutionRow,
  actorId: string | null,
): void {
  getEventBus().emit(event as never, {
    entity: {
      ...row,
      resolutionId: row.id,
      originRequestId: row.originRequestId,
      ...(row.resolvedRequestId
        ? { resolvedRequestId: row.resolvedRequestId }
        : {}),
      state: row.state,
    },
    entityType: "merge_resolution",
    entityId: row.id,
    projectId: row.projectId,
    actorId,
    timestamp: new Date().toISOString(),
  });
}

// ─── State-machine guard ──────────────────────────────────────────

/**
 * Central resolution transition guard (§4.3):
 *   pending → resolving → resolved | escalated | failed
 *
 *   - start    legal only from "pending"
 *   - resolved legal only from "resolving"
 *   - escalate legal only from "resolving"
 *
 * Any other source state → AppError(409, INVALID_TRANSITION). Unlike the
 * incident machine there is no idempotent-noop terminal here: each op has
 * exactly one legal source.
 */
function assertCanTransition(
  from: string,
  op: "start" | "resolved" | "escalate",
  resolutionId: string,
): void {
  const legalFrom = op === "start" ? "pending" : "resolving";
  if (from !== legalFrom) {
    throw new AppError(
      409,
      "INVALID_TRANSITION",
      `Cannot ${op} merge resolution ${resolutionId} from state "${from}"`,
    );
  }
}

// ─── View projection ──────────────────────────────────────────────

function toView(row: MergeResolutionRow): MergeResolutionView {
  return {
    id: row.id,
    projectId: row.projectId,
    resource: row.resource,
    originRequestId: row.originRequestId,
    resolvedRequestId: row.resolvedRequestId,
    state: row.state as MergeResolutionView["state"],
    conflictingFiles: row.conflictingFiles,
    attemptStartedAt: row.attemptStartedAt,
    attemptEndedAt: row.attemptEndedAt,
    escalationTarget:
      row.escalationTarget as MergeResolutionView["escalationTarget"],
    detail: row.detail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Open a resolution for an origin (conflicting) request — the durable PM
 * record that the integrator hit a textual rebase conflict and (resolver
 * enabled) spun a bounded resolution off-lane (§5.1). State "pending".
 *
 * Authz: integrator (ai_agent) only. Emits MERGE_RESOLUTION_PENDING after
 * the insert commits.
 */
export function open(
  params: OpenResolutionParams,
  actor: Actor,
): MergeResolutionView {
  requireIntegrator(actor, "open a merge resolution");
  ensureProjectExists(params.projectId);

  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();
  const resource = params.resource ?? "main";
  const conflictingFiles = params.conflictingFiles ?? null;

  db.transaction((tx) => {
    tx.insert(mergeResolutions)
      .values({
        id,
        projectId: params.projectId,
        resource,
        originRequestId: params.originRequestId,
        resolvedRequestId: null,
        state: "pending",
        conflictingFiles,
        attemptStartedAt: null,
        attemptEndedAt: null,
        escalationTarget: null,
        detail: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  const row = readResolutionOrThrow(id);
  emit(EVENT_NAMES.MERGE_RESOLUTION_PENDING, row, actor.id);
  return toView(row);
}

/**
 * pending → resolving: the resolver built the worktree and spawned the
 * headless agent (§5.2). Sets attemptStartedAt. Emits MERGE_RESOLUTION_STARTED.
 *
 * Authz: integrator only. Illegal source state → 409.
 */
export function start(id: string, actor: Actor): MergeResolutionView {
  requireIntegrator(actor, "start a merge resolution");
  const row = readResolutionOrThrow(id);
  assertCanTransition(row.state, "start", id);

  const db = getDb();
  const now = new Date().toISOString();

  db.transaction((tx) => {
    tx.update(mergeResolutions)
      .set({ state: "resolving", attemptStartedAt: now, updatedAt: now })
      .where(eq(mergeResolutions.id, id))
      .run();
  });

  const updated = readResolutionOrThrow(id);
  emit(EVENT_NAMES.MERGE_RESOLUTION_STARTED, updated, actor.id);
  return toView(updated);
}

/**
 * resolving → resolved: the resolver produced a clean, locally-verified tree
 * and resubmitted it as a new request (§5.3). Records resolvedRequestId and
 * attemptEndedAt. Emits MERGE_RESOLUTION_SUCCEEDED.
 *
 * `resolved` is NOT terminal-happy on its own — the resolved request still
 * has to pass the real verify gate and land on the train (§4.3).
 *
 * Authz: integrator only. Illegal source state → 409.
 */
export function resolved(
  id: string,
  params: ResolvedResolutionParams,
  actor: Actor,
): MergeResolutionView {
  requireIntegrator(actor, "record a resolved merge resolution");
  const row = readResolutionOrThrow(id);
  assertCanTransition(row.state, "resolved", id);

  const db = getDb();
  const now = new Date().toISOString();
  const detail = params.detail ?? row.detail ?? null;

  db.transaction((tx) => {
    tx.update(mergeResolutions)
      .set({
        state: "resolved",
        resolvedRequestId: params.resolvedRequestId,
        attemptEndedAt: now,
        detail,
        updatedAt: now,
      })
      .where(eq(mergeResolutions.id, id))
      .run();
  });

  const updated = readResolutionOrThrow(id);
  emit(EVENT_NAMES.MERGE_RESOLUTION_SUCCEEDED, updated, actor.id);
  return toView(updated);
}

/**
 * resolving → escalated | failed: the resolver couldn't land a clean tree.
 *   - "escalated": verify-fail / budget / the agent reports it can't (§5.4).
 *   - "failed": infra error (worktree/spawn/PM I/O) — escalates too, but
 *     tagged distinctly so operators can tell "model couldn't" from "the
 *     resolver itself broke" (§4.3).
 *
 * Sets escalationTarget, attemptEndedAt, and detail.escalationReason. Emits
 * MERGE_RESOLUTION_FAILED when state === "failed", else
 * MERGE_RESOLUTION_ESCALATED.
 *
 * Authz: integrator only. Illegal source state → 409.
 */
export function escalate(
  id: string,
  params: EscalateResolutionParams,
  actor: Actor,
): MergeResolutionView {
  requireIntegrator(actor, "escalate a merge resolution");
  const row = readResolutionOrThrow(id);
  assertCanTransition(row.state, "escalate", id);

  const state = params.state ?? "escalated";
  const db = getDb();
  const now = new Date().toISOString();
  const detail: MergeResolutionDetail = {
    ...(row.detail ?? {}),
    ...(params.detail ?? {}),
    escalationReason: params.reason,
  };

  db.transaction((tx) => {
    tx.update(mergeResolutions)
      .set({
        state,
        escalationTarget: params.target,
        attemptEndedAt: now,
        detail,
        updatedAt: now,
      })
      .where(eq(mergeResolutions.id, id))
      .run();
  });

  const updated = readResolutionOrThrow(id);
  emit(
    state === "failed"
      ? EVENT_NAMES.MERGE_RESOLUTION_FAILED
      : EVENT_NAMES.MERGE_RESOLUTION_ESCALATED,
    updated,
    actor.id,
  );
  return toView(updated);
}

/**
 * Get a resolution by id. 404 if missing.
 */
export function getById(id: string): MergeResolutionView {
  return toView(readResolutionOrThrow(id));
}

/**
 * List resolutions for a project, optionally filtered by state/resource,
 * ordered by createdAt asc (oldest-first — the resolver-pickup sweep order).
 * 404 if the project is missing.
 */
export function list(
  projectId: string,
  params: ListResolutionsParams = {},
): MergeResolutionView[] {
  ensureProjectExists(projectId);
  const db = getDb();

  const conditions = [eq(mergeResolutions.projectId, projectId)];
  if (params.state) conditions.push(eq(mergeResolutions.state, params.state));
  if (params.resource) {
    conditions.push(eq(mergeResolutions.resource, params.resource));
  }

  const rows = db
    .select()
    .from(mergeResolutions)
    .where(and(...conditions))
    .orderBy(asc(mergeResolutions.createdAt))
    .all() as MergeResolutionRow[];

  return rows.map(toView);
}

/**
 * List the resolutions spawned off a given origin request, oldest-first
 * (Phase 7.6 §7). Read-only lineage helper used by the per-request timeline
 * weave (merge-request.service.ts:getTimeline) — the origin branch. Mirrors
 * list() but keys on the indexed origin_request_id column
 * (idx_merge_resolutions_origin), so it is project-agnostic by design (the
 * origin id uniquely scopes the lane). Empty for a request that never
 * conflicted under an enabled resolver.
 */
export function listByOriginRequest(
  originRequestId: string,
): MergeResolutionView[] {
  const db = getDb();
  const rows = db
    .select()
    .from(mergeResolutions)
    .where(eq(mergeResolutions.originRequestId, originRequestId))
    .orderBy(asc(mergeResolutions.createdAt))
    .all() as MergeResolutionRow[];

  return rows.map(toView);
}
