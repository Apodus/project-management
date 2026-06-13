# Project Management System

Human-AI Collaborative Project Management System. A focused tool for small teams (1-3 humans, multiple AI agents) working locally or on a shared LAN. Monorepo powered by pnpm + Turborepo.

## Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** (install via `npm install -g pnpm`)

## Quick Start

### Development

```bash
pnpm install          # Install all dependencies
pnpm dev              # Starts API server (port 3000) + web dev server (port 5173, with HMR)
```

The web dev server proxies `/api` requests to the backend automatically.

### Production

```bash
pnpm install          # Install dependencies (if not already done)
pnpm build            # Build all packages (shared -> server -> web -> mcp-server)
pnpm start:prod       # Start production server (serves API + web UI on port 3000)
```

In production mode the server serves both the REST API and the pre-built React SPA from a single Node.js process.

## Commands

```bash
# Install all dependencies
pnpm install

# Build all packages
pnpm build

# Start all dev servers (server + web)
pnpm dev

# Start production server (NODE_ENV=production)
pnpm start:prod

# Start server (without setting NODE_ENV)
pnpm start

# Run all tests (unit/integration via Vitest)
pnpm test

# Run E2E tests (Playwright â€” builds, starts server, runs in Chromium)
pnpm test:e2e

# Lint all packages
pnpm lint

# Type-check all packages
pnpm typecheck

# Format code with Prettier
pnpm format

# Check formatting
pnpm format:check
```

### Package-specific commands

```bash
# Run command for a specific package
pnpm --filter @pm/server dev
pnpm --filter @pm/web dev
pnpm --filter @pm/shared build
pnpm --filter @urtela/pm-mcp-server build

# Generate Drizzle migration after schema changes
pnpm --filter @pm/server db:generate

# Export OpenAPI spec to JSON
pnpm --filter @pm/server openapi:export

# Regenerate API types from OpenAPI spec (in web package)
pnpm --filter @pm/web generate:api
```

## Package Structure

```
project-management/
â”œâ”€â”€ packages/
â”‚   â”œâ”€â”€ shared/        # Shared Zod schemas, types, and constants (single source of truth)
â”‚   â”œâ”€â”€ server/        # Hono REST API server with SQLite (Drizzle ORM)
â”‚   â”œâ”€â”€ web/           # React 19 SPA (Vite + Tailwind CSS + TanStack Router/Query)
â”‚   â””â”€â”€ mcp-server/    # MCP server for Claude AI agent integration (stdio transport)
â”œâ”€â”€ docs/design/       # Design documents (high-level-design.md)
â”œâ”€â”€ roadmaps/          # Phase roadmaps
â”œâ”€â”€ turbo.json         # Turborepo pipeline config
â”œâ”€â”€ tsconfig.base.json # Shared TypeScript config (strict mode)
â””â”€â”€ eslint.config.js   # ESLint 9 flat config
```

## Architecture

- **Backend**: Hono framework on Node.js with SQLite via Drizzle ORM. OpenAPI spec auto-generated from Zod schemas. Full-text search via FTS5.
- **Frontend**: React 19 + Vite + Tailwind CSS v4. TanStack Router for routing, TanStack Query for data fetching, Zustand for client state. Component library built on Radix UI primitives.
- **MCP Server**: Separate process using stdio transport. Communicates with the REST API over localhost HTTP. Provides tools for AI agents to manage projects, proposals, tasks, and more.
- **Shared**: Zod schemas as the single source of truth for types across all packages. Exported as ESM.
- All packages use TypeScript with strict mode enabled.

## Merge train (worker / integrator split)

Workers submit a merge request and walk away; a separate long-lived **integrator** process
picks it up, rebases onto live main, runs the project's verify command in an isolated
worktree, and either lands it (fast-forwards main, attaches a `landed_sha` git_ref to the
linked task) or rejects it with a structured payload (auto-comment of type `merge_rejection`).
Main is never broken â€” verify runs against a tree SHA before main fast-forwards.
If a request's content is already on main (landed out-of-band under a different SHA, or a
duplicate), the land path detects the rebased tree is byte-identical to live main
(`GitOps.treesIdentical`, under the lane lock) and records a **no-op land** at the current
main SHA without pushing â€” it never advances main by an empty commit or re-applies. (Grouped
cross-repo re-submissions are no-op'd naturally by the fast-forward push; see
`docs/integrator-deployment.md` Â§9.)

- **Architecture & contracts**: `docs/design/phase-7.1-design.md` (data model, state machines,
  REST surface, SSE events, authz, failure catalog); `phase-7.2` (speculative batching),
  `phase-7.3` (cross-repo atomicity), `phase-7.4` (observability + break-glass),
  `phase-7.5` (smart verification).
- **Operator deployment guide**: `docs/integrator-deployment.md` (install, config, monitoring,
  failure modes, single-machine layout; Â§15 = observability + break-glass).
  The integrator config (`settings.integrator` editable fields + `gitRepoUrl`, including `clean_keep`)
  is now editable in the admin **Integrator** settings page (`/projects/{id}/settings/integrator`);
  deferred fields (`verify_steps`/cache/`slo`/`resolver`) stay REST-only.
- **MCP tools** (worker-facing): `pm_request_merge`, `pm_list_merge_requests`,
  `pm_get_merge_request`, `pm_cancel_merge_request`. The integrator-facing operations
  (pickup, start/complete attempt, land, reject, reset-to-queued) are HTTP-only.
- **Reference integrator**: `packages/integrator-ref` (`@urtela/pm-integrator`, bin `pm-integrator`).
  Deploy one process per `(project, resource)` lane.

