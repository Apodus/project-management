# Phase 7.3: Cross-Repo Atomicity — Roadmap

**Goal**: A change spanning multiple linked repos (game_one's rynx inner Rust workspace + the outer gitlink/submodule repo) lands as a unit or not at all. No half-landed gitlink state ever reaches main. The half-landed-gitlink corruption case — the game_one team's single most-cited concern — is eliminated, and the orphaned-inner case is detectable and recoverable from PM alone.

**Design reference**: `roadmaps/phase-7-merge-train-vision.md` Phase 7.3. Builds on 7.2 speculative batching (`docs/design/phase-7.2-design.md`). This file is the Month 3 execution roadmap.

**Prerequisites**: Phase 7.2 complete and committed (speculative batching: worktree pool, lane-ownership lock, suffix invalidation, batch events, the reference integrator on `runBatchLoop`). 1246 tests green.

## Architectural decisions (settled with the director before drafting)

1. **Group + incident state is PM-OWNED (durable coordination state), a deliberate divergence from 7.2.** Phase 7.2 kept batch state integrator-owned because it is transient EXECUTION state. Groups and incidents are different: they are durable COORDINATION state, and a hard 7.3 success criterion is *"the orphaned-inner case is detectable from PM alone (no SSH into the integrator host)."* That requires PM tables + query endpoints. So 7.3 ADDS `merge_request_groups` and `merge_incidents` to PM. This does NOT walk back 7.2 — batch execution state stays integrator-owned; only the group-membership and incident records are PM-side. Document the principle: *transient execution → integrator; durable coordination/incident → PM.*

2. **Atomic land order: inner-first, then outer gitlink, in one integrator transaction.** The integrator pushes the inner repo first; on success it pushes the outer repo with the updated gitlink (submodule SHA bump). An INNER push failure stops the whole group cleanly (nothing landed — straightforward reject of all members). An OUTER push failure AFTER the inner landed is the dangerous case: the inner SHA is marked `orphaned` and a `merge_incident` is opened.

3. **Orphaned-inner recovery: auto-rollforward + human fallback.** When the outer push fails post-inner-land, the next group integration AUTOMATICALLY rolls the gitlink forward to absorb the orphaned inner SHA (the common, self-healing case). If it cannot reconcile (e.g. the orphaned inner SHA conflicts with intervening outer history), the incident escalates to humans: a `merge_incident` comment on the linked task + a dashboard-visible alert. NEVER auto-mutate in a way that could break outer main — the verify-gate-before-fast-forward invariant from 7.1/7.2 still holds for the roll-forward push.

4. **Verify runs against the ASSEMBLED multi-repo state.** A group's verify is not per-repo-in-isolation: the inner is rebuilt at its new SHA, the outer is checked out with the new submodule SHA pointing at the inner's rebased tree, and per-repo verify commands all run against that assembled state. All must pass before any land. Groups declare per-repo verify commands (rynx tests on inner, integration tests on outer).

5. **Backwards compatible.** A single-repo merge request (no group) flows exactly as 7.2 today. Groups are opt-in: a worker tags N requests as a group. `parallelism` batching still applies to single-repo lanes; a group integrates as a unit (its members are not speculatively interleaved with each other — a group is the atomic unit).

**Design liberties**: Implementing agents may make tactical decisions within these constraints. The PM-owned-group/incident-state decision, inner-first atomic land order, auto-rollforward+human-fallback recovery, assembled-state verify, and single-repo backward compatibility are NOT negotiable.

**Risk note (from the vision)**: This is the riskiest phase. The orphaned-inner recovery state machine needs proof-level care. Step 1 (design doc) is the load-bearing step and its adversarial verification IS the "second review" the vision calls for — do not shortcut it.

---

## Steps

### Step 1 — Month 3 design doc

Write `docs/design/phase-7.3-design.md` (target 700–1000 lines). This is the load-bearing step; every later step references it. Its adversarial verification is the vision's required "second review."

- **Linked-repo model**: the config shape `linkedRepos: [{ name, path, role: "inner"|"outer", gitlinkParent?, gitlinkPath? }]`. How the integrator understands the inner↔outer gitlink relationship (which repo is the submodule, where the gitlink lives in the outer tree). Cover the game_one shape precisely: rynx (inner) embedded as a submodule in the outer game repo at a known path.
- **Group data model (PM-owned)**: `merge_request_groups` (id, project, resource, state, created/updated) + how `merge_requests` associate to a group (a nullable `group_id` FK, or a join — decide and justify). Group state machine: `forming → integrating → landed | rejected | partially_landed(orphaned)`. A member request's lifecycle vs the group's lifecycle — pin the relationship (a member can't land independently of its group).
- **Incident data model (PM-owned)**: `merge_incidents` (id, project, group_id, type: "orphaned_inner", inner_repo, orphaned_sha, outer_repo, state: "open"|"auto_resolved"|"human_resolved", opened_at, resolved_at, resolution). How an incident links back to the task + surfaces.
- **Assembled-state verify**: the exact git sequence to assemble inner@newSHA + outer@(submodule→newSHA) in worktrees, run per-repo verify, and capture the combined result. How this composes with the 7.2 worktree pool (a group needs ≥2 correlated worktrees — one per linked repo — leased together).
- **Atomic land protocol**: inner-push-then-outer-push, the exact ordering, the transaction boundary, and the THREE failure points: (a) inner push fails → reject group, nothing landed; (b) outer push fails after inner landed → mark inner orphaned + open incident; (c) verify fails on assembled state → reject group, nothing landed. Pin each transition.
- **Orphaned-inner recovery state machine** (the proof-level-care part): the auto-rollforward algorithm (how the next group integration detects the open incident, rolls the gitlink forward, and either auto-resolves the incident or escalates). The reconciliation check (when CAN'T it auto-rollforward → human). The invariant that outer main is never advanced past an unverified assembled tree even during recovery.
- **Lane-ownership lock under groups**: a group holds the lane lock like any batch; how a group interacts with the 7.2 lane lock (one integrator owns the lane; a group is integrated under that lock). Confirm a group does NOT need a second lock.
- **PM-invariant audit**: enumerate where the new group_id / incident state touches existing queries (the integrator's pickup, the recovery sweep, the merge-request list/detail) and confirm nothing breaks. Confirm single-repo requests (group_id null) are unaffected.
- **SSE events**: `merge.group.started / member_landed / landed / rejected`, `merge.incident.opened / auto_resolved / human_resolved`. Payloads.
- **Failure-mode catalog**: push race on inner, push race on outer, fs-full mid-assembly, network drop between inner-push and outer-push (THE orphaned case), submodule SHA mismatch, an orphaned inner whose SHA conflicts with intervening outer history (the un-auto-resolvable case).
- **Backwards-compat section**: single-repo (group_id null) path is byte-identical to 7.2.

**Verify**: doc exists, internally consistent, every later step finds its contracts here, the orphaned-inner recovery state machine is complete and the PM-invariant audit covers single-repo backward compat. The adversarial verification of THIS doc is the vision's "second review" — it must be thorough.

### Step 2 — DB schema + migration (PM-owned group + incident tables)

- New `merge_request_groups` + `merge_incidents` tables (Drizzle, in `packages/server/src/db/schema.ts`) + the `group_id` association on `merge_requests` (nullable FK, ON DELETE SET NULL — a deleted group orphans nothing). Migration generated via `pnpm --filter @pm/server db:generate`.
- FK discipline mirroring 7.1 (taskId FK ON DELETE SET NULL; appropriate UNIQUE/indexes).
- Tests: schema test (tables exist, FKs, the group_id association, indexes).

**Verify**: `pnpm --filter @pm/server test` schema tests pass; migration applies cleanly on a fresh DB.

### Step 3 — Shared Zod schemas (groups + incidents)

- New `packages/shared/src/schemas/merge-group.ts` + `merge-incident.ts`: the group + incident row schemas, the group/incident state enums, the create-group request shape. Re-export from `schemas/index.ts`. Add enums to `constants/enums.ts`.
- Tests: `packages/shared/tests/` round-trip + enum coverage.

**Verify**: `pnpm --filter @pm/shared test` + `build` pass.

### Step 4 — Per-project linkedRepos config

- Add `linkedRepos` to the integrator settings: canonical `integratorSettingsSchema` (`packages/shared/src/schemas/project.ts`) + the server route LOCAL Zod-4 mirror (`routes/projects.ts`) + integrator `config.ts` + pm-client. Each entry `{ name, path, role, gitlinkParent?, gitlinkPath? }`. Default empty (= single-repo, the 7.2 behavior).
- Tests: schema accept/default/reject; config loader surfaces it; server project-settings route round-trips it.

**Verify**: `pnpm --filter @pm/shared test` + server project-settings tests + integrator config tests pass. Empty-linkedRepos path unchanged from 7.2.

### Step 5 — Group service + state machine (PM)

- `packages/server/src/services/merge-group.service.ts`: createGroup (associate N member requests), getById (+ members), list, the group state machine with a central `assertCanTransition` guard (mirror 7.1's merge-request service). Member↔group invariant: a member can't land independently; the group transitions drive member visibility.
- Group transitions emit AFTER commit (the 7.1/7.2 discipline: status + side-effect in `db.transaction`, events after).
- Tests: `packages/server/tests/services/merge-group.test.ts` — create, member association, legal/illegal transitions, the can't-land-independently invariant.

**Verify**: `pnpm --filter @pm/server test` group service tests pass.

### Step 6 — Incident service (PM)

- `packages/server/src/services/merge-incident.service.ts`: openIncident (orphaned_inner with inner_repo/orphaned_sha/outer_repo/group), getById, list (by project/group/state), resolve (auto_resolved | human_resolved with resolution payload). Opening an incident auto-posts a `merge_incident` comment on the linked task (mirror 7.1's `merge_rejection` comment mechanism).
- Tests: `packages/server/tests/services/merge-incident.test.ts` — open, the task-comment side effect, resolve transitions, list filters.

**Verify**: `pnpm --filter @pm/server test` incident service tests pass.

### Step 7 — REST routes + MCP tools

- `packages/server/src/routes/merge-groups.ts` + `merge-incidents.ts` (OpenAPIHono, LOCAL Zod-4 mirror bodies — NEVER import @pm/shared Zod-3 into the OpenAPI route). Worker-facing: create group, get group, list incidents, get incident. Integrator-facing (HTTP-only): the group integration operations (mark integrating, land group, reject group, mark-orphaned, open/resolve incident). Mirror the 7.1 worker-vs-integrator auth split (ai_agent gate where appropriate). Mount in `app.ts`. Regenerate `openapi.json`.
- MCP tools (worker-facing): `pm_request_merge_group` (submit N requests as an atomic group), `pm_get_merge_group`, `pm_list_merge_incidents`, `pm_get_merge_incident`. Register in mcp-server; add api-client helpers.
- Tests: route tests (group create/get, incident list/get, integrator-only ops 403 for non-integrator) + MCP tool tests.

**Verify**: `pnpm --filter @pm/server test` + `pnpm --filter @pm/mcp-server test` pass; openapi exported.

### Step 8 — SSE events for groups + incidents

- Add `merge.group.*` (started/member_landed/landed/rejected) + `merge.incident.*` (opened/auto_resolved/human_resolved) to `EVENT_NAMES`. Emit from the group/incident services. The flattened SSE wire frame carries them via `onAll` (entity_type `merge_group` / `merge_incident`) — extend the wire frame if group/incident need extra fields (mirror the 7.2 batch_id pass-through). Synthetic events are FK-safe (verified pattern from 7.2).
- Tests: server SSE test that each event re-emits over `/api/v1/events`.

**Verify**: `pnpm --filter @pm/server test` SSE tests pass.

### Step 9 — Integrator: multi-repo worktree assembly

- Extend the reference integrator to assemble a multi-repo group state: lease correlated worktrees (one per linked repo) from a pool, check out inner@newSHA, update the outer's submodule gitlink to point at the inner's rebased tree, producing the assembled state. New module(s) in `packages/integrator-ref/src` (e.g. `group-assembly.ts` + git-ops extensions for submodule update). Reuse the 7.2 worktree pool; a group leases a correlated SET of slots.
- Tests: against a REAL two-repo git fixture (inner + outer-with-submodule, temp bare repos) — assembly produces a consistent inner@SHA + outer@(gitlink→SHA) tree.

**Verify**: `pnpm --filter @pm/integrator-ref test` assembly tests pass against real git.

### Step 10 — Integrator: group integration + assembled-state verify

- The integrator's group path: rebase each member onto live main (per repo), assemble, run each repo's per-repo verify command against the assembled state, collect results. All-pass → proceed to land (Step 11); any-fail → reject the whole group (nothing landed). Compose with the 7.2 scheduler (a group is an atomic unit, not speculatively interleaved internally).
- Tests: real-git fixture — assembled verify passes → group proceeds; one repo's verify fails → group rejected, no repo advanced.

**Verify**: `pnpm --filter @pm/integrator-ref test` group-integration tests pass.

### Step 11 — Integrator: atomic land + orphaned-inner detection

- The atomic land protocol (decision 2): push inner first; on success push outer with the updated gitlink. Inner push fail → reject group cleanly (nothing landed). Outer push fail after inner landed → call PM to mark the inner request `orphaned` + openIncident(orphaned_inner). Verify-gate-before-fast-forward preserved on BOTH pushes.
- Tests: real-git fixture with INDUCED failures — (a) inner push race → whole group rejected, neither repo advanced; (b) outer push fails after inner landed → inner orphaned + incident opened + outer NOT advanced; (c) clean path → both land atomically, both repos advance.

**Verify**: `pnpm --filter @pm/integrator-ref test` atomic-land + induced-failure tests pass.

### Step 12 — Orphaned-inner recovery (auto-rollforward + human fallback)

- The recovery state machine (decision 3, the proof-level-care part): on the next group integration the integrator detects the open orphaned-inner incident, attempts to roll the gitlink forward to absorb the orphaned inner SHA (verify-gated push). Success → resolve incident `auto_resolved`. Cannot reconcile (orphaned SHA conflicts with intervening outer history) → escalate: incident stays open, `merge_incident` comment + dashboard alert, human-resolvable. Outer main never advanced past an unverified assembled tree during recovery.
- Tests: real-git fixture — (a) orphaned inner, next integration auto-rolls-forward → incident auto_resolved, outer now at the inner SHA; (b) orphaned inner with conflicting intervening outer history → auto-rollforward declines, incident stays open for human, outer unchanged.

**Verify**: `pnpm --filter @pm/integrator-ref test` recovery tests pass; the auto-resolve and escalate branches both proven.

### Step 13 — Full-stack E2E + chaos against a real two-repo fixture

- Self-contained E2E (in-process PM + spawned integrator + real temp inner+outer gitlink git remotes), mirroring the 7.2 E2E harness. Flows: (a) a clean group of inner+outer changes lands atomically (both remotes advance, gitlink consistent); (b) assembled-verify failure → group rejected, neither remote advances; (c) the orphaned-inner case — outer push induced to fail after inner landed → incident opened + visible via PM API (the "detectable from PM alone" success criterion) → next group integration auto-rolls-forward → incident auto_resolved; (d) the un-reconcilable orphan → incident stays open, human-visible.
- Chaos: kill the integrator at each state transition (after inner push, before outer push, mid-assembly) and assert recoverability + no corruption (the vision's chaos requirement). Gate on git-available + built dist, default-on, leak-proof teardown.

**Verify**: the E2E runs (not skipped) and all flows pass; `pnpm test` green across the monorepo.

### Step 14 — Documentation

- `docs/integrator-deployment.md`: the `linkedRepos` config, the inner/outer worktree layout, the atomic-land protocol, orphaned-inner recovery + incident model, the new failure modes. Update the game_one layout to show rynx-inner + outer-gitlink.
- Finalize `docs/design/phase-7.3-design.md` with implementation-driven adjustments (a §deviations subsection like 7.2's §16).
- Update `CLAUDE.md` Merge train section: cross-repo atomicity + groups + incidents.
- Update `packages/integrator-ref/README.md`: linkedRepos in config-at-a-glance.
- Update `docs/design/phase-7-merge-train-vision.md` status if appropriate.

**Verify**: docs cross-checked against shipped source (config fields, event names, endpoints, table names); `pnpm typecheck` + `pnpm --filter @pm/server exec vitest run` green.

---

## Out of scope for Phase 7.3 (later phases)

- **Train dashboard / audit log / break-glass** — Phase 7.4 (7.3 emits the group + incident events the dashboard will consume; it does not build the dashboard UI).
- **Smart verification (caching, multi-stage, test-impact)** — Phase 7.5.
- **Multi-train lanes / permissions / advisory board** — Phase 7.6.
- **N>2 linked repos as a general DAG** — 7.3 targets the inner+outer (2-repo gitlink) shape game_one needs; a general N-repo dependency DAG is deferred unless the design proves it's free.

## Definition of done

- A group of linked inner+outer requests either all land (visible on every repo, gitlink consistent) or all reject (no repo advances).
- The orphaned-inner case is detectable from PM alone (no SSH) and recoverable — auto-rollforward on the common case, human-escalated incident on the un-reconcilable case.
- Induced-failure chaos tests pass: every state transition can be killed and recovered, no half-landed state reaches main.
- Single-repo requests (group_id null) behave exactly as 7.2 (backward compatible).
- game_one's rynx + outer gitlink case lands atomically.
- All existing tests stay green; new unit + real-git + E2E + chaos tests cover groups, assembly, atomic land, orphaned-inner recovery. Build + typecheck clean.
- Docs let an operator configure linkedRepos and reason about the orphaned-inner incident model.
