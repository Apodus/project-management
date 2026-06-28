import { eq, and, isNull, or } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  PROPOSAL_TRANSITION_MAP,
  type ClaimState,
  type ClaimStatus,
  type ClaimResult,
  type ProposalKind,
  type ProposalStatus,
  type UserType,
} from "@pm/shared";
import { getDb, projects, proposals, comments, epics, tasks, users } from "../db/index.js";
import { AppError } from "../types.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";
import {
  assertClaimOk as assertClaimOkRaw,
  deriveClaimStatus,
  deriveClaimState,
  forceClaim as forceClaimShared,
  releaseTo as releaseToShared,
  requestTakeover as requestTakeoverShared,
  type Actor as ClaimActor,
  type ClaimFilter as ClaimFilterShared,
  type ForceClaimConfig,
  type ForceClaimResult,
  type ReleaseToResult,
  type RequestTakeoverResult,
} from "./claim-helpers.js";
import {
  acquireLease,
  deleteLease,
  readLease,
  readLeasesFor,
  sweepStaleClaims,
  type ClaimLeaseRow,
} from "./claim-lease.service.js";

export { deriveClaimStatus } from "./claim-helpers.js";

// ─── Types ────────────────────────────────────────────────────────

export interface CreateProposalInput {
  title: string;
  description?: string | null;
  createdBy: string;
  sourceNoteId?: string | null;
  proposalKind?: ProposalKind;
}

export interface UpdateProposalInput {
  title?: string;
  description?: string | null;
}

export interface AddCommentInput {
  authorId: string;
  body: string;
  commentType?: string;
}

export interface EpicInput {
  name: string;
  description?: string | null;
  priority?: string;
  status?: string;
}

export interface TaskInput {
  title: string;
  description?: string | null;
  priority?: string;
  type?: string;
  epicIndex?: number; // index into the epics array to link to
}

export type Actor = ClaimActor;
export type ClaimFilter = ClaimFilterShared;

// ─── Claim helpers ────────────────────────────────────────────────

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "rejected"]);

/**
 * Decorate a proposal row with claim_status AND claim_state derived from the
 * caller. Proposals use `claimedBy` as the claim-holder field.
 *
 * `claimState` (C3.P1) folds in the C2 lease liveness; `lease`/`now` are optional
 * so existing `(row, caller)` call sites keep working (absent → fresh `now` + null
 * lease → fail-safe-to-live). The `claimStatus` value is unchanged (additive).
 */
export function withClaimStatus<T extends { claimedBy?: string | null }>(
  row: T,
  caller?: { id: string } | null,
  lease?: ClaimLeaseRow | null,
  now?: Date,
): T & { claimStatus: ClaimStatus; claimState: ClaimState } {
  return {
    ...row,
    claimStatus: deriveClaimStatus(row.claimedBy ?? null, caller),
    claimState: deriveClaimState(row.claimedBy ?? null, lease ?? null, now ?? new Date(), caller),
  };
}

/**
 * Enforce that an AI agent has the claim on a proposal before writing.
 * Humans always pass. AI agents must hold the claim — unclaimed proposals also
 * reject AI-agent writes (they must call `claim()` first).
 */
export function assertClaimOk(
  proposal: { id: string; claimedBy?: string | null },
  actor: Actor,
): void {
  assertClaimOkRaw(proposal.claimedBy ?? null, actor, "proposal", "proposal", proposal.id);
}

// ─── Service functions ────────────────────────────────────────────

/**
 * List proposals for a project, with optional status filter and a claim filter.
 * The `claim` filter narrows by claim ownership relative to the caller:
 *   - "available": unclaimed OR claimed by the caller
 *   - "mine":      claimed by the caller
 *   - "all":       no claim restriction (default)
 */
export function list(
  projectId: string,
  filters?: { status?: string; claim?: ClaimFilter },
  caller?: { id: string } | null,
) {
  const db = getDb();
  const conditions = [eq(proposals.projectId, projectId)];

  if (filters?.status) {
    conditions.push(eq(proposals.status, filters.status));
  }

  if (filters?.claim && filters.claim !== "all" && caller) {
    if (filters.claim === "mine") {
      conditions.push(eq(proposals.claimedBy, caller.id));
    } else {
      // available
      const availClause = or(isNull(proposals.claimedBy), eq(proposals.claimedBy, caller.id));
      if (availClause) conditions.push(availClause);
    }
  }

  const rows = db
    .select()
    .from(proposals)
    .where(and(...conditions))
    .all();

  const leases = readLeasesFor(
    "proposal",
    rows.map((r) => r.id),
  );
  const now = new Date();

  return rows.map((row) => withClaimStatus(row, caller, leases.get(row.id) ?? null, now));
}

