import { eq, and, count, isNull, or } from "drizzle-orm";
import { createId } from "@pm/shared";
import { type ClaimResult, type ClaimStatus } from "@pm/shared";
import { getDb, epics, proposals, tasks } from "../db/index.js";
import { AppError } from "../types.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";
import { assertClaimOk as assertProposalClaimOk } from "./proposal.service.js";
import {
  assertClaimOk as assertClaimOkRaw,
  deriveClaimStatus,
  forceClaim as forceClaimShared,
  type Actor,
  type ClaimFilter,
  type ForceClaimResult,
} from "./claim-helpers.js";
import {
  acquireLease,
  deleteLease,
  sweepStaleClaims,
} from "./claim-lease.service.js";

// ─── Types ────────────────────────────────────────────────────────

export interface CreateEpicInput {
  projectId: string;
  name: string;
  description?: string | null;
  status?: string;
  priority?: string;
  proposalId?: string | null;
  milestoneId?: string | null;
  targetDate?: string | null;
  category?: string | null;
  sortOrder?: number;
  createdBy?: string | null;
}

export interface UpdateEpicInput {
  name?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  proposalId?: string | null;
  milestoneId?: string | null;
  targetDate?: string | null;
  category?: string | null;
  sortOrder?: number;
}

export interface EpicTaskSummary {
  total: number;
  done: number;
  byStatus: Record<string, number>;
}

// ─── Claim helpers ────────────────────────────────────────────────

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled"]);

/**
 * Decorate an epic row with claim_status derived from the caller.
 * Epics use `assigneeId` as the claim-holder field.
 */
function withClaimStatus<T extends { assigneeId?: string | null }>(
  row: T,
  caller?: { id: string } | null,
): T & { claimStatus: ClaimStatus } {
  return {
    ...row,
    claimStatus: deriveClaimStatus(row.assigneeId ?? null, caller),
  };
}

function assertEpicClaimOk(
  epic: { id: string; assigneeId?: string | null },
  actor: Actor,
): void {
  assertClaimOkRaw(epic.assigneeId ?? null, actor, "epic", "epic", epic.id);
}

// ─── Service functions ────────────────────────────────────────────

/**
 * Build the task summary (count by status) for a given epic.
 */
function getTaskSummary(epicId: string): EpicTaskSummary {
  const db = getDb();

  const rows = db
    .select({
      status: tasks.status,
      count: count(),
    })
    .from(tasks)
    .where(eq(tasks.epicId, epicId))
    .groupBy(tasks.status)
    .all();

  const byStatus: Record<string, number> = {};
  let total = 0;
  let done = 0;

  for (const row of rows) {
    byStatus[row.status] = row.count;
    total += row.count;
    if (row.status === "done") {
      done = row.count;
    }
  }

  return { total, done, byStatus };
}

/**
 * List epics for a project, with optional filters.
 * Includes task summary (count by status) and claim_status on each epic.
 * The `claim` filter narrows by claim ownership relative to the caller:
 *   - "available": unclaimed OR claimed by the caller
 *   - "mine":      claimed by the caller
 *   - "all":       no claim restriction (default)
 */
export function list(
  projectId: string,
  filters?: { status?: string; milestone?: string; claim?: ClaimFilter },
  caller?: { id: string } | null,
) {
  const db = getDb();

  const conditions = [eq(epics.projectId, projectId)];

  if (filters?.status) {
    conditions.push(eq(epics.status, filters.status));
  }
  if (filters?.milestone) {
    conditions.push(eq(epics.milestoneId, filters.milestone));
  }

  if (filters?.claim && filters.claim !== "all" && caller) {
    if (filters.claim === "mine") {
      conditions.push(eq(epics.assigneeId, caller.id));
    } else {
      // available
      const availClause = or(
        isNull(epics.assigneeId),
        eq(epics.assigneeId, caller.id),
      );
      if (availClause) conditions.push(availClause);
    }
  }

  const epicList = db
    .select()
    .from(epics)
    .where(and(...conditions))
    .all();

  return epicList.map((epic) =>
    withClaimStatus(
      {
        ...epic,
        taskSummary: getTaskSummary(epic.id),
      },
      caller,
    ),
  );
}

/**
 * Get a single epic by ID with task summary and claim_status. Throws 404 if not found.
 */
