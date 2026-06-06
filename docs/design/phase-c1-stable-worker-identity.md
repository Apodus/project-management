# Campaign C1 — Stable worker identity

Status: **shipped** (2026-06-06). Stable worker identity is the safety precondition for C2's
auto-reclaim `on` flip; C1 makes that flip safe but does **not** flip it (operator decision — C2 still
ships in `shadow`). Independent safety fix of the claim-liveness/heartbeat vision
(`roadmaps/vision-20260606-claim-liveness-heartbeat.md`, C1, tier A); roadmap
`roadmaps/roadmap-20260606-1739-c1-stable-worker-identity.md`.

## 1. Motivation

A pool worker had **no durable identity**. `claimAgent(pool, secret)` grabbed *any* free agent from the
pool and minted a fresh token, so every reconnect / reboot / MCP token refresh allocated a **new
`users` row** — the client's `_claimedUserId` was in-memory only and churned on each reconnect. This is
the documented reconnect-strand incident (`project-force-claim`, the "Worker 1 → Worker 3" failure):
when a worker reconnected mid-work it became a *different* identity, so every in-flight claim stranded
under the dead `users` row, and the new identity got a spurious `409 CLAIM_DENIED` trying to re-claim or
complete its own work. The only recovery was a human `forceClaim`. C2's lease engine keys liveness to
`users.id` and **strands at exactly the same seam** — worse, a naive lease could *false-reclaim*
live-but-reconnected work when the same human-driven worker comes back under a new id. Identity
stability is therefore the safety prerequisite for turning C2 auto-reclaim `on`.

## 2. The binding model

A worker presents a durable **worker key** alongside the pool secret. The extended
`claimAgent(poolName, poolSecret, workerKey?)` (`agent-pool.service.ts`) resolves `(pool, workerKey)` to
a single `users` row: the **first** keyed claim picks a free agent and writes a keyed binding; every
subsequent claim for the same tuple **reuses** that same agent and merely refreshes its token. The
binding lives in the existing `agent_claims` table — **migration 0022** adds `worker_key` and
`worker_key_pool_id` (the binding is scoped per pool, so the same key in two pools is two distinct
identities) plus a `bind_handle` (a stable opaque handle returned on every (re)bind so the client can
assert continuity). The whole keyed resolution runs in a single transaction.

**Keyed exclusion (the reservation rule).** A keyed binding is **reserved for its worker forever** and
is excluded from the free pool: the candidate-selection query skips any agent whose `agent_claims` row
has a non-null `worker_key`, regardless of that row's `expires_at`. Consequently neither a **keyless**
claim nor **another key's first-bind** can ever grab a keyed worker's slot — even after the keyed
worker's claim TTL has lapsed. (The keyless GC that prunes expired claims deletes only
`worker_key IS NULL` rows, so it never reaps a reserved binding.) `available_count` likewise discounts
keyed-bound agents so the pool never over-reports capacity.

## 3. Keyless back-compat + no impersonation

The change is **opt-in and additive**. When `workerKey` is absent, `claimAgent` degrades to the exact
pre-C1 behavior: grab any free agent, mint a fresh token, prune expired keyless claims — byte-identical
to today. Static `PM_API_TOKEN` users are **not** pool workers and already have a stable identity, so
the bind path is a no-op for them. **No impersonation:** the worker key only takes effect *paired with a
valid pool secret* — a wrong/absent secret is rejected (401) and writes no binding row — so a key can
never be used to bind to another worker's identity, and a key is meaningless without the secret it is
scoped to.

## 4. Client (MCP) integration

The MCP client (`api-client.ts`) reads `PM_WORKER_KEY` (trimmed; empty → unset) and threads it through
`claimAgent(poolName, poolSecret, workerKey?)` on every (re)connect, so a reconnect re-binds the SAME
`users` row and refreshes the token instead of grabbing a new agent. The server's stable `bindHandle`
is carried on the wire for honesty but is **unconsumed** by the client — rebinding keys on the
`workerKey` itself, so a stable `PM_WORKER_KEY` is sufficient. On process shutdown the cleanup path
**skips the pool release** when `PM_WORKER_KEY` is set: the binding is durable by design, and releasing
it would defeat the whole point (the next process must re-bind the same identity). Keyless workers
retain the legacy release-on-shutdown behavior.

## 5. Force-claim preserved

Stable identity *reduces accidental strands*; it does **not** remove the audited break-glass. A genuine
cross-worker handoff still goes through `forceClaim` (shipped 2026-05-31, reason-required, one audit
row). The composition is the load-bearing seal: a human or another agent can force-claim a task held by
a keyed-stable worker; the displaced worker, on its next reconnect, **re-binds to the same `users` id**
(identity survives the takeover) yet is **still correctly gated** off the taken work — a write by the
stable-but-displaced identity gets `409 CLAIM_DENIED`, exactly as force-claim intends.

## 6. The C2 gate (unblocks the `on` flip, does not flip it)

C2's lease engine ships in `shadow` and its auto-reclaim **`on`** mode is **C1-gated**: an identity that
churned per session would present as a new holder each reconnect and be wrongly reclaimed. With C1
landed, a reconnected worker is the same id, so the `on` flip is now **safe** — but C1 deliberately does
**not** perform it. Flipping `PM_LEASE_MODE=on` (after observing zero wrongful lapses in `shadow`)
remains an explicit operator decision.

## 7. Out of scope (deferred)

- **The C2 `on` flip itself** — C1 makes it safe; the operator turns it on (shadow → observe → on).
- **C3** — first-class `claim_state` surfacing in reads/UI, pick-next liveness behavior, stale-claim
  badges and alerts.
- **A transparent client/MCP heartbeat** — an out-of-band keepalive for long *quiet* gaps (deferred
  late-C2 add; renew-on-action covers the dominant case).
