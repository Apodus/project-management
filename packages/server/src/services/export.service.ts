import { eq } from "drizzle-orm";
import { createId } from "@pm/shared";
import fs from "node:fs";
import path from "node:path";
import {
  getDb,
  getRawDb,
  projects,
  proposals,
  epics,
  milestones,
  tasks,
  comments,
  labels,
  taskLabels,
  taskDependencies,
  gitRefs,
  activityLog,
} from "../db/index.js";
import { AppError } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────

export interface ExportData {
  version: string;
  exported_at: string;
  project: Record<string, unknown>;
  proposals: Record<string, unknown>[];
  epics: Record<string, unknown>[];
  milestones: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  labels: Record<string, unknown>[];
  task_labels: Record<string, unknown>[];
  task_dependencies: Record<string, unknown>[];
  git_refs: Record<string, unknown>[];
  activity_log?: Record<string, unknown>[];
}

export interface BackupResult {
  path: string;
  size: number;
  timestamp: string;
}

// ─── Export ───────────────────────────────────────────────────────

/**
 * Export a complete project and all related data as JSON.
 */
export function exportProject(
  projectId: string,
  options?: { includeActivity?: boolean },
): ExportData {
  const db = getDb();
  const includeActivity = options?.includeActivity ?? false;

  // Get project
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();

  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }

  // Get all related data
  const projectProposals = db
    .select()
    .from(proposals)
    .where(eq(proposals.projectId, projectId))
    .all();

  const projectEpics = db.select().from(epics).where(eq(epics.projectId, projectId)).all();

  const projectMilestones = db
    .select()
    .from(milestones)
    .where(eq(milestones.projectId, projectId))
    .all();

  const projectTasks = db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();

  const taskIds = projectTasks.map((t) => t.id);

  // Get comments for tasks and proposals in this project
  const projectComments: Record<string, unknown>[] = [];
  for (const task of projectTasks) {
    const taskComments = db.select().from(comments).where(eq(comments.taskId, task.id)).all();
    projectComments.push(...taskComments);
  }
  for (const proposal of projectProposals) {
    const proposalComments = db
      .select()
      .from(comments)
      .where(eq(comments.proposalId, proposal.id))
      .all();
    projectComments.push(...proposalComments);
  }

  // Get labels for this project
  const projectLabels = db.select().from(labels).where(eq(labels.projectId, projectId)).all();

  // Get task_labels for tasks in this project
  const projectTaskLabels: Record<string, unknown>[] = [];
  for (const taskId of taskIds) {
    const tl = db.select().from(taskLabels).where(eq(taskLabels.taskId, taskId)).all();
    projectTaskLabels.push(...tl);
  }

  // Get task_dependencies for tasks in this project
  const projectDependencies: Record<string, unknown>[] = [];
  for (const taskId of taskIds) {
    const deps = db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, taskId))
      .all();
    projectDependencies.push(...deps);
  }

  // Get git_refs for tasks in this project
  const projectGitRefs: Record<string, unknown>[] = [];
  for (const taskId of taskIds) {
    const refs = db.select().from(gitRefs).where(eq(gitRefs.taskId, taskId)).all();
    projectGitRefs.push(...refs);
  }

  const result: ExportData = {
    version: "1.0",
    exported_at: new Date().toISOString(),
    project: project as unknown as Record<string, unknown>,
    proposals: projectProposals as unknown as Record<string, unknown>[],
    epics: projectEpics as unknown as Record<string, unknown>[],
    milestones: projectMilestones as unknown as Record<string, unknown>[],
    tasks: projectTasks as unknown as Record<string, unknown>[],
    comments: projectComments,
    labels: projectLabels as unknown as Record<string, unknown>[],
    task_labels: projectTaskLabels,
    task_dependencies: projectDependencies,
    git_refs: projectGitRefs,
  };

  // Optionally include activity log
  if (includeActivity) {
    const projectActivity = db
      .select()
      .from(activityLog)
      .where(eq(activityLog.projectId, projectId))
      .all();
    result.activity_log = projectActivity as unknown as Record<string, unknown>[];
  }

  return result;
}

// ─── Import ───────────────────────────────────────────────────────

/**
 * Validate the structure of import data.
 */
