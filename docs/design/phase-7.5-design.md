# Phase 7.5 Design: Smart Verification

**Target audience**: Claude agents (design, implementation, testing) and the human director
**Created**: 2026-05-30
**Status**: Design (Step 1 of the Month 5 roadmap — the load-bearing step every later step references)
**Parent roadmap**: `roadmaps/phase-7.5-smart-verification.md`
**Vision reference**: `roadmaps/phase-7-merge-train-vision.md` (Phase 7.5)

This document is the authoritative architecture spec for Phase 7.5 (Month 5) of the merge-train build:
verify-result caching, a multi-stage verify-step DAG, fail-fast + parallel pipeline execution, strict +
verifiable cache safety, and per-step metrics. Every later step (Steps 2–9 of the roadmap) treats this file
as the single source of truth. **When this document and the roadmap disagree on a detail, this document wins.**

This doc **builds on** `docs/design/phase-7.2-design.md` (the `runVerifyTask` verify seam + the
retry/suffix-invalidation/kill machinery), `docs/design/phase-7.3-design.md` §5.3 (the per-repo assembled
verify), and `docs/design/phase-7.4-design.md` (the on-read metrics bundle + the per-request timeline + the
SSE/`EVENT_NAMES` conventions). Those documents' contracts are unchanged unless explicitly noted here. In
particular the following are inherited verbatim:

- 7.2 §6 (the structural land-gate), §7 (suffix invalidation), §8 (`resetToQueued` re-admission), §9 (the
  lane-ownership lock), §10 (the transient/real retry policy) — **none of these change.** The pipeline lives
  strictly _inside_ the per-member verify seam; the scheduler above it is untouched.
- 7.3 §5.2/§5.3 (the assembled multi-repo checkout + the per-repo AND-combined verify) — the pipeline replaces
  the single per-repo `runVerify`, AND-combined exactly as today.
- 7.4 §2/§3/§4 (the `audit_log`/`integrator_health`/`train_state` PM-owned tables — the recent precedent for a
  PM-owned coordination table), §5 (the on-read metrics bundle), §8.3 (the per-request timeline), §9 (the SSE
  `EVENT_NAMES` + flattened wire frame).

---

## 0. Reading guide

The load-bearing sections, in dependency order: **§4** (the strict + verifiable cache safety — the
no-false-pass invariant, the highest-risk section), **§3** (the `verify_cache` data model + the
`step_config_sha`), **§2** (the verify-step DAG semantics), and **§5** (the pipeline executor inside
`runVerifyTask`, the exact 7.2 seam swap). The remaining sections (§6 cross-repo, §7 metrics, §8 REST, §9 SSE,
§10 PM-invariant audit, §11 failures, §12 roadmap map) compose around those four.

The single most important invariant, stated once here and proven in §4/§5/§10:

> **No verify that would really fail is ever skipped on a cache hit. The cache key
> (`tree_sha + step_id + step_config_sha`) is exact (no fuzzy match); ANY tree-content OR step-config change is
> a MISS; and `cache_mode: shadow` runs the real verify anyway and compares — emitting `verify.cache_mismatch`
> and ALWAYS using the real verdict on any discrepancy — so the cache earns trust by demonstrated agreement
> before it is relied on. Main is never advanced on a cache verdict that the real verify would have failed.**

And the prime backward-compat invariant (§10):

> **With `verify_steps` empty/absent AND `cache_enabled: false` (the defaults), 7.5 is byte-identical to
> 7.2/7.3/7.4: one synthetic step running `verify_command`, no cache lookup, no cache write — the exact
> single-`runVerify` behavior shipped today.**

---

## 1. Goals, non-goals, and the five settled decisions

Month 5 makes verify stop being a fixed cost. Today every member runs the whole `verify_command` from scratch,
every time, even when an identical tree was verified seconds ago by a sibling or a predecessor. Verify runtime
is the throughput ceiling: 7.2 made N verifies run concurrently, but each is still the full cost, so the p50
time-to-land floor is "the slowest single verify." 7.5 attacks that floor two ways:

1. **A verify-result cache** — an identical re-verify (same tree, same step config) SKIPS the run and reuses
   the cached verdict. This collapses the cost of re-verifying a tree a sibling/predecessor already verified,
   and the cost of a re-submitted unchanged tree.
2. **A multi-stage fail-fast pipeline** — cheap stages first (format → lint → typecheck), expensive last
   (unit → integration), with the first failing step short-circuiting the rest. A bad change that breaks
   `lint` fails in <30s instead of after the full suite; independent steps run concurrently so the
   pass-the-whole-pipeline latency is the critical path, not the sum.

The success criteria (vision §7.5): **p50 time-to-land drops toward <2min; cheap failures fail in <30s;
identical re-verifies skip via the cache; the cache-hit-rate is dashboardable; and — load-bearing — there is
NO false-pass from a stale cache.**

### 1.1 The five settled decisions (non-negotiable, restated from the roadmap/director)

> 1. **The verify cache is a PM-OWNED `verify_cache` table** — NOT integrator-local-disk. Keyed by
>    `(project_id, resource, tree_sha, step_id, step_config_sha)` → pass/fail + a log pointer + timestamps. The
>    integrator queries it before a step and writes it after. Rationale: the cache-hit-rate is a 7.5 success
>    criterion (dashboardable), the cache survives integrator restarts and is shared across integrator
>    instances on a lane, and it mirrors the 7.3/7.4 "PM owns durable coordination state" pattern (the
>    precedent: `merge_incidents`, `audit_log`, `integrator_health`, `train_state` are all PM tables).
> 2. **The pipeline is a DAG in project settings** — `verify_steps: [{id, command, depends_on?[],
cache_key_inputs?[], timeout_sec?}]`, the canonical Zod-3 schema in `@pm/shared` plus the route-local
>    Zod-4 mirror (the established split, like `parallelism`/`linked_repos`/`slo`). Cheap stages first;
>    FAIL-FAST (the first failing step short-circuits); independent steps (no `depends_on` edge) run
>    CONCURRENTLY. **BACKWARD COMPAT:** empty/absent `verify_steps` → a single synthetic step running
>    `verify_command` = today's EXACT behavior (a degenerate one-step pipeline).
> 3. **Strict + verifiable cache safety.** Key = `tree_sha + step_id + step_config_sha` (no fuzzy match); ANY
>    tree OR step-config change = a MISS. A per-project `cache_enabled` kill-switch. A `cache_mode: off | on |
shadow` where SHADOW runs the verify anyway, compares the real verdict to the cached one, emits
>    `verify.cache_mismatch` on a discrepancy, and ALWAYS uses the REAL verdict. The shadow mode is the
>    verifiable proof of no false-pass _before_ the cache is trusted. "No false-pass from a stale cache" is
>    THE load-bearing invariant.
> 4. **TIA + artifact handoff are OUT** (deferred to 7.5b). This campaign = cache + pipeline + metrics + the
>    false-pass discipline. No path→test-selector mapping, no cross-worktree build-cache sharing.
> 5. **The pipeline runs INSIDE the existing `runVerifyTask`** (the 7.2 verify seam). A member's "verify"
>    becomes "run the cache-aware, fail-fast, parallel pipeline → a combined pass/fail." The scheduler above
>    it (admit / rebase / land / suffix-invalidate / retry / kill) is UNCHANGED. The cross-repo assembled
>    verify (7.3 §5.3) runs the pipeline per repo, AND-combined.

Implementing agents may make tactical decisions within these constraints. The PM-owned-cache, DAG-in-settings,
strict+shadow cache safety, TIA/artifact-deferral, and pipeline-inside-`runVerifyTask` decisions are NOT
negotiable.

### 1.2 Non-goals (deferred)

- **No test-impact analysis** (path→test-selector, run-only-affected) — 7.5b. Highest false-pass risk; deferred
  until the cache + pipeline + false-pass discipline is proven.
- **No artifact handoff** between batched verifies (predecessor build cache → successor incremental build) —
  7.5b. Cross-worktree build-cache sharing.
- **No change to the scheduler** — admit/rebase/land/suffix/retry/kill (7.2 §5–§10) are untouched. The cache +
  pipeline live strictly inside the per-member verify.
- **No change to the cross-repo land protocol** (7.3 §6) — only the _verify_ step (§5.3) gains the pipeline.
- **No multi-lane / advisory board / permissions** — Phase 7.6.

### 1.3 Why verify-cost is the throughput ceiling

7.1 serialized integration: throughput = `1 / (rebase + verify + land)`. 7.2 parallelized verify: throughput
scales toward `parallelism / verify_runtime` — but `verify_runtime` is still the full per-member cost, so the
p50 floor is "one full verify." Two facts make caching + fail-fast the right lever:

- **Re-verification is rampant.** A speculative batch member that gets invalidated (7.2 §7) re-verifies against
  the corrected base; a re-submitted unchanged tree re-verifies; a tail member whose tree equals a
  predecessor's intermediate step re-verifies cheap steps that are byte-identical. Each is a cache hit waiting
  to happen.
- **Most failures are cheap-stage failures.** A change that breaks formatting or lint fails a 5-second step,
  but today pays the full multi-minute suite before learning that. Fail-fast on cheap stages first turns the
  <30s cheap-fail goal into a structural property.

---

## 2. Canonical naming

The authoritative naming table for Phase 7.5. Every later section, test name, payload field, config key, and
module cites these verbatim. Drift is a defect. Names from 7.1–7.4 (request/attempt statuses, `VerifyResult`,
`runVerifyTask`, `EVENT_NAMES`) are unchanged and not repeated.

