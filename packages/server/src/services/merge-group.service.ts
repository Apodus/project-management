import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import type { MergeGroupMemberSpec, MergeRequestGroupView, MergeRequestView } from "@pm/shared";
import { getDb, mergeIncidents, mergeRequestGroups, mergeRequests, projects } from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus } from "../events/event-bus.js";
import {
  attachLandedRef,
  ensureUserExists,
  insertRequestRow,
  validateTaskBelongsToProject,
  type Actor,
} from "./merge-request.service.js";
import { emitAuditRecorded, record as recordAudit, type AuditLogView } from "./audit.service.js";

// ─── Types ────────────────────────────────────────────────────────

export type { Actor };

export interface CreateGroupParams {
  projectId: string;
  resource?: string;
  submittedBy: string;
  /**
   * Back-compat arm: bind >=2 ALREADY-queued, ungrouped requests into the group.
   * Exactly one of `memberRequestIds` | `members` (the route + shared schema
   * enforce the exactly-one-of; the service double-checks defensively).
   */
  memberRequestIds?: string[];
  /**
   * Atomic arm: submit >=2 NEW member requests AND form the group in one txn, so
   * members are born group-bound (closes the submit/group pickup race).
   */
  members?: MergeGroupMemberSpec[];
  /**
   * Inner-only cross-repo form (campaign 2026-06-10): with EXACTLY ONE member
   * spec (the inner change), PM also inserts a SYNTHETIC outer member (no
   * branch/commit) in the same txn; the integrator synthesizes the outer
   * gitlink-bump candidate at integration time. STRICT `=== true` semantics —
   * an explicit false behaves exactly like absent. Requires
   * settings.integrator.linked_repos to declare exactly one inner + one outer.
   */
  synthesizeOuter?: boolean;
}

export interface GroupWithMembers extends MergeRequestGroupView {
  members: MergeRequestView[];
}

export interface ListGroupsParams {
  state?: string;
  resource?: string;
}

export interface LandGroupMember {
  requestId: string;
  landedSha: string;
  role?: string;
}

// ─── Internal row shapes ──────────────────────────────────────────

