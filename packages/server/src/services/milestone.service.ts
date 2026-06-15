import { eq } from "drizzle-orm";
import { createId } from "@pm/shared";
import { getDb, milestones, projects } from "../db/index.js";
import { AppError } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────

export interface CreateMilestoneInput {
  projectId: string;
  name: string;
  description?: string | null;
  targetDate?: string | null;
  status?: string;
  sortOrder?: number;
}

export interface UpdateMilestoneInput {
  name?: string;
  description?: string | null;
  targetDate?: string | null;
  status?: string;
  sortOrder?: number;
}

// ─── Service functions ────────────────────────────────────────────

/**
 * List milestones for a project.
 */
export function list(projectId: string) {
  const db = getDb();

  // Verify project exists
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();

  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }

  return db.select().from(milestones).where(eq(milestones.projectId, projectId)).all();
}

/**
 * Get a single milestone by ID. Throws 404 if not found.
 */
export function getById(id: string) {
  const db = getDb();
  const milestone = db.select().from(milestones).where(eq(milestones.id, id)).get();

  if (!milestone) {
    throw new AppError(404, "NOT_FOUND", `Milestone not found: ${id}`);
  }

  return milestone;
}

/**
 * Create a new milestone.
 */
export function create(data: CreateMilestoneInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();

  // Verify project exists
  const project = db.select().from(projects).where(eq(projects.id, data.projectId)).get();

  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${data.projectId}`);
  }

  db.insert(milestones)
    .values({
      id,
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      targetDate: data.targetDate ?? null,
      status: data.status ?? "open",
      sortOrder: data.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return getById(id);
}

/**
 * Update a milestone's fields. Throws 404 if not found.
 */
export function update(id: string, data: UpdateMilestoneInput) {
  getById(id); // verify exists
  const db = getDb();
  const now = new Date().toISOString();

  const values: Record<string, unknown> = {
    updatedAt: now,
  };

  if (data.name !== undefined) values.name = data.name;
  if (data.description !== undefined) values.description = data.description;
  if (data.targetDate !== undefined) values.targetDate = data.targetDate;
  if (data.status !== undefined) values.status = data.status;
  if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;

  db.update(milestones).set(values).where(eq(milestones.id, id)).run();

  return getById(id);
}

/**
 * Delete a milestone. Throws 404 if not found.
 */
export function deleteMilestone(id: string) {
  const existing = getById(id);
  const db = getDb();

  db.delete(milestones).where(eq(milestones.id, id)).run();

  return existing;
}
