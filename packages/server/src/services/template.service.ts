import { eq, and, isNull } from "drizzle-orm";
import { createId } from "@pm/shared";
import { getDb, templates, projects, users } from "../db/index.js";
import { AppError } from "../types.js";
import * as taskService from "./task.service.js";
import * as epicService from "./epic.service.js";
import * as labelService from "./label.service.js";
import * as projectService from "./project.service.js";

// ─── Types ────────────────────────────────────────────────────────

export interface SubtaskTemplate {
  title: string;
  type?: string;
  effort?: string;
}

export interface TaskTemplateData {
  title_prefix?: string;
  description?: string;
  type?: string;
  priority?: string;
  estimated_effort?: string;
  context?: Record<string, unknown>;
  subtasks?: SubtaskTemplate[];
}

export interface ProjectEpicTask {
  title: string;
  type?: string;
}

export interface ProjectEpic {
  name: string;
  tasks?: ProjectEpicTask[];
}

export interface ProjectLabel {
  name: string;
  color: string;
}

export interface ProjectTemplateData {
  description?: string;
  epics?: ProjectEpic[];
  labels?: ProjectLabel[];
}

export interface CreateTemplateInput {
  projectId?: string | null;
  name: string;
  description?: string | null;
  templateType: "task" | "project";
  templateData: TaskTemplateData | ProjectTemplateData;
  createdBy?: string | null;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string | null;
  templateData?: TaskTemplateData | ProjectTemplateData;
}

// ─── Service functions ────────────────────────────────────────────

/**
 * List templates with optional filters.
 * If projectId is provided, returns project-level + workspace-level templates.
 * If not, returns workspace-level templates only.
 */
export function list(projectId?: string, templateType?: string) {
  const db = getDb();

  const conditions: ReturnType<typeof eq>[] = [];

  if (templateType) {
    conditions.push(eq(templates.templateType, templateType));
  }

  if (projectId) {
    // Return both project-specific and workspace-level (null projectId) templates
    const projectTemplates = db
      .select()
      .from(templates)
      .where(
        conditions.length > 0
          ? and(eq(templates.projectId, projectId), ...conditions)
          : eq(templates.projectId, projectId),
      )
      .all();

    const workspaceTemplates = db
      .select()
      .from(templates)
      .where(
        conditions.length > 0
          ? and(isNull(templates.projectId), ...conditions)
          : isNull(templates.projectId),
      )
      .all();

    return [...projectTemplates, ...workspaceTemplates];
  }

  // No projectId — return all templates
  if (conditions.length > 0) {
    return db
      .select()
      .from(templates)
      .where(and(...conditions))
      .all();
  }

  return db.select().from(templates).all();
}

/**
 * Get a single template by ID. Throws 404 if not found.
 */
export function getById(id: string) {
  const db = getDb();
  const template = db
    .select()
    .from(templates)
    .where(eq(templates.id, id))
    .get();

  if (!template) {
    throw new AppError(404, "NOT_FOUND", `Template not found: ${id}`);
  }

  return template;
}

/**
 * Create a new template.
 */
export function create(data: CreateTemplateInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();

  // Validate template type
  if (data.templateType !== "task" && data.templateType !== "project") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Invalid template_type: ${data.templateType}. Must be "task" or "project".`,
    );
  }

  // Verify project exists if provided
  if (data.projectId) {
    projectService.getById(data.projectId);
  }

  db.insert(templates)
    .values({
      id,
      projectId: data.projectId ?? null,
      name: data.name,
      description: data.description ?? null,
      templateType: data.templateType,
      templateData: data.templateData,
      createdAt: now,
      updatedAt: now,
      createdBy: data.createdBy ?? null,
    })
    .run();

  return getById(id);
}

/**
 * Update a template's fields. Throws 404 if not found.
 */
export function update(id: string, data: UpdateTemplateInput) {
  getById(id); // verify exists
  const db = getDb();
  const now = new Date().toISOString();

  const values: Record<string, unknown> = {
    updatedAt: now,
  };

  if (data.name !== undefined) values.name = data.name;
  if (data.description !== undefined) values.description = data.description;
  if (data.templateData !== undefined) values.templateData = data.templateData;

  db.update(templates).set(values).where(eq(templates.id, id)).run();

  return getById(id);
}

/**
 * Delete a template. Throws 404 if not found.
 */
export function deleteTemplate(id: string) {
  const existing = getById(id);
  const db = getDb();

  db.delete(templates).where(eq(templates.id, id)).run();

  return existing;
}

/**
 * Instantiate a task template: creates a task (with optional subtasks) from template.
 */
export function instantiateTaskTemplate(
  templateId: string,
  projectId: string,
  overrides?: Partial<TaskTemplateData> & { title?: string },
) {
  const template = getById(templateId);

  if (template.templateType !== "task") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Template "${template.name}" is not a task template.`,
    );
  }

  // Verify project exists
  projectService.getById(projectId);

  const data = template.templateData as TaskTemplateData;

  // Determine the task title
  const titlePrefix = overrides?.title_prefix ?? data.title_prefix ?? "";
  const title = overrides?.title ?? `${titlePrefix}New Task`;

  // We need a reporter — use createdBy from template, or fall back to a system user
  // For now, find any user in the system
  const db = getDb();
  const anyUser = db.select().from(projects).where(eq(projects.id, projectId)).get();
  const reporterId = anyUser?.createdBy ?? template.createdBy ?? getAnyUserId(db);

  if (!reporterId) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Cannot instantiate template: no reporter user available.",
    );
  }

  // Create the main task
  const task = taskService.create({
    projectId,
    title,
    description: overrides?.description ?? data.description ?? null,
    type: overrides?.type ?? data.type ?? "feature",
    priority: overrides?.priority ?? data.priority ?? "medium",
    estimatedEffort: overrides?.estimated_effort ?? data.estimated_effort ?? null,
    context: overrides?.context ?? data.context ?? null,
    reporterId,
  });

  // Create subtasks if defined
  const subtasks = overrides?.subtasks ?? data.subtasks;
  const createdSubtasks: ReturnType<typeof taskService.create>[] = [];

  if (subtasks && subtasks.length > 0) {
    for (const sub of subtasks) {
      const subtask = taskService.create({
        projectId,
        parentTaskId: task.id,
        title: sub.title,
        type: sub.type ?? "feature",
        estimatedEffort: sub.effort ?? null,
        reporterId,
      });
      createdSubtasks.push(subtask);
    }
  }

  return {
    task,
    subtasks: createdSubtasks,
  };
}

