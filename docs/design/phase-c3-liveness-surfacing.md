# Campaign C3 — Liveness surfacing + handoff + alerts

Status: **shipped** (2026-06-06). Third campaign of the claim-liveness/heartbeat vision
(`roadmaps/vision-20260606-claim-liveness-heartbeat.md`). Hard-depends on C2 (the lease spine) and is
made safe-to-turn-`on` by C1 (stable worker identity). This campaign does **not** flip `PM_LEASE_MODE`
— the lease still ships in `shadow` (operator decision).

## 1. Motivation

C2 made a claim a **lease** that knows whether its holder is alive — but the signal was invisible. An
agent picking work still relied on dangerous proxies (status/assignment), so it would double-pick a
silently-dead holder's epic or skip a free one; a human still hand-surveyed "which assigned epics are
actually dead." C3 surfaces the lease's live/stale signal **everywhere a decision is made** (agent +
operator), makes pickup act on it, alerts on stale work, and adds a clean, audited handoff.

## 2. `claim_state` — the identity-masked liveness view (P1)

A first-class `claim_state` enum in `@pm/shared` (`unclaimed | live | stale | yours`), computed by
`deriveClaimState(holderId, lease, now, caller)` (`claim-helpers.ts`):

- no holder → `unclaimed`
- caller IS the holder → `yours` (BEFORE liveness — a self-stale lease still reads `yours`)
- held by another, lease stale (`now > expiresAt + grace`) → `stale`
- held by another, lease live / absent / unparseable → `live` (**fail-safe-to-live**: a claimed
  entity with no lease row — the common case in default shadow mode — reads live, never stale)

It returns the enum only, **never the holder id** (identity-masked, like the existing
`deriveClaimStatus`). The lease is read on the get path (single `readLease`) or pre-fetched on the list
path (`readLeasesFor`, one batched query — no N+1); a missing key ⇒ no lease ⇒ fail-safe-to-live.

## 3. Read-surface threading (P1–P4)

`claim_state` is threaded through every read used to decide pickup and surfaced for humans:

- **REST + MCP:** `pm_list_epics` / `pm_get_epic` / `pm_list_tasks` / `pm_get_task` /
  `pm_get_my_work` / `pm_awareness_check`, rendered as agent-friendly text ("live (actively worked)",
  "stale (claim lease lapsed — may be abandoned)", "yours (you hold this)", "unclaimed (free to pick
  up)"). The MCP render is masked — it never interpolates a holder id.
- **Web:** liveness badges on the board, epic views, and the roadmap canvas (a stale affordance the
  human can act on).

## 4. Pickup behavior (P3)

`pm_pick_next_task` acts on `claim_state` rather than the old proxies:

- **skip live** — a live-claimed candidate is not picked.
- **reclaim-then-claim stale** (mode `on`) — a stale candidate is atomically reclaimed and claimed
  using the merge-lock idiom (`WHERE holder IS NULL OR lease expired` + `changes === 0` race check), so
  two agents racing on the same stale item produce **exactly one winner**.

Pickup uses the same staleness boundary the sweep uses (TTL + grace), so a just-lapsed lease isn't
grabbed mid-action.

## 5. Stale-claim alert (P5a)

An edge-triggered alert (`claim.stale_alert`, `claims-health.service.ts`) fires when a project has
work claimed-but-inactive past the lease TTL + grace. It is **edge-triggered** (once per stale episode,
latched on the `claims_alert_state` table, re-arming on resolution — `train.stuck` parity) and
delivered BOTH in-app (SSE banner) AND out-of-band to Discord (`settings.webhooks.discord_url`). The
payload is **identity-masked**: an aggregate stale count + the oldest-stale age, never a holder id.
(Shipped in P5a, commit `2e7de2e`.)

## 6. Handoff semantics (P5b)

Two handoff primitives compose a shared **audited-transfer core**, `performClaimTransfer`
(`claim-helpers.ts`), extracted out of `forceClaim`. The core does ONLY the parts identical across
every handoff: the terminal guard + the txn (clear old holder, set new holder, **ONE `force_claim`
audit row**) + after commit the domain event + `audit.recorded` + the lease transfer to the new holder
(`acquireLease(target)`). It performs **no authz** — each caller applies its own gate first. The audit
action is reused (`force_claim`) for all handoffs — the `reason` carries the handoff intent — so no
audit-enum change was needed.

| Primitive          | Authz                                                                 | Behavior                                                                                                                      |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `release-to`       | a human always; an AI agent **only if it holds the claim**            | Transfer to a **required, real** target worker. This is the load-bearing case `forceClaim` could NOT serve — its `target !== actor.id && !human → 403` gate would reject an AI holder handing off to another named worker. |
| `request-takeover` | any authenticated caller                                              | **stale** → auto-grant to the requester (self-target transfer via the core; atomic, one winner on a race). **live** → **NO mutation** (the cardinal invariant) — emit `claim.takeover_requested` to notify the holder, return `notified_holder`. **unclaimed** → `not_held` (call claim). **yours** → `already_claimed_by_you` (no-op). |

REST: `POST .../{tasks|epics|proposals}/{id}/release-to` (body `{reason, targetId}`) +
`.../{id}/request-takeover` (body `{reason}`), mirroring the force-claim route shape, authz, and error
envelopes. MCP: `pm_release_task/epic/proposal_to` (id, reason, target) + `pm_request_takeover_*` (id,
reason), with identity-masked renders (never leak a holder id). A new `claim.takeover_requested` SSE
event (auto-forwarded via `onAll`) carries an identity-masked payload (`actorId` = the requester,
`entity` = null — no holder id). A new shared result status `notified_holder` (`ok:false`) was added to
`CLAIM_RESULT_STATUSES`.

## 7. Invariants

- **Never stomp a live claim.** `request-takeover` mutates ONLY a stale claim; a live claim is left
  untouched and the holder is merely notified. This is the campaign's cardinal invariant.
- **Identity-masked everywhere.** `claim_state`, the stale-claim alert, the takeover notification, and
  every MCP render carry an enum / aggregate — never a holder id.
- **One audit row per handoff**, with an honest `before`/`after` holder, written in the same txn as the
  holder change.
- **Lease moves with the claim.** Every transfer re-points the lease to the new holder so the displaced
  holder's lease never lingers.
- **Fail-safe-to-live** (inherited from C2): a missing/unparseable lease reads live, never stale.
- **No mode flip.** The arc does not change `PM_LEASE_MODE`; the lease still ships in `shadow`.

## 8. Out of scope (deferred)

- **The `PM_LEASE_MODE=on` flip** — an operator decision. C1 made it safe; C3 surfaces the signal but
  leaves the lease in `shadow`.
- A **task-graph mini-DAG liveness badge** (parked).
- A **transparent heartbeat** channel (an explicit out-of-band keepalive distinct from
  renew-on-action) for long-running silent holders.
- A distinct `release_to` audit action (reusing `force_claim` keeps the audit enum stable; the reason
  carries intent).