interface MergeGroupRow {
  id: string;
  projectId: string;
  resource: string;
  state: string;
  submittedBy: string;
  integratorId: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MergeRequestRow {
  id: string;
  projectId: string;
  resource: string;
  submittedBy: string;
  taskId: string | null;
  resolvedFrom: string | null;
  escalationId: string | null;
  revertOf: string | null;
  synthetic: boolean;
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

function readGroup(id: string): MergeGroupRow | null {
  const db = getDb();
  const row = db.select().from(mergeRequestGroups).where(eq(mergeRequestGroups.id, id)).get();
  return (row as MergeGroupRow | undefined) ?? null;
}

function readGroupOrThrow(id: string): MergeGroupRow {
  const row = readGroup(id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Merge group not found: ${id}`);
  }
  return row;
}

function readRequest(id: string): MergeRequestRow | null {
  const db = getDb();
  const row = db.select().from(mergeRequests).where(eq(mergeRequests.id, id)).get();
  return (row as MergeRequestRow | undefined) ?? null;
}

function readMembers(groupId: string): MergeRequestRow[] {
  const db = getDb();
  return db
    .select()
    .from(mergeRequests)
    .where(eq(mergeRequests.groupId, groupId))
    .orderBy(asc(mergeRequests.enqueuedAt))
    .all() as MergeRequestRow[];
}

/**
 * Event emission helper. Mirrors merge-request.service.ts:emit — spreads the
 * group row + extras onto `entity` so downstream SSE consumers see one flat
 * object. Always fires AFTER the UPDATE commits (caller responsibility).
 */
function emit(
  event: string,
  row: MergeGroupRow,
  actorId: string | null,
  extra?: Record<string, unknown>,
): void {
  getEventBus().emit(event as never, {
    entity: { ...row, ...(extra ?? {}) },
    entityType: "merge_group",
    entityId: row.id,
    projectId: row.projectId,
    actorId,
    timestamp: new Date().toISOString(),
  });
}

// ─── State-machine guard ──────────────────────────────────────────

/**
 * Central group transition guard. Mirrors merge-request.service.ts:
 * assertCanTransition — returns one of:
 *   { kind: "proceed" }         — caller should do the UPDATE.
 *   { kind: "idempotent_noop" } — caller should return the row as-is.
 *   throws AppError(409, INVALID_TRANSITION) — illegal transition.
 *
 * The group state machine in docs/design/phase-7.3-design.md §3.3 is the
 * authoritative spec.
 */
type TransitionResult = { kind: "proceed" } | { kind: "idempotent_noop" };

function assertCanTransition(
  from: string,
  op: "markIntegrating" | "reject" | "land" | "markPartiallyLanded" | "reset",
  groupId: string,
): TransitionResult {
  switch (op) {
    case "reset":
      // Stranded-group recovery (§9 finding 2 / §6.4): integrating → forming, a
      // re-integratable reset. Idempotent if ALREADY forming (a crash between
      // the resetGroup commit and the integrator's next list re-scan must be a
      // safe no-op). NEVER legal from a terminal/partial state — that guard is
      // the corruption fence (a partially_landed group is a REAL orphan handled
      // by §7 recovery, not a stranded group).
      if (from === "integrating") return { kind: "proceed" };
      if (from === "forming") return { kind: "idempotent_noop" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot reset merge group ${groupId} from state "${from}" (only a stranded integrating group may be reset to forming)`,
      );
    case "markIntegrating":
      // Integrator pickup: only legal from forming. No idempotent case —
      // integrating/terminal → markIntegrating → 409 (§3.3).
      if (from === "forming") return { kind: "proceed" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot transition merge group ${groupId} to integrating from state "${from}"`,
      );
    case "reject":
      // Cancel-while-forming OR integrator reject: legal from forming or
      // integrating. rejected → rejected is idempotent (§3.3).
      if (from === "forming" || from === "integrating") {
        return { kind: "proceed" };
      }
      if (from === "rejected") return { kind: "idempotent_noop" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot reject merge group ${groupId} from state "${from}"`,
      );
    case "land":
      // Atomic land success: only legal from integrating.
      // landed → landed is idempotent (§3.3).
      if (from === "integrating") return { kind: "proceed" };
      if (from === "landed") return { kind: "idempotent_noop" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot land merge group ${groupId} from state "${from}"`,
      );
    case "markPartiallyLanded":
      // Outer-push-fail-after-inner-land: only legal from integrating.
      // partially_landed → partially_landed is idempotent (§3.3).
      if (from === "integrating") return { kind: "proceed" };
      if (from === "partially_landed") return { kind: "idempotent_noop" };
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Cannot mark merge group ${groupId} partially_landed from state "${from}"`,
      );
  }
}

// ─── View projection ──────────────────────────────────────────────

function toGroupView(row: MergeGroupRow): MergeRequestGroupView {
  return {
    id: row.id,
    projectId: row.projectId,
    resource: row.resource,
    state: row.state as MergeRequestGroupView["state"],
    submittedBy: row.submittedBy,
    integratorId: row.integratorId,
    resolvedAt: row.resolvedAt,
    resolutionReason: row.resolutionReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMemberView(row: MergeRequestRow): MergeRequestView {
  return {
    id: row.id,
    projectId: row.projectId,
    resource: row.resource,
    submittedBy: row.submittedBy,
    taskId: row.taskId,
    resolvedFrom: row.resolvedFrom,
    escalationId: row.escalationId,
    revertOf: row.revertOf,
    synthetic: row.synthetic,
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

function withMembers(row: MergeGroupRow): GroupWithMembers {
  return {
    ...toGroupView(row),
    members: readMembers(row.id).map(toMemberView),
  };
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * The classified create-group form. Discriminates which arm of the submit
 * surface a CreateGroupParams selects — the single owner of the form matrix
 * (createGroup dispatches on it; the route/shared Zod tiers pre-validate the
 * same matrix on the wire, the service re-classifies defensively).
 */
export type CreateForm = { kind: "bind" } | { kind: "atomic" } | { kind: "inner_only" };

/**
 * Classify a create-group call into its form, owning the ENTIRE form matrix:
 *
 *  - exactly one of `memberRequestIds` | `members` (both/neither → 400);
 *  - `synthesizeOuter === true` (STRICT — an explicit false behaves exactly
 *    like absent) requires the members arm with EXACTLY ONE spec → inner_only;
 *  - otherwise the legacy floors hold: ids arm ≥2 → bind, members arm ≥2 →
 *    atomic (each <2 → 400 with the exact legacy message).
 */
export function classifyCreateForm(params: CreateGroupParams): CreateForm {
  const hasIds = params.memberRequestIds !== undefined;
  const hasSpecs = params.members !== undefined;
  if (hasIds === hasSpecs) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Provide exactly one of memberRequestIds or members.",
    );
  }

  if (params.synthesizeOuter === true) {
    if (hasIds) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "synthesizeOuter cannot be combined with memberRequestIds; provide members with exactly one inner member spec.",
      );
    }
    if (params.members!.length !== 1) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "synthesizeOuter requires exactly one member spec (the inner change); the outer member is synthesized at integration time.",
      );
    }
    return { kind: "inner_only" };
  }

  if (hasSpecs) {
    if (params.members!.length < 2) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "A merge group requires at least 2 member specs.",
      );
    }
    return { kind: "atomic" };
  }

  if (params.memberRequestIds!.length < 2) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "A merge group requires at least 2 member requests.",
    );
  }
  return { kind: "bind" };
}

