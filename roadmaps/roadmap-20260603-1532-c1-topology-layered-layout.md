# Campaign C1 — Topology-First Layered Layout + Mode Seam

**Parent vision:** `roadmaps/vision-20260603-epic-roadmap-topological-layout.md`
**Tier:** S (foundation). **Scope:** Large, ~900–1300 LOC, 6 phases.
**Branch:** `epic-roadmap-topological-layout`. **Commit:** one logical commit per phase.

## Goal

Replace the time-x / greedy-y epic-roadmap layout with a **layered DAG layout** — x from
dependency rank (a prerequisite is *always* strictly left of its dependent), y from a
crossing-minimized within-layer ordering — so short, low-crossing dependency edges are a
structural invariant. Preserve the existing time engine as an opt-in **"Timeline" mode**
behind a layout-mode seam; **"Structure" mode is the new default.**

## Key files (current state)

- `packages/web/src/lib/epic-graph-layout.ts` — the engine being replaced. x = `representativeTime = time_window.end ?? start` (`:81-90`); y = greedy interval-coloring (`:207`), never reads edges. Outputs `{positions, scale: TimeScale, laneCount, backwardsEdges}`. `NodePosition.t` (`:48`) is the per-node representative-ms. The `unscheduledIds`/Backlog-zone subsystem lives at `:108-201`.
- `packages/web/src/lib/epic-graph-layout.test.ts` — ~30 pure-layout tests (incl. 8 backlog-zone cases at `:249-344`). These migrate **verbatim** under timeline mode.
- `packages/web/src/components/epic-roadmap-canvas.tsx` — consumes layout; calls `computeEpicGraphLayout` (`:205-212`); reads `layout.scale` for `MilestoneGuides` + `yTop/ySpan` (`:217-226`); builds `unscheduledIds` memo (`:197-203`).
- `packages/web/src/components/milestone-guides.tsx` — reads `TimeScale.toX` (calendar artifact; gate to timeline mode).
- `packages/web/src/components/epic-node.tsx` — hard-codes `Handle target=Left` / `source=Right` (`:77-78`) → assumes left→right flow.
- `packages/web/src/lib/epic-graph-style.ts` — `getEdgeStyling`: amber+curved for `isBackwards` (reuse for cycle back-edges).
- Server payload (UNCHANGED this campaign): `epic-graph.service.ts` provides edges `{from=prereq, to=dependent, dependency_type ∈ {blocks, relates_to}, provenance}` + `hasCycle` + `cycles` (Kahn's already runs server-side).

## Commands

- Test (web pkg): `pnpm --filter @pm/web test`
- Test (all): `pnpm test`
- Typecheck: `pnpm typecheck` · Lint: `pnpm lint` · Build: `pnpm build`
- E2E: `pnpm test:e2e`

## Engineering values (non-negotiable)

No investment ceiling — best end result, not smallest diff. Less code in the right sense.
Automatic > manual (structural impossibility beats callsite discipline). Pure + deterministic
layout: NO `Date.now`/`Math.random`/`new Date` in layout modules; identical output across
shuffled input. Server contract untouched — entirely client-side.

---

## Phases

### P1 — Mode seam (pure refactor, no behavior change)

Rename the current engine internals to a `computeTimelineLayout` and make
`computeEpicGraphLayout(nodes, edges, { mode: "structure" | "timeline", ... })` dispatch on
`mode`. **Default stays `"timeline"` this phase** so all ~30 existing tests pass unchanged.
Introduce a discriminated `LayoutResult` so `scale: TimeScale` and `NodePosition.t` are
present **only** in timeline mode (structure variant omits them). No structure engine yet —
this phase is purely the seam + the contract shape C2 will read.

- **Verify:** `pnpm --filter @pm/web test` (all existing layout tests green, unchanged behavior) + `pnpm typecheck`.
- **Commit:** "C1.P1: layout-mode seam + discriminated LayoutResult (timeline default, no behavior change)".

### P2 — Rank assignment

Build the `blocks` sub-DAG (exclude `relates_to` — non-sequencing). DAG-ify by consuming the
server's `cycles` to choose back-edges to exclude from ranking. Compute a rank per node
(tight-tree preferred — minimizes total edge length → shorter edges; longest-path acceptable
fallback). Pure, unit-tested in isolation.

- **Verify:** new unit tests — A.rank < B.rank for every `blocks` edge; rank monotonic along chains; `relates_to` never constrains rank; cycle back-edge excluded; determinism across shuffled input; finite on degenerate inputs (empty, single, all-`relates_to`, full cycle).
- **Commit:** "C1.P2: topological rank assignment over the blocks sub-DAG (cycle-aware)".

### P3 — Crossing-minimized ordering (DECISION GATE: hand-rolled vs dagre)

Order nodes within each layer to minimize edge crossings via median heuristic + transpose.
**This is an objective decision gate, not just an impl:** pre-commit a crossing-count for a
fixed reference fixture (a 3-layer graph with two unavoidable crossings → assert exactly 2,
so "good enough" is falsifiable). Implement hand-rolled median+transpose. **If the first
honest attempt fails the crossing fixture OR the determinism shuffle test, adopt
`@dagrejs/dagre` for ordering+coordinates** (keep the hand-rolled rank + cycle pre-processing;
dagre needs a DAG anyway). Unit-tested either way against the same fixture + determinism gate.

- **Verify:** crossing-count fixture asserts the pre-committed number; determinism shuffle test; `pnpm --filter @pm/web test`.
- **Commit:** "C1.P3: crossing-minimized within-layer ordering (median+transpose | dagre)".

### P4 — Coordinate assignment (structure positions emitted)

Map rank → x (even layer spacing) and ordering → y (barycenter-aligned lanes, no overlap).
Emit the full structure-mode `positions` map. **This phase completes the structure coordinate
space — C2.P2 unblocks here.**

- **Verify:** unit tests — no node overlap; prerequisite strictly left of dependent (x); finite geometry on degenerate inputs; determinism.
- **Commit:** "C1.P4: coordinate assignment — structure-mode positions".

### P5 — Flip default to Structure + canvas wiring + MilestoneGuides reconciliation

Flip `computeEpicGraphLayout` default to `"structure"`. Wire a canvas mode toggle (segmented
"Structure | Timeline"); the compact dashboard-hero embed defaults to Structure with no
toggle. Gate `MilestoneGuides` + the "Today" line to timeline mode only. Recompute
`yTop`/`ySpan` from `positions` (mode-agnostic). **Gate the canvas `unscheduledIds` memo
(`:197-203`) to timeline mode** so it never feeds the structure engine. Migrate the ~30 pure
tests + 8 backlog-zone tests under timeline mode (verbatim-green).

- **Verify:** `pnpm --filter @pm/web test` (timeline-mode tests verbatim-green; new structure tests green) + `pnpm typecheck` + `pnpm lint`. E2E: roadmap renders prerequisites left of dependents; toggle flips Structure ↔ Timeline.
- **Commit:** "C1.P5: default to Structure mode + mode toggle + gate calendar artifacts to Timeline".

### P6 — Back-edge re-semantics + handle geometry + states

Re-semanticize `backwardsEdges` as cycle/upstream-contradiction back-edges (a `blocks` edge
pointing against rank); render via the existing amber+curved `getEdgeStyling` path. **Verify
ReactFlow handle geometry on a true reversed edge:** a right→left cycle back-edge attaches
`source=Right`→`target=Left` across the reversed span under the hard-coded handles
(`epic-node.tsx:77-78`) — confirm it reads as a deliberate contradiction loop (adjust handle
selection / edge `type` for reversed edges if needed). Cycle-warning banner still fires;
empty/loading/single-node states intact.

- **Verify:** `pnpm --filter @pm/web test` + `pnpm build` + `pnpm test:e2e` (full sweep) + `pnpm typecheck` + `pnpm lint`.
- **Commit:** "C1.P6: cycle back-edge re-semantics + reversed-edge handle routing + states".

---

## Cross-phase invariants (green at every commit)

- Timeline mode never regresses — preserved engine + its ~30 pure tests stay verbatim-green.
- Structure layout pure + deterministic (shuffle test is the gate).
- Prerequisite-left-of-dependent holds in structure mode for every non-cycle `blocks` edge.
- Server `epic-graph` contract untouched — no migration, client-only.
- `pnpm test` + `pnpm typecheck` + `pnpm lint` green.
