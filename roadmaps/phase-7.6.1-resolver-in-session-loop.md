# Roadmap — Phase 7.6.1: In-session resolver loop

Spec: `docs/design/phase-7.6.1-resolver-in-session-loop.md`. Off by default (resolver opt-in).
Goal: the conflict resolver iterates resolve→verify→fix **in one agent session** until the full
verify suite passes, then declares an outcome; the daemon finalizes (push+resubmit) or escalates;
the **train re-verify stays the sole landing gate**; a reclaim sweep recovers dead/stranded sessions.

Project commands: `pnpm --filter <pkg> test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.
Key packages: `@pm/shared`, `@urtela/pm-integrator` (slow suite, ~10 min), `@pm/server`, `@pm/web`.
**Engineering values:** end-result quality over minimal diff; structural fixes over callsite patches;
non-fatal discipline (nothing the resolver does may throw into the train).

## P1 — Prompt + config

- Rewrite `DEFAULT_RESOLVER_PROMPT` (`packages/shared/src/schemas/project.ts`): keep the
  commander/fresh-sub-agent model; **reverse** the "don't run verify" stance → the agent owns the
  in-session verify loop (run the verify steps itself, iterate to a green FULL suite, targeted checks
  ok for speed but full suite required before declaring done), and as its final step writes the
  status sentinel at `PM_RESOLUTION_STATUS_PATH`: `{ "status": "complete" }` or
  `{ "status": "give_up", "reason": … }`. Retain `{files}` / `{verify_command}` placeholders.
- `integratorSettingsSchema.resolver`: `time_budget_sec` now bounds the **whole session**; raise
  default `600 → 3600`. Mirror in the Zod-4 route schema (`packages/server/src/routes/projects.ts`)
  — keep the `.prefault({})` parity. No `max_attempts`.
- Verify: `pnpm --filter @pm/shared test` (placeholder test + a new assertion for the status-file /
  full-verify instructions), `@pm/server` test (settings round-trip), typecheck.

## P2 — Runner status protocol

- `packages/integrator-ref/src/resolver-runner.ts`: inject `PM_RESOLUTION_STATUS_PATH` (an absolute
  path OUTSIDE the worktree, e.g. under `logsDir`) into the spawned agent env; after the agent exits,
  read + parse the status file → extend `ResolverRunResult` to `complete` | `give_up{reason}` |
  `incomplete{reason: "markers"|"timeout"|"spawn_error"}`. Absent/invalid file ⇒ `incomplete`
  (markers/exit still respected). Keep the injectable-fake seam and the SIGTERM→SIGKILL/killTree
  budget path; budget now = whole session.
- Verify: `pnpm --filter @urtela/pm-integrator test` (runner tests), typecheck.

## P3 — Pool drops the verify gate  (depends on P2)

- `packages/integrator-ref/src/resolver-pool.ts` `runResolution`: **remove** the `runPipeline` call
  and `buildVerifySteps`/cache wiring. Map the new runner result: `complete` → commit
  (`commitResolution`) + `resolved` outcome (worktree leased for the Step-7 push); `give_up` →
  `escalate{state:"escalated", reason}`; `incomplete(markers|timeout)` → `escalate{escalated}`;
  `incomplete(spawn_error)` → `escalate{failed}`; any infra throw → `failed`. `resolution-outcome.ts`
  `handleResolved` stays unchanged (already pushes + resubmits with `resolvedFrom` + origin
  `verifyCmd`).
- Verify: `pnpm --filter @urtela/pm-integrator test` (pool + seam tests updated), typecheck, build.

## P4 — Reclaim sweep  (independent of P2/P3)

- `pm-client.ts`: add `listResolutions(projectId, { state })` (GET `merge-resolutions`) and a
  resubmission lookup by `resolved_from` (`listMergeRequests({ resolvedFrom })` or equivalent). Add
  the server-side filter(s) if missing (`@pm/server` routes; `ai_agent`-readable).
- `loop.ts`: periodic reclaim sweep in the daemon tick. For each `resolving` row past
  `attempt_started_at + time_budget_sec + grace` (grace = `max(120s, 0.25×budget)`): if a
  resubmission (`resolved_from = origin`) exists → `resolvedResolution(id,{resolvedRequestId})`
  (reconcile, do NOT escalate); else → `escalateResolution(id,{state:"failed",
  reason:"session_died_or_timeout"})` + author `merge_rejection` comment. Idempotent vs an
  already-terminal row (409 → treat as handled); non-fatal (never throws into the train).
- Verify: `pnpm --filter @urtela/pm-integrator test` + `pnpm --filter @pm/server test`
  (filter/route), typecheck.

## P5 — Seal

- e2e/integration (fake runner): `complete` path → push + resubmit + train re-verify lands;
  `give_up` path → escalates with the reason; reclaim path → reconcile-vs-escalate both covered.
- Metrics (`metrics.service.ts` resolution sub-block): add `mean_session_sec` + `reclaimed_count`.
- Docs: `docs/integrator-deployment.md` §18 (in-session loop + budget sizing + reclaim) and the
  `CLAUDE.md` Phase 7.6 note (point to 7.6.1).
- Full monorepo green: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. Commit per phase;
  working tree clean at the end.
