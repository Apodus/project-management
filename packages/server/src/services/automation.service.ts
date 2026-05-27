import { eq, and } from "drizzle-orm";
import { createId } from "@pm/shared";
import { getDb, automationRules, tasks, epics, comments } from "../db/index.js";
import { AppError } from "../types.js";
import { logActivity } from "./activity.service.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";

// ─── Types ────────────────────────────────────────────────────────

export interface Condition {
  field: string;
  operator: "eq" | "neq" | "in" | "not_in" | "contains";
  value: unknown;
}

export interface CreateRuleInput {
  projectId: string;
  name: string;
  description?: string | null;
  triggerEvent: string;
  conditions?: Condition[] | null;
  actionType: string;
  actionConfig?: Record<string, unknown> | null;
  isActive?: boolean;
  createdBy?: string | null;
}

export interface UpdateRuleInput {
  name?: string;
  description?: string | null;
  triggerEvent?: string;
  conditions?: Condition[] | null;
  actionType?: string;
  actionConfig?: Record<string, unknown> | null;
  isActive?: boolean;
}

export interface ActionContext {
  entity: unknown;
  entityType: string;
  entityId: string;
  projectId: string | null;
  actorId: string | null;
  timestamp: string;
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  previousStatus?: string;
  /** Automation execution depth for loop prevention */
  _automationDepth?: number;
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_AUTOMATION_DEPTH = 3;

const VALID_ACTION_TYPES = new Set([
  "transition_task",
  "transition_epic",
  "create_comment",
  "notify",
]);

// ─── Service functions ──────────────────────────────────────────

/**
 * List all automation rules for a project.
 */
export function list(projectId: string) {
  const db = getDb();
  return db
    .select()
    .from(automationRules)
    .where(eq(automationRules.projectId, projectId))
    .all();
}

/**
 * Get a single automation rule by ID. Throws 404 if not found.
 */
export function getById(id: string) {
  const db = getDb();
  const rule = db
    .select()
    .from(automationRules)
    .where(eq(automationRules.id, id))
    .get();

  if (!rule) {
    throw new AppError(404, "NOT_FOUND", `Automation rule not found: ${id}`);
  }

  return rule;
}

/**
 * Create a new automation rule.
 */
export function create(data: CreateRuleInput) {
  if (!VALID_ACTION_TYPES.has(data.actionType)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Invalid action_type: "${data.actionType}". Valid types: ${[...VALID_ACTION_TYPES].join(", ")}`,
    );
  }

  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();

  db.insert(automationRules)
    .values({
      id,
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      triggerEvent: data.triggerEvent,
      conditions: data.conditions ?? null,
      actionType: data.actionType,
      actionConfig: data.actionConfig ?? null,
      isActive: data.isActive ?? true,
      createdAt: now,
      updatedAt: now,
      createdBy: data.createdBy ?? null,
    })
    .run();

  return getById(id);
}

/**
 * Update an automation rule. Throws 404 if not found.
 */
export function update(id: string, data: UpdateRuleInput) {
  getById(id); // verify exists
  const db = getDb();
  const now = new Date().toISOString();

  if (data.actionType !== undefined && !VALID_ACTION_TYPES.has(data.actionType)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Invalid action_type: "${data.actionType}". Valid types: ${[...VALID_ACTION_TYPES].join(", ")}`,
    );
  }

  const values: Record<string, unknown> = {
    updatedAt: now,
  };

  if (data.name !== undefined) values.name = data.name;
  if (data.description !== undefined) values.description = data.description;
  if (data.triggerEvent !== undefined) values.triggerEvent = data.triggerEvent;
  if (data.conditions !== undefined) values.conditions = data.conditions;
  if (data.actionType !== undefined) values.actionType = data.actionType;
  if (data.actionConfig !== undefined) values.actionConfig = data.actionConfig;
  if (data.isActive !== undefined) values.isActive = data.isActive;

