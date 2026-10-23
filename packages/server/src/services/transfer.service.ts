import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import {
  createId,
  type AuditLogView,
  type TransferBody,
  type TransferEntityType,
  type TransferResult,
} from "@pm/shared";
import {
  activityLog,
  epicDependencies,
  epics,
  getDb,
  labels,
  mergeIncidents,
  mergeLockQueue,
  mergeLocks,
  mergeRequestGroups,
  mergeRequests,
  projects,
  proposals,
  taskLabels,
  tasks,
} from "../db/index.js";
import { AppError } from "../types.js";
import { EVENT_NAMES, getEventBus, type EventName } from "../events/event-bus.js";
import { record as recordAudit, emitAuditRecorded } from "./audit.service.js";
import type { Actor } from "./claim-helpers.js";

/**
 * Engine-independence C4-P4: move a task, an epic (with all of its tasks) or a
 * proposal to another project of the SAME workspace.
 *
 * One implementation for all three kinds, driven by `ENTITY` below. What
 * FOLLOWS the entity is everything keyed by its id rather than by a project --
 * comments, git refs, the claim (holder unchanged) and its lease, task
 * dependencies (cross-project task dependencies are an explicit contract, see
 * dependency.service.ts). What CANNOT follow is project-scoped and is cleared
 * and reported: labels (dropped, listed), an epic's milestone, a task's epic
 * (unless `target_epic_id` names one of the target project).
 *
 * Refused (409, nothing moves) while the work is in flight anywhere a project
 * id is load-bearing: a queued or integrating merge request or a forming /
 * integrating group on any moving task, a merge lock held or queued for one, an
 * open merge incident naming one; a task whose parent or subtasks would stay
 * behind; an epic with ANY epic dependency (epic dependencies never cross
 * projects -- CROSS_PROJECT stays the rule, and only this epic moves). Authz:
 * the claim holder or a human (release-to's rule).
 */

const ENTITY = {
  task: { table: tasks, holderKey: "assigneeId", event: EVENT_NAMES.TASK_UPDATED },
  epic: { table: epics, holderKey: "assigneeId", event: EVENT_NAMES.EPIC_UPDATED },
  proposal: { table: proposals, holderKey: "claimedBy", event: null },
} as const satisfies Record<
  TransferEntityType,
  {
    table: typeof tasks | typeof epics | typeof proposals;
    holderKey: "assigneeId" | "claimedBy";
    event: EventName | null;
  }
>;

const OPEN_REQUEST_STATUSES = ["queued", "integrating"];
const OPEN_GROUP_STATES = ["forming", "integrating"];

function refuse(code: string, message: string): never {
  throw new AppError(409, code, message);
}