| Concept                     | Canonical name                                                       | Notes                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PM-owned cache table        | `verify_cache`                                                       | §3. Migration `0015_verify_cache.sql` (journal idx 15 — the latest shipped is `0014_train_state`).                                                                         |
| Pipeline config key         | `verify_steps`                                                       | snake_case in `projects.settings.integrator.verify_steps`; an array of step objects. Empty/absent = the single-`verify_command` fallback.                                  |
| Cache kill-switch           | `cache_enabled`                                                      | `projects.settings.integrator.cache_enabled`, boolean, **default `false`** (off = today's behavior).                                                                       |
| Cache mode                  | `cache_mode`                                                         | `"off" \| "on" \| "shadow"`, **default `"off"`**. `CACHE_MODES` enum in `@pm/shared`.                                                                                      |
| A step's config fingerprint | `step_config_sha`                                                    | A SHA-256 hex digest over the step's verdict-affecting config (§3.3).                                                                                                      |
| The tree the step verifies  | `tree_sha`                                                           | The member's **rebased** tree SHA (`Member.rebasedTreeSha`, 7.2 §4) — the exact tree the verify runs against. For cross-repo, the assembled inner/outer rebased tree (§6). |
| Per-step result enum        | `result ∈ { "pass", "fail" }`                                        | The cache stores the binary verdict; a richer category is derivable from the log but not the cache key.                                                                    |
| Pipeline executor module    | `packages/integrator-ref/src/verify-pipeline.ts`                     | `runPipeline(steps, ctx)` (Step 5).                                                                                                                                        |
| Shared cache/step schemas   | `verifyStepSchema`, `verifyCacheRowSchema`, `verifyStepResultSchema` | `@pm/shared` (Step 2/3).                                                                                                                                                   |
| Cache mismatch event        | `verify.cache_mismatch`                                              | `EVENT_NAMES.VERIFY_CACHE_MISMATCH` (§9).                                                                                                                                  |
| Debug cache GET             | `GET /api/v1/projects/{projectId}/verify-cache`                      | §8.4. `requireAuth` (any authed user).                                                                                                                                     |

### 2.1 Verify-step DAG semantics + validation

The `verify_steps` config (§8.1) is a DAG of verify stages. This subsection is the authoritative anchor for the
DAG's _shape_, _execution semantics_, and _config-time validation_; the executor that realizes these semantics
is §5.2, and the schema/`.superRefine` that enforces the validation is §8.1.

**The shape.** `verify_steps: [{ id, command, depends_on?[], cache_key_inputs?[], timeout_sec? }]` (the Zod
`verifyStepSchema`, §8.1). Each step has a unique `id`, a shell `command`, an optional `depends_on` list of
predecessor step ids, the optional `cache_key_inputs` (the out-of-tree fingerprint, §3.3), and an optional
per-step `timeout_sec`. An empty/absent array is the backward-compat single-synthetic-step fallback (§5.4).

**The execution semantics** (realized by §5.2):

- **Fail-fast.** The first failing step short-circuits the pipeline: no further wave starts, the member rejects
  citing that step. A cheap early step (format/lint) that fails saves the expensive suite (the <30s goal, §1).
- **Independent steps run in parallel.** Steps with no `depends_on` edge between them run concurrently
  (`Promise.all` over a topological wave, §5.2 step 2). The pass-the-pipeline latency is the critical path, not
  the sum of step durations.
- **Cheap-first ordering.** The operator orders cheap steps as roots (no `depends_on`) so they form the first
  wave; an expensive step declares `depends_on: ["lint", "typecheck"]` so it only starts once the cheap gates
  pass. The DAG shape + fail-fast make "cheap failures fail fast" a structural property, not a heuristic.
- **Combined verdict.** The member passes iff EVERY step passed (or hit-as-pass via the cache). The AND-combine
  is preserved cross-repo (§6).

**The config-time validation** (enforced by the `.superRefine`/`.refine` on `verify_steps`, §8.1; the executor
re-checks defensively, §5.2 step 1):

- **Unique ids.** Every `verify_steps[].id` is distinct. A duplicate id → `400 VALIDATION_ERROR`.
- **No dangling refs.** Every `depends_on` entry resolves to a real step `id` in the same array. A reference to
  a non-existent id → `400 VALIDATION_ERROR`.
- **No cycles.** The `depends_on` graph is acyclic, checked via a topological sort (Kahn's algorithm — if the
  topo order cannot consume every node, a cycle exists). A cyclic DAG → `400 VALIDATION_ERROR`; the operator
  cannot save it.
- An empty array stays valid (the backward-compat fallback, §5.4). A non-empty array must have ≥1 step.

This is the anchor the rest of the doc cites as "§2.1 (the DAG semantics + validation)". The validation CONTENT
also appears, in schema form, in §8.1, and the execution CONTENT in §5.2 — this subsection is the single
conceptual reference both point back to.

---

## 3. The cache data model (PM-owned)

### 3.1 The `verify_cache` table

A new Drizzle table in `packages/server/src/db/schema.ts` (roadmap Step 3). Column conventions match the
existing `merge_*`/`integrator_health`/`train_state` tables exactly: `text("id").primaryKey()` ULID, `text`
ISO-8601 timestamps (NOT integer epoch), snake_case DB column names, `.references()` FKs, indexes for every
query path. The hand-authored migration is `0015_verify_cache.sql` (the drizzle-kit snapshot chain is broken —
**do NOT run `db:generate`**; hand-author matching the `0013`/`0014` style, journal idx 15).

```ts
export const verifyCache = sqliteTable(
  "verify_cache",
  {
    id: text("id").primaryKey(), // ULID
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    resource: text("resource").notNull().default("main"),
    // ── The cache key (§3.2) ──
    treeSha: text("tree_sha").notNull(), // the rebased tree the step verified
    stepId: text("step_id").notNull(), // the verify_steps[].id this verdict is for
    stepConfigSha: text("step_config_sha").notNull(), // §3.3 — hash of the step's verdict-affecting config
    // ── The verdict ──
    result: text("result").notNull(), // "pass" | "fail" (VERIFY_RESULTS enum, @pm/shared)
    durationMs: integer("duration_ms"), // the real run's duration (for time-saved metrics §7)
    logExcerpt: text("log_excerpt"), // a short tail of the run log (same convention as merge_attempts)
    logUrl: text("log_url"), // pointer to the full log (integrator-supplied)
    // ── Bookkeeping ──
    createdAt: text("created_at").notNull(), // when this verdict was first recorded
    lastHitAt: text("last_hit_at"), // last time this row served a hit (null until first hit)
    hitCount: integer("hit_count").notNull().default(0), // number of skips this row has served
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // THE lookup index — also the strict-key uniqueness guarantee (§3.2, §4.1).
    uniqueIndex("idx_verify_cache_key").on(
      table.projectId,
      table.resource,
      table.treeSha,
      table.stepId,
      table.stepConfigSha,
    ),
    // Dashboard / debug GET (§8.4) + the cache-hit-rate metric (§7): recent rows per lane.
    index("idx_verify_cache_project_resource_created").on(
      table.projectId,
      table.resource,
      table.createdAt,
    ),
  ],
);
```

Notes:

- **`resource` is in the key** because a cache verdict is lane-scoped (`main` vs a future hotfix lane). Today
  every lane is `main`; the column future-proofs without cost.
- **`result` is the binary verdict only.** The richer reject category (7.1 `categorize.ts` output) is NOT in
  the cache — a cache hit short-circuits the _run_, and a cached `fail` re-derives its reject payload from the
  stored `logExcerpt`/`logUrl` plus a `categorize` of the (absent) live run is not needed: a cached `fail`
  drives the same member-fail path with `failureCategory: "other"` + a reason citing the cache (§5.3). The
  cache's job is the pass/fail gate, not the full categorization.
- **`durationMs`** is the duration of the _real run that produced this verdict_. It is what the "time-saved
  from caching" metric multiplies by `hitCount` (§7.2).

### 3.2 The cache key (strict, no fuzzy match)

The lookup key is the tuple `(project_id, resource, tree_sha, step_id, step_config_sha)`, enforced unique by
`idx_verify_cache_key`. A cache entry is valid for the current step **iff every component matches exactly**:

- `tree_sha` — the member's rebased tree SHA (§3.4). A git tree SHA is a content hash: two trees with the
  same SHA are byte-identical source. ANY source change → a different `tree_sha` → a MISS. This is the
  _verifiable_ tree-identity guarantee — git's own content-addressing does the work.
- `step_id` — the `verify_steps[].id`. A verdict for `lint` never serves a `unit` lookup.
- `step_config_sha` — the fingerprint of everything else that affects the verdict (§3.3). ANY config change
  (the command, a declared dependency input) → a different `step_config_sha` → a MISS.

There is **no fuzzy/partial match, no prefix match, no nearest-neighbor.** The lookup is a single
equality probe on the unique index. A hit means "this exact tree, this exact step, this exact config was
verified before, with this verdict." A miss means "run it."

### 3.3 The `step_config_sha` computation

`step_config_sha = sha256_hex(canonical_json({ command, cache_key_inputs }))`, computed by the integrator
(NOT PM — the integrator is the only party that knows the step config it is about to run). Concretely:

```ts
function stepConfigSha(step: VerifyStep): string {
  // Canonical = stable key order + no whitespace, so equal config → equal bytes → equal SHA.
  const canonical = JSON.stringify({
    command: step.command,
    cache_key_inputs: [...(step.cache_key_inputs ?? [])].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
```

What is hashed (everything that can change the verdict for a fixed tree):

- **`command`** — the exact shell command run. Change the command → change the meaning of the verdict → MISS.
- **`cache_key_inputs`** — operator-declared values that the verdict depends on _but that are not captured by
  the source tree_. These are the honest seam (§4.5): the operator lists, per step, the external inputs whose
  change should invalidate the verdict. Examples the operator would declare:
  - A toolchain version (`"node-22.4.0"`, `"rustc-1.81.0"`) — a verdict produced under a different compiler is
    not transferable.
  - A lockfile hash (`"pnpm-lock:sha256:abcd…"`) — if the test command's behavior depends on resolved deps and
    the lockfile is not part of the verified tree's relevant subset.
  - An environment marker (`"ci-image:2026-05"`).

  The integrator resolves these into stable strings and folds them into the hash. The values are **sorted**
  before hashing so declaration order is irrelevant.

What is **NOT** hashed (deliberately): `depends_on` (a DAG-shape property, not a verdict property — a step's
pass/fail does not change because its predecessor changed, only its _eligibility to run_ does), `timeout_sec`
(a hung step times out and that _is_ a fail verdict, but a timeout is a real run, not a cache concern; two runs
with different timeouts that both complete produce the same verdict, and a verdict from a longer-timeout run is
not unsafe to reuse under a shorter one — a _pass_ means the command exited 0 well within either bound), and
`tree_sha` (that is a separate key component, §3.2). `id` is a key component too, not part of the config hash.

> **PIN (the operator's responsibility, stated honestly):** the cache is only as correct as the declared
> `cache_key_inputs`. The `tree_sha` captures every _in-tree_ dependency for free (git content-addressing).
> The `cache_key_inputs` are how the operator captures _out-of-tree_ dependencies (toolchain, lockfile, env).
> If a step's verdict depends on an out-of-tree input the operator did NOT declare, a stale cache could
> false-pass — see §4.5. The shadow mode (§4.4) is precisely how that gap is detected before the cache is
> trusted.

### 3.4 The `tree_sha` source — grounded in shipped git-ops

The `tree_sha` for a member's step is the member's **rebased tree SHA**: `Member.rebasedTreeSha`
(`batch.ts:89`), set when `gitOps.rebaseOnto(baseSha, ref)` returns `RebaseSuccess.treeSha`
(`git-ops.ts:9-12`, captured as `git rev-parse HEAD` after the rebase). This is the exact tree the verify runs
against — for member 0 it is `main`'s rebased HEAD; for member K it is the speculatively-chained tree
(7.2 §4). It is computed _before_ the verify (the member is in state `verifying` only after `rebasedTreeSha`
is set, `batch.ts:1347-1348`), so the pipeline always has it in hand at lookup time.

For cross-repo (7.3 §6): each repo has its own assembled rebased tree — the inner's `Ri` and the outer's
assembled `Ro` (gitlink→Ri). Each repo's pipeline keys on _its own_ tree SHA. See §6.

### 3.5 Eviction / TTL policy

**PIN: no TTL, no automatic eviction in this campaign.** Rationale:

- The key is content-addressed (`tree_sha` is a git content hash). A cache row is _correct forever_ for its
  exact key — a tree SHA never "goes stale" in the sense of pointing at different content; it is the content.
  So there is no correctness reason to expire a row.
- The growth rate is bounded by distinct `(tree, step, config)` tuples actually verified. In a small-team LAN
  deployment (the system's stated scope) that is small. A row is ~200 bytes; a year of heavy use is megabytes.
- The `last_hit_at` / `hit_count` columns make a _future_ LRU/age sweep trivial to add if growth ever matters —
  but it is explicitly out of scope here. The honest pin: **unbounded growth is accepted for 7.5;** a sweep is
  a 7.5b/operational follow-up if the table ever grows large. (A manual `DELETE FROM verify_cache WHERE
created_at < ?` is the operator's escape hatch in the meantime; the debug GET §8.4 shows the row count.)

This is the conservative choice: never expire a _correct_ row (no false MISS that costs a re-run), and never
risk an _incorrect_ row (the key, not age, is the validity rule — §4).

---

## 4. Strict + verifiable cache invalidation (the load-bearing section)

This is the highest-risk section. A stale cache that passes a verify which would really fail = a broken main.
The cache key, the strict invalidation, the kill-switch, and the shadow mode are the four defenses. They are
designed so that **the no-false-pass invariant holds by construction, and the residual operator-gap is
_detectable_ (not silent).**

### 4.1 The verifiable rule

> **A cache entry is valid for the current step iff its `(project_id, resource, tree_sha, step_id,
step_config_sha)` exactly equals the current step's. ANY difference in tree content OR step config is a
> MISS.**

This is enforced by the unique index `idx_verify_cache_key` (§3.1): the lookup is an equality probe; a hit is
returned only on an exact-tuple match. There is no code path that returns a "close enough" row. The two
content guarantees:

- **Tree content → `tree_sha`.** Git's content-addressing means a different tree (even a one-byte change) is a
  different SHA. The cache cannot confuse two trees. This is _verifiable_ — it is git's invariant, not ours.
- **Step config → `step_config_sha`.** Any change to the command or a declared `cache_key_input` re-hashes to a
  different `step_config_sha` (§3.3) → MISS. This is verifiable for everything the operator _declares_.

### 4.2 The `cache_enabled` kill-switch

`cache_enabled: false` (the default) → the integrator **never looks up and never writes** the cache. Every step
runs, every time — byte-identical to a deployment with no cache table at all. This is the panic button: if a
cache-correctness concern is ever suspected in production, the operator flips `cache_enabled: false` (a
`PATCH /projects/{id}` settings write, §8.1) and the cache is instantly inert with zero risk. The integrator
re-reads settings each poll/drain pass (the same mechanism it reads `parallelism`/`verify_steps` through), so
the kill-switch takes effect on the next pass. **`cache_enabled: false` makes `cache_mode` irrelevant** (no
lookup, no write, no shadow comparison).

### 4.3 The `cache_mode: off | on | shadow`

When `cache_enabled: true`, `cache_mode` governs how the cache is _used_:

| Mode     | Lookup?                   | On HIT                                                                                                                | On MISS                                   | Write after run?                                                                                    |
| -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `off`    | no                        | — (never looks up)                                                                                                    | run the step                              | **no** — cache is fully inert (same as `cache_enabled:false`; `off` is the redundant explicit form) |
| `on`     | yes                       | **skip the run**, use the cached verdict, bump `hit_count`/`last_hit_at`                                              | run the step, then **record** the verdict | yes                                                                                                 |
| `shadow` | yes (for comparison only) | **run the step anyway**, then COMPARE the real verdict to the cached one (§4.4); use the REAL verdict; bump hit stats | run the step, then **record**             | yes                                                                                                 |

The intended rollout (operator recipe, §8 / docs): **`shadow` → observe zero `verify.cache_mismatch` over a
representative window → flip to `on`.** Shadow earns the trust; `on` cashes it in. `off`/`cache_enabled:false`
is the instant revert.

### 4.4 SHADOW mode — the false-pass detector (the verifiable proof)

In `shadow` mode the integrator does the full real run for every step (no skip — zero latency win in shadow,
that is the _point_), AND does the cache lookup. The comparison logic, per step:

```
realVerdict = run the step (pass|fail)
cached      = cacheLookup(treeSha, stepId, stepConfigSha)   // hit → cached.result; miss → none

if cached is a hit AND cached.result !== realVerdict:
    emit verify.cache_mismatch {                            // §9 — the alert
      projectId, resource, treeSha, stepId, stepConfigSha,
      cachedResult: cached.result, realResult: realVerdict,
      requestId, attemptId
    }
    // The discrepancy is recorded; the REAL verdict is what the member uses.

useVerdict = realVerdict        // ALWAYS the real verdict in shadow — NEVER the cached one
record(treeSha, stepId, stepConfigSha, realVerdict)   // overwrite the row with the freshly-proven verdict
```

Three properties make shadow the verifiable proof:

1. **It never trusts the cache.** The member's verdict in shadow is _always_ the real run. A mismatch cannot
   cause a false-pass because the cache verdict is never used for the gate — only for the comparison.
2. **It surfaces every discrepancy.** A `cached: pass` / `real: fail` mismatch is the exact false-pass scenario
   the cache key is supposed to prevent. If the key is correct, this never fires. If it _does_ fire, the
   operator has found a real cache-correctness gap (almost always an undeclared `cache_key_input`, §4.5) —
   **before** trusting the cache. The reverse (`cached: fail` / `real: pass`) is a false-NEGATIVE: harmless to
   correctness (it would have caused an unnecessary re-run, not a broken main) but still emitted, because it
   signals the same kind of config gap and erodes cache value.
3. **It self-heals the row.** Shadow re-records the freshly-proven verdict (overwrites the row for that key),
   so a stale entry is corrected the next time the tree is verified in shadow.

The success-criterion contract: **a representative shadow window with zero `verify.cache_mismatch` events is
the evidence that flipping to `on` is safe.** The dashboard surfaces the mismatch count (§7); the SSE event
fires an alert (§9). This is the "verifiable rollout path to trusting the cache" from the roadmap's definition
of done.

### 4.5 Walking the false-pass scenarios

| Scenario                                                                                                                                                           | Defense                                                                                    | Outcome                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The source changed (a real fix or a real break)                                                                                                                    | `tree_sha` differs (git content hash) → MISS                                               | Re-runs. No false-pass. _Verifiable_ (git's invariant).                                                                                                                                         |
| The step's command changed (e.g. `npm test` → `npm test -- --strict`)                                                                                              | `step_config_sha` differs → MISS                                                           | Re-runs. No false-pass. _Verifiable_ for declared config.                                                                                                                                       |
| A declared `cache_key_input` changed (toolchain bump, lockfile change)                                                                                             | `step_config_sha` differs → MISS                                                           | Re-runs. No false-pass. _Verifiable for what the operator declared._                                                                                                                            |
| **An UNDECLARED out-of-tree input changed** (the verdict depends on, say, a global env var or an installed binary the operator did NOT list in `cache_key_inputs`) | `step_config_sha` is UNCHANGED (the gap) → HIT on the stale verdict                        | **In `on` mode: a false-pass is possible — this is the honest limitation.** In `shadow` mode: the real run disagrees → `verify.cache_mismatch` → the gap is detected and the real verdict used. |
| A row was hand-corrupted in the DB                                                                                                                                 | The unique key still gates; a corrupted `result` would be caught by shadow on the next run | Detected in shadow; in `on` it is a trusted row (the same trust model as any cached verdict).                                                                                                   |

> **THE honest limitation, pinned for the adversarial reviewer:** in `cache_mode: on`, the cache is _exactly as
> correct as the operator's declared `cache_key_inputs`._ A step whose verdict depends on an out-of-tree input
> that the operator did not declare can false-pass on a stale cache. There is no way for the system to know
> about an undeclared dependency — that knowledge lives only in the operator's head. The system's answer is
> NOT "trust me"; it is the shadow mode: **run in `shadow` first, and any undeclared-input gap manifests as a
> `verify.cache_mismatch` _before_ you flip to `on`.** The discipline is: declare your inputs, then prove it
> with shadow, then trust. The cache key is the strict gate; the shadow mode is the verifiable proof; the
> operator's declaration is the part the system cannot do for them — and the design says so out loud rather
> than pretending the cache is magically sound.

### 4.6 Why this is safe even with the gap

The combination is sound because the _only_ residual false-pass path (an undeclared out-of-tree input) is
(a) detectable in shadow, (b) reversible via the kill-switch, and (c) under the operator's explicit control via
the declared inputs. We never claim the cache is correct under arbitrary undeclared dependencies — we claim it
is correct under the declared key, and _detectable-incorrect_ otherwise. That is a strictly stronger and more
honest position than a fuzzy cache, and it is the verifiable rollout the roadmap demands.

---

## 5. The pipeline executor — inside `runVerifyTask` (grounded in shipped code)

The pipeline replaces exactly one thing in the shipped 7.2 integrator: the single `gitOps.runVerify(...)` call
at `batch.ts:1410-1414` inside `runVerifyTask`. Everything around it — the retry loop, the
`AbortSignal`/kill, the post-await bail-guards, the `onMemberFailed`/suffix-invalidation path — is unchanged.

### 5.1 The exact seam (what runVerifyTask does today)

The shipped `runVerifyTask` (`batch.ts:1376-1530`) runs a transient-retry loop whose body is:

```ts
const verify = await gitOps.runVerify(
  verifyCommand, // member.request.verifyCmd ?? deps.defaultVerifyCommand
  deps.verifyTimeoutSec * 1000,
  { cwd: wt.path, logPath, signal }, // signal = the AbortSignal the kill aborts
);
// BAIL-GUARD (FIX 2): if a suffix invalidation killed this verify, state is
// already "invalidated" — bail.
if (member.state !== "verifying") return;
if (verify.exitCode === 0 && !verify.timedOut) {
  member.state = "verified";
  return;
}
const disposition = classifyVerifyFailure(verify); // transient vs real (7.2 §10)
// real OR cap reached → onMemberFailed (reject + suffix invalidation)
// transient under cap → completeAttempt(failed) + backoff + new startAttempt → loop
```

The single `runVerify` call **becomes** `runPipeline(...)`. The result it returns — a combined pass/fail with
the same shape `runVerifyTask` already branches on (`exitCode === 0 && !timedOut` → pass; else → classify) —
is what the rest of `runVerifyTask` consumes unchanged.

### 5.2 `runPipeline(steps, ctx)` — the executor (`verify-pipeline.ts`, Step 5)

```ts
interface PipelineStepResult {
  stepId: string;
  outcome: "pass" | "fail";
  cached: boolean; // true if served by a cache hit (no run)
  durationMs: number; // 0-ish on a hit (lookup cost); real run duration on a miss
  treeSha: string;
  stepConfigSha: string;
  verify: VerifyResult | null; // the real run's VerifyResult on a miss/shadow; null on a pure hit
}

interface PipelineResult {
  outcome: "pass" | "fail"; // member passes iff EVERY step passed/hit
  steps: PipelineStepResult[]; // per-step records (for metrics §7 + the failing step's reject payload)
  failingStep: PipelineStepResult | null; // the first step that failed (fail-fast); null on all-pass
}

async function runPipeline(
  steps: VerifyStep[], // resolved from settings.verify_steps, OR the synthetic single step (§5.4)
  ctx: {
    gitOps: GitOps; // bound to the member's worktree
    treeSha: string; // member.rebasedTreeSha
    verifyTimeoutSec: number; // default; a step's timeout_sec overrides
    signal?: AbortSignal; // the member-level signal runVerifyTask owns (one-shot teardown trigger).
    // runPipeline mints a per-pass CHILD controller forwarded from this (§5.5);
    // each runStep receives that child's signal, not this raw member signal.
    // OPTIONAL: absent on the group/cross-repo path (no member-level kill, §6).
    logsDir: string;
    attemptId: string;
    cache: CacheCtx; // { enabled, mode, lookup(), record(), emitMismatch() } — §5.3
    projectId: string;
    resource: string;
    requestId: string;
  },
): Promise<PipelineResult>;
```

The execution algorithm:

1. **Topologically order** the DAG (Kahn's algorithm over `depends_on` edges). Validation (§2.1) has already
   rejected cycles / dangling refs at config time, but the executor re-checks defensively and fails the
   pipeline (member fails, real failure) if a cycle is somehow present.
2. **Run in topological waves with fail-fast.** First, MINT a per-pipeline-pass child `AbortController`
   (`passController`) forwarded from the member-level `ctx.signal` (§5.5) — every `runStep` in this pass
   receives `passController.signal`, NOT the raw member signal. Maintain a frontier of steps whose `depends_on`
   are all _passed_ (or empty). Run all ready steps **concurrently** (`Promise.all` over the frontier, each via
   §5.3 `runStep`). When a wave settles:
   - If **any** step in the wave failed → **fail-fast**: abort the still-running steps by aborting
     `passController` (the per-pass child — NOT the member signal; see §5.5), record the first failure as
     `failingStep`, do NOT start any further wave, return `{ outcome: "fail", failingStep, steps }`.
   - Else → advance the frontier with the newly-unblocked steps; repeat.
3. **Combined result:** the member passes **iff every step passed or hit-as-pass**. The first failing step (in
   topological-then-declaration order) is `failingStep`; its `VerifyResult` (or a synthesized one for a cached
   fail, §5.3) is what `runVerifyTask` feeds to `classifyVerifyFailure` + `onMemberFailed` for the reject
   payload — so the member rejects citing the _specific_ step that failed.

**Cheap-first / fail-fast in practice:** the operator orders cheap steps with no `depends_on` so they form the
first wave; an expensive `unit` step declares `depends_on: ["lint", "typecheck"]` so it only starts after the
cheap gates pass. A `lint` failure fails the first wave, the expensive steps never start, and the member
rejects in <30s — the §1 goal, made structural by the DAG shape + fail-fast.

### 5.3 `runStep` — cache-aware single-step execution

(Pin: `ctx.signal` inside `runStep` is the per-pass CHILD `passController.signal` that `runPipeline` minted and
threaded down — §5.2 step 2 / §5.5 — NOT the raw member-level signal. Aborting `passController` on fail-fast
abort-kills the in-flight `runVerify` of every sibling in the pass; a member-level teardown still reaches it via
the forward.)

```
async function runStep(step, ctx):
  stepConfigSha = stepConfigSha(step)               // §3.3
  timeoutMs     = (step.timeout_sec ?? ctx.verifyTimeoutSec) * 1000

  if NOT ctx.cache.enabled OR ctx.cache.mode == "off":
      # No cache: run, no lookup, no record (the kill-switch / off path).
      v = ctx.gitOps.runVerify(step.command, timeoutMs, { cwd, logPath, signal: ctx.signal })
      return { outcome: PASS(v) ? "pass" : "fail", cached: false, verify: v, durationMs: v.durationMs, ... }

  hit = ctx.cache.lookup(ctx.treeSha, step.id, stepConfigSha)   # §3.2 strict probe; bumps hit_count/last_hit_at on a hit

  if ctx.cache.mode == "on" AND hit:
      # HIT → skip the run entirely, reuse the verdict.
      return { outcome: hit.result, cached: true, verify: null, durationMs: 0, ... }

  # mode == "on" + MISS  →  run + record.
  # mode == "shadow"     →  run ALWAYS (even on a hit), compare, use REAL, record.
  v = ctx.gitOps.runVerify(step.command, timeoutMs, { cwd, logPath, signal: ctx.signal })
  real = PASS(v) ? "pass" : "fail"

  if ctx.cache.mode == "shadow" AND hit AND hit.result != real:
      ctx.cache.emitMismatch({ treeSha, stepId: step.id, stepConfigSha, cached: hit.result, real, requestId, attemptId })   # §4.4 / §9

  ctx.cache.record(ctx.treeSha, step.id, stepConfigSha, { result: real, durationMs: v.durationMs, logExcerpt, logUrl })   # §3.1 write-or-update

  return { outcome: real, cached: false, verify: v, durationMs: v.durationMs, ... }
```

`PASS(v) = v.exitCode === 0 && !v.timedOut` — the **exact** predicate the shipped code uses
(`group-integration.ts:247`, `batch.ts:1423`). A cached `fail` that gates the member produces a synthetic
`VerifyResult`-shaped object (`exitCode: 1`, the stored `logExcerpt` as `stderr`, `timedOut: false`) so
`runVerifyTask`'s downstream `classifyVerifyFailure`/`onMemberFailed` works identically — a cached fail is a
**real** failure (it is a proven fail verdict, never transient — §5.6).

### 5.4 The backward-compat synthetic step (the prime invariant)

When `settings.integrator.verify_steps` is empty/absent, the pipeline is a **single synthetic step**:

```ts
const SYNTHETIC_STEP: VerifyStep = {
  id: "verify", // a fixed reserved id
  command: member.request.verifyCmd ?? deps.defaultVerifyCommand,
  depends_on: [],
  cache_key_inputs: [],
};
```

`runPipeline([SYNTHETIC_STEP], ctx)` with `cache_enabled: false` (the default) runs exactly:
`gitOps.runVerify(verifyCommand, verifyTimeoutSec*1000, { cwd, logPath, signal })` → `PASS()` → pass/fail.
That is **byte-identical** to the shipped single `runVerify` call at `batch.ts:1410`. The §10 audit enumerates
every touch point. game_one sets a real multi-step `verify_steps`; an unconfigured deployment keeps the exact
7.2/7.3/7.4 behavior.

### 5.5 Composition with the 7.2 retry / kill / suffix machinery (UNCHANGED)

The pipeline lives _inside_ `runVerifyTask`; the machinery around it is preserved verbatim:

- **The kill (`AbortSignal`) — a member-level teardown signal + a per-pass child for fail-fast.**
  `runVerifyTask` already owns the member-level `AbortController`/`signal` (7.2 §16 note 2: the killable verify
  is driven by `controller.abort()` → `runVerify`'s `signal` option → `killTree`). This member-level controller
  is created ONCE before `runVerifyTask` (`batch.ts:1067`) and its signal is **stable across the transient
  retry loop** (the loop is inside `runVerifyTask`; the signal survives retries, `batch.ts:1401-1402`). An
  `AbortSignal` is one-shot/irreversible — once aborted it stays aborted. So fail-fast must NOT abort it (a
  transient retry would re-enter with an already-aborted signal and every step would `killTree` at spawn,
  burning all retries in ms). Instead:

  **PIN (the per-pass child controller):**
  - The member-level `AbortSignal` is the **suffix-invalidation / kill teardown trigger** — one-shot, exactly as
    today (`batch.ts:1067`). A suffix-invalidation kill (`member.verify.kill()`) aborts it and tears the whole
    in-flight pipeline pass down at once (correct: the member is being invalidated/killed).
  - EACH `runPipeline` pass **mints its own per-pass CHILD `AbortController` (`passController`), forwarded from
    the member signal:** `const passController = new AbortController(); if (ctx.signal?.aborted)
passController.abort(); else ctx.signal?.addEventListener("abort", () => passController.abort(), { once:
true });` (or `AbortSignal.any([ctx.signal])` on Node ≥ 20). Every step's `runVerify` in that pass receives
    `passController.signal`, NOT the raw member signal.
  - **Fail-fast aborts the CHILD** (`passController`) → it kills ONLY this pass's still-running siblings. The
    member-level signal stays the **un-fired** teardown trigger.
  - A member-level teardown (suffix-kill) still propagates into the running pass via the forward
    (member signal aborts → `passController` aborts → the in-flight step `killTree`s), so the single kill path
    is preserved — no new member-level kill plumbing.
  - Because `passController` is **fresh per `runPipeline` call**, a transient retry (which re-calls `runPipeline`
    over the same tree/config) gets an **un-aborted** child signal and CAN actually re-run its steps. This is
    what preserves the 7.2 transient-retry contract (decision #5) UNCHANGED. (The single-synthetic-step
    backward-compat case is unaffected: with no siblings there is no fail-fast abort to fire — which is why
    §10's parity audit stays clean; this child-controller distinction only matters with ≥2 concurrent steps.)

- **The transient retry (7.2 §10).** The retry loop stays _outside_ the pipeline body, exactly where it is
  today. **PIN: a transient failure retries at the STEP granularity, not the whole pipeline.** When a step's
  `runVerify` returns a transient signal (`classifyVerifyFailure → "transient"`, e.g. a spawn `ENOENT`, an
  external SIGKILL not from our timeout — 7.2 §10.1), `runStep` returns a transient disposition; the pipeline
  surfaces it as the failing step, and `runVerifyTask`'s existing retry loop re-runs — **but the re-run is
  scoped to the failed step's re-execution within a fresh pipeline pass over the same tree, same step
  config.** Because the cache is keyed on `(tree, step, config)` and the tree/config are unchanged across a
  retry, the already-passed cheap steps **hit the cache on the retry** (in `on` mode) — so a transient failure
  in `unit` re-runs `unit` cheaply, not the whole suite. A transient retry NEVER re-keys the cache (same
  `tree_sha`, same `step_config_sha`) and NEVER records a transient outcome to the cache (only the _final_
  pass/fail verdict of a step is recorded; a transient is not a verdict — §5.6). The backoff (1s/5s/15s, cap 3)
  and the abortable-sleep + post-sleep bail-guard (7.2 §16 note 5) are unchanged.
- **The suffix invalidation (7.2 §7).** A **real** pipeline fail → the member fails → `onMemberFailed` →
  reject + structural suffix-invalidation, **exactly as today**. The pipeline changes _how the member's verify
  verdict is computed_, not _what happens when it fails_. The post-await bail-guards (FIX 1/FIX 2, 7.2 §16
  note 4) still protect the member: after `runPipeline` returns, `runVerifyTask` re-checks
  `member.state !== "verifying"` before acting (a suffix-kill mid-pipeline already flipped state to
  `invalidated`, and the aborted steps resolved cleanly via the abort → `killTree` → `finish()` path, 7.2
  §git-ops). No double-reject.

### 5.6 Transient vs cache interaction (pinned, subtle)

- A **transient** step failure (7.2 §10) is NOT a verdict. It is NOT recorded in the cache (no `record` call on
  a transient disposition). Only a _settled_ `pass`/`fail` (the command exited 0, or exited non-zero on its own
  / hit its own timeout) is a cache verdict.
- A **cached `fail`** served in `on` mode is a **real** failure, never transient — it is a previously-proven
  fail verdict. So a cached fail goes straight to `onMemberFailed` (no retry); it does not loop the transient
  machinery. (Rationale: the original real run already exhausted any transient retries before recording a
  `fail`; the cache stores the _final_ verdict.)
- A step's own `verify_timeout` (`killedByTimeout === true`, 7.2 §10.3) is a **real** fail and IS a cacheable
  `fail` verdict — a tree+step that times out deterministically should not be re-run on every encounter.

---

## 6. Cross-repo composition (7.3 §5.3)

7.3's assembled verify runs the inner and outer repo verifies concurrently against the assembled checkout
(inner@Ri + outer@(gitlink→Ri)), AND-combined: the group passes iff EVERY repo's verify passes
(`group-integration.ts:385-398`, `PASS(resI) && PASS(resO)`). 7.5 replaces each repo's single `runVerify` with
**a per-repo pipeline run:**

```
// The shipped group runVerify calls (group-integration.ts:386-393) pass NO signal — groups have no
// member-level kill. So ctx.signal is absent for the group path; each runPipeline simply mints its own
// per-pass child controller from an un-aborted (or absent) parent (§5.5) and fail-fast aborts that child.
[resI, resO] = await Promise.all([
  runPipeline(innerSteps, { gitOps: asm.innerGitOps, treeSha: Ri, signal: undefined, cache: {…inner…}, ... }),
  runPipeline(outerSteps, { gitOps: asm.outerGitOps, treeSha: Ro, signal: undefined, cache: {…outer…}, ... }),
])
groupPass = (resI.outcome === "pass") && (resO.outcome === "pass")   // the AND is preserved
```

Pinned facts:

- **The per-pass child controller, group edition (§5.5).** Each per-repo `runPipeline` mints its OWN per-pass
  child `AbortController` regardless of whether a parent member signal is present — and on the group path the
  parent signal is **absent** (the shipped group runVerify calls pass no signal: groups have no member-level
  kill, `group-integration.ts:386-393`). So the forward-from-parent is a no-op for the group path and each
  repo's pipeline fail-fast aborts strictly its own child controller. This is fully consistent with the
  single-lane path (§5.2/§5.5): the child controller is always per-pass, the parent member signal is
  optional/absent here.

- **Each repo has its own `verify_steps`.** A linked repo declares its pipeline; the inner runs its DAG
  (e.g. `rynx` tests), the outer runs its DAG (integration tests). Where the steps live: per-repo
  `verify_steps` is read from the linked-repo config (the natural extension of `linked_repos[].` — the
  inner/outer each carry their own steps; absent → the synthetic single step over that repo's verify command,
  §5.4). The inner pipeline keys on `tree_sha = Ri`; the outer on `tree_sha = Ro` (the assembled outer tree
  with the gitlink→Ri committed). Two distinct `tree_sha`s → two independent cache namespaces, naturally
  partitioned by the existing key (the `resource` could distinguish them, or the tree SHAs alone do — since Ri
  and Ro are different SHAs, no collision is possible even within one `resource`).
- **The AND is unchanged.** `runPipeline` returns a combined `outcome` per repo; the group's pass is the AND of
  the two combined outcomes — exactly the shipped `innerPass && outerPass`. Any repo's pipeline failing → the
  whole group fails verify → 7.3 §6.6 failure point (c): reject the group, nothing landed. The verify-gate
  invariant (7.3 R1) is preserved: a push happens only after the _combined assembled pipeline_ passed.
- **Fail-fast within a repo, both repos still run.** Within each repo the pipeline fails fast; across repos the
  shipped code runs both to settlement (7.3 §5.3: "BOTH must settle … so each attempt gets a truthful
  outcome") — that is preserved. A repo's pipeline that fails fast settles fast (a cheap inner fail returns
  quickly), but the sibling repo's pipeline is not aborted by the other repo's failure (the cross-repo AND
  wants both per-repo truths for the per-member attempt rows). This matches the shipped `Promise.all` that does
  not abort the sibling.
- **Group recovery (7.3 §7).** The roll-forward recovery's assembled-tree verify (`group-recovery.ts:244`,
  the R1 verify-gate on the gitlink→O assembled tree) similarly becomes a per-repo pipeline run, cache-aware,
  AND-combined. Same substitution, same gate.

---

## 7. Per-step metrics

### 7.1 What is recorded and where

**PIN: no new `verify_step_runs` table.** The per-step metrics are derived from two existing sources, mirroring
7.4's on-read aggregation (no pre-aggregation, §7.4 §5.1):

1. **The `verify_cache` table** — for the **cache-hit-rate** and **time-saved** metrics. Every cache row
   carries `hit_count`, `last_hit_at`, `created_at`, `duration_ms`. These are queryable per `(project,
resource)` lane and per `step_id`.
2. **The per-step results in the SSE/timeline stream** — for **per-step durations + pass/fail** on a _specific_
   request. The integrator already POSTs per-step entries (§7.3); they ride the timeline.

The rationale for deriving rather than adding a table: a dedicated per-run table would duplicate what the
`verify_cache` rows (verdicts + durations + hit counts) and the per-request attempt/timeline already carry, and
7.4 established the on-read-derive precedent (`metrics.service` computes everything from the live tables at read
time). The cache-hit-rate is literally `sum(hit_count) / (sum(hit_count) + count(rows))` over the window — a
pure `verify_cache` aggregation.

### 7.2 The metric definitions (extending the 7.4 bundle)

The 7.4 `metricsBundleSchema` (`@pm/shared`, §7.4 §5.6) gains a `verify` sub-block, computed in
`metrics.service.computeMetrics` (the same windowed, JS-ISO-cutoff pattern, 7.4 §16 note 4):

```jsonc
"verify": {
  "cache_enabled": true,
  "cache_mode": "on",
  "cache_hit_rate": { "ratio": 0.61, "hits": 122, "lookups": 200 },   // hits / (hits + misses) over the window
  "time_saved_ms": 5_400_000,                                          // Σ(hit_count × duration_ms) of hit rows
  "per_step": [
    { "step_id": "lint",      "runs": 40, "cached": 60, "pass_rate": 0.95, "avg_duration_ms": 4200,  "fail_count": 2 },
    { "step_id": "typecheck", "runs": 38, "cached": 50, "pass_rate": 0.97, "avg_duration_ms": 11000, "fail_count": 1 },
    { "step_id": "unit",      "runs": 30, "cached": 20, "pass_rate": 0.90, "avg_duration_ms": 95000, "fail_count": 3 }
  ],
  "cache_mismatches": 0     // count of verify.cache_mismatch in the window (the shadow false-pass-gap signal)
}
```

- **`cache_hit_rate`** — over the metrics window: `hits = Σ hit_count` for rows whose `last_hit_at` is in the
  window; `lookups = hits + misses`, where misses are inferred from rows `created_at` in the window (a row's
  creation = a miss that ran). Returns `{ ratio, hits, lookups }`; null ratio when `lookups === 0` (the 7.4
  null-percentile convention).
- **`time_saved_ms`** — `Σ (hit_count × duration_ms)` over hit rows in the window: each hit skipped a run that
  would have cost `duration_ms`. This is the headline "the cache bought you N minutes" number.
- **`per_step`** — per `step_id`: run-count, cache-skip count, pass-rate, avg duration, fail-count. "Which
  steps take longest / fail most" — the vision's per-step observability.
- **`cache_mismatches`** — the count of `verify.cache_mismatch` over the window. In a healthy `on`-mode
  deployment this is 0; a non-zero value during `shadow` is the gating signal (§4.4).

### 7.3 The per-request timeline (extending 7.4 §8.3)

7.4's `timelineView` (the ordered state history of a request: row boundaries + attempts + audit + incidents) is
extended with **per-step entries** under each `verifying` attempt segment. The integrator supplies the per-step
results — the cleanest seam is to extend the per-attempt `merge.attempt.completed` payload (or a small
dedicated relay, §8.3) with the `PipelineStepResult[]` so the timeline shows, per attempt:

```
attempt #2  verifying → failed   base=R0  tree=R1
  ├─ lint       cached  ✓  0ms      (hit)
  ├─ typecheck  ran     ✓  11.0s
  └─ unit       ran     ✗  42.3s    ← failing step (fail-fast: integration NOT run)
```

Each per-step entry: `{ step_id, cached: bool, outcome: pass|fail, duration_ms, log_url? }`. The timeline view
renders them under the attempt; a fail-fast short-circuit is visible (later steps simply absent). This is the
"per-step timeline gain" the roadmap asks for. The web dashboard (7.4 §10) renders the `verify` metric block on
the train dashboard and the per-step rows in the `MergeRequestTimeline` component.

---

## 8. The REST surface

All endpoints mount under `/api/v1/`. Envelopes follow the shipped convention (`{ data }` / `{ error: { code,
message } }`, 7.1 §8). The cache _config_ rides the existing project-settings endpoint; the cache _metrics_
extend the 7.4 train metrics; one new debug GET is added.

### 8.1 Cache + pipeline config (via the existing project-update endpoint)

`verify_steps`, `cache_enabled`, `cache_mode` are written via the EXISTING `PATCH /api/v1/projects/{id}` by
nesting them in `settings.integrator` (the 7.4 §8.7 / SLO precedent — no new endpoint). The canonical Zod-3
schema is `integratorSettingsSchema` (`packages/shared/src/schemas/project.ts`); the Zod-4 mirror is the local
`integratorSettingsSchema` in `routes/projects.ts:37` (the established split). The additions:

```ts
// in integratorSettingsSchema (both the @pm/shared Zod-3 and the routes/projects.ts Zod-4 mirror):
cache_enabled: z.boolean().default(false),
cache_mode: z.enum(["off", "on", "shadow"]).default("off"),
verify_steps: z.array(verifyStepSchema).default([]),
```

with `verifyStepSchema`:

```ts
export const verifyStepSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  depends_on: z.array(z.string().min(1)).default([]),
  cache_key_inputs: z.array(z.string().min(1)).default([]),
  timeout_sec: z.number().int().min(1).optional(),
});
```

The DAG validation (§2.1) is a `.superRefine`/`.refine` on `verify_steps` (unique `id`s; every `depends_on` ref
resolves to a real `id`; no cycles via a Kahn's-algorithm check; ≥1 step when the array is non-empty). A cycle
or a dangling `depends_on` → a `400 VALIDATION_ERROR` on the settings write — the operator cannot save a broken
DAG. (An empty array stays valid — it is the backward-compat fallback.) **PIN:** the `enabled`-requires-
`verify_command` refine (`project.ts:51`) stays; with `verify_steps` empty, `verify_command` is still the
fallback source, so the existing refine is correct as-is. When `verify_steps` is non-empty, `verify_command`
becomes optional (the steps carry their own commands) — the refine is extended to:
`!enabled || ((verify_command || verify_steps.length > 0) && worktree_root)`.

### 8.2 The cache-hit-rate metric (extend `train/metrics`)

The 7.4 `GET /api/v1/projects/{projectId}/train/metrics` (`requireAuth`, §7.4 §8.1) returns the metrics bundle;
7.5 adds the `verify` sub-block (§7.2) to that same response. No new endpoint — the dashboard gets cache-hit-
rate + time-saved + per-step + mismatch-count in the one existing read.

### 8.3 The per-step timeline (extend the timeline)

`GET /api/v1/merge-requests/{id}/timeline` (`requireAuth`, 7.4 §8.3) gains per-step entries under each attempt
(§7.3). The integrator supplies them by extending the per-attempt completion payload (the
`completeAttempt`/`merge.attempt.completed` body) with the `PipelineStepResult[]`, OR via a thin
`requireIntegrator` relay if the attempt body proves awkward (a Step-7 tactical choice, consistent with 7.2's
relay-endpoint precedent). Either way: **PM stores the per-step results** so the timeline survives an
integrator restart — the cleanest home is a `steps` JSON column on `merge_attempts` (a `text(..., { mode:
"json" })` array, the same convention as `failed_files`), populated at `completeAttempt`. (Pin: this is one
small additive nullable column on `merge_attempts`; it is NOT a new table, and it is absent on 7.4 attempts →
the timeline degrades to the 7.4 view, preserving compat.)

### 8.4 The debug verify-cache GET

| Method | Path                                        | Query                                                   | Response                                         | Authz         |
| ------ | ------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------ | ------------- |
| GET    | `/api/v1/projects/{projectId}/verify-cache` | `resource?`, `step_id?`, `result?`, `page?`, `perPage?` | `200 { data: verifyCacheRowView[], pagination }` | `requireAuth` |

Lists recent `verify_cache` rows (newest-first by `created_at`, paginated) for debugging and the dashboard's
cache panel. **PIN authz: `requireAuth` (any authenticated user) — NOT admin-only.** Rationale: a cache row is
operational telemetry (a tree SHA + a verdict + hit counts), not a break-glass secret; it parallels the metrics
GET (`requireAuth`), not the audit log (`requireAdmin`). It carries no actor-accountability data, so the
admin-tier gate that the audit log warrants (7.4 §8.4) does not apply. Filters map to a
`verify-cache.service.list`. This is the only NEW endpoint in 7.5.

### 8.5 The integrator pm-client methods

The integrator's `PmClient` (the `pm-client.ts` it calls PM through) gains:

- `lookupVerifyCache({ projectId, resource, treeSha, stepId, stepConfigSha })` → `{ result, durationMs,
logExcerpt, logUrl } | null` (a hit bumps `hit_count`/`last_hit_at` server-side, §3.1).
- `recordVerifyCache({ projectId, resource, treeSha, stepId, stepConfigSha, result, durationMs, logExcerpt,
logUrl })` → write-or-update (upsert on the unique key).
- `emitVerifyCacheMismatch({ projectId, resource, treeSha, stepId, stepConfigSha, cachedResult, realResult,
requestId, attemptId })` → a thin `requireIntegrator` relay that emits `verify.cache_mismatch` (§9), no
  persistence (the 7.2 batch-marker relay precedent).

These back onto two small internal endpoints (a cache lookup/record pair, `requireIntegrator`-gated, ai_agent —
mirroring the 7.1 merge-request integrator endpoints) plus the mismatch relay. The cache config
(`cache_enabled`/`cache_mode`/`verify_steps`) reaches the integrator via the **existing** settings read it
already does for `parallelism`/`verify_command` (the integrator's config bootstrap reads
`projects.settings.integrator`) — no new config endpoint.

---

## 9. SSE events

One new event in `EVENT_NAMES` (`packages/server/src/events/event-bus.ts` — appended to the existing `merge.*`
/ `train.*` blocks, after the 7.4 `AUDIT_RECORDED`):

```ts
// Smart-verification (Phase 7.5 — the shadow-mode false-pass detector)
VERIFY_CACHE_MISMATCH: "verify.cache_mismatch",
```

- **`verify.cache_mismatch`** — emitted (relayed, not persisted) when shadow mode finds a cached verdict that
  disagrees with the real run (§4.4). It is the false-pass alarm. Payload (the body the integrator POSTs to the
  relay; PM re-emits onto the event):

  | Field                                                        | Meaning                                                              |
  | ------------------------------------------------------------ | -------------------------------------------------------------------- |
  | `projectId`, `resource`                                      | the lane (so the SSE project filter, `routes/events.ts`, scopes it)  |
  | `treeSha`, `stepId`, `stepConfigSha`                         | the exact cache key that mismatched                                  |
  | `cachedResult` (`pass`/`fail`), `realResult` (`pass`/`fail`) | the disagreement — `cached: pass / real: fail` is the dangerous case |
  | `requestId`, `attemptId`                                     | the member that surfaced it                                          |

  `entityType: "verify_cache"`; the flattened wire frame (7.4 §9 / `routes/events.ts`) projects `action =
"cache_mismatch"` + the key/result fields as extras (the 7.2 §13.1 pass-through pattern), so the dashboard
  can flash the cache panel and count the event into `cache_mismatches` (§7.2). This is a NON-persisted relay
  (the 7.2 batch-marker / 7.4 alert precedent) — the durable record of the mismatch is implicit in the cache
  row being re-recorded with the corrected verdict (§4.4) plus the metric count.

**No per-step "step started/finished" SSE events.** The per-step granularity is delivered via the timeline
(§7.3, an on-read GET) and the metrics bundle (§7.2), NOT a high-frequency per-step event storm. A multi-step
pipeline over a busy batch would emit a flood of step events with no consumer that needs them live — the
dashboard reconstructs per-step state from the timeline GET on demand, mirroring 7.2's decision to NOT add a
batch table and instead reconstruct from events/reads. The only NEW live event is the mismatch alarm, which is
rare and load-bearing.

---

## 10. PM-invariant audit (the prime backward-compat invariant)

**Conclusion up front: with `verify_steps` empty/absent AND `cache_enabled: false` (the shipped defaults), 7.5
is byte-identical to 7.2/7.3/7.4.** Every touch point below degrades to exactly the shipped single-command, no-
cache behavior. Each is verified against source.

| Touch point                                     | 7.5 behavior with defaults (empty steps + cache off)                                                                                                                                                                                                    | Identical to 7.2/7.3/7.4?                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runVerifyTask` (`batch.ts:1410`)               | `runPipeline([SYNTHETIC_STEP], { cache.enabled:false })` → one `runVerify(verify_command, …)` → `PASS()` (§5.4)                                                                                                                                         | **Yes** — the synthetic step's single `runVerify` is the same call with the same args; the `PASS` predicate is the shipped `exitCode===0 && !timedOut`. |
| The transient-retry loop (`batch.ts:1405-1490`) | Untouched — wraps `runPipeline` instead of `runVerify`; on a one-step pipeline a transient surfaces identically                                                                                                                                         | **Yes** — same backoff/cap/abortable-sleep/bail-guards.                                                                                                 |
| The kill / `AbortSignal` (7.2 §16 note 2)       | The member `signal` forwards into the pass's child controller, whose signal threads into the synthetic step's `runVerify`; with one step there is no sibling to fail-fast-abort, so the child is a transparent pass-through of the member signal (§5.5) | **Yes** — one kill path, behaviorally unchanged; the child controller is inert for a single-step pass.                                                  |
| Suffix invalidation / `onMemberFailed` (7.2 §7) | A one-step real fail → `onMemberFailed` exactly as today                                                                                                                                                                                                | **Yes** — the failure path is untouched.                                                                                                                |
| The land-gate / scheduler (7.2 §5/§6/§9)        | Untouched — the pipeline is below the verify seam                                                                                                                                                                                                       | **Yes** — no scheduler change.                                                                                                                          |
| Cross-repo assembled verify (7.3 §5.3)          | `runPipeline` per repo with one synthetic step each → `PASS(resI) && PASS(resO)`                                                                                                                                                                        | **Yes** — the AND over two single-`runVerify` calls is the shipped behavior.                                                                            |
| Cache table / lookup / write                    | `cache_enabled:false` → no lookup, no write, no rows created                                                                                                                                                                                            | **Yes** — the table exists but is never touched; a fresh DB with the `0015` migration but no cache config behaves as a 7.4 DB.                          |
| Metrics bundle (7.4 §5.6)                       | The `verify` sub-block reports `cache_enabled:false`, empty per-step (or the single `verify` step), `cache_hit_rate` null                                                                                                                               | **Additive** — a new optional block; the 7.4 fields are unchanged.                                                                                      |
| Timeline (7.4 §8.3)                             | The `merge_attempts.steps` column is null on 7.4-style attempts → the timeline shows the attempt without per-step rows                                                                                                                                  | **Additive** — degrades to the 7.4 view.                                                                                                                |
| SSE (`EVENT_NAMES`)                             | `verify.cache_mismatch` only fires in shadow mode on a discrepancy → never with cache off                                                                                                                                                               | **Additive** — a new event name; no existing event changes.                                                                                             |
| Project settings schema                         | `verify_steps`/`cache_enabled`/`cache_mode` all default to empty/off                                                                                                                                                                                    | **Additive** — defaults reproduce the prior settings shape.                                                                                             |

The enabling facts: the pipeline is a **strict inner substitution** at one call site
(`runVerify → runPipeline`), the synthetic-step path makes the empty config produce the _same call with the
same arguments_, and the cache is **gated behind `cache_enabled`** (default false) so it is fully inert by
default. No scheduler, land-gate, suffix, retry, kill, or cross-repo-land contract changes. The only PM schema
additions are the new `verify_cache` table (untouched when the cache is off) and one nullable `steps` JSON
column on `merge_attempts` (null on default attempts). Both are additive; neither alters a 7.4 query.

---

## 11. Failure-mode catalog

Extends 7.2 §15 / 7.3 §11 / 7.4. (symptom / defense / outcome):

| Failure                                                                   | Symptom                                                                                                               | Defense                                                                                                                                                                                                                                                                                                                          | Outcome                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stale cache (the false-pass)**                                          | A cached `pass` would be served for a tree/step that should fail                                                      | The strict key (`tree_sha + step_id + step_config_sha`, §4.1) makes any in-tree or declared-config change a MISS; an UNDECLARED out-of-tree input is the residual gap (§4.5), detected by **shadow mode** (§4.4) emitting `verify.cache_mismatch` before `on` is trusted. The `cache_enabled` kill-switch is the instant revert. | No false-pass for declared inputs; the undeclared-input gap is _detectable in shadow_ and the honest documented limitation. Main is never advanced on a verdict the real verify would fail (shadow uses the real verdict).                      |
| **A DAG cycle**                                                           | `verify_steps` has a `depends_on` cycle                                                                               | Rejected at config time: the `.superRefine` Kahn's-algorithm check (§2.1 / §8.1) returns `400 VALIDATION_ERROR` on the settings write; the executor re-checks defensively (§5.2 step 1) and fails the pipeline if one somehow reaches it                                                                                         | The operator cannot save a cyclic DAG; a degenerate runtime cycle fails the member (real failure), never hangs.                                                                                                                                 |
| **A step hangs**                                                          | One step's command never exits                                                                                        | The per-step `timeout_sec` (or the default `verify_timeout_sec`) fires → `runVerify`'s own deadline timer → `killTree` (the shipped 7.2 timeout path) → `timedOut: true` → that step is a **real** fail (`verify_timeout`, §5.6) → fail-fast aborts the rest → member rejects                                                    | That step rejects the member; siblings in the wave are aborted via the shared signal; the dependent suffix re-admits (7.2 §7). A hung step cannot stall the whole batch — it is bounded by its own timeout.                                     |
| **A cache write fails**                                                   | `recordVerifyCache` errors (PM transiently down, DB locked)                                                           | **Degrade to no-cache, never block the land.** The integrator treats a record failure as a no-op warning (the verdict the member uses is the REAL run's, already in hand — the record is a side effect, not on the critical path). The next encounter is simply a MISS and re-runs.                                              | The member lands/rejects on its real verdict regardless; the cache is best-effort. A write failure NEVER fails a member or blocks a land. (Pin: the lookup is also best-effort — a lookup error is treated as a MISS → run, never a false hit.) |
| **A shadow mismatch**                                                     | Shadow finds `cached !== real`                                                                                        | Emit `verify.cache_mismatch` (§9) + **use the REAL verdict** (§4.4) + re-record the corrected verdict                                                                                                                                                                                                                            | The member uses the correct (real) verdict — no false-pass. The operator sees the alarm and (almost always) finds an undeclared `cache_key_input` to add before flipping to `on`.                                                               |
| **An undeclared real dependency** (the operator's `cache_key_inputs` gap) | A step's verdict depends on an out-of-tree input not in `cache_key_inputs`; in `on` mode a stale row could false-pass | The HONEST limitation (§4.5). The defense is procedural-but-verifiable: run `shadow` first → the gap surfaces as a `verify.cache_mismatch` → declare the missing input (re-hashes `step_config_sha` → the stale row is now a MISS) → re-shadow to zero mismatches → flip `on`. The kill-switch is always available.              | Detectable in shadow, never silent. The campaign ships this as a documented operator responsibility + the shadow tooling to discharge it, not as a hidden assumption.                                                                           |
| **A cache row for a stale step config lingers**                           | After a command/input change, old rows remain                                                                         | They are simply never hit (the new `step_config_sha` doesn't match) — they are inert dead weight, not incorrect                                                                                                                                                                                                                  | No correctness impact; eventual manual cleanup (§3.5, no TTL). The new config's rows accumulate; the old config's rows are unreachable.                                                                                                         |

---

## 12. Implementation-roadmap pointer (Steps 2–9)

Every later step finds its contracts in this document:

| Roadmap step                                                                 | Sections of this doc                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Step 2** — Shared schemas + `verify_steps`/cache config (Zod 3/4 mirror)   | §2 (naming), §3.1/§3.2 (the cache row + step result schemas), §8.1 (the `integratorSettingsSchema` additions + `verifyStepSchema` + the DAG `.superRefine`), §10 (the defaults = backward-compat).                      |
| **Step 3** — `verify_cache` table + service                                  | §3 (the table, the unique key, the `step_config_sha` contract, no-TTL), §8.5 (`lookup`/`record` semantics + hit-count bump), §4.2 (`cache_enabled` → always-miss).                                                      |
| **Step 4** — REST: cache config endpoints + the cache-hit metric + debug GET | §8.1 (config via PATCH), §8.2 (extend `train/metrics`), §8.4 (the debug GET + authz pin), §8.5 (pm-client methods), §9 (`VERIFY_CACHE_MISMATCH` in `EVENT_NAMES`).                                                      |
| **Step 5** — Integrator: the pipeline executor (DAG, fail-fast, parallel)    | §2.1 (DAG semantics + validation), §5.1/§5.2 (the seam swap + `runPipeline` + topo-wave fail-fast), §5.4 (the synthetic-step fallback), §5.5 (compose with retry/kill/suffix), §6 (cross-repo per-repo pipeline).       |
| **Step 6** — Integrator: cache-aware step execution + shadow mode            | §3.2/§3.3 (the key + `step_config_sha`), §3.4 (the `tree_sha` source), §4.3/§4.4 (the modes + the shadow comparison + `verify.cache_mismatch`), §5.3 (`runStep` cache-aware logic), §5.6 (transient/cache interaction). |
| **Step 7** — Per-step metrics on the dashboard                               | §7 (the derived metrics, the `verify` bundle block, the per-step timeline + the `merge_attempts.steps` column), §8.2/§8.3 (the extended reads).                                                                         |
| **Step 8** — Full-stack E2E                                                  | §1 (the goals: fail-fast <30s, cache-skip), §4.4 (the shadow false-pass detection flow), §5 (the pipeline), §10 (the backward-compat parity flow).                                                                      |
| **Step 9** — Documentation                                                   | §3.5 (no-TTL / cleanup), §4.3/§4.4 (the shadow→on rollout recipe), §8 (the config surface), §11 (the new failure modes); finalize this doc's §13 deviations.                                                            |

---

## 13. Implementation notes / deviations (post-ship)

_(Reserved — to be filled in by Step 9, mirroring 7.2 §16 / 7.4 §14. Where the shipped code diverged from,
sharpened, or made-concrete the design above, recorded here with the reason. The design sections remain the
authoritative contract; this section records the soundness-driven adjustments made during implementation.
Everything not listed here ships as designed.)_

**Step 6 deviations (cache-aware pipeline + shadow mode):**

1. **`PipelineStepResult.verify` is NON-NULL (sharpened from §5.2's `VerifyResult | null`).** §5.2 types
   `verify: VerifyResult | null` (null on a pure cache HIT). The shipped code keeps it NON-NULL: a HIT
   populates a SYNTHESIZED `VerifyResult` from the cached row (§5.3's "synthetic `VerifyResult`-shaped object")
   rather than leaving it null. **Reason:** the two downstream `.verify` consumers — `batch.ts`'s
   `pipeline.failingStep!.verify` (~the runVerifyTask fail branch) and `group-integration.ts`'s
   `(pipeI.failingStep ?? pipeI.steps[0]).verify` (~the per-repo outcome extraction) — have NO null-guard, so a
   null on a cached-fail HIT would crash the fail/reject path. The synthetic (`exitCode: result==="fail" ? 1 :
0`, `signal: null`, `timedOut: false`, `stderr: logExcerpt`, `logPath: logUrl ?? ""`) preserves
   `PASS()`/`classifyVerifyFailure`/`categorize` parity exactly, so a cached fail classifies "real" → straight to
   `onMemberFailed` (never the transient retry, §5.6) and a cached pass passes the gate. `PipelineStepResult`
   also gains `cached: boolean`, `treeSha: string`, `stepConfigSha: string` (§5.2's documented fields).

2. **CLARIFICATION A — the cache key is keyed on the derived TREE sha, not `Member.rebasedTreeSha`/`Ri`/`Ro`.**
   §3.4 names `Member.rebasedTreeSha` as the `tree_sha`. In shipped git-ops, `rebaseOnto` returns
   `git rev-parse HEAD` (a COMMIT sha, carrying a committer timestamp) and `updateSubmoduleGitlink` likewise
   returns a commit sha — so `Member.rebasedTreeSha`, `asm.Ri`, and `asm.Ro` are all COMMIT shas, NOT content-
   addressed tree shas. Using a commit sha as the key would make every (re-)assembly a distinct key → an
   always-miss / dead cache. The shipped code derives the REAL tree sha via `gitOps.resolveRef("<commit>^{tree}")`
   for the single-repo key (batch.ts) and for BOTH per-repo keys (group-integration.ts: inner on `Ri^{tree}`,
   outer on `Ro^{tree}`). The two derived tree shas are distinct content-addressed keys → no cross-repo collision
   under one resource, and the cache HITS on an identical re-assembled tree. **The design's named field was a
   latent commit-vs-tree misnomer; the shipped key is content-addressed as §3.2/§4.1 require.**

3. **CLARIFICATION B — group orphan-recovery stays cache-OFF.** The R1 roll-forward verify
   (`group-recovery.ts`) runs the pipeline with NO `cache` ctx (the off-path, byte-identical). The recovery
   drops its assembled-outer ref, so there is no stable tree sha in hand; orphan recovery is rare and gains
   nothing from caching. Zero false-pass risk on the R1 gate. (Intentional, commented in source.)

**Step 7 deviations (per-step metrics + timeline):**

1. **`metrics.verify` is SNAKE_CASE on the wire, `timeline.steps[]` is CAMELCASE (the deliberate split).**
   `train.ts`'s `metricsToResponse` maps the internal camelCase metrics bundle to a snake_case OpenAPI schema:
   the `verify` sub-block ships as `{ cache_enabled, cache_mode, cache_hit_rate: { ratio, hits, lookups },
time_saved_ms, per_step: [{ step_id, runs, cached, pass_rate, avg_duration_ms, fail_count }],
cache_mismatches }`. The per-request timeline's `steps[]`, by contrast, KEEPS camelCase — `{ stepId, outcome,
cached, durationMs, treeSha, stepConfigSha, logUrl? }` — mirroring the integrator's `VerifyStepResult` shape
   stored in `merge_attempts.steps`. The two are NOT conflated: a consumer reading `metrics.verify.per_step[].step_id`
   and `timeline.steps[].stepId` is using two intentionally different casings. **Reason:** the metrics bundle
   follows the 7.4 snake-case wire convention for the on-read metrics surface; the timeline step result mirrors
   the integrator's `VerifyStepResult` camelCase shape it is round-tripping. The split is by design, not an
   oversight.

2. **`cache_mismatches` in the metrics bundle is HARDCODED 0.** The metrics `verify` block reports
   `cache_mismatches` but it is always `0`. The shadow mismatch is a **non-persisted SSE relay** (§9 —
   `verify.cache_mismatch` is a flattened-frame relay, never written to a table), so the on-read metric — which
   derives every other field from durable `verify_cache` / `merge_attempts` rows — has nothing to count and
   returns a 0 placeholder. §7.2's "count mismatches over the window" is honestly a 0-placeholder in the shipped
   metric. The LIVE shadow-mismatch signal is ONLY the `verify.cache_mismatch` SSE event (the dashboard banner);
   an operator validating a shadow window watches the SSE event / dashboard, NOT the `cache_mismatches` metric.

---

## Appendix A: Settled-decisions compliance checklist

A final self-check that each of the five non-negotiable decisions is respected by this design:

- [x] **Decision 1 (PM-owned `verify_cache` table, keyed by tree+step+config; integrator queries before / writes
      after; dashboardable; survives restarts; shared across instances).** §3 defines the PM table with the strict
      unique key; §8.5 the integrator lookup/record; §7 the dashboard hit-rate; the table is durable PM state.
- [x] **Decision 2 (DAG in project settings; cheap-first; fail-fast; independent steps concurrent; empty →
      single-command fallback; validated).** §2 + §8.1 define `verify_steps`, the Zod 3/4 mirror, the DAG
      semantics, the validation; §5.2 the topo-wave fail-fast + concurrency; §5.4 the synthetic-step fallback.
- [x] **Decision 3 (strict + verifiable cache safety: exact key, no fuzzy; `cache_enabled` kill-switch;
      `cache_mode off|on|shadow`; shadow runs real, compares, emits `verify.cache_mismatch`, always uses real; no
      false-pass is THE invariant).** §4 is the entire rigorous treatment, incl. the honest undeclared-input
      limitation (§4.5) and the verifiable shadow proof (§4.4).
- [x] **Decision 4 (TIA + artifact handoff OUT).** §1.2 records both as 7.5b non-goals; nothing in the design
      implements path→test-selection or cross-worktree build-cache sharing.
- [x] **Decision 5 (pipeline runs INSIDE `runVerifyTask`; scheduler unchanged; cross-repo per-repo
      AND-combined).** §5 grounds the exact one-call-site substitution in shipped `batch.ts:1410`; §5.5 preserves
      retry/kill/suffix; §6 runs the pipeline per repo, AND-combined per `group-integration.ts`; §10 audits the
      byte-identical backward-compat.