function validateImportData(data: unknown): ExportData {
  if (!data || typeof data !== "object") {
    throw new AppError(400, "INVALID_FORMAT", "Import data must be a JSON object");
  }

  const d = data as Record<string, unknown>;

  if (d.version !== "1.0") {
    throw new AppError(
      400,
      "UNSUPPORTED_VERSION",
      `Unsupported export version: ${d.version}. Expected "1.0"`,
    );
  }

  if (!d.project || typeof d.project !== "object") {
    throw new AppError(400, "INVALID_FORMAT", "Import data must include a project object");
  }

  const project = d.project as Record<string, unknown>;
  if (!project.name || typeof project.name !== "string") {
    throw new AppError(400, "INVALID_FORMAT", "Project must have a name");
  }

  // Validate arrays exist (they can be empty)
  const requiredArrays = [
    "proposals",
    "epics",
    "milestones",
    "tasks",
    "comments",
    "labels",
    "task_labels",
    "task_dependencies",
    "git_refs",
  ];
  for (const key of requiredArrays) {
    if (!Array.isArray(d[key])) {
      throw new AppError(400, "INVALID_FORMAT", `Import data must include "${key}" as an array`);
    }
  }

  return d as unknown as ExportData;
}

/**
 * Import a project from exported JSON.
 * Generates new IDs for all entities and remaps foreign keys.
 */
