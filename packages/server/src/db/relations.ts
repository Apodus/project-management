import { relations } from "drizzle-orm";
import {
  workspaces,
  agentPools,
  users,
  projects,
  milestones,
  proposals,
  epics,
  tasks,
  taskDependencies,
  labels,
  taskLabels,
  comments,
  activityLog,
  gitRefs,
  sessions,
  automationRules,
  templates,
  agentClaims,
} from "./schema.js";

// ─── workspaces ────────────────────────────────────────────────────
export const workspacesRelations = relations(workspaces, ({ many }) => ({
  projects: many(projects),
}));

// ─── agent_pools ──────────────────────────────────────────────────
export const agentPoolsRelations = relations(agentPools, ({ one, many }) => ({
  creator: one(users, {
    fields: [agentPools.createdBy],
    references: [users.id],
    relationName: "poolCreator",
  }),
  agents: many(users, { relationName: "poolAgents" }),
}));

// ─── users ─────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ one, many }) => ({
  pool: one(agentPools, {
    fields: [users.poolId],
    references: [agentPools.id],
    relationName: "poolAgents",
  }),
  createdProjects: many(projects),
  createdPools: many(agentPools, { relationName: "poolCreator" }),
  createdProposals: many(proposals, { relationName: "proposalCreator" }),
  resolvedProposals: many(proposals, { relationName: "proposalResolver" }),
  createdEpics: many(epics, { relationName: "epicCreator" }),
  assignedEpics: many(epics, { relationName: "epicAssignee" }),
  assignedTasks: many(tasks, { relationName: "taskAssignee" }),
  reportedTasks: many(tasks, { relationName: "taskReporter" }),
  comments: many(comments),
  activityLogs: many(activityLog),
  sessions: many(sessions),
  agentClaims: many(agentClaims),
}));

// ─── sessions ─────────────────────────────────────────────────────
export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

// ─── projects ──────────────────────────────────────────────────────
export const projectsRelations = relations(projects, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [projects.workspaceId],
    references: [workspaces.id],
  }),
  creator: one(users, {
    fields: [projects.createdBy],
    references: [users.id],
  }),
  proposals: many(proposals),
  epics: many(epics),
  tasks: many(tasks),
  labels: many(labels),
  milestones: many(milestones),
  activityLogs: many(activityLog),
  automationRules: many(automationRules),
  templates: many(templates),
}));

// ─── milestones ────────────────────────────────────────────────────
export const milestonesRelations = relations(milestones, ({ one, many }) => ({
  project: one(projects, {
    fields: [milestones.projectId],
    references: [projects.id],
  }),
  epics: many(epics),
}));

// ─── proposals ─────────────────────────────────────────────────────
export const proposalsRelations = relations(proposals, ({ one, many }) => ({
  project: one(projects, {
    fields: [proposals.projectId],
    references: [projects.id],
  }),
  creator: one(users, {
    fields: [proposals.createdBy],
    references: [users.id],
    relationName: "proposalCreator",
  }),
  resolver: one(users, {
    fields: [proposals.resolvedBy],
    references: [users.id],
    relationName: "proposalResolver",
  }),
  epics: many(epics),
  tasks: many(tasks),
  comments: many(comments),
}));

// ─── epics ─────────────────────────────────────────────────────────
export const epicsRelations = relations(epics, ({ one, many }) => ({
  project: one(projects, {
    fields: [epics.projectId],
    references: [projects.id],
  }),
  proposal: one(proposals, {
    fields: [epics.proposalId],
    references: [proposals.id],
  }),
  milestone: one(milestones, {
    fields: [epics.milestoneId],
    references: [milestones.id],
  }),
  creator: one(users, {
    fields: [epics.createdBy],
    references: [users.id],
    relationName: "epicCreator",
  }),
  assignee: one(users, {
    fields: [epics.assigneeId],
    references: [users.id],
    relationName: "epicAssignee",
  }),
  tasks: many(tasks),
}));

