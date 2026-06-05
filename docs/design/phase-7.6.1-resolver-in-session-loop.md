# Phase 7.6.1 — In-session resolver loop

Status: **design** (2026-06-05). Builds on Phase 7.6 (`docs/design/phase-7.6-design.md`).
Off by default (inherits `settings.integrator.resolver.enabled`, default `false`).

## 1. Motivation

Phase 7.6 resolves a textual rebase conflict with a **single** headless agent attempt: the
agent reconciles the markers, the daemon (`resolver-pool.ts` `runResolution`) commits and runs
the 7.5 verify pipeline **once** as the gate, and on a verify failure it **escalates** to the
author — one shot, no iteration. In practice a reconciliation often *nearly* works and fails one
test; throwing it straight to a human wastes a good attempt.

The natural fix is to let the agent **iterate**: resolve → run verify → read the failure → fix →
re-verify, until green. The question is *who runs verify and owns the loop*.

## 2. The key insight: the train is already the authoritative gate

A resolution that "succeeds" is **resubmitted as a new merge request** (`resolved_from = origin`)
that **re-enters the train and runs full verify again before it can land on main**
(`resolution-outcome.ts` `handleResolved` → `submitMergeRequest`). That train re-verify — not the
daemon's own `runPipeline` — is what actually protects `main`.

Therefore the daemon's own verify of the resolution is a *belt* on top of the train's *suspenders*.
**Letting the agent run verify in-session does not weaken safety**: we still never trust the model's
self-assertion to *land*; the train does that. The agent's in-session verify only builds its own
confidence and drives iteration.

This reverses the Phase 7.6 stance ("the agent must not run the slow verify; the daemon owns it").
Under 7.6.1 the agent **owns** iterating against the verify steps; the daemon owns only git/PM
finalization; the train remains the sole landing gate.

## 3. Architecture — agent owns the loop, daemon finalizes

```
pool spawns ONE long-lived agent (generous time+token budget), handing it the verify command(s)
agent, in ONE session, with full retained context:
    investigate → plan → execute → RUN the verify steps → diagnose any failure → fix → re-verify …
    … iterate until the FULL verify suite passes (its own judgment)
agent writes its decision to PM_RESOLUTION_STATUS_PATH (outside the worktree) and exits:
        { "status": "complete" }                — resolved tree left in the worktree, full verify seen green
        { "status": "give_up", "reason": "…" }  — no clear path forward
daemon (resolver-pool) reads the status file after the agent exits:
    complete   → commit + push pm/resolution-<id> + resubmit (resolved_from)  → TRAIN re-verifies = real gate
    give_up    → escalate (escalated, agent's reason) + author merge_rejection comment
    no file / conflict markers remain / non-zero exit → escalate (incomplete)
    spawn error → failed
budget breach (whole session) → SIGTERM→SIGKILL (killTree), → escalate (budget)
```

The daemon **drops** the `runPipeline` call. The agent never pushes or talks to PM — it only
produces the resolved tree and declares an outcome — so a mid-session death finalizes **nothing**
(clean recovery, §6).

### 3.1 Why the agent declares but the daemon finalizes
- **Trust boundary:** the agent needs no push credentials and no PM API token; all git/PM writes
  stay in the daemon (`resolution-outcome.ts`, unchanged).
- **Recovery:** if the session dies from a Claude API error mid-loop, there is no half-pushed branch
  and no double-resubmit risk — the reclaim sweep simply escalates (§6).

### 3.2 The status sentinel
A single JSON file written **outside** the git worktree (path injected via env
`PM_RESOLUTION_STATUS_PATH`, e.g. under `wt.logsDir`) so it never pollutes the resolved tree:

```json
{ "status": "complete" }
{ "status": "give_up", "reason": "two incompatible API redesigns; needs an author decision" }
```

The runner reads it after the agent exits. **Absent file ⇒ incomplete** (the agent did not confirm
it ran verify to green) ⇒ escalate. The prompt makes writing this file the mandatory final step.

## 4. The agent contract (prompt)

`DEFAULT_RESOLVER_PROMPT` (`@pm/shared`) gains the in-session verify loop. The commander/sub-agent
model from the 2026-06-05 revision stays; the changes:

- **You own verification.** Run the project's verify steps yourself (you will be given the
  command), iterate resolve→verify→fix until the **full** suite passes. Do not declare done on a
  partial/targeted check — targeted checks are fine for fast iteration, but you must see the *full*
  suite green before declaring `complete`.
- **Declare your outcome.** As your final step write `PM_RESOLUTION_STATUS_PATH`:
  `{ "status": "complete" }` once the full suite is green, or
  `{ "status": "give_up", "reason": … }` if after genuine effort you see no clear path. Do not thrash.