/**
 * Get a single proposal by ID with comments and linked work items.
 * Throws 404 if not found.
 */
export function getById(id: string, caller?: { id: string } | null) {
  const db = getDb();
  const proposal = db.select().from(proposals).where(eq(proposals.id, id)).get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${id}`);
  }

  const proposalComments = db.select().from(comments).where(eq(comments.proposalId, id)).all();

  const linkedEpics = db.select().from(epics).where(eq(epics.proposalId, id)).all();

  const linkedTasks = db.select().from(tasks).where(eq(tasks.proposalId, id)).all();

  return {
    ...withClaimStatus(proposal, caller, readLease("proposal", proposal.id), new Date()),
    comments: proposalComments,
    workItems: {
      epics: linkedEpics,
      tasks: linkedTasks,
    },
  };
}

/**
 * Create a new proposal.
 * Validates that the project exists.
 */
export function create(projectId: string, data: CreateProposalInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();

  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }

  db.insert(proposals)
    .values({
      id,
      projectId,
      title: data.title,
      description: data.description ?? null,
      status: "open",
      proposalKind: data.proposalKind ?? "standard",
      createdBy: data.createdBy,
      sourceNoteId: data.sourceNoteId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const result = db.select().from(proposals).where(eq(proposals.id, id)).get()!;

  getEventBus().emit(EVENT_NAMES.PROPOSAL_CREATED, {
    entity: result,
    entityType: "proposal",
    entityId: id,
    projectId,
    actorId: data.createdBy,
    timestamp: now,
  });

  return result;
}

/**
 * Update a proposal's title/description.
 * Throws 404 if not found.
 */
export function update(id: string, data: UpdateProposalInput) {
  const db = getDb();

  const existing = db.select().from(proposals).where(eq(proposals.id, id)).get();

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${id}`);
  }

  const now = new Date().toISOString();
  const values: Record<string, unknown> = { updatedAt: now };

  if (data.title !== undefined) values.title = data.title;
  if (data.description !== undefined) values.description = data.description;

  db.update(proposals).set(values).where(eq(proposals.id, id)).run();

  return db.select().from(proposals).where(eq(proposals.id, id)).get()!;
}

/**
 * Claim a proposal for an actor. Atomic via WHERE claimed_by IS NULL.
 * Idempotent for the holder (returns already_claimed_by_you).
 * Returns a ClaimResult — no IDs leaked.
 */