export function getById(id: string, caller?: { id: string } | null) {
  const db = getDb();
  const epic = db.select().from(epics).where(eq(epics.id, id)).get();

  if (!epic) {
    throw new AppError(404, "NOT_FOUND", `Epic not found: ${id}`);
  }

  return withClaimStatus(
    {
      ...epic,
      taskSummary: getTaskSummary(epic.id),
    },
    caller,
  );
}

/**
 * Get a raw epic by ID (without task summary). Throws 404 if not found.
 */
function getRawById(id: string) {
  const db = getDb();
  const epic = db.select().from(epics).where(eq(epics.id, id)).get();

  if (!epic) {
    throw new AppError(404, "NOT_FOUND", `Epic not found: ${id}`);
  }

  return epic;
}

/**
 * Create a new epic with auto-generated ID and timestamps.
 * If proposalId is set, the proposal must exist and the actor (if AI agent)
 * must hold the claim — adding work to a claimed proposal is a write that
 * goes through the same gate as comments/transitions.
 */
export function create(
  data: CreateEpicInput,
  actor?: Actor,
) {
  const db = getDb();

  if (data.proposalId) {
    const proposal = db
      .select()
      .from(proposals)
      .where(eq(proposals.id, data.proposalId))
      .get();
    if (!proposal) {
      throw new AppError(
        404,
        "NOT_FOUND",
        `Proposal not found: ${data.proposalId}`,
      );
    }
    if (actor) {
      assertProposalClaimOk(proposal, actor);
    }
  }

  const now = new Date().toISOString();
  const id = createId();

  db.insert(epics)
    .values({
      id,
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      status: data.status ?? "draft",
      priority: data.priority ?? "medium",
      proposalId: data.proposalId ?? null,
      milestoneId: data.milestoneId ?? null,
      targetDate: data.targetDate ?? null,
      category: data.category ?? null,
      sortOrder: data.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
      createdBy: data.createdBy ?? null,
    })
    .run();

  const result = getById(id, actor);

  getEventBus().emit(EVENT_NAMES.EPIC_CREATED, {
    entity: result,
    entityType: "epic",
    entityId: id,
    projectId: data.projectId,
    actorId: data.createdBy ?? null,
    timestamp: now,
  });

  return result;
}

/**
 * Update an epic's fields. Throws 404 if not found, 409 if AI agent
 * doesn't hold the claim. If the new status is terminal (completed/cancelled),
 * the claim is auto-cleared.
 */
export function update(
  id: string,
  data: UpdateEpicInput,
  actor?: Actor,
) {
  const existing = getRawById(id);
  if (actor) assertEpicClaimOk(existing, actor);

  const db = getDb();
  const now = new Date().toISOString();

  const values: Record<string, unknown> = {
    updatedAt: now,
  };

  if (data.name !== undefined) values.name = data.name;
  if (data.description !== undefined) values.description = data.description;
  if (data.status !== undefined) values.status = data.status;
  if (data.priority !== undefined) values.priority = data.priority;
  if (data.proposalId !== undefined) values.proposalId = data.proposalId;
  if (data.milestoneId !== undefined) values.milestoneId = data.milestoneId;
  if (data.targetDate !== undefined) values.targetDate = data.targetDate;
  if (data.category !== undefined) values.category = data.category;
  if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;

  const goesTerminal =
    data.status !== undefined && TERMINAL_STATUSES.has(data.status);
  if (goesTerminal) {
    values.assigneeId = null;
  }

  db.update(epics).set(values).where(eq(epics.id, id)).run();

  // Terminal status clears the holder (above) — tear down the lease to match.
  // (UpdateEpicInput carries no assigneeId field, so there is no direct
  // assignee-PATCH fold-in to mirror here, unlike tasks.)
  if (goesTerminal) {
    deleteLease("epic", id);
  }

  const result = getById(id, actor);

  getEventBus().emit(EVENT_NAMES.EPIC_UPDATED, {
    entity: result,
    entityType: "epic",
    entityId: id,
    projectId: result.projectId,
    actorId: actor?.id ?? null,
    timestamp: now,
  });

  return result;
}

/**
 * Claim an epic for an actor. Atomic via WHERE assignee_id IS NULL.
 * Idempotent for the holder (returns already_claimed_by_you).
 * Returns a ClaimResult — no claimant IDs leaked.
 */
