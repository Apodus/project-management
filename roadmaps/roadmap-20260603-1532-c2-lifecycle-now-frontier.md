# Campaign C2 — Lifecycle Phasing + the Now-Frontier

**Parent vision:** `roadmaps/vision-20260603-epic-roadmap-topological-layout.md`
**Tier:** A (user-visible). **Scope:** Medium, ~400–700 LOC, 4 phases.
**Branch:** `epic-roadmap-topological-layout` (continues from C1). **Commit:** one per phase.
**Depends on C1 (SHIPPED):** structure-mode coordinates exist; structure is the default.

## Goal

Make done / active / future legible at a glance and render a **completion frontier** —
"now" as the boundary between shipped and not-yet-shipped work — replacing the calendar-recency
fade with a **lifecycle**-driven emphasis. Answers "where are we now, and what's still future."

## Current state after C1 (key facts)

- **Structure is the default layout** (`computeEpicGraphLayout` default mode). Topological x, centered y.
- **`epic-node.tsx`** drives node opacity from `recede` (calendar `recedeOpacity`, `epic-graph-recency.ts`) OR `dimmed` (hover-chain). Health drives the completion-fill color (`getHealthColor`). Category drives the left border accent.
- **`epic-graph-recency.ts`**: `partitionEpics` (active/past/unscheduled by calendar: `done AND activity_recency < 45-day cutoff` → past; `not_started AND no target end` → unscheduled) + `recedeOpacity` (fades by `activity_recency` wall-clock age).
- **`epic-roadmap-canvas.tsx`**: in **structure mode**, `railComposed` currently folds ALL epics (active+past+unscheduled) into the DAG (`:205-214`) — the calendar Past/Backlog **rails are timeline-only** (`:483+`). `recede` is computed via `recedeOpacity(n.activity_recency, {now})` (~:289) and passed to every node REGARDLESS of mode. The "shows all epics" canvas test documents the C1 interim.
- **Server already provides** per-epic `health ∈ {not_started, on_track, at_risk, blocked, done}`, `status`, `taskSummary`, and `edges` (so an epic's `blocks`-prerequisites are knowable client-side).

## Commands

Test (web): `pnpm --filter @pm/web test` · Test all: `pnpm test` · Typecheck: `pnpm typecheck` ·
Lint: `pnpm lint` · Build: `pnpm build` · E2E (host-flaky, don't gate): `pnpm test:e2e`

## Engineering values (non-negotiable)

No investment ceiling — best end result. Pure + deterministic helpers (no Date.now/Math.random in
lifecycle logic; inject `now` if a clock is needed — mirror `epic-graph-recency.ts`). Automatic >
manual. Lifecycle drives base emphasis; category drives accent; hover drives transient dim — keep
these channels orthogonal (the existing canvas discipline). Per-epic `taskSummary`/`health` remain
the SINGLE lifecycle source — never fork a second completion calc.

---

## Phases

### C2.P1 — `epic-lifecycle.ts` + actionable-now predicate (pure, no render change)

A new pure module `packages/web/src/lib/epic-lifecycle.ts`:
- `lifecycle(node): "done" | "active" | "future"` — `done` = `health === "done"` OR `status === "completed"`; `future` = `health === "not_started"`; `active` = everything else (on_track / at_risk / blocked).
- `actionableNow(nodes, edges): Set<string>` — the set of `active` epics whose EVERY `blocks`-prerequisite is `done` (the work that is actually startable right now). Pure; consumes the same edge shape the layout uses (`from`=prereq, `to`=dependent, `dependency_type`). Handle cycles/blocked edges sanely (a blocked-by-incomplete-prereq epic is NOT actionable).

- **Verify:** new unit tests — lifecycle truth table (done/active/future from health × status); actionable-now predicate (all-prereqs-done → actionable; an incomplete prereq → not; no prereqs → actionable if active; cycle/blocked edge cases). Determinism.
- **Commit:** "C2.P1: epic-lifecycle.ts — done/active/future derivation + actionable-now predicate".

### C2.P2 — Lifecycle node emphasis (replace calendar recede in structure mode)

In structure mode, drive node emphasis from **lifecycle**, not `activity_recency`:
- `done` → receded/desaturated (the "behind us" zone).
- `active` → full emphasis.
- `future`/`not_started` → outlined/lighter ("not implemented yet").
Keep calendar `recedeOpacity` for **timeline mode only** (where calendar age is the point). Wire through
`epic-roadmap-canvas.tsx` (the `recede` computation ~:289 becomes mode-aware) and `epic-node.tsx`
(may need a lifecycle/treatment prop distinct from the numeric `recede`). Keep lifecycle / category-accent
/ hover-dim as orthogonal visual channels.
- **Depends on:** C1 structure coordinates (this renders in structure mode).
- **Verify:** component tests — done node desaturated, future node outlined, active node full, INDEPENDENT of `activity_recency`; timeline mode still uses calendar recede. Existing node/canvas tests green.
- **Commit:** "C2.P2: lifecycle-driven node emphasis in structure mode (done/active/future)".

### C2.P3 — Now-frontier overlay

A subtle structure-mode background band/contour bracketing the **actionable-now** set (from C2.P1) —
the at-a-glance "you are here." A new overlay component (mirror `MilestoneGuides`/`CategoryLegend`
patterns; rendered inside ReactFlow, structure-mode only). Compose with (don't fight) category accents
+ lifecycle emphasis. Optional legend affordance.
- **Verify:** the frontier overlay brackets exactly the actionable-now set; renders only in structure mode; component test. Reconcile with category legend (no visual collision).
- **Commit:** "C2.P3: now-frontier overlay bracketing the actionable set".

### C2.P4 — Lifecycle-gate the rails + migrate calendar-coupled tests

Re-gate the structure-mode rails on **lifecycle** (superseding C1.P5's "show all" interim):
Past rail = `done` epics (collapsed by default), Backlog rail = `future`/`not_started`, live canvas =
`active` + the actionable frontier. The calendar-age gate (`partitionEpics` 45-day cutoff) applies in
**timeline mode only**. Migrate the calendar-coupled tests this changes:
`epic-roadmap-canvas.test.tsx` (the "shows all epics" test → re-assert lifecycle rails in structure;
the C1-closeout test that documents the interim) + re-verify the E2E past-rail assertion
(`tests/e2e/05-epic-timeline.spec.ts`).
- **Verify:** structure Past rail = done (not calendar); future in Backlog; active on canvas. Migrated canvas tests green. Full suite green.
- **Commit:** "C2.P4: lifecycle-gated rails in structure mode + migrate calendar-coupled tests".

---

## Cross-phase invariants

- C1's structure layout + timeline mode never regress; `pnpm test`/`typecheck`/`lint` green at every commit.
- Lifecycle helpers pure + deterministic; `taskSummary`/`health` the single lifecycle source.
- Server contract untouched (client-only).
- Lifecycle / category-accent / hover-dim stay orthogonal visual channels.
