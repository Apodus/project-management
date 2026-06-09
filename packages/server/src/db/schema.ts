import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  check,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type {
  CodeLocator,
  MergeResolutionDetail,
  NoteAnchorType,
  NoteKind,
  NoteSeverity,
  NoteStatus,
  NoteTriageOutcome,
  VerifyStepResult,
} from "@pm/shared";

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
  (table) => [uniqueIndex("idx_projects_workspace_slug").on(table.workspaceId, table.slug)],
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
    // Campaign C2: provenance back-pointer to the note this was promoted from.
    // notes is defined BELOW → forward-ref arrow required (mergeRequests.resolvedFrom precedent).
    sourceNoteId: text("source_note_id").references((): AnySQLiteColumn => notes.id, {
      onDelete: "set null",
    }),
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
  category: text("category"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  createdBy: text("created_by").references(() => users.id),
});

// ─── epic_dependencies ─────────────────────────────────────────────
export const epicDependencies = sqliteTable(
  "epic_dependencies",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    epicId: text("epic_id")
      .notNull()
      .references(() => epics.id),
    dependsOnEpicId: text("depends_on_epic_id")
      .notNull()
      .references(() => epics.id),
    dependencyType: text("dependency_type").notNull().default("blocks"),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").references(() => users.id), // DB-nullable, mirrors epics.createdBy
  },
  (table) => [
    index("idx_epic_deps_epic").on(table.epicId),
    index("idx_epic_deps_depends_on").on(table.dependsOnEpicId),
    index("idx_epic_deps_project").on(table.projectId),
    uniqueIndex("idx_epic_deps_unique").on(
      table.epicId,
      table.dependsOnEpicId,
      table.dependencyType,
    ),
    check("epic_deps_no_self", sql`${table.epicId} <> ${table.dependsOnEpicId}`),
  ],
);

