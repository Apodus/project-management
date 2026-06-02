import { eq, and } from "drizzle-orm";
import { type DependencyType } from "@pm/shared";
import { getDb, tasks, taskDependencies } from "../db/index.js";
import { AppError } from "../types.js";
import * as epicService from "./epic.service.js";

// ─── Types ────────────────────────────────────────────────────────

interface GraphEdge {
  from: string;
  to: string;
  dependency_type: DependencyType;
  provenance: "explicit";
}

/**
 * Build the task-graph payload for a single epic.
 *
 * Nodes are the epic's tasks (ALL of them — cancelled tasks render as ordinary
 * nodes; no special-casing). Edges are the epic's INTERNAL task dependencies:
 * a task_dependencies row is kept only when BOTH endpoints (`task_id` and
 * `depends_on_task_id`) belong to the epic — cross-epic deps are excluded (the
 * floating mini-DAG is intra-epic). Edge direction mirrors the task model:
 *   from = prerequisite = depends_on_task_id
 *   to   = dependent     = task_id
 *
 * Cycle detection (Kahn's) runs over the `blocks` sub-graph; concrete cycles
 * are surfaced via the optional `cycles` flag. Edges are never dropped —
 * detection only reads the edge set.
 */
export function getTaskGraph(
  projectId: string,
  epicId: string,
  caller?: { id: string } | null,
) {
  // ── Guard — epic must exist and belong to the project ──
  const epic = epicService.getById(epicId, caller);
  if (epic.projectId !== projectId) {
    throw new AppError(404, "NOT_FOUND", `Epic not found: ${epicId}`);
  }

  const db = getDb();

  // ── Nodes — the epic's tasks (all statuses) ──
  const taskRows = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.epicId, epicId), eq(tasks.projectId, projectId)))
    .all();

  const nodes = taskRows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    type: t.type,
    assignee_id: t.assigneeId,
    done: t.status === "done",
  }));

  const taskIds = new Set(taskRows.map((t) => t.id));

  // ── Edges — intra-epic task deps only (both endpoints in the epic) ──
  const depRows = db.select().from(taskDependencies).all();
  const edges: GraphEdge[] = [];
  for (const r of depRows) {
    if (!taskIds.has(r.taskId) || !taskIds.has(r.dependsOnTaskId)) continue;
    edges.push({
      from: r.dependsOnTaskId,
      to: r.taskId,
      // The DB column is free `text`, but only validated types are ever
      // inserted (route z.enum + createDependency validation).
      dependency_type: r.dependencyType as DependencyType,
      provenance: "explicit" as const,
    });
  }

  // ── Cycle detection over the `blocks` sub-graph ──
  const nodeIds = nodes.map((n) => n.id);
  const cycleResult = detectCycles(
    nodeIds,
    edges.filter((e) => e.dependency_type === "blocks"),
  );

  return {
    nodes,
    edges,
    hasCycle: cycleResult.hasCycle,
    ...(cycleResult.cycles.length ? { cycles: cycleResult.cycles } : {}),
  };
}

/**
 * Kahn's algorithm for cycle existence over a directed graph, plus DFS
 * extraction of concrete cycles from the residual (non-source) sub-graph.
 *
 * Edges are interpreted from→to. Isolated nodes participate (indegree 0) so
 * the processed-count comparison is exact. (Copied from epic-graph.service —
 * self-contained, deliberately not retrofitted into a shared export.)
 */
function detectCycles(
  nodeIds: string[],
  blocksEdges: { from: string; to: string }[],
): { hasCycle: boolean; cycles: string[][] } {
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
    indegree.set(id, 0);
  }
  // Edge endpoints not present in nodeIds (shouldn't happen for a coherent
  // epic, but be defensive) are registered so the graph is self-consistent.
  const ensure = (id: string) => {
    if (!adjacency.has(id)) adjacency.set(id, []);
    if (!indegree.has(id)) indegree.set(id, 0);
  };
  for (const e of blocksEdges) {
    ensure(e.from);
    ensure(e.to);
    adjacency.get(e.from)!.push(e.to);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }

  const nodeCount = adjacency.size;

  // ── Kahn's: peel off sources; survivors with indegree > 0 are in/feed cycles ──
  const residualIndegree = new Map(indegree);
  const queue: string[] = [];
  for (const [id, deg] of residualIndegree) {
    if (deg === 0) queue.push(id);
  }
  let processed = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    processed++;
    for (const next of adjacency.get(node) ?? []) {
      const deg = (residualIndegree.get(next) ?? 0) - 1;
      residualIndegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (processed === nodeCount) {
    return { hasCycle: false, cycles: [] };
  }

  // ── Extract concrete cycles via DFS over residual nodes (those that did not
  //    get peeled — i.e. still have indegree > 0 in the residual graph) ──
  const residual = new Set<string>();
  for (const [id, deg] of residualIndegree) {
    if (deg > 0) residual.add(id);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of residual) color.set(id, WHITE);

  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();
  const stack: string[] = [];

  const dfs = (node: string) => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!residual.has(next)) continue;
      const c = color.get(next);
      if (c === GRAY) {
        // Found a back-edge → cycle is stack[idx..] where idx = first occurrence of next.
        const idx = stack.indexOf(next);
        if (idx !== -1) {
          const cycle = stack.slice(idx);
          const key = canonicalCycleKey(cycle);
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key);
            cycles.push(cycle);
          }
        }
      } else if (c === WHITE) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const id of residual) {
    if (color.get(id) === WHITE) dfs(id);
  }

  return { hasCycle: true, cycles };
}

/**
 * A rotation-invariant key for a cycle so the same cycle discovered from a
 * different start node is de-duplicated. Rotates the node list to start at its
 * lexicographically smallest member.
 */
function canonicalCycleKey(cycle: string[]): string {
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
  return rotated.join("→");
}
