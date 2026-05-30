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

// ─── agent_pools ──────────────────────────────────────────────────
export const agentPools = sqliteTable(
  "agent_pools",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    secretHash: text("secret_hash"),
    description: text("description"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // FK to users.id — not declared with .references() to avoid circular TS ref
    createdBy: text("created_by"),
  },
  (table) => [uniqueIndex("idx_agent_pools_name").on(table.name)],
);

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
    poolId: text("pool_id").references(() => agentPools.id),
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
    claimedBy: text("claimed_by").references(() => users.id),
    resolvedBy: text("resolved_by").references(() => users.id),
    resolvedAt: text("resolved_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_proposals_project_status").on(table.projectId, table.status),
    index("idx_proposals_created_by").on(table.createdBy),
    index("idx_proposals_claimed_by").on(table.claimedBy),
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
  assigneeId: text("assignee_id").references(() => users.id),
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

// ─── agent_claims ─────────────────────────────────────────────────
export const agentClaims = sqliteTable("agent_claims", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  claimedAt: text("claimed_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  heartbeatAt: text("heartbeat_at").notNull(),
  poolSecretHash: text("pool_secret_hash"),
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

// ─── merge_locks ───────────────────────────────────────────────────
// Per-project named coordination locks (e.g. resource = "main"). One
// holder at a time per (project, resource); contending callers wait in
// merge_lock_queue. Lease is TTL-based: heartbeat refreshes expires_at,
// and any operation opportunistically sweeps a holder whose lease has
// elapsed.
export const mergeLocks = sqliteTable(
  "merge_locks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    resource: text("resource").notNull(),
    holderId: text("holder_id").references(() => users.id),
    acquiredAt: text("acquired_at"),
    heartbeatAt: text("heartbeat_at"),
    expiresAt: text("expires_at"),
    landedSha: text("landed_sha"),
    landedAt: text("landed_at"),
    // Landing intent — what the holder is trying to land. Cleared on
    // release/expire. All optional; some are project-shared (taskId,
    // branch, commitSha, verifyCmd) and one is per-machine but useful
    // when agents share a host (worktreePath).
    taskId: text("task_id").references(() => tasks.id),
    branch: text("branch"),
    commitSha: text("commit_sha"),
    verifyCmd: text("verify_cmd"),
    worktreePath: text("worktree_path"),
    // Set when the holder releases without landed_sha — gives observers
    // and the next queue head context about why main hasn't moved.
    abandonReason: text("abandon_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_merge_locks_project_resource").on(
      table.projectId,
      table.resource,
    ),
    index("idx_merge_locks_holder").on(table.holderId),
  ],
);

export const mergeLockQueue = sqliteTable(
  "merge_lock_queue",
  {
    id: text("id").primaryKey(),
    lockId: text("lock_id")
      .notNull()
      .references(() => mergeLocks.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    enqueuedAt: text("enqueued_at").notNull(),
    notifiedAt: text("notified_at"),
    // Landing intent carried while queued — copied onto the held lock
    // row when the queue head advances.
    taskId: text("task_id").references(() => tasks.id),
    branch: text("branch"),
    commitSha: text("commit_sha"),
    verifyCmd: text("verify_cmd"),
    worktreePath: text("worktree_path"),
  },
  (table) => [
    index("idx_queue_lock_enqueued").on(table.lockId, table.enqueuedAt),
    uniqueIndex("idx_queue_lock_user").on(table.lockId, table.userId),
  ],
);

// ─── merge_requests ────────────────────────────────────────────────
// Phase 7.1 Stage 2: worker-submitted merge requests. The worker calls
// pm_request_merge and exits; a single integrator process per
// (projectId, resource) lane picks the oldest queued request, rebases
// onto live main, runs verify, and either lands or rejects.
//
// Lifecycle (full state machine in docs/design/phase-7.1-design.md §5.1):
//   queued → integrating → landed | rejected
//   queued → abandoned                 (submitter or admin cancel)
//   integrating → abandoned            (admin force-cancel only)
//   integrating → queued               (push-race or crash recovery — back-edge)
export const mergeRequests = sqliteTable(
  "merge_requests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    resource: text("resource").notNull().default("main"),
    submittedBy: text("submitted_by")
      .notNull()
      .references(() => users.id),
    // taskId is nullable AND uses ON DELETE SET NULL so a request whose
    // task gets deleted mid-flight still resolves cleanly. The auto
    // side-effects (git_refs on land, merge_rejection comment on reject)
    // are skipped when taskId is null at resolution time.
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    branch: text("branch"),
    commitSha: text("commit_sha"),
    verifyCmd: text("verify_cmd"),
    worktreePath: text("worktree_path"),
    // Phase 7.3: nullable association to the atomic group this request is a
    // member of (§3.2). ON DELETE SET NULL — a deleted group orphans nothing;
    // members degrade cleanly to single-repo requests. The lazy () => arrow
    // forward-refs mergeRequestGroups (defined below).
    groupId: text("group_id").references(() => mergeRequestGroups.id, {
      onDelete: "set null",
    }),
    // status enum lives in @pm/shared (MERGE_REQUEST_STATUSES) — added in
    // Step 3. Default "queued" matches the initial-state convention.
    status: text("status").notNull().default("queued"),
    enqueuedAt: text("enqueued_at").notNull(),
    pickedUpAt: text("picked_up_at"),
    resolvedAt: text("resolved_at"),
    landedSha: text("landed_sha"),
    rejectCategory: text("reject_category"),
    rejectReason: text("reject_reason"),
    // JSON-encoded string[] — paths implicated in the failure.
    failedFiles: text("failed_files", { mode: "json" }).$type<string[]>(),
    logExcerpt: text("log_excerpt"),
    logUrl: text("log_url"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_merge_requests_project_status").on(
      table.projectId,
      table.status,
    ),
    index("idx_merge_requests_resource_status").on(
      table.projectId,
      table.resource,
      table.status,
      table.enqueuedAt,
    ),
    index("idx_merge_requests_task").on(table.taskId),
    index("idx_merge_requests_group").on(table.groupId),
  ],
);

// ─── merge_attempts ────────────────────────────────────────────────
// One row per rebase+verify cycle for a merge_request. The integrator
// inserts a new row at status="pending" → flips to "running" → completes
// as "passed" | "failed" | "cancelled". Attempt failure ≠ request
// rejection — the integrator decides per outcome (see §5.2 of design).
export const mergeAttempts = sqliteTable(
  "merge_attempts",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => mergeRequests.id),
    attemptNumber: integer("attempt_number").notNull(),
    baseSha: text("base_sha").notNull(),
    treeSha: text("tree_sha"),
    // status enum: pending/running/passed/failed/cancelled (Step 3).
    status: text("status").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    verifyDurationMs: integer("verify_duration_ms"),
    // Same enum as merge_requests.rejectCategory (MERGE_REJECT_CATEGORIES).
    failureCategory: text("failure_category"),
    failureReason: text("failure_reason"),
    failedFiles: text("failed_files", { mode: "json" }).$type<string[]>(),
    logExcerpt: text("log_excerpt"),
    logUrl: text("log_url"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // UNIQUE structurally enforces monotonic numbering per request —
    // defense-in-depth against caller-discipline bugs. Service uses
    // MAX(attemptNumber)+1 within the same operation.
    uniqueIndex("idx_merge_attempts_request_num").on(
      table.requestId,
      table.attemptNumber,
    ),
  ],
);