/**
 * Create a merge group three ways (exactly one form; classifyCreateForm owns
 * the form matrix, the route + shared schema pre-validate it on the wire):
 *
 *  - `memberRequestIds` (back-compat): bind >=2 existing queued, ungrouped
 *    requests (§3.2). ATOMICALLY claims the members inside one db.transaction
 *    with a WHERE-guarded, rowcount-checked UPDATE (PIN D) that closes the
 *    TOCTOU window between validation and write.
 *
 *  - `members` (atomic submit-and-group): submit >=2 NEW member requests AND
 *    form the group in ONE txn, so members are born group-bound (status queued,
 *    groupId set) and never exist as an ungrouped/pickable row — closing the
 *    submit/group pickup race (a single-repo pickup can never grab a member
 *    mid-grouping; Part B's transitionToIntegrating guard is the structural
 *    backstop).
 *
 *  - `members` (exactly one) + `synthesizeOuter: true` (inner-only cross-repo,
 *    campaign 2026-06-10): submit the ONE real inner member AND a server-minted
 *    SYNTHETIC outer member (no branch/commit) in the same txn — the integrator
 *    synthesizes the outer gitlink-bump candidate at integration time, so a
 *    worker never mints (and never goes stale on) an outer bump branch.
 *
 * No event on create any way — merge.group.started fires at markIntegrating
 * (§10.2), and the submit-and-group arms emit ZERO per-member
 * MERGE_REQUEST_QUEUED so a born-grouped member is never advertised as
 * individually pickable.
 */
export function createGroup(params: CreateGroupParams): GroupWithMembers {
  const form = classifyCreateForm(params);
  switch (form.kind) {
    case "bind":
      return createGroupFromIds(params);
    case "atomic":
      return createGroupFromSpecs(params);
    case "inner_only":
      return createGroupInnerOnly(params, params.members![0]);
  }
}

/**
 * Atomic submit-and-group arm. Pre-validates every spec, then in ONE txn inserts
 * the forming group row FIRST (FK target) and each member via the shared
 * `insertRequestRow` (status "queued", groupId = the forming group). Members are
 * born group-bound; no row is ever ungrouped, so the pickup race cannot occur.
 */
function createGroupFromSpecs(params: CreateGroupParams): GroupWithMembers {
  ensureProjectExists(params.projectId);
  ensureUserExists(params.submittedBy);

  // ≥2-specs floor already enforced by classifyCreateForm (the form-matrix owner).
  const specs = params.members!;
  const resource = params.resource ?? "main";

  // Pre-txn validation (no rows written yet, so a throw leaves nothing behind).
  for (const spec of specs) {
    if (!spec.branch && !spec.commitSha) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Each member spec needs at least one of branch / commitSha.",
      );
    }
    validateTaskBelongsToProject(params.projectId, spec.taskId ?? null);
  }

  const db = getDb();
  const now = new Date().toISOString();
  const groupId = createId();

  db.transaction((tx) => {
    tx.insert(mergeRequestGroups)
      .values({
        id: groupId,
        projectId: params.projectId,
        resource,
        state: "forming",
        submittedBy: params.submittedBy,
        integratorId: null,
        resolvedAt: null,
        resolutionReason: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    for (const spec of specs) {
      insertRequestRow(tx, {
        projectId: params.projectId,
        resource,
        submittedBy: params.submittedBy,
        taskId: spec.taskId ?? null,
        branch: spec.branch ?? null,
        commitSha: spec.commitSha ?? null,
        verifyCmd: spec.verifyCmd ?? null,
        status: "queued",
        groupId,
      });
    }
  });

  return withMembers(readGroupOrThrow(groupId));
}

/**
 * Inner-only cross-repo arm (campaign 2026-06-10). Validates the ONE real
 * inner spec + the project's inner/outer topology, then in ONE txn inserts the
 * forming group row, the real inner member, and a server-minted SYNTHETIC
 * outer member (no branch/commit/verifyCmd/taskId; synthetic = true) — the
 * integrator synthesizes the outer gitlink-bump candidate at integration time
 * and fills the synthetic member's landedSha at land. Real-then-synthetic
 * insert order. Like the other arms: no events, no audit rows on create.
 */
function createGroupInnerOnly(
  params: CreateGroupParams,
  innerSpec: MergeGroupMemberSpec,
): GroupWithMembers {
  ensureProjectExists(params.projectId);
  ensureUserExists(params.submittedBy);

  // Pre-txn validation (no rows written yet, so a throw leaves nothing behind).
  if (!innerSpec.branch && !innerSpec.commitSha) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Each member spec needs at least one of branch / commitSha.",
    );
  }
  validateTaskBelongsToProject(params.projectId, innerSpec.taskId ?? null);
  assertInnerOuterTopology(params.projectId);

  const resource = params.resource ?? "main";
  const db = getDb();
  const now = new Date().toISOString();
  const groupId = createId();

  db.transaction((tx) => {
    tx.insert(mergeRequestGroups)
      .values({
        id: groupId,
        projectId: params.projectId,
        resource,
        state: "forming",
        submittedBy: params.submittedBy,
        integratorId: null,
        resolvedAt: null,
        resolutionReason: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // The real inner member, born group-bound (same shape as the atomic arm).
    insertRequestRow(tx, {
      projectId: params.projectId,
      resource,
      submittedBy: params.submittedBy,
      taskId: innerSpec.taskId ?? null,
      branch: innerSpec.branch ?? null,
      commitSha: innerSpec.commitSha ?? null,
      verifyCmd: innerSpec.verifyCmd ?? null,
      status: "queued",
      groupId,
    });

    // The synthetic outer member: no refs to land (the integrator synthesizes
    // the candidate), no task (the inner member carries the work linkage).
    insertRequestRow(tx, {
      projectId: params.projectId,
      resource,
      submittedBy: params.submittedBy,
      taskId: null,
      branch: null,
      commitSha: null,
      verifyCmd: null,
      status: "queued",
      groupId,
      synthetic: true,
    });
  });

  return withMembers(readGroupOrThrow(groupId));
}

/**
 * Topology gate for the inner-only form: the project must declare EXACTLY one
 * inner and one outer repo in settings.integrator.linked_repos, else the
 * integrator cannot know which gitlink to bump. Settings are read tolerantly
 * as plain JSON (the metrics.service idiom) — a missing/odd shape counts as
 * zero declared repos, never a crash.
 */
function assertInnerOuterTopology(projectId: string): void {
  const db = getDb();
  const row = db
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  const settings = (row?.settings ?? null) as {
    integrator?: { linked_repos?: unknown };
  } | null;
  const linkedRepos = Array.isArray(settings?.integrator?.linked_repos)
    ? (settings!.integrator!.linked_repos as Array<{ role?: unknown }>)
    : [];
  const innerCount = linkedRepos.filter((r) => r?.role === "inner").length;
  const outerCount = linkedRepos.filter((r) => r?.role === "outer").length;
  if (innerCount !== 1 || outerCount !== 1) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `synthesizeOuter requires settings.integrator.linked_repos to declare exactly one inner and one outer repo; found ${innerCount} inner / ${outerCount} outer.`,
    );
  }
}