// ─── agent_claims ─────────────────────────────────────────────────
export const agentClaimsRelations = relations(agentClaims, ({ one }) => ({
  user: one(users, {
    fields: [agentClaims.userId],
    references: [users.id],
  }),
}));

// ─── tasks ─────────────────────────────────────────────────────────
export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
  }),
  proposal: one(proposals, {
    fields: [tasks.proposalId],
    references: [proposals.id],
  }),
  epic: one(epics, {
    fields: [tasks.epicId],
    references: [epics.id],
  }),
  parentTask: one(tasks, {
    fields: [tasks.parentTaskId],
    references: [tasks.id],
    relationName: "subtasks",
  }),
  subtasks: many(tasks, { relationName: "subtasks" }),
  assignee: one(users, {
    fields: [tasks.assigneeId],
    references: [users.id],
    relationName: "taskAssignee",
  }),
  reporter: one(users, {
    fields: [tasks.reporterId],
    references: [users.id],
    relationName: "taskReporter",
  }),
  dependencies: many(taskDependencies, { relationName: "taskDeps" }),
  dependents: many(taskDependencies, { relationName: "taskDependents" }),
  taskLabels: many(taskLabels),
  comments: many(comments),
  gitRefs: many(gitRefs),
}));

// ─── task_dependencies ─────────────────────────────────────────────
export const taskDependenciesRelations = relations(
  taskDependencies,
  ({ one }) => ({
    task: one(tasks, {
      fields: [taskDependencies.taskId],
      references: [tasks.id],
      relationName: "taskDeps",
    }),
    dependsOnTask: one(tasks, {
      fields: [taskDependencies.dependsOnTaskId],
      references: [tasks.id],
      relationName: "taskDependents",
    }),
  }),
);

// ─── labels ────────────────────────────────────────────────────────
export const labelsRelations = relations(labels, ({ one, many }) => ({
  project: one(projects, {
    fields: [labels.projectId],
    references: [projects.id],
  }),
  taskLabels: many(taskLabels),
}));

// ─── task_labels ───────────────────────────────────────────────────
export const taskLabelsRelations = relations(taskLabels, ({ one }) => ({
  task: one(tasks, {
    fields: [taskLabels.taskId],
    references: [tasks.id],
  }),
  label: one(labels, {
    fields: [taskLabels.labelId],
    references: [labels.id],
  }),
}));

// ─── comments ──────────────────────────────────────────────────────
export const commentsRelations = relations(comments, ({ one }) => ({
  task: one(tasks, {
    fields: [comments.taskId],
    references: [tasks.id],
  }),
  proposal: one(proposals, {
    fields: [comments.proposalId],
    references: [proposals.id],
  }),
  author: one(users, {
    fields: [comments.authorId],
    references: [users.id],
  }),
}));

// ─── activity_log ──────────────────────────────────────────────────
export const activityLogRelations = relations(activityLog, ({ one }) => ({
  project: one(projects, {
    fields: [activityLog.projectId],
    references: [projects.id],
  }),
  actor: one(users, {
    fields: [activityLog.actorId],
    references: [users.id],
  }),
}));

// ─── automation_rules ─────────────────────────────────────────────
export const automationRulesRelations = relations(automationRules, ({ one }) => ({
  project: one(projects, {
    fields: [automationRules.projectId],
    references: [projects.id],
  }),
  creator: one(users, {
    fields: [automationRules.createdBy],
    references: [users.id],
  }),
}));

// ─── templates ───────────────────────────────────────────────────
export const templatesRelations = relations(templates, ({ one }) => ({
  project: one(projects, {
    fields: [templates.projectId],
    references: [projects.id],
  }),
  creator: one(users, {
    fields: [templates.createdBy],
    references: [users.id],
  }),
}));

// ─── git_refs ──────────────────────────────────────────────────────
export const gitRefsRelations = relations(gitRefs, ({ one }) => ({
  task: one(tasks, {
    fields: [gitRefs.taskId],
    references: [tasks.id],
  }),
}));
