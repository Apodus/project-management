# Phase 7.6: Intelligent Merge-Conflict Resolution — Roadmap

**Goal**: When the integrator hits a **textual rebase conflict**, it no longer just rejects to the worker. Behind an opt-in flag it spawns a bounded, headless Claude Code session to reconcile both intents, re-verifies, and resubmits the resolved change as a new merge request. If resolution can't land, the original author gets the conflict back as ordinary work; a human is the last resort. **No proven work is ever discarded, and `main` is never advanced to anything verify hasn't passed.**

**Design reference**: `docs/design/phase-7.6-design.md` (already authored — the load-bearing spec; every step below references it). PM proposal `01KT1W67ZB400S13HVK7ATGE9K` (project `01KT1VN1BEMF1KZGBFMGXBY5W1`), with the director's decision comment.

**Prerequisites**: Phases 7.1–7.5 complete and committed (the reference integrator with `runBatchLoop`/`runVerifyTask`/the group path; `GitOps.rebaseOnto` returning `RebaseConflict`; `categorize.ts`'s `conflict` category; the 7.4 metrics/health/audit/dashboard + SSE stream; the 7.5 verify DAG + cache). The worktree pool (`worktree-pool.ts`), the lane-lock ownership protocol (7.2), and the `settings.integrator` Zod-3/Zod-4 mirror are all in place.

## Scope (settled with the director)

**IN this campaign (Track B — the engine):**
1. `settings.integrator.resolver` config block (Zod 3/4 mirror) — `enabled` (default false), `max_concurrent` (default 1), `time_budget_sec` (default 600), `token_budget?`, `command?`.
2. PM-owned data: nullable `merge_requests.resolved_from` + a `merge_resolutions` table (state machine `pending → resolving → resolved | escalated | failed`).
3. Resolver lifecycle REST endpoints (ai_agent/integrator-only) + `merge.resolution.*` SSE events.
4. The integrator engine: branch the `rebaseOnto → RebaseConflict` seam (reject-fast + **release the lane lock** + enqueue), the resolver worker (worktree + headless Claude bounded by budget + local verify), resubmit-as-linked-new-request, and escalation-to-author.
5. Observability: the resolution lineage chain in the per-request timeline + train dashboard + a verify/resolution metrics sub-block.
6. Operator guide §18 + finishing Track A's systematic redistribution.
7. Tests — including the **off=inert** invariant.

**Track A is ALREADY DONE** (doc-only, shipped this session): `game_one/docs/pm-workflow.md` submit-and-move-on + rejection-is-a-new-ticket sections. The only Track A remnant in scope here is folding worker-doc redistribution into `distribute.bat` (Step 9).

**DEFERRED to v2 (NOT this campaign):**
- **Semantic verify-failure resolution** (rebased clean, broke a test) — open-ended bug-fixing; the harder cousin. Conflict-only for v1.
- **Cross-repo group conflicts** through the resolver — v1 leaves group conflicts on the existing 7.3 reject/incident path.
- **Iterative / multi-round** resolution — one bounded attempt only in v1.

## Architectural decisions (the five settled decisions — NON-NEGOTIABLE)

1. **Off by default, opt-in like the 7.5 cache.** `resolver.enabled` defaults `false`. Off ⇒ a conflict rejects EXACTLY as in 7.5 (byte-identical). One attempt per conflict, no retry loop. This is the load-bearing safety invariant — enforced by a dedicated test.
2. **Resolution spawns a linked NEW merge request; the original is never mutated.** The origin is rejected `conflict` + tagged `resolution_pending`; the resolver's output enters the train carrying `resolved_from = origin.id`. Honest audit trail.
3. **Verify is the ONLY arbiter.** Never trust a model's self-asserted confidence to gate a land. The resolver's output runs the normal verify gate. Pass ⇒ land. Fail OR budget-exceeded ⇒ escalate. There is NO "the model said it's confident, so land it" path.
4. **Never discard work.** "Redo from scratch" is never a path. Escalation hands the conflict back to the origin author (then human); the original commit is always preserved.
5. **The lane lock is NEVER held during a resolution.** On conflict, reject-fast + release the lane, then resolve off the critical path. A multi-minute Claude session must not stall the train.

**Design liberties**: Implementing agents may make tactical decisions within these constraints. The five decisions above, the `rebaseOnto→RebaseConflict` seam as the integration point, and "the resolver never pushes `main` directly — it only ever submits a request" are NOT negotiable.

**Risk note**: The load-bearing risks, in order: (1) a resolved change landing WITHOUT passing verify (violates decision 3 → broken main) — defended by routing every resolution through the normal verify gate, never a direct land; (2) `resolver.enabled=false` NOT being byte-identical to 7.5 (regression) — defended by the off=inert test; (3) the lane lock being held across a resolution (train stall) — defended by releasing at enqueue + a test asserting a second admit proceeds; (4) recursion (a resolved request conflicting again triggering another resolution) — defended by `resolved_from != null ⇒ resolver skips`.

---

## Steps

### Step 1 — Design doc (ALREADY WRITTEN — verify & refine)

`docs/design/phase-7.6-design.md` exists. Re-read it against the shipped integrator code (`loop.ts`, `batch.ts`, `git-ops.ts` `rebaseOnto`, `categorize.ts`, `worktree-pool.ts`, `settings.integrator`) and tighten any drift: confirm the `RebaseConflict` shape (`{ ok:false, conflictingFiles, stderr }`), the exact seam where conflict is currently categorized/rejected, and that the config field names match the Zod mirror conventions. Adversarial review the verify-only-arbiter + off=inert + lane-never-held invariants.

**Verify**: doc internally consistent with shipped code; the five decisions + the seam + the data model are pinned. No code references a symbol that doesn't exist.

### Step 2 — Shared schemas + `settings.integrator.resolver` (Zod 3/4 mirror)

- Add the `resolver` block to the canonical `integratorSettingsSchema` (@pm/shared, Zod 3) + the server route-local Zod-4 mirror (`routes/projects.ts`). Fields per §3 of the design. Defaults make absent/empty `resolver` ⇒ `{ enabled:false }` ⇒ inert.
- Validation: `max_concurrent ≥ 1`, `time_budget_sec > 0`. Regen openapi + web api-types.
- Tests: accept/default/reject; absent block ⇒ inert; round-trip via `PATCH /projects/{id}`.

**Verify**: `pnpm --filter @pm/shared test` + server project-settings tests + openapi/api-types regen green.

### Step 3 — Migration 0017: `resolved_from` + `merge_resolutions`

- Drizzle: nullable `merge_requests.resolved_from` (text) + the `merge_resolutions` table (columns per design §4.2: id, project_id, resource, origin_request_id, resolved_request_id?, state, conflicting_files JSON, attempt_started_at?, attempt_ended_at?, escalation_target?, detail JSON, timestamps). `pnpm --filter @pm/server db:generate` → migration 0017.
- Shared schemas for the row + the resolution state enum (`pending|resolving|resolved|escalated|failed`).
- Tests: migration applies on a fresh in-memory DB; the state enum + row schema round-trip; `resolved_from` defaults null on a normal request.

**Verify**: server boots + migrates clean; schema tests pass.

### Step 4 — Resolver lifecycle REST + SSE events (ai_agent only)

- Endpoints per design §6: `POST projects/{id}/merge-resolutions` (open→pending), `POST merge-resolutions/{id}/start` (→resolving), `POST merge-resolutions/{id}/resolved` (set resolved_request_id, →resolved), `POST merge-resolutions/{id}/escalate` (→escalated|failed + reason + target), `GET projects/{id}/merge-resolutions` + `GET merge-resolutions/{id}` (any authed user). Each write records its transition in ONE transaction with the state change.
- AuthZ: the four mutating endpoints are `ai_agent`-only (like the 7.4/7.5 integrator channels); the GETs are any authenticated user.
- SSE: `merge.resolution.pending|started|succeeded|escalated|failed`, tagged with `origin_request_id`, `resolution_id`, `resolved_request_id?`.
- Tests: each transition + authz (human/ai_agent), illegal transitions rejected, events emitted.

**Verify**: route tests + SSE-emission tests green; openapi regen.

### Step 5 — Integrator: branch the conflict seam (off=inert is the prime test)

- In `loop.ts`/`batch.ts`, at the `RebaseConflict` branch: if `!resolver.enabled` → today's plain `conflict` reject (UNCHANGED). If `resolver.enabled` → reject origin `conflict` + tag `resolution_pending`, **release the lane lock**, open a `merge_resolutions` row (`pending`), emit `merge.resolution.pending`, and enqueue a resolution job into the resolver pool.
- The resolver pool: `max_concurrent` slots, isolated worktrees, SEPARATE from the verify pool.
- Tests: **off=inert** (enabled=false ⇒ plain reject, zero `merge_resolutions` rows, zero events — byte-identical to 7.5); enabled ⇒ a `pending` row + the lane is released (a second admit can proceed while a resolution is queued).

**Verify**: the off=inert test + the lane-released test pass; existing 7.2–7.5 integrator tests stay green.

### Step 6 — Integrator: the resolver worker (worktree + headless Claude, bounded)

- The worker: materialize the conflict in an isolated worktree (main + replay origin branch), spawn headless Claude Code (`claude -p` / Agent SDK, or `resolver.command`) with the reconcile-both-intents + run-verify prompt, bounded by `time_budget_sec` (SIGTERM→SIGKILL) and `token_budget?`. ONE attempt. Then run the project verify pipeline (7.5 DAG) on the result with cache **OFF**.
- The spawn is injectable/mockable (do NOT require a real Claude binary in unit tests — inject a fake resolver that returns a fixed resolved tree or a failure/timeout).
- Tests (with a mocked resolver): produces a clean verified tree → hands to Step 7; verify-fail → escalate; budget-exceeded (timeout) → escalate; spawn error → `failed`→escalate.

**Verify**: worker tests green via the injected fake; no real network/binary needed.

### Step 7 — Integrator: resubmit-as-linked-new-request + escalation

- On a clean, locally-verified resolution: submit the resolved branch as a NEW merge request with `resolved_from = origin.id` + the origin's `task_id`; it re-enters the train and passes the REAL verify gate before landing. Set `resolved_request_id`, state `resolved`, emit `merge.resolution.succeeded`. Enforce no-recursion: `resolved_from != null ⇒ the resolver never re-engages` on a later conflict.
- Escalation (verify-fail/budget/unresolvable/infra): state `escalated`|`failed`, `escalation_target=author`, post a `merge_rejection` comment on the origin task (conflicting files + verdict/budget reason + "auto-resolution attempted; original commit intact — fix forward, don't redo"), emit `merge.resolution.escalated`.
- Tests: happy path (resolve→resubmit→the resolved request lands; lineage intact); resolved request conflicts again ⇒ plain reject, NO second resolution; escalation posts the author comment.

**Verify**: end-to-end resolver tests green; the no-recursion + never-discard invariants asserted.

### Step 8 — Observability: the resolution lineage chain

- Per-request timeline (extend 7.4 §8.3) + train dashboard: render `origin (rejected conflict) → resolution attempt (state) → resolved request (its own land timeline)`, driven by `merge.resolution.*` + `resolved_from`. A `resolving` attempt shows as in-flight composition (a long resolver is visible, not mystery latency).
- Metrics sub-block: attempt count, auto-resolve success rate, escalation rate, mean resolver wall-clock + budget utilization (extend the 7.4 metrics bundle; recorded, not SLO-enforced).
- Tests: the timeline assembles the chain; the metrics compute on seeded rows.

**Verify**: timeline + metrics tests green; the web view renders the chain (typecheck + a component/render test).

### Step 9 — Operator guide §18 + Track A redistribution

- `docs/integrator-deployment.md` §18: `settings.integrator.resolver` config, the `enabled` kill-switch, budget/cost controls, and what operators see when a conflict is auto-resolved vs escalated (the timeline chain + the events).
- Fold worker-doc redistribution into `distribute.bat` so future clients receive the tightened `pm-workflow.md` guidance systematically (note: the worker doc is currently maintained in the client repo — decide whether to source a canonical copy from this repo or document the manual step; pin and implement the chosen approach).

**Verify**: §18 present + consistent with the shipped config; `distribute.bat` change runs clean.

### Step 10 — Full green + the off=inert guarantee

- `pnpm typecheck && pnpm lint && pnpm test` across all packages; integrator package tests incl. the off=inert, lane-released, no-recursion, never-discard, and verify-is-the-only-arbiter assertions. Confirm `resolver.enabled=false` ⇒ the full 7.5 suite is byte-identical.
- Update `CLAUDE.md` with the Phase 7.6 paragraph (the established per-phase summary) + reference `docs/design/phase-7.6-design.md`.

**Verify**: whole-repo typecheck + lint + test green; the off=inert invariant proven; CLAUDE.md updated.
