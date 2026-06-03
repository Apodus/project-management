# Vision — Readable Layered Roadmap Layout (neighbor-aligned coordinates)

**Date:** 2026-06-03
**Scope:** Make the structure-mode epic roadmap's dependency edges **clearly readable** — a dependent sits aligned-to / near its prerequisite, edges are short/straight/low-crossing, the 5 long-span edges route cleanly instead of cutting across nodes, and the 4 `relates_to` edges stop masquerading as sequencing `blocks`. The done↔active↔future left→right sense is a **soft** goal that yields to readability.
**Architect role:** Graph-layout / information-visualization systems architect.
**Status:** ACTIVE (Phase-2 verified — REVISED once from a dagre-engine-swap draft the verifier killed with live measurement; see bottom).
**Relationship to prior vision:** **Extends** `vision-20260603-epic-roadmap-topological-layout.md` (its C1 built the layered engine, C2 the lifecycle/frontier — both SHIPPED). This refines **only C1's coordinate-assignment step**, which shipped naive.

---

## Where we are

The topology-first layout shipped (prior arc C1): structure mode is the default, x = dependency rank, within-layer order is crossing-minimized. It is a real improvement — but on the **live rynx (game_one) graph** it reads badly, and the root cause is a single naive step. The numbers below are **measured against `./data/pm.db`**, not estimated.

### The live graph (measured)

- **49 epics, 32 edges = 28 `blocks` + 4 `relates_to`.** 0 cycles.
- Rank distribution: **4 layers, sizes `{0:27, 1:9, 2:11, 3:2}`** — wide and shallow. 27 nodes on rank 0 (20 of them fully isolated), only 2 on the deepest rank.
- **5 long-span `blocks` edges** (four rank-distance-2, one distance-3) — 18% of forward edges.

### The named failure (verified in code + measured)

The pipeline is **rank → order → coordinates**, and only the last step is broken:

1. **Rank** (`epic-graph-rank.ts`, longest-path over the cycle-broken `blocks` sub-DAG) → x. Correct: prerequisite always strictly left of dependent. **Keep.**
2. **Order** (`epic-graph-order.ts`, median + transpose) → a crossing-minimized within-layer permutation. The relative order is good. **Keep.**
3. **Coordinate assignment** (`epic-graph-layout.ts:301-310`) → y. **The failure.** Verbatim (`:307`):
   ```ts
   const y = (o - (k - 1) / 2) * STRUCTURE_ROW_HEIGHT;   // o = order index, k = layer size
   ```
   y is the node's **index within its own layer, centered**, with **zero regard for where its connected neighbors sit**. The order pass's good *relative* order is then discarded — equal order-index across layers of different size maps to *different* y (the `(k-1)/2` centering shifts each layer independently). A rank-0 node and its rank-1 dependent end up far apart; second-layer epics splay "way down" from their source.

**The measurement that scopes the fix** (mean / median / max edge vertical displacement, lower = more aligned = more readable):

| coordinate strategy | mean | median | max |
|---|---|---|---|
| current `(o-(k-1)/2)·H` | **436px** | 416px | 936px |
| neighbor-median pass on the **existing** rank+order (~120 LOC, no new deps) | **149px** | **104px** (one row) | 520px |

A hand-rolled neighbor-median coordinate pass recovers **66% of the splay** and lands the median single-prereq dependent **within one row** of its prerequisite. That *is* the readability win the user asked for — and it scopes the fix to the broken step, not an engine swap.

### Two compounding gaps (both small, both real)

- **No empty slots.** Layers are contiguously packed (`o = 0,1,2,…`); there is no mechanism to leave a gap so a lone dependent sits at its prerequisite's y. The user explicitly wants empty slots — **proximity-to-source beats dense packing.** The neighbor-median pass produces gaps naturally (a node takes its neighbor's y; sparse layers leave space).
- **5 long-span edges are unrouted.** `epic-graph-order.ts` (header `:14-20`) inserts no virtual nodes; a rank-distance>1 `blocks` edge is drawn as a straight diagonal across whatever nodes lie between its endpoints. 5 edges — a **custom-edge routing job**, not a reason to re-architect placement.