export function claim(id: string, actor: Actor): ClaimResult {
  const db = getDb();
  const proposal = db.select().from(proposals).where(eq(proposals.id, id)).get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${id}`);
  }

  // Opportunistic single-entity sweep (shadow no-op in production).
  sweepStaleClaims({ entityType: "proposal", entityId: id });

  if (TERMINAL_STATUSES.has(proposal.status)) {
    return { ok: false, status: "closed" };
  }

  if (proposal.claimedBy === actor.id) {
    // Idempotent re-claim re-arms the lease for a legacy/lapsed holder.
    acquireLease("proposal", id, { id: actor.id });
    return { ok: true, status: "already_claimed_by_you" };
  }

  if (proposal.claimedBy && proposal.claimedBy !== actor.id) {
    return { ok: false, status: "claimed_by_another_agent" };
  }

  const now = new Date().toISOString();
  const update = db
    .update(proposals)
    .set({ claimedBy: actor.id, updatedAt: now })
    .where(and(eq(proposals.id, id), isNull(proposals.claimedBy)))
    .run();

  if (update.changes === 0) {
    // Someone else won the race in between our SELECT and UPDATE.
    return { ok: false, status: "claimed_by_another_agent" };
  }

  const fresh = db.select().from(proposals).where(eq(proposals.id, id)).get()!;

  // Establish the lease for the new holder.
  acquireLease("proposal", id, { id: actor.id });

  getEventBus().emit(EVENT_NAMES.PROPOSAL_CLAIMED, {
    entity: fresh,
    entityType: "proposal",
    entityId: id,
    projectId: proposal.projectId,
    actorId: actor.id,
    timestamp: now,
    changes: { claimed_by: { from: null, to: actor.id } },
  });

  return { ok: true, status: "claimed_by_you" };
}

/**
 * Release a claim. Humans can release any claim; AI agents only their own.
 */
export function release(id: string, actor: Actor): ClaimResult {
  const db = getDb();
  const proposal = db.select().from(proposals).where(eq(proposals.id, id)).get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${id}`);
  }

  if (!proposal.claimedBy) {
    return { ok: false, status: "not_held" };
  }

  if (actor.type === "ai_agent" && proposal.claimedBy !== actor.id) {
    return { ok: false, status: "claimed_by_another_agent" };
  }

  const now = new Date().toISOString();
  const previousClaimant = proposal.claimedBy;
  db.update(proposals).set({ claimedBy: null, updatedAt: now }).where(eq(proposals.id, id)).run();

  // The holder is gone — tear down the lease.
  deleteLease("proposal", id);

  const fresh = db.select().from(proposals).where(eq(proposals.id, id)).get()!;

  getEventBus().emit(EVENT_NAMES.PROPOSAL_RELEASED, {
    entity: fresh,
    entityType: "proposal",
    entityId: id,
    projectId: proposal.projectId,
    actorId: actor.id,
    timestamp: now,
    changes: { claimed_by: { from: previousClaimant, to: null } },
  });

  return { ok: true, status: "released" };
}

/**
 * Force-claim (take over) a proposal claim — reason-required + audited.
 * Delegates to the shared helper (the DRY home for the authz/reason/audit
 * logic). The proposal holds its claim in `claimedBy` (vs assigneeId for
 * task/epic).
 */
const PROPOSAL_HANDOFF_CFG: ForceClaimConfig = {
  table: proposals,
  holderKey: "claimedBy",
  holderJsonKey: "claimed_by",
  terminalStatuses: TERMINAL_STATUSES,
  eventName: EVENT_NAMES.PROPOSAL_CLAIM_FORCED,
  entityType: "proposal",
};

export function forceClaim(
  id: string,
  actor: Actor,
  opts: { reason: string; newAssigneeId?: string | null },
): ForceClaimResult {
  return forceClaimShared(id, actor, opts, PROPOSAL_HANDOFF_CFG);
}

/**
 * release-to — hand this proposal's claim to a named worker (audited). The
 * holder (or a human) may release to another worker. Delegates to the shared
 * helper.
 */
export function releaseTo(
  id: string,
  actor: Actor,
  opts: { reason: string; targetId: string },
): ReleaseToResult {
  return releaseToShared(id, actor, opts, PROPOSAL_HANDOFF_CFG);
}

/**
 * request-takeover — ask to take over this proposal's claim (stomp-safe). A
 * stale claim auto-grants to the requester; a live claim only notifies its
 * holder.
 */
export function requestTakeover(
  id: string,
  actor: Actor,
  opts: { reason: string },
): RequestTakeoverResult {
  return requestTakeoverShared(id, actor, opts, PROPOSAL_HANDOFF_CFG);
}

/**
 * Transition a proposal to a new status.
 * - Validates the transition is allowed per PROPOSAL_TRANSITION_MAP
 * - Validates the actor's user type is allowed for this transition
 * - Enforces claim ownership for AI agents
 * - If transitioning to accepted/rejected, sets resolved_by and resolved_at
 * - If transitioning to a terminal state (completed/rejected), clears claimed_by
 * - Updates status and updated_at
 */
