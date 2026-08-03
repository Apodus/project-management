# Roadmap — Train phase timing + event trace (2026-08-03)

**Goal.** Make the merge train legible **while it runs**, not only when a result
pops out. Today a request enters the train and the operator learns nothing until
it lands or rejects — a 39-minute verify is indistinguishable from a wedge, and
nobody can say where the 39 minutes went.

**Builds on:** Phase 7.5 (`verify_steps` DAG + per-step `VerifyStepResult` with
`durationMs`/`cached`, persisted on `merge_attempts.steps`) and Phase 7.4
(dashboard, audit log, in-flight read). This campaign does NOT re-mechanize
those — it instruments the phases 7.5 cannot see, aggregates what both produce,
and renders the result.

**Out of scope (deliberate):**

- Splitting game_one's `pm-verify.bat` into `generate` / `build` / `test`
  `verify_steps`. That is a config + script change in the game_one repo, owned
  by that team, and it is what unlocks the intra-verify breakdown. PM cannot see
  inside a single shell command, and no code here can change that. This campaign
  must therefore degrade gracefully: with one opaque verify step it still shows
  queue / assemble / verify / land, just with `verify` as one bar.
- Changing verify semantics, the land protocol, or the cache.

---

## What is measured today, and what is not

| Phase | Today |
| --- | --- |
| queue wait (`enqueuedAt` → `pickedUpAt`) | derivable, never surfaced as a phase |
| group forming → first member pickup | derivable, never surfaced |
| binding + assembly (clone, fetch, rebase, **LFS/submodule materialize**) | **unmeasured** — the prime suspect for cross-repo wall clock |
| worktree reset / speculative base / rebase (single-repo) | **unmeasured** |
| verify | per-step `durationMs`, at whatever granularity `verify_steps` declares |
| land (fetch + push; ×2 for a group) | **unmeasured** |

---

## P1 — Phase record (data + contract)

New append-only table `merge_phase_timings`, one row per completed phase:

```
id, project_id, resource,
request_id (nullable, FK ON DELETE SET NULL),
group_id   (nullable, FK ON DELETE SET NULL),
attempt_id (nullable, FK ON DELETE SET NULL),
phase      (enum: queue_wait | assemble | rebase | materialize | verify | land | forming),
started_at, duration_ms,
detail     (nullable JSON: repo role, step id, cached flag, …),
created_at
```

Why a table and not `merge_attempts.steps[]`: assembly happens **before** an
attempt exists, and group assembly spans **both** members — there is nothing to
hang those on. The same rows back both the stats panel (P4) and the event trace
(P5), so one store serves both asks.

Deliverables: migration (next sequential number — stamp `when` honestly, see
CLAUDE.md), shared Zod schema, service (`recordPhase` + reads), REST ingest for
the integrator, authz = integrator (ai_agent) writes / any authenticated reads.
Invariant: recording a phase NEVER fails the operation it measures.

## P2 — Integrator instrumentation

Emit a phase row at each boundary the daemon already crosses:

- `batch.ts`: worktree reset, speculative base + rebase, verify (per step, from
  the existing pipeline results), land (fetch + push).
- `group-integration.ts` / `group-assembly.ts`: binding resolve, correlated
  lease, inner rebase, **materialize**, outer assemble, the two pushes.
- Queue wait + forming are derived PM-side from existing timestamps (no daemon
  work) — do not double-count them.

Fire-and-forget with the alerts-listener discipline: a failed phase POST logs
and continues. Never hold the lane lock on telemetry.

## P3 — Aggregation

Per `(project, resource)` over the 24h window, per phase: p50 / p95 / max /
count / share-of-total, plus the same for the newest N requests. Reuse the
nearest-rank percentile helper in `metrics.service.ts`; extend the metrics
bundle rather than minting a parallel endpoint.

## P4 — Train page: where the time goes

A phase-breakdown panel on the train dashboard (stacked bar per phase with p50 /
p95), and per-member phase progress on the In Flight table — so a running
request shows **which phase it is in and for how long**, which is the actual ask.
Degrades to a single `verify` bar when `verify_steps` is unconfigured.

## P5 — Event trace

A recent-events feed on the train page: the last N lane events (pickup, phase
completions, land, reject, requeue, incident, pause) with **durations**, drawn
from `merge_phase_timings` + `activity_log` + `audit_log`. This is the "what has
happened recently and what took how long" view. Live via the existing SSE
stream; do not invent a second transport.

## P6 — Discord enrichment

Extend the land/reject lines from the event feed (`train-feed-listener.ts`) with
a phase line:

```
✅ Group landed on `main` — "Fix grass placement drift" · inner abc1234d + outer def5678a
   ⏱ queue 12m · assemble 3m · verify 26m (generate 1m / build 18m / test 7m) · land 8s
```

Omit phases with no rows rather than printing zeros. Respect the existing
`train_events_enabled` gate.

## P7 — Seal

Playwright coverage for the panel + trace; a full-suite run; deployment-guide
section (phase taxonomy, what each phase includes, how it degrades without
`verify_steps`); CLAUDE.md capability-index entry.

---

## Design locks

1. **Telemetry is never load-bearing.** No phase write may fail, delay, or
   abort a merge. Fire-and-forget, guarded, no lock held.
2. **One store, two consumers.** The stats panel and the event trace read the
   same rows. If a phase is worth showing in the trace it is worth aggregating.
3. **Degrade honestly.** With one opaque verify step, show one `verify` bar —
   never fabricate a generate/build/test split PM cannot observe.
4. **Pre-computed durations only.** Emit `duration_ms` and rendered ages; never
   hand a reader two timestamps to subtract (deployment guide §14.14).
5. **No new transport.** SSE for live, the existing Discord webhook for
   out-of-band.