export function transfer(
  entityType: TransferEntityType,
  id: string,
  actor: Actor,
  body: TransferBody,
): TransferResult {
  const cfg = ENTITY[entityType];
  const db = getDb();
  const reason = body.reason.trim();
  if (reason === "") throw new AppError(400, "VALIDATION_ERROR", "transfer requires a reason.");

  const row = db.select().from(cfg.table).where(eq(cfg.table.id, id)).get() as
    | (Record<string, unknown> & { projectId: string | null })
    | undefined;
  if (!row) throw new AppError(404, "NOT_FOUND", `${entityType} not found: ${id}`);
  const from = row.projectId;
  if (!from)
    refuse(
      "NO_PROJECT",
      `This ${entityType} belongs to no project; there is nothing to transfer from.`,
    );
  const to = body.target_project_id;
  if (to === from) refuse("SAME_PROJECT", `This ${entityType} is already in project ${to}.`);

  const source = db.select().from(projects).where(eq(projects.id, from)).get();
  const target = db.select().from(projects).where(eq(projects.id, to)).get();
  if (!source) throw new AppError(404, "NOT_FOUND", `Project not found: ${from}`);
  if (!target) throw new AppError(404, "NOT_FOUND", `Target project not found: ${to}`);
  if (target.workspaceId !== source.workspaceId) {
    refuse("CROSS_WORKSPACE", "A transfer stays inside one workspace.");
  }
  if (target.status === "archived") refuse("TARGET_ARCHIVED", `Target project ${to} is archived.`);

  // authz: release-to's rule -- a human always; an agent only for what it holds.
  const holder = (row[cfg.holderKey] as string | null | undefined) ?? null;
  if (actor.type !== "human" && holder !== actor.id) {
    throw new AppError(
      403,
      "FORBIDDEN",
      `Only the claim holder or a human may transfer this ${entityType}${holder ? "" : " (it is unclaimed: claim it first)"}.`,
    );
  }

  let targetEpicId: string | null = null;
  if (body.target_epic_id !== undefined) {
    if (entityType !== "task") {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "target_epic_id applies to a task transfer only.",
      );
    }
    const epic = db.select().from(epics).where(eq(epics.id, body.target_epic_id)).get();
    if (!epic || epic.projectId !== to) {
      refuse(
        "TARGET_EPIC",
        `Epic ${body.target_epic_id} is not an epic of the target project ${to}.`,
      );
    }
    targetEpicId = epic.id;
  }

  // ── Which tasks move. ──
  const moving =
    entityType === "task"
      ? [id]
      : entityType === "epic"
        ? db
            .select({ id: tasks.id })
            .from(tasks)
            .where(eq(tasks.epicId, id))
            .all()
            .map((t) => t.id)
        : [];
  const movingSet = new Set(moving);

  if (moving.length > 0) {
    const movingRows = db.select().from(tasks).where(inArray(tasks.id, moving)).all();
    const strandedParent = movingRows.find((t) => t.parentTaskId && !movingSet.has(t.parentTaskId));
    if (strandedParent) {
      refuse(
        "SUBTASK_SPLIT",
        `Task ${strandedParent.id} is a subtask of ${strandedParent.parentTaskId}, which would stay behind: move them together (one epic) or detach it first.`,
      );
    }
    const children = db
      .select({ id: tasks.id, parent: tasks.parentTaskId })
      .from(tasks)
      .where(inArray(tasks.parentTaskId, moving))
      .all();
    const strandedChild = children.find((c) => !movingSet.has(c.id));
    if (strandedChild) {
      refuse(
        "SUBTASK_SPLIT",
        `Task ${strandedChild.parent} has subtask ${strandedChild.id}, which would stay behind: move them together (one epic) or detach it first.`,
      );
    }

    const openRequests = db
      .select({ id: mergeRequests.id, status: mergeRequests.status })
      .from(mergeRequests)
      .leftJoin(mergeRequestGroups, eq(mergeRequestGroups.id, mergeRequests.groupId))
      .where(
        and(
          inArray(mergeRequests.taskId, moving),
          or(
            inArray(mergeRequests.status, OPEN_REQUEST_STATUSES),
            inArray(mergeRequestGroups.state, OPEN_GROUP_STATES),
          ),
        ),
      )
      .all();
    if (openRequests.length > 0) {
      refuse(
        "OPEN_MERGE_REQUEST",
        `Merge work is in flight for a moving task (${openRequests.map((r) => `${r.id} ${r.status}`).join(", ")}): it is verified and landed in ${from}'s lane. Let it finish or cancel it, then transfer.`,
      );
    }
    const heldLocks = db
      .select({ id: mergeLocks.id })
      .from(mergeLocks)
      .where(and(inArray(mergeLocks.taskId, moving), isNotNull(mergeLocks.holderId)))
      .all();
    const queuedLocks = db
      .select({ id: mergeLockQueue.id })
      .from(mergeLockQueue)
      .where(inArray(mergeLockQueue.taskId, moving))
      .all();
    if (heldLocks.length + queuedLocks.length > 0) {
      refuse("MERGE_LOCK", "A merge lock is held or queued for a moving task: release it first.");
    }
    const incidents = db
      .select({ id: mergeIncidents.id })
      .from(mergeIncidents)
      .where(and(inArray(mergeIncidents.taskId, moving), eq(mergeIncidents.state, "open")))
      .all();
    if (incidents.length > 0) {
      refuse(
        "OPEN_INCIDENT",
        `An open merge incident names a moving task (${incidents.map((i) => i.id).join(", ")}): resolve it first.`,
      );
    }
  }

  if (entityType === "epic") {
    const deps = db
      .select({ epicId: epicDependencies.epicId, dependsOn: epicDependencies.dependsOnEpicId })
      .from(epicDependencies)
      .where(or(eq(epicDependencies.epicId, id), eq(epicDependencies.dependsOnEpicId, id)))
      .all();
    if (deps.length > 0) {
      refuse(
        "CROSS_PROJECT",
        `Epic dependencies never cross projects, and this epic has ${deps.length} (${deps.map((d) => `${d.epicId}->${d.dependsOn}`).join(", ")}): remove them first.`,
      );
    }
  }

  const dropped =
    moving.length === 0
      ? []
      : db
          .select({ taskId: taskLabels.taskId, name: labels.name })
          .from(taskLabels)
          .innerJoin(labels, eq(labels.id, taskLabels.labelId))
          .where(inArray(taskLabels.taskId, moving))
          .all();
  const droppedLabels = dropped.map((d) => `${d.taskId}: ${d.name}`);
  const droppedMilestoneId =
    entityType === "epic" ? ((row.milestoneId as string | null) ?? null) : null;

  const now = new Date().toISOString();
  const before: Record<string, unknown> = { project_id: from };
  const after: Record<string, unknown> = { project_id: to, dropped_labels: droppedLabels };
  if (entityType === "task") {
    before.epic_id = row.epicId ?? null;
    after.epic_id = targetEpicId;
  }
  if (entityType === "epic") {
    before.milestone_id = droppedMilestoneId;
    after.milestone_id = null;
    after.moved_task_ids = moving;
  }

  let auditId = "";
  db.transaction((tx) => {
    const set: Record<string, unknown> = { projectId: to, updatedAt: now };
    if (entityType === "task") set.epicId = targetEpicId;
    if (entityType === "epic") set.milestoneId = null;
    tx.update(cfg.table).set(set).where(eq(cfg.table.id, id)).run();
    if (entityType === "epic" && moving.length > 0) {
      tx.update(tasks)
        .set({ projectId: to, updatedAt: now })
        .where(inArray(tasks.id, moving))
        .run();
    }
    if (moving.length > 0) tx.delete(taskLabels).where(inArray(taskLabels.taskId, moving)).run();

    const changes = {
      project_id: { from, to },
      ...(droppedLabels.length > 0 ? { labels: { from: droppedLabels, to: [] } } : {}),
    };
    for (const projectId of [from, to]) {
      tx.insert(activityLog)
        .values({
          id: createId(),
          entityType,
          entityId: id,
          projectId,
          actorId: actor.id,
          action: "transferred",
          changes,
          createdAt: now,
        })
        .run();
    }
    auditId = recordAudit(tx, {
      projectId: from,
      actorId: actor.id,
      action: "transfer",
      targetType: entityType,
      targetId: id,
      reason,
      before,
      after,
      now,
    });
  });

  const view: AuditLogView = {
    id: auditId,
    projectId: from,
    actorId: actor.id,
    action: "transfer",
    targetType: entityType,
    targetId: id,
    reason,
    metadataBefore: before,
    metadataAfter: after,
    createdAt: now,
  };
  emitAuditRecorded(auditId, from, actor.id, view);
  if (cfg.event) {
    const fresh = db.select().from(cfg.table).where(eq(cfg.table.id, id)).get();
    getEventBus().emit(cfg.event, {
      entity: fresh,
      entityType,
      entityId: id,
      projectId: to,
      actorId: actor.id,
      timestamp: now,
    });
  }

  return {
    entity_type: entityType,
    entity_id: id,
    from_project_id: from,
    to_project_id: to,
    moved_task_ids: moving,
    dropped_labels: droppedLabels,
    dropped_milestone_id: droppedMilestoneId,
    audit_id: auditId,
  };
}
