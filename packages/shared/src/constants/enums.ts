// All enums as `as const` arrays with derived union types.
// This is the single source of truth for allowed values.

export const PROJECT_STATUSES = ["active", "paused", "archived", "completed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROPOSAL_STATUSES = [
  "open",
  "discussing",
  "accepted",
  "in_progress",
  "completed",
  "rejected",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const CLAIM_STATUSES = ["unclaimed", "claimed_by_you", "claimed_by_other"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

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
  "merge_rejection",
  "merge_incident",
] as const;
export type CommentType = (typeof COMMENT_TYPES)[number];

export const DEPENDENCY_TYPES = ["blocks", "relates_to"] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

// Phase 7.5 — verify cache mode (design §2/§4.3). Per-project cache_mode
// governs how the verify cache is used when cache_enabled is true:
//   off    — never look up, never write (inert; same as cache_enabled:false)
//   on     — hit skips the run and reuses the verdict; miss runs + records
//   shadow — always run, compare the real verdict to the cached one (emit
//            verify.cache_mismatch on a discrepancy), ALWAYS use the real verdict
export const CACHE_MODES = ["off", "on", "shadow"] as const;
export type CacheMode = (typeof CACHE_MODES)[number];

// Phase 7.5 — the binary verify verdict stored in verify_cache (design §2/§3.1).
// Named VerifyResultValue (NOT VerifyResult) to avoid colliding with the
// integrator-ref VerifyResult INTERFACE (git-ops.ts).
export const VERIFY_RESULTS = ["pass", "fail"] as const;
export type VerifyResultValue = (typeof VERIFY_RESULTS)[number];

export const GIT_REF_TYPES = ["branch", "commit", "pull_request", "landed_sha"] as const;
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
