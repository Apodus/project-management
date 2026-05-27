import { z } from "zod";
import type {
  // Workspace
  selectWorkspaceSchema,
  insertWorkspaceSchema,
  workspaceSettingsSchema,
  // User
  selectUserSchema,
  insertUserSchema,
  // Project
  selectProjectSchema,
  insertProjectSchema,
  projectSettingsSchema,
  aiAutonomySettingsSchema,
  workflowSettingsSchema,
  gitSettingsSchema,
  // Proposal
  selectProposalSchema,
  insertProposalSchema,
  // Epic
  selectEpicSchema,
  insertEpicSchema,
  // Task
  selectTaskSchema,
  insertTaskSchema,
  taskContextSchema,
  // Comment
  selectCommentSchema,
  insertCommentSchema,
  progressUpdateMetadataSchema,
  decisionMetadataSchema,
  handoffMetadataSchema,
  commentMetadataSchema,
  // Label
  selectLabelSchema,
  insertLabelSchema,
  // Task Label
  taskLabelSchema,
  // Task Dependency
  selectTaskDependencySchema,
  insertTaskDependencySchema,
  // Activity Log
  selectActivityLogSchema,
  insertActivityLogSchema,
  activityChangesSchema,
  // Git Ref
  selectGitRefSchema,
  insertGitRefSchema,
  // Milestone
  selectMilestoneSchema,
  insertMilestoneSchema,
} from "../schemas/index.js";

// --- Workspace ---
export type Workspace = z.infer<typeof selectWorkspaceSchema>;
export type InsertWorkspace = z.infer<typeof insertWorkspaceSchema>;
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

// --- User ---
export type User = z.infer<typeof selectUserSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;

// --- Project ---
export type Project = z.infer<typeof selectProjectSchema>;
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type AiAutonomySettings = z.infer<typeof aiAutonomySettingsSchema>;
export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;
export type GitSettings = z.infer<typeof gitSettingsSchema>;

// --- Proposal ---
export type Proposal = z.infer<typeof selectProposalSchema>;
export type InsertProposal = z.infer<typeof insertProposalSchema>;

// --- Epic ---
export type Epic = z.infer<typeof selectEpicSchema>;
export type InsertEpic = z.infer<typeof insertEpicSchema>;

// --- Task ---
export type Task = z.infer<typeof selectTaskSchema>;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type TaskContext = z.infer<typeof taskContextSchema>;

// --- Comment ---
export type Comment = z.infer<typeof selectCommentSchema>;
export type InsertComment = z.infer<typeof insertCommentSchema>;
export type ProgressUpdateMetadata = z.infer<typeof progressUpdateMetadataSchema>;
export type DecisionMetadata = z.infer<typeof decisionMetadataSchema>;
export type HandoffMetadata = z.infer<typeof handoffMetadataSchema>;
export type CommentMetadata = z.infer<typeof commentMetadataSchema>;

// --- Label ---
export type Label = z.infer<typeof selectLabelSchema>;
export type InsertLabel = z.infer<typeof insertLabelSchema>;

// --- Task Label ---
export type TaskLabel = z.infer<typeof taskLabelSchema>;

// --- Task Dependency ---
export type TaskDependency = z.infer<typeof selectTaskDependencySchema>;
export type InsertTaskDependency = z.infer<typeof insertTaskDependencySchema>;

// --- Activity Log ---
export type ActivityLog = z.infer<typeof selectActivityLogSchema>;
export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;
export type ActivityChanges = z.infer<typeof activityChangesSchema>;

// --- Git Ref ---
export type GitRef = z.infer<typeof selectGitRefSchema>;
export type InsertGitRef = z.infer<typeof insertGitRefSchema>;

// --- Milestone ---
export type Milestone = z.infer<typeof selectMilestoneSchema>;
export type InsertMilestone = z.infer<typeof insertMilestoneSchema>;
