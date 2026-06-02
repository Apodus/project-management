# Campaign C1 — Epic Graph Model (data seal)

Per-campaign roadmap materialized from `vision-20260602-epic-timeline-visualization.md` (C1).
Driven by `/campaign` as part of the combined C1→C2 effort. C3/C4 parked.

**Goal:** Make epic→epic dependencies and per-epic roadmap state a first-class, queryable
contract — derived automatically from the task graph where possible, authorable explicitly
for planning-time intent, served as one `epic-graph` payload.

**Engineering values (non-negotiable):** No investment ceiling — bar is end-result quality,
not minimum diff. Automatic > manual. Less code in the right sense. Getting it right > fast.

**Established conventions to honor (from the repo):**

- Shared Zod schemas are the single source of truth in `@pm/shared` (Zod-3 canonical), with
  route-local Zod-4 mirrors in the server (the established split — see phase-7.5 verify_steps).
- Drizzle ORM; migrations in `packages/server/src/db/migrations/`, generated via
  `pnpm --filter @pm/server db:generate` after editing `schema.ts`.
- Services in `packages/server/src/services/`, routes in `packages/server/src/routes/`.
- In-memory SQLite test harness (Vitest) for server tests.
- MCP worker tools mirror existing shapes (`pm_block_task`, `pm_link_git_ref`).
- Commands: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`,
  `pnpm --filter @pm/server test`, `pnpm --filter @pm/shared test`.

---

## P1 — `epic_dependencies` table + migration + `@pm/shared` schemas (contract definition)

- **Change:** Add an `epic_dependencies` table (Drizzle schema): `{ id, project_id, epic_id,
depends_on_epic_id, dependency_type ∈ {blocks, relates_to}, created_at, created_by }` for
  EXPLICIT planning-time epic edges. Generate the migration. Add canonical Zod-3 schemas to
  `@pm/shared` (`selectEpicDependencySchema`, `insertEpicDependencySchema`), exported via the
  schemas index. Define the `epicGraphSchema` shape (nodes + edges + cycle flag) as the contract
  skeleton in `@pm/shared` so consumers can type against it.
- **Verify:** `pnpm --filter @pm/shared test` (schema round-trip) + `pnpm --filter @pm/server db:generate`
  produces a clean migration + `pnpm typecheck`.
- **Depends on:** nothing.

## P2 — `GET epic-graph` endpoint, derived edges only (CONTRACT STABLE — C2 unblocks here)

- **Change:** Add `epic-graph.service.ts` with the DERIVATION query: roll cross-epic task `blocks`
  dependencies up to epic granularity (epic A blocks epic B iff ∃ task∈B that `blocks`-depends on a
  task∈A), deduped. Build the `epic-graph` payload: nodes = epics + their existing `taskSummary`,
  edges = derived blocks edges (provenance `derived`). Add `GET /api/v1/projects/{id}/epic-graph`
  with the route-local Zod-4 mirror of `epicGraphSchema`. Register the route; export OpenAPI.
- **Verify:** server unit tests (roll-up: multiple cross-epic task deps → one epic edge, dedup;
  no self-edges; epics with no deps → isolated nodes) + `pnpm --filter @pm/server test` + build.
- **Depends on:** P1.
- **NOTE:** At end of P2 the read contract is stable. C2 frontend may begin against it.

## P3 — explicit edges unioned w/ provenance + cycle detection + MCP tools

- **Change:** Extend `epic-graph.service.ts` to UNION explicit `epic_dependencies` rows with the
  derived edges, tagging provenance (`derived | explicit`); when both exist for the same ordered
  pair, explicit wins (collapse, mark `explicit`). Add Kahn's cycle detection over `blocks` edges;
  surface cycles as a payload flag (never drop edges). Add service CRUD for explicit edges
  (create/delete with project + epic existence checks, no self-dep, no duplicate). Add MCP worker
  tools `pm_link_epic_dependency` / `pm_unlink_epic_dependency` mirroring the task-dependency tool
  shape. Wire REST endpoints for create/delete explicit edge.
- **Verify:** unit tests (provenance union + explicit-wins; cycle A→B→A flagged; self-dep rejected;
  duplicate rejected) + MCP tool tests if harness exists + `pnpm test` + build.
- **Depends on:** P2.

## P4 — node enrichment (health, recency, time_window) + full test suite

- **Change:** Enrich graph nodes: `health ∈ {not_started, on_track, at_risk, blocked, done}`
  (at_risk = target_date passed AND incomplete; blocked = has an incomplete `blocks` prerequisite;
  done = all tasks done / epic status completed; not_started = 0 done; else on_track),
  `activity_recency` = max(task.updated_at) for the epic falling back to epic.updated_at,
  `time_window` = { start: created_at (or first task started), end: target_date|null }. Round out
  the test suite (health truth table, recency fallback, time_window). Update OpenAPI export.
- **Verify:** full `pnpm test` green + `pnpm typecheck` + `pnpm lint` + build. One commit per phase.
- **Depends on:** P3.

---

## Cross-phase invariants

- Existing epic/task/board surfaces never regress (C1 is purely additive).
- `taskSummary` remains the single completion source — do not fork a second calculation.
- `pnpm test` + `pnpm typecheck` + `pnpm lint` green at every phase boundary.
- Zod-3 canonical / Zod-4 route-local split preserved for every new schema.
