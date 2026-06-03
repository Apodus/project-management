# Campaign C1 — Readable Layered Coordinates + edge routing + relates_to distinction

**Parent vision:** `roadmaps/vision-20260603-epic-roadmap-layout-readability.md`
**Tier:** A. **Scope:** Medium, ~400–600 LOC, **no new dependency, no deleted module.** 4 phases.
**Branch:** `epic-roadmap-layout-readability`. **Commit:** one logical commit per phase.

## Goal

Make structure-mode dependency edges clearly READABLE: a dependent aligns to (the median-y of)
its prerequisites, empty slots allowed, the 5 long-span edges route cleanly, and the 4
`relates_to` edges stop masquerading as sequencing `blocks`. The done↔active↔future left→right
sense is a SOFT goal that yields to readability.

## Measured baseline (live rynx graph, from ./data/pm.db)

- 49 epics, 32 edges = **28 blocks + 4 relates_to**. 0 cycles.
- Ranks: **4 layers {0:27, 1:9, 2:11, 3:2}**; 27 nodes on rank 0 (20 fully isolated).
- **5 long-span (rank-dist>1) blocks edges** (4× dist-2, 1× dist-3).
- Current `(o-(k-1)/2)*ROW_HEIGHT` coordinate pass → **436px mean edge vertical displacement**.
- Target (neighbor-median pass) → **~149px mean, ~104px median (one row)**.

## Key files (current state)

- `packages/web/src/lib/epic-graph-layout.ts` — `computeStructureLayout` (~:286-327). The coordinate
  formula to REPLACE is `:301-310` (`y = (o-(k-1)/2)*STRUCTURE_ROW_HEIGHT`). Consumes `computeRanks`
  (rank.ts) + `computeOrder` (order.ts). Constants STRUCTURE_X_GAP=320, STRUCTURE_ROW_HEIGHT=104,
  STRUCTURE_X_PAD=80. Builds `backwardsEdges` from `rank.excludedBackEdges`.
- `packages/web/src/lib/epic-graph-rank.ts` — `computeRanks(nodes,edges) → {ranks, maxRank, excludedBackEdges, forwardEdges}`. **KEEP unchanged.**
- `packages/web/src/lib/epic-graph-order.ts` — `computeOrder(rank) → {layers, positions{rank,order}, crossings}`. **KEEP unchanged** (ordering is fine; only coords are broken).
- `packages/web/src/lib/epic-graph-layout.test.ts` — structure-mode coordinate tests (migrate to readability invariants); timeline-mode tests (KEEP byte-identical).
- `packages/web/src/components/epic-roadmap-canvas.tsx` — consumes positions/backwardsEdges/edges; builds rfEdges; lifecycle/ready-ring read positions.
- `packages/web/src/lib/epic-graph-style.ts` — `getEdgeStyling` branches on provenance/backwards/highlight ONLY, never `dependency_type` (the relates_to gap).
- `packages/web/src/components/epic-node.tsx` — node is `w-[200px]`, ~56-64px tall.

## Commands

Test (web): `pnpm --filter @pm/web test` · Test all: `pnpm test` · Typecheck: `pnpm typecheck` ·
Lint: `pnpm lint` · Build: `pnpm build` · E2E (host-flaky, don't gate): `pnpm test:e2e`

## Engineering values

No investment ceiling. Less code in the right sense. Automatic > manual. Pure + deterministic
layout: NO Date.now/Math.random; identical output across shuffled input (reuse the EXISTING
determinism harness — engine stays ours). NO new dependency. Server contract untouched.
**dagre/ELK was verifier-killed — do NOT reach for it.**

---

## Phases

### P1 — Neighbor-aligned coordinate pass (the 90% win)

Replace the coordinate formula at `epic-graph-layout.ts:301-310`. Algorithm (priority/median method):
sweep ranks down (0→max) then up (max→0), a few iterations; each node's desired y = **median of its
already-placed adjacent-layer neighbors** (prerequisites on the down-sweep via `forwardEdges`,
dependents on the up-sweep); within each layer, walk nodes in their `order` (from order.ts) and assign
desired-y, **pushing later nodes down only as needed to keep min-gap (STRUCTURE_ROW_HEIGHT)** — preserve
order, leave gaps where sparse. No-neighbor nodes (rank-0 sources, 20 isolated) pack from an id-sorted
baseline; don't let them perturb the aligned chains. Pure + deterministic (median + order + id tie-breaks).

- **Verify:** migrate structure tests to readability invariants — single-prereq dependent's y within
  ~1 row (STRUCTURE_ROW_HEIGHT, allow a small tolerance) of its prereq; no node overlap (distinct (x,y);
  same-rank |Δy|≥ROW_HEIGHT); determinism across shuffled input (reuse existing pattern); finite on
  degenerate inputs (empty/single/all-relates_to/full-cycle); prerequisite strictly left (x) preserved.
  `pnpm --filter @pm/web test` + `pnpm typecheck`. Timeline tests byte-identical.
- **Commit:** "C1.P1: neighbor-aligned coordinate pass (dependents align to prereqs, empty slots)".

### P2 — Routed long-span edges

A custom ReactFlow edge type for rank-distance>1 `blocks` edges, routing through the inter-rank gap
lanes derived from node positions (NO virtual nodes, NO dagre). The layout (or the canvas) computes,
per long edge, a routed polyline that clears intermediate-rank node bands. 5 edges; keep it simple.

- **Verify:** unit/component — a long-span edge's routed path clears intermediate node boxes on a
  fixture; short edges unaffected; existing edge tests green. `pnpm --filter @pm/web test` + typecheck.
- **Commit:** "C1.P2: route long-span dependency edges through inter-rank gaps".

### P3 — relates_to distinction

Branch `epic-graph-style.ts` `getEdgeStyling` on `dependency_type`: render `relates_to` clearly softer
than `blocks` (dotted + lower contrast + no/different arrowhead) so soft relations don't read as
sequencing. Reconcile precedence with backwards-amber + chain-highlight (those still win when active).

- **Verify:** component — relates_to edge carries the distinct style, blocks does not; backwards/highlight
  precedence intact; existing style/chain tests green. `pnpm --filter @pm/web test` + typecheck.
- **Commit:** "C1.P3: distinguish relates_to edges from blocks (soft, non-sequencing styling)".

### P4 — Reconcile downstream + states

Confirm lifecycle emphasis + ready-ring (actionableNow reads graph not positions — unaffected) +
Hide-done/Hide-future rails (fewer nodes → re-layout) + backwardsEdges amber (over new coords) + cycle
banner + empty/single-node states all work over the new positions. E2E asserts a single-prereq dependent
renders within the alignment band.

- **Verify:** `pnpm --filter @pm/web test` + `pnpm typecheck` + `pnpm lint` + `pnpm build`; E2E sweep (don't gate on host-flaky).
- **Commit:** "C1.P4: reconcile lifecycle/frontier/rails/states over neighbor-aligned coords".

---

## Cross-phase invariants

- Timeline mode byte-identical; structure layout pure + deterministic (existing harness green).
- Prerequisite-strictly-left-of-dependent holds (x = rank unchanged).
- Cycle back-edges still render amber from rank.excludedBackEdges.
- Server contract untouched; `pnpm test`/`typecheck`/`lint`/`build` green at every commit.