### Issue #3, resolved empirically

The user's "epics on the first layer that depend on each other" — a forward `blocks` edge can never be same-rank (longest-path guarantees separation), and the live graph **has 4 `relates_to` epic edges**, which `epic-graph-style.ts:45-106` renders with the **same arrowhead as `blocks`** (it branches on provenance/backwards only, never on `dependency_type`). So a soft relation reads as a sequencing dependency. That, plus the splay making rank columns hard to delineate, is issue #3. Both are fixed below.

---

## The arc

**One campaign.** The scope is a focused, measured, single-subsystem fix; the live-data measurement shows the minimal approach clears the readability bar, so a second campaign would be padding. The campaign has four phases: the coordinate pass (the 90% win) → routed long edges → `relates_to` distinction → downstream reconciliation.

> **North-star (user-set, 2026-06-03):** *"Make the dependencies as clearly readable as possible, while maintaining the done↔ongoing↔future split to some degree — soft goal. The clear read of dependencies is more important."*

> **REJECTED remedy (verifier-killed, kept as a guardrail):** adopting `@dagrejs/dagre` for order+coordinates+virtual-nodes and deleting the just-shipped `epic-graph-order.ts`. The verifier measured a hand-rolled pass at 149px (vs. dagre's marginal extra), counted only 5 long-span edges (not worth the virtual-node apparatus), and flagged the engine swap as churn + a maintenance-mode dependency + re-validation burden for no measured gain. **Do not reach for dagre.** Park it only if a future graph grows to hundreds of nodes / many-deep ranks.

---

### C1 — Readable Layered Coordinates + edge routing + `relates_to` distinction

- **Goal:** Replace the order-index-centered y with a **neighbor-aligned coordinate pass** (dependent aligns to the median-y of its prerequisites; empty slots allowed; deterministic min-gap overlap resolution), route the 5 long-span edges along inter-rank gaps, and style `relates_to` distinctly from `blocks` — so dependency edges become short, straight, traceable, and unambiguous.
- **Tier:** A (user-visible — directly fixes the named, measured regression).
- **Removes:**
  - Only the coordinate formula at `epic-graph-layout.ts:301-310` (the `(o-(k-1)/2)·H` y-assignment). **Nothing else** — `epic-graph-rank.ts`, `epic-graph-order.ts`, and their tests stay intact.
  - The default straight-bezier ReactFlow edge for long spans.
  - The dependency-type-blind edge styling (`epic-graph-style.ts` gains a `relates_to` branch).
- **Adds:**
  - A **neighbor-median coordinate pass** (in `computeStructureLayout`, or a small pure `lib/epic-graph-coords.ts` consuming `order.layers` + `forwardEdges`): assign each node a y from the median of its placed neighbors, resolve within-layer overlaps with a min-gap sweep that **preserves the order** from `epic-graph-order.ts`, leave gaps where layers are sparse. Pure + deterministic (no `Date.now`/`Math.random`; median + order + id tie-breaks).
  - A **custom ReactFlow edge** routing long-span edges through the gaps between intermediate-rank nodes — **derived from node positions**, no virtual nodes, no external engine.
  - **`relates_to` visual distinction** in `epic-graph-style.ts` (softer: dotted / lower-contrast / different-or-no arrowhead), reconciled with the hover chain-highlight and the amber backwards arcs.
- **Tests:** readability-invariant suite replacing the exact-coordinate structure tests — single-prereq dependent's y within ~1 row of its prereq (the measured alignment); no node overlap; **determinism across shuffled input** (reuse the existing harness — kept, since the engine stays ours); finite geometry on degenerate inputs; a long-span edge's routed path stays clear of intermediate node boxes on a fixture; `relates_to` carries the distinct style and `blocks` does not. Timeline-mode suite stays **byte-identical**.
- **Scope:** Medium. ~5–7 files (the coord pass, the custom edge + canvas wiring, `epic-graph-style.ts`, tests), **no new dependency**, **no deleted module**. LOC ~400–600. 4 phases.
  - **P1 — The coordinate pass (the 90% win).** Replace `:301-310`. Algorithm: sweep ranks (down then up, a few iterations like the ordering sweeps); each node's desired y = median of its already-placed adjacent-layer neighbors (prereqs on the down-sweep, dependents on the up-sweep); within each layer, walk nodes in their `order` and assign desired y, pushing later nodes down only as needed to keep min-gap (`STRUCTURE_ROW_HEIGHT`) — preserving order, leaving gaps. No-neighbor nodes (rank-0 sources, isolated) pack from a baseline. Migrate the structure coordinate tests to the readability invariants. **This phase alone delivers the measured 436→~149px fix.**
  - **P2 — Routed long-span edges.** A custom ReactFlow edge type for rank-distance>1 `blocks` edges, routing through the inter-rank gap lanes computed from node positions (the layout exposes, per long edge, the y-lane to thread). 5 edges; keep it simple.
  - **P3 — `relates_to` distinction.** Branch `epic-graph-style.ts` on `dependency_type`; render `relates_to` clearly softer than `blocks`. Verified-needed (4 edges exist). Reconcile with chain-highlight + backwards-amber precedence.
  - **P4 — Reconcile downstream + states.** Lifecycle emphasis + ready-ring (`actionableNow` reads the graph, not positions — unaffected) + Hide-done/Hide-future rails (fewer nodes → re-layout) + `backwardsEdges` amber (over new coords) + cycle banner + empty/single-node states; E2E asserts a single-prereq dependent renders within the alignment band.
- **Risk register:**
  - *Coordinate-pass convergence / overlap* — a naive single down-sweep can leave a prereq mis-centered vs. its dependents. **Mitigation:** a few down+up iterations (the priority/median method); min-gap sweep guarantees no overlap by construction; the measurement (149px) was from exactly this approach.
  - *Determinism* — must be byte-stable across input order. **Mitigation:** the engine stays ours, so the **existing** shuffle-determinism harness is reused unchanged; median + order + id tie-breaks, no clock.
  - *27-node rank-0 pileup* — many independent sources stack tall regardless of the coordinate pass. **Mitigation:** that's inherent to the data (20 isolated epics); the pass still aligns the *dependent chains* (the actual complaint); isolated sources packing in a column is acceptable and honest. (A future "isolated-node tray" is parked, not in scope.)
  - *Long-edge routing corner cases* — a routed path could still graze a node. **Mitigation:** route in the gap lane between intermediate-rank node bands; assert clearance on a fixture; only 5 edges to satisfy.
- **Cost of not doing it:** the topology-first value the prior arc shipped is undercut at the point of use — the user can't trace dependencies on the live roadmap (measured 436px mean displacement). Every epic added to game_one worsens it. This is the direct, named, observed regression that prompted the request.

---

## Sequencing

Single campaign, four sequential phases (P1 → P2 → P3 → P4). P1 is the load-bearing fix; P2 and P3 are independent small slot-ins that both follow P1 (they consume the corrected positions / the same canvas); P4 reconciles. No cross-campaign DAG (only one campaign).

```
phases: P1 (coords) → P2 (routed edges) → P3 (relates_to) → P4 (reconcile + states)
P2 and P3 are mutually independent; either may precede the other after P1.
```

---

## Cross-campaign invariants

- **Timeline (calendar) mode is byte-identical** — untouched; this arc is structure-mode only.
- **Structure layout stays pure + deterministic** — the existing shuffle-determinism harness stays green (engine remains ours; no new dependency to re-pin).
- **Prerequisite-strictly-left-of-dependent holds** for every forward `blocks` edge (x = rank unchanged).
- **Cycle back-edges still render amber** from `rank.excludedBackEdges`.
- **Server `epic-graph` contract untouched** — client-only.
- **`pnpm test`/`typecheck`/`lint`/`build` green at every commit;** lifecycle emphasis + ready-ring + rails keep working over the new positions.

---

## Out-of-scope for this arc (parked)

- **dagre / ELK adoption** — verifier-killed for this graph (149px hand-rolled clears the bar; 5 long edges don't justify virtual nodes). Revisit only at hundreds-of-nodes / many-deep-rank scale.
- **Force-directed / organic layouts** — non-deterministic, fight the rank semantics. Rejected.
- **Isolated-node tray** — a dedicated lane/tray for the 20 dependency-less epics so they don't stack in the rank-0 column. A real future polish, but the complaint is about *dependent* readability; park.
- **Interactive focus / collapse-subtree / pan-to-node**, **edge bundling**, **node-content density** — orthogonal to dependency-edge readability. Park.
- **Tighter ranking (network-simplex)** — longest-path's rank-0 pileup is inherent to 27 sources, not a ranking defect; network-simplex wouldn't materially change this shallow graph. Park.

---

## Recommended single starting point

**C1.P1 — the coordinate pass.** It is the measured 90% win (436→149px) and everything else (routed edges, relates_to, reconciliation) reads off the corrected positions. Invoke: `/campaign roadmaps/vision-20260603-epic-roadmap-layout-readability.md`.

---

## Open questions (commander authority)

When the user is unavailable, resolve via the campaign's quality criteria — don't pause:

- **Coordinate-pass iterations / direction.** *Resolution rule:* start with the median method, a few down+up sweeps; stop when the single-prereq alignment invariant (dependent within ~1 row of its prereq) passes on the rynx fixture. Don't over-iterate.
- **No-neighbor / isolated-node placement.** *Resolution rule:* pack rank-0 sources and the 20 isolated epics from a stable baseline (id-sorted); they have no dependency to align to. Do not let them perturb the aligned chains. (Isolated-node tray is parked.)
- **`relates_to` styling strength.** *Resolution rule:* clearly softer than `blocks` (dotted + lower contrast + no/!different arrowhead) so it never reads as sequencing; reconcile so backwards-amber and chain-highlight still win when active.
- **Long-edge routing shape.** *Resolution rule:* route in the inter-rank gap lane (orthogonal-ish or gentle spline) so the 5 long edges clear intermediate nodes; prefer the simplest path that reads cleanly.

---

## Phase-2 adversarial verification

**Verdict: REVISE → folded → APPROVE (single campaign).** A fresh adversarial verifier (opus) **queried the live rynx graph from `./data/pm.db` and measured the layouts**, then killed the draft's dagre recommendation on evidence:

- **The draft over-engineered to dagre.** Measured: the current `(o-(k-1)/2)·H` formula yields **436px mean edge vertical displacement**; a **~120-LOC neighbor-median pass on the existing rank+order yields 149px** (median 104px = one row). dagre's marginal extra quality does not justify a maintenance-mode dependency + deleting tested code + a coordinate-space remap + determinism re-pinning. **Killed: the dagre engine swap.**
- **Killed: deleting `epic-graph-order.ts`.** The ordering is fine (the failure is only the coordinate pass); deleting a just-shipped tested module to justify the replacement engine was the "throw away good work" smell. Keep rank + order; fix only coordinates.
- **Killed: the virtual-node apparatus.** Only **5 long-span edges** (max span 3) on a 4-layer graph — a custom-edge routing job, not an engine reason.
- **C2 dissolved into C1.** Its hard dependency ("C2 needs dagre's edge points") evaporates once routing derives from node positions. And `relates_to` **is verified to exist (4 edges)**, so its distinction is confirmed-needed (de-speculated), folded as C1.P3.
- **Honesty fix:** the resolution is "measured coordinate quality (436→149px), hand-rolled clears it," not "the old gate measured crossing-count, therefore dagre."

All four kills folded in: the arc is now **one campaign, hand-rolled, no new dependency, no deleted module**, scoped to the measured fix.

## Rejected by verifier

- **dagre/ELK engine swap** — no measured gain over a 120-LOC pass on this graph; dependency + churn + determinism-re-validation for nothing. Parked to hundreds-of-nodes scale.
- **Deleting `epic-graph-order.ts`** — the ordering is correct; only the coordinate pass is broken.
- **Virtual-node infrastructure** — 5 long edges is an edge-routing slot-in, not an engine.
- **C2 as a separate campaign** — collapsed into C1 (routed edges + relates_to styling are slot-ins on the corrected positions).
