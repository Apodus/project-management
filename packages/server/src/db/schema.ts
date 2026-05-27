import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";

// ─── workspaces ────────────────────────────────────────────────────
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  settings: text("settings", { mode: "json" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ─── users ─────────────────────────────────────────────────────────
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    role: text("role").notNull().default("member"),
    type: text("type").notNull().default("human"),
    avatarUrl: text("avatar_url"),
    passwordHash: text("password_hash"),
    apiTokenHash: text("api_token_hash"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_users_username").on(table.username)],
);

// ─── projects ──────────────────────────────────────────────────────
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    gitRepoUrl: text("git_repo_url"),
    settings: text("settings", { mode: "json" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    createdBy: text("created_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("idx_projects_workspace_slug").on(
      table.workspaceId,
      table.slug,
    ),
  ],
);

// ─── milestones ────────────────────────────────────────────────────
export const milestones = sqliteTable("milestones", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  name: text("name").notNull(),
  description: text("description"),
  targetDate: text("target_date"),
  status: text("status").notNull().default("open"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ─── proposals ─────────────────────────────────────────────────────
export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("open"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    resolvedBy: text("resolved_by").references(() => users.id),
    resolvedAt: text("resolved_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_proposals_project_status").on(table.projectId, table.status),
    index("idx_proposals_created_by").on(table.createdBy),
  ],
);

// ─── epics ─────────────────────────────────────────────────────────
export const epics = sqliteTable("epics", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  proposalId: text("proposal_id").references(() => proposals.id),
  milestoneId: text("milestone_id").references(() => milestones.id),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("draft"),
  priority: text("priority").notNull().default("medium"),
  targetDate: text("target_date"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  createdBy: text("created_by").references(() => users.id),
});

// ─── tasks ─────────────────────────────────────────────────────────
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    proposalId: text("proposal_id").references(() => proposals.id),
    epicId: text("epic_id").references(() => epics.id),
    parentTaskId: text("parent_task_id"),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("backlog"),
    priority: text("priority").notNull().default("medium"),
    type: text("type").notNull().default("feature"),
    assigneeId: text("assignee_id").references(() => users.id),
    reporterId: text("reporter_id")
      .notNull()
      .references(() => users.id),
    estimatedEffort: text("estimated_effort"),
    dueDate: text("due_date"),
    sortOrder: integer("sort_order").notNull().default(0),
    context: text("context", { mode: "json" }),
    gitBranch: text("git_branch"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("idx_tasks_project_status").on(table.projectId, table.status),
    index("idx_tasks_project_epic").on(table.projectId, table.epicId),
    index("idx_tasks_assignee").on(table.assigneeId),
    index("idx_tasks_parent").on(table.parentTaskId),
    index("idx_tasks_priority").on(table.projectId, table.priority),
    index("idx_tasks_status_priority").on(
      table.projectId,
      table.status,
      table.priority,
    ),
  ],
);

// ─── task_dependencies ─────────────────────────────────────────────
export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    dependsOnTaskId: text("depends_on_task_id")
      .notNull()
      .references(() => tasks.id),
    dependencyType: text("dependency_type").notNull().default("blocks"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_deps_task").on(table.taskId),
    index("idx_deps_depends_on").on(table.dependsOnTaskId),
  ],
);

// ─── labels ────────────────────────────────────────────────────────
export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    color: text("color"),
    description: text("description"),
  },
  (table) => [
    uniqueIndex("idx_labels_project_name").on(table.projectId, table.name),
  ],
);

// ─── task_labels ───────────────────────────────────────────────────
export const taskLabels = sqliteTable(
  "task_labels",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.labelId] })],
);

// ─── comments ──────────────────────────────────────────────────────
export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").references(() => tasks.id),
    proposalId: text("proposal_id").references(() => proposals.id),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    commentType: text("comment_type").notNull().default("comment"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_comments_task").on(table.taskId, table.createdAt),
    index("idx_comments_proposal").on(table.proposalId, table.createdAt),
  ],
);

// ─── sessions ─────────────────────────────────────────────────────
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_sessions_user").on(table.userId)],
);

// ─── activity_log ──────────────────────────────────────────────────
export const activityLog = sqliteTable(
  "activity_log",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    projectId: text("project_id").references(() => projects.id),
    actorId: text("actor_id").references(() => users.id),
    action: text("action").notNull(),
    changes: text("changes", { mode: "json" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_activity_project").on(table.projectId, table.createdAt),
    index("idx_activity_entity").on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
  ],
);

// ─── automation_rules ─────────────────────────────────────────────
export const automationRules = sqliteTable(
  "automation_rules",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    description: text("description"),
    triggerEvent: text("trigger_event").notNull(),
    conditions: text("conditions", { mode: "json" }),
    actionType: text("action_type").notNull(),
    actionConfig: text("action_config", { mode: "json" }),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    createdBy: text("created_by").references(() => users.id),
  },
  (table) => [
    index("idx_automation_rules_project").on(table.projectId),
    index("idx_automation_rules_trigger").on(table.projectId, table.triggerEvent),
  ],
);

// ─── templates ────────────────────────────────────────────────────
export const templates = sqliteTable(
  "templates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id),
    name: text("name").notNull(),
    description: text("description"),
    templateType: text("template_type").notNull(), // "task" or "project"
    templateData: text("template_data", { mode: "json" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    createdBy: text("created_by").references(() => users.id),
  },
  (table) => [
    index("idx_templates_project").on(table.projectId),
    index("idx_templates_type").on(table.templateType),
  ],
);

// ─── git_refs ──────────────────────────────────────────────────────
export const gitRefs = sqliteTable(
  "git_refs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    refType: text("ref_type").notNull(),
    refValue: text("ref_value").notNull(),
    url: text("url"),
    title: text("title"),
    status: text("status"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_git_refs_task").on(table.taskId),
    index("idx_git_refs_branch").on(table.refType, table.refValue),
  ],
);