/**
 * Back-compat bind-existing arm (§3.2). Unchanged from the original createGroup.
 */
function createGroupFromIds(params: CreateGroupParams): GroupWithMembers {
  ensureProjectExists(params.projectId);

  // ≥2-ids floor already enforced by classifyCreateForm (the form-matrix owner).
  const memberRequestIds = params.memberRequestIds!;
  const resource = params.resource ?? "main";

  // Pre-txn validation (re-checked atomically by the rowcount guard below).
  for (const memberId of memberRequestIds) {
    const member = readRequest(memberId);
    if (!member) {
      throw new AppError(404, "NOT_FOUND", `Merge request not found: ${memberId}`);
    }
    if (member.projectId !== params.projectId) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Merge request ${memberId} does not belong to project ${params.projectId}`,
      );
    }
    if (member.resource !== resource) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Merge request ${memberId} targets resource "${member.resource}", not "${resource}"`,
      );
    }
    if (member.status !== "queued") {
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `Merge request ${memberId} is "${member.status}", not "queued"; cannot group it.`,
      );
    }
    if (member.groupId !== null) {
      throw new AppError(
        409,
        "ALREADY_GROUPED",
        `Merge request ${memberId} is already a member of group ${member.groupId}.`,
      );
    }
  }

  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();
  const memberIds = memberRequestIds;

  db.transaction((tx) => {
    tx.insert(mergeRequestGroups)
      .values({
        id,
        projectId: params.projectId,
        resource,
        state: "forming",
        submittedBy: params.submittedBy,
        integratorId: null,
        resolvedAt: null,
        resolutionReason: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // PIN D: atomic claim. WHERE-guarded + rowcount-checked so a member
    // concurrently grouped / dequeued between validation and here fails the
    // whole txn (rolls back the group insert → 409), with no partial writes.
    const result = tx
      .update(mergeRequests)
      .set({ groupId: id, updatedAt: now })
      .where(
        and(
          inArray(mergeRequests.id, memberIds),
          sql`${mergeRequests.groupId} IS NULL`,
          eq(mergeRequests.status, "queued"),
        ),
      )
      .run();

    if (result.changes !== memberIds.length) {
      throw new AppError(
        409,
        "ALREADY_GROUPED",
        "One or more members could not be atomically claimed (concurrently grouped or dequeued).",
      );
    }
  });

  return withMembers(readGroupOrThrow(id));
}

/**
 * Get a group by id with its members (ordered by enqueuedAt asc).
 * 404 if missing.
 */
export function getById(id: string): GroupWithMembers {
  return withMembers(readGroupOrThrow(id));
}

/**
 * List groups for a project, optionally filtered by state/resource,
 * ordered by createdAt asc. 404 if the project is missing.
 */
export function list(projectId: string, params: ListGroupsParams = {}): MergeRequestGroupView[] {
  ensureProjectExists(projectId);
  const db = getDb();

  const conditions = [eq(mergeRequestGroups.projectId, projectId)];
  if (params.state) conditions.push(eq(mergeRequestGroups.state, params.state));
  if (params.resource) {
    conditions.push(eq(mergeRequestGroups.resource, params.resource));
  }

  const rows = db
    .select()
    .from(mergeRequestGroups)
    .where(and(...conditions))
    .orderBy(asc(mergeRequestGroups.createdAt))
    .all() as MergeGroupRow[];

  return rows.map(toGroupView);
}

/**
 * Integrator pickup of the whole group — forming → integrating (§3.3).
 *
 * Authz: integrator (actor.type === "ai_agent").
 *
 * PIN C: this is the SOLE owner of the member queued → integrating flip. In
 * one txn it sets the group state + integratorId AND flips every queued
 * member to integrating. Step 7's group route must call this ONCE and must
 * NOT also call the per-request transitionToIntegrating — there is NO
 * per-member merge.request.integrating event on group pickup; visibility is
 * the single MERGE_GROUP_STARTED event.
 */
export function markIntegrating(
  id: string,
  actor: Actor,
  opts: { integratorId?: string } = {},
): GroupWithMembers {
  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only integrator (ai_agent) users may pick up a merge group.",
    );
  }

  const row = readGroupOrThrow(id);
  assertCanTransition(row.state, "markIntegrating", id);

  const integratorId = opts.integratorId ?? actor.id;
  const db = getDb();
  const now = new Date().toISOString();

  db.transaction((tx) => {
    tx.update(mergeRequestGroups)
      .set({ state: "integrating", integratorId, updatedAt: now })
      .where(eq(mergeRequestGroups.id, id))
      .run();

    tx.update(mergeRequests)
      .set({ status: "integrating", pickedUpAt: now, updatedAt: now })
      .where(and(eq(mergeRequests.groupId, id), eq(mergeRequests.status, "queued")))
      .run();
  });

  const updated = readGroupOrThrow(id);
  const members = readMembers(id);
  emit(EVENT_NAMES.MERGE_GROUP_STARTED, updated, actor.id, {
    groupId: id,
    resource: updated.resource,
    memberCount: members.length,
    memberRequestIds: members.map((m) => m.id),
  });
  return { ...toGroupView(updated), members: members.map(toMemberView) };
}