**Speculative batching (Phase 7.2).** The integrator can run **N integrations in flight at once**,
configured by `project.settings.integrator.parallelism` (integer â‰¥ 1, **default 1** = exact 7.1
serial behavior â€” no env var). With `parallelism > 1` each member rebases speculatively on
`main + predecessors` (member K assumes 0..K-1 land first), all verify concurrently in a pool of N
isolated worktree clones, and lands serialize in batch order. A member failure invalidates exactly
its dependent suffix (predecessors still land; the suffix re-verifies against the corrected base);
transient verify failures retry with backoff. The lane lock is now acquired **once per batch**
(lane ownership), so a second integrator on the same lane idles. Batch observability is delivered
via SSE: `merge.batch.started/member_landed/member_invalidated/completed` markers (relayed through
`POST /api/v1/projects/{projectId}/merge-batches/events`) plus `batch_id`/`speculative_position` tags
on the existing `merge.request.*` / `merge.attempt.*` frames. No PM batch tables â€” the integrator owns
batch state in memory. Full spec: `docs/design/phase-7.2-design.md`.

**Cross-repo atomicity (Phase 7.3).** A change that spans linked repos (game*one's `rynx` inner Rust
workspace + the outer game repo that embeds it as a `160000` gitlink) lands as a unit or not at all.
Workers submit each repo's change as a normal merge request, then bind them into a **merge group**
(`pm_request_merge_group`); the integrator picks up the whole group under the **same lane lock**,
assembles the multi-repo state (inner rebased to `Ri` + outer gitlink committed to `Ri` + the inner
sources materialized into the outer working tree), runs per-repo verify concurrently (AND-combined),
and lands **inner-first then outer**. If the inner push fails the whole group rejects cleanly (outer
never touched); if the outer push fails \_after* the inner landed, the inner commit is marked
`orphaned` and a durable **incident** (`orphaned_inner`) is opened so the divergence is detectable
from PM alone (no SSH into the host). Recovery is **auto-rollforward**: a later integration rolls the
outer gitlink forward to absorb the orphaned SHA via a verify-gated fast-forward push (when the
current gitlink is an ancestor of the orphan) and resolves the incident `auto_resolved`; an
un-reconcilable orphan escalates and the incident stays `open` for a human (`human_resolved`). Outer
`main` is **never** advanced to a gitlink whose assembled tree has not passed verify â€” not in land,
not in recovery. State is PM-owned in two new tables â€” `merge_request_groups`
(forming â†’ integrating â†’ landed | rejected | partially_landed) and `merge_incidents`
(open â†’ auto_resolved | human_resolved) â€” plus a nullable `merge_requests.group_id`. Linked repos are
declared per project in `settings.integrator.linked_repos` (`[{ name, path, role: "inner"|"outer",
gitlink_parent?, gitlink_path? }]`; default `[]` = single-repo, byte-identical to 7.2) â€” where a
linked-repo `path` accepts a bare/local path **or** a remote/`file://`/SSH/HTTPS URL (the integrator
binds it via a local `--mirror` clone to resolve refs), and an inner repo's Git LFS files materialize
as **real binaries** in the outer working tree for verify (land path AND recovery roll-forward). The
materialized overlay is **complete and self-cleaning** (2026-06-10 hardening): materialize purges the
gitlink path before writing (content at a committed gitlink is INVISIBLE to git status/clean/reset, so
a stale overlay would otherwise outlive every attempt and poison later verifies in the slot â€” the
game_one `submodule update` fatal), exports the inner repo's **nested submodules recursively**
(tree-exact, initialized in the inner pool worktree where `submodule update` works), and every
`resetForAttempt` purges leftover overlays at declared `gitlink_path`s (triple-guarded: only a
populated, `.git`-less dir at a real 160000 gitlink is removed). **Verify contract:** the outer verify
command must NOT `submodule update --init` the gitlink path (unfetchable pre-land; the train provides
those sources) â€” see `docs/integrator-deployment.md` Â§14.8 for the detection idiom. Worker MCP tools:
`pm_request_merge_group` (accepts an atomic `members` form — ≥2 specs, or ONE inner spec +
`synthesize_outer: true` (see the inner-only blurb below); members born group-bound, never
single-repo-pickable — or the legacy `member_request_ids`),
`pm_get_merge_group`, `pm_list_merge_incidents`, `pm_get_merge_incident`. Full spec:
`docs/design/phase-7.3-design.md`.

