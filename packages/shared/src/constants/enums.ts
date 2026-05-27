// All enums as `as const` arrays with derived union types.
// This is the single source of truth for allowed values.

export const PROJECT_STATUSES = ["active", "paused", "archived", "completed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROPOSAL_STATUSES = [
  "open",
  "discussing",
  "accepted",
  "planned",
  "in_progress",
  "completed",
  "rejected",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const EPIC_STATUSES = ["draft", "active", "completed", "cancelled"] as const;
export type EpicStatus = (typeof EPIC_STATUSES)[number];

export const TASK_STATUSES = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MILESTONE_STATUSES = ["open", "closed"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TASK_TYPES = ["feature", "bug", "chore", "spike", "design", "research"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const EFFORT_SIZES = ["xs", "s", "m", "l", "xl"] as const;
export type EffortSize = (typeof EFFORT_SIZES)[number];

export const USER_ROLES = ["admin", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_TYPES = ["human", "ai_agent"] as const;
export type UserType = (typeof USER_TYPES)[number];

export const COMMENT_TYPES = [
  "comment",
  "progress_update",
  "decision",
  "question",
  "handoff",
  "review_note",
  "design_discussion",
] as const;
export type CommentType = (typeof COMMENT_TYPES)[number];

export const DEPENDENCY_TYPES = ["blocks", "relates_to"] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const GIT_REF_TYPES = ["branch", "commit", "pull_request"] as const;
export type GitRefType = (typeof GIT_REF_TYPES)[number];

export const GIT_REF_STATUSES = ["open", "merged", "closed"] as const;
export type GitRefStatus = (typeof GIT_REF_STATUSES)[number];

export const ENTITY_TYPES = ["project", "proposal", "epic", "task", "comment"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ACTIVITY_ACTIONS = [
  "created",
  "updated",
  "status_changed",
  "assigned",
  "commented",
  "dependency_added",
  "dependency_removed",
  "label_added",
  "label_removed",
  "archived",
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];
