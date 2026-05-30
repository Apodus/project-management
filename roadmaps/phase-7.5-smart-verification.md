# Phase 7.5: Smart Verification — Roadmap

**Goal**: p50 time-to-land drops sharply (toward the vision's <2min). Cheap failures fail in <30s (fail-fast on cheap stages). Identical re-verifies skip via a verify-result cache. Verify stops being a fixed cost.

**Design reference**: `roadmaps/phase-7-merge-train-vision.md` Phase 7.5. Builds on 7.1 (worker/integrator), 7.2 (speculative batching + the `runVerifyTask`), 7.3 (cross-repo + assembled verify), 7.4 (observability + per-step-ready metrics + the dashboard). This file is the Month 5 execution roadmap.

**Prerequisites**: Phases 7.1–7.4 complete and committed (the reference integrator with `runBatchLoop`/`runVerifyTask`/the group path; the single `verify_command`; the 7.4 metrics/health/audit/dashboard + the on-read alert + the SSE stream). 1650 tests green.

## Scope (settled with the director — this campaign is a coherent LOWER-RISK slice of the full vision)

**IN this campaign:**
1. **Verify-result caching** — PM-owned `verify_cache` table keyed by `(tree_sha, step_id, step_config_sha)` → pass/fail + log pointer + timestamp. An identical re-verify (same tree, same step config) SKIPS the run and reuses the cached verdict.
2. **Multi-stage verify pipeline** — a per-project DAG of verify steps (`verify_steps: [{id, command, depends_on[], cache_key_inputs}]`) replacing/augmenting the single `verify_command`. Cheap stages first (format→lint→typecheck), expensive last (unit→integration). FAIL-FAST: the first failing step short-circuits the pipeline (no later steps run). Independent steps (no `depends_on` edge) run CONCURRENTLY within the pipeline.
3. **Per-step metrics** — which steps take longest, which fail most, cache-hit-rate, time-saved-from-caching. Surfaced on the 7.4 dashboard (extend the metrics + the timeline).
4. **Strict + verifiable cache invalidation** — cache key = `tree_sha + step_config_sha` (the exact command + the declared `cache_key_inputs`, hashed); ANY tree OR step-config change = a cache MISS. PLUS a per-project `cache_enabled` kill-switch AND a `cache_mode: "off" | "on" | "shadow"` where SHADOW runs the verify anyway, compares the real verdict to the cached one, and ALERTS on a mismatch (the verifiable proof that no false-pass occurs before trusting the cache).

**DEFERRED to a 7.5b follow-up (NOT this campaign):**
- **Test-impact analysis** (path→test-selector mapping, run only affected tests, fall back to full suite when uncertain) — the highest false-pass risk; deferred until the cache+pipeline+false-pass discipline is proven.
- **Artifact handoff between batched verifies** (predecessor build cache feeds successor incremental build) — cross-worktree build-cache sharing; deferred.

## Architectural decisions (settled with the director before drafting)

1. **The verify cache is a PM-OWNED table** (`verify_cache`), NOT integrator-local-disk. Rationale: the cache-hit-rate is a 7.5 success criterion (dashboardable), the cache survives integrator restarts + is shared across integrator instances on a lane, and it mirrors the 7.3/7.4 PM-owns-durable-coordination-state pattern. The integrator queries the cache before running a step and writes the verdict after.
2. **The pipeline is a DAG in project settings** (`verify_steps: [{id, command, depends_on?[], cache_key_inputs?[]}]`), the Zod 3/4 mirror (canonical @pm/shared + the route Zod-4 mirror, like linked_repos/slo). BACKWARD COMPAT: an empty/absent `verify_steps` falls back to the single `verify_command` as exactly today's behavior (a degenerate one-step pipeline). game_one sets the real DAG.
3. **Strict + verifiable cache safety** — the cache key is `tree_sha + step_config_sha` (no fuzzy matching); the kill-switch `cache_enabled` + the `cache_mode` shadow harness PROVE no false-pass. The "no false-pass from stale cache" criterion is the load-bearing invariant — the shadow mode is how we earn trust in the cache before relying on it.
4. **TIA + artifact handoff are explicitly OUT** (deferred to 7.5b). This campaign ships cache + pipeline + metrics + the false-pass discipline — the bulk of the p50 win + the <30s cheap-fail goal — at lower risk.
5. **The pipeline runs INSIDE the existing `runVerifyTask`** (the 7.2 scheduler's verify seam), composing with the retry + suffix-invalidation + kill machinery. A member's "verify" becomes "run the pipeline (cache-aware, fail-fast, parallel) and produce a combined pass/fail" — the scheduler above it (admit/rebase/land/suffix-invalidate) is UNCHANGED. The cross-repo assembled verify (7.3 §5.3) similarly runs the pipeline per repo.

**Design liberties**: Implementing agents may make tactical decisions within these constraints. The PM-owned-cache, DAG-in-settings, strict+shadow cache safety, TIA/artifact-deferral, and pipeline-inside-runVerifyTask decisions are NOT negotiable.

**Risk note**: The load-bearing risk is the cache false-pass (a stale cache passing a verify that would really fail = a broken main). The cache key (tree_sha + step_config_sha) + the strict invalidation + the shadow mode are the defenses. The second risk is the pipeline composing cleanly with the 7.2 retry/suffix-invalidation/kill machinery (the verify seam is load-bearing). The DAG parallelism + fail-fast ordering is the third.

---

## Steps

### Step 1 — Month 5 design doc

Write `docs/design/phase-7.5-design.md` (target 700–1000 lines). Load-bearing; every later step references it. Cover:
- **The verify-step DAG model**: `verify_steps: [{id, command, depends_on?[], cache_key_inputs?[], timeout_sec?}]`. The DAG semantics (depends_on edges, the topological execution, independent-steps-parallel, fail-fast short-circuit). The backward-compat: empty verify_steps → a single synthetic step running `verify_command` (today's exact behavior). The validation (no cycles, depends_on references real step ids, ≥1 step when enabled).
- **The cache data model**: the PM-owned `verify_cache` table (id, project_id, resource, tree_sha, step_id, step_config_sha, result pass|fail, log_excerpt/log_url, created_at, last_hit_at, hit_count). The cache key = `(tree_sha, step_id, step_config_sha)`. The `step_config_sha` computation (a hash of the step's command + cache_key_inputs + relevant config). The lookup (hit → reuse verdict, skip the run) + the write (after a real run). Eviction/TTL policy (or none — pin).
- **The strict + verifiable invalidation**: ANY tree_sha OR step_config_sha change = miss. The `cache_enabled` kill-switch. The `cache_mode: off|on|shadow` — SHADOW runs the verify, compares the real verdict to the cached one, and EMITS a `verify.cache_mismatch` event/alert on a discrepancy (the false-pass detector). The verifiable rule: a cache entry is valid iff its (tree_sha, step_config_sha) exactly matches the current step's.
- **The pipeline executor**: how `runVerifyTask` runs the pipeline (cache-check each step → skip-if-hit, run-if-miss → write the verdict → fail-fast on the first fail → parallel independent steps). The combined result (the member passes iff EVERY step passes/hits). How it composes with the 7.2 retry (a transient step failure retries the STEP, not the whole pipeline — pin) + the kill (the AbortSignal aborts the running step) + suffix-invalidation.
- **The cross-repo composition** (7.3 §5.3): the assembled verify runs the pipeline per repo (inner pipeline + outer pipeline), AND-combined as today.
- **Per-step metrics**: how the per-step durations + cache-hit-rate + time-saved are recorded (a verify_step_runs table? or derived from verify_cache + the attempt? — pin) + surfaced on the 7.4 dashboard (the metrics bundle + the timeline gain per-step entries).
- **The REST surface**: the cache config (cache_enabled/cache_mode + verify_steps in settings), the cache-hit-rate metric (extend train/metrics), the per-step timeline (extend the timeline), maybe a GET verify-cache (debug/observability — pin).
- **SSE**: verify.cache_mismatch (the shadow-mode false-pass alert) + any per-step events.
- **PM-invariant audit**: confirm verify_steps empty → byte-identical 7.2/7.3/7.4 single-command behavior; the cache off → byte-identical (no skip).
- **Failure-mode catalog**: a stale cache (the false-pass — prevented by the key + shadow), a step DAG cycle (rejected at config), a step that hangs (per-step timeout), a cache write failure (degrade to no-cache, don't block the land), the shadow mismatch (alert + DON'T trust the cache verdict — use the real run's).

**Verify**: doc exists, internally consistent; the cache key + strict invalidation + shadow mode (the false-pass defense) + the pipeline-inside-runVerifyTask composition + the backward-compat are pinned. Adversarial review (the cache false-pass is the load-bearing correctness concern — review it hard).

### Step 2 — Shared schemas + the verify_steps/cache config (Zod 3/4 mirror)

- Add `verify_steps`, `cache_enabled`, `cache_mode` to the canonical `integratorSettingsSchema` (@pm/shared, Zod 3) + the server route LOCAL Zod-4 mirror (routes/projects.ts). The verify-step object schema ({id, command, depends_on?, cache_key_inputs?, timeout_sec?}). DAG validation (no cycles, depends_on refs real ids) — a `.refine` or service-side check. Default: empty verify_steps + cache_enabled false + cache_mode "off" = today's behavior.
- Shared schemas for the cache row + the per-step result. Regen openapi + web api-types.
- Tests: schema accept/default/reject (a cycle → 400, a bad depends_on → 400, valid DAG round-trips); the backward-compat (empty → single-command).

**Verify**: `pnpm --filter @pm/shared test` + the server project-settings tests + openapi/api-types regen pass.

### Step 3 — verify_cache table + service

- PM-owned `verify_cache` table (hand-authored migration, matching the prior style — the snapshot chain is broken, do NOT db:generate). Columns per §design. Unique index on (project_id, resource, tree_sha, step_id, step_config_sha) for the lookup.
- `verify-cache.service.ts`: `lookup({projectId, resource, treeSha, stepId, stepConfigSha})` → hit (the cached result + bump hit_count/last_hit_at) | miss; `record({...key, result, logExcerpt/logUrl})` (write-or-update). The cache-hit-rate query (for the metrics). Respect cache_enabled (off → always miss).
- Tests: lookup miss → record → lookup hit; the strict key (any of tree_sha/step_id/step_config_sha differs → miss); hit_count/last_hit_at bumped; cache_enabled off → always miss.

**Verify**: `pnpm --filter @pm/server test` cache service tests pass; the migration applies on fresh SQLite.

### Step 4 — REST: cache config endpoints + the cache-hit metric + debug GET

- The cache config is in the integrator settings (Step 2) — written via PATCH /projects/{id}. Extend train/metrics (7.4) with the cache-hit-rate + time-saved (computed from verify_cache). A GET /projects/{id}/verify-cache (debug/observability, admin or any-authed — pin) listing recent cache entries (for the dashboard/debugging). Add verify.cache_mismatch to EVENT_NAMES.
- pm-client (integrator): lookupVerifyCache + recordVerifyCache (the integrator calls these around each step) + getTrainState/the settings already give it cache_enabled/cache_mode/verify_steps.
- Tests: the cache-hit metric reflects seeded cache rows; the debug GET; the pm-client methods; verify.cache_mismatch event.

**Verify**: `pnpm --filter @pm/server test` + `pnpm --filter @pm/mcp-server test` (if any) pass; openapi regen.

### Step 5 — Integrator: the pipeline executor (DAG, fail-fast, parallel)

- A new `verify-pipeline.ts` in the integrator: `runPipeline(steps, ctx)` — topologically order the DAG, run independent steps CONCURRENTLY, FAIL-FAST (the first failing step aborts the rest), return the combined pass/fail + the per-step results. Each step runs the existing `git-ops.runVerify(step.command, ...)` in the worktree. Compose with the AbortSignal (kill aborts the running step). The empty-verify_steps → single-synthetic-step (verify_command) fallback.
- Wire `runVerifyTask` (batch.ts) to call `runPipeline` instead of the single `runVerify` — the member's verify becomes the pipeline result. The 7.2 retry composes (a transient step failure retries the step; a real step failure fails the member → suffix-invalidation as today). The cross-repo assembled verify (7.3) runs the pipeline per repo.
- Tests (the FakePmClient + real-git or fake-verify harness): a DAG runs in topo order; independent steps overlap (concurrent); fail-fast (a failing cheap step short-circuits — later steps NOT run); the empty-steps fallback == today's single-command; the AbortSignal aborts a running step; parallelism:1 + the group path still pass.

**Verify**: `pnpm --filter @pm/integrator-ref test` pipeline tests pass; the existing batch/group tests green (the verify seam swap is behavior-preserving for the single-command case).

### Step 6 — Integrator: cache-aware step execution + the shadow mode

- The pipeline executor becomes cache-aware: before running a step, compute step_config_sha + the tree_sha (the assembled/rebased tree the verify runs against — from git-ops), lookup the cache; HIT → skip the run, use the cached verdict; MISS → run, record the verdict. Respect cache_enabled (off → always run+no-record) + cache_mode.
- SHADOW mode: cache_mode="shadow" → ALWAYS run the verify (don't skip), but ALSO lookup the cache; if the cache had a verdict AND it differs from the real run → emit verify.cache_mismatch (the false-pass detector) + USE THE REAL run's verdict (never trust a mismatched cache). Record the real verdict.
- The tree_sha for the cache key: the member's rebased tree SHA (the thing the step verifies) — pin from git-ops (the rebasedTreeSha the 7.2/7.3 assembly already computes).
- Tests: cache hit skips the run (assert runVerify NOT called for the cached step); cache miss runs + records; the strict key (a tree/config change → miss → re-run); shadow mode runs + compares + emits cache_mismatch on a discrepancy + uses the real verdict; cache_enabled off → always runs.

**Verify**: `pnpm --filter @pm/integrator-ref test` cache-aware + shadow tests pass.

### Step 7 — Per-step metrics on the dashboard

- Extend the 7.4 metrics bundle with per-step data (step durations, cache-hit-rate, time-saved-from-caching) — computed from verify_cache + the per-step results. Extend the per-request timeline with per-step entries (each step: cached|run, duration, pass|fail). The web dashboard + timeline render them.
- Tests: the metrics bundle includes the per-step/cache data; the timeline shows per-step; the web renders (the 7.4 web harness).

**Verify**: `pnpm --filter @pm/server test` + `pnpm --filter @pm/web test` pass.

### Step 8 — Full-stack E2E

- Self-contained E2E (in-process PM + spawned integrator + real git remote, the 7.4 harness): (a) a multi-step pipeline runs fail-fast (a failing cheap step short-circuits — the expensive steps never run, the request rejects fast); (b) cache hit — verify a tree, then re-verify the SAME tree → the second skips (cache hit, faster, the cache-hit metric reflects it); (c) the strict invalidation — change the tree → cache miss → re-runs; (d) shadow mode — seed a stale cache entry that would false-pass → shadow runs the real verify → detects the mismatch → emits verify.cache_mismatch → uses the real (correct) verdict (NO false-pass reaches main); (e) backward-compat — empty verify_steps → the single-command path behaves exactly as 7.2.
- Tests RUN (not skipped); `pnpm test` green across the monorepo.

**Verify**: the E2E runs + all flows pass; monorepo `pnpm test` green.

### Step 9 — Documentation

- Update `docs/integrator-deployment.md`: the verify_steps DAG config, the cache (cache_enabled/cache_mode + the shadow-mode rollout recipe: shadow → observe no mismatches → flip to on), the per-step metrics, the new failure modes.
- Finalize `docs/design/phase-7.5-design.md` with a deviations subsection.
- Update `CLAUDE.md`: the smart-verification surface (the pipeline, the cache, the shadow mode).
- Update the integrator README: verify_steps + the cache in config-at-a-glance.
- Mark Phase 7.5 shipped in the vision; note TIA + artifact handoff deferred to 7.5b.

**Verify**: docs cross-checked vs shipped source; `pnpm typecheck` + server tests green.

---

## Out of scope for Phase 7.5 (this campaign)

- **Test-impact analysis** (path→test-selector, run-only-affected) — deferred to 7.5b (the highest false-pass risk; needs the cache+false-pass discipline proven first).
- **Artifact handoff between batched verifies** (predecessor build cache → successor incremental build) — deferred to 7.5b (cross-worktree build-cache sharing).
- **Multi-train lanes / permissions / advisory board** — Phase 7.6.

## Definition of done

- An identical re-verify (same tree, same step config) SKIPS via the cache (the cache-hit metric reflects it on the dashboard).
- A multi-stage pipeline fails fast on a cheap step (<30s to known-bad; the expensive steps never run); independent steps run concurrently.
- Strict invalidation: any tree OR step-config change = a cache miss (re-run). NO false-pass from a stale cache.
- The shadow mode proves no false-pass: it runs the real verify, compares to the cache, alerts on a mismatch, and always uses the real verdict — the verifiable rollout path to trusting the cache.
- Backward compatible: empty verify_steps + cache off = byte-identical 7.2/7.3/7.4 single-command behavior.
- Per-step metrics (durations, cache-hit-rate, time-saved) on the dashboard + the per-request timeline.
- All existing tests stay green; new unit + integration + E2E cover the DAG/fail-fast/parallel pipeline, the cache hit/miss/strict-invalidation, and the shadow-mode false-pass detection. Build + typecheck clean.
- Docs let an operator configure the verify DAG + roll out the cache safely (shadow → on).
