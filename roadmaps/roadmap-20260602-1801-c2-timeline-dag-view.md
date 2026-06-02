# Campaign C2 — Timeline-DAG View (headline UX)

Per-campaign roadmap materialized from `vision-20260602-epic-timeline-visualization.md` (C2).
Driven by `/campaign` as the second half of the combined C1→C2 effort. C3/C4 parked.
**C1 is COMPLETE** (commits fbfe3a6 → e4e7b84) — the `epic-graph` contract is stable.

**Goal:** A time-anchored, dependency-aware epic graph: epics positioned on a horizontal
time axis (active work near "today," ancient work receding/faded), each node visualizing
completion + health, dependency edges as arrows, pan/zoom, click-to-drill into the epic.

**Engineering values (non-negotiable):** No investment ceiling — bar is end-result quality.
Automatic > manual. Less code in the right sense. Getting it right > fast.

**The C1 contract this consumes (live, stable):**
`GET /api/v1/projects/{projectId}/epic-graph` →
```
{
  nodes: [{ id, project_id, name, status, priority, target_date,
            created_at, updated_at, taskSummary{total,done,byStatus},
            health: "not_started"|"on_track"|"at_risk"|"blocked"|"done",
            activity_recency, time_window{start, end} }],
  edges: [{ from (prerequisite epic id), to (dependent epic id),
            dependency_type: "blocks"|"relates_to", provenance: "derived"|"explicit" }],
  hasCycle: boolean,
  cycles?: string[][]
}
```
Edge direction: arrow points prerequisite → dependent (`from` blocks `to`).

**Established web conventions to honor (verify against source in each phase):**
- React 19 + Vite + Tailwind v4. TanStack Router (`packages/web/src/router.tsx`),
  TanStack Query hooks (`packages/web/src/hooks/use-*.ts`), Zustand for client state.
- API client `packages/web/src/lib/api.ts`; API types generated from OpenAPI via
  `pnpm --filter @pm/web generate:api` (run this FIRST in P1 to get the EpicGraph types —
  C1 already regenerated `packages/server/openapi.json`).
- Radix UI primitives in `packages/web/src/components/ui/`. `cn` util, `format.ts` helpers
  (getStatusColor/getPriorityColor). Existing epic completion UI to reuse visually:
  `packages/web/src/pages/epic-list-page.tsx` (progress bar + ratio + %).
- Routes are registered in `router.tsx` under `projectRoute`.
- Commands: `pnpm --filter @pm/web dev`, `pnpm --filter @pm/web typecheck`,
  `pnpm --filter @pm/web build`, `pnpm test`, `pnpm test:e2e`, `pnpm lint`.

---

## P1 — route scaffold + fetch epic-graph + bare nodes (prove the data path)

- **Change:** Run `pnpm --filter @pm/web generate:api` to pull the `EpicGraph` types. Add a
  new route `/projects/{projectId}/roadmap` (`epic-timeline-page.tsx`) registered in
  `router.tsx` under `projectRoute`. Add a `useEpicGraph(projectId)` TanStack Query hook
  (mirror `use-epics.ts`) hitting the new endpoint. Render bare node cards in a naive vertical
  list (name + `{done}/{total}` + health label) to prove the end-to-end data path. Add a sidebar
  nav entry for "Roadmap" (do NOT change the default route — that's C3, parked).
- **Verify:** `pnpm --filter @pm/web typecheck` + `pnpm --filter @pm/web build`; manual/dev
  smoke that the route renders the live payload. (A thin component test if the harness supports it.)
- **Depends on:** C1 (done).

## P2 — `epic-graph-layout.ts` (time-x + dependency-lane-y), unit-tested in isolation

- **Change:** A PURE, deterministic layout module `packages/web/src/lib/epic-graph-layout.ts`:
  input = nodes + edges; output = `Map<epicId, {x, y}>` (+ any lane metadata). x from
  `time_window` (NOW pinned near the right edge; future target_dates extend right; past recedes
  left). y from a dependency-respecting lane assignment (a prerequisite never sits to the right
  of its dependent; lanes avoid edge overlap). Ties broken by stable sort on id — NO randomness,
  NO Date.now() inside the pure fn (pass `now` in). Unit-tested in isolation.
- **Verify:** Vitest unit tests — deterministic positions (same input → same output); no node
  overlap; prerequisite-left-of-dependent invariant; past-recede ordering; backwards-in-time edge
  handling (flagged, not crashing). `pnpm --filter @pm/web test` (or the web test runner).
- **Depends on:** P1.

## P3 — ReactFlow integration: custom completion/health nodes + pan/zoom + drill

- **Change:** Add `@xyflow/react`. Render the graph with ReactFlow using OUR computed positions
  from P2 (ReactFlow does NOT impose layout when positions are supplied). Custom node component:
  body fills left→right with completion, colored by `health`; shows `{done}/{total}` + `%`; a thin
  `byStatus`-segmented underline on hover. Pan/zoom enabled. Click-to-drill navigates to the epic
  detail route. Wire the page to compute layout (P2) then feed ReactFlow.
- **Verify:** component test (node renders completion fill + ratio + health color); typecheck +
  build; dev smoke (pan/zoom works, click drills). Keep layout pure/owned — ReactFlow for
  render/interaction only.
- **Depends on:** P2.

## P4 — edges: derived-dashed/explicit-solid + arrowheads + chain highlight

- **Change:** Custom edges prerequisite→dependent with arrowheads; dashed = derived,
  solid = explicit (provenance). On hover/select of a node, highlight its full dependency chain
  (ancestors + descendants) and dim the rest. Backwards-in-time edges (data contradiction) rendered
  curved + visually flagged. Cycle members (from `cycles`) visually marked.
- **Verify:** component test (derived vs explicit styling; chain highlight on select; cycle marking);
  typecheck + build; dev smoke.
- **Depends on:** P3.

## P5 — recency recede + "Past" rail collapse + focus-active viewport

- **Change:** Fade/recede nodes by `activity_recency` (older = dimmer/smaller). Collapse
  completed-and-old epics into an expandable faded "Past" rail with a "+N older epics" affordance.
  Default viewport ("focus active") opens centered on in-flight + upcoming epics, not the whole
  history. Expand/collapse interaction for the Past rail.
- **Verify:** component test (recede threshold; Past rail collapse/expand; default viewport centers
  on active); typecheck + build; dev smoke.
- **Depends on:** P4.

## P6 — milestone guides + empty/loading/cycle states + E2E

- **Change:** Vertical milestone guide lines on the time axis at each milestone `target_date`
  (milestones already exist in data — fetch them). Empty state (no epics), loading skeleton, and a
  cycle-warning banner when `hasCycle`. Playwright `epic-timeline.spec`: roadmap route renders
  nodes + edges, clicking a node drills to epic detail, "show older" expands the Past rail.
- **Verify:** `pnpm test:e2e` (new spec green) + full `pnpm test` + `pnpm typecheck` + `pnpm lint`
  + `pnpm build`. One commit per phase.
- **Depends on:** P5.

---

## Cross-phase invariants
- Existing surfaces never regress (C2 is purely additive — a NEW route; default route unchanged
  until C3, which is parked).
- The layout module stays PURE and deterministic (no Date.now/Math.random inside; `now` injected).
- ReactFlow is used for rendering/interaction ONLY — layout is owned/testable.
- `taskSummary` from the payload is the single completion source (do not recompute).
- `pnpm typecheck` + `pnpm lint` + `pnpm build` green at every phase boundary.
