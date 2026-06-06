# Campaign C3 — Liveness Everywhere a Decision Is Made

**Parent vision:** `roadmaps/vision-20260606-claim-liveness-heartbeat.md` (C3, tier A — the user-visible win; hard-depends on C2).
**Branch:** `campaign-claim-liveness-c1-c3` (continues after C1; base contains C2 + C1).
**Depends on:** C2 (claim-lease engine — `claim_leases`, `deriveLiveness`, `sweepStaleClaims`, shadow default) + C1 (stable worker identity — makes safe reclaim possible).

## Goal
Replace the dangerous proxies (0/n complete, in_progress status) with a first-class **`claim_state`** (`unclaimed | live | stale | yours`) surfaced on every read an agent uses to decide pickup, make the pickup tools act on it, and give the human director stale-claim visibility + clean handoff. This is what lets agents tell, *without a shadow of a doubt*, whether a claimed work item is actively worked — and lets the human see hanging work at a glance.

## Non-negotiable invariants (every phase)
- **`claim_state` derives from the C2 lease** (`deriveLiveness` over `claim_leases`), never from completion/status proxies. Fail-safe-to-live: ambiguity → `live`.
- **Identity-masked:** never leak another agent's raw `users.id` in a read surface (mirror the merge-lock view: `you` / `someone_else` / `none`). `claim_state` exposes live/stale/yours/unclaimed, not who.
- **Self-stale preserved:** a holder is `yours` even if its own lease lapsed (the C2 self-stale rule) — never shown as reclaimable-from-you.
- **Shadow-respecting pickup:** pick-next always SKIPS a `live`-claimed item (safe, read-only). Reclaim-then-claim of a `stale` item is a deliberate foreground takeover — gate/behave per the lease mode + the atomic claim idiom (`WHERE holder IS NULL OR lease expired` + `changes===0`); never stomp a `live` lease.
- **Accountable handoff:** `release-to` / `request-takeover` compose the audited `forceClaim` (one audit row), never a silent transfer.
- **Green every commit:** `pnpm test` 10/10, typecheck 6/6, lint 0.

## Prior art / files to read
- `packages/server/src/services/claim-helpers.ts` — `deriveClaimStatus` (to supersede with `deriveClaimState`), `assertClaimOk`, the masked-view pattern.
- `packages/server/src/services/claim-lease.service.ts` — `deriveLiveness`, `readLease`, `sweepStaleClaims`.
- `packages/server/src/services/{task,epic,proposal}.service.ts` — the list/get view builders; `pickNextTask`; `awareness`.
- `packages/mcp-server/src/tools/{tasks,agent,workflow,write}.ts` — `pm_list_*`/`pm_get_*`/`pm_get_my_work`/`pm_awareness_check`/`pm_pick_next_task` renders.
- `packages/server/src/services/merge-lock.service.ts` — the identity-masked view + atomic-claim idiom.
- `train_state` `*_notified` latch + Discord webhook (`settings.webhooks.discord_url`) — the edge-triggered alert precedent (7.4).
- `packages/web/src/pages/*` — board / roadmap / epic views for badges.

## Phases (~5)

### P1 — `claim_state` enum + `deriveClaimState` + read-surface threading (server + shared)
- `@pm/shared`: `CLAIM_STATES = unclaimed | live | stale | yours` (+ type). `deriveClaimState(holderId, lease, now, caller)` in claim-helpers (supersedes/augments `deriveClaimStatus`), computed from the C2 lease + caller identity, identity-masked, self-stale→`yours`.
- Thread `claim_state` into the list/get view builders for tasks + epics + proposals + `pm_get_my_work` source + `awareness` (server-side). Keep `claim_status` if other consumers need it, or migrate cleanly.
- **Verify:** unit tests — live lease→`live`; lapsed→`stale`; caller-is-holder→`yours` (even if lapsed); no lease/unclaimed→`unclaimed`; never leaks holder id.

### P2 — MCP renders surface `claim_state`
- `pm_list_epics`/`pm_get_epic`/`pm_list_tasks`/`pm_get_task`/`pm_get_my_work`/`pm_awareness_check` render human-readable liveness ("live · heartbeat 2m ago" / "stale · last seen 3d ago" / "yours" / "unclaimed"), identity-masked.
- **Verify:** mcp tests — renders show the right state; no raw id leak.

### P3 — pickup acts on liveness + awareness live/stale
- `pm_pick_next_task` SKIPS `live`-claimed; for a `stale` item, atomically reclaim-then-claim (merge-lock idiom + the lease-mode discipline). `pm_awareness_check` reports live vs stale in-flight (not bare status).
- **Verify:** unit tests — pick skips live, takes stale atomically (two racers → one wins); awareness distinguishes live/stale; barely-stale margin so a just-lapsed lease isn't grabbed mid-action.

### P4 — Web badges (board / roadmap / epic)
- Surface `claim_state` visually on the board, roadmap, and epic views (a "stale" affordance distinct from "live"/"yours"/"unclaimed"). Reuse the API `claim_state` from P1; regenerate web API types.
- **Verify:** typecheck + a component/e2e check that a stale-claimed item renders the stale affordance.

### P5 — Stale-claim alert + handoff + seal
- Edge-triggered **stale-claim alert** (in-app SSE banner + Discord webhook) via a `*_notified` latch (mirror `train_state.stuckNotified`), past a grace threshold.
- **Handoff** primitives: `release-to` (hand a claim to a named worker) + `request-takeover`, composing the audited `forceClaim`.
- Docs (CLAUDE.md note + design stub) + vision/roadmap status. Full suite green.
- **Verify:** one alert per stale episode (edge-triggered, re-arms); `release-to` transfers with an audit row; full `pnpm test` 10/10, typecheck 6/6, lint 0, build 5/5; committed.

## Out of scope
- Flipping `PM_LEASE_MODE` to `on` by default (operator decision; C1 made it safe).
- Transparent client/MCP heartbeat (deferred late-C2 add).
- Claim queues (vision-parked; contention → pick other work).