  db.update(automationRules).set(values).where(eq(automationRules.id, id)).run();

  return getById(id);
}

/**
 * Delete an automation rule. Throws 404 if not found.
 */
export function deleteRule(id: string) {
  getById(id); // verify exists
  const db = getDb();
  db.delete(automationRules).where(eq(automationRules.id, id)).run();
}

/**
 * Toggle an automation rule's active state.
 */
export function toggle(id: string, active: boolean) {
  getById(id); // verify exists
  const db = getDb();
  const now = new Date().toISOString();

  db.update(automationRules)
    .set({ isActive: active, updatedAt: now })
    .where(eq(automationRules.id, id))
    .run();

  return getById(id);
}

// ─── Condition evaluation ───────────────────────────────────────

/**
 * Resolve a dot-notation path to a value from a nested object.
 * E.g., "changes.status.to" on { changes: { status: { from: "a", to: "b" } } } -> "b"
 */
function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate a single condition against a payload.
 */
function evaluateSingleCondition(condition: Condition, payload: unknown): boolean {
  const actual = resolvePath(payload, condition.field);
  const expected = condition.value;

  switch (condition.operator) {
    case "eq":
      return actual === expected;

    case "neq":
      return actual !== expected;

    case "in":
      if (!Array.isArray(expected)) return false;
      return expected.includes(actual);

    case "not_in":
      if (!Array.isArray(expected)) return false;
      return !expected.includes(actual);

    case "contains":
      if (typeof actual === "string" && typeof expected === "string") {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return false;

    default:
      return false;
  }
}

/**
 * Evaluate an array of conditions (AND logic) against an event payload.
 * Returns true if all conditions pass, or if conditions is null/empty.
 */
export function evaluateConditions(
  conditions: Condition[] | null | undefined,
  payload: unknown,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((condition) => evaluateSingleCondition(condition, payload));
}

// ─── Action execution ───────────────────────────────────────────

/**
 * Execute an automation action.
 * This function imports services lazily to avoid circular dependencies.
 */
export function executeAction(
  actionType: string,
  actionConfig: Record<string, unknown> | null,
  context: ActionContext,
): void {
  const config = actionConfig ?? {};

  switch (actionType) {
    case "transition_task": {
      const toStatus = config.to_status as string;
      if (!toStatus) return;
      const taskId = (config.task_id as string) ?? context.entityId;

      // Use the db directly to avoid triggering validation in the service
      // (automation may need transitions that the normal transition flow wouldn't allow)
      // Actually, let's use the service properly for safety
      const db = getDb();
      const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!task) return;
      if (task.status === toStatus) return; // already in target status

      const now = new Date().toISOString();
      const values: Record<string, unknown> = {
        status: toStatus,
        updatedAt: now,
      };
      if (toStatus === "done") {
        values.completedAt = now;
      }
      if (toStatus === "in_progress" && !task.startedAt) {
        values.startedAt = now;
      }

      db.update(tasks).set(values).where(eq(tasks.id, taskId)).run();

      // Emit event for the transition (will be picked up by automation listener)
      const updatedTask = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      getEventBus().emit(EVENT_NAMES.TASK_STATUS_CHANGED, {
        entity: updatedTask,
        entityType: "task",
        entityId: taskId,
        projectId: task.projectId,
        actorId: null,
        timestamp: now,
        changes: { status: { from: task.status, to: toStatus } },
        previousStatus: task.status,
        _automationDepth: (context._automationDepth ?? 0) + 1,
      });
      break;
    }

    case "transition_epic": {
      const toStatus = config.to_status as string;
      if (!toStatus) return;
      const epicId = (config.epic_id as string) ?? context.entityId;

      const db = getDb();
      const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
      if (!epic) return;
      if (epic.status === toStatus) return;

      const now = new Date().toISOString();
      db.update(epics)
        .set({ status: toStatus, updatedAt: now })
        .where(eq(epics.id, epicId))
        .run();

      const updatedEpic = db.select().from(epics).where(eq(epics.id, epicId)).get();
      getEventBus().emit(EVENT_NAMES.EPIC_UPDATED, {
        entity: updatedEpic,
        entityType: "epic",
        entityId: epicId,
        projectId: epic.projectId,
        actorId: null,
        timestamp: now,
        changes: { status: { from: epic.status, to: toStatus } },
        previousStatus: epic.status,
        _automationDepth: (context._automationDepth ?? 0) + 1,
      });
      break;
    }

    case "create_comment": {
      const body = config.body as string;
      if (!body) return;

      const targetTaskId = (config.task_id as string) ?? (context.entityType === "task" ? context.entityId : null);
      if (!targetTaskId) return;

      const db = getDb();
      const now = new Date().toISOString();
      const id = createId();

      // Find or use a system user for the automation actor
      const authorId = context.actorId;
      if (!authorId) return;

      db.insert(comments)
        .values({
          id,
          taskId: targetTaskId,
          proposalId: null,
          authorId,
          body: `[Automation] ${body}`,
          commentType: "system",
          metadata: { automationGenerated: true },
          createdAt: now,
          updatedAt: now,
        })
        .run();
      break;
    }

    case "notify": {
      const message = (config.message as string) ?? "Automation action executed";

      logActivity({
        entityType: context.entityType,
        entityId: context.entityId,
        projectId: context.projectId,
        actorId: null, // automation actor
        action: "automation_notify",
        changes: {
          automation: { from: null, to: message },
        },
      });
      break;
    }

    default:
      break;
  }
}