- **The integrator re-verifies** your result as the final landing gate — but that is *after* you;
  it is not a substitute for getting the suite green yourself.

The `{files}` and `{verify_command}` placeholders are retained (tests pin them).

## 5. Component changes

| Component | Change |
|---|---|
| `@pm/shared` `DEFAULT_RESOLVER_PROMPT` | reverse the "don't run verify" stance → agent owns the in-session verify loop + status-file declaration (§4). |
| `@pm/shared` `integratorSettingsSchema.resolver` + Zod-4 route mirror (`server/src/routes/projects.ts`) | `time_budget_sec` now bounds the **whole session**; raise default `600 → 3600`. **No `max_attempts`** (iteration is in-session). `max_concurrent`/`token_budget`/`command`/`prompt` unchanged. |
| `resolver-runner.ts` | inject `PM_RESOLUTION_STATUS_PATH` env; after exit read the status file → return `complete` / `give_up{reason}` / `incomplete{markers|timeout|spawn}`. Budget = whole session (existing SIGTERM→SIGKILL/killTree path unchanged). |
| `resolver-pool.ts` `runResolution` | **remove** the `runPipeline` gate; map the runner result: `complete` → `resolved` outcome (commit + return, worktree leased for push); `give_up`/`incomplete` → `escalate` (escalated); `spawn_error` → `failed`. `buildVerifySteps`/cache wiring removed. |
| `resolution-outcome.ts` `handleResolved` | **unchanged** — already fetches origin, pushes `pm/resolution-<id>`, resubmits with `resolvedFrom` + origin `verifyCmd`, records `resolved`. |
| `pm-client.ts` | add `listResolutions(projectId, { state })` (GET) and a "find resubmission by `resolved_from`" lookup (`listMergeRequests({ resolvedFrom })` or equivalent) for the reclaim sweep. |
| `loop.ts` | add the periodic **reclaim sweep** (§6) to the daemon tick. |
| server routes | ensure GET `merge-resolutions?state=resolving` and a `merge_requests?resolved_from=<id>` filter exist (add the filter if missing); both already `ai_agent`-readable. |

## 6. Recovery — budget kill + reclaim sweep

Long in-session sessions are now normal, so durable recovery is **required** (it was the noted v1
follow-up). Two layers:

1. **Hard budget kill** (exists): `time_budget_sec`/`token_budget` → SIGTERM→SIGKILL via `killTree`.
   Now bounds the whole loop, so it must be set generously (a few × the verify duration).

2. **Reclaim sweep** (new, periodic in `loop.ts`). For each `merge_resolutions` row in `resolving`:
   - **deadline** = `attempt_started_at + time_budget_sec + grace` (grace = `max(120s, 0.25 × budget)`).
     Derived from the existing `attempt_started_at` column ⇒ **no schema migration**.
   - If `now < deadline`: skip (a live session may still own it — the owning daemon's in-memory lease
     is authoritative while fresh; the time deadline is the cross-restart backstop).
   - If `now ≥ deadline`, **first check for a resubmission** (`merge_requests` with
     `resolved_from = origin`):
     - **found** ⇒ the resolution actually succeeded but `resolvedResolution` never recorded it
       (the v1 stranded-`resolving` case, `resolution-outcome.ts:199`). **Reconcile** →
       `resolvedResolution(id, { resolvedRequestId: found.id })`. Do **not** escalate (the resubmit
       already rides the train — escalating would be a lie).
     - **not found** ⇒ the session died/timed out without finalizing → `escalateResolution(id,
       { state: "failed", reason: "session_died_or_timeout" })` + author `merge_rejection` comment.
   - **Idempotency:** an `escalateResolution`/`resolvedResolution` on a row another path already
     transitioned returns the server's illegal-transition error (409) → the sweep treats it as
     already-handled and moves on. The sweep never throws into the train (non-fatal discipline).

This sweep also **closes the v1 known limitation** (stranded `resolving` after a post-submit
`resolvedResolution` throw) — not just API-error deaths.

## 7. State machine — unchanged

`pending → resolving → resolved | escalated | failed` (migration 0017, unchanged). Iteration lives
**inside** the agent session and the resolver log file, not in PM rows — **no new table, no
migration**. The `detail` JSON may optionally carry `sessionSec` / a coarse iteration count if the
agent reports it (nice-to-have, not required).

## 8. Observability

- Existing SSE `merge.resolution.pending|started|succeeded|escalated|failed` are reused. The reclaim
  sweep emits `escalated`/`succeeded` through the same endpoints (so a reconciled stranded row shows
  as `succeeded`, a dead one as `escalated`).
