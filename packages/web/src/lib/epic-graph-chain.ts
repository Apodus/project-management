import type { EpicGraphEdge } from "./api";

/**
 * Pure dependency-chain computation for the epic timeline-DAG view.
 *
 * Given a focused epic, `computeChain` returns the set of node ids and edge
 * keys that lie on a path THROUGH that focus node — its full ancestor +
 * descendant chain. The page brightens these and dims everything else on hover.
 *
 * Two decisions are pinned here:
 *
 * (a) The chain follows ALL rendered edges, including `relates_to` (not just
 *     `blocks`). Every edge ReactFlow draws participates in the highlight; a
 *     `relates_to` link between two epics is a real, rendered relationship and
 *     belongs to the chain.
 *
 * (b) A CROSS-EDGE is INTENTIONALLY not highlighted. An edge directly between
 *     an ancestor and a descendant that does NOT pass through focus is not on a
 *     path through focus: both endpoints brighten (they reach focus by other
 *     routes) but the shortcut edge itself stays dim. This is by design, not a
 *     bug — the highlight answers "what flows through THIS node," and the
 *     shortcut bypasses it.
 *
 * Determinism: no clock, no randomness. Edge order in the input does not affect
 * the resulting sets (Sets carry no ordering contract the callers depend on).
 */

export interface ChainResult {
  nodeIds: Set<string>;
  edgeKeys: Set<string>;
}

/**
 * The stable key for an edge — byte-identical to the rfEdge `id` scheme the
 * page builds, so chain membership can be matched against rendered edges.
 */
export function edgeKey(e: { from: string; to: string; dependency_type: string }): string {
  return `${e.from}->${e.to}-${e.dependency_type}`;
}

export function computeChain(focusId: string, edges: EpicGraphEdge[]): ChainResult {
  // Adjacency over ALL edges (both dependency_types).
  const outgoing = new Map<string, EpicGraphEdge[]>();
  const incoming = new Map<string, EpicGraphEdge[]>();
  for (const e of edges) {
    let outs = outgoing.get(e.from);
    if (!outs) {
      outs = [];
      outgoing.set(e.from, outs);
    }
    outs.push(e);

    let ins = incoming.get(e.to);
    if (!ins) {
      ins = [];
      incoming.set(e.to, ins);
    }
    ins.push(e);
  }

  const nodeIds = new Set<string>([focusId]);
  const edgeKeys = new Set<string>();

  // Descend: BFS forward from focus via outgoing edges.
  const downQueue: string[] = [focusId];
  while (downQueue.length > 0) {
    const current = downQueue.shift()!;
    const outs = outgoing.get(current);
    if (!outs) continue;
    for (const e of outs) {
      edgeKeys.add(edgeKey(e));
      if (!nodeIds.has(e.to)) {
        nodeIds.add(e.to);
        downQueue.push(e.to);
      }
    }
  }

  // Ascend: BFS backward from focus via incoming edges. The shared `nodeIds`
  // visited-set is correct: descend/ascend explore disjoint directions except
  // through cycles, where the guard ensures termination.
  const upQueue: string[] = [focusId];
  while (upQueue.length > 0) {
    const current = upQueue.shift()!;
    const ins = incoming.get(current);
    if (!ins) continue;
    for (const e of ins) {
      edgeKeys.add(edgeKey(e));
      if (!nodeIds.has(e.from)) {
        nodeIds.add(e.from);
        upQueue.push(e.from);
      }
    }
  }

  return { nodeIds, edgeKeys };
}