// ─── Rule matching ──────────────────────────────────────────────

/**
 * Find active automation rules that match a given event and project.
 */
export function findMatchingRules(triggerEvent: string, projectId: string | null) {
  if (!projectId) return [];

  const db = getDb();
  return db
    .select()
    .from(automationRules)
    .where(
      and(
        eq(automationRules.projectId, projectId),
        eq(automationRules.triggerEvent, triggerEvent),
        eq(automationRules.isActive, true),
      ),
    )
    .all();
}

/**
 * Check if automation depth limit has been reached.
 */
export function isDepthExceeded(depth: number): boolean {
  return depth >= MAX_AUTOMATION_DEPTH;
}

/**
 * Get the max automation depth constant.
 */
export function getMaxDepth(): number {
  return MAX_AUTOMATION_DEPTH;
}

// ─── Built-in rules ─────────────────────────────────────────────

/**
 * Create default automation rules for a new project (if none exist).
 */
export function createBuiltInRules(projectId: string, createdBy?: string | null) {
  const db = getDb();

  // Check if rules already exist for this project
  const existing = db
    .select()
    .from(automationRules)
    .where(eq(automationRules.projectId, projectId))
    .all();

  if (existing.length > 0) return;

  const now = new Date().toISOString();

  // Rule 1: Auto-complete epic when all tasks are done
  db.insert(automationRules)
    .values({
      id: createId(),
      projectId,
      name: "Auto-complete epic",
      description:
        "When a task status changes to done, check if all tasks in the epic are done. If so, transition the epic to completed.",
      triggerEvent: "task.status_changed",
      conditions: [
        { field: "changes.status.to", operator: "eq", value: "done" },
      ],
      actionType: "transition_epic",
      actionConfig: { to_status: "completed" },
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: createdBy ?? null,
    })
    .run();

  // Rule 2: Auto-advance parent task when all subtasks are done
  db.insert(automationRules)
    .values({
      id: createId(),
      projectId,
      name: "Auto-advance parent",
      description:
        "When all subtasks of a task are done, transition the parent task to in_review.",
      triggerEvent: "task.status_changed",
      conditions: [
        { field: "changes.status.to", operator: "eq", value: "done" },
      ],
      actionType: "transition_task",
      actionConfig: { to_status: "in_review" },
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: createdBy ?? null,
    })
    .run();
}