**Inner-only merge groups (2026-06-10).** A change that lives entirely in the inner repo submits ONE
member: `pm_request_merge_group(members: [<inner spec>], synthesize_outer: true)`. The flag is strict
(`=== true`; `false` behaves like absent; a 1-member array without it stays a 400) and requires
`settings.integrator.linked_repos` to declare exactly one inner + one outer (else 400). PM mints a
**synthetic** outer member (migration 0027: `merge_requests.synthetic` + nullable refs; born
group-bound; views gain an additive `synthetic: false` on real members — the legacy ≥2-member and
`member_request_ids` forms stay byte-identical) and the integrator synthesizes the outer candidate at
assembly: live outer `main` + gitlink commit → `Ri`, the outer rebase **skipped**, the synthetic
member being the outer **by construction** (never ref-resolved) — so the stale-bump `outer_conflict`
rejection class is **structurally impossible** for inner-only groups (no worker-minted bump branch
exists to go stale; workers must never mint gitlink-bump-only outer branches). The synthetic member's
verify is the project default `verify_command` in the **outer** worktree; land fills its
`landedSha = Ro`; a rejected inner-only group is resubmitted by resubmitting the ONE inner member
(re-synthesis against the then-current outer main is automatic). Binding guard: the real member must
bind to the INNER repo — an outer-binding member rejects from `forming` with "outer-only changes
don't need a group; submit a plain merge request". `updateSubmoduleGitlink` no-change idempotence is
now explicit/contractual (assembly skips the gitlink commit when unchanged — never an empty bump
commit; the land's FF push is then a natural no-op). Rendering: timeline badge "synthetic gitlink
bump"; `pm_get_merge_group` shows "(synthetic gitlink bump — outer candidate synthesized at
integration)". **Scope limit:** only the declared `linked_repos` gitlink is synthesized — game_one's
second gitlink `tools/rynx-treegen` still needs a real outer member; >2-repo topologies and
auto-cancel of duplicate stale submissions are out of scope. Worker doc: `docs/worker-pm-workflow.md`
(cross-repo section); operator: `docs/integrator-deployment.md` §14.7/§14.9.

**Observability + break-glass (Phase 7.4).** The train is legible, accountable, recoverable, and
self-alerting. A human-facing **dashboard** (`/projects/{id}/train`), a **per-request timeline**
(`GET /api/v1/merge-requests/{id}/timeline`, ordered from request + attempts + audit + incident),
and an admin-only **audit + break-glass controls** view (`/projects/{id}/train/audit`). On-read
**metrics** (`GET train/metrics` + `GET train/in-flight`): queue depth, in-flight composition,
24h time-to-land p50/p95/p99, verify-success/abandon rates, pool utilization, embedded health, and
per-project **SLO** compliance (`settings.integrator.slo`, recorded not enforced). Three PM tables:
`audit_log` (append-only, action-centric â€” 7 actions: `land`/`reject`/`pause`/`resume`/
`force_release_lock`/`force_land`/`force_reject`), `integrator_health` (per-lane heartbeat upsert,
fixed 90s staleness), `train_state` (per-lane running/paused + alert latches). The **five admin
break-glass overrides** â€” all HUMAN admin-only (not `ai_agent`), each writing exactly one audit row
in the same transaction as its state change: `pause` (stop new pickups, finish in-flight) / `resume`
/ `force-release-lock` (`POST .../merge-locks/{resource}/force-release`, hard-clears, no queue
promotion) / **`force-land`** (`POST /api/v1/merge-requests/{id}/force-land` â€” THE R1 override: lands
WITHOUT verify, reason-required, records the operator-asserted `landedSha`, **PM never runs git so
the operator must advance remote `main` separately**, grouped member â†’ 409) / `force-reject`
(reason-required). The **integrator health channel**: the integrator POSTs `POST .../integrator/
heartbeat` (ai_agent) every `heartbeat_interval_sec` (default 30); `GET .../integrator/health` shows
freshness. **Dual alerts** for `train.stuck` (oldest-queued > 600s AND in-flight 0 AND not paused) /
`train.abandon_rate_high` (24h ratio > 0.3 AND resolved â‰¥ 5) / `train.integrator_unhealthy`
(heartbeat > 90s stale) â€” edge-triggered on-read (no sweep), delivered BOTH in-app (SSE banner) AND
out-of-band to Discord (`settings.webhooks.discord_url`). **Pause** is read-side on the integrator
(fail-open): it stops NEW admission and finishes in-flight; recovery still runs while paused. New SSE
events: `train.paused/resumed/stuck/abandon_rate_high/integrator_unhealthy` + `audit.recorded`. No
new MCP tools (the overrides are human operator actions). Full spec: `docs/design/phase-7.4-design.md`;
operator guide: `docs/integrator-deployment.md` Â§15.

**Smart verification (Phase 7.5).** Verify stops being a fixed cost via two levers: a multi-step
verify **DAG** (cheap-first, fail-fast, independent steps parallel) and a PM-owned **verify-result
cache**. The DAG is `settings.integrator.verify_steps: [{id, command, depends_on?, cache_key_inputs?,
timeout_sec?}]` (canonical Zod-3 in `@pm/shared` + the route-local Zod-4 mirror, the established
split); config-time validation rejects duplicate ids / dangling `depends_on` / cycles (Kahn's) as
`400`s; empty/absent â†’ a single synthetic `verify` step running `verify_command` = byte-identical
7.2/7.3/7.4. The pipeline runs INSIDE `runVerifyTask` (the scheduler â€” admit/rebase/land/suffix/retry/
kill â€” is UNCHANGED); cross-repo runs the pipeline per repo, AND-combined; group orphan-recovery runs
cache-OFF. The cache is PM-owned `verify_cache` with a strict 5-tuple key `(project_id, resource,
tree_sha, step_id, step_config_sha)` â€” content-addressed (`tree_sha` is `resolveRef("<commit>^{tree}")`,
NOT the commit sha; `step_config_sha = sha256` over `{command, cache_key_inputs sorted}`), no fuzzy
match, no TTL. A `cache_enabled` kill-switch (**default `false`**) + `cache_mode: off|on|shadow`
(**default `off`**) govern it: **off** = inert (byte-identical to pre-7.5); **on** = HIT skips the
step + reuses the verdict / MISS runs + records; **shadow** = ALWAYS runs the real step + compares to
any cached row + emits `verify.cache_mismatch` on a discrepancy + ALWAYS uses the REAL verdict (the
false-pass detector + self-heal). **The honest limitation:** in `on` the cache is only as correct as
the operator's declared `cache_key_inputs` â€” an UNDECLARED out-of-tree input CAN false-pass; shadow is
the detector, so the discipline is **shadow â†’ observe zero mismatches â†’ on**. Cache I/O is best-effort
non-fatal (a lookup throw â†’ MISS; a record/emit throw â†’ warn + continue; never fails a member or blocks
a land). Observability: a per-step **timeline** (`merge_attempts.steps`, camelCase
`{stepId, outcome, cached, durationMs, treeSha, stepConfigSha, logUrl?}`) + a `verify` metrics
sub-block (snake_case cache-hit-rate / time-saved / per-step) + a debug `GET /api/v1/projects/{id}/
verify-cache` (any authenticated user). Integrator-only (`ai_agent`): `POST .../verify-cache/lookup`,
`/record`, `/mismatch`. **No new worker MCP tools** (the cache is HTTP-only, like 7.4) and no new env
var (config lives in `settings.integrator`, set via `PATCH /projects/{id}`). New tables: `verify_cache`
(0015), `merge_attempts.steps` nullable JSON (0016). New event: `verify.cache_mismatch`. Full spec:
`docs/design/phase-7.5-design.md`; operator guide: `docs/integrator-deployment.md` Â§16.

**Intelligent conflict resolution (Phase 7.6).** When the integrator hits a **textual rebase
conflict**, instead of rejecting straight to the worker it can â€” behind an opt-in flag â€” spawn a
bounded headless Claude session to reconcile both intents, re-verify, and resubmit the resolved
change as a **linked new merge request**; if that fails it escalates to the author then a human, and
**no proven work is ever discarded**. Config is `settings.integrator.resolver: {enabled (default
`false`), max_concurrent (default 1), time_budget_sec (default 600), token_budget?, command?}`
(canonical Zod-3 in `@pm/shared` + the route-local Zod-4 mirror; absent/empty â†’ `{enabled:false}` â‡’
**byte-identical to 7.5**). **Five settled decisions:** (1) **off by default**, one attempt, no retry;
(2) resolution spawns a **linked NEW** request (`resolved_from`), never mutates the origin (rejected
`conflict`); (3) **verify is the only arbiter** â€” never a model's self-asserted confidence; (4)
**never discard work** â€” escalate to the origin author (then human); (5) **conflict-only for v1**
(semantic verify failures deferred). The engine: at the `rebaseOnto â†’ RebaseConflict` seam
(`loop.ts`/`batch.ts`), if enabled, reject-fast + **release the lane** + open a `merge_resolutions`
row + enqueue into a **resolver pool** (isolated worktrees, separate from the verify pool) â€” the
resolution runs **OFF the lane lock**. The worker calls `start` (pendingâ†’resolving) FIRST,
materializes the conflict (`GitOps.materializeConflict`, no `--abort`), spawns the **injectable**
resolver (`claude -p`/`command`, SIGTERMâ†’SIGKILL at `time_budget_sec`, one attempt), commits +
pushes `pm/resolution-<id>`, then runs the 7.5 verify pipeline **cache-OFF** as the sole gate
(superseded by 7.6.1 â€” see below); on pass
it resubmits with `resolved_from` + the origin's `task_id` AND `verify_cmd` (re-enters the train, real
verify gate); on fail/budget/spawn-error it escalates (`escalated`|`failed`) + posts a `merge_rejection`
comment. **No recursion**: `resolved_from != null` â‡’ the resolver never re-engages. All PM/git I/O is
non-fatal (never escapes into the train); a push/submit failure escalates, a post-resubmit
`resolvedResolution` failure is log-only (the resubmit already succeeded). State is PM-owned:
`merge_resolutions` (pending â†’ resolving â†’ resolved | escalated | failed) + a nullable
`merge_requests.resolved_from` (migration 0017). REST (integrator-only `ai_agent`): `POST
.../merge-resolutions` (open), `/start`, `/resolved`, `/escalate`; GET list + by-id (any authed user).
Five SSE events `merge.resolution.pending|started|succeeded|escalated|failed`. Observability: the
per-request **timeline** renders the originâ†’attemptâ†’resolved chain (a `resolving` attempt shows
in-flight) + a `resolution` metrics sub-block (snake_case attempts / auto-resolve-success-rate /
escalation-rate / mean-wall-clock / budget-utilization). **No new worker MCP tools** (the resolver is
operator/integrator machinery, like 7.4/7.5) and no new env var (config in `settings.integrator`, set
via `PATCH /projects/{id}`). **Track A** (doc-only, shipped): the worker workflow doc now tells agents
to **submit-and-move-on** (a rejection is a new ticket, not a stall). **Honest limitation:** the
resolver is bounded + one-shot; a rare integrator crash mid-resolution strands the row in `resolving`
(no auto-reclaim sweep yet â€” v2 (superseded by 7.6.1 â€” see below); no work lost, `main` untouched). Full spec:
`docs/design/phase-7.6-design.md`; operator guide: `docs/integrator-deployment.md` Â§18.

**In-session resolver loop (Phase 7.6.1).** The agent now owns verification: within its single bounded
session it runs the **full verify itself** and iterates resolveâ†’verifyâ†’fix to a green suite, then
declares via a **status sentinel** (`PM_RESOLUTION_STATUS_PATH`: `complete`|`give_up`; absent/markers â‡’
escalate). The daemon **dropped its own verify gate** â€” the **train re-verify is the sole landing gate**
(an agent that wrongly declares `complete` just fails the train re-verify; `main` never at risk).
`time_budget_sec` now bounds the **whole session** (default raised **600 â†’ 3600**; size â‰¥ a fewÃ— verify
duration). A periodic **reclaim sweep** (`reclaim-resolutions.ts`, in `runBatchLoop`, gated on
`resolver.enabled`) recovers rows stranded in `resolving` past `attempt_started_at + time_budget_sec +
grace[max 120s, 0.25Ã—budget]` â€” **reconcile** (resubmission with `resolved_from` exists â†’ `resolved`,
never escalate) **or escalate** (`failed`/`session_died_or_timeout` + comment) â€” closing the v1
dangling-`resolving` gap. Metrics add **`mean_session_sec`** (seconds view of `mean_wall_clock_ms`) +
**`reclaimed_count`** (sweep-**escalated** rows only â€” reconciled rows write no marker, counted in
`auto_resolve_success_rate`; honest under-count, documented). No `@pm/shared`/migration change. Full
spec: `docs/design/phase-7.6.1-resolver-in-session-loop.md`; operator guide:
`docs/integrator-deployment.md` Â§18.7.

**Claim lease engine (Campaign C2).** A claim is a **lease**, not a permanent grab: a single row per
`(entity_type, entity_id)` in `claim_leases` tracks the holder + a TTL-derived `expiresAt`
(the entity's `assigneeId`/`claimedBy` stays the human-facing holder pointer; the lease is the
liveness layer beside it). **Renew-on-action**: every claimed write flows through the liveness-aware
`assertClaimOk`, which renews the holder's own lease forward â€” so a holder is **never 409'd for its own
stale lease** (self-stale â†’ renew), and only a _different_ agent is gated. Reclaim is an
**opportunistic on-read sweep** (merge-lock parity â€” piggybacked on claim/pick, no scheduler / no
background thread): lapsed leases (`now > expiresAt + grace`) are detected and, in mode `on`, the
holder is cleared atomically with exactly one `claim_reclaimed` audit row + one `claim.lease.reclaimed`
SSE event per reclaim. The engine is governed by `PM_LEASE_MODE` (`off`/`shadow`/`on`, default
**`shadow`**) + `PM_LEASE_TTL_SEC` (default 1800) + `PM_LEASE_GRACE_SEC` (default 86400): **off** =
inert (pre-C2), **shadow** = detect-only (the safe-rollout rung â€” observe lapses, never reclaim),
**on** = the lease governs (reclaim active). The discipline is **shadow â†’ observe â†’ on**, and **`on`
is C1-gated** â€” stable worker identity is the precondition (an agent whose id churns per session would
be wrongly reclaimed). Everything is **fail-safe-to-live**: a null/unparseable `expiresAt`, a
misconfigured knob, or a vanished entity is never aggressively reclaimed. Ships in `shadow` with a long
(24h) grace. Full spec: `docs/design/phase-c2-claim-lease-engine.md`.

**Stable worker identity (Campaign C1).** A pool worker re-binds to the **same `users` row** across
reconnect / reboot / token refresh by presenting a durable **worker key** (`PM_WORKER_KEY`) paired with
the pool secret: the server resolves `(pool, workerKey)` to the same agent and refreshes its token
instead of grabbing a fresh free agent and minting a new identity. Keyed bindings are recorded in
`agent_claims` (migration 0022 adds `worker_key`/`worker_key_pool_id`) and are **reserved** â€” excluded
from the free pool, so neither a keyless claim nor another key's first-bind can ever steal a keyed
worker's slot, even after its claim TTL lapses. This kills the **reconnect-strand** bug (the documented
Worker 1â†’Worker 3 incident, `project-force-claim`): an MCP reconnect no longer churns the identity, so
in-flight claims (and their C2 leases) never strand under a dead `users` row and the new identity never
gets a spurious `409 CLAIM_DENIED`. Stable identity is the safety precondition that **unblocks the C2
`PM_LEASE_MODE=on` flip** (an identity that churned per session would be wrongly reclaimed) â€” but C1
does **not** flip it (operator decision; the lease still ships in `shadow`). `forceClaim` is preserved
as the break-glass for a genuine cross-worker handoff (a displaced keyed worker re-binds to the same id
yet is still correctly gated off the taken work). **Back-compat:** keyless `claimAgent(pool, secret)`
callers degrade to today's grab-any-free-agent behavior, and static `PM_API_TOKEN` users (already
stable) are a no-op. Full spec: `docs/design/phase-c1-stable-worker-identity.md`.

