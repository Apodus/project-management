import type { ProposalStatus, TaskStatus, UserType } from "./enums.js";

// --- Proposal transitions ---

export interface ProposalTransitionRule {
  from: ProposalStatus;
  to: ProposalStatus;
  allowedBy: readonly UserType[];
}

export const PROPOSAL_TRANSITIONS: readonly ProposalTransitionRule[] = [
  { from: "open", to: "discussing", allowedBy: ["human", "ai_agent"] },
  { from: "discussing", to: "accepted", allowedBy: ["human"] },
  { from: "discussing", to: "rejected", allowedBy: ["human"] },
  { from: "open", to: "rejected", allowedBy: ["human"] },
  { from: "accepted", to: "implemented", allowedBy: ["ai_agent"] },
] as const;

/** O(1) lookup: "open->discussing" => ProposalTransitionRule */
export const PROPOSAL_TRANSITION_MAP = new Map<string, ProposalTransitionRule>(
  PROPOSAL_TRANSITIONS.map((rule) => [`${rule.from}->${rule.to}`, rule]),
);

/**
 * Check whether a proposal status transition is valid.
 * Optionally checks the actor's user type against allowed roles.
 */
export function isValidProposalTransition(
  from: ProposalStatus,
  to: ProposalStatus,
  actorType?: UserType,
): boolean {
  const rule = PROPOSAL_TRANSITION_MAP.get(`${from}->${to}`);
  if (!rule) return false;
  if (actorType && !rule.allowedBy.includes(actorType)) return false;
  return true;
}

// --- Task transitions ---

export interface TaskTransitionRule {
  from: TaskStatus;
  to: TaskStatus;
}

export const TASK_TRANSITIONS: readonly TaskTransitionRule[] = [
  { from: "backlog", to: "ready" },
  { from: "ready", to: "in_progress" },
  { from: "in_progress", to: "in_review" },
  { from: "in_progress", to: "done" },
  { from: "in_review", to: "done" },
  { from: "in_review", to: "in_progress" },
  { from: "backlog", to: "cancelled" },
  { from: "ready", to: "cancelled" },
  { from: "in_progress", to: "cancelled" },
  { from: "ready", to: "backlog" },
] as const;

/** O(1) lookup: "backlog->ready" => TaskTransitionRule */
export const TASK_TRANSITION_MAP = new Map<string, TaskTransitionRule>(
  TASK_TRANSITIONS.map((rule) => [`${rule.from}->${rule.to}`, rule]),
);

/**
 * Check whether a task status transition is valid.
 */
export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITION_MAP.has(`${from}->${to}`);
}

/**
 * Get all valid target statuses from a given task status.
 */
export function getValidTaskTargets(from: TaskStatus): TaskStatus[] {
  return TASK_TRANSITIONS.filter((rule) => rule.from === from).map((rule) => rule.to);
}

/**
 * Get all valid target statuses from a given proposal status.
 */
export function getValidProposalTargets(
  from: ProposalStatus,
  actorType?: UserType,
): ProposalStatus[] {
  return PROPOSAL_TRANSITIONS.filter(
    (rule) => rule.from === from && (!actorType || rule.allowedBy.includes(actorType)),
  ).map((rule) => rule.to);
}
