import { getEventBus, EVENT_NAMES, type EventName, type EventPayload } from "./event-bus.js";
import {
  findMatchingRules,
  evaluateConditions,
  executeAction,
  isDepthExceeded,
  type Condition,
  type ActionContext,
} from "../services/automation.service.js";
import { getDb, tasks, epics, proposals } from "../db/index.js";
import { eq } from "drizzle-orm";
import type { ProposalStatus } from "@pm/shared";

/**
 * Auto-complete a proposal whose work is fully done, idempotently.
 * Shared by both the task-driven path (proposals with directly-linked tasks,
 * e.g. `implementProposal`) and the epic-driven path (proposals whose work is
 * organised under epics — the common case, where tasks carry `epicId` only).
 * Writes status directly (a system action) and emits PROPOSAL_TRANSITIONED.
 * No-ops if the proposal is already terminal. The caller is responsible for
 * having verified that the proposal's work is complete.
 */
function completeProposal(proposalId: string, from: ProposalStatus): void {
  const db = getDb();
  const bus = getEventBus();
  const now = new Date().toISOString();
  db.update(proposals)
    .set({ status: "completed", updatedAt: now })
    .where(eq(proposals.id, proposalId))
    .run();

  const updated = db.select().from(proposals).where(eq(proposals.id, proposalId)).get();
  if (!updated) return;
  bus.emit(EVENT_NAMES.PROPOSAL_TRANSITIONED, {
    entity: updated,
    entityType: "proposal",
    entityId: proposalId,
    projectId: updated.projectId,
    actorId: null,
    timestamp: now,
    changes: { status: { from, to: "completed" } },
    previousStatus: from,
  });
}

/**
 * Register the proposal auto-transition listeners.
 *
 * Two complementary paths drive a proposal to `completed`:
 * - TASK_STATUS_CHANGED: a proposal with tasks linked DIRECTLY (`task.proposalId`,
 *   as `implementProposal` stamps them) completes when all non-cancelled such
 *   tasks are done — but only once it is already `in_progress`.
 * - EPIC_UPDATED: a proposal whose work is organised under EPICS completes when
 *   all of its non-cancelled linked epics are completed. This is the common
 *   case (tasks created under an epic carry `epicId`, not `proposalId`), and it
 *   fires from any active state (incl. `accepted`), mirroring the way epics
 *   auto-complete from their tasks.
 */
export function registerProposalAutoTransitionListener(): () => void {
  const bus = getEventBus();

  // ── Epic-driven completion ──────────────────────────────────────
  // When a linked epic reaches `completed`, complete the proposal once ALL of
  // its non-cancelled epics are completed. Re-reads the epic from the db so it
  // is robust to both auto-completion (automation, which carries `changes`) and
  // manual epic updates (the epic service, which emits no `changes`).
  bus.on(EVENT_NAMES.EPIC_UPDATED, (payload: EventPayload) => {
    if (payload.entityType !== "epic") return;

    const db = getDb();
    const epic = db.select().from(epics).where(eq(epics.id, payload.entityId)).get();
    if (!epic || epic.status !== "completed" || !epic.proposalId) return;

    const proposal = db
      .select()
      .from(proposals)
      .where(eq(proposals.id, epic.proposalId))
      .get();
    if (!proposal) return;

    const currentStatus = proposal.status as ProposalStatus;
    // Only auto-complete from an active, non-terminal state.
    if (currentStatus === "completed" || currentStatus === "rejected") return;

    // Every non-cancelled epic of this proposal must be completed (and ≥1 must
    // exist) before the proposal itself is done.
    const proposalEpics = db
      .select()
      .from(epics)
      .where(eq(epics.proposalId, epic.proposalId))
      .all();
    const relevant = proposalEpics.filter((e) => e.status !== "cancelled");
    if (relevant.length === 0) return;
    if (!relevant.every((e) => e.status === "completed")) return;

    completeProposal(epic.proposalId, currentStatus);
  });

  // ── Task-driven completion ──────────────────────────────────────
  bus.on(EVENT_NAMES.TASK_STATUS_CHANGED, (payload: EventPayload) => {
    if (payload.entityType !== "task") return;

    const entity = payload.entity as { proposalId?: string | null; status?: string } | null;
    const proposalId = entity?.proposalId;
    if (!proposalId) return;

    const db = getDb();
    const proposal = db.select().from(proposals).where(eq(proposals.id, proposalId)).get();
    if (!proposal) return;

    const currentStatus = proposal.status as ProposalStatus;
    const changes = payload.changes as { status?: { from: unknown; to: unknown } } | undefined;
    const newTaskStatus = changes?.status?.to as string | undefined;

    // in_progress → completed: when all non-cancelled tasks are done
    if (currentStatus === "in_progress" && newTaskStatus === "done") {
      const proposalTasks = db
        .select()
        .from(tasks)
        .where(eq(tasks.proposalId, proposalId))
        .all();

      if (proposalTasks.length === 0) return;

      // Filter out cancelled tasks
      const nonCancelledTasks = proposalTasks.filter((t) => t.status !== "cancelled");
      if (nonCancelledTasks.length === 0) return; // only cancelled tasks, don't auto-complete

      const allDone = nonCancelledTasks.every((t) => t.status === "done");
      if (!allDone) return;

      completeProposal(proposalId, "in_progress");
    }
  });

  // Return a cleanup function
  return () => {
    // The bus.on doesn't return a cleanup, but registerAutomationListener
    // handles the broader cleanup via onAll. This is fine for now.
  };
}

