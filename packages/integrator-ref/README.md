# @pm/integrator-ref

Reference integrator process for the PM merge train. One process per `(project, resource)` lane.

It watches a PM project for queued merge requests, rebases each onto live main in an isolated
worktree, runs the project's verify command, and either lands the change (fast-forwarding main)
or rejects it with a structured payload.

## Quick start

```bash
pnpm --filter @pm/integrator-ref build
PM_API_TOKEN=... node packages/integrator-ref/dist/index.js \
  --project 01HXYZ... \
  --resource main \
  --pm-url http://localhost:3000
```

With `parallelism > 1` (set in the project's `settings.integrator`) it runs N integrations in
flight at once: each member rebases speculatively on `main + predecessors`, all verify concurrently
in a pool of N isolated worktree clones, and lands serialize in batch order (Phase 7.2).

## Documentation

- **Operator deployment guide** (start here): `docs/integrator-deployment.md` — install,
  configuration, worktree setup, verify conventions, logging, monitoring, failure modes,
  and single-machine multi-agent layout. Includes the Phase 7.2 speculative-batching section
  (`parallelism`, worktree pool, lane-ownership lock, batch events, batch failure modes) and the
  Phase 7.3 cross-repo atomicity section (§14: `linked_repos`, inner/outer pools, atomic-land
  protocol, orphaned-inner incident + recovery, cross-repo failure modes).
- **Architecture & contracts**: `docs/design/phase-7.1-design.md` (serial baseline),
  `docs/design/phase-7.2-design.md` (speculative batching), and
  `docs/design/phase-7.3-design.md` (cross-repo atomicity).

## Configuration at a glance

CLI flags: `--project`, `--resource` (default `main`), `--pm-url`, `--token` (env-var name,
default `PM_API_TOKEN`), `--log-level`, `--poll-interval-sec` (default `30`).

Per-project settings live in `projects.settings.integrator` — see the deployment guide. Key fields:
`enabled`, `verify_command`, `verify_timeout_sec`, `worktree_root`, `worktree_name`, `git_remote`,
`git_main_branch`, **`parallelism`** (integer ≥ 1, **default 1** = 7.1 serial behavior; there is
**no env var** — it is set on the project, not the process), and **`linked_repos`** (Phase 7.3,
**default `[]`** = single-repo). `parallelism: N` runs a pool of N worktree clones at
`${worktree_root}/${worktree_name}-{0..N-1}`.

`linked_repos` (Phase 7.3 cross-repo atomicity) declares the inner/outer repos that must land as a
unit: `[{ name, path, role: "inner"|"outer", gitlink_parent?, gitlink_path? }]` — **exactly one
`inner` + one `outer`** when non-empty (else config exit code 2). Each linked repo gets its **own**
worktree pool (`${worktree_root}/${worktree_name}-{inner,outer}-{0..N-1}`) alongside the base pool.
Empty = byte-identical to 7.2. See the deployment guide §14 and `docs/design/phase-7.3-design.md`.

## Code map note

`runBatchLoop` / `runBatchOnce` (`src/batch.ts`) is the **live path** — `index.ts` wires it for all
parallelism levels (a degenerate batch-of-one at `parallelism: 1`). The 7.1 serial `runLoop` /
`runOnce` (`src/loop.ts`) is **superseded but retained**: it is the behavioral oracle for the N=1
case and `batch.ts` still imports its `isApiError` / `errMessage` helpers, so it is not dead-code-removed.

**Phase 7.3 group path** (engaged only when `linked_repos` is declared; `index.ts` builds the
inner/outer `RepoLane`s and a `groupLane`, and `batch.ts`'s `runGroupLaneOnce` runs it under the
lane lock *before* the single-repo drain): `group-assembly.ts` (`assembleGroup` — correlated
inner+outer lease, rebase both, commit the outer gitlink → `Ri`, materialize the inner sources into
the outer working tree) → `group-integration.ts` (`runGroupIntegration` — bind members→roles,
pick up, concurrent assembled verify, AND) → `group-land.ts` (`landAssembledGroup` — the inner-then-
outer atomic land + the three failure points; orphan → `openIncident`) → `group-recovery.ts`
(`recoverOrphanedInner` — PM-keyed auto-rollforward, the `isAncestor`/RECONCILABLE gate, escalate).
Crash recovery: `recovery.ts` carries both `reclaimStrandedRequests` (single-repo, ungrouped) and
`reclaimStrandedGroups` (resets a stranded `integrating` group with no open incident back to
`forming` via `resetGroup`; a group *with* an open incident is left for orphan recovery). The
single-repo merge-request list uses an `ungrouped: true` filter so grouped members are never
speculatively interleaved. Deterministic test-only fault hooks live in `chaos.ts`.
