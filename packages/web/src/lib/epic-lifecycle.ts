import type { EpicGraphEdge, EpicGraphNode } from "./api";

/**
 * Pure, deterministic lifecycle derivation for the epic roadmap DAG (C2).
 *
 * Two helpers, both total and clock-free:
 *
 * (a) `lifecycle` collapses the server `health` enum (+ the free-form `status`
 *     string) into a three-way phase — `done` | `active` | `future` — with a
 *     fixed precedence `done > future > active`:
 *       - `done`:   `health === "done"` OR `status === "completed"`. Either
 *                   signal alone is enough; `done` beats every other phase.
 *       - `future`: `health === "not_started"` (and not already done).
 *       - `active`: everything else (`on_track` | `at_risk` | `blocked`).
 *     Total over `(health, status)`: every input maps to exactly one literal.
 *
 * (b) `actionableNow` is the work startable *right now*: an `active` epic whose
 *     every `blocks`-prerequisite is lifecycle-`done`. No prereqs → vacuously
 *     actionable. One-hop only (no transitive walk): a cycle needs no special
 *     handling here — but note a cycle member CAN be actionable if its direct
 *     prereqs happen to be done (cycle detection is structural / health-
 *     independent, e.g. a done↔active 2-cycle makes the active member actionable
 *     because its prereq is done). The canvas suppresses the ready marker on
 *     in-cycle nodes (the cycle is the more urgent signal).
 *
 * EQUIVALENCE (no forked completion calc). On server-consistent data,
 * `actionableNow(n) ⟺ active(n) ∧ server health !== "blocked"`: the server sets
 * `blocked` exactly when an incomplete prerequisite gates an epic, so the edge
 * predicate here re-derives the same fact from the graph rather than trusting
 * (or duplicating) the server's `blocked` computation. It is implemented as the
 * edge predicate — not as `health !== "blocked"` — so the equivalence is
 * self-testable (A6) and we never fork a second completion calculation.
 *
 * Determinism is a correctness requirement: NO `Date.now()`, no `Math.random()`,
 * no `new Date`, no clock. The result is a `Set<string>` whose membership is
 * order-independent, so input array order never changes the answer.
 */

export type Lifecycle = "done" | "active" | "future";

/**
 * Collapse a node's `(health, status)` into its lifecycle phase.
 *
 * Total function. Precedence `done > future > active`.
 */
export function lifecycle(node: Pick<EpicGraphNode, "health" | "status">): Lifecycle {
  if (node.health === "done" || node.status === "completed") return "done";
  if (node.health === "not_started") return "future";
  return "active"; // on_track | at_risk | blocked
}

/**
 * The set of epic ids that are `active` AND have every `blocks`-prerequisite
 * lifecycle-`done` — the work startable right now.
 *
 * Edge handling mirrors `computeRanks`: only `blocks` edges gate (`relates_to`
 * never gates), and an edge is skipped (defensive) when either endpoint is
 * absent from the node set or it is a self-loop. Skipping an absent prerequisite
 * is safe ONLY because callers pass the full graph:
 *
 *   CALL-SITE CONTRACT (C2.P3): `actionableNow` assumes it receives the FULL
 *   graph node+edge set. Callers must NOT pass a category-filtered subset — a
 *   hidden (filtered-out) prerequisite would be skipped here and would falsely
 *   mark its dependent actionable.
 *
 * @returns a `Set<string>` of actionable ids (membership order-independent).
 */
export function actionableNow(
  nodes: ReadonlyArray<Pick<EpicGraphNode, "id" | "health" | "status">>,
  edges: ReadonlyArray<Pick<EpicGraphEdge, "from" | "to" | "dependency_type">>,
): Set<string> {
  // 1. lifecycle per node + the id universe.
  const lifecycleById = new Map<string, Lifecycle>();
  const nodeSet = new Set<string>();
  for (const node of nodes) {
    lifecycleById.set(node.id, lifecycle(node));
    nodeSet.add(node.id);
  }

  // 2. blocks-only prerequisite lists, keyed by dependent. Skip relates_to,
  // absent endpoints, and self-loops (mirroring computeRanks' edge filter).
  const prereqsByDependent = new Map<string, string[]>();
  for (const e of edges) {
    if (e.dependency_type !== "blocks") continue;
    if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    if (e.from === e.to) continue;
    const list = prereqsByDependent.get(e.to);
    if (list) list.push(e.from);
    else prereqsByDependent.set(e.to, [e.from]);
  }

  // 3. active epics whose every prereq is done.
  const result = new Set<string>();
  for (const node of nodes) {
    if (lifecycleById.get(node.id) !== "active") continue;
    const prereqs = prereqsByDependent.get(node.id) ?? [];
    if (prereqs.every((p) => lifecycleById.get(p) === "done")) result.add(node.id);
  }
  return result;
}
