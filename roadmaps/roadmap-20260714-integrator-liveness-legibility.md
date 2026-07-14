# Campaign — Integrator liveness legibility (agent-facing stall self-diagnosis)

**Date:** 2026-07-14
**Tier:** A (fixes a recurring, expensive human-in-the-loop failure — agents misdiagnosed the train state 3× in days)
**Proposal:** `01KXFVW6XMQB5DH1X8QX834GTK` (project-manager) — director directed "draft and run".
**Goal:** an agent looking at a stalled merge train can **self-diagnose** it — distinguish "integrator down (restart it)" from "integrator alive, slow verify (wait)" from "gitlink assembly drain (fix the branch)" — from the tools it already calls, without a human relay.
**Branch:** `campaign-integrator-liveness-legibility` off `main`, in a dedicated git worktree.
**Builds on:** Phase 7.4 (`integrator_health` heartbeat + on-read staleness + `train.integrator_unhealthy` alert) — this campaign SURFACES that existing signal on the agent-facing path; it does not re-mechanize it.

## The gap (observed live, game_one, 2026-07-13/14)

Agents are handed a point-in-time snapshot (`holder: none`, `queue: 0`, `last landed <old>`, `batch drained with no land`, a request at `0 attempts`) that cannot distinguish three different situations:

| What the agent sees | Could actually be | Right action |
|---|---|---|
| free lock + queued + nothing landing | integrator **crashed/down** | restart the daemon |
| lock held + lease advancing, no progress | integrator **alive, slow verify** | wait |
| `batch drained with no land`, 0 attempts | **gitlink assembly drain** | fix the branch |

They cannot tell these apart because **integrator liveness is never surfaced on the tools they call** (`pm_get_merge_lock`, `pm_list_merge_requests`, `pm_get_merge_request`), and no MCP tool exposes health. Yet the signal EXISTS: Phase 7.4's `integrator_health` (migration 0013) carries `lastSeenAt` + status + version, the daemon POSTs a heartbeat regardless of lock-holding, `GET .../integrator/health` computes on-read staleness, and `train.integrator_unhealthy` is an edge-triggered alert. It's a **surfacing gap**, not a missing mechanism. Most recent cost: a daemon crashed overnight, a verified fix sat unprocessed 12h, and the agent concluded "infrastructure stall" from a snapshot that equally fit a slow verify or a gitlink drain.

## Design (settled — additive, read-path only)

1. **Liveness on the agent-facing lock + merge-request reads.** Reuse the health service's on-read staleness to attach an integrator liveness block — `{ status: "alive" | "stale" | "down", last_heartbeat_age_sec, version, lane_status: "idle" | "integrating" }` — to the merge-lock read and the merge-request(s) reads. Thresholds reuse the existing health staleness cutoff (do NOT invent a second one).
2. **Stall-correlation hint (the decisive win).** When a lane has a `queued` request with `0 attempts` AND the integrator heartbeat is stale/absent, surface an explicit actionable line: *"integrator appears DOWN (no heartbeat for Ns) — the queue is not being consumed; restart the daemon."* Distinguish the alive-but-busy case: *"integrator healthy, actively integrating <branch> — verify in progress."*
3. **A health MCP tool.** `pm_get_integrator_health` (thin wrapper over the existing endpoint) + cross-reference it from the merge-lock/merge-request tool descriptions so an agent can query liveness directly.
4. **Enrich the abandon reason.** `batch drained with no land` (`batch.ts:1377`) should name *why* it drained where determinable (gitlink assembly failure / verify failure / etc.).

## Safety / invariants

- **Read-path + messaging only.** No change to how the train lands or verifies. No new persistence — `integrator_health` already exists; NO migration.
- **Reuse, don't fork, the staleness computation** (Phase 7.4 §3.4 on-read staleness) — one source of truth for "stale."
- **Additive wire.** New fields are added to read responses; existing fields/consumers are untouched (assert byte-identity where "unchanged").
- **Fail-safe.** If `integrator_health` has no row for a lane (never heartbeated), surface `status: "down"/"unknown"` — never crash the lock/request read.

## Scope

**In:** server merge-lock + merge-request read services/routes (attach liveness + stall hint, reusing health.service); a `pm_get_integrator_health` MCP tool + liveness rendering in the lock/request MCP tool outputs; `batch.ts` abandon-reason enrichment; seals + docs.

**Out (non-goals):** a daemon supervisor/auto-restart (game_one launcher-side ops — this campaign lets an agent *know* a restart is needed, not perform it); any change to land/verify behavior; reworking the 7.4 health mechanism; web dashboard (7.4 already covers the human dashboard — this is the AGENT surface).