export function claim(id: string, actor: Actor): ClaimResult {
  const db = getDb();
  const epic = db.select().from(epics).where(eq(epics.id, id)).get();

  if (!epic) {
    throw new AppError(404, "NOT_FOUND", `Epic not found: ${id}`);
  }

  // Opportunistic single-entity sweep (shadow no-op in production).
  sweepStaleClaims({ entityType: "epic", entityId: id });

  if (TERMINAL_STATUSES.has(epic.status)) {
    return { ok: false, status: "closed" };
  }

  if (epic.assigneeId === actor.id) {
    // Idempotent re-claim re-arms the lease for a legacy/lapsed holder.
    acquireLease("epic", id, { id: actor.id });
    return { ok: true, status: "already_claimed_by_you" };
  }

  if (epic.assigneeId && epic.assigneeId !== actor.id) {
    return { ok: false, status: "claimed_by_another_agent" };
  }

  const now = new Date().toISOString();
  const update = db
    .update(epics)
    .set({ assigneeId: actor.id, updatedAt: now })
    .where(and(eq(epics.id, id), isNull(epics.assigneeId)))
    .run();

  if (update.changes === 0) {
    return { ok: false, status: "claimed_by_another_agent" };
  }

  const fresh = db.select().from(epics).where(eq(epics.id, id)).get()!;

  // Establish the lease for the new holder.
  acquireLease("epic", id, { id: actor.id });

  getEventBus().emit(EVENT_NAMES.EPIC_CLAIMED, {
    entity: fresh,
    entityType: "epic",
    entityId: id,
    projectId: epic.projectId,
    actorId: actor.id,
    timestamp: now,
    changes: { assignee_id: { from: null, to: actor.id } },
  });

  return { ok: true, status: "claimed_by_you" };
}

/**
 * Release a claim on an epic. Humans can release any claim; AI agents only their own.
 */
export function release(id: string, actor: Actor): ClaimResult {
  const db = getDb();
  const epic = db.select().from(epics).where(eq(epics.id, id)).get();

  if (!epic) {
    throw new AppError(404, "NOT_FOUND", `Epic not found: ${id}`);
  }

  if (!epic.assigneeId) {
    return { ok: false, status: "not_held" };
  }

  if (actor.type === "ai_agent" && epic.assigneeId !== actor.id) {
    return { ok: false, status: "claimed_by_another_agent" };
  }

  const now = new Date().toISOString();
  const previousClaimant = epic.assigneeId;
  db.update(epics)
    .set({ assigneeId: null, updatedAt: now })
    .where(eq(epics.id, id))
    .run();

  // The holder is gone — tear down the lease.
  deleteLease("epic", id);

  const fresh = db.select().from(epics).where(eq(epics.id, id)).get()!;

  getEventBus().emit(EVENT_NAMES.EPIC_RELEASED, {
    entity: fresh,
    entityType: "epic",
    entityId: id,
    projectId: epic.projectId,
    actorId: actor.id,
    timestamp: now,
    changes: { assignee_id: { from: previousClaimant, to: null } },
  });

  return { ok: true, status: "released" };
}

/**
 * Force-claim (take over) an epic claim — reason-required + audited. Delegates
 * to the shared helper (the DRY home for the authz/reason/audit logic).
 */
export function forceClaim(
  id: string,
  actor: Actor,
  opts: { reason: string; newAssigneeId?: string | null },
): ForceClaimResult {
  return forceClaimShared(id, actor, opts, {
    table: epics,
    holderKey: "assigneeId",
    holderJsonKey: "assignee_id",
    terminalStatuses: TERMINAL_STATUSES,
    eventName: EVENT_NAMES.EPIC_CLAIM_FORCED,
    entityType: "epic",
  });
}

/**
 * Archive an epic (set status to "cancelled"). Throws 404 if not found, 409 if
 * AI agent doesn't hold the claim. Clears any active claim.
 */
export function archive(id: string, actor?: Actor) {
  const existing = getRawById(id);
  if (actor) assertEpicClaimOk(existing, actor);

  const db = getDb();
  const now = new Date().toISOString();

  db.update(epics)
    .set({ status: "cancelled", assigneeId: null, updatedAt: now })
    .where(eq(epics.id, id))
    .run();

  // cancelled is terminal and the holder was cleared above — tear down the lease.
  deleteLease("epic", id);

  const result = getById(id, actor);

  getEventBus().emit(EVENT_NAMES.EPIC_ARCHIVED, {
    entity: result,
    entityType: "epic",
    entityId: id,
    projectId: existing.projectId,
    actorId: actor?.id ?? null,
    timestamp: now,
    changes: { status: { from: existing.status, to: "cancelled" } },
    previousStatus: existing.status,
  });

  return result;
}