/**
 * Stranded-GROUP recovery reset — integrating → forming (§9 finding 2 / §6.4).
 *
 * The §6.4 crash-between-PUSH-1-and-incident-write window leaves a group
 * `integrating` with NO incident: the inner pushed, the integrator died before
 * §6.5 could open the incident, so PM never recorded an orphan. resetGroup is
 * the SOLE mechanism that recovers that window: in ONE db.transaction it sets
 * the group back to `forming` (clearing integratorId) AND resets every
 * `integrating` member back to `queued` (clearing pickedUpAt) — atomically, so
 * the recovery NEVER leaves a half-integrating group (the §9-finding-2
 * invariant: group + members reset together). On re-integration the inner
 * re-push is a fast-forward no-op (inner main is already at Ri) and the outer
 * push completes the atom (or, if it fails again while alive, §6.5 opens the
 * incident synchronously).
 *
 * Authz: integrator (actor.type === "ai_agent").
 *
 * CRITICAL GUARD (the corruption fence): resetGroup refuses any group that is
 * NOT `integrating` (terminal / partial / forming all 409 or no-op via
 * assertCanTransition), AND refuses an integrating group that has an OPEN
 * `orphaned_inner` incident. A `partially_landed` group, or an integrating
 * group with an open incident, is a REAL orphan handled by §7 recovery —
 * resetting it would corrupt the cross-repo atom (re-queue an already-landed
 * inner member). Only a genuinely-stranded `integrating` group with NO open
 * incident is reset. The integrator-side reclaim (recovery.ts) likewise only
 * calls this for integrating groups it has confirmed have no open incident; this
 * server guard is the defense-in-depth backstop.
 *
 * LEAN: no SSE event — the reset is an internal recovery action, not a
 * lifecycle transition observers track. (A dedicated MERGE_GROUP_RESET could be
 * emitted, but the design pins "no new event" as the default.)
 */
