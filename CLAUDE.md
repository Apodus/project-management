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

### Capability index (phases & campaigns)

The merge train and the campaigns that build on it are summarized below — one
entry per capability with its key operational facts and a spec pointer. The full
chronological narrative lives in **`docs/capability-history.md`**; the
authoritative per-feature spec is the linked `docs/design/phase-*.md` /
`roadmaps/*.md`.

**Merge train (Phases 7.1–7.6.1)** — `docs/design/phase-7.*.md`, operator guide
`docs/integrator-deployment.md`.

- **7.2 Speculative batching** — `settings.integrator.parallelism` (≥1, **default
  1** = serial 7.1). N members rebase speculatively + verify concurrently + land
  in order; a failure invalidates only its dependent suffix.
- **7.3 Cross-repo atomicity** — a change spanning linked repos (inner Rust
  workspace + outer gitlink) lands as a unit or not at all. `settings.integrator.
linked_repos` (`[]` = single-repo). Orphaned-inner → durable incident +
  auto-rollforward. **Inner-only groups** (`synthesize_outer: true`) mint a
  synthetic outer member; a legacy two-member group whose outer member is a
  pure gitlink bump is **auto-converted** at assembly (outer rebase skipped,
  outer synthesized on live main) — always-on/fail-open, so bump-branch drift
  can't `outer_conflict`, and inner-only stays preferred (deployment guide
  §14.10 / `roadmaps/roadmap-20260710-xrepo-gitlink-bump-autoconvert.md`).
  **Gitlink normalization umbrella** generalizes that pure-bump case: a MIXED
  outer member (real source + a stale-but-reachable gitlink) has its managed
  gitlink hunk **stripped** at assembly (source-only patch applied onto live
  main, gitlink authored to the landing inner) so stale gitlinks can't
  `outer_conflict`; a lone outer change lands with inner as a no-op via
  **`synthesizeInner: true`** (the mirror of `synthesize_outer`); the sole gate
  is **ancestry** (gitlink target ancestor-of-landing-inner → normalize;
  diverged/unreachable → legible `gitlink_diverged`/`gitlink_unreachable` reject
  with a `merge_rejection` task comment, never a silent stall). Always-on/
  fail-open; new `outer_gitlink_normalized` audit action; no migration but a
  PM-server redeploy is required (deployment guide §14.11 /
  `roadmaps/roadmap-20260713-xrepo-gitlink-umbrella-widening.md`).
  **Verify contract:** the outer verify must NOT
  `submodule update --init` the gitlink path (see deployment guide §14.8).
- **7.4 Observability + break-glass** — train dashboard / per-request timeline /
  audit; on-read metrics + SLO; 5 admin-only overrides (pause/resume/
  force-release-lock/**force-land**/force-reject), each one audit row; integrator
  heartbeat; dual (SSE + Discord) alerts. The same Discord webhook also carries
  the **train event feed** — one line per pickup / land / reject / requeue /
  abandon / incident / pause, named by the linked task title with queue depth
  and pre-computed elapsed times (submits and per-attempt noise are excluded).
  Gated by `settings.webhooks.train_events_enabled` (**default on**;
  `alerts_enabled: false` mutes both). Deployment guide §15.4a.
- **7.5 Smart verification** — multi-step verify DAG (`settings.integrator.
verify_steps`) + PM-owned `verify_cache` (`cache_enabled` **default false**,
  `cache_mode off|on|shadow` **default off**). Discipline: shadow → on.
- **7.6 / 7.6.1 Conflict resolver** — on a textual rebase conflict, an opt-in
  bounded headless Claude session (`settings.integrator.resolver`, **default
  off**) reconciles + re-verifies + resubmits as a linked new MR; the **train
  re-verify is the sole landing gate**. Never discards proven work.