**Liveness surfacing (Campaign C3).** The C2 lease becomes a first-class, **identity-masked**
`claim_state` (`unclaimed | live | stale | yours`) surfaced on every read used to decide pickup â€”
REST + MCP (agent-friendly renders: "live (actively worked)" / "stale (claim lease lapsed â€” may be
abandoned)") + web badges (board / epic / roadmap canvas) â€” derived from the C2 lease via
`deriveClaimState(holder, lease, now, caller)` (fail-safe-to-live: a claimed entity with no lease row
reads **live**, never stale). It never carries a holder id (masked like `deriveClaimStatus`). Pickup
acts on it: `pm_pick_next_task` **skips live**-claimed work and, in mode `on`, **reclaims-then-claims a
stale** one (the atomic merge-lock idiom â€” one winner on a race); `pm_awareness_check` reports live vs
stale in-flight. An **edge-triggered stale-claim alert** (`claim.stale_alert`) fires once per stale
episode (latched on `claims_alert_state`, re-arms on resolution â€” `train.stuck` parity) BOTH in-app
(SSE banner) AND out-of-band to Discord, identity-masked to an aggregate count + oldest-stale age.
**Handoff primitives** compose the audited transfer core (`performClaimTransfer` â€” terminal guard +
txn clearing old/setting new holder + ONE `force_claim` audit row + post-commit event + lease transfer
to the new holder): `release-to` (`POST .../{tasks|epics|proposals}/{id}/release-to`, MCP
`pm_release_*_to`) hands a claim to a **named worker** â€” its own authz lets the **current holder**
(or any human) transfer, the load-bearing case `force_claim`'s gate could not serve (an AI holder
handing off to another worker); `request-takeover` (`POST .../{id}/request-takeover`, MCP
`pm_request_takeover_*`) is **stomp-safe** â€” a **stale** claim auto-grants to the requester, a **live**
claim is **NEVER mutated** (the cardinal invariant â€” it only emits `claim.takeover_requested` to notify
the holder and returns `notified_holder`). The arc does **NOT** flip `PM_LEASE_MODE` (operator
decision; C1 made `on` safe; the lease still ships in `shadow`). Full spec:
`docs/design/phase-c3-liveness-surfacing.md`.