export function transition(id: string, toStatus: ProposalStatus, actor: Actor) {
  const db = getDb();

  const proposal = db.select().from(proposals).where(eq(proposals.id, id)).get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${id}`);
  }

  const fromStatus = proposal.status as ProposalStatus;

  const rule = PROPOSAL_TRANSITION_MAP.get(`${fromStatus}->${toStatus}`);
  if (!rule) {
    throw new AppError(
      400,
      "INVALID_TRANSITION",
      `Cannot transition proposal from "${fromStatus}" to "${toStatus}"`,
    );
  }

  if (!rule.allowedBy.includes(actor.type)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      `User type "${actor.type}" is not allowed to transition proposal from "${fromStatus}" to "${toStatus}"`,
    );
  }

  assertClaimOk(proposal, actor);

  const now = new Date().toISOString();
  const values: Record<string, unknown> = {
    status: toStatus,
    updatedAt: now,
  };

  if (toStatus === "accepted" || toStatus === "rejected") {
    values.resolvedBy = actor.id;
    values.resolvedAt = now;
  }

  const goesTerminal = TERMINAL_STATUSES.has(toStatus);
  if (goesTerminal) {
    values.claimedBy = null;
  }

  db.update(proposals).set(values).where(eq(proposals.id, id)).run();

  // Terminal status (completed/rejected) clears the holder above — tear down
  // the lease to match.
  if (goesTerminal) {
    deleteLease("proposal", id);
  }

  const result = db.select().from(proposals).where(eq(proposals.id, id)).get()!;

  getEventBus().emit(EVENT_NAMES.PROPOSAL_TRANSITIONED, {
    entity: result,
    entityType: "proposal",
    entityId: id,
    projectId: proposal.projectId,
    actorId: actor.id,
    timestamp: now,
    changes: { status: { from: fromStatus, to: toStatus } },
    previousStatus: fromStatus,
  });

  return result;
}

/**
 * Add a comment to a proposal.
 * If proposal status is "open", a comment by ANYONE (human or AI agent)
 * auto-transitions it to "discussing" so the proposal can be carried forward.
 * An AI-agent commenter must already hold the claim (enforced by assertClaimOk).
 */
export function addComment(proposalId: string, data: AddCommentInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const commentId = createId();

  const proposal = db.select().from(proposals).where(eq(proposals.id, proposalId)).get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${proposalId}`);
  }

  const author = db.select().from(users).where(eq(users.id, data.authorId)).get();

  if (author) {
    assertClaimOk(proposal, { id: author.id, type: author.type as UserType });
  }

  db.insert(comments)
    .values({
      id: commentId,
      proposalId,
      authorId: data.authorId,
      body: data.body,
      commentType: data.commentType ?? "comment",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Auto-transition: any comment on an "open" proposal (human OR AI agent) moves
  // it to "discussing", so commenting is enough to carry the proposal forward.
  const autoTransitioned = proposal.status === "open" && !!author;
  if (autoTransitioned) {
    db.update(proposals)
      .set({ status: "discussing", updatedAt: now })
      .where(eq(proposals.id, proposalId))
      .run();
  }

  const comment = db.select().from(comments).where(eq(comments.id, commentId)).get()!;

  // Broadcast so idle proposal views update live (SSE → query invalidation).
  // Previously addComment emitted NOTHING, so neither the new comment nor the
  // open→discussing auto-transition reached the client — the view stayed stale.
  const bus = getEventBus();
  bus.emit(EVENT_NAMES.PROPOSAL_COMMENTED, {
    entity: comment,
    entityType: "comment",
    entityId: commentId,
    projectId: proposal.projectId,
    actorId: data.authorId,
    timestamp: now,
  });
  if (autoTransitioned) {
    const updated = db.select().from(proposals).where(eq(proposals.id, proposalId)).get()!;
    bus.emit(EVENT_NAMES.PROPOSAL_TRANSITIONED, {
      entity: updated,
      entityType: "proposal",
      entityId: proposalId,
      projectId: proposal.projectId,
      actorId: data.authorId,
      timestamp: now,
      changes: { status: { from: "open", to: "discussing" } },
      previousStatus: "open",
    });
  }

  return comment;
}

/**
 * List comments for a proposal.
 */
export function listComments(proposalId: string) {
  const db = getDb();

  const proposal = db.select().from(proposals).where(eq(proposals.id, proposalId)).get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${proposalId}`);
  }

  return db.select().from(comments).where(eq(comments.proposalId, proposalId)).all();
}

/**
 * List epics and tasks spawned from this proposal.
 */
export function getWorkItems(proposalId: string) {
  const db = getDb();

  const proposal = db.select().from(proposals).where(eq(proposals.id, proposalId)).get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${proposalId}`);
  }

  const linkedEpics = db.select().from(epics).where(eq(epics.proposalId, proposalId)).all();

  const linkedTasks = db.select().from(tasks).where(eq(tasks.proposalId, proposalId)).all();

  return {
    epics: linkedEpics,
    tasks: linkedTasks,
  };
}

