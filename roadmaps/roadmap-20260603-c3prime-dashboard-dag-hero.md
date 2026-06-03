# Campaign C3′ — Dashboard-as-DAG-hero + board re-scope

Consolidation of original C3 + C4 from `vision-20260602-epic-timeline-visualization.md`,
user-directed 2026-06-03 after C1+C2 shipped. Driven via `/campaign`.

**Goal:** Make the **dashboard** (which STAYS the default project landing) the DAG-hero
surface: the epic DAG embedded as the hero at the top, the pulse widgets (attention /
my-work / AI-agents / proposals) reshaped into a thin dressing rail around it, and the
board re-scoped into an epic drill-down so tasks are never a default infinite enumeration.
The standalone `/roadmap` route remains a focused full-bleed view.

**The one change from original C3:** we do NOT flip the default route to `/roadmap`. The
dashboard itself becomes the hero surface (realizing the north-star: "the DAG is the single
most important thing on the dashboard; everything else is dressing").

**Engineering values (non-negotiable):** No investment ceiling — end-result quality.
Less code in the right sense — REUSE the C1/C2 machinery. Automatic > manual. Non-destructive
(re-scope, don't delete). Getting it right > fast.

**What already exists (the C1/C2/C4.P1 baseline this builds on):**
- `/projects/{id}/roadmap` (`epic-timeline-page.tsx`) — the full DAG view: ReactFlow canvas
  (`computeEpicGraphLayout`, custom `epic-node`, edge styling, chain-highlight, recency-recede
  + Past rail, milestone guides + today line, cycle banner, `ROADMAP_FIT_OPTIONS` zoom cap) +
  the floating draggable/resizable task mini-DAG panel (`epic-tasks-panel`). The canvas logic is
  currently WELDED into the page.
- `GET /api/v1/projects/{id}/epic-graph` (C1) + `GET .../epics/{epicId}/task-graph`.
- `dashboard-page.tsx` — already has C4.P1 density (attention lifted, collapse-when-empty,
  masonry). Default project route (`router.tsx` `projectIndexRoute` → `DashboardPage`).
- `board-page.tsx` — the project-wide unbounded board (`perPage: 100`, full backlog+done columns)
  — the "two infinite lists" surface to re-scope.
- Web test harness: vitest + Testing Library; `@xyflow/react` mocked via passthrough in page tests.
- Commands: `pnpm --filter @pm/web {test,typecheck,build,lint}`, `pnpm test:e2e`.

---

## P1 — Extract a reusable `<EpicRoadmapCanvas>` (pure refactor, no behavior change)

- **Change:** Extract the ReactFlow canvas + all its logic (layout memo, rfNodes/rfEdges,
  hover chain-highlight, recency/partition + Past rail, milestone guides, cycle banner, the
  floating task panel, fitView/`ROADMAP_FIT_OPTIONS`, the `useEpicGraph` fetch) out of
  `epic-timeline-page.tsx` into a NEW reusable `packages/web/src/components/epic-roadmap-canvas.tsx`
  (`<EpicRoadmapCanvas projectId variant?="full"|"compact" />`). `epic-timeline-page.tsx` becomes a
  thin wrapper: header + `<EpicRoadmapCanvas variant="full" />` in the existing `min-h-0 flex-1`
  region. The `variant` prop is the seam for P2's compact dashboard hero (e.g. compact hides some
  chrome / tightens controls — decide minimal differences in P2; P1 just plumbs the prop, default
  "full" = byte-identical current behavior).
- **Verify:** existing `epic-timeline-page.test.tsx` stays green (the page still renders the canvas;
  may need the mock/test pointed at the extracted component — keep behavior identical). New thin
  `epic-roadmap-canvas.test.tsx` if useful. `pnpm --filter @pm/web {test,typecheck,build,lint}`.
  Dev-smoke: `/roadmap` looks/behaves exactly as before.
- **Depends on:** C1/C2 (done).
- **NOTE:** contract for P2 is the `<EpicRoadmapCanvas>` component API — stable at end of P1.

## P2 — Dashboard DAG-hero + pulse-rail reshape (dashboard stays default)

- **Change:** In `dashboard-page.tsx`, add `<EpicRoadmapCanvas projectId variant="compact" />` as a
  **bounded-height hero panel at the top** (e.g. a card `h-[55vh]`/`h-[480px]` — ReactFlow needs an
  explicit/flex-bounded height, mirror the proven `min-h-0`/`flex-1` chain). Reshape the dashboard
  around it per the north-star: a slim attention strip (only when something needs attention) + the
  DAG hero as the dominant element, then the existing stats + masonry pulse widgets (my-work,
  AI-agents, proposals, recent activity) below as the dressing rail. Add an "Open full roadmap →"
  link on the hero to `/projects/{id}/roadmap`. Dashboard REMAINS the default route (do NOT touch
  `projectIndexRoute`). Empty state: project with 0 epics → hero shows the canvas empty-state.
- **Verify:** `dashboard-page.test.tsx` (exists? add/update) — assert the hero renders + the pulse
  widgets still render + collapse-when-empty preserved. The `@xyflow/react` mock must be available to
  the dashboard test now (the hero embeds a ReactFlow). `pnpm --filter @pm/web {test,typecheck,build,lint}`.
  Dev-smoke: landing on a project shows the DAG hero with the pulse rail below; hero links to /roadmap;
  click an epic in the hero opens the floating task panel (inherited from the canvas).
- **Depends on:** P1 (consumes `<EpicRoadmapCanvas>`).

## P3 — Board re-scope: epic drill-down (kill the infinite lists)

- **Change:** Re-scope the board from a project-wide unbounded enumeration into an **epic drill-down**.
  Concretely: the board is reachable per-epic (a board/tasks view scoped to ONE epic — bounded by
  construction), e.g. `/projects/{id}/epics/{epicId}/board` or a board tab on epic detail (reuse
  `board-page.tsx`'s logic with the epic filter pinned). The project-wide board route is RETIRED or
  GATED behind an explicit "all tasks (power user)" affordance, defaulted closed / excluding
  done+cancelled. Re-point the sidebar nav (demote "Board"/"Tasks" to within-epic or power-user).
  NON-DESTRUCTIVE — re-scope/gate, do not delete; AI-agent MCP workflows are untouched (agents use
  MCP, not the web board).
- **Verify:** routing tests (epic drill → epic-scoped board shows only that epic's tasks); the board's
  swimlane/group-by-epic logic reused; E2E re-pointed if it touched the board; assert no default
  surface enumerates the full task set. `pnpm --filter @pm/web {test,typecheck,build,lint}` + `pnpm test:e2e`.
- **Depends on:** P2 (the dashboard is the landing; the board is now a secondary drill-down). Largely
  independent of the canvas — could overlap P1/P2, but sequence after to keep the IA coherent.

---

## Cross-phase invariants
- The dashboard REMAINS the default project route (`projectIndexRoute` untouched).
- `/roadmap` full view keeps working (P1 refactor is behavior-preserving).
- C1/C2 machinery is REUSED, not forked (one `<EpicRoadmapCanvas>` for both surfaces).
- Board re-scope is non-destructive (gate/re-scope, never delete); AI-agent MCP flows untouched.
- `pnpm --filter @pm/web {test,typecheck,build,lint}` green at every phase boundary; the
  ReactFlow height chain (`min-h-0`/`flex-1` / explicit height) is pinned wherever the canvas embeds.