// ─── merge_request_groups ──────────────────────────────────────────
// Phase 7.3 Stage: cross-repo atomicity. A group is a set of merge
// requests (one per linked repo) that must land together atomically or
// not at all. PM-owned; the integrator picks up the whole group under
// the SAME lane lock, assembles + verifies the linked state, and lands
// inner-then-outer (full state machine in docs/design/phase-7.3-design.md
// §3.3).
//
// Lifecycle:
//   forming → integrating → landed | rejected | partially_landed
//   forming → rejected                 (abandoned while forming)
export const mergeRequestGroups = sqliteTable(
  "merge_request_groups",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    resource: text("resource").notNull().default("main"),
    // Group state machine (§3.3). Enum lives in @pm/shared
    // (MERGE_GROUP_STATES) — added in Step 3. Default "forming".
    state: text("state").notNull().default("forming"),
    submittedBy: text("submitted_by")
      .notNull()
      .references(() => users.id),
    // The integrator that picked the group up (mirrors the lane-lock
    // holder). Null until integration begins.
    integratorId: text("integrator_id").references(() => users.id),
    resolvedAt: text("resolved_at"),
    // Free-text summary of why the group rejected or partially landed —
    // observer context, like merge_locks.abandonReason.
    resolutionReason: text("resolution_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_merge_request_groups_project_state").on(
      table.projectId,
      table.state,
    ),
    index("idx_merge_request_groups_resource_state").on(
      table.projectId,
      table.resource,
      table.state,
      table.createdAt,
    ),
  ],
);

// ─── merge_incidents ───────────────────────────────────────────────
// Phase 7.3: a recorded orphaned-inner event. When a group's inner repo
// lands but the outer push fails (§6.5), the inner main now references a
// commit the outer gitlink does not — an incident is opened to track and
// heal the divergence (auto-rollforward §7, or human resolution §7.5).
// PM-owned; survives group deletion (the orphan is a fact about main).
//
// Lifecycle:
//   open → auto_resolved | human_resolved
export const mergeIncidents = sqliteTable(
  "merge_incidents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    // The group whose land produced the orphan. ON DELETE SET NULL so a
    // deleted group never cascade-deletes the incident.
    groupId: text("group_id").references(() => mergeRequestGroups.id, {
      onDelete: "set null",
    }),
    // Incident type. For 7.3 the only value is "orphaned_inner"; enum
    // (MERGE_INCIDENT_TYPES) so 7.4+ can add types without a schema change.
    type: text("type").notNull(),
    innerRepo: text("inner_repo").notNull(),
    // The orphaned inner commit SHA: inner main landed here, outer gitlink
    // does NOT yet reference it. The heart of the incident.
    orphanedSha: text("orphaned_sha").notNull(),
    outerRepo: text("outer_repo").notNull(),
    // The inner member request whose land orphaned. ON DELETE SET NULL.
    innerRequestId: text("inner_request_id").references(
      () => mergeRequests.id,
      { onDelete: "set null" },
    ),
    // The task the incident comment is posted on (from the inner member's
    // taskId at open time). ON DELETE SET NULL.
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    // Incident state machine (§4.2). Enum MERGE_INCIDENT_STATES.
    state: text("state").notNull().default("open"),
    openedAt: text("opened_at").notNull(),
    resolvedAt: text("resolved_at"),
    // Structured resolution. JSON: { mode, outerLandedSha?,
    // resolvedByGroupId?, note? }. Null while open.
    resolution: text("resolution", { mode: "json" }).$type<{
      mode: "auto_rollforward" | "human";
      outerLandedSha?: string;
      resolvedByGroupId?: string;
      note?: string;
    }>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_merge_incidents_project_state").on(
      table.projectId,
      table.state,
    ),
    index("idx_merge_incidents_group").on(table.groupId),
    // The recovery sweep's hot path: open orphaned_inner incidents for
    // this project, oldest first.
    index("idx_merge_incidents_open").on(
      table.projectId,
      table.state,
      table.type,
      table.openedAt,
    ),
  ],
);