export function resetGroup(
  id: string,
  actor: Actor,
  opts: { reason?: string } = {},
): GroupWithMembers {
  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only integrator (ai_agent) users may reset a merge group.",
    );
  }

  const row = readGroupOrThrow(id);
  const result = assertCanTransition(row.state, "reset", id);
  if (result.kind === "idempotent_noop") {
    // Already forming (a re-run after a successful reset). Nothing to do.
    return withMembers(row);
  }

  // CORRUPTION FENCE: an integrating group with an OPEN orphaned_inner incident
  // is a REAL orphan (§6.5 ran), recovered by §7 rollforward — NEVER reset it.
  const db = getDb();
  const openIncident = db
    .select({ id: mergeIncidents.id })
    .from(mergeIncidents)
    .where(and(eq(mergeIncidents.groupId, id), eq(mergeIncidents.state, "open")))
    .get();
  if (openIncident) {
    throw new AppError(
      409,
      "INVALID_TRANSITION",
      `Cannot reset merge group ${id}: it has an open incident (${openIncident.id}); this is a real orphan recovered by rollforward, not a stranded group.`,
    );
  }

  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.update(mergeRequestGroups)
      .set({
        state: "forming",
        integratorId: null,
        resolutionReason: opts.reason ?? null,
        updatedAt: now,
      })
      .where(eq(mergeRequestGroups.id, id))
      .run();

    // Reset every integrating member back to queued (clear pickedUpAt) — the
    // group + members reset together (the §9-finding-2 invariant).
    tx.update(mergeRequests)
      .set({ status: "queued", pickedUpAt: null, updatedAt: now })
      .where(and(eq(mergeRequests.groupId, id), eq(mergeRequests.status, "integrating")))
      .run();
  });

  return withMembers(readGroupOrThrow(id));
}

/**
 * Atomic clean-land — integrating → landed (§6.6/§6.7, the G1 clean-land
 * path). Lands every member (status landed, landedSha, git_ref per member
 * via the shared attachLandedRef helper) and sets the group landed, all in
 * one txn. Member states are written DIRECTLY here — never via the public
 * merge-request land() — to avoid a nested transaction.
 *
 * Authz: integrator (actor.type === "ai_agent"). landed → idempotent noop.
 *
 * emit-after-commit: per-member { requestId, landedSha, gitRefId } is
 * accumulated OUTSIDE the txn closure, then emitted AFTER commit — one
 * MERGE_GROUP_MEMBER_LANDED per member, then one MERGE_GROUP_LANDED.
 */
export function landGroup(
  id: string,
  body: { members: LandGroupMember[] },
  actor: Actor,
): GroupWithMembers {
  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only integrator (ai_agent) users may land a merge group.",
    );
  }

  const row = readGroupOrThrow(id);
  const result = assertCanTransition(row.state, "land", id);
  if (result.kind === "idempotent_noop") {
    return withMembers(row);
  }

  const now = new Date().toISOString();
  const landed: Array<{
    requestId: string;
    landedSha: string;
    role?: string;
    gitRefId: string | null;
  }> = [];
  // Phase 7.4 §2.5: one `land` audit row per landed member, written inside
  // the SAME txn (additive, INSERT-only). Accumulated here, emitted per-member
  // after commit (mirroring the MERGE_GROUP_MEMBER_LANDED loop).
  const auditViews: AuditLogView[] = [];

  const db = getDb();
  db.transaction((tx) => {
    for (const m of body.members) {
      const member = tx
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, m.requestId))
        .get() as MergeRequestRow | undefined;
      if (!member) {
        throw new AppError(404, "NOT_FOUND", `Merge request not found: ${m.requestId}`);
      }
      if (member.groupId !== id) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `Merge request ${m.requestId} is not a member of group ${id}.`,
        );
      }

      tx.update(mergeRequests)
        .set({
          status: "landed",
          resolvedAt: now,
          landedSha: m.landedSha,
          updatedAt: now,
        })
        .where(eq(mergeRequests.id, m.requestId))
        .run();

      const gitRefId = attachLandedRef(tx, {
        requestId: m.requestId,
        taskId: member.taskId,
        landedSha: m.landedSha,
        resource: member.resource,
        now,
      });

      const before = { status: "integrating", landedSha: null };
      const after = { status: "landed", landedSha: m.landedSha };
      const auditId = recordAudit(tx, {
        projectId: member.projectId,
        actorId: actor.id,
        action: "land",
        targetType: "merge_request",
        targetId: m.requestId,
        reason: null,
        before,
        after,
        now,
      });
      auditViews.push({
        id: auditId,
        projectId: member.projectId,
        actorId: actor.id,
        action: "land",
        targetType: "merge_request",
        targetId: m.requestId,
        reason: null,
        metadataBefore: before,
        metadataAfter: after,
        createdAt: now,
      });

      landed.push({
        requestId: m.requestId,
        landedSha: m.landedSha,
        role: m.role,
        gitRefId,
      });
    }

    tx.update(mergeRequestGroups)
      .set({ state: "landed", resolvedAt: now, updatedAt: now })
      .where(eq(mergeRequestGroups.id, id))
      .run();
  });

  const updated = readGroupOrThrow(id);

  // Emit AFTER commit — per-member audit, then per-member landed events,
  // then the group landed.
  for (const av of auditViews) {
    emitAuditRecorded(av.id, av.projectId, actor.id, av);
  }
  for (const m of landed) {
    emit(EVENT_NAMES.MERGE_GROUP_MEMBER_LANDED, updated, actor.id, {
      groupId: id,
      requestId: m.requestId,
      role: m.role ?? null,
      landedSha: m.landedSha,
      gitRefId: m.gitRefId,
    });
  }
  // Derive inner/outer landed SHAs from role tags when supplied; else carry
  // the member sha list.
  const inner = landed.find((m) => m.role === "inner");
  const outer = landed.find((m) => m.role === "outer");
  emit(EVENT_NAMES.MERGE_GROUP_LANDED, updated, actor.id, {
    groupId: id,
    ...(inner ? { innerLandedSha: inner.landedSha } : {}),
    ...(outer ? { outerLandedSha: outer.landedSha } : {}),
    members: landed.map((m) => ({
      requestId: m.requestId,
      role: m.role ?? null,
      landedSha: m.landedSha,
    })),
  });

  return withMembers(updated);
}

