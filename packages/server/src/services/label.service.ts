import { eq, and } from "drizzle-orm";
import { createId } from "@pm/shared";
import { getDb, labels, taskLabels, projects } from "../db/index.js";
import { AppError } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────

export interface CreateLabelInput {
  name: string;
  color?: string | null;
  description?: string | null;
}

export interface UpdateLabelInput {
  name?: string;
  color?: string | null;
  description?: string | null;
}

// ─── Service functions ────────────────────────────────────────────

/**
 * List all labels for a project.
 */
export function listByProject(projectId: string) {
  const db = getDb();

  return db
    .select()
    .from(labels)
    .where(eq(labels.projectId, projectId))
    .all();
}

/**
 * Create a label. Enforces unique name within project.
 */
export function create(projectId: string, data: CreateLabelInput) {
  const db = getDb();
  const id = createId();

  // Verify project exists
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }

  // Enforce unique name within project
  const existing = db
    .select()
    .from(labels)
    .where(and(eq(labels.projectId, projectId), eq(labels.name, data.name)))
    .get();

  if (existing) {
    throw new AppError(
      409,
      "CONFLICT",
      `Label "${data.name}" already exists in this project`,
    );
  }

  db.insert(labels)
    .values({
      id,
      projectId,
      name: data.name,
      color: data.color ?? null,
      description: data.description ?? null,
    })
    .run();

  return db.select().from(labels).where(eq(labels.id, id)).get()!;
}

/**
 * Update a label's fields. Throws 404 if not found.
 * If name is being changed, enforces uniqueness within the project.
 */
export function update(id: string, data: UpdateLabelInput) {
  const db = getDb();

  const existing = db
    .select()
    .from(labels)
    .where(eq(labels.id, id))
    .get();

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `Label not found: ${id}`);
  }

  // If changing name, enforce uniqueness within project
  if (data.name !== undefined && data.name !== existing.name) {
    const conflict = db
      .select()
      .from(labels)
      .where(
        and(eq(labels.projectId, existing.projectId), eq(labels.name, data.name)),
      )
      .get();

    if (conflict) {
      throw new AppError(
        409,
        "CONFLICT",
        `Label "${data.name}" already exists in this project`,
      );
    }
  }

  const values: Record<string, unknown> = {};

  if (data.name !== undefined) values.name = data.name;
  if (data.color !== undefined) values.color = data.color;
  if (data.description !== undefined) values.description = data.description;

  if (Object.keys(values).length > 0) {
    db.update(labels).set(values).where(eq(labels.id, id)).run();
  }

  return db.select().from(labels).where(eq(labels.id, id)).get()!;
}

/**
 * Delete a label. Also deletes all task_label associations via cascade.
 * Throws 404 if not found.
 */
export function deleteLabel(id: string) {
  const db = getDb();

  const existing = db
    .select()
    .from(labels)
    .where(eq(labels.id, id))
    .get();

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `Label not found: ${id}`);
  }

  // Delete task_label associations first (since FK may not cascade depending on config)
  db.delete(taskLabels).where(eq(taskLabels.labelId, id)).run();

  // Delete the label
  db.delete(labels).where(eq(labels.id, id)).run();

  return existing;
}

/**
 * Attach a label to a task. Creates the task_label association.
 * Throws 404 if the label or task doesn't exist.
 * Throws 409 if already attached.
 */
export function attachToTask(taskId: string, labelId: string) {
  const db = getDb();

  // Verify label exists
  const label = db
    .select()
    .from(labels)
    .where(eq(labels.id, labelId))
    .get();

  if (!label) {
    throw new AppError(404, "NOT_FOUND", `Label not found: ${labelId}`);
  }

  // Check if already attached
  const existing = db
    .select()
    .from(taskLabels)
    .where(
      and(eq(taskLabels.taskId, taskId), eq(taskLabels.labelId, labelId)),
    )
    .get();

  if (existing) {
    throw new AppError(
      409,
      "CONFLICT",
      `Label is already attached to this task`,
    );
  }

  db.insert(taskLabels)
    .values({
      taskId,
      labelId,
    })
    .run();

  return { taskId, labelId };
}

/**
 * Detach a label from a task. Removes the task_label association.
 * Throws 404 if the association doesn't exist.
 */
export function detachFromTask(taskId: string, labelId: string) {
  const db = getDb();

  const existing = db
    .select()
    .from(taskLabels)
    .where(
      and(eq(taskLabels.taskId, taskId), eq(taskLabels.labelId, labelId)),
    )
    .get();

  if (!existing) {
    throw new AppError(
      404,
      "NOT_FOUND",
      `Label is not attached to this task`,
    );
  }

  db.delete(taskLabels)
    .where(
      and(eq(taskLabels.taskId, taskId), eq(taskLabels.labelId, labelId)),
    )
    .run();

  return existing;
}

/**
 * Get all labels attached to a task.
 */
export function getTaskLabels(taskId: string) {
  const db = getDb();

  // Join task_labels with labels to get full label info
  const rows = db
    .select({
      id: labels.id,
      projectId: labels.projectId,
      name: labels.name,
      color: labels.color,
      description: labels.description,
    })
    .from(taskLabels)
    .innerJoin(labels, eq(taskLabels.labelId, labels.id))
    .where(eq(taskLabels.taskId, taskId))
    .all();

  return rows;
}