/**
 * Instantiate a project template: creates project + epics + tasks + labels.
 */
export function instantiateProjectTemplate(
  templateId: string,
  workspaceId: string,
  overrides?: { name?: string; description?: string },
) {
  const template = getById(templateId);

  if (template.templateType !== "project") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Template "${template.name}" is not a project template.`,
    );
  }

  const data = template.templateData as ProjectTemplateData;

  // Create the project
  const projectName = overrides?.name ?? `Project from ${template.name}`;
  const project = projectService.create({
    name: projectName,
    workspaceId,
    description: overrides?.description ?? data.description ?? null,
    createdBy: template.createdBy,
  });

  // We need a reporter for tasks
  const reporterId = project.createdBy ?? template.createdBy ?? getAnyUserId(getDb());

  // Create labels
  const createdLabels: ReturnType<typeof labelService.create>[] = [];
  if (data.labels && data.labels.length > 0) {
    for (const labelDef of data.labels) {
      const label = labelService.create(project.id, {
        name: labelDef.name,
        color: labelDef.color,
      });
      createdLabels.push(label);
    }
  }

  // Create epics and their tasks
  const createdEpics: Array<{
    epic: ReturnType<typeof epicService.create>;
    tasks: ReturnType<typeof taskService.create>[];
  }> = [];

  if (data.epics && data.epics.length > 0) {
    for (const epicDef of data.epics) {
      const epic = epicService.create({
        projectId: project.id,
        name: epicDef.name,
        createdBy: template.createdBy,
      });

      const epicTasks: ReturnType<typeof taskService.create>[] = [];

      if (epicDef.tasks && epicDef.tasks.length > 0) {
        for (const taskDef of epicDef.tasks) {
          if (!reporterId) {
            throw new AppError(
              400,
              "VALIDATION_ERROR",
              "Cannot instantiate template: no reporter user available.",
            );
          }
          const task = taskService.create({
            projectId: project.id,
            epicId: epic.id,
            title: taskDef.title,
            type: taskDef.type ?? "feature",
            reporterId,
          });
          epicTasks.push(task);
        }
      }

      createdEpics.push({ epic, tasks: epicTasks });
    }
  }

  return {
    project,
    labels: createdLabels,
    epics: createdEpics,
  };
}

/**
 * Create a template from an existing task (snapshot).
 * Captures the task's fields and subtasks as a task template.
 */
export function createTemplateFromTask(
  taskId: string,
  name: string,
  description?: string,
) {
  const task = taskService.getById(taskId);
  const subtasks = taskService.listSubtasks(taskId);

  const templateData: TaskTemplateData = {
    description: task.description ?? undefined,
    type: task.type,
    priority: task.priority,
    estimated_effort: task.estimatedEffort ?? undefined,
    context: task.context && typeof task.context === "object"
      ? (task.context as Record<string, unknown>)
      : undefined,
    subtasks: subtasks.map((st) => ({
      title: st.title,
      type: st.type,
      effort: st.estimatedEffort ?? undefined,
    })),
  };

  // Clean up undefined values from templateData
  const cleanData: TaskTemplateData = {};
  if (templateData.description !== undefined) cleanData.description = templateData.description;
  if (templateData.type !== undefined) cleanData.type = templateData.type;
  if (templateData.priority !== undefined) cleanData.priority = templateData.priority;
  if (templateData.estimated_effort !== undefined) cleanData.estimated_effort = templateData.estimated_effort;
  if (templateData.context !== undefined) cleanData.context = templateData.context;
  if (templateData.subtasks && templateData.subtasks.length > 0) cleanData.subtasks = templateData.subtasks;

  return create({
    projectId: task.projectId,
    name,
    description: description ?? `Template from task: ${task.title}`,
    templateType: "task",
    templateData: cleanData,
    createdBy: task.reporterId,
  });
}

// ─── Internal helpers ────────────────────────────────────────────

function getAnyUserId(db: ReturnType<typeof getDb>): string | null {
  const user = db.select().from(users).limit(1).get();
  return user?.id ?? null;
}