/**
 * Implement a proposal by atomically creating epics and tasks from it.
 * 1. Verify proposal is in a planning-eligible status (open/discussing/accepted)
 * 2. AI agents must hold the claim
 * 3. Create epics with proposal_id set
 * 4. Create tasks (under epics or standalone) with proposal_id set
 * 5. Transition proposal to "in_progress"
 * 6. Add a summary comment
 * All in a single transaction.
 */
export function implementProposal(
  proposalId: string,
  epicInputs: EpicInput[],
  taskInputs: TaskInput[],
  actor: Actor,
) {
  const db = getDb();

  const proposal = db.select().from(proposals).where(eq(proposals.id, proposalId)).get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${proposalId}`);
  }

  const blockedStatuses = ["in_progress", "completed", "rejected"];
  if (blockedStatuses.includes(proposal.status)) {
    throw new AppError(
      400,
      "INVALID_STATUS",
      `Proposal cannot be planned from "${proposal.status}" status. Only open, discussing, or accepted proposals can be planned.`,
    );
  }

  assertClaimOk(proposal, actor);

  const projectId = proposal.projectId;
  if (!projectId) {
    throw new AppError(400, "NO_PROJECT", `Proposal has no project associated`);
  }

  const now = new Date().toISOString();
  const createdEpicIds: string[] = [];
  const createdTaskIds: string[] = [];

  db.transaction((tx) => {
    for (const epicInput of epicInputs) {
      const epicId = createId();
      createdEpicIds.push(epicId);

      tx.insert(epics)
        .values({
          id: epicId,
          projectId,
          proposalId,
          name: epicInput.name,
          description: epicInput.description ?? null,
          status: epicInput.status ?? "draft",
          priority: epicInput.priority ?? "medium",
          createdAt: now,
          updatedAt: now,
          createdBy: actor.id,
        })
        .run();
    }

    for (const taskInput of taskInputs) {
      const taskId = createId();
      createdTaskIds.push(taskId);

      const epicId =
        taskInput.epicIndex !== undefined ? createdEpicIds[taskInput.epicIndex] : undefined;

      tx.insert(tasks)
        .values({
          id: taskId,
          projectId,
          proposalId,
          epicId: epicId ?? null,
          title: taskInput.title,
          description: taskInput.description ?? null,
          status: "backlog",
          priority: taskInput.priority ?? "medium",
          type: taskInput.type ?? "feature",
          reporterId: actor.id,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    tx.update(proposals)
      .set({
        status: "in_progress",
        updatedAt: now,
      })
      .where(eq(proposals.id, proposalId))
      .run();

    const commentId = createId();
    const epicCount = epicInputs.length;
    const taskCount = taskInputs.length;
    const summaryParts: string[] = [];
    if (epicCount > 0) summaryParts.push(`${epicCount} epic(s)`);
    if (taskCount > 0) summaryParts.push(`${taskCount} task(s)`);
    const summaryText = `Proposal planned: created ${summaryParts.join(" and ")}.`;

    tx.insert(comments)
      .values({
        id: commentId,
        proposalId,
        authorId: actor.id,
        body: summaryText,
        commentType: "decision",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  const eventBus = getEventBus();

  for (const epicId of createdEpicIds) {
    const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
    eventBus.emit(EVENT_NAMES.EPIC_CREATED, {
      entity: epic,
      entityType: "epic",
      entityId: epicId,
      projectId,
      actorId: actor.id,
      timestamp: now,
    });
  }

  for (const taskId of createdTaskIds) {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    eventBus.emit(EVENT_NAMES.TASK_CREATED, {
      entity: task,
      entityType: "task",
      entityId: taskId,
      projectId,
      actorId: actor.id,
      timestamp: now,
    });
  }

  const updatedProposal = db.select().from(proposals).where(eq(proposals.id, proposalId)).get()!;

  eventBus.emit(EVENT_NAMES.PROPOSAL_PLANNED, {
    entity: updatedProposal,
    entityType: "proposal",
    entityId: proposalId,
    projectId,
    actorId: actor.id,
    timestamp: now,
    changes: { status: { from: proposal.status, to: "in_progress" } },
  });

  return updatedProposal;
}
