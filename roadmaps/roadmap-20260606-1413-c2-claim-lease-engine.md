# Campaign C2 — The Claim Lease Engine

**Status: ✅ C2 shipped (2026-06-06)** — all phases (P1–P5) landed; ships in **shadow / long-grace** posture. Design doc: `docs/design/phase-c2-claim-lease-engine.md`.

**Parent vision:** `roadmaps/vision-20260606-claim-liveness-heartbeat.md` (C2, tier S, recommended start).
**Branch:** `campaign-claim-lease-engine`
**Mode for this campaign:** ship in **shadow / long-grace** (safe before C1 — the engine observes and records but does NOT auto-clear live work by default; turning auto-reclaim `on` is a later C1-gated phase, out of scope here).

## Goal
Make a claim a **lease**: it lives only while the holder is provably alive, renews **automatically from real activity** (via the `assertClaimOk` seam), and can be swept back to *available* when stale — uniform for tasks, epics, proposals, at ANY status including not-started. This campaign builds the engine + observability; it does not flip auto-reclaim on by default.

## Non-negotiable invariants (apply to every phase)
- **Fail-safe-to-live:** any ambiguity (missing lease row, legacy data, clock skew) → treat as *live*, never reclaim.
- **Self-stale authz rule:** when the *holder's own* lease has lapsed, a write must **renew, never 409**. Liveness is enforced **only against other agents**.
- **No claim queue** (unlike merge-lock — contention resolves by picking other work).
- **No new scheduler:** sweeps are **opportunistic-on-read** (merge-lock `sweepExpired` parity); the server has no in-process scheduler and this campaign adds none.
- **Accountable:** every actual reclaim writes one **audit row** + emits one **SSE event**.
- **Naming:** the new table is **`claim_leases`** (NOT `claims` — avoid collision with existing `agent_claims`).
- **Green every commit:** `pnpm test` 10/10, `pnpm typecheck` 6/6, `pnpm lint` 0 errors.

## Prior art to mirror (read, don't reinvent)
- `packages/server/src/services/merge-lock.service.ts` — `sweepExpired` (opportunistic), `heartbeat`, lease TTL, atomic claim, identity-masked view.
- `packages/server/src/services/claim-helpers.ts` — `assertClaimOk`, `deriveClaimStatus`, `forceClaim` (audit-in-txn + emit-after-commit pattern).
- `packages/server/src/services/agent-pool.service.ts` — the (dead) `reclaimStaleTasks`/`cleanExpiredClaims` to remove/repoint.
- `train_state` / `integrator_health` (schema.ts) — on-read staleness + edge-trigger latch precedent.

## Phases

### P1 — Shared types + `claim_leases` schema + migration (no behavior change)
- `@pm/shared`: lease mode enum (`off | shadow | on`, default `shadow`), lease config defaults (TTL, grace), audit action `claim_reclaimed`, SSE event name `claim.lease.reclaimed`, any lease view/type. (No `claim_state` reader enum — that's C3.)
- `schema.ts`: add `claim_leases` table — `id`, `entityType`, `entityId`, `holderId` (FK users, SET NULL), `claimedAt`, `heartbeatAt`, `expiresAt`, `lastActivityAt`, `sessionId?`, `createdAt`, `updatedAt`. Unique index `(entityType, entityId)`; index for sweep (e.g. `(entityType, expiresAt)`).
- Generate migration (`pnpm --filter @pm/server db:generate`).
- **Verify:** typecheck + migration applies in an in-memory DB test; enums/consts exported.

### P2 — `claim-lease.service.ts`: lease lifecycle + opportunistic sweep (pure mechanics)
- `acquireLease` / `renewLease` / `readLease` / `deriveLiveness(now, ttl, grace) → live|stale` / `sweepStaleClaims(opts)` modeled on `merge-lock::sweepExpired`.
- Reclaim path (mode `on`): clear holder pointer (`assigneeId`/`claimedBy`) + close/delete lease + write audit row (`claim_reclaimed`, in-txn) + emit `claim.lease.reclaimed` (after commit). Mode `shadow`: compute + emit observe-only signal, **do not** clear. Mode `off`: inert.
- Fail-safe-to-live throughout; config (mode/TTL/grace) read from a single source.
- **Verify:** unit tests — acquire/renew/expire; sweep frees stale (mode on); never frees live (grace + fail-safe); shadow observes without acting; audit + SSE on reclaim.

### P3 — Wire renew-on-action + self-stale rule into `assertClaimOk`; lease creation on claim/start/pick
- `assertClaimOk` becomes liveness-aware: renew the holder's lease on every AI write; **self-stale → renew, never 409**; reject only an *other* live holder.
- Create/refresh a lease on `claimTask`/`claimEpic`/`claimProposal`/`startTask`/`pickNextTask`.
- Wire opportunistic `sweepStaleClaims` at the top of claim + pick read paths (merge-lock idiom).
- **Verify:** unit tests — holder writes after own lease lapsed → renew, never 409; claim creates a lease; any action renews; sweep runs opportunistically on pick/claim.

### P4 — Reclaim completeness (epics + proposals + not-started) + remove dead code + audit/SSE finalize
- Generalize reclaim to epics + proposals + **not-started** work (the headline gap); remove dead `cleanExpiredClaims`/`reclaimStaleTasks` (or repoint to the new sweep).
- Register `claim_reclaimed` in `AUDIT_ACTIONS` + target types; register the SSE event in the event bus + listeners.
- **Verify:** unit tests — sweep frees a stale **not-started epic** + a stale proposal (mode on); each reclaim writes exactly one audit row + emits SSE; live never freed.

### P5 — Seal: config surfacing + e2e + docs + full suite ✅ DONE (2026-06-06)
- Surface lease config (mode/TTL/grace) — default **shadow/long-grace**; document the shadow→on discipline (on is C1-gated, next campaign).
- End-to-end test of the full lease flow; CLAUDE.md note + design doc stub.
- **Verify:** full `pnpm test` 10/10, `pnpm typecheck` 6/6, `pnpm lint` 0 errors; working tree committed.

## Out of scope (later campaigns)
- `claim_state` reader enum + surfacing in list/get/my-work/awareness, pick-next skip-live/reclaim-stale behavior, web badges (**C3**).
- Stable worker identity / turning auto-reclaim `on` by default (**C1** gates the `on` flip).
- Transparent client/MCP heartbeat (deferred late C2 add — only if quiet-gap false-reclaims observed; not in this pass).