// ─── agent_claims ─────────────────────────────────────────────────
export const agentClaims = sqliteTable(
  "agent_claims",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    claimedAt: text("claimed_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    heartbeatAt: text("heartbeat_at").notNull(),
    poolSecretHash: text("pool_secret_hash"),
    // ─── Stable worker identity (C1) ─────────────────────────────────
    // A keyed binding ties a stable (pool, workerKey) tuple to a single
    // users row across reconnects, killing the reconnect→new-identity bug.
    // All three are NULL for legacy keyless claims (byte-identical 7.x).
    // workerKeyPoolId mirrors the owning pool so the partial unique index
    // scopes keys per-pool (the same workerKey in two pools is distinct).
    // bindHandle is an opaque per-binding correlation token handed to the
    // client so it can prove continuity of the same binding.
    workerKey: text("worker_key"),
    workerKeyPoolId: text("worker_key_pool_id"),
    bindHandle: text("bind_handle"),
  },
  (table) => [
    // Partial unique index: at most one binding per (pool, workerKey).
    // The migration is the runtime source of truth (db:generate is unused);
    // this declaration keeps the drizzle schema legible and the index name
    // discoverable. The `.where()` predicate restricts uniqueness to keyed
    // rows so keyless claims (worker_key NULL) are unconstrained.
    uniqueIndex("idx_agent_claims_worker")
      .on(table.workerKeyPoolId, table.workerKey)
      .where(sql`worker_key IS NOT NULL`),
  ],
);

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
    // Campaign C2: provenance back-pointer to the note this was promoted from.
    // notes is defined BELOW → forward-ref arrow required (mergeRequests.resolvedFrom precedent).
    sourceNoteId: text("source_note_id").references((): AnySQLiteColumn => notes.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("idx_tasks_project_status").on(table.projectId, table.status),
    index("idx_tasks_project_epic").on(table.projectId, table.epicId),
    index("idx_tasks_assignee").on(table.assigneeId),
    index("idx_tasks_parent").on(table.parentTaskId),
    index("idx_tasks_priority").on(table.projectId, table.priority),
    index("idx_tasks_status_priority").on(table.projectId, table.status, table.priority),
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
  (table) => [uniqueIndex("idx_labels_project_name").on(table.projectId, table.name)],
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
    index("idx_activity_entity").on(table.entityType, table.entityId, table.createdAt),
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
    uniqueIndex("idx_merge_locks_project_resource").on(table.projectId, table.resource),
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
    // Phase 7.6 lineage (§4.1): on a resolved request this self-references
    // the origin (conflicting) request id; null on every normal request.
    // ON DELETE SET NULL so deleting an origin never cascades into the
    // resolved request it spawned. The (): AnySQLiteColumn arrow is required
    // for a self-reference within the same table definition.
    resolvedFrom: text("resolved_from").references((): AnySQLiteColumn => mergeRequests.id, {
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
    index("idx_merge_requests_project_status").on(table.projectId, table.status),
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
    // Phase 7.5: per-step pipeline results (additive, nullable). Null on all
    // 7.1-7.4 attempts (no backfill). Feeds the per-request timeline only;
    // the metric per_step derives from verify_cache (design §7.1).
    steps: text("steps", { mode: "json" }).$type<VerifyStepResult[]>(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // UNIQUE structurally enforces monotonic numbering per request —
    // defense-in-depth against caller-discipline bugs. Service uses
    // MAX(attemptNumber)+1 within the same operation.
    uniqueIndex("idx_merge_attempts_request_num").on(table.requestId, table.attemptNumber),
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
    index("idx_merge_request_groups_project_state").on(table.projectId, table.state),
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
    innerRequestId: text("inner_request_id").references(() => mergeRequests.id, {
      onDelete: "set null",
    }),
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
    index("idx_merge_incidents_project_state").on(table.projectId, table.state),
    index("idx_merge_incidents_group").on(table.groupId),
    // The recovery sweep's hot path: open orphaned_inner incidents for
    // this project, oldest first.
    index("idx_merge_incidents_open").on(table.projectId, table.state, table.type, table.openedAt),
  ],
);

// ─── audit_log ─────────────────────────────────────────────────────
// Phase 7.4 (§2): the dedicated, append-only accountability record of
// "who did what to the train and why." Action-centric (NOT entity-centric
// like activity_log): every break-glass override (pause/resume/
// force_release_lock/force_land/force_reject) AND every natural land/reject
// writes exactly one row, in the same db.transaction as the state change it
// records. Immutable by construction — there is deliberately NO updatedAt and
// the service exports no update/delete (an audit row is written once, never
// mutated). PM-owned; survives the integrator process that performed the act.
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    // The lane scope. Audit is always project-scoped. NOT nullable.
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    // The HUMAN (override) or ai_agent (natural land/reject) who performed
    // the action — the accountability datum. NOT nullable.
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id),
    // The action taxonomy (§2.3). Enum AUDIT_ACTIONS (local to
    // audit.service for Step 2; hoisted to @pm/shared in Step 8). Stored as
    // text; the enum is the validation gate.
    action: text("action").notNull(),
    // What the action targeted: "merge_request" | "merge_lock" | "train"
    // | "merge_group". Enum AUDIT_TARGET_TYPES.
    targetType: text("target_type").notNull(),
    // The target's identifier (a merge_requests.id, a lock resource name, a
    // group id, or the resource for a train-level action). NOT an FK —
    // targets are heterogeneous (a resource name is not a row id).
    targetId: text("target_id").notNull(),
    // Free-text reason. Required for force_land/force_reject (enforced in the
    // service); optional/null for the rest.
    reason: text("reason"),
    // Structured snapshot of the target's relevant fields BEFORE the action.
    metadataBefore: text("metadata_before", { mode: "json" }).$type<Record<string, unknown>>(),
    // Structured snapshot AFTER.
    metadataAfter: text("metadata_after", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // Query-by-time-window within a project (the audit-log view default).
    index("idx_audit_log_project_created").on(table.projectId, table.createdAt),
    // Query-by-actor (the "everything this operator did" view).
    index("idx_audit_log_actor").on(table.actorId, table.createdAt),
    // Query-by-target (the per-request / lock / lane history view).
    index("idx_audit_log_target").on(table.targetType, table.targetId, table.createdAt),
  ],
);