**Escalation channel (Campaign C1 â€” escalation primitive).** A bidirectional, directed, durable
**cross-team channel** that **replaces the human relay** (client worker complains â†’ human forwards â†’
PM reacts â†’ human relays back): a client-repo (game_one) worker now raises straight to the platform/PM
project and the teams converse **agent-to-agent** on an append-only thread. Two PM-owned tables
(migration 0029): `escalations` (one row per thread â€” `kind`, `severity`, `status`, `origin_repo`,
`origin_worker_key`, `holder_id`, `author_id`, optional `code_locator`/anchor) + `escalation_messages`
(the thread, `UNIQUE(escalation_id, seq)` with the next 1-based `seq` allocated **atomically** under the
write txn; `message_type` âˆˆ `{reply, diagnosis, instruction, system}`). **Lifecycle**
`open â†’ acknowledged â†’ answered â†’ resolved` (centralized `ESCALATION_TRANSITIONS` + `assertTransition`),
with **`needs_human`** reachable as a side-channel from **any non-terminal** state and the **origin
author** able to **withdraw-resolve** from any non-terminal state (a non-author resolves only from
`answered`/`needs_human`); `resolved` is terminal + append-frozen. `kind` âˆˆ
`{bug_report, question, request, blocked}` + optional `severity`. **`origin_repo` + `origin_worker_key`
are REQUIRED provenance params** (`.min(1)`, passed explicitly by the worker â€” NOT read from env).
Surface: **8 MCP tools** (`pm_raise_escalation`, `pm_reply_escalation`, `pm_get_escalation`,
`pm_list_escalations`, `pm_acknowledge_escalation`, `pm_answer_escalation`, `pm_resolve_escalation`,
`pm_escalate_to_human`), **8 REST routes** (raise/list under `/projects/{id}/escalations`;
get/messages/acknowledge/answer/resolve/escalate-to-human under `/escalations/{id}/...`), **SSE
`escalation.*` frames** (`opened`/`acknowledged`/`replied`/`answered`/`resolved`/`needs_human`, with
`escalation_id` + `origin_worker_key` projected onto the frame), and **activity-feed verbs** â€” **one
activity_log row per transition IS the durable audit trail** (the governance-specific train `audit_log`
enum table is **deliberately NOT** extended). **Authz:** raise = any authed; reply = author|holder|
human; acknowledge/answer = human|holder|unclaimed-pickup (acknowledge is the PM-side pickup that
auto-claims the thread); resolve = author-withdrawal|holder|human; escalate_to_human = author|holder|
human. **Delivery is now SHIPPED (Campaign C2 â€” see next paragraph);** C3 (auto-responder), C4 (web UI)
remain future. Everything is **additive** â€”
notes/comments/proposals/tasks/merge-train stay byte-identical. Docs: `docs/worker-pm-workflow.md`
(Â§ Cross-team escalations) + the roadmap/vision files under `roadmaps/`.