/**
 * Reject the whole group — forming → rejected OR integrating → rejected
 * (§6.3/§6.6). Every non-terminal member (queued or integrating) is rejected
 * in the same txn; the group is set rejected. Member states written directly
 * (no nested merge-request reject()).
 *
 * Authz: integrator (ai_agent) OR admin OR the submitter (mirrors the
 * cancel/forceCancel split). rejected → idempotent noop.
 */
export function rejectGroup(
  id: string,
  body: { reason: string; category?: string },
  actor: Actor,
): GroupWithMembers {
  const row = readGroupOrThrow(id);

  const isIntegrator = actor.type === "ai_agent";
  const isAdmin = actor.role === "admin";
  const isSubmitter = actor.id === row.submittedBy;
  if (!isIntegrator && !isAdmin && !isSubmitter) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only the submitter, an admin, or the integrator may reject this merge group.",
    );
  }

  const result = assertCanTransition(row.state, "reject", id);
  if (result.kind === "idempotent_noop") {
    return withMembers(row);
  }

  const db = getDb();
  const now = new Date().toISOString();

  // Phase 7.4 §2.5: read the non-terminal members BEFORE the bulk reject so
  // we can write one `reject` audit row per affected member (additive,
  // INSERT-only, inside the same txn). Emitted after commit.
  const affectedMembers = db
    .select()
    .from(mergeRequests)
    .where(
      and(eq(mergeRequests.groupId, id), inArray(mergeRequests.status, ["queued", "integrating"])),
    )
    .all() as MergeRequestRow[];
  const auditViews: AuditLogView[] = [];

  db.transaction((tx) => {
    tx.update(mergeRequests)
      .set({
        status: "rejected",
        resolvedAt: now,
        rejectReason: body.reason,
        ...(body.category ? { rejectCategory: body.category } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(mergeRequests.groupId, id),
          inArray(mergeRequests.status, ["queued", "integrating"]),
        ),
      )
      .run();

    for (const member of affectedMembers) {
      const before = { status: member.status };
      const after = {
        status: "rejected",
        ...(body.category ? { rejectCategory: body.category } : {}),
      };
      const auditId = recordAudit(tx, {
        projectId: member.projectId,
        actorId: actor.id,
        action: "reject",
        targetType: "merge_request",
        targetId: member.id,
        reason: null,
        before,
        after,
        now,
      });
      auditViews.push({
        id: auditId,
        projectId: member.projectId,
        actorId: actor.id,
        action: "reject",
        targetType: "merge_request",
        targetId: member.id,
        reason: null,
        metadataBefore: before,
        metadataAfter: after,
        createdAt: now,
      });
    }

    tx.update(mergeRequestGroups)
      .set({
        state: "rejected",
        resolvedAt: now,
        resolutionReason: body.reason,
        updatedAt: now,
      })
      .where(eq(mergeRequestGroups.id, id))
      .run();
  });

  const updated = readGroupOrThrow(id);
  for (const av of auditViews) {
    emitAuditRecorded(av.id, av.projectId, actor.id, av);
  }
  emit(EVENT_NAMES.MERGE_GROUP_REJECTED, updated, actor.id, {
    groupId: id,
    outcome: "rejected",
    reason: body.reason,
  });
  return withMembers(updated);
}

/**
 * Outer-push-fail-after-inner-land — integrating → partially_landed (§6.5).
 * Sets the GROUP ROW only; member states are set by markInnerOrphaned (inner)
 * and the outer-member reject, both sequenced by Step 7. The orphaned-inner
 * incident itself is opened by Step 6 (merge-incident.service).
 *
 * Authz: integrator (ai_agent). partially_landed → idempotent noop.
 *
 * Reuses MERGE_GROUP_REJECTED with an `outcome: "partially_landed"`
 * discriminator (§10.2) — NOT a 5th event name.
 */
