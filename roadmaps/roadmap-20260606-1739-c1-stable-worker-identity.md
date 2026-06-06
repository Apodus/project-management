# Campaign C1 — Stable Worker Identity

**Parent vision:** `roadmaps/vision-20260606-claim-liveness-heartbeat.md` (C1, tier A — independent safety fix; concurrency-eligible with C2/C3; unblocks C2's safe `on` flip).
**Branch:** `campaign-claim-liveness-c1-c3` (C1 first, then C3 on the same branch).
**Base:** main @ aae1bbd (C2 shipped: claim-lease engine, shadow default).

## Goal
A worker re-binds to the **same `users` row** across reconnect / reboot / token refresh, via a durable **worker key** — so claims (and their C2 leases) never strand under a dead identity, and the new identity never gets `409 CLAIM_DENIED` on re-claim/complete. This is the deferred root cause from `project-force-claim` (the Worker 1→Worker 3 reconnect incident). It is the safety precondition for turning C2 auto-reclaim `on` (a stable identity prevents false-reclaiming live-but-reconnected work).

## Non-negotiable invariants (every phase)
- **Stable identity:** same (pool, worker key) → same `users` row, every (re)connect. A reconnect refreshes the token, it does NOT allocate a new agent.
- **No impersonation:** the worker key only takes effect paired with the valid pool secret; it can never be used to bind to another worker's identity.
- **Back-compat:** static `PM_API_TOKEN` users (non-pool) already have stable identity — the bind path must no-op for them. Existing `claimAgent(pool, secret)` callers without a key keep working (degrade to today's behavior).
- **Shared-host safe:** two distinct worker processes on one host + one pool derive/get DISTINCT stable identities (no collision); a key collision falls back to allocate-new rather than mis-binding.
- **Force-claim preserved:** genuine cross-worker handoff via `forceClaim` still works (stable identity reduces accidental strands; it does not remove the break-glass).
- **Green every commit:** `pnpm test` 10/10, `pnpm typecheck` 6/6, `pnpm lint` 0 errors.

## Prior art / files to read
- `packages/server/src/services/agent-pool.service.ts` — `claimAgent(poolName, poolSecret)` (grabs any free agent → token), `agent_claims` lease (1h TTL + heartbeat), `releaseAgent`/`heartbeat`.
- `packages/mcp-server/src/api-client.ts` — `claimAgent`/`_claimedUserId` (in-memory only, churns on reconnect), token handling, reconnect path.
- `packages/server/src/db/schema.ts` — `users`, `agent_pools`, `agent_claims`.
- `project-force-claim` memory (the incident + the deferred root-cause framing).

## Open design question (commander resolves per vision rule)
Worker-key shape: client-derived `{pool, machine, slot}` vs worker-supplied stable id vs **server-issued durable handle**. Vision rule: pick what survives a process restart on a shared host without collision and pairs with the pool secret; **prefer the server-issued durable handle if client persistence proves unreliable.** The P1 Plan leg proposes; verify scrutinizes; commander decides.

## Phases (~3)

### P1 — Server-side stable worker binding
- Decide + implement the binding mechanism: a `bindWorker`/extended-`claimAgent` server path that, given (poolName, poolSecret, workerKey), resolves to the SAME `users` row — creating it once, reusing + refreshing its token thereafter. Choose the key storage (column on `users`, a `worker_bindings` table, or reuse `agent_claims`) + migration if needed (hand-author; `db:generate` is broken repo-wide).
- **Verify:** server unit tests — same (pool,key) → same userId across repeated binds; distinct keys → distinct identities; wrong/absent pool secret rejected; key collision falls back safely; back-compat (keyless `claimAgent` unchanged).

### P2 — MCP client persists + presents the worker key
- `api-client.ts`: derive/persist a durable worker key and present it on (re)connect so reconnect re-binds the SAME `users` row + refreshes the token, instead of grabbing a new agent. Remove the in-memory-only `_claimedUserId` churn (or back it with the persisted key).
- **Verify:** tests — reconnect re-binds the same `userId`; an in-flight claim survives a reconnect with no `CLAIM_DENIED` (the headline regression for the Worker 1→Worker 3 incident).

### P3 — Seal: shared-host distinctness + back-compat + force-claim + docs + full suite
- Prove two workers on one host/pool get distinct stable identities; static-token users no-op; force-claim still works for a genuine handoff. Docs: CLAUDE.md note + design-doc stub; note that C1 unblocks the safe C2 `on` flip (but does NOT flip it — operator decision). Update vision/roadmap status.
- **Verify:** full `pnpm test` 10/10, typecheck 6/6, lint 0, build 5/5; tree committed.

## Out of scope
- Flipping C2 `PM_LEASE_MODE` to `on` by default (operator decision; C1 only makes it safe).
- The C3 surfacing work (claim_state in reads, pick-next behavior, badges).
- Transparent client/MCP heartbeat (deferred late C2 add).