- **Integrator liveness (agent-facing)** — the merge-lock + merge-request reads
  now carry an `integrator` liveness block (alive/stale/down + `stall:
"integrator_down"` when the daemon is silent >90s and a queued 0-attempt request
  waits) plus a `pm_get_integrator_health` MCP tool, so an agent distinguishes
  daemon-down (restart) from slow-verify (wait) from gitlink-drain (fix branch,
  §14.11). Deployment guide §14.12 / `roadmaps/roadmap-20260714-integrator-liveness-legibility.md`.
- **Stranded verify slot** — a leased worktree slot is freed only by an explicit
  release, so a throw between acquire and release used to kill a `parallelism: 1`
  lane permanently while the daemon kept heartbeating (the 2026-08-02 nine-hour
  wedge: a request cancelled mid-verify → land 409 → throw past the release).
  Now sealed in `batch.ts` (member-slot sweep + `pool.reclaimAll()` in the drain
  `finally`, `try/finally` over the admit window, 409-tolerant terminal PM
  writes, no-batch-without-a-free-slot), surfaced as `stall: "pool_stranded"`,
  and alerted by the periodic sweep (`PM_ALERT_SWEEP_SEC`). Guide §14.15.
- **Phase timing (where the wall clock went)** — a 39-minute verify used to be
  indistinguishable from a wedge because the only two facts were "picked up" and
  "landed". `merge_phase_timings` (migration **0038**) records one row per
  **COMPLETED** phase — `duration_ms` NOT NULL, no `ended_at`, no open-row state,
  so a crashed daemon strands nothing to reconcile (contrast §14.15). The phase
  set is PARTITIONED and the partition is enforced as a type: `queue_wait`/
  `forming` are DERIVED by PM from timestamps it owns (400 if ingested), while
  `assemble`/`materialize`/`rebase`/`verify`/`land` are OBSERVED (ai_agent-only
  ingest, 202 `{recorded, adjusted}` — a non-zero `adjusted` means the EMITTER is
  wrong). Telemetry is never load-bearing: `flush()` is un-awaitable by type, no
  suspension point inside a lock hold, rows dropped past 4 outstanding POSTs, and
  no merge-path service imports the store (both sealed by test). Surfaced as a
  "Where the time goes" dashboard panel (**absent ≠ zero** — an unobserved phase
  is omitted and listed by name; the denominator is **summed measured phase time,
  not elapsed**, because forming/queue_wait and cross-repo inner/outer verify
  genuinely overlap), an In Flight phase-chip column (the RUNNING phase is
  deliberately unnamed — only completed phases exist), a lane event trace
  (`GET .../train/trace`, closed `elapsed` union so a renderer can't print "took"
  over a since-pickup number), and a Discord stopwatch line (a phase figure is
  the **UNION** of its intervals, scoped to the current trip). Degrades honestly
  on game_one's one opaque `pm-verify.bat`: exactly one `verify` bar, no
  fabricated split. No new env vars; needs a PM-server redeploy (0038) AND a
  bundle redistribute + daemon restart before any observed data exists. Guide
  §14.16 / `roadmaps/roadmap-20260803-train-phase-timing-legibility.md`.