## Verification

Server unit/integration tests for the derived liveness + the stall-correlation predicate (stale heartbeat + queued 0-attempt → DOWN hint; fresh heartbeat + integrating → healthy line; no health row → down/unknown, no crash). MCP tool-output tests. An integration seal reproducing the exact confusing snapshot and asserting it now self-diagnoses. Full existing suite green (additive wire).

## Phases (DRAFT — pending adversarial verify inside /campaign)

- **P0** — worktree + design-lock. Read `integrator_health` schema + `health.service` on-read staleness + the `train.integrator_unhealthy` edge; the merge-lock read (service/route + MCP) and merge-request(s) reads (service/route + MCP); the MCP tool output text shapes. Decide EXACTLY: the liveness field shape + where it attaches; the alive/stale/down thresholds (reuse health.service — cite the cutoff); the stall-correlation predicate; the `pm_get_integrator_health` tool shape; the abandon-reason enrichment points. Assert no migration needed. No code commit.
- **P1** — server: derive + attach the integrator liveness block on the **merge-lock read** (reuse health.service staleness) + the stall-correlation hint (stale/down heartbeat AND a queued 0-attempt request). Unit/integration tests. Additive-wire assertion.
- **P2** — server: same liveness + stall signal on **merge-request(s) reads** (`list` + `get`), so a queued 0-attempt request shows the integrator state inline. Enrich `batch.ts` `batch drained with no land` to name the drain cause where determinable. Tests.
- **P3** — MCP: render the liveness/stall fields in `pm_get_merge_lock` / `pm_list_merge_requests` / `pm_get_merge_request` tool outputs (the text agents read); add `pm_get_integrator_health`; cross-reference from tool descriptions. Regenerate openapi/web types if the REST surface changed. Tests.
- **P4** — seals + docs: integration seal (stalled-queue snapshot → actionable "DOWN, restart" hint; alive+integrating → "healthy, verify in progress"); docs (integrator-deployment.md agent-legibility note + agent guidance on reading liveness); CLAUDE.md if warranted.
- **P5** — close-out: full gate, diff-stat audit, outcomes recorded, memory.