**Escalation reply delivery (Campaign C2).** The reply a holder/human writes now **finds the origin
worker** instead of waiting to be polled, via **three surfacing paths** keyed on the worker's liveness:
(1) the **wake daemon** (`@urtela/pm-wake-daemon`, bin `pm-wake-daemon`) â€” one process per machine
watching the local `PM_WORKER_KEY`, which polls undelivered replies and **spawns a fresh worker turn
seeded with the reply** for an **ended/dormant** worker (the **structural guarantee** the other two
can't give); (2) a **piggyback envelope** â€” an active in-session worker gets a ðŸ“¬ unread-replies notice
**appended to any `pm_*` tool response** (opportunistic, best-effort, byte-identical when there's
nothing unread); (3) **`pm_check_messages`** â€” an explicit **drain** that pulls + acks. All three are
backed by a per-thread **delivery cursor** (`escalations.origin_last_seen_seq`, migration 0030 â€” an
ADVISORY, forward-only watermark advanced ONLY via `mark-delivered`, **never** on a read path) +
`GET /escalations/undelivered?worker_key=` (directed replies = messages NOT authored by the origin
author, seq beyond the cursor) + `POST /escalations/{id}/mark-delivered`. The **Discord needs-human
bridge** is the **one out-of-band path**: `escalation.needs_human` POSTs through the existing alert
machinery (missing webhook = no-op) â€” **per-event** (NOT latched), **intentionally specific** (id /
title / kind / origin, NOT identity-masked, unlike the aggregate train/notes/claims alerts) so a human
**re-enters for the decision** (approval / awareness), never as message transport. No new worker MCP
tools beyond `pm_check_messages`; the wake daemon is operator machinery (its client docs ship in the
game_one bundle â€” a separate repo, do not edit). Full spec under `roadmaps/`.

**Auto-responder (Campaign C3).** The PM side now **answers escalations autonomously** via a responder
daemon (`@urtela/pm-responder`, bin `pm-responder`) â€” one process per watched platform project, the
mirror of the C2 wake daemon. It is **answer/diagnose-ONLY**: a **read-only PM-repo diagnosis** session
(no code mutation â€” a code-fixing responder is parked). Per poll tick it lists **open** escalations for
the watched project, seeds the no-recursion set (unclaimed, `status === "open"`, `authorId !== selfId`,
`originRepo` not in `excludeOriginRepos`), and for each candidate **claims via acknowledge** (the C1
one-active-responder gate â€” a 403 means another responder beat it), then **spawns a bounded headless
claude** in the PM repo and routes its **4-state status sentinel**: `answered{answer}` posts via
`answer` (the diagnosis becomes a directed reply the origin **auto-notices through C2 delivery**);
`needs_human` / `give_up` / `error` route to `escalateToHuman` (â†’ the **C2 P5 Discord needs-human
bridge**) so **no proven work is discarded**. **Safety:** `enabled` is a kill-switch (**default FALSE**
â€” ships OFF); `mode` âˆˆ `off | shadow | on` (**default shadow**) gates only the POST â€” **off** is fully
silent, **shadow** drafts every answer to a human for approval (the safe-rollout rung), **on** auto-sends
routine answers but a **high-severity** answer **PERMANENTLY** routes to human approval even at `on`;
a **reclaim sweep** recovers escalations stranded `acknowledged` under a dead session (stale past
`updatedAt + timeBudgetSec + reclaimGraceSec`, poison-capped at `maxReclaimAttempts`); a sliding-window
**spawn-rate budget** + `maxConcurrent` bound the spawn rate. **No-recursion is structural** â€” the
responder mints no escalation (its only actions are `answer`â†’answered and `escalateToHuman`â†’needs_human,
neither creating a thread), so a responder answer can never spawn a thread it would re-pick;
`excludeOriginRepos` is the belt-and-suspenders for a co-located self-hosted PM repo. This **closes the
C1â†’C3â†’C2 chain**: a client raises (C1) â†’ the responder acknowledges + answers (C3) â†’ the diagnosis
surfaces as an undelivered directed reply the origin auto-notices and drains (C2). **No new worker MCP
tools** (the responder is operator/integrator machinery, like the wake daemon). The operator flips
`enabled` then graduates **shadow â†’ on** after observing drafts. Operator guide:
`docs/integrator-deployment.md` Â§20; the game_one bundle ships it (a separate repo, do not edit). Full
spec under `roadmaps/`.

**Escalation legibility, safety rails & SLAs (Campaign C4).** The cross-team channel is now **legible,
bounded, and self-alerting**. A human-facing **web dashboard** (`/projects/{id}/escalations`) lists/filters
escalations (status/kind/severity/origin-repo/worker-key), a **per-escalation timeline**
(`/projects/{id}/escalations/{escalationId}`) renders the message thread + a status-derived lifecycle
strip, and a sidebar nav entry/badge surfaces the project's open-escalation count. An **on-read metrics
endpoint** (`GET /api/v1/projects/{id}/escalations/metrics`, mirroring `train/metrics` â€” no new table)
exposes time-to-first-response and time-to-resolve p50/p95, **auto-resolve rate** (diagnosis-message
presence), **human-escalation rate** (current `needs_human` share), and **open backlog** (count + oldest
age); the dashboard's metrics panel renders these. These are the **PM-side observable responder-outcome
signals** â€” the responder-internal seals (spawn-rate budget, `maxConcurrent`) are **DAEMON-side**
(observable via the responder logs + `docs/integrator-deployment.md` Â§20), NOT the PM dashboard
(deferred). An **edge-triggered + latched `escalation.sla_breached` alert** (migration 0031;
ESCALATION_SLA_BREACH_THRESHOLD_MS = **1h**, hardcoded non-env) fires once per breach episode â€”
identity-masked to an aggregate count + oldest-unanswered age, re-arming on resolution (`train.stuck`
parity) â€” BOTH in-app (SSE banner) AND out-of-band to Discord (`settings.webhooks.discord_url`).
Anti-spam: an `escalations_fts` **advisory similar-thread** hint plus an **exact-dup auto-link** (same
project + `originRepo` + normalized title, both open) that **folds** the second raise into the existing
thread (bumps `updatedAt`, emits `escalation.replied` NOT `escalation.opened` â€” so **no 2nd thread and no
2nd responder spawn**), and a **per-`origin_worker_key` raise rate-limit** (soft â†’ proceed with
`rateLimited:true`; hard (env) â†’ 429; **fail-open** on any limiter error). The create response is now the
envelope `{data, similar, merged, mergedInto, rateLimited}` (201). **Arc-close:** the 4-campaign arc is
**COMPLETE** â€” **C1 channel â†’ C2 delivery â†’ C3 responder â†’ C4 legibility**. The channel is legible,
bounded, and self-alerting, so the responder (which **ships `enabled=false`**) can be flipped
**shadow â†’ on** responsibly â€” a human always sees the backlog, is paged by the SLA alert, and approves
high-severity/`needs_human` outcomes. Roadmap: `roadmaps/roadmap-20260613-1441-c4-legibility-sla.md`.

### Production Deployment

In production (`NODE_ENV=production`), the server process:

- Serves the REST API on `/api/v1/*`
- Serves the SSE event stream on `/api/v1/events`
- Serves the pre-built React SPA on `/*` (with SPA fallback for client-side routing)
- Uses SQLite database at `./data/pm.db` (configurable)

## MCP Server Setup

The MCP server allows Claude (or any MCP-compatible AI agent) to interact with the project management system.

### Configuration

Add the following to your Claude MCP settings (e.g., `claude_desktop_config.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "project-management": {
      "command": "node",
      "args": ["/path/to/project-management/packages/mcp-server/dist/index.js"],
      "env": {
        "PM_API_URL": "http://localhost:3000",
        "PM_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Replace `/path/to/project-management` with the absolute path to this project. `PM_API_URL` can point to any machine running the server (e.g., `http://192.168.1.x:3000` for a remote host).

When auto-claiming from an agent pool (`PM_POOL_SECRET` instead of a static `PM_API_TOKEN`), also set a **distinct** `PM_WORKER_KEY` per worker so a reconnect/restart re-binds the SAME identity instead of grabbing a new free agent (avoids stranded claims). The game*one distribute bundle (a separate repo â€” do not edit from here) should write a distinct `PM_WORKER_KEY` per worker alongside the per-worker `PM_POOL*\*` it already emits.

### Available MCP Tools

The MCP server exposes tools for:

- **Projects**: List, create, and manage projects
- **Proposals**: List, create, discuss, and transition proposals
- **Tasks**: List, get, create, and update tasks
- **Notes**: Capture, list, and get lightweight ownerless notes (bug/question/idea/tech_debt/wtf/observation) via `pm_post_note`/`pm_list_notes`/`pm_get_note`
- **Search**: Full-text search across all entities
- **Updates**: Activity feed and status updates
- **Workflow**: Status transitions and workflow management
- **Write operations**: Create and modify project entities

## Environment Variables

| Variable             | Default                 | Description                                                                                                                                                                                                                     |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`           | (none)                  | Set to `production` for production mode                                                                                                                                                                                         |
| `PM_PORT`            | `3000`                  | Server port                                                                                                                                                                                                                     |
| `PM_HOST`            | `127.0.0.1`             | Bind address (`0.0.0.0` for LAN access)                                                                                                                                                                                         |
| `PM_DB_PATH`         | `./data/pm.db`          | SQLite database file path                                                                                                                                                                                                       |
| `PM_LOG_LEVEL`       | `info`                  | Logging verbosity                                                                                                                                                                                                               |
| `PM_WEB_DIST_PATH`   | (auto-resolved)         | Override path to web dist directory                                                                                                                                                                                             |
| `PM_POOL_SECRET`     | (none)                  | Agent-pool secret. Server: auto-creates the `default` pool on first claim. MCP server: auto-claims an agent identity from the pool (alternative to a static `PM_API_TOKEN`).                                                    |
| `PM_POOL_NAME`       | `default`               | MCP server: name of the agent pool to claim from                                                                                                                                                                                |
| `PM_LEASE_MODE`      | `shadow`                | Claim lease engine: `off`/`shadow`/`on` (`on` is C1-gated)                                                                                                                                                                      |
| `PM_LEASE_TTL_SEC`   | `1800`                  | Claim lease TTL (seconds) before a lease lapses                                                                                                                                                                                 |
| `PM_LEASE_GRACE_SEC` | `86400`                 | Reclaim grace (seconds) beyond TTL before sweep                                                                                                                                                                                 |
| `PM_API_URL`         | `http://localhost:3000` | MCP server: API base URL                                                                                                                                                                                                        |
| `PM_API_TOKEN`       | (none)                  | MCP server: API authentication token                                                                                                                                                                                            |
| `PM_WORKER_KEY`      | (none)                  | MCP server: stable per-worker identity key. With the pool secret, re-binds the SAME agent identity across reconnect/restart (no stranded claims). Must be DISTINCT per worker. Unset â‡’ legacy behavior (grab any free agent). |

There is no session-signing secret: sessions and API tokens are opaque random tokens stored
bcrypt-hashed server-side (sessions ride an httpOnly `pm_session` cookie; API tokens go in the
`Authorization` header).

See `.env.example` for a template.

## Testing

```bash
# Run all unit/integration tests (Vitest)
pnpm test

# Run tests for a specific package
pnpm --filter @pm/server test
pnpm --filter @pm/shared test
pnpm --filter @urtela/pm-mcp-server test

# Run tests in watch mode (package-level)
cd packages/server && npx vitest

# Run E2E tests (Playwright)
pnpm test:e2e
```

Unit/integration tests use Vitest. Server tests use in-memory SQLite databases for isolation.

E2E tests use Playwright with Chromium. They build the app, start a production server on a dedicated port (default 3099, configurable via `E2E_PORT`), and test critical user flows: setup wizard, login/logout, project creation, proposals, task management, board view, and command-palette search.

## Database Management

### Migrations

Drizzle ORM handles schema migrations automatically on server startup. To generate a new migration after changing the schema:

```bash
# Edit schema in packages/server/src/db/schema.ts
# Then generate migration SQL:
pnpm --filter @pm/server db:generate
```

Migration files are stored in `packages/server/src/db/migrations/`.

`db:generate` works again: the snapshot history was rebuilt to a single baseline
`meta/0026_snapshot.json` (after a historical hand-copied-snapshot collision â€” `0005`/`0006`
were byte-identical, which broke drizzle-kit's snapshot diffing). Under this one-baseline model,
a future `db:generate` diffs the current `schema.ts` against that baseline and emits `0027_*`
automatically â€” the `.sql`, its `meta/0027_snapshot.json`, and the `_journal.json` entry are all
written for you. Hand-authored migrations remain possible, but each must append its own
`_journal.json` entry â€” migrations apply by journal order, not by `.sql` glob.

**Journal `when` MUST be the real current time (`Date.now()`), strictly greater than the previous
entry and NEVER in the future.** Drizzle applies a migration iff `when > MAX(created_at)` of the
applied log — a future-stamped entry raises the watermark so the NEXT (honestly-stamped) migration
silently skips on every existing DB (the 2026-06-10 incident: hand-authored entries 0004–0026
carried fabricated sequential-midnight stamps marching to 2026-06-21; the auto-generated 0027 sat
below the watermark, skipped, and the server 500'd per request). Guards now exist
(`src/db/migration-journal.ts`): boot HEALS drifted `created_at` values (hash-matched to the
journal) and then FAIL-LOUD asserts every journal migration is applied — plus a journal-hygiene
test pins monotonic, non-future `when`s. Don't fight the guards; stamp honestly.

### Backup

The database is a single SQLite file (default: `./data/pm.db`). To back up:

```bash
# Simple file copy (stop server first for consistency, or use SQLite backup API)
cp ./data/pm.db ./data/pm.db.backup

# Or use SQLite CLI
sqlite3 ./data/pm.db ".backup ./data/pm.db.backup"
```

### Reset

To reset the database, delete the file and restart the server:

```bash
rm ./data/pm.db
pnpm start:prod   # Server will recreate and run migrations
```
