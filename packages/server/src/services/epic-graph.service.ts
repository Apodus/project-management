import { eq, and, ne, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb, tasks, taskDependencies } from "../db/index.js";
import * as epicService from "./epic.service.js";

/**
 * Build the derived epic-graph payload for a project.
 *
 * Nodes are the project's epics with their existing `taskSummary` (the single
 * completion source — never recomputed here). Edges are cross-epic task `blocks`
 * dependencies rolled up to epic granularity and deduped: epic A blocks epic B
 * iff ∃ a task in B that `blocks`-depends on a task in A.
 *
 * Provenance is always `derived` in P2; explicit edges + cycle detection arrive
 * in P3 (hence `hasCycle` is statically false here).
 */
export function getGraph(projectId: string, caller?: { id: string } | null) {
  // ── Nodes — reuse the single completion source (epic.service.list) ──
  const epicRows = epicService.list(projectId, undefined, caller);
  const nodes = epicRows.map((e) => ({
    id: e.id,
    project_id: e.projectId,
    name: e.name,
    status: e.status,
    priority: e.priority,
    target_date: e.targetDate,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    taskSummary: e.taskSummary,
  }));

  // ── Edges — roll cross-epic task `blocks` deps up to epic granularity ──
  // from = prerequisite = the epic of depends_on_task_id (pre_task)
  // to   = dependent    = the epic of task_id            (dep_task)
  const db = getDb();
  const depTask = alias(tasks, "dep_task"); // dependent task (task_id)
  const preTask = alias(tasks, "pre_task"); // prerequisite task (depends_on_task_id)
  const edgeRows = db
    .selectDistinct({ from: preTask.epicId, to: depTask.epicId })
    .from(taskDependencies)
    .innerJoin(depTask, eq(taskDependencies.taskId, depTask.id))
    .innerJoin(preTask, eq(taskDependencies.dependsOnTaskId, preTask.id))
    .where(
      and(
        eq(taskDependencies.dependencyType, "blocks"),
        eq(depTask.projectId, projectId),
        eq(preTask.projectId, projectId),
        isNotNull(depTask.epicId),
        isNotNull(preTask.epicId),
        ne(preTask.epicId, depTask.epicId),
      ),
    )
    .all();
  const edges = edgeRows.map((r) => ({
    from: r.from!,
    to: r.to!,
    dependency_type: "blocks" as const,
    provenance: "derived" as const,
  }));

  return { nodes, edges, hasCycle: false };
}