- Metrics (`metrics.service.ts` resolution sub-block): keep `auto_resolve_success_rate` /
  `escalation_rate`; add `mean_session_sec` (from `attempt_started_at`→terminal) and a
  `reclaimed_count`. No new tables.
- The per-request timeline already renders the origin→resolution→resubmit chain; a `resolving`
  resolution shows in-flight until the loop finishes.

## 9. Backward-compatibility / inertness

Resolver stays opt-in: `resolver.enabled = false` (default) ⇒ the pool is never constructed ⇒
byte-identical to 7.5/7.6-off. The in-session loop, status sentinel, and reclaim sweep are all live
**only** when the resolver is enabled. The `time_budget_sec` default change (600→3600) affects only
projects that have explicitly enabled the resolver.

## 10. Risks & non-goals

- **Agent must run the FULL suite before `complete`.** A partial-check declaration risks a wasted
  train verify + escalation. The prompt makes this non-negotiable; the train re-verify is the
  backstop that keeps it *safe* (just not free).
- **Flaky verify** can still consume budget — but the agent can now re-run + reason "this is
  unrelated/flaky," which v1 could not. We deliberately ship **no full-verify cap** (budget is the
  only backstop) per the 2026-06-05 decision; revisit only if a flaky suite proves costly.
- **Long sessions / token cost** are bounded solely by `time_budget_sec`/`token_budget`. Operators
  with slow verify must size the budget generously.
- **Non-goal:** semantic (non-textual) conflict detection; multi-resolution batching; per-iteration
  PM rows. Out of scope.

## 11. Test plan

- **Prompt** (`@pm/shared`): placeholder test still green; add a test asserting the status-file +
  "run the full verify yourself" instructions are present.
- **Runner** (`resolver-runner.ts`): status-file read → `complete`/`give_up`/absent(incomplete);
  env injection; budget timeout still → `timeout`/incomplete. Injectable fake unaffected.
- **Pool** (`resolver-pool.ts`): `runResolution` no longer calls `runPipeline`; `complete` →
  `resolved` outcome; `give_up`/markers/timeout → `escalate`; infra throw → `failed`. Existing
  pool/seam tests updated.
- **Reclaim sweep**: resolving past deadline with a resubmission present → reconciles `resolved`
  (no escalation); without → escalates `failed` + comment; idempotent vs an already-terminal row.
- **e2e** (fake runner): conflict → runner that declares `complete` → push + resubmit + train
  re-verify lands; a runner that declares `give_up` → escalates with the reason.
- Full monorepo green: `pnpm typecheck`, `pnpm lint`, `pnpm test` (integrator suite ~10 min),
  `pnpm build`.

## 12. Implementation phases (campaign)

1. **P1 — Prompt + config.** `DEFAULT_RESOLVER_PROMPT` rewrite (§4) + `time_budget_sec` whole-session
   semantics & default 3600 in `@pm/shared` **and** the Zod-4 route mirror. Tests + the
   conflict-resolution settings page picks up the new default via the existing endpoint.
2. **P2 — Runner status protocol.** `PM_RESOLUTION_STATUS_PATH` env + post-exit status read →
   `complete`/`give_up`/`incomplete`; budget bounds the whole session. Runner tests.
3. **P3 — Pool drops the verify gate.** `runResolution` removes `runPipeline`; maps runner result to
   `resolved`/`escalate`/`failed`. `onOutcome` (resolution-outcome.ts) unchanged. Pool tests.
   *(depends on P2's result shape.)*
4. **P4 — Reclaim sweep.** `pm-client.listResolutions` + resubmission lookup; `loop.ts` periodic
   sweep with reconcile-or-escalate + deadline derivation; any missing server list/filter. Sweep
   tests. *(independent of P2/P3; touches pm-client/server/loop.)*
5. **P5 — Seal.** e2e loop test (complete + give_up paths), reclaim test, metrics `mean_session_sec`/
   `reclaimed_count`, docs (`integrator-deployment.md` §18 + `CLAUDE.md` 7.6 note), full suite green.

## 13. Settled decisions

1. **Drop the daemon's own resolution verify** — the agent verifies in-session; the **train
   re-verify is the sole landing gate**.
2. **No `max_attempts`** — iteration is in-session; a **generous `time_budget_sec` + optional
   `token_budget`** is the only ceiling (default raised 600→3600).
3. **No full-verify cap** — budget is the only backstop against a flaky suite.
4. **Daemon finalizes, agent declares** (status sentinel) — clean trust boundary + clean recovery.
5. **Reclaim sweep is required**, and it **reconciles** a stranded-but-resubmitted row rather than
   falsely escalating it (also closes the v1 limitation).
