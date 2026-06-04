import { and, asc, desc, eq, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import type {
  MergeAttemptView,
  MergeEscalationTarget,
  MergeRequestLand,
  MergeRequestReject,
  MergeRequestView,
  MergeResolutionDetail,
  VerifyStepResult,
} from "@pm/shared";
import {
  comments,
  getDb,
  gitRefs,
  mergeAttempts,
  mergeRequests,
  projects,
  tasks,
  users,
} from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";
import {
  cancelOpenAttempts,
  emitAttemptCompleted,
} from "./merge-attempt.service.js";
import {
  emitAuditRecorded,
  list as listAudit,
  record as recordAudit,
  type AuditLogView,
} from "./audit.service.js";
import { list as listIncidents } from "./merge-incident.service.js";
import { listByOriginRequest } from "./merge-resolution.service.js";

// ─── Types ────────────────────────────────────────────────────────

/**
 * Caller of a request-level operation. The service makes authorization
 * decisions from `id` + `role` (cancel by submitter vs admin) and from
 * `type` (only ai_agent users may perform integrator-only transitions).
 * Routes are expected to pass the full auth context.
 */
export interface Actor {
  id: string;
  role: string;
  type: string;
}

export interface SubmitParams {
  projectId: string;
  resource?: string;
  submittedBy: string;
  taskId?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  verifyCmd?: string | null;
  worktreePath?: string | null;
  resolvedFrom?: string | null;
}

export interface ListParams {
  resource?: string;
  status?: string;
  taskId?: string;
  page?: number;
  perPage?: number;
  /**
   * When true, exclude requests that belong to a merge group (groupId IS NOT
   * NULL). The integrator's single-repo FIFO drain passes this so a grouped
   * member is NEVER speculatively interleaved into the single-repo path
   * (Phase 7.3 design §9 finding 3 — grouped members are admitted only as a
   * unit via group-pickup). Additive; absent → exact pre-7.3 behavior.
   */
  ungrouped?: boolean;
}

export interface ListResult {
  data: MergeRequestView[];
  pagination: { total: number; page: number; perPage: number };
}

export interface MergeRequestWithAttempts extends MergeRequestView {
  attempts: MergeAttemptView[];
}

// ─── Internal row shape ───────────────────────────────────────────

interface MergeRequestRow {
  id: string;
  projectId: string;
  resource: string;
  submittedBy: string;
  taskId: string | null;
  resolvedFrom: string | null;
  branch: string | null;
  commitSha: string | null;
  verifyCmd: string | null;
  worktreePath: string | null;
  status: string;
  groupId: string | null;
  enqueuedAt: string;
  pickedUpAt: string | null;
  resolvedAt: string | null;
  landedSha: string | null;
  rejectCategory: string | null;
  rejectReason: string | null;
  failedFiles: string[] | null;
  logExcerpt: string | null;
  logUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Internal helpers ─────────────────────────────────────────────

export function ensureProjectExists(projectId: string): void {
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

export function ensureUserExists(userId: string): void {
  const db = getDb();
  const u = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!u) {
    throw new AppError(404, "NOT_FOUND", `User not found: ${userId}`);
  }
}

/**
 * Cross-project taskId validation. Mirrors merge-lock.service.ts:validateIntent.
 * - taskId omitted: nothing to check.
 * - taskId points to a row in a different project: 400 VALIDATION_ERROR.
 * - taskId points to no row at all: 404 NOT_FOUND.
 */
export function validateTaskBelongsToProject(
  projectId: string,
  taskId: string | null | undefined,
): void {
  if (!taskId) return;
  const db = getDb();
  const task = db
    .select({ id: tasks.id, projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!task) {
    throw new AppError(404, "NOT_FOUND", `Task not found: ${taskId}`);
  }
  if (task.projectId !== projectId) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Task ${taskId} does not belong to project ${projectId}`,
    );
  }
}

function readRequest(id: string): MergeRequestRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(mergeRequests)
    .where(eq(mergeRequests.id, id))
    .get();
  return (row as MergeRequestRow | undefined) ?? null;
}

function readRequestOrThrow(id: string): MergeRequestRow {
  const row = readRequest(id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Merge request not found: ${id}`);
  }
  return row;
}

/**
 * Event emission helper. Mirrors merge-lock.service.ts:emit — spreads the
 * row + extras onto `entity` so downstream SSE consumers see one flat object.
 * Always fires AFTER the UPDATE commits (caller responsibility).
 */
function emit(
  event: string,
  row: MergeRequestRow,
  actorId: string | null,
  extra?: Record<string, unknown>,
): void {
  getEventBus().emit(event as never, {
    entity: { ...row, ...(extra ?? {}) },
    entityType: "merge_request",
    entityId: row.id,
    projectId: row.projectId,
    actorId,
    timestamp: new Date().toISOString(),
  });
}

// ─── Shared git_refs land helper ──────────────────────────────────

/**
 * Write-only helper: attach (or dedup) a `landed_sha` git_ref for a landed
 * merge request. Extracted from `land()` so the Phase-7.3 group-land path
 * (`merge-group.service.ts:landGroup`) can attach the SAME git_ref per
 * member without drifting from the single-repo land semantics.
 *
 * Guards `taskId != null` (no ref for task-less requests). Dedups on
 * (taskId, refType='landed_sha', refValue=landedSha): reuses an existing
 * row, else inserts a new one with the identical title/metadata/createdAt
 * land() has always used. Returns the gitRefId (or null when taskId null).
 *
 * MUST be called inside a db.transaction (takes the tx handle). Emits
 * nothing — the caller emits after commit.
 */
export function attachLandedRef(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  args: {
    requestId: string;
    taskId: string | null;
    landedSha: string;
    resource: string;
    now: string;
  },
): string | null {
  if (args.taskId === null) {
    return null;
  }
  const existing = tx
    .select({ id: gitRefs.id })
    .from(gitRefs)
    .where(
      and(
        eq(gitRefs.taskId, args.taskId),
        eq(gitRefs.refType, "landed_sha"),
        eq(gitRefs.refValue, args.landedSha),
      ),
    )
    .get();
  if (existing) {
    return existing.id;
  }
  const gitRefId = createId();
  tx.insert(gitRefs)
    .values({
      id: gitRefId,
      taskId: args.taskId,
      refType: "landed_sha",
      refValue: args.landedSha,
      url: null,
      title: `Landed via merge request ${args.requestId}`,
      status: null,
      metadata: { mergeRequestId: args.requestId, resource: args.resource },
      createdAt: args.now,
    })
    .run();
  return gitRefId;
}

// ─── State-machine guard ──────────────────────────────────────────

/**
 * Central transition guard. Returns one of:
 *   { kind: "proceed" }                 — caller should do the UPDATE.
 *   { kind: "idempotent_noop" }         — caller should return the row as-is.
 *   throws AppError(409, INVALID_TRANSITION) — illegal transition.
 *
 * The decision matrix in docs/design/phase-7.1-design.md §6 is the
 * authoritative spec. Every (from-state × operation) pair documented there
 * MUST map to exactly one branch here.
 */
type TransitionResult = { kind: "proceed" } | { kind: "idempotent_noop" };

function assertCanTransition(
  from: string,
  op:
    | "cancel"
    | "forceCancel"
    | "transitionToIntegrating"
    | "resetToQueued"
    | "land"
    | "reject",
  requestId: string,
): TransitionResult {
  switch (op) {
    case "cancel":
      // Submitter "I changed my mind": only legal from queued.
      // abandoned → abandoned is idempotent per §6.1.
      if (from === "queued") return { kind: "proceed" };
      if (from === "abandoned") return { kind: "idempotent_noop" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot cancel merge request ${requestId} from state "${from}"`,
      );
    case "forceCancel":
      // Admin "kill it now": legal from queued OR integrating.
      // abandoned → abandoned is idempotent per §6.1.
      if (from === "queued" || from === "integrating") {
        return { kind: "proceed" };
      }
      if (from === "abandoned") return { kind: "idempotent_noop" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot force-cancel merge request ${requestId} from state "${from}"`,
      );
    case "transitionToIntegrating":
      // Integrator pickup: only legal from queued. No idempotent case —
      // §6 explicitly maps integrating → transitionToIntegrating → 409.
      if (from === "queued") return { kind: "proceed" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot transition merge request ${requestId} to integrating from state "${from}"`,
      );
    case "resetToQueued":
      // Back-edge — only legal from integrating. No idempotent case —
      // §6 explicitly maps queued → resetToQueued → 409.
      if (from === "integrating") return { kind: "proceed" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot reset merge request ${requestId} to queued from state "${from}"`,
      );
    case "land":
      // Integrator land: only legal from integrating.
      // landed → landed is idempotent per §6.1.
      if (from === "integrating") return { kind: "proceed" };
      if (from === "landed") return { kind: "idempotent_noop" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot land merge request ${requestId} from state "${from}"`,
      );
    case "reject":
      // Integrator reject: only legal from integrating.
      // rejected → rejected is idempotent per §6.1.
      if (from === "integrating") return { kind: "proceed" };
      if (from === "rejected") return { kind: "idempotent_noop" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot reject merge request ${requestId} from state "${from}"`,
      );
  }
}

// ─── View projection ──────────────────────────────────────────────

function toView(row: MergeRequestRow): MergeRequestView {
  return {
    id: row.id,
    projectId: row.projectId,
    resource: row.resource,
    submittedBy: row.submittedBy,
    taskId: row.taskId,
    resolvedFrom: row.resolvedFrom,
    branch: row.branch,
    commitSha: row.commitSha,
    verifyCmd: row.verifyCmd,
    worktreePath: row.worktreePath,
    status: row.status as MergeRequestView["status"],
    enqueuedAt: row.enqueuedAt,
    pickedUpAt: row.pickedUpAt,
    resolvedAt: row.resolvedAt,
    landedSha: row.landedSha,
    rejectCategory: row.rejectCategory as MergeRequestView["rejectCategory"],
    rejectReason: row.rejectReason,
    failedFiles: row.failedFiles,
    logExcerpt: row.logExcerpt,
    logUrl: row.logUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * A db handle OR a transaction handle. `insertRequestRow` accepts either so the
 * caller controls the transaction boundary: `submit` passes `getDb()` (one
 * standalone insert), while the atomic group-create path (merge-group.service.ts)
 * passes the `tx` handle from inside its own `db.transaction(...)` — better-sqlite3
 * throws "transaction within transaction" if the helper hardcoded getDb().
 */
type DbOrTx =
  | ReturnType<typeof getDb>
  | Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

export interface InsertRequestRowParams {
  projectId: string;
  resource: string;
  submittedBy: string;
  taskId?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  verifyCmd?: string | null;
  worktreePath?: string | null;
  resolvedFrom?: string | null;
  /** Defaults to "queued". The atomic group-create path passes "queued" explicitly. */
  status?: string;
  /** Defaults to null. The atomic group-create path passes the forming group id. */
  groupId?: string | null;
}

/**
 * Insert ONE merge_requests row, returning its id. Pure write — performs NO
 * validation (the caller owns that) and emits NO event (the caller decides
 * whether to signal pickability: `submit` emits MERGE_REQUEST_QUEUED; the atomic
 * group-create path deliberately emits NOTHING so a born-grouped member is never
 * advertised as individually pickable).
 *
 * Accepts a db-or-tx handle so it composes inside an outer transaction.
 */
export function insertRequestRow(
  dbOrTx: DbOrTx,
  params: InsertRequestRowParams,
): string {
  const now = new Date().toISOString();
  const id = createId();
  dbOrTx
    .insert(mergeRequests)
    .values({
      id,
      projectId: params.projectId,
      resource: params.resource,
      submittedBy: params.submittedBy,
      taskId: params.taskId ?? null,
      branch: params.branch ?? null,
      commitSha: params.commitSha ?? null,
      verifyCmd: params.verifyCmd ?? null,
      worktreePath: params.worktreePath ?? null,
      resolvedFrom: params.resolvedFrom ?? null,
      status: params.status ?? "queued",
      groupId: params.groupId ?? null,
      enqueuedAt: now,
      pickedUpAt: null,
      resolvedAt: null,
      landedSha: null,
      rejectCategory: null,
      rejectReason: null,
      failedFiles: null,
      logExcerpt: null,
      logUrl: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

/**
 * Create a new merge request at status=queued.
 *
 * Validates:
 *  - Project exists.
 *  - Submitter user exists.
 *  - taskId (if set) belongs to the same project as the request.
 *
 * Emits MERGE_REQUEST_QUEUED after the insert commits.
 */
export function submit(params: SubmitParams): MergeRequestView {
  ensureProjectExists(params.projectId);
  ensureUserExists(params.submittedBy);
  validateTaskBelongsToProject(params.projectId, params.taskId ?? null);

  const id = insertRequestRow(getDb(), {
    projectId: params.projectId,
    resource: params.resource ?? "main",
    submittedBy: params.submittedBy,
    taskId: params.taskId ?? null,
    branch: params.branch ?? null,
    commitSha: params.commitSha ?? null,
    verifyCmd: params.verifyCmd ?? null,
    worktreePath: params.worktreePath ?? null,
    resolvedFrom: params.resolvedFrom ?? null,
  });

  const row = readRequestOrThrow(id);
  emit(EVENT_NAMES.MERGE_REQUEST_QUEUED, row, params.submittedBy);
  return toView(row);
}

/**
 * List merge requests for a project, with optional filters and pagination.
 * Default page=1, perPage=50.
 */
export function list(projectId: string, params: ListParams = {}): ListResult {
  ensureProjectExists(projectId);
  const db = getDb();

  const conditions = [eq(mergeRequests.projectId, projectId)];
  if (params.resource) conditions.push(eq(mergeRequests.resource, params.resource));
  if (params.status) conditions.push(eq(mergeRequests.status, params.status));
  if (params.taskId) conditions.push(eq(mergeRequests.taskId, params.taskId));
  if (params.ungrouped) {
    conditions.push(sql`${mergeRequests.groupId} IS NULL`);
  }

  const whereClause = and(...conditions);

  const total = Number(
    db
      .select({ c: sql<number>`count(*)` })
      .from(mergeRequests)
      .where(whereClause)
      .get()?.c ?? 0,
  );

  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.max(1, Math.min(200, params.perPage ?? 50));
  const offset = (page - 1) * perPage;

  const rows = db
    .select()
    .from(mergeRequests)
    .where(whereClause)
    .orderBy(asc(mergeRequests.enqueuedAt))
    .limit(perPage)
    .offset(offset)
    .all() as MergeRequestRow[];

  return {
    data: rows.map(toView),
    pagination: { total, page, perPage },
  };
}

/**
 * Get a request by id, with its attempts (most-recent first).
 *
 * Step 4 placeholder: returns `attempts: []` when no attempts exist.
 * Step 5 will insert attempt rows; this projection is already
 * forward-compatible.
 */
export function getById(id: string): MergeRequestWithAttempts {
  const row = readRequestOrThrow(id);
  const db = getDb();
  const attemptRows = db
    .select()
    .from(mergeAttempts)
    .where(eq(mergeAttempts.requestId, id))
    .orderBy(desc(mergeAttempts.attemptNumber))
    .all();
  const attempts: MergeAttemptView[] = attemptRows.map((a) => ({
    id: a.id,
    requestId: a.requestId,
    attemptNumber: a.attemptNumber,
    baseSha: a.baseSha,
    treeSha: a.treeSha,
    status: a.status as MergeAttemptView["status"],
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    verifyDurationMs: a.verifyDurationMs,
    failureCategory: a.failureCategory as MergeAttemptView["failureCategory"],
    failureReason: a.failureReason,
    failedFiles: a.failedFiles ?? null,
    logExcerpt: a.logExcerpt,
    logUrl: a.logUrl,
    steps: a.steps ?? null,
    createdAt: a.createdAt,
  }));
  return { ...toView(row), attempts };
}

// ─── Timeline (design §5.7 / §8.3) ────────────────────────────────

/**
 * One chronological entry in a request's timeline. Every event carries an ISO
 * `at` timestamp (used for the ascending sort) + a `kind` discriminator. All
 * timestamps the timeline reads were written via `new Date().toISOString()`
 * (ISO-8601 `Z`), so a lexical string compare on `at` IS chronological — we
 * deliberately never mix in a SQLite `datetime()` value (whose space-separated
 * format is not lexically comparable to the stored ISO strings).
 */
export interface TimelineEvent {
  at: string;
  kind:
    | "queued"
    | "integrating"
    | "landed"
    | "rejected"
    | "abandoned"
    | "attempt"
    | "audit"
    | "incident"
    | "resolution"
    | "resolution_origin";
  // attempt fields
  attemptNumber?: number;
  baseSha?: string | null;
  treeSha?: string | null;
  status?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  failureCategory?: string | null;
  logExcerpt?: string | null;
  logUrl?: string | null;
  steps?: VerifyStepResult[] | null;
  // terminal-milestone fields
  landedSha?: string | null;
  rejectCategory?: string | null;
  rejectReason?: string | null;
  // audit fields
  action?: string;
  actorId?: string;
  reason?: string | null;
  metadataBefore?: Record<string, unknown> | null;
  metadataAfter?: Record<string, unknown> | null;
  // incident fields
  type?: string;
  orphanedSha?: string;
  state?: string;
  openedAt?: string;
  resolvedAt?: string | null;
  resolution?: unknown;
  // resolution lineage fields (Phase 7.6 §7). "resolution" is the origin-branch
  // event (a conflict spawned an off-lane resolver attempt); "resolution_origin"
  // is the resolved-branch back-link (this request was resubmitted by a resolver).
  resolutionId?: string;
  resolutionState?: string;
  originRequestId?: string;
  resolvedRequestId?: string | null;
  conflictingFiles?: string[] | null;
  escalationTarget?: MergeEscalationTarget | null;
  attemptStartedAt?: string | null;
  attemptEndedAt?: string | null;
  detail?: MergeResolutionDetail | null;
}

export interface TimelineResult {
  request: MergeRequestView;
  events: TimelineEvent[];
}

/**
 * Compose the ordered state history of a request (design §5.7 / §8.3) from four
 * heterogeneous sources, then sort ASCENDING by `at`:
 *   1. Request milestones (the row): enqueued→queued; pickedUp→integrating;
 *      resolved→terminal (landed/rejected/abandoned, tagged by status).
 *   2. Attempts (mergeAttempts ASC by attemptNumber): each a `verifying→…`
 *      segment with its log pointers; sort ts = startedAt ?? createdAt.
 *   3. Audit rows targeting this request (land/reject/force_land/force_reject):
 *      actorId, reason, before/after; sort ts = createdAt.
 *   4. Incident (if the request was orphaned): the merge_incident whose
 *      innerRequestId === id; sort ts = openedAt. No index on innerRequestId,
 *      so list the project's incidents and filter in JS (the cheap path).
 */
export function getTimeline(id: string): TimelineResult {
  const row = readRequestOrThrow(id);
  const db = getDb();
  const events: TimelineEvent[] = [];

  // 1. Request milestones.
  events.push({ at: row.enqueuedAt, kind: "queued" });
  if (row.pickedUpAt !== null) {
    events.push({ at: row.pickedUpAt, kind: "integrating" });
  }
  if (row.resolvedAt !== null) {
    if (row.status === "landed") {
      events.push({
        at: row.resolvedAt,
        kind: "landed",
        landedSha: row.landedSha,
      });
    } else if (row.status === "rejected") {
      events.push({
        at: row.resolvedAt,
        kind: "rejected",
        rejectCategory: row.rejectCategory,
        rejectReason: row.rejectReason,
      });
    } else if (row.status === "abandoned") {
      events.push({ at: row.resolvedAt, kind: "abandoned" });
    }
  }

  // 2. Attempts (ASC by attemptNumber).
  const attemptRows = db
    .select()
    .from(mergeAttempts)
    .where(eq(mergeAttempts.requestId, id))
    .orderBy(asc(mergeAttempts.attemptNumber))
    .all() as Array<{
    attemptNumber: number;
    baseSha: string;
    treeSha: string | null;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    failureCategory: string | null;
    logExcerpt: string | null;
    logUrl: string | null;
    steps: VerifyStepResult[] | null;
    createdAt: string;
  }>;
  for (const a of attemptRows) {
    events.push({
      at: a.startedAt ?? a.createdAt,
      kind: "attempt",
      attemptNumber: a.attemptNumber,
      baseSha: a.baseSha,
      treeSha: a.treeSha,
      status: a.status,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      failureCategory: a.failureCategory,
      logExcerpt: a.logExcerpt,
      logUrl: a.logUrl,
      steps: a.steps ?? null,
    });
  }

  // 3. Audit rows targeting this request.
  const audit = listAudit({
    projectId: row.projectId,
    targetType: "merge_request",
    targetId: id,
    perPage: 200,
  });
  for (const e of audit.data) {
    events.push({
      at: e.createdAt,
      kind: "audit",
      action: e.action,
      actorId: e.actorId,
      reason: e.reason,
      metadataBefore: e.metadataBefore,
      metadataAfter: e.metadataAfter,
    });
  }

  // 4. Incident (orphaned-inner). No index on innerRequestId — list the
  // project's incidents and filter in JS (the cheap, project-scoped path).
  const incidents = listIncidents(row.projectId).filter(
    (inc) => inc.innerRequestId === id,
  );
  for (const inc of incidents) {
    events.push({
      at: inc.openedAt,
      kind: "incident",
      type: inc.type,
      orphanedSha: inc.orphanedSha,
      state: inc.state,
      openedAt: inc.openedAt,
      resolvedAt: inc.resolvedAt,
      resolution: inc.resolution,
    });
  }

  // 5. Resolution lineage (Phase 7.6 §7). Two complementary branches:
  //   (origin) every resolution spun off THIS request as its origin (a textual
  //   rebase conflict triggered an off-lane resolver attempt) — push a
  //   "resolution" event carrying the attempt state/timestamps/escalation.
  //   (resolved) if THIS request was itself resubmitted by a resolver
  //   (row.resolvedFrom != null), push a "resolution_origin" back-link to its
  //   origin request at the moment it was enqueued.
  // resolver-off deployments never write merge_resolutions rows and never set
  // resolvedFrom, so both branches are inert (no events added).
  for (const res of listByOriginRequest(id)) {
    events.push({
      at: res.attemptStartedAt ?? res.createdAt,
      kind: "resolution",
      resolutionId: res.id,
      resolutionState: res.state,
      originRequestId: res.originRequestId ?? id,
      resolvedRequestId: res.resolvedRequestId,
      conflictingFiles: res.conflictingFiles,
      escalationTarget: res.escalationTarget,
      attemptStartedAt: res.attemptStartedAt,
      attemptEndedAt: res.attemptEndedAt,
      detail: res.detail,
    });
  }
  if (row.resolvedFrom !== null) {
    events.push({
      at: row.enqueuedAt,
      kind: "resolution_origin",
      originRequestId: row.resolvedFrom,
    });
  }

  // Sort ASCENDING by `at` — all sources use ISO-8601 `Z`, so the lexical
  // string compare is chronological across the heterogeneous sources.
  events.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));

  return { request: toView(row), events };
}

/**
 * Submitter (or admin) cancel — queued → abandoned.
 *
 * Authz: submitter (actor.id === request.submittedBy) OR admin
 * (actor.role === "admin"). Other-worker → 403 NOT_REQUEST_OWNER.
 *
 * State machine: per §6 — only legal from queued. abandoned is idempotent.
 * All other states → 409 INVALID_TRANSITION.
 */
export function cancel(id: string, actor: Actor): MergeRequestView {
  const row = readRequestOrThrow(id);

  const isSubmitter = actor.id === row.submittedBy;
  const isAdmin = actor.role === "admin";
  if (!isSubmitter && !isAdmin) {
    throw new AppError(
      403,
      "NOT_REQUEST_OWNER",
      "Only the submitter or an admin may cancel this merge request.",
    );
  }

  const result = assertCanTransition(row.status, "cancel", id);
  if (result.kind === "idempotent_noop") {
    return toView(row);
  }

  return applyAbandon(row, actor, null);
}

/**
 * Admin force-cancel — queued OR integrating → abandoned. The break-glass
 * escape hatch for a stuck QUEUED request (force_reject/force_land only reach
 * `integrating`).
 *
 * Authz: admin only (route layer enforces; service double-checks).
 *
 * State machine: per §6 — legal from queued or integrating.
 * abandoned is idempotent. All other states → 409 INVALID_TRANSITION.
 *
 * Unlike submitter `cancel`, this is a recorded override: the abandon and a
 * `force_cancel` audit row commit in ONE transaction (the §1.4 invariant);
 * the abandoned event + audit.recorded fire after commit.
 */
export function forceCancel(
  id: string,
  actor: Actor,
  reason: string | null = null,
): MergeRequestView {
  const row = readRequestOrThrow(id);

  if (actor.role !== "admin") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only admins may force-cancel a merge request.",
    );
  }

  const result = assertCanTransition(row.status, "forceCancel", id);
  if (result.kind === "idempotent_noop") {
    return toView(row);
  }

  const now = new Date().toISOString();
  let auditId: string | null = null;
  let auditView: AuditLogView | null = null;

  const db = getDb();
  db.transaction((tx) => {
    tx.update(mergeRequests)
      .set({ status: "abandoned", resolvedAt: now, updatedAt: now })
      .where(eq(mergeRequests.id, row.id))
      .run();

    const before = { status: row.status };
    const after = { status: "abandoned", overridden: true };
    auditId = recordAudit(tx, {
      projectId: row.projectId,
      actorId: actor.id,
      action: "force_cancel",
      targetType: "merge_request",
      targetId: row.id,
      reason,
      before,
      after,
      now,
    });
    auditView = {
      id: auditId,
      projectId: row.projectId,
      actorId: actor.id,
      action: "force_cancel",
      targetType: "merge_request",
      targetId: row.id,
      reason,
      metadataBefore: before,
      metadataAfter: after,
      createdAt: now,
    };
  });

  const updated = readRequestOrThrow(row.id);
  emit(EVENT_NAMES.MERGE_REQUEST_ABANDONED, updated, actor.id, {
    cancelledBy: actor.id,
    reason,
    overridden: true,
  });
  if (auditId !== null && auditView !== null) {
    emitAuditRecorded(auditId, row.projectId, actor.id, auditView);
  }
  return toView(updated);
}

function applyAbandon(
  row: MergeRequestRow,
  actor: Actor,
  reason: string | null,
): MergeRequestView {
  const db = getDb();
  const now = new Date().toISOString();
  db.update(mergeRequests)
    .set({
      status: "abandoned",
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(mergeRequests.id, row.id))
    .run();
  const updated = readRequestOrThrow(row.id);
  emit(EVENT_NAMES.MERGE_REQUEST_ABANDONED, updated, actor.id, {
    cancelledBy: actor.id,
    reason,
  });
  return toView(updated);
}

/**
 * Integrator pickup — queued → integrating.
 *
 * Authz: integrator (actor.type === "ai_agent"). Routes enforce too;
 * service double-checks so this can't be called from a buggy code path
 * that bypassed routes.
 *
 * State machine: per §6 — only legal from queued. integrating → 409.
 * All other states → 409 INVALID_TRANSITION.
 */
export function transitionToIntegrating(
  id: string,
  actor: Actor,
  extra?: { batchId?: string; speculativePosition?: number },
): MergeRequestView {
  const row = readRequestOrThrow(id);

  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only integrator (ai_agent) users may pick up a merge request.",
    );
  }

  // Structural guard (Phase 7.3 hardening): a grouped member is NEVER
  // single-repo-pickable, regardless of the client's list query or mode.
  // Mirrors the symmetric land-side guard `assertMemberLandableViaGroup`
  // (merge-group.service.ts). The group integration path flips members to
  // integrating via `markIntegrating` (its own tx) and does NOT route through
  // this function, so this guard cannot block the legitimate group pickup.
  if (row.groupId !== null) {
    throw new AppError(
      409,
      "GROUPED_MEMBER",
      `Merge request ${id} is a group member and must be integrated via its group, not picked up individually.`,
    );
  }

  assertCanTransition(row.status, "transitionToIntegrating", id);

  const db = getDb();
  const now = new Date().toISOString();
  db.update(mergeRequests)
    .set({
      status: "integrating",
      pickedUpAt: now,
      updatedAt: now,
    })
    .where(eq(mergeRequests.id, row.id))
    .run();
  const updated = readRequestOrThrow(row.id);
  // Phase 7.2: spread optional batch tags onto the event entity so the SSE
  // frame carries batch_id / speculative_position (undefined fields omitted).
  emit(EVENT_NAMES.MERGE_REQUEST_INTEGRATING, updated, actor.id, {
    ...(extra?.batchId !== undefined ? { batchId: extra.batchId } : {}),
    ...(extra?.speculativePosition !== undefined
      ? { speculativePosition: extra.speculativePosition }
      : {}),
  });
  return toView(updated);
}

/**
 * Integrator back-edge — integrating → queued.
 *
 * Used for two operational realities only:
 *   (a) Crash recovery: integrator restart finds a stranded `integrating`
 *       request with no live attempt; resets it so the lane unblocks.
 *   (b) Push race: post-verify-pass git push returned non-fast-forward;
 *       the verified tree is stale, retry from queued.
 *
 * Step 4 does NOT cancel open attempts here — the attempts service in
 * Step 5 owns that. Step 5 will extend resetToQueued (or layer on top
 * of it) to flip running attempts → cancelled.
 *
 * Authz: integrator (actor.type === "ai_agent"). Same double-check.
 *
 * State machine: per §6 — only legal from integrating.
 */
export function resetToQueued(
  id: string,
  actor: Actor,
  reason: string,
): MergeRequestView {
  const row = readRequestOrThrow(id);

  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only integrator (ai_agent) users may reset a merge request.",
    );
  }

  assertCanTransition(row.status, "resetToQueued", id);

  const db = getDb();
  const now = new Date().toISOString();
  let cancelledAttempts: MergeAttemptView[] = [];

  db.transaction(() => {
    // Finding 1: cancelOpenAttempts is write-only; no events inside tx.
    const result = cancelOpenAttempts(row.id);
    cancelledAttempts = result.cancelledAttempts;

    // Note: cancelOpenAttempts uses getDb(); better-sqlite3 single-writer
    // semantics keep both writes in the same tx context.
    getDb()
      .update(mergeRequests)
      .set({
        status: "queued",
        pickedUpAt: null,
        updatedAt: now,
      })
      .where(eq(mergeRequests.id, row.id))
      .run();
  });

  const updated = readRequestOrThrow(row.id);

  // Emit AFTER commit — Finding 1.
  for (const att of cancelledAttempts) {
    emitAttemptCompleted(att, row.projectId, actor.id, {
      requestId: row.id,
      status: "cancelled",
      reason,
    });
  }
  emit(EVENT_NAMES.MERGE_REQUEST_QUEUED, updated, actor.id, { reason });

  return toView(updated);
}