export function markPartiallyLanded(
  id: string,
  body: { reason: string; incidentId?: string },
  actor: Actor,
): GroupWithMembers {
  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only integrator (ai_agent) users may mark a merge group partially landed.",
    );
  }

  const row = readGroupOrThrow(id);
  const result = assertCanTransition(row.state, "markPartiallyLanded", id);
  if (result.kind === "idempotent_noop") {
    return withMembers(row);
  }

  const db = getDb();
  const now = new Date().toISOString();

  db.transaction((tx) => {
    tx.update(mergeRequestGroups)
      .set({
        state: "partially_landed",
        resolvedAt: now,
        resolutionReason: body.reason,
        updatedAt: now,
      })
      .where(eq(mergeRequestGroups.id, id))
      .run();
  });

  const updated = readGroupOrThrow(id);
  emit(EVENT_NAMES.MERGE_GROUP_REJECTED, updated, actor.id, {
    groupId: id,
    outcome: "partially_landed",
    reason: body.reason,
    ...(body.incidentId ? { incidentId: body.incidentId } : {}),
  });
  return withMembers(updated);
}

/**
 * Set the inner member to the `orphaned` outcome — member integrating →
 * orphaned (§6.5 step 1; a group-land-FAMILY operation, so it does not
 * contend with G1's `landed` reservation). Does NOT open the incident
 * (Step 6) and does NOT emit a member_landed event — the orphan surfaces via
 * the incident.
 *
 * Authz: integrator (ai_agent). Guard: the request must be a group member
 * (group_id != null, 409) and currently integrating (409).
 */
export function markInnerOrphaned(
  innerRequestId: string,
  orphanedSha: string,
  actor: Actor,
): MergeRequestView {
  if (actor.type !== "ai_agent") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only integrator (ai_agent) users may orphan an inner merge request.",
    );
  }

  const row = readRequest(innerRequestId);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Merge request not found: ${innerRequestId}`);
  }
  if (row.groupId === null) {
    throw new AppError(
      409,
      "INVALID_TRANSITION",
      `Merge request ${innerRequestId} is not a group member; cannot orphan it.`,
    );
  }
  if (row.status !== "integrating") {
    throw new AppError(
      409,
      "INVALID_TRANSITION",
      `Cannot orphan merge request ${innerRequestId} from state "${row.status}".`,
    );
  }

  const db = getDb();
  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.update(mergeRequests)
      .set({
        status: "orphaned",
        resolvedAt: now,
        landedSha: orphanedSha,
        updatedAt: now,
      })
      .where(eq(mergeRequests.id, innerRequestId))
      .run();
  });

  return toMemberView(readRequest(innerRequestId)!);
}

/**
 * G1 guard helper for Step 7's per-request land route (§3.4 / §6.7). A
 * grouped member (group_id != null) MUST NOT be landed independently — it
 * lands only via its group's atomic land. Step 7 calls this BEFORE
 * merge-request.service.land(). Step 5 only EXPOSES the check; it does NOT
 * modify merge-request.service.land().
 */
export function assertMemberLandableViaGroup(requestId: string): void {
  const row = readRequest(requestId);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Merge request not found: ${requestId}`);
  }
  if (row.groupId !== null) {
    throw new AppError(
      409,
      "GROUPED_MEMBER",
      `Merge request ${requestId} is a group member and cannot be landed independently; land via its group.`,
    );
  }
}

/**
 * Force-land variant of the group guard (C2 — failure legibility). The
 * break-glass force-land is allowed to reach INTO a group, but ONLY when the
 * group itself is terminal (rejected / partially_landed) — i.e. the train is
 * done with it and a stuck member can only be recovered by a human. A live
 * group (forming / integrating) or an already-landed group still 409s exactly
 * like `assertMemberLandableViaGroup` (land via the group / nothing to fix).
 *
 * Returns a discriminated result so the caller can branch its status matrix:
 *   { kind: "non_grouped" }                       — plain request, today's path.
 *   { kind: "grouped_terminal", groupId, groupState } — terminal-group member.
 * Throws 404 when the request is missing; 409 GROUPED_MEMBER (with the group
 * state in the message) when the group is non-terminal-or-landed.
 */
export type ForceLandGroupCheck =
  | { kind: "non_grouped" }
  | {
      kind: "grouped_terminal";
      groupId: string;
      groupState: "rejected" | "partially_landed";
    };

export function assertForceLandableViaGroup(requestId: string): ForceLandGroupCheck {
  const row = readRequest(requestId);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", `Merge request not found: ${requestId}`);
  }
  if (row.groupId === null) {
    return { kind: "non_grouped" };
  }
  const group = readGroupOrThrow(row.groupId);
  if (group.state === "rejected" || group.state === "partially_landed") {
    return {
      kind: "grouped_terminal",
      groupId: group.id,
      groupState: group.state,
    };
  }
  throw new AppError(
    409,
    "GROUPED_MEMBER",
    `Merge request ${requestId} is a member of group ${group.id} in state ` +
      `"${group.state}"; force-land only applies to members of terminal groups ` +
      `(rejected/partially_landed) — land via the group instead.`,
  );
}
