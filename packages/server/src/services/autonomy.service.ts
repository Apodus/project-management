import { eq } from "drizzle-orm";
import { getDb, projects } from "../db/index.js";
import { AppError } from "../types.js";
import type { AuthUser } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────

export interface AiAutonomySettings {
  can_self_assign: boolean;
  can_create_subtasks: boolean;
  can_create_tasks: boolean;
  can_change_priority: boolean;
  can_close_epics: boolean;
  max_concurrent_tasks: number;
}

const DEFAULT_AUTONOMY: AiAutonomySettings = {
  can_self_assign: true,
  can_create_subtasks: true,
  can_create_tasks: false,
  can_change_priority: false,
  can_close_epics: false,
  max_concurrent_tasks: 3,
};

type GuardrailAction =
  | "self_assign"
  | "create_subtask"
  | "create_task"
  | "change_priority"
  | "close_epic";

const ACTION_TO_SETTING: Record<GuardrailAction, keyof AiAutonomySettings> = {
  self_assign: "can_self_assign",
  create_subtask: "can_create_subtasks",
  create_task: "can_create_tasks",
  change_priority: "can_change_priority",
  close_epic: "can_close_epics",
};

const ACTION_LABELS: Record<GuardrailAction, string> = {
  self_assign: "self-assign tasks",
  create_subtask: "create subtasks",
  create_task: "create tasks",
  change_priority: "change task priority",
  close_epic: "close epics",
};

// ─── Service functions ────────────────────────────────────────────

/**
 * Get the AI autonomy settings for a project.
 * Falls back to defaults for any missing settings.
 */
export function getAutonomySettings(projectId: string): AiAutonomySettings {
  const db = getDb();
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project) {
    return { ...DEFAULT_AUTONOMY };
  }

  const settings = project.settings as Record<string, unknown> | null;
  if (!settings || typeof settings !== "object") {
    return { ...DEFAULT_AUTONOMY };
  }

  const aiAutonomy = settings.ai_autonomy as Partial<AiAutonomySettings> | undefined;
  if (!aiAutonomy || typeof aiAutonomy !== "object") {
    return { ...DEFAULT_AUTONOMY };
  }

  return {
    can_self_assign: typeof aiAutonomy.can_self_assign === "boolean" ? aiAutonomy.can_self_assign : DEFAULT_AUTONOMY.can_self_assign,
    can_create_subtasks: typeof aiAutonomy.can_create_subtasks === "boolean" ? aiAutonomy.can_create_subtasks : DEFAULT_AUTONOMY.can_create_subtasks,
    can_create_tasks: typeof aiAutonomy.can_create_tasks === "boolean" ? aiAutonomy.can_create_tasks : DEFAULT_AUTONOMY.can_create_tasks,
    can_change_priority: typeof aiAutonomy.can_change_priority === "boolean" ? aiAutonomy.can_change_priority : DEFAULT_AUTONOMY.can_change_priority,
    can_close_epics: typeof aiAutonomy.can_close_epics === "boolean" ? aiAutonomy.can_close_epics : DEFAULT_AUTONOMY.can_close_epics,
    max_concurrent_tasks: typeof aiAutonomy.max_concurrent_tasks === "number" ? aiAutonomy.max_concurrent_tasks : DEFAULT_AUTONOMY.max_concurrent_tasks,
  };
}

/**
 * Check an autonomy guardrail for an AI agent.
 * Humans are never constrained by guardrails.
 *
 * Throws AppError(403) if the guardrail blocks the action.
 */
export function checkGuardrail(
  actor: AuthUser,
  action: GuardrailAction,
  projectId: string,
): void {
  // Humans are not constrained by AI autonomy guardrails
  if (actor.type !== "ai_agent") {
    return;
  }

  const autonomy = getAutonomySettings(projectId);
  const settingKey = ACTION_TO_SETTING[action];
  const allowed = autonomy[settingKey];

  if (!allowed) {
    throw new AppError(
      403,
      "GUARDRAIL_BLOCKED",
      `AI agent is not allowed to ${ACTION_LABELS[action]} in this project`,
    );
  }
}

/**
 * Get the max concurrent tasks for an actor in a project.
 */
export function getMaxConcurrentTasks(projectId: string): number {
  const autonomy = getAutonomySettings(projectId);
  return autonomy.max_concurrent_tasks;
}