/**
 * Integrator land — integrating → landed.
 *
 * Authz: integrator (actor.type === "ai_agent").
 *
 * Side effects (atomic with the status update — §12.2):
 *   1. UPDATE merge_requests SET status='landed', resolvedAt, landedSha.
 *   2. If taskId !== null: SELECT existing git_refs (dedup); else INSERT
 *      git_refs(refType='landed_sha', refValue=landedSha, taskId, ...).
 *
 * Event MERGE_REQUEST_LANDED emits AFTER the transaction commits (§12.1).
 */
export function land(
  id: string,
  body: MergeRequestLand,
  actor: Actor,
): MergeRequestView {
  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only integrator (ai_agent) users may land a merge request.",
    );
  }

  const row = readRequestOrThrow(id);
  const result = assertCanTransition(row.status, "land", id);
  if (result.kind === "idempotent_noop") {
    return toView(row);
  }

  const now = new Date().toISOString();
  let gitRefId: string | null = null;
  // Phase 7.4 §2.5: the natural land writes one audit row inside the SAME
  // txn (additive, INSERT-only, on the proceed path only — the idempotent
  // noop above returns before this). Captured here, emitted after commit.
  let auditId: string | null = null;
  let auditView: AuditLogView | null = null;

  const db = getDb();
  db.transaction((tx) => {
    tx.update(mergeRequests)
      .set({
        status: "landed",
        resolvedAt: now,
        landedSha: body.landedSha,
        updatedAt: now,
      })
      .where(eq(mergeRequests.id, id))
      .run();

    gitRefId = attachLandedRef(tx, {
      requestId: id,
      taskId: row.taskId,
      landedSha: body.landedSha,
      resource: row.resource,
      now,
    });

    const before = { status: "integrating", landedSha: null };
    const after = { status: "landed", landedSha: body.landedSha };
    auditId = recordAudit(tx, {
      projectId: row.projectId,
      actorId: actor.id,
      action: "land",
      targetType: "merge_request",
      targetId: id,
      reason: null,
      before,
      after,
      now,
    });
    auditView = {
      id: auditId,
      projectId: row.projectId,
      actorId: actor.id,
      action: "land",
      targetType: "merge_request",
      targetId: id,
      reason: null,
      metadataBefore: before,
      metadataAfter: after,
      createdAt: now,
    };
  });

  const updated = readRequestOrThrow(id);
  emit(EVENT_NAMES.MERGE_REQUEST_LANDED, updated, actor.id, {
    landedSha: body.landedSha,
    gitRefId,
  });
  if (auditId !== null && auditView !== null) {
    emitAuditRecorded(auditId, row.projectId, actor.id, auditView);
  }
  return toView(updated);
}

