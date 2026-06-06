# Campaign C2 — The claim lease engine

Status: **shipped** (2026-06-06, ships in `shadow` mode with a long 24h grace).
First campaign of the claim-liveness/heartbeat vision
(`roadmaps/vision-20260606-claim-liveness-heartbeat.md`); roadmap
`roadmaps/roadmap-20260606-1413-c2-claim-lease-engine.md`.

## 1. Motivation

A claim was a permanent grab: an AI agent claims a task/epic/proposal, sets the holder pointer
(`assigneeId`/`claimedBy`), and that claim sits forever — even after the agent crashes, its session
dies, or it silently walks away. A dead holder's work is **frozen**: no other agent can pick it up
(non-holder writes 409), and there is no signal that the holder is gone. The only recovery was a human
`force_claim`. The merge train already solved the equivalent problem for merge locks with a TTL +
opportunistic reclaim; claims needed the same liveness layer.

## 2. The lease model

A claim becomes a **lease**: one row per `(entity_type, entity_id)` in `claim_leases`
(migration 0021) carrying `holderId`, `claimedAt`/`heartbeatAt`/`lastActivityAt`, and a TTL-derived
`expiresAt`. The lease is a **liveness sidecar**, not a replacement: the entity's
`assigneeId`/`claimedBy` remains the human-facing holder pointer, and the lease tracks whether that
holder is still alive. Lifecycle primitives (`claim-lease.service.ts`): `acquireLease`
(create-or-overwrite, idempotent over the unique index — mirrors `merge-lock.getOrCreateLock`),
`renewLease` (holder-guarded heartbeat), `deleteLease` (teardown for release/terminal/unassign), and
`readLease` + `deriveLiveness` (on-read liveness from `expiresAt` + grace).

## 3. Renew-on-action + self-stale

There is **no separate heartbeat call** in v1 — every claimed write *is* the heartbeat. Each
claimed-entity mutation flows through the liveness-aware `assertClaimOk`, which, for the holder's own
write, **renews the lease forward** (`expiresAt = now + TTL`). The consequence: a holder is **never
409'd for its own stale lease** (self-stale → renew; a lapsed-but-not-yet-swept lease self-heals on the
holder's next action, and a legacy holder with no lease row gets one created). Only a *different* agent
is gated — and only that gate produces a 409. Human writes neither require nor create a lease.

## 4. Opportunistic sweep + reclaim accountability

Reclaim is an **opportunistic on-read sweep** (`sweepStaleClaims`), piggybacked on the claim/pick
paths — **merge-lock parity: no scheduler, no background thread**. A lease is a reclaim candidate once
`now > expiresAt + grace`; `deriveLiveness` re-checks the precise boundary per candidate. The sweep is
governed by a three-position mode:

- **off** — inert (early return; byte-identical to pre-C2).
- **shadow** — DETECT only: lapsed leases are recorded in `observed`, but nothing is cleared, deleted,
  audited, or emitted. The safe-rollout rung.
- **on** — RECLAIM: each lapsed lease runs an atomic reclaim txn (clear the entity holder + delete the
  lease under a holder guard + write the audit row, all-or-nothing — a concurrent renew that re-arms
  the lease aborts the reclaim cleanly), and the domain event + `audit.recorded` fire after commit.

Reclaim is fully accountable: each `on` reclaim writes **exactly one `claim_reclaimed` audit row**
(append-only, honest `before`/`after` holder) and emits **exactly one `claim.lease.reclaimed` SSE
event**. The reclaim txn shape deliberately mirrors `forceClaim` (`claim-helpers.ts`).

## 5. Config + the shadow → on discipline

Three env knobs (with `@pm/shared` defaults as the canonical fallback): `PM_LEASE_MODE`
(`off`/`shadow`/`on`, default **`shadow`**), `PM_LEASE_TTL_SEC` (default 1800 = 30m), and
`PM_LEASE_GRACE_SEC` (default 86400 = 24h). An unset / non-numeric / non-positive seconds value falls
back to the default; an unrecognized mode warns-and-continues to `shadow`. When the env is unset the
behavior is byte-identical to the pre-config posture.

The rollout discipline is **shadow → observe zero wrongful lapses → on**. The campaign ships in
`shadow` with a deliberately **long (24h) grace** so the engine is observed before it governs.
**`on` is C1-gated**: stable worker identity is the precondition. An agent whose id churns per session
would present as a new holder each session and be wrongly reclaimed; C1 (identity) must land before
`on` is safe.

## 6. Invariants

- **Fail-safe-to-live.** A null/unparseable `expiresAt`, a misconfigured knob, or a lease pointing at
  a vanished entity (or an entity with a null `projectId` that cannot be audited) is **never**
  aggressively reclaimed — the bias is always toward leaving a live claim alone.
- **No queue.** A reclaim frees the holder; it does not promote a waiting claimant. The next agent
  claims through the normal path.
- **No scheduler.** Reclaim is strictly on-read (claim/pick), exactly like merge-lock reclaim.
- **Main / work safety.** The lease never touches merge-train state; clearing a holder loses no work
  (the entity and its history are untouched, only the holder pointer is cleared).

## 7. Out of scope (deferred)

- **C3** — a first-class `claim_state` surfaced in the API/UI (liveness badges, stale-claim views).
- **C1** — stable worker identity and the automatic flip to `on` (this campaign ships the mechanism in
  `shadow`; the auto-on switch is gated on identity).
- A **transparent heartbeat** channel (an explicit out-of-band keepalive distinct from
  renew-on-action) for long-running silent holders.
