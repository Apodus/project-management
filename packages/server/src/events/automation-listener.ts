import { getEventBus, type EventName, type EventPayload } from "./event-bus.js";
import {
  findMatchingRules,
  evaluateConditions,
  executeAction,
  isDepthExceeded,
  type Condition,
  type ActionContext,
} from "../services/automation.service.js";
import { getDb, tasks, epics } from "../db/index.js";
import { eq } from "drizzle-orm";

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