**Watch-items for the verifier:** reuse (don't duplicate) the 7.4 staleness cutoff; no migration; the merge-lock read must not start failing when `integrator_health` has no row; additive wire (existing merge-lock/merge-request consumers byte-identical); the stall predicate must not false-positive on a healthy-but-idle lane with a legitimately-empty queue; MCP output stays parseable.

**Key files:** `packages/server/src/services/health.service.ts` (on-read staleness — reuse), `packages/server/src/routes/integrator-health.ts`, the merge-lock read (`merge-lock` service/route) + merge-request read service/route, `packages/mcp-server/src/*` (tool outputs + new tool), `packages/integrator-ref/src/batch.ts:1377`.

## Ops handoff (after merge)
1. Merge → main; `pnpm build`; redistribute the game_one bundle (`node scripts/distribute.mjs` — ships the updated MCP bundle so agents get `pm_get_integrator_health` + the richer outputs); PM-server redeploy (new read fields + tool). No migration.
2. Restart any game_one Claude sessions to pick up the new MCP bundle.
3. Separately (out of scope here): stand up a daemon supervisor/auto-restart on the game_one host so a crash no longer means a silent overnight stall.

## P0 Findings — Design-lock (settled 2026-07-14)

Design is locked. The campaign is READ-PATH-ONLY and additive; **no migration** (H). Server-side derivation so REST + MCP both inherit (C). Build order `@pm/shared` → `@pm/server` → `@pm/mcp-server`; openapi/web regeneration IS required in P3 for the additive `integrator` blocks (H).

### A. Health mechanism — reuse, don't re-mechanize
- `integrator_health` table `schema.ts:823-872`, one row per `(project_id, resource)` lane (unique index `schema.ts:870`). Heartbeat carries status idle/integrating, pool util, in-flight counts, version, `lastSeenAt` (`schema.ts:849`), `unhealthyNotified` latch (`schema.ts:854`), `lastReleaseFailure` (`schema.ts:862`).
- **Single source of truth for staleness: `HEALTH_STALE_MS = 90_000` (`health.service.ts:13`).** Do NOT invent a second threshold.
- **Reuse target: `getHealth(projectId, resource, now?)` (`health.service.ts:292-300`)** — computes `stalenessMs` + `healthy = stalenessMs <= HEALTH_STALE_MS` (`health.service.ts:110-127`); no row → `neverSeenView` (`health.service.ts:133-149`, status `"never_seen"`, healthy false — the fail-safe, never throws).
- Firing `getHealth` edge-triggers `train.integrator_unhealthy` ONCE per stale episode via the `unhealthyNotified` latch (`health.service.ts:266-284`); every `recordHeartbeat` resets it (`health.service.ts:191/:213/:240`). Precedent for on-read embedding: `metrics.service.ts:907-908`.

### B. Liveness field shape (tri-state from the ONE cutoff + row presence)
```
integrator: { status: "alive"|"stale"|"down", last_heartbeat_age_sec: number|null,
              lane_status: "idle"|"integrating"|null, version: string|null,
              stall: "integrator_down"|null }
```
Derivation: `lastSeenAt === null` → `down`; `healthy === true` → `alive`; else → `stale`.

### C. Attach points (server-side) — field-vs-sibling asymmetry (verifier amendment c)
- **merge-lock get + list:** `integrator` is a **NEW OPTIONAL FIELD ON `MergeLockView`** (`shared/src/schemas/merge-lock.ts`) — a lock is per-lane, its natural home and primary surface. Wire in `merge-lock.service.ts` `toView:287`, `getLock:556`, `listLocks:567`. Merge-lock MCP clients already unwrap `.data` containing the view → **no lock-client change needed**.
- **merge-request detail + list:** `integrator` is an **ENVELOPE SIBLING** (`{ data, pagination, integrator }` on list; a detail-extension sibling on get), **NOT** a field on the shared `mergeRequestSchema` (keep that row byte-identical — it is consumed everywhere). Wire in `merge-request.service.ts` `getById:675`, `list:624`. **Do NOT put `integrator` inside `mergeRequestSchema`.**

### D. Stall-correlation predicate — one server helper `deriveLiveness(projectId, resource, now)`
Base it in `health.service` (or a small integrator-liveness helper); consumed by all attach sites.
```
alive = getHealth(...).lastSeenAt !== null && getHealth(...).healthy
queuedZeroAttempt = EXISTS a queued merge_request for the lane with ZERO merge_attempts rows
stall = (!alive && queuedZeroAttempt) ? "integrator_down" : null
```
- **VERIFIER AMENDMENT (a): count ALL `merge_attempts` rows (ANY status), not just open/pending.** A re-queued request retains CANCELLED attempt rows (`resetToQueued:1220` → `cancelOpenAttempts` UPDATEs status→cancelled, never deletes; `merge-attempt.service.ts:310-316`), so counting all rows correctly EXCLUDES it. Counting only open attempts would re-introduce a false-positive.
- Fires on the real overnight incident (12h down + queued 0-attempt). Does NOT false-positive on a slow verify (daemon heartbeats independent of lock-holding → lane stays fresh through a 12-min verify) nor on a healthy-idle lane with an empty queue (the `queuedZeroAttempt` conjunct guards it).
- Render distinctions: DOWN → `"⚠ integrator appears DOWN (no heartbeat for Ns) — the queue is not being consumed; restart the daemon"`; alive+integrating → `"integrator healthy, actively integrating <branch> — verify in progress"`; else plain status. **Word the DOWN hint as "no heartbeat for Ns"** so an agent can judge cold-start vs crash (verifier note 2b).

### E. `pm_get_integrator_health` MCP tool
Thin wrapper over the EXISTING `GET /api/v1/projects/{projectId}/integrator/health?resource=` (`integrator-health.ts:123-148`, any authed user). api-client `getIntegratorHealth(projectId, resource="main")`; new tool `packages/mcp-server/src/tools/integrator-health.ts` registered in `tools/index.ts`; renders the derived tri-state + age + `lane_status` + version + pool + in-flight + `last_release_failure`. Cross-reference it from `pm_get_merge_lock` / `pm_list_merge_requests` / `pm_get_merge_request` descriptions.

### F. MCP client conversions (verifier amendment b — P3 obligation)
BOTH `listMergeRequests` (`api-client.ts:1376`) AND `getMergeRequest` (`api-client.ts:1395`) currently unwrap `.data` and would DROP the `integrator` sibling — both need envelope-preserving conversion (precedent: `createNote` `api-client.ts:1559`). AND two internal callers treat the list result as a bare array — `pm_request_merge` position calc (`merge-requests.ts:76-82`) + the list renderer (`merge-requests.ts:128-173`); **P3 must keep the array accessible** (e.g. return `{ requests, integrator }`) or update both call sites.

### G. Abandon-reason enrichment (`batch.ts:1370-1378`)
The lane-lock release `finally` calls `releaseLock({ reason })` → the lock's `abandonReason` (`merge-lock.service.ts:491/504`, surfaced as `Last abandon:`). Determinable at the drain from `ctx`/`batch.members`. **Locked count-level composition:**
```
admitted===0          → "batch drained with no land: no admittable request at the FIFO head (empty batch)"
ctx.rejected.length>0 → "batch drained with no land: N member(s) rejected at verify/conflict"
ctx.requeued.length>0 → "batch drained with no land: M member(s) re-queued (drift/push-race), none landed"
else                  → "batch drained with no land"
```
Optional stretch (P2): carry reject category on `ctx.rejected` for category-level naming — NOT required.

### H. No migration / regeneration
`integrator_health` (+ `unhealthy_notified` since `0013`, `last_release_failure` since `0028`) fully exists; campaign READS only, adds zero columns. **openapi/web regeneration IS required in P3** — the REST response schemas gain the additive `integrator` block (`mergeLockSchema`, merge-request detail schema, list envelope); base `mergeRequestSchema` + all request bodies stay byte-identical.

## Close-out (executed 2026-07-14, branch `campaign-integrator-liveness-legibility`, base 3a92a0c)

**Shipped in full (P0–P4), NOT yet merged/pushed.** 6 commits (P0–P4 + this close-out), 23 files, +1510/−72.

- **P0** `a255050` — design-lock (docs). Reuse `getHealth` + `HEALTH_STALE_MS = 90_000` (single source of truth); field-on-`MergeLockView` vs envelope-sibling-on-merge-request asymmetry; stall predicate; no migration.
- **P1** `589c33c` — `deriveLiveness` helper (`integrator-liveness.service.ts`) reusing `getHealth`; `integrator` block on `MergeLockView`; `stall = !alive && queued-with-ZERO-(any-status)-attempts`. 10 unit tests.
- **P2** `ffc5a6e` — liveness envelope-sibling on the merge-request list + detail reads (base `mergeRequestSchema` byte-identical); `batch.ts` enriched abandon reason (`composeAbandonReason` — empty-batch / N-rejected / M-requeued).
- **P3** `9a00609` — MCP: `renderIntegratorLiveness` in `pm_get_merge_lock` / `pm_list_merge_requests` / `pm_get_merge_request`; new `pm_get_integrator_health` tool; both merge-request clients converted envelope-preserving (the P0-flagged risk — clean); web api-types +13.
- **P4** `b85dbaa` — route-level end-to-end seal (a stalled queue surfaces `integrator.stall="integrator_down"` through the HTTP read) + docs (deployment §14.12 + worker guide + CLAUDE.md).

**Adversarial-verify result.** P0 design-lock **APPROVED** after attack — the two load-bearing mechanisms held: the `train.integrator_unhealthy` alert edge is genuinely once-per-episode (latched, self-resetting) so surfacing `getHealth` on frequent agent reads does NOT spam alerts; and the stall predicate fires on the real overnight incident (12h down + queued 0-attempt) without false-positiving on a slow verify (the daemon heartbeats independent of lock-holding) or a healthy-idle empty queue. Three amendments folded in (count ALL attempt rows incl. cancelled; convert both merge-request clients; state the field-vs-sibling asymmetry).

**Verification.** Full `build` + `lint` + `typecheck` green (all packages). `@pm/server` 1866, `@urtela/pm-mcp-server` 231, `@pm/shared` green, integrator `batch.ts` unit-covered (abandon-reason 6/6, batch 51/51 isolated). NO migration. The one full-turbo test failure was `@urtela/pm-responder` — a package this campaign never touched (206/206 isolated), a known concurrent-load flake.

**What this fixes.** An agent looking at a stalled train now **self-diagnoses**: `pm_get_merge_lock` / the merge-request reads / `pm_get_integrator_health` show `integrator: DOWN (no heartbeat for Ns) — restart the daemon` vs `healthy, actively integrating — verify in progress`, and the abandon reason names *why* a batch drained. The exact three-way confusion (down vs slow-verify vs gitlink-drain) that cost human relays is now legible from the tools agents already call.

**Remaining (ops handoff, NOT executed):** merge → main; `pnpm build` + `node scripts/distribute.mjs` (ships the updated MCP bundle so agents get `pm_get_integrator_health` + the richer outputs); PM-server redeploy (new read fields + tool — no migration); restart game_one Claude sessions to pick up the new MCP bundle. Separately (out of scope): a daemon supervisor/auto-restart on the game_one host so a crash no longer means a silent overnight stall.