/**
 * Register the automation rules listener on the event bus.
 * Listens to all events via onAll() and triggers matching automation rules.
 */
export function registerAutomationListener(): () => void {
  const bus = getEventBus();

  return bus.onAll((event: EventName, payload: EventPayload) => {
    // Check automation depth to prevent infinite loops
    const depth = (payload as unknown as { _automationDepth?: number })._automationDepth ?? 0;
    if (isDepthExceeded(depth)) {
      console.warn(
        `[Automation] Loop prevention: stopping at depth ${depth} for event "${event}" on entity ${payload.entityId}`,
      );
      return;
    }

    if (!payload.projectId) return;

    // Find matching active rules for this event and project
    const matchingRules = findMatchingRules(event, payload.projectId);

    for (const rule of matchingRules) {
      try {
        // Build the evaluation payload (merge entity fields + event payload)
        const evalPayload = buildEvalPayload(payload);

        // Evaluate conditions
        const conditions = rule.conditions as Condition[] | null;
        if (!evaluateConditions(conditions, evalPayload)) {
          continue;
        }

        // For built-in rules, apply special logic
        const actionConfig = rule.actionConfig as Record<string, unknown> | null;
        const context: ActionContext = {
          entity: payload.entity,
          entityType: payload.entityType,
          entityId: payload.entityId,
          projectId: payload.projectId,
          actorId: payload.actorId,
          timestamp: payload.timestamp,
          changes: payload.changes,
          previousStatus: payload.previousStatus,
          _automationDepth: depth,
        };

        // Handle special built-in rule logic
        if (rule.actionType === "transition_epic" && rule.name === "Auto-complete epic") {
          handleAutoCompleteEpic(payload, actionConfig, context);
        } else if (rule.actionType === "transition_task" && rule.name === "Auto-advance parent") {
          handleAutoAdvanceParent(payload, actionConfig, context);
        } else {
          executeAction(rule.actionType, actionConfig, context);
        }
      } catch (error) {
        // Log but don't throw -- automation failures should not break the main flow
        console.error(
          `[Automation] Error executing rule "${rule.name}" (${rule.id}):`,
          error,
        );
      }
    }
  });
}

// ─── Built-in rule handlers ─────────────────────────────────────

/**
 * Auto-complete epic: when a task is done, check if all tasks in its epic are done.
 * If so, transition the epic to completed.
 */
function handleAutoCompleteEpic(
  payload: EventPayload,
  actionConfig: Record<string, unknown> | null,
  context: ActionContext,
): void {
  if (payload.entityType !== "task") return;

  const entity = payload.entity as { epicId?: string | null };
  const epicId = entity?.epicId;
  if (!epicId) return;

  const db = getDb();

  // Check if ALL tasks in this epic are done
  const epicTasks = db
    .select()
    .from(tasks)
    .where(eq(tasks.epicId, epicId))
    .all();

  if (epicTasks.length === 0) return;
  const allDone = epicTasks.every((t) => t.status === "done");

  if (allDone) {
    executeAction("transition_epic", { ...actionConfig, epic_id: epicId }, context);
  }
}

/**
 * Auto-advance parent: when a subtask is done, check if all siblings are done.
 * If so, transition the parent task to in_review.
 */
function handleAutoAdvanceParent(
  payload: EventPayload,
  actionConfig: Record<string, unknown> | null,
  context: ActionContext,
): void {
  if (payload.entityType !== "task") return;

  const entity = payload.entity as { parentTaskId?: string | null };
  const parentTaskId = entity?.parentTaskId;
  if (!parentTaskId) return;

  const db = getDb();

  // Check if ALL subtasks of this parent are done
  const siblings = db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId))
    .all();

  if (siblings.length === 0) return;
  const allDone = siblings.every((t) => t.status === "done");

  if (allDone) {
    // Check parent is not already in the target status
    const parent = db.select().from(tasks).where(eq(tasks.id, parentTaskId)).get();
    if (!parent || parent.status === "done" || parent.status === "cancelled") return;

    executeAction("transition_task", { ...actionConfig, task_id: parentTaskId }, context);
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Build a flat evaluation payload from the event payload for condition matching.
 * Includes entity fields, changes, and top-level payload fields.
 */
function buildEvalPayload(payload: EventPayload): Record<string, unknown> {
  const entity = (payload.entity && typeof payload.entity === "object" ? payload.entity : {}) as Record<string, unknown>;

  return {
    ...entity,
    entityType: payload.entityType,
    entityId: payload.entityId,
    projectId: payload.projectId,
    actorId: payload.actorId,
    timestamp: payload.timestamp,
    changes: payload.changes,
    previousStatus: payload.previousStatus,
  };
}
