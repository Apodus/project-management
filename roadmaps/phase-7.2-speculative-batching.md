# Phase 7.2: Speculative Batching — Roadmap

**Goal**: The reference integrator runs N integrations in flight at once (config `integrator.parallelism`, default 1 = today's behavior). Requests verify speculatively — B assumes A will land and rebases onto `main+A`, C onto `main+A+B` — all verifying concurrently. Lands are serialized in batch order; a member failure invalidates exactly its dependent suffix, which re-verifies against the corrected base. Throughput scales toward the verify-runtime ceiling instead of being capped by serial integration.

**Design reference**: `roadmaps/phase-7-merge-train-vision.md` Phase 7.2. This file is the execution roadmap for Month 2 only.

**Prerequisites**: Phase 7.1 complete and committed (732c880). Worker/integrator split shipped: `merge_requests` + `merge_attempts`, the request/attempt services, 11 REST endpoints, 7 SSE events, the reference integrator (`@pm/integrator-ref`) with `runOnce`/`runLoop`, git-ops, worktree, categorization, crash recovery, and a self-contained full-stack E2E. 1187 tests green.

## Architectural decisions (settled with the director before drafting)

1. **Batch state is integrator-owned (in-memory).** PM stays exactly request-centric — the `merge_requests`/`merge_attempts` lifecycle is unchanged. PM gains NO `merge_batches` tables and NO `GET /merge-batches`. The integrator is the single source of truth for speculative ordering and the worktree pool. Batch observability is delivered by tagging the *existing* SSE events with batch context (`batchId`, `speculativePosition`) plus a small set of batch-marker events PM re-emits on behalf of the integrator (Step 7) — not by a PM-side batch model.

2. **Full speculative batching.** Member B rebases onto `main + A` (the assumed-landed predecessor chain), C onto `main + A + B`, etc. All verify concurrently. Lands serialize in batch order. On a member failure, the *dependent suffix* (every member that speculated on the failed member) is invalidated and re-verified against the corrected base; predecessors that already passed still land.

3. **The Stage-1 lock becomes lane ownership, not per-attempt serialization.** In 7.1 the integrator acquired/released the lock around each single integration. With N in flight, that no longer fits. The integrator acquires the `(project, resource)` lock **once** when it begins a batch, holds it (heartbeating) while the batch is in flight, and releases it when the lane goes idle. The lock now means "exactly one integrator owns this lane" — which is what prevents two integrator processes from racing on `main`. Lands (the actual `git push` to main) are serialized **by the integrator's own batch logic**, in batch order, while it holds the lock.

4. **`parallelism: 1` is the default and exactly reproduces 7.1 behavior** (a degenerate batch of one). 7.2 is backwards compatible: an existing deployment that doesn't set `parallelism` keeps integrating serially. game_one sets `parallelism: 3–5`.

5. **PM must tolerate multiple concurrent `integrating` requests per lane.** In 7.1, only one request was ever `integrating` at a time (the serializer guaranteed it). Under batching, N requests in one lane are `integrating` simultaneously. PM has no invariant that forbids this (the state lives per-row), but the design step must audit for any implicit assumption (queries, the integrator's crash-recovery sweep, the merge-lock holder model) and confirm nothing breaks.

**Design liberties**: Implementing agents may make tactical decisions within these constraints. The integrator-owned-state decision, the full-speculative strategy, the lane-ownership lock model, and `parallelism: 1` backwards-compatibility are not negotiable.

---

## Steps

### Step 1 — Month 2 design doc

Write `docs/design/phase-7.2-design.md`. This is the load-bearing step; every later step references it. Target 600–900 lines.

- **In-memory batch model**: the integrator's data structures. A `Batch` is an ordered list of `Member`s. Each `Member` carries: the `merge_request` id, its assigned worktree, its `speculativeBase` (the ordered chain of predecessor SHAs/branches it rebased on top of), its verify state (`pending`/`rebasing`/`verifying`/`verified`/`failed`/`invalidated`/`landed`), the attempt id (PM-side), and the verify process handle.
- **Speculative base chains**: how member K's base is computed = `main` + the rebased trees of members 0..K-1 (assumed to land). Concretely: member 0 rebases its branch onto live `main`; member K rebases its branch onto member K-1's *rebased tree SHA*. Document the exact git sequence per member and how the chain is represented.
- **Concurrency model**: up to `parallelism` worktrees, each running one member's rebase+verify. The scheduler fills idle worktrees from the head of the queued requests (FIFO by `enqueuedAt`).
- **Land serialization**: a member may land only when (a) it has `verified` and (b) all its predecessors in the batch have `landed`. Lands push to `main` in strict batch order. Because member K verified against `main + (0..K-1)`, once 0..K-1 have landed, member K's verified tree fast-forwards `main` cleanly — **no re-verify in the happy path** (the speculative win). Document the fast-forward-or-reverify check at land time (if `main` is not at the expected predecessor SHA, the member is stale → re-verify).
- **Suffix invalidation**: when member K `failed`, every member J>K that speculated on K (its base chain includes K) is `invalidated`: its verify process is killed, its worktree freed, and its request is re-queued (or kept and re-based) against the corrected base (`main` + the *surviving* prefix, excluding K). Document: K itself is rejected (existing `reject` flow); the invalidated suffix members get `resetToQueued` or are re-admitted to the next batch with a fresh speculative base. Pin down which (re-queue vs in-place re-base) and why.
- **Lane-ownership lock protocol**: acquire `(project, resource)` once at batch start; heartbeat every minute while in flight; release when the queue drains and all members resolve. Cover: what happens if acquire returns `queued` (another integrator owns the lane → this integrator idles and retries); crash while holding (TTL sweep frees it; the new owner reconciles via the existing crash-recovery sweep, which must now handle *multiple* `integrating` requests).
- **Verify retry policy**: classify verify failures into *transient* (process spawn failure, network/infra timeout distinct from the verify command's own timeout, OOM-killed) vs *real* (the verify command exited non-zero on its own). Transient → retry with backoff (cap N retries), same speculative base. Real → `failed` → reject + suffix invalidation. Document the classification signals and the backoff schedule. (Reuse/extend `categorize.ts`.)
- **Backpressure**: when all `parallelism` worktrees are occupied, new queued requests wait — none are dropped, none are picked up. Document the admission rule.
- **Batch observability**: the events approach (per decision 1). Existing `merge.request.*`/`merge.attempt.*` events gain optional `batchId` + `speculativePosition` context. Plus a minimal set of batch markers — `merge.batch.started` / `merge.batch.member_landed` / `merge.batch.member_invalidated` / `merge.batch.completed` — that PM re-emits when the integrator POSTs them to a thin endpoint (Step 7). Document the payloads. Note the **forward dependency**: Phase 7.4's dashboard consumes these events (it does NOT query a PM batch table, because there isn't one).
- **PM invariant audit** (decision 5): enumerate every place that might assume ≤1 `integrating` request per lane — the crash-recovery sweep (`reclaimStrandedRequests`), any `list(status: integrating)` consumer, the merge-lock holder/landing-intent model — and confirm each tolerates N. Record findings; if any breaks, the fix is specified here.
- **Failure-mode catalog additions**: worktree pool exhaustion; one worktree corrupt mid-batch (isolate + repair that slot, batch continues); integrator crash mid-batch (lane lock TTL-frees; restart reclaims all `integrating` in the lane → queued); a member's verify hangs (per-member timeout kills just that worktree); the predecessor-stale-at-land case.

**Verify**: doc exists, internally consistent, every later step finds its contracts here, the PM-invariant audit is complete, and the director reviews before code lands.

### Step 2 — Per-project `parallelism` config

Extend the integrator settings (shipped in 7.1 at `projects.settings.integrator`).

- Add `parallelism: number` to `integratorSettingsSchema` (`packages/shared/src/schemas/project.ts`): integer ≥ 1, default 1. When 1, behavior is identical to 7.1.
- Thread it through the integrator's `IntegratorConfig` + `loadConfig` (`packages/integrator-ref/src/config.ts`).
- Tests: schema accepts/defaults/rejects (`parallelism: 0` → 400); config loader surfaces it.

**Verify**: `pnpm --filter @pm/shared test` + the server project-settings tests + integrator config tests pass. Default-1 path unchanged.

### Step 3 — Worktree pool

Generalize the single worktree (7.1) into a pool of N isolated worktrees in the integrator.

- New `packages/integrator-ref/src/worktree-pool.ts`: manages `parallelism` worktrees at `${worktree_root}/${worktree_name}-{0..N-1}` (each a separate clone — never a shared `.git`). Operations: `acquire()` (lease an idle worktree), `release(wt)`, `ensureAll()` (clone-on-first-use for each), `repair(wt)` (detect-and-rebuild one slot without disturbing the others), `gc()` (remove orphaned/leaked worktrees on startup).
- Reuse the existing `worktree.ts` per-slot logic (clone, resetForAttempt, detectCorruption, repair) — the pool composes N of them.
- Tests (real git, temp bare repo): pool of 3 clones cleanly; `acquire`/`release` leasing; `repair` rebuilds one slot while others are untouched; `gc` removes a leaked slot; corruption in one slot doesn't poison the pool.

**Verify**: `pnpm --filter @pm/integrator-ref test` — pool tests pass against a real git binary.

### Step 4 — Batch scheduler (the core)

Replace the serial `runLoop` with a batch scheduler in the integrator. This is the largest step.

- New `packages/integrator-ref/src/batch.ts`: the in-memory `Batch`/`Member` model + the scheduler. The scheduler:
  1. Acquires the lane lock (decision 3); idles + retries if not granted.
  2. Pulls up to `parallelism` queued requests (FIFO), assigns each a worktree from the pool, and admits them as ordered members.
  3. For member 0: rebase its branch onto live `main`. For member K>0: rebase onto member K-1's rebased tree SHA (speculative base).
  4. Kicks off all members' verifies concurrently (each via the existing `runVerify` in its own worktree).
  5. As members finish, applies the land-serialization + suffix-invalidation rules (Steps 5, 6).
  6. Backpressure: refills worktrees from the queue only as members resolve and slots free.
  7. Heartbeats the lane lock; releases it when the lane drains.
- Each member's PM-side lifecycle uses the EXISTING endpoints: `pickup` (queued→integrating), `startAttempt`, `completeAttempt`, `land`/`reject`, `resetToQueued`. The scheduler orchestrates these; no new PM request endpoints.
- `parallelism: 1` must drive exactly one member at a time = 7.1 behavior (regression-guard this explicitly).
- Tests (the scheduler logic against a fake PM client + real git, mirroring 7.1's `loop.test.ts` FakePmClient pattern): a 3-member all-pass batch lands all three in order with each member's `pickedUpAt` ordered; `parallelism: 1` degenerates to serial; backpressure holds the 4th request while 3 worktrees are busy.

**Verify**: `pnpm --filter @pm/integrator-ref test` — scheduler unit tests green; the 7.1 `loop.test.ts` equivalents still pass under `parallelism: 1`.

### Step 5 — Speculative rebase + concurrent verify

Implement the speculative base chain and concurrent verification within the scheduler.

- Member K's rebase target = the rebased tree SHA of member K-1 (or live `main` for K=0). The git sequence: fetch, rebase member's branch/commit onto the predecessor's tree, capture the resulting tree SHA (which becomes the base for K+1).
- All admitted members verify concurrently in their own worktrees. `startAttempt(requestId, baseSha)` records the speculative base SHA PM-side (so the attempt history shows what each member verified against).
- A rebase conflict at admission (member can't rebase onto its speculative base) → that member `failed` with category `conflict` → reject + suffix invalidation (Step 6).
- Tests: member K's recorded `baseSha` equals member K-1's tree SHA; concurrent verifies run in parallel (assert overlapping start/end timestamps); a mid-chain rebase conflict fails that member.

**Verify**: integrator tests green; the speculative chain is correct (each base = predecessor tree).

### Step 6 — Land serialization + suffix invalidation

The batch resolution rules.

- **Land serialization**: a `verified` member lands only when all predecessors have `landed`. At land time, check `main` is at the expected predecessor SHA; if so, push (fast-forward) + call PM `land(landedSha)` — no re-verify. If `main` drifted unexpectedly (shouldn't happen while we hold the lane lock, but guard it), the member is stale → re-verify.
- **Suffix invalidation**: when member K `failed` (verify non-zero or rebase conflict): reject K (existing `reject` flow, with structured payload + the `merge_rejection` comment); then for every member J>K whose base chain included K: kill its verify, free its worktree, and re-admit it with a corrected base (`main` + surviving prefix). Decide per the design doc whether re-admission is via `resetToQueued`+re-pickup or in-place re-base; implement that.
- Predecessors of K that already `verified` or `landed` are untouched (failure isolation).
- Emit the batch-marker events (Step 7) at member_landed / member_invalidated / batch boundaries.
- Tests (the heart of the phase): 3-member batch where member 1 fails → member 0 still lands, member 1 rejected, member 2 invalidated and re-verified against `main+0` (NOT `main+0+1`); a tail failure (member 2 fails) lands 0 and 1, rejects 2, invalidates nothing; a head failure (member 0 fails) invalidates the entire suffix.

**Verify**: integrator tests green; "a single failure invalidates exactly the dependent suffix — never more, never less" (the vision's success criterion) is asserted by tests.

### Step 7 — Batch observability (events)

Surface batch context without PM-side batch tables (decision 1).

- **PM**: add optional `batchId` + `speculativePosition` fields to the relevant existing event payloads (carried when the integrator supplies them on `pickup`/`startAttempt` — add optional body fields, defaulted absent so 7.1 callers are unaffected). Add a thin integrator-only endpoint `POST /api/v1/projects/{projectId}/merge-batches/events` that accepts a batch-marker `{ type: started|member_landed|member_invalidated|completed, batchId, ... }` and re-emits it as the corresponding `merge.batch.*` SSE event. Add the 4 event names to `EVENT_NAMES`. (No batch table; PM just relays.)
- **Integrator**: emit batch markers at the right transitions; tag pickup/startAttempt with batchId + position.
- Tests: server test that the batch-events endpoint re-emits over SSE (integrator-auth only, 403 for non-integrator); integrator test that markers fire at batch start / member land / member invalidation / completion.

**Verify**: server + integrator tests green; batch events stream over the existing `/api/v1/events`.

### Step 8 — Verify retry policy

Distinguish transient infra failures from real verify failures.

- Extend the integrator's failure handling: transient (spawn failure, infra/network timeout distinct from the verify command's own timeout, signal-kill not from our timeout) → retry the same member with backoff, same speculative base, up to a capped retry count. Real (verify exited non-zero on its own) → `failed` → reject + suffix invalidation (Step 6).
- Surface retry attempts in logs and (optionally) as additional `merge_attempts` rows so the history shows the retries.
- Tests: a simulated transient failure retries then succeeds (lands); a real failure does not retry (rejects immediately); retry cap is honored.

**Verify**: integrator tests green; transient vs real classification behaves per the design doc.

### Step 9 — Lane-ownership lock migration

Move the integrator from per-attempt locking (7.1) to lane-ownership (decision 3).

- The scheduler acquires the `(project, resource)` lock once at batch start, heartbeats while in flight, releases when the lane drains. Individual members no longer acquire/release the lock per attempt.
- Crash recovery: the existing `reclaimStrandedRequests` sweep must reset ALL `integrating` requests in the lane to queued on integrator restart (it may currently assume one) — audit + fix per the design doc's PM-invariant audit (Step 1).
- A second integrator process for the same lane gets `queued` on acquire and idles — verify the anti-pattern is handled gracefully (no double-push to main).
- Tests: lock acquired once per batch (not per member); heartbeat keeps it; release on drain; a second integrator can't land concurrently; crash-recovery reclaims multiple `integrating` requests.

**Verify**: integrator + server tests green; no path lets two integrators push main concurrently.

### Step 10 — Full-stack E2E for batching

The regression net for the phase. Extend/replace the 7.1 E2E to exercise real parallelism.

- Self-contained (in-process PM server + spawned integrator with `parallelism: 3` + real temp git remote), mirroring the 7.1 E2E harness.
- Flows: (a) 3 independent clean branches submitted together → all land in order, main advances by all three, sub-linear wall-clock vs serial (assert the three verifies overlapped); (b) suffix invalidation — middle member fails verify → head lands, middle rejects, tail re-verifies against corrected base and lands; (c) backpressure — 5 submitted with parallelism 3 → all eventually land, never more than 3 in flight; (d) `parallelism: 1` → behaves exactly like the 7.1 serial E2E.
- Gate on git-available + built dist, default-on (no opt-in env var), leak-proof teardown.

**Verify**: the E2E runs (not skipped) and all flows pass; full `pnpm test` green across the monorepo.

### Step 11 — Documentation

- Update `docs/integrator-deployment.md`: the `parallelism` config field, worktree pool layout (`${worktree_root}/${worktree_name}-{0..N-1}`), the lane-ownership lock model, batch observability events, and the new batch-related failure modes. Update the single-machine game_one layout to show N worktree slots.
- Finalize `docs/design/phase-7.2-design.md` with any implementation-driven adjustments.
- Update `CLAUDE.md` Merge train section: note speculative batching + `parallelism`.
- Update `packages/integrator-ref/README.md`: parallelism in the config-at-a-glance.

**Verify**: docs cross-checked against the shipped source (config fields, event names, endpoint, worktree paths); `pnpm typecheck` + `pnpm --filter @pm/server exec vitest run` confirm code still green.

---

## Out of scope for Phase 7.2 (later phases)

- **Cross-repo atomicity** (rynx + outer gitlink) — Phase 7.3.
- **Train dashboard, audit log, break-glass** — Phase 7.4. (7.2 emits the batch events the dashboard will consume; it does not build the dashboard.)
- **Verify-result caching, multi-stage verify, test impact analysis** — Phase 7.5.
- **A PM-side batch model / `merge_batches` tables / `GET /merge-batches`** — explicitly NOT built (decision 1). If 7.4 finds the dashboard genuinely needs durable batch history, revisit then.

## Definition of done

- The integrator sustains `parallelism` concurrent integrations; throughput scales toward the verify-runtime ceiling (E2E asserts overlapping verifies + multi-member lands).
- A single member failure invalidates exactly its dependent suffix — predecessors still land, unrelated members untouched.
- Lands are serialized through the lane lock; no two integrators can push main concurrently; main is never advanced past an unverified tree.
- `parallelism: 1` reproduces 7.1 behavior exactly (backwards compatible).
- Worktree leaks are detectable and GC'd on startup; one corrupt slot doesn't poison the pool.
- Batch context is observable over SSE (batchId-tagged events + merge.batch.* markers) for the future dashboard.
- All existing tests stay green; new unit + real-git + E2E tests cover the scheduler, speculation, suffix invalidation, retry, and the lane lock. Build + typecheck clean.
- Docs let an operator turn on batching and reason about it.
