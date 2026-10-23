import { z } from "zod";

// ─── Transfer between projects (engine-independence C4-P4) ────────
// Move a task, an epic (with all of its tasks) or a proposal to another project
// of the SAME workspace, keeping its id, comments, git refs, claim and task
// dependencies. Labels are project-scoped: they are dropped and listed in the
// result and the audit row. A task may name an epic of the target project.

export const TRANSFER_ENTITY_TYPES = ["task", "epic", "proposal"] as const;
export type TransferEntityType = (typeof TRANSFER_ENTITY_TYPES)[number];

export const transferBodySchema = z.object({
  target_project_id: z.string().min(1),
  /** Task transfers only: an epic of the TARGET project to file the task under. */
  target_epic_id: z.string().min(1).optional(),
  reason: z.string().trim().min(1).max(2048),
});
export type TransferBody = z.infer<typeof transferBodySchema>;

export const transferResultSchema = z.object({
  entity_type: z.enum(TRANSFER_ENTITY_TYPES),
  entity_id: z.string(),
  from_project_id: z.string(),
  to_project_id: z.string(),
  /** Every task that moved (an epic moves all of its tasks atomically). */
  moved_task_ids: z.array(z.string()),
  /** Project-scoped labels that could not follow, as "<task id>: <label name>". */
  dropped_labels: z.array(z.string()),
  /** An epic's milestone belongs to its old project and is cleared. */
  dropped_milestone_id: z.string().nullable(),
  audit_id: z.string(),
});
export type TransferResult = z.infer<typeof transferResultSchema>;