- **Ending a doomed verify** — until 2026-08-04 only pass/fail/`verify_timeout_sec`
  ended a verify, and on game_one that ceiling is 9000s of dead lane. That day a
  worker cancelled a request 7 minutes before its build even FINISHED, and then
  the build succeeded and its MSBuild never exited (12 threads, 0 CPU, 0 IO).
  Two triggers now feed the kill seam that already existed (`killTree` always
  reaped the tree — the failure was that no kill ever FIRED; now pinned by a
  grandchild-reap test on both the abort and timeout paths).
  **`verify_cancel_poll_sec`** (**default 30**, `0` disables, ON by default): each
  in-flight member re-reads its OWN status; anything but `integrating` aborts
  within ~one interval. **Fails OPEN** — network error / 5xx / 401 / 404 /
  malformed body all leave the verify RUNNING; only a successful terminal read
  may kill. A cancel is NOT a rejection: attempt closed + suffix invalidated +
  slot freed, but never a `merge_rejection` (that blames code for a human's
  decision) and never `resetToQueued` (that resurrects cancelled work) — a new
  `cancelled` member state, and `hasLeftBatch` now replaces four hand-copied
  "has this member left the batch" predicates (one missed copy would have
  wedged `tryLand`'s land walk for the life of the batch).
  **`verify_stall_sec`** (**default 0 = OFF**, opt in per lane): kills a verify
  producing NO output for that long, categorized **`verify_stall`** (never
  `verify_timeout` — `categorize` maps SIGTERM to the latter) and never retried
  (a killed child reads TRANSIENT). Ships off because silence is WEAK evidence;
  API 400s unless `stall < timeout`. **Verify contract (§14.8):** a verify
  command MUST EXIT — MSBuild `nodeReuse` is the known offender; use
  `/nodeReuse:false` or `MSBUILDDISABLENODEREUSE=1` on the daemon env. SSE stays
  out (the subscriber reads event names only; poll is the correctness floor).
  Both knobs REST-only; no migration, but needs a PM-server redeploy + a bundle
  redistribute/daemon restart. Guide §14.17 + §14.8 /
  `roadmaps/roadmap-20260804-verify-abort-and-stall-detection.md`.
- **A race is not a verdict** — three outcomes used to END a cross-repo group
  that had nothing wrong with it, where the single-repo lane self-heals. Pre-land
  **drift** rejected the group while writing the reason "re-verify next pass";
  an inner push returning **`non_fast_forward`** — the definition of a lost race
  — rejected too. Both now **`resetGroup`** (back to `forming`, re-integrates
  against the new main, nobody notified), mirroring `onMemberFailed` kind
  `"drift"` → `resetToQueued`. A race's attempt is **cancelled, not failed** (a
  `conflict` on the author's history for a race they did not run is a lie).
  `auth`/`network`/`other` still reject — retrying those spins a lane against a
  wall. BOUNDED at 4 integration attempts, **derived from attempt rows** (no
  migration, no counter to sync); past it the reject names the LANE ("landing
  changes faster than this group can assemble"), because that is the true
  finding. An unreadable count re-queues anyway. **R2 of that campaign was
  DROPPED on a verified false premise**: `resetForAttempt` fetches + hard-resets
  to `origin/main` before EVERY attempt, so an assembly rebase is never against
  a stale base and a retry would hit the identical conflict. Guide §14.19 /
  `roadmaps/roadmap-20260815-stop-bouncing-landable-merges.md`.
- **Outcome delivery** — `settings.integrator.notify_author_on_reject`
  (**default false**): a REJECT raises an escalation addressed to the submitting
  worker so the EXISTING wake daemon delivers it into that agent's session,
  instead of a human relaying from Discord. Rejections only. **The escalation
  belongs to the WORKER, the notice is authored by the TRAIN** — the daemon
  delivers "messages not authored by the origin author", so authoring it as the
  integrator would match nothing and wake nobody, SILENTLY (pinned by test). Its
  own raise path, not `create()` (which sets authorId from the actor and whose
  FTS dedup would fold two different rejections into one thread). Ships off: it
  widens what the escalation channel carries and, with the auto-responder on,
  these become responder input. Guide §14.20.
- **Which commit the train actually judged** — two defects made the train
  integrate something OTHER than what a worker submitted, and both read to the
  author as a problem with their own code. (1) **Branch reuse replayed a stale
  tip.** `rebaseOnto` did a bare `git checkout <branch>`, which only DWIMs to
  `<remote>/<branch>` while NO local branch of that name exists — attempt 1
  creates one and `git rebase` MOVES it onto that attempt's commits, so the pool
  slot kept a local `<branch>` pinned to the rejected content FOREVER (slot
  clones are cloned once, outlive daemon restarts, nothing prunes local
  branches). `resetForAttempt`'s fetch advanced the remote-tracking ref every
  time; the checkout never consulted it. Surfaced BOTH ways: a false **reject**
  (a correct fix rejected with the error it removes) and a false **green** (the
  stale branch rebases to a no-op ⇒ `tree == base` ⇒ the no-op land guard reports
  LANDED having changed nothing). Per-SLOT, so at `parallelism > 1` it read as
  intermittent; three client notes across seven weeks, each investigated as a
  conflict in the author's change because **the rejection named no commit**. Now
  resolved **remote-first** with `checkout -B <branch> <remote>/<branch>` — a
  poisoned slot self-heals on first use, no pool wipe — falling back to the bare
  name when no remote-tracking ref exists (keeps the A4 `pm/revert-<sha>` path).
  Same defect and same fix in the resolver's `materializeConflict` (a stale
  branch there hands the agent a conflict that no longer exists); `resolveDetectRef`
  was deliberately mirroring the OLD DWIM order and was flipped to match, since
  detection reading a different commit than the rebase is its own bug class.
  (2) **A `commit_sha` pin was ignored.** `ref = branch ?? commitSha` meant a
  request carrying both integrated the branch TIP — shipping later, unverified
  commits — while `pm_request_merge` documents the pin as "pin to a SHA when you
  may keep committing on the branch while queued". Now `commitSha ?? branch`,
  matching the cross-repo lane's `memberIdentityRef`, which was always
  commitSha-first. A conflict reject now NAMES the sha it judged
  (`RebaseResult.checkedOutSha`, optional, **nothing branches on it** — the
  missing fact was never control flow). Integrator-side only: no migration, no
  PM-server change; reaches a lane on a bundle redistribute + daemon restart.
  Guide §14.21 + §14.22.
- **Cross-repo resolver executor** — `maybeOpenResolution` had two call sites,
  both single-repo conflict; the group path had NONE, so a cross-repo lane could
  not auto-resolve anything. Now `inner_conflict` resolves: a **second resolver
  pool cloned from the INNER repo** (its own slots — a resolver session can run
  an hour and must not hold a verify slot; non-fatal if unbuildable), **replay
  inputs carried on the assembly error** (`materializeConflict` needs base+ref
  and the failed assembly releases its worktrees at once), and a **group
  resubmit** as an inner-only group (a lone inner would land without the outer
  gitlink bump — the orphan the train exists to prevent; `synthesizeOuter` also
  stops the resolution re-creating the stale-bump `outer_conflict` class). The
  hook gates on eligibility AND capability separately: `gitlink_diverged` is
  rated worth resolving but a bump rebase is not a marker reconciliation, so
  `hasRemainingMarkers()` would call it done while nothing was fixed. The
  no-recursion guard moves UPSTREAM (the group resubmit takes member specs with
  no `resolvedFrom` to carry). Guide §14.18.
- **Group-path parity** — two capabilities stopped at the cross-repo boundary,
  and game_one is a cross-repo lane. (1) The kill seam: `group-integration.ts`
  passed `signal: undefined` to both pipelines, so NEITHER trigger above reached
  a grouped merge. The group lane is now a second CALLER of that machinery
  (`isTerminalForUs`/`watcherTickMs` exported, not copied); policy differs only
  in that **a group is an ATOM** — one controller, one liveness box, a kill takes
  both repos. PLACEMENT IS LOAD-BEARING: the watcher runs only around the verify
  await, because members are `queued` during assembly and `queued` reads as
  terminal after pickup — started earlier it would kill every group (pinned by
  test). A cancelled group rejects as `other` (it must leave `integrating` or the
  lane wedges, and the sibling is owed the news), a stalled one as `verify_stall`.
  (2) Resolver reach: `maybeOpenResolution` had TWO call sites, both single-repo
  `failure.kind === "conflict"`, and ZERO in the group path — the usual reason
  "auto-resolve never activates" (the other being `resolver.enabled`, **default
  false**). `resolution-eligibility.ts` now decides per assembly reason
  (`inner_conflict`/`outer_conflict`/`gitlink_diverged` YES;
  `gitlink_unreachable` NO — the commit was never pushed, no agent can
  materialize absent objects; `gitlink_mismatch` NO — a train bug, resolving it
  destroys evidence), pinned to `AssembledGroupErr` in BOTH directions plus an
  exhaustiveness guard, and its `why` strings are what the reject now tells the
  author. Opening a resolution also posts a **`merge_resolution`** comment ("do
  not start a manual fix; a linked MR is coming") — its own comment type, since
  it says the opposite of a `merge_rejection`. **NOT built: the cross-repo
  resolver executor** (resolver pool is single-repo; `merge_resolutions` is
  single-origin). Guide §14.17/§14.18 /
  `roadmaps/roadmap-20260815-group-path-parity.md`.
- **A gitlink outer main has and inner main does not** — the cross-repo invariant
  `outer main gitlink ∈ inner main` had **no detector in that direction**, so on
  2026-08-29/30 a lane died for every group for days while
  `pm_list_merge_incidents` said "No merge incidents", and every author got a
  reject that ruled their own change out before anyone had looked. Four things
  ship together, and **must** (design lock 1: the fetch fix must never be
  deployed without the gate). (1) **Automatic submodule recursion is OFF** on every clone the
  integrator owns (`fetch.recurseSubmodules=no` + `submodule.recurse=false`,
  written repo-locally on the clone lifecycle's REUSE path, so deployed slots
  self-heal at restart with no wipe). Measured, and broader than this campaign's
  name: the fetch dies when main advances across ANY managed-gitlink change while
  the slot's gitlink path is populated-but-not-an-openable-repo — which the
  materialized overlay leaves in the OUTER slot permanently — so the lane
  poisoned its own next fetch, **including after a bump the train itself
  landed**, per slot (intermittent at `parallelism > 1`). Reachability of the
  target is irrelevant to it: "the fetch succeeded" is NOT evidence the gitlink
  is sane. **Verify contract:** those keys are repo-local in the slot the verify
  command runs in, so a verify that relied on git's default on-demand recursion
  must now recurse EXPLICITLY (§14.8). (2) **The gate** —
  `checkMainGitlinkInvariant` at group assembly, before anything can author the
  pointer; three git queries (five processes) on a healthy lane. FOUR verdicts,
  because HEALTH (is the target on inner main?) and LANDING (is it in `Ri`?) are
  different questions: `heals` lets the group CARRYING the cure land, and gating
  on health would have rejected the only cure the train can take. `undecided`
  fails OPEN; a decided not-ancestor is a hard **reject, never a re-queue** —
  §14.19's "a race is not a verdict" does not apply, because a broken main does
  not self-heal between passes. (3) **`dangling_gitlink` incident** — the mirror
  direction of `orphaned_inner`, no migration (`type` is bare text), server-side
  OPEN dedup, and a new `auto_observed` resolve mode so the record never claims a
  push the train did not make. Closes three ways: a later assembly observing
  `holds`, the group that LANDS the cure (entailed by the §11 post-assembly
  assertion, **not** by step 8), or an admin. Both cures are a human's: cure 2
  changes what consumers of outer main compile, so **the train detects and
  refuses, it never picks**. (4) **A catch-all is never a diagnosis** — the
  assembly catch-all mints `assembly_error` (class `unknown`, raw git error
  first) instead of borrowing `gitlink_mismatch`'s train-bug verdict; the
  exonerating sentence is gone from every author-facing string and a source-text
  guard fails the build if it returns (it caught two drift attempts during the
  campaign). **Periodic probe DEFERRED** — the check runs at assembly, so an idle
  lane's broken main is found at the next submission; revisit triggers in the
  roadmap §S5, and a future probe must be the mirror form (a `--mirror` carries
  no `refs/remotes/*`). No migration, but a PM-server redeploy AND a bundle
  redistribute + daemon restart, **COUPLED** — the `openIncident` envelope and
  two reject categories changed, so neither half tolerates the other being old.
  Guide §14.23 + §14.8 /
  `roadmaps/roadmap-20260830-dangling-gitlink-and-honest-rejects.md`.

**Claim liveness (Campaigns C1–C3)** — `docs/design/phase-c*.md`.

- Leases (`claim_leases`) are the liveness layer beside the holder pointer.
  **As of 2026-06-15 the lease engine is ALWAYS ON** — no `PM_LEASE_MODE`; every
  claim creates a lease, a lapsed claim (`now > expiresAt + grace`) is always
  reclaimed, and a holder with no lease row reads **stale by definition**. Only
  `PM_LEASE_TTL_SEC` / `PM_LEASE_GRACE_SEC` are tunable. **C1 stable worker
  identity** (`PM_WORKER_KEY`) is the precondition — set a distinct key per
  worker or a reconnect churns identity and strands/reclaims a live claim.
- **C3 liveness surfacing** — identity-masked `claim_state` (unclaimed/live/
  stale/yours) on REST + MCP + web badges; pick-next skips live / reclaims stale;
  stale-claim alert; release-to / request-takeover handoffs (live is never
  stomped). The claims page also has a plain **Release** action.
- **A pool identity is a lease, not a freehold (2026-09-03)** — a KEYED binding
  reserved its identity **expiry-independently and forever** (C1's structural
  guard against identity-sharing), and nothing ever reaped one. That is correct
  for a bounded set of worker keys, but game*one mints a key per \_task/session*
  (`codex-rocket-fx-merge`, …), so the pool leaked one identity per session for
  seven weeks until all 35 read empty and every request 503'd. Now a reservation
  is bounded by **`PM_AGENT_BIND_GRACE_SEC`** (default 24h) and reclamation is
  **LAZY** — consulted only when no free agent exists, taking the COLDEST
  reservation first — so stable identity is untouched whenever the pool has any
  slack. Safe because minting the new claimant's token overwrites the single
  per-user `users.api_token_hash`, so the displaced worker's token stops
  validating at the instant of transfer (pinned by test). The fourth state is
  now **named**: `reserved` (≠ inactive, ≠ available) on `PoolAgentState` +
  `reservedCount`/`reclaimableCount`/`inactiveCount` on the pool summary, and
  Force Release reaches it. Every surface previously lied in the same direction
  — the per-agent view reported `claimed: false` and the UI rendered a green
  **Available** badge for an unclaimable identity, while the summary counted it
  in neither bucket and labelled the residual "inactive", so a draining pool
  read as an accounting quirk right up until it hit zero. **The upstream fix is
  in game_one, not here**: `PM_WORKER_KEY` must be per worker SLOT
  (`worker-1`…`worker-N`), not per task — recycling is the safety net.

**Escalation channel (Campaigns C1–C4)** — `roadmaps/*escalation*.md`. A
bidirectional agent-to-agent cross-team channel replacing the human relay:
`escalations` + `escalation_messages` (migrations 0029–0031), 8 MCP tools, REST +
SSE + activity-feed audit. **C2 delivery** (wake daemon `@urtela/pm-wake-daemon`

- piggyback + `pm_check_messages` + Discord needs-human bridge). **C3
  auto-responder** (`@urtela/pm-responder`, answer/diagnose-only, **ships
  `enabled=false`**, `mode off|shadow|on` default shadow). **C4 legibility** (web
  dashboard + timeline + metrics + SLA alert + FTS dedup/auto-link + rate-limit).

**Auto-implement / autonomous drive (Campaigns A1–A5)** — `roadmaps/*a[1-5]*.md`.
The responder can autonomously land a code fix or drive a full `/vision`+
`/campaign` arc, **verify-gated by the merge train** (`main` is structurally
unbreakable). Enablement = per-project **`settings.autoImplement.enabled`/`mode`**
(web-toggleable, **default off / shadow**) composed with the env master
`PM_AUTO_IMPLEMENT_ENABLED` (explicit-false ⇒ force-off-all; true/unset ⇒ defer to
DB). Deployment knobs (git url / budget / allowlist / verify) stay env. A4 adds
budget/revert/reclaim guardrails; A5 adds the off|shadow|on rollout + audit-chain
dashboard. **The whole arc ships OFF.**

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
- **Notes**: Capture, list, and get lightweight ownerless notes (bug/question/idea/tech_debt/wtf/observation) via `pm_post_note`/`pm_list_notes`/`pm_get_note`. Triage via `pm_dismiss_note` / `pm_promote_note_to_proposal` / `pm_flag_note_needs_human` — **neither dismiss nor promote is authz-gated** (any authenticated caller, author or not, human or agent), because the agent that FIXES a reported bug is rarely the one that reported it and had no way to close the note. What protects the signal is not authz: `reason` is required, `triagedBy` records who, the terminal guard stops re-dismissal, and `pm_reopen_note` (HUMAN-ONLY) makes the undo strictly harder to reach than the do
- **Search**: Full-text search across all entities
- **Updates**: Activity feed and status updates
- **Workflow**: Status transitions and workflow management
- **Write operations**: Create and modify project entities

## Environment Variables

| Variable                  | Default                 | Description                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                | (none)                  | Set to `production` for production mode                                                                                                                                                                                                                                                                                                |
| `PM_PORT`                 | `3000`                  | Server port                                                                                                                                                                                                                                                                                                                            |
| `PM_HOST`                 | `127.0.0.1`             | Bind address (`0.0.0.0` for LAN access)                                                                                                                                                                                                                                                                                                |
| `PM_DB_PATH`              | `./data/pm.db`          | SQLite database file path                                                                                                                                                                                                                                                                                                              |
| `PM_LOG_LEVEL`            | `info`                  | Logging verbosity                                                                                                                                                                                                                                                                                                                      |
| `PM_ALERT_SWEEP_SEC`      | `300`                   | How often the server re-evaluates the `train.*` alerts for every active lane, so a wedged train alerts without anyone opening the dashboard. `0` disables (on-read evaluation only, the pre-2026-08-03 behavior). Min 30.                                                                                                              |
| `PM_WEB_DIST_PATH`        | (auto-resolved)         | Override path to web dist directory                                                                                                                                                                                                                                                                                                    |
| `PM_POOL_SECRET`          | (none)                  | Agent-pool secret. Server: auto-creates the `default` pool on first claim. MCP server: auto-claims an agent identity from the pool (alternative to a static `PM_API_TOKEN`).                                                                                                                                                           |
| `PM_POOL_NAME`            | `default`               | MCP server: name of the agent pool to claim from                                                                                                                                                                                                                                                                                       |
| `PM_LEASE_TTL_SEC`        | `1800`                  | Claim lease TTL (seconds) before a lease lapses. The lease engine is always active (no on/off/shadow switch): every claim creates a lease and a lapsed claim is always reclaimed.                                                                                                                                                      |
| `PM_LEASE_GRACE_SEC`      | `86400`                 | Reclaim grace (seconds) beyond TTL before sweep                                                                                                                                                                                                                                                                                        |
| `PM_AGENT_BIND_GRACE_SEC` | `86400`                 | How long a KEYED pool binding (`PM_WORKER_KEY`) stays reserved for its worker past its claim TTL before the identity may be recycled. Reclamation is LAZY — only when a claim would otherwise fail, coldest reservation first. `off` disables it (reserved forever, the pre-2026-09 behavior); `0` recycles the moment the TTL lapses. |
| `PM_API_URL`              | `http://localhost:3000` | MCP server: API base URL                                                                                                                                                                                                                                                                                                               |
| `PM_API_TOKEN`            | (none)                  | MCP server: API authentication token                                                                                                                                                                                                                                                                                                   |
| `PM_WORKER_KEY`           | (none)                  | MCP server: stable per-worker identity key. With the pool secret, re-binds the SAME agent identity across reconnect/restart (no stranded claims). Must be DISTINCT per worker. Unset â‡’ legacy behavior (grab any free agent).                                                                                                        |

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
