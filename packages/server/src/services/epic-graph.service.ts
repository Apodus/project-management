import { eq, and, ne, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { createId, DEPENDENCY_TYPES, type DependencyType } from "@pm/shared";
import {
  getDb,
  tasks,
  taskDependencies,
  epicDependencies,
} from "../db/index.js";
import { AppError } from "../types.js";
import * as epicService from "./epic.service.js";

const VALID_DEPENDENCY_TYPES = new Set<string>(DEPENDENCY_TYPES);

// ─── Types ────────────────────────────────────────────────────────

interface GraphEdge {
  from: string;
  to: string;
  dependency_type: DependencyType;
  provenance: "derived" | "explicit";
}

export interface CreateEpicDependencyInput {
  projectId: string;
  epicId: string;
  dependsOnEpicId: string;
  dependencyType?: string;
  createdBy?: string | null;
}

/**
 * Build the epic-graph payload for a project.
 *
 * Nodes are the project's epics with their existing `taskSummary` (the single
 * completion source — never recomputed here). Edges are the UNION of:
 *   - DERIVED blocks edges: epic A blocks epic B iff ∃ a task in B that
 *     `blocks`-depends on a task in A, rolled up to epic granularity + deduped.
 *   - EXPLICIT planning-time edges from `epic_dependencies`.
 * When a derived and explicit edge share the same ordered (from, to, type),
 * explicit wins (the pair collapses to a single `explicit` edge).
 *
 * Cycle detection (Kahn's) runs over the `blocks` sub-graph; concrete cycles
 * are surfaced via the optional `cycles` flag. Edges are never dropped —
 * detection only reads the edge set.
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

  const db = getDb();

  // ── Derived edges — roll cross-epic task `blocks` deps up to epic level ──
  // from = prerequisite = the epic of depends_on_task_id (pre_task)
  // to   = dependent    = the epic of task_id            (dep_task)
  const depTask = alias(tasks, "dep_task"); // dependent task (task_id)
  const preTask = alias(tasks, "pre_task"); // prerequisite task (depends_on_task_id)
  const derivedRows = db
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

  // ── Explicit edges — authored planning-time rows ──
  // from = prerequisite = depends_on_epic_id
  // to   = dependent     = epic_id
  const explicitRows = db
    .select({
      from: epicDependencies.dependsOnEpicId,
      to: epicDependencies.epicId,
      dependency_type: epicDependencies.dependencyType,
    })
    .from(epicDependencies)
    .where(eq(epicDependencies.projectId, projectId))
    .all();

  // ── Union with explicit-wins collapse ──
  // Key includes dependency_type so e.g. blocks + relates_to on the same pair
  // remain two distinct edges. Derived first, explicit overwrites.
  const edgeMap = new Map<string, GraphEdge>();
  for (const r of derivedRows) {
    const edge: GraphEdge = {
      from: r.from!,
      to: r.to!,
      dependency_type: "blocks",
      provenance: "derived",
    };
    edgeMap.set(`${edge.from}|${edge.to}|${edge.dependency_type}`, edge);
  }
  for (const r of explicitRows) {
    const edge: GraphEdge = {
      from: r.from,
      to: r.to,
      // The DB column is free `text`, but only validated types are ever
      // inserted (route z.enum + createDependency VALID_DEPENDENCY_TYPES).
      dependency_type: r.dependency_type as DependencyType,
      provenance: "explicit",
    };
    edgeMap.set(`${edge.from}|${edge.to}|${edge.dependency_type}`, edge);
  }
  const edges = [...edgeMap.values()];

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
 * the processed-count comparison is exact.
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
  // project, but be defensive) are registered so the graph is self-consistent.
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

// ─── Explicit dependency CRUD ─────────────────────────────────────

/**
 * Create an explicit epic→epic dependency. NO self/dup pre-check — the DB
 * unique index + self check are authoritative; their constraint codes are
 * caught and mapped to clean AppErrors (automatic > manual).
 */
export function createDependency(input: CreateEpicDependencyInput) {
  const db = getDb();
  const type = input.dependencyType ?? "blocks";

  if (!VALID_DEPENDENCY_TYPES.has(type)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Invalid dependency type: "${type}". Valid types: ${DEPENDENCY_TYPES.join(", ")}`,
    );
  }

  // Existence (getById throws 404 on miss) + cross-project assertion.
  const epic = epicService.getById(input.epicId);
  const dependsOnEpic = epicService.getById(input.dependsOnEpicId);
  if (
    epic.projectId !== input.projectId ||
    dependsOnEpic.projectId !== input.projectId
  ) {
    throw new AppError(
      400,
      "CROSS_PROJECT",
      `Both epics must belong to project ${input.projectId}`,
    );
  }

  const id = createId();
  const now = new Date().toISOString();

  try {
    db.insert(epicDependencies)
      .values({
        id,
        projectId: input.projectId,
        epicId: input.epicId,
        dependsOnEpicId: input.dependsOnEpicId,
        dependencyType: type,
        createdAt: now,
        createdBy: input.createdBy ?? null,
      })
      .run();
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new AppError(409, "CONFLICT", "This epic dependency already exists");
    }
    if (code === "SQLITE_CONSTRAINT_CHECK") {
      throw new AppError(
        400,
        "SELF_DEPENDENCY",
        "An epic cannot depend on itself",
      );
    }
    throw err;
  }

  return db
    .select()
    .from(epicDependencies)
    .where(eq(epicDependencies.id, id))
    .get()!;
}

/**
 * Delete an explicit epic dependency by id. Throws 404 if not found.
 * No claim gate, no event emit — mirrors task-dependency removal.
 */
export function deleteDependency(depId: string) {
  const db = getDb();

  const existing = db
    .select()
    .from(epicDependencies)
    .where(eq(epicDependencies.id, depId))
    .get();

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `Epic dependency not found: ${depId}`);
  }

  db.delete(epicDependencies).where(eq(epicDependencies.id, depId)).run();

  return existing;
}