/**
 * Integrator reject — integrating → rejected.
 *
 * Authz: integrator (actor.type === "ai_agent").
 *
 * Side effects (atomic with the status update — §12.3):
 *   1. UPDATE merge_requests SET status='rejected', resolvedAt, rejection fields.
 *   2. If taskId !== null: INSERT comments(commentType='merge_rejection',
 *      body templated, metadata = structured payload + attemptId).
 *
 * Event MERGE_REQUEST_REJECTED emits AFTER the transaction commits (§12.1).
 */
export function reject(
  id: string,
  body: MergeRequestReject,
  actor: Actor,
): MergeRequestView {
  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only integrator (ai_agent) users may reject a merge request.",
    );
  }

  const row = readRequestOrThrow(id);
  const result = assertCanTransition(row.status, "reject", id);
  if (result.kind === "idempotent_noop") {
    return toView(row);
  }

  const db = getDb();
  const latestAttempt = db
    .select({
      id: mergeAttempts.id,
      baseSha: mergeAttempts.baseSha,
    })
    .from(mergeAttempts)
    .where(eq(mergeAttempts.requestId, id))
    .orderBy(desc(mergeAttempts.attemptNumber))
    .limit(1)
    .get();

  const now = new Date().toISOString();
  let commentId: string | null = null;
  // Phase 7.4 §2.5: the natural reject writes one audit row inside the SAME
  // txn (additive, proceed path only). Emitted after commit.
  let auditId: string | null = null;
  let auditView: AuditLogView | null = null;

  db.transaction((tx) => {
    tx.update(mergeRequests)
      .set({
        status: "rejected",
        resolvedAt: now,
        rejectCategory: body.category,
        rejectReason: body.reason,
        failedFiles: body.failedFiles ?? null,
        logExcerpt: body.logExcerpt ?? null,
        logUrl: body.logUrl ?? null,
        updatedAt: now,
      })
      .where(eq(mergeRequests.id, id))
      .run();

    if (row.taskId !== null) {
      commentId = createId();
      const failedCount = body.failedFiles?.length ?? 0;
      const commentBody =
        `Merge rejected: ${body.category}.\n\n${body.reason}\n\n` +
        `${failedCount} failed file(s).\n` +
        `See log: ${body.logUrl ?? "(none)"}`;
      tx.insert(comments)
        .values({
          id: commentId,
          taskId: row.taskId,
          proposalId: null,
          authorId: actor.id,
          body: commentBody,
          commentType: "merge_rejection",
          metadata: {
            mergeRequestId: id,
            attemptId: latestAttempt?.id ?? null,
            category: body.category,
            reason: body.reason,
            failedFiles: body.failedFiles ?? [],
            logExcerpt: body.logExcerpt ?? null,
            logUrl: body.logUrl ?? null,
            baseSha: latestAttempt?.baseSha ?? null,
          },
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const before = { status: "integrating" };
    const after = { status: "rejected", rejectCategory: body.category };
    auditId = recordAudit(tx, {
      projectId: row.projectId,
      actorId: actor.id,
      action: "reject",
      targetType: "merge_request",
      targetId: id,
      reason: null,
      before,
      after,
      now,
    });
    auditView = {
      id: auditId,
      projectId: row.projectId,
      actorId: actor.id,
      action: "reject",
      targetType: "merge_request",
      targetId: id,
      reason: null,
      metadataBefore: before,
      metadataAfter: after,
      createdAt: now,
    };
  });

  const updated = readRequestOrThrow(id);
  emit(EVENT_NAMES.MERGE_REQUEST_REJECTED, updated, actor.id, {
    attemptId: latestAttempt?.id ?? null,
    commentId,
    category: body.category,
    reason: body.reason,
    failedFiles: body.failedFiles ?? null,
    logExcerpt: body.logExcerpt ?? null,
    logUrl: body.logUrl ?? null,
  });
  if (auditId !== null && auditView !== null) {
    emitAuditRecorded(auditId, row.projectId, actor.id, auditView);
  }
  return toView(updated);
}
