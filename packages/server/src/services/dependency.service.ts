import { eq, and } from "drizzle-orm";
import { createId, DEPENDENCY_TYPES } from "@pm/shared";
import { getDb, taskDependencies, tasks } from "../db/index.js";
import { AppError } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────

const VALID_DEPENDENCY_TYPES = new Set<string>(DEPENDENCY_TYPES);

// ─── Service functions ────────────────────────────────────────────

/**
 * Add a dependency between two tasks.
 * taskId depends on dependsOnTaskId (i.e. dependsOnTaskId blocks taskId).
 *
 * CRITICAL: Performs cycle detection via BFS before insert.
 * Prevents self-dependencies and duplicate dependencies.
 */
export function addDependency(taskId: string, dependsOnTaskId: string, type: string = "blocks") {
  const db = getDb();

  // Validate dependency type
  if (!VALID_DEPENDENCY_TYPES.has(type)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Invalid dependency type: "${type}". Valid types: ${DEPENDENCY_TYPES.join(", ")}`,
    );
  }

  // Prevent self-dependency
  if (taskId === dependsOnTaskId) {
    throw new AppError(400, "SELF_DEPENDENCY", "A task cannot depend on itself");
  }

  // Verify both tasks exist
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) {
    throw new AppError(404, "NOT_FOUND", `Task not found: ${taskId}`);
  }

  const dependsOnTask = db.select().from(tasks).where(eq(tasks.id, dependsOnTaskId)).get();
  if (!dependsOnTask) {
    throw new AppError(404, "NOT_FOUND", `Task not found: ${dependsOnTaskId}`);
  }

  // Check for duplicate dependency
  const existing = db
    .select()
    .from(taskDependencies)
    .where(
      and(
        eq(taskDependencies.taskId, taskId),
        eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
      ),
    )
    .get();

  if (existing) {
    throw new AppError(409, "CONFLICT", "This dependency already exists");
  }

  // Cycle detection via BFS:
  // We're about to add: taskId depends on dependsOnTaskId
  // This means dependsOnTaskId -> taskId in the "blocks" direction
  // A cycle exists if taskId already reaches dependsOnTaskId through existing dependencies
  // i.e., if following the "depends on" chain from dependsOnTaskId, we can reach taskId
  if (type === "blocks") {
    if (wouldCreateCycle(taskId, dependsOnTaskId)) {
      throw new AppError(
        400,
        "CYCLE_DETECTED",
        "Adding this dependency would create a circular dependency",
      );
    }
  }

  const id = createId();
  const now = new Date().toISOString();

  db.insert(taskDependencies)
    .values({
      id,
      taskId,
      dependsOnTaskId,
      dependencyType: type,
      createdAt: now,
    })
    .run();

  return db.select().from(taskDependencies).where(eq(taskDependencies.id, id)).get()!;
}

/**
 * BFS cycle detection.
 * If we add "taskId depends on dependsOnTaskId", check if dependsOnTaskId
 * already (transitively) depends on taskId. If so, adding this edge creates a cycle.
 *
 * We traverse from dependsOnTaskId following all "depends on" edges (of type "blocks")
 * and check if we can reach taskId.
 */
function wouldCreateCycle(taskId: string, dependsOnTaskId: string): boolean {
  const db = getDb();
  const visited = new Set<string>();
  const queue: string[] = [dependsOnTaskId];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current === taskId) {
      return true; // Cycle detected
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    // Get all tasks that "current" depends on (following the dependency chain)
    const deps = db
      .select()
      .from(taskDependencies)
      .where(
        and(eq(taskDependencies.taskId, current), eq(taskDependencies.dependencyType, "blocks")),
      )
      .all();

    for (const dep of deps) {
      if (!visited.has(dep.dependsOnTaskId)) {
        queue.push(dep.dependsOnTaskId);
      }
    }
  }

  return false;
}

/**
 * Remove a dependency by its ID.
 * Throws 404 if not found.
 */
export function removeDependency(id: string) {
  const db = getDb();

  const existing = db.select().from(taskDependencies).where(eq(taskDependencies.id, id)).get();

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `Dependency not found: ${id}`);
  }

  db.delete(taskDependencies).where(eq(taskDependencies.id, id)).run();

  return existing;
}

/**
 * Get all dependencies for a task — both directions:
 * - "blocks": tasks that this task depends on (blocks this task)
 * - "blocked_by": tasks that depend on this task (this task blocks them)
 */
export function getDependencies(taskId: string) {
  const db = getDb();

  // Dependencies where this task depends on another
  const dependsOn = db
    .select()
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, taskId))
    .all();

  // Dependencies where another task depends on this one
  const dependedOnBy = db
    .select()
    .from(taskDependencies)
    .where(eq(taskDependencies.dependsOnTaskId, taskId))
    .all();

  return {
    dependsOn,
    dependedOnBy,
  };
}

/**
 * Check if a task is blocked by unresolved dependencies.
 * A task is "blocked" if it has at least one "blocks" dependency
 * where the blocking task is NOT in "done" status.
 */
export function isBlocked(taskId: string): boolean {
  const db = getDb();

  // Get all "blocks" dependencies where this task depends on another
  const deps = db
    .select()
    .from(taskDependencies)
    .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependencyType, "blocks")))
    .all();

  if (deps.length === 0) {
    return false;
  }

  // Check if any blocking task is NOT done
  for (const dep of deps) {
    const blockingTask = db.select().from(tasks).where(eq(tasks.id, dep.dependsOnTaskId)).get();

    if (blockingTask && blockingTask.status !== "done") {
      return true; // At least one blocking task is not done
    }
  }

  return false;
}