// ─── integrator_health ─────────────────────────────────────────────
// Phase 7.4 (§3): the dedicated heartbeat / liveness channel. The
// integrator POSTs a periodic heartbeat (status + worktree-pool utilization
// + in-flight counts + version) regardless of whether it holds a lane lock,
// so liveness is observable even when the integrator is IDLE (holds no
// lock) — exactly when lock-derived freshness is blind (§3.1). One row per
// (project, resource) lane (the lock/health cardinality). The unique index
// makes the heartbeat an upsert (insert-if-absent, else update lastSeenAt +
// the denormalized payload). Staleness of lastSeenAt is computed ON-READ
// (§3.4) and raises train.integrator_unhealthy edge-triggered via
// unhealthyNotified. PM-owned; survives integrator crashes.
export const integratorHealth = sqliteTable(
  "integrator_health",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    resource: text("resource").notNull().default("main"),
    // The integrator user (ai_agent) that last heartbeated this lane. ON
    // DELETE SET NULL so a deleted integrator user doesn't cascade away the
    // health row.
    integratorId: text("integrator_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // The heartbeat's status ("idle" | "integrating").
    status: text("status").notNull(),
    // Pool utilization, denormalized from the heartbeat payload.
    poolSize: integer("pool_size"),
    poolLeased: integer("pool_leased"),
    // In-flight counts, denormalized.
    inFlightRequests: integer("in_flight_requests").notNull().default(0),
    inFlightBatches: integer("in_flight_batches").notNull().default(0),
    inFlightGroups: integer("in_flight_groups").notNull().default(0),
    version: text("version"),
    // THE liveness datum — the ISO timestamp of the most recent heartbeat.
    // Staleness of this is train.integrator_unhealthy (§3.4).
    lastSeenAt: text("last_seen_at").notNull(),
    // Tracks whether we have ALREADY raised integrator_unhealthy for the
    // current stale episode, so on-read detection (§3.4) fires exactly ONCE
    // per stale→healthy→stale cycle (edge-triggered, not level-triggered).
    // Reset to false on the next fresh heartbeat.
    unhealthyNotified: integer("unhealthy_notified", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_integrator_health_project_resource").on(table.projectId, table.resource),
  ],
);

// ─── train_state ───────────────────────────────────────────────────
// Phase 7.4 (§4.1): the per-(project, resource) lane pause/resume control
// state. "running" | "paused", default "running". A human writes it via the
// pause/resume break-glass overrides; the integrator reads it on every poll
// to decide whether to admit NEW work (pause = stop new pickups, finish
// in-flight — §4.2). NOT a project-settings column: it is operational control
// state, per-resource, mutated by an override and read on every poll. One row
// per lane (the lock/health cardinality). Lazy-created on first read/write
// (the getOrCreateLock idiom). The unique index makes the upsert race-safe.
// stuckNotified / abandonNotified are edge-trigger debounce flags for the
// on-read alerts (§7.3) — each fires once per breach episode. PM-owned.
export const trainState = sqliteTable(
  "train_state",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    resource: text("resource").notNull().default("main"),
    // "running" | "paused". Enum TRAIN_STATES in @pm/shared. Default "running".
    state: text("state").notNull().default("running"),
    // The actor who last paused/resumed, and when — a denormalized convenience
    // for the dashboard read ("paused by alice 4m ago"); the audit row is the
    // canonical record. ON DELETE SET NULL so a deleted user doesn't cascade.
    changedBy: text("changed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    changedAt: text("changed_at"),
    // Edge-trigger debounce flags for the on-read alerts (§7.3). Each is set
    // true when its alert fires and reset to false when the condition clears.
    stuckNotified: integer("stuck_notified", { mode: "boolean" }).notNull().default(false),
    abandonNotified: integer("abandon_notified", { mode: "boolean" }).notNull().default(false),
    stalledNotified: integer("stalled_notified", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_train_state_project_resource").on(table.projectId, table.resource)],
);

// ─── verify_cache ───────────────────────────────────────────────────
// Phase 7.5 (§3.1): the PM-owned verify-result cache. One row per distinct
// (project, resource, tree_sha, step_id, step_config_sha) tuple — a verify
// step's pass/fail verdict for an exact tree + an exact step config. The
// integrator queries this before a step (a HIT skips the run and reuses the
// verdict) and records it after a real run. The cache key is STRICT (§3.2):
// the lookup is a single equality probe on the unique index — ANY tree-content
// OR step-config change is a different key → a MISS. There is no fuzzy/prefix
// match, so no stale row can ever false-pass a verify that would really fail.
// Content-addressed (tree_sha is a git tree hash) → a row is correct forever
// for its key, so NO TTL / no eviction in 7.5 (§3.5). hit_count / last_hit_at
// drive the cache-hit-rate + time-saved metrics (§7.2). PM-owned, durable;
// survives integrator restarts and is shared across integrators on a lane.
export const verifyCache = sqliteTable(
  "verify_cache",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    resource: text("resource").notNull().default("main"),
    // ── The strict cache key (§3.2) ──
    treeSha: text("tree_sha").notNull(), // the rebased tree the step verified
    stepId: text("step_id").notNull(), // the verify_steps[].id this verdict is for
    stepConfigSha: text("step_config_sha").notNull(), // §3.3 — hash of the step's verdict-affecting config
    // ── The verdict ──
    result: text("result").notNull(), // "pass" | "fail" (VERIFY_RESULTS enum, @pm/shared)
    durationMs: integer("duration_ms"), // the real run's duration (for time-saved metrics §7)
    logExcerpt: text("log_excerpt"), // a short tail of the run log
    logUrl: text("log_url"), // pointer to the full log (integrator-supplied)
    // ── Bookkeeping ──
    createdAt: text("created_at").notNull(), // when this verdict was first recorded
    lastHitAt: text("last_hit_at"), // last time this row served a hit (null until first hit)
    hitCount: integer("hit_count").notNull().default(0), // number of skips this row has served
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // THE lookup index — also the strict-key uniqueness guarantee (§3.2, §4.1).
    uniqueIndex("idx_verify_cache_key").on(
      table.projectId,
      table.resource,
      table.treeSha,
      table.stepId,
      table.stepConfigSha,
    ),
    // Dashboard / debug GET (§8.4) + the cache-hit-rate metric (§7): recent
    // rows per lane (the metrics path).
    index("idx_verify_cache_project_resource_created").on(
      table.projectId,
      table.resource,
      table.createdAt,
    ),
  ],
);

// ─── merge_resolutions ─────────────────────────────────────────────
// Phase 7.6 (§4.2): the durable record of a conflict-resolution attempt.
// When the integrator hits a RebaseConflict and the resolver is enabled, it
// rejects the origin request, releases the lane lock, and enqueues a
// resolution row here. The resolver worker drives state transitions over the
// REST surface (Step 6). PM owns the state; the integrator owns the in-flight
// scheduling in memory (no batch tables — same stance as 7.2).
//
// State machine (§4.3, enum MERGE_RESOLUTION_STATES):
//   pending → resolving → resolved | escalated | failed
export const mergeResolutions = sqliteTable(
  "merge_resolutions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    resource: text("resource").notNull().default("main"),
    // The conflicting (origin) request. ON DELETE SET NULL so a deleted
    // request never cascade-deletes the durable resolution record.
    originRequestId: text("origin_request_id").references(() => mergeRequests.id, {
      onDelete: "set null",
    }),
    // The new request the resolver submits once it produces a clean tree.
    // Null until §5.3 resubmit; ON DELETE SET NULL for the same reason.
    resolvedRequestId: text("resolved_request_id").references(() => mergeRequests.id, {
      onDelete: "set null",
    }),
    // Resolution state machine (§4.3). Enum MERGE_RESOLUTION_STATES.
    state: text("state").notNull().default("pending"),
    // JSON-encoded string[] — the conflicting files, copied from the
    // RebaseConflict that triggered this resolution.
    conflictingFiles: text("conflicting_files", {
      mode: "json",
    }).$type<string[]>(),
    attemptStartedAt: text("attempt_started_at"),
    attemptEndedAt: text("attempt_ended_at"),
    // Where an escalated/failed resolution is routed: "author" | "human" |
    // null. Enum MERGE_ESCALATION_TARGETS.
    escalationTarget: text("escalation_target"),
    // Structured detail. JSON: { budgetConsumedSec?, tokensConsumed?,
    // verifyVerdict?, escalationReason?, logUrl? }. Null until the resolver
    // runs.
    detail: text("detail", { mode: "json" }).$type<MergeResolutionDetail>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_merge_resolutions_project_state").on(table.projectId, table.state),
    // The resolver-pickup hot path: pending resolutions for a lane, oldest
    // first.
    index("idx_merge_resolutions_resource_state").on(
      table.projectId,
      table.resource,
      table.state,
      table.createdAt,
    ),
    index("idx_merge_resolutions_origin").on(table.originRequestId),
  ],
);

// ─── claim_leases ──────────────────────────────────────────────────
// Campaign C2 (§P1): the PM-owned liveness lease for an entity claim
// (task | epic | proposal). A claim is no longer a static `claimedBy`
// flag that strands forever when its holder dies — it is a TTL lease
// that a live holder refreshes by heartbeat and a reclaim sweep can
// reconcile-or-escalate when it lapses. One ACTIVE lease per entity (the
// unique (entityType, entityId) index). The holder is a user (ON DELETE
// SET NULL so a deleted holder leaves the lease orphaned-but-reclaimable
// rather than cascade-deleting the record). sessionId is the optional
// per-session correlation handle the holder supplies.
//
// NOTE: P1 adds the TABLE ONLY. No service reads or writes it yet, and
// there is intentionally no runtime behavior change — the lease engine
// (read/heartbeat/reclaim) lands in later phases behind LEASE_MODES
// (default "shadow"). No projectId column: the P4 audit write sources
// projectId from the entity row (the forceClaim precedent).
export const claimLeases = sqliteTable(
  "claim_leases",
  {
    id: text("id").primaryKey(),
    // The claimed entity: "task" | "epic" | "proposal" (LEASE_ENTITY_TYPES
    // in @pm/shared). Plain text validated against the enum — heterogeneous
    // targets, so NOT an FK.
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    // The lease holder. ON DELETE SET NULL — a deleted user leaves the lease
    // orphaned-but-reclaimable, never cascade-deletes the record.
    holderId: text("holder_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // The lease lifecycle timestamps (ISO strings, house convention).
    claimedAt: text("claimed_at").notNull(),
    heartbeatAt: text("heartbeat_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    // Optional per-session correlation handle supplied by the holder.
    sessionId: text("session_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // One ACTIVE lease per entity — the uniqueness guarantee + the
    // claim-lookup hot path.
    uniqueIndex("idx_claim_leases_entity").on(table.entityType, table.entityId),
    // The reclaim sweep's hot path: lapsed leases of a given type, by expiry.
    index("idx_claim_leases_type_expires").on(table.entityType, table.expiresAt),
    // The "everything this holder holds" view.
    index("idx_claim_leases_holder").on(table.holderId),
  ],
);

// ─── claims_alert_state ─────────────────────────────────────────────
// Campaign C3 (§P5a): the per-project edge-trigger latch for the stale-claim
// alert. Mirrors train_state's stuck/abandon latches EXACTLY — a single boolean
// debounce flag set true when the stale-claim alert fires and reset to false
// when the condition clears, so the on-read detection (claims-health.service
// computeClaimsHealth) fires the alert exactly ONCE per stale episode and
// re-arms when the stale claims are cleared (renewed / reassigned / reclaimed).
//
// One row per project (claim_leases carries NO projectId, and staleness is
// derived per-project by resolving each lapsed lease's entity — so the latch is
// project-scoped, not per-(project, resource) like the train lane). Lazy-created
// on first read/write (the getOrCreateTrainState idiom). The unique index makes
// the upsert race-safe. PM-owned, durable.
export const claimsAlertState = sqliteTable(
  "claims_alert_state",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    // The edge-trigger debounce flag for the on-read stale-claim alert. Set
    // true when the alert fires and reset to false when the condition clears.
    staleClaimsNotified: integer("stale_claims_notified", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_claims_alert_state_project").on(table.projectId)],
);

// ─── notes ──────────────────────────────────────────────────────────
// Campaign C1 (Notes / Findings Inbox §P2): the capture surface for
// bugs/questions/ideas/tech_debt/wtf/observations jotted mid-flow. C1 adds
// the TABLE + capture only; the open→triaged transition and its metadata are
// deferred to C2. Enum-valued columns (kind/status/anchorType/severity) are
// plain text validated in the app layer (claim_leases precedent). anchorType/
// anchorId are a heterogeneous polymorphic anchor — NOT FKs; NULL anchorType
// is the single encoding for "no anchor" (no sentinel). Field names mirror the
// @pm/shared note schema (P1) exactly.
export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    kind: text("kind").notNull().$type<NoteKind>(),
    status: text("status").notNull().default("open").$type<NoteStatus>(),
    title: text("title").notNull(),
    body: text("body"),
    anchorType: text("anchor_type").$type<NoteAnchorType>(),
    anchorId: text("anchor_id"),
    codeLocator: text("code_locator", { mode: "json" }).$type<CodeLocator>(),
    severity: text("severity").$type<NoteSeverity>(),
    // ─── Triage metadata (Campaign C2) ───────────────────────────────
    // Server-driven on the open→triaged transition (P2 dismiss / P3-P4
    // promote). All null until triaged. proposals/tasks/users precede notes
    // → plain backward () => refs are fine here.
    triagedAt: text("triaged_at"),
    triagedBy: text("triaged_by").references(() => users.id, { onDelete: "set null" }),
    triageOutcome: text("triage_outcome").$type<NoteTriageOutcome>(),
    triageReason: text("triage_reason"),
    promotedProposalId: text("promoted_proposal_id").references(() => proposals.id, {
      onDelete: "set null",
    }),
    promotedTaskId: text("promoted_task_id").references(() => tasks.id, { onDelete: "set null" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_notes_project_status").on(table.projectId, table.status),
    index("idx_notes_anchor").on(table.anchorType, table.anchorId),
    index("idx_notes_project_kind_status").on(table.projectId, table.kind, table.status),
  ],
);

// ─── notes_alert_state ──────────────────────────────────────────────
// Campaign C2 (notes triage §P5): the per-project latch for the on-read,
// edge-triggered backlog-age alert. Mirrors claims_alert_state exactly — a
// single edge-trigger debounce flag set true when the alert fires and reset to
// false when the backlog clears, so the alert fires exactly ONCE per backlog
// episode and re-arms on resolution. Lazy-created on first read/write; the
// unique (project_id) index makes the upsert race-safe. PM-owned, durable.
export const notesAlertState = sqliteTable(
  "notes_alert_state",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    backlogNotified: integer("backlog_notified", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_notes_alert_state_project").on(table.projectId)],
);