export function importProject(
  data: unknown,
  workspaceId: string,
  createdBy: string,
): Record<string, unknown> {
  const exportData = validateImportData(data);
  const db = getDb();
  const now = new Date().toISOString();

  // Build old→new ID mapping
  const idMap = new Map<string, string>();

  // Generate new project ID
  const oldProjectId = exportData.project.id as string;
  const newProjectId = createId();
  idMap.set(oldProjectId, newProjectId);

  // Generate new IDs for all entities
  for (const milestone of exportData.milestones) {
    idMap.set(milestone.id as string, createId());
  }
  for (const proposal of exportData.proposals) {
    idMap.set(proposal.id as string, createId());
  }
  for (const epic of exportData.epics) {
    idMap.set(epic.id as string, createId());
  }
  for (const label of exportData.labels) {
    idMap.set(label.id as string, createId());
  }
  for (const task of exportData.tasks) {
    idMap.set(task.id as string, createId());
  }
  for (const comment of exportData.comments) {
    idMap.set(comment.id as string, createId());
  }
  for (const dep of exportData.task_dependencies) {
    idMap.set(dep.id as string, createId());
  }
  for (const ref of exportData.git_refs) {
    idMap.set(ref.id as string, createId());
  }

  // Helper to remap an ID (returns null if the original was null/undefined)
  function remap(oldId: unknown): string | null {
    if (oldId == null || oldId === "") return null;
    return idMap.get(oldId as string) ?? null;
  }

  // Generate a unique slug
  const baseName = exportData.project.name as string;
  const importedName = `${baseName} (imported)`;

  // Insert in dependency order using a transaction
  const rawDb = getRawDb();
  const runImport = rawDb.transaction(() => {
    // 1. Project
    const projectSlug = `${(exportData.project.slug as string) || "imported"}-${newProjectId.slice(-6)}`;
    db.insert(projects)
      .values({
        id: newProjectId,
        workspaceId,
        name: importedName,
        slug: projectSlug,
        description: (exportData.project.description as string) ?? null,
        status: (exportData.project.status as string) ?? "active",
        gitRepoUrl: (exportData.project.gitRepoUrl as string) ?? null,
        settings: exportData.project.settings ?? null,
        sortOrder: (exportData.project.sortOrder as number) ?? 0,
        createdAt: now,
        updatedAt: now,
        createdBy,
      })
      .run();

    // 2. Milestones
    for (const ms of exportData.milestones) {
      db.insert(milestones)
        .values({
          id: remap(ms.id)!,
          projectId: newProjectId,
          name: ms.name as string,
          description: (ms.description as string) ?? null,
          targetDate: (ms.targetDate as string) ?? null,
          status: (ms.status as string) ?? "open",
          sortOrder: (ms.sortOrder as number) ?? 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // 3. Proposals (createdBy remaps to importing user since we don't import users)
    for (const prop of exportData.proposals) {
      db.insert(proposals)
        .values({
          id: remap(prop.id)!,
          projectId: newProjectId,
          title: prop.title as string,
          description: (prop.description as string) ?? null,
          status: (prop.status as string) ?? "open",
          createdBy,
          resolvedBy: null,
          resolvedAt: (prop.resolvedAt as string) ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // 4. Epics
    for (const epic of exportData.epics) {
      db.insert(epics)
        .values({
          id: remap(epic.id)!,
          projectId: newProjectId,
          proposalId: remap(epic.proposalId),
          milestoneId: remap(epic.milestoneId),
          name: epic.name as string,
          description: (epic.description as string) ?? null,
          status: (epic.status as string) ?? "draft",
          priority: (epic.priority as string) ?? "medium",
          targetDate: (epic.targetDate as string) ?? null,
          sortOrder: (epic.sortOrder as number) ?? 0,
          createdAt: now,
          updatedAt: now,
          createdBy,
        })
        .run();
    }

    // 5. Labels
    for (const label of exportData.labels) {
      db.insert(labels)
        .values({
          id: remap(label.id)!,
          projectId: newProjectId,
          name: label.name as string,
          color: (label.color as string) ?? null,
          description: (label.description as string) ?? null,
        })
        .run();
    }

    // 6. Tasks
    for (const task of exportData.tasks) {
      db.insert(tasks)
        .values({
          id: remap(task.id)!,
          projectId: newProjectId,
          proposalId: remap(task.proposalId),
          epicId: remap(task.epicId),
          parentTaskId: remap(task.parentTaskId),
          title: task.title as string,
          description: (task.description as string) ?? null,
          status: (task.status as string) ?? "backlog",
          priority: (task.priority as string) ?? "medium",
          type: (task.type as string) ?? "feature",
          assigneeId: null,
          reporterId: createdBy,
          estimatedEffort: (task.estimatedEffort as string) ?? null,
          dueDate: (task.dueDate as string) ?? null,
          sortOrder: (task.sortOrder as number) ?? 0,
          context: task.context ?? null,
          gitBranch: (task.gitBranch as string) ?? null,
          createdAt: now,
          updatedAt: now,
          startedAt: (task.startedAt as string) ?? null,
          completedAt: (task.completedAt as string) ?? null,
        })
        .run();
    }

    // 7. Task labels
    for (const tl of exportData.task_labels) {
      const newTaskId = remap(tl.taskId);
      const newLabelId = remap(tl.labelId);
      if (newTaskId && newLabelId) {
        db.insert(taskLabels)
          .values({
            taskId: newTaskId,
            labelId: newLabelId,
          })
          .run();
      }
    }

    // 8. Comments
    for (const comment of exportData.comments) {
      db.insert(comments)
        .values({
          id: remap(comment.id)!,
          taskId: remap(comment.taskId),
          proposalId: remap(comment.proposalId),
          authorId: createdBy,
          body: comment.body as string,
          commentType: (comment.commentType as string) ?? "comment",
          metadata: comment.metadata ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // 9. Task dependencies
    for (const dep of exportData.task_dependencies) {
      const newTaskId = remap(dep.taskId);
      const newDependsOnId = remap(dep.dependsOnTaskId);
      if (newTaskId && newDependsOnId) {
        db.insert(taskDependencies)
          .values({
            id: remap(dep.id)!,
            taskId: newTaskId,
            dependsOnTaskId: newDependsOnId,
            dependencyType: (dep.dependencyType as string) ?? "blocks",
            createdAt: now,
          })
          .run();
      }
    }

    // 10. Git refs
    for (const ref of exportData.git_refs) {
      const newTaskId = remap(ref.taskId);
      if (newTaskId) {
        db.insert(gitRefs)
          .values({
            id: remap(ref.id)!,
            taskId: newTaskId,
            refType: ref.refType as string,
            refValue: ref.refValue as string,
            url: (ref.url as string) ?? null,
            title: (ref.title as string) ?? null,
            status: (ref.status as string) ?? null,
            metadata: ref.metadata ?? null,
            createdAt: now,
          })
          .run();
      }
    }

    return newProjectId;
  });

  // Execute transaction
  const importedProjectId = runImport();

  // Return the new project
  const newProject = db.select().from(projects).where(eq(projects.id, importedProjectId)).get();

  return newProject as unknown as Record<string, unknown>;
}

// ─── Backup ───────────────────────────────────────────────────────

/**
 * Create a backup of the SQLite database file.
 */
export function backupDatabase(): BackupResult {
  const rawDb = getRawDb();
  const dbPath = rawDb.pragma("database_list") as Array<{
    file: string;
  }>;

  const currentDbPath = dbPath[0]?.file;
  if (!currentDbPath || currentDbPath === "" || currentDbPath === ":memory:") {
    throw new AppError(400, "BACKUP_ERROR", "Cannot backup an in-memory database");
  }

  // Create backup directory
  const backupDir = path.join(path.dirname(currentDbPath), "backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // Generate backup filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFileName = `pm-${timestamp}.db`;
  const backupPath = path.join(backupDir, backupFileName);

  // Use SQLite backup API via better-sqlite3
  rawDb.backup(backupPath);

  // Get backup file size
  const stats = fs.statSync(backupPath);

  return {
    path: backupPath,
    size: stats.size,
    timestamp: new Date().toISOString(),
  };
}
