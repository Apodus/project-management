# Phase 7: Merge Train — Six Month Vision

**Goal**: A production-grade, PM-native merge train. Workers submit and walk away. A dedicated integrator agent rebases, verifies, and lands — atomically across linked repos, in parallel where safe, with structured rejection back to the implementor. Observable, recoverable, operator-friendly.

**Status**: Stage 1 shipped. Per-project named locks with FIFO queue, TTL lease, landing intent (taskId/branch/commitSha/verifyCmd/worktreePath), abandon reason, SSE event stream, MCP tools. This phase builds Stage 2 on top.

**Prerequisites**: Stage 1 merge lock + task claims + subsystem awareness (already shipped).

**Design liberties**: This is a vision document, not an execution spec. Concrete API shapes and table schemas are derived in per-month design docs as each phase begins. Architectural commitments (worker/integrator split, atomic cross-repo landing, verify-gate before main moves, structured rejection) are not negotiable.

---

## Vision

PM becomes the merge coordination layer for AI-heavy development. Workers commit, request a merge, and pick up new work — they never hold a lock during verify. A dedicated **integrator** agent (long-lived, per project, isolated checkout) processes the queue: rebases onto live main, runs verify, lands proven-green results, rejects red ones with structured context that lands as a task comment back on the implementor's task. Main is never broken because verification happens off to the side and only success fast-forwards.

By month six the train is operating game_one in production: 3–5 parallel speculative integrations, sub-2-minute typical land times, cross-repo atomic landing (rynx + outer gitlink), full audit trail, human break-glass controls, dashboards humans can read in 60 seconds.

## Principles

1. **PM owns coordination state. The integrator owns execution.** PM doesn't run builds; it knows what's queued, what's verifying, what landed, what failed. The integrator is a separate process — we ship a reference implementation, but it's not part of the server.
2. **Main is never broken.** Verification happens off to the side. Only proven-green tree SHAs fast-forward main.
3. **Workers submit and walk away.** No agent should be parked on a lock for the duration of a verify build.
4. **Failure is information.** Rejections carry category, files, log pointer, and auto-post to the implementor's task. A red verify is not lost — it's actionable.
5. **Atomicity across linked repos.** A change that spans inner + outer (rynx + gitlink) lands as a unit or not at all. No half-landed states reach main.
6. **Observable by default.** Every state transition is an event. Every action is auditable. Operators read the dashboard, not the source.
7. **Backwards compatible.** Stage 1 workers (acquire / release directly) keep working through Stage 2 rollout. Migration is opt-in.
8. **Single-machine first-class.** game_one's setup — agents sharing a host, isolated worktrees per agent — is a primary deployment target, not an afterthought.

---

## Phase 7.1 — Month 1: Worker/Integrator Split

**Goal**: Smallest possible train. Workers submit; one integrator integrates serially. Verify gate. Structured rejection.

**Why now**: Stage 1 forces the implementor to do their own rebase + verify + land. That's fragile, parks them for 3–5 minutes per attempt, and doesn't scale. Splitting worker from integrator is the single change that enables every later phase.

**Deliverables**:
- `merge_requests` model: decouples the submission from the lock. Carries taskId / branch / commitSha / verifyCmd / worktreePath (already designed for Stage 1 landing intent). State machine: `queued → integrating → landed | rejected | abandoned`.
- `pm_request_merge` MCP tool: workers call this and are done. Replaces the acquire/release pattern for the common case.
- `merge_attempts` model: each verify run against a tree SHA, with result + log pointer + category. One request can have multiple attempts (rebase + verify each time the predecessor lands or rejects).
- Structured `reject(reason, category, failedFiles, logExcerpt | logUrl)`: as a first-class operation, not a flag on release. Auto-posts a comment of type `merge_rejection` on the linked task with the structured payload as metadata.
- SSE events: `merge.request.queued`, `merge.request.integrating`, `merge.request.landed`, `merge.request.rejected`. Workers subscribe to know what happened to their request.
- Git refs auto-attached on land: a new `git_refs` entry of type `landed` on the linked task. Closes the loop "where did my work end up."
- **Reference integrator agent** (`packages/integrator-ref`): a long-lived Node/TS process. Configurable per project. Subscribes to PM, maintains its own isolated checkout, runs the rebase/verify/land cycle. This is what game_one deploys.
- Per-project config (project settings JSON): `integrator.verifyCommand`, `integrator.verifyTimeoutSec`, `integrator.worktreeRoot`, `integrator.gitRemote`.
- Documentation: integrator deployment guide.

**Success criteria**:
- A worker can `pm_request_merge` and exit. Within `verifyTimeoutSec + queue_wait`, they receive a landed-or-rejected event.
- A verify failure produces a structured rejection with category and failedFiles, posted as a task comment on the implementor's task.
- Landed SHAs appear as `git_refs` on the linked task.
- Main is never broken: any verify failure → reject, never land.
- The skinned_renderer scenario (cross-agent API drift discovered at build) and the bootstrap-rediscovery scenario would now both be caught and surfaced as actionable comments before reaching main.

**Game_one impact**: Core "submit and walk away" works. Throughput is still serial (~12–20 req/hr at 3–5 min builds), but the train no longer requires a human in the loop or a parked implementor.

---

## Phase 7.2 — Month 2: Speculative Batching

**Goal**: 3–5 in-flight integrations in parallel. Throughput scales near-linearly with worktree count.

**Why now**: At 3–5 min build times, serial integration caps at ~12–20 requests/hour. For a multi-agent team that's the throughput killer. Speculative batching is the merge-train trick that gets you from "serialized on verify" to "verify-runtime ceiling."

**Deliverables**:
- **Worktree pool**: integrator manages N parallel isolated worktrees per project (config `integrator.parallelism`). Each worktree is an isolated checkout — never a shared `.git`.
- **Batch state machine**: requests A, B, C verify in parallel:
  - A's tree is `main + A`. B's tree is `main + A + B`. C's tree is `main + A + B + C`.
  - All three verifies run concurrently against their assumed-predecessor states.
  - If A passes, A lands. If B is still verifying, it continues unchanged. If A fails, the suffix (B, C) is invalidated — they re-verify against the new main and are placed at the head of the next batch.
- **Failure isolation**: a single rejection doesn't cascade. Predecessors that already passed still land.
- **Backpressure**: when the worktree pool is saturated, new requests wait in the head queue. No request is dropped.
- **Verify retry policy**: transient failures (network blip, infra timeout) auto-retry with backoff. Real failures don't.
- **Batch events**: `merge.batch.started`, `merge.batch.member_landed`, `merge.batch.member_invalidated`, `merge.batch.completed`.
- **Batch query API**: `GET /api/v1/projects/:id/merge-batches` returns current and recent batch state, member-by-member.
- **Worktree management module** in the reference integrator: spawn / reset / repair / garbage-collect worktrees. Critical because shared `.git` is the documented footgun.

**Success criteria**:
- 3–5 parallel integrations sustained for game_one.
- Throughput scales near-linearly with `parallelism` up to the verify-runtime ceiling.
- A single verify failure invalidates exactly the dependent suffix — never more, never less.
- Worktree leaks (orphaned checkouts) are detectable and auto-recovered.

**Game_one impact**: 5–10x throughput improvement. Queue depth at typical load goes from "growing" to "draining."

---

## Phase 7.3 — Month 3: Cross-Repo Atomicity

**Status**: **Shipped** (2026-05-30). PM-owned `merge_request_groups` + `merge_incidents` tables (+ nullable `merge_requests.group_id`), the `orphaned` member state, `linked_repos` config (inner/outer + gitlink), assembled-state concurrent verify, the inner-then-outer atomic-land protocol with the three failure points, PM-keyed orphaned-inner auto-rollforward recovery + human escalation, stranded-group crash recovery, group/incident REST + MCP surface and SSE events, and a real two-repo-fixture E2E + chaos suite. See `docs/design/phase-7.3-design.md` (incl. §16 implementation deviations) and the deployment guide §14.

**Goal**: A change spanning multiple linked repos lands as a unit or not at all. No half-landed gitlink states reach main.

**Why now**: game_one has rynx (inner Rust workspace) + outer gitlink (game repo containing rynx as submodule). The agents' team identified the half-landed gitlink as their primary corruption case. Until we model this, the train is unsafe for the real shape of the codebase.

**Deliverables**:
- `merge_request_groups` model: multiple `merge_requests` can be tagged as members of a group, must succeed-or-fail atomically.
- Per-project config: declare linked repos: `linkedRepos: [{ name, path, gitlinkParent?, gitlinkPath? }]`. The integrator understands the relationship.
- **Group integration**: when a group is in-flight, all member repos are checked out into worktrees with consistent SHAs. Verify runs against the assembled state (inner rebuilt, outer with the new submodule SHA).
- **Atomic land**: inner pushed first, then outer with the updated gitlink, in the same integrator transaction. If outer push fails after inner landed, the inner SHA is marked `orphaned` and a structured incident is opened. (Inner push failures stop the whole group cleanly.)
- **Orphaned-inner recovery**: a `merge_incidents` model tracking these. Either auto-recovered (next group integration rolls the gitlink forward) or surfaced to humans (incident comment on the task, dashboard alert).
- **Per-repo verify commands**: groups can declare per-repo verify (rynx tests on inner, integration tests on outer). All must pass.
- **Tests against a real two-repo fixture**: not mocked — a temp git fixture exercising the full inner/outer gitlink cycle, including induced failure modes (push race, fs-full, network drop mid-push).

**Success criteria**:
- A group of N linked requests either all land (visible on every repo) or all reject (no repo advances).
- The orphaned-inner case is detectable from PM alone (no SSH into the integrator host).
- Induced-failure chaos tests pass: every state transition can be killed and recovered.
- game_one's rynx + outer gitlink case lands atomically in production.

**Game_one impact**: The single most-cited correctness concern is eliminated. Multi-repo changes become safe.

---

## Phase 7.4 — Month 4: Observability + Break-Glass

**Goal**: A human can answer "what's wrong with the train" in 60 seconds from the dashboard. When something is genuinely stuck, humans can unwedge it without database surgery.

**Why now**: After Months 1–3 the train is doing real work, and it will get stuck in ways we didn't predict. Without observability and override controls, every incident requires a developer with source-code knowledge. We can't ship a system that depends on its authors to operate.

**Deliverables**:
- **Train dashboard** (web UI): queue depth, in-flight batches with per-member state, integrator heartbeat freshness, recent landings/rejections, last 24h time-to-land p50/p95/p99, verify success rate, abandon rate, current worktree pool utilization.
- **Per-request timeline view**: queued → batched → verifying → landing → done, every state with timestamp, every verify attempt with link to log. The single page that answers "what happened to my merge?"
- **Audit log**: every land/reject/override/pause/resume/force-* is a recorded event with actor, timestamp, request/batch/lock id, reason. Queryable by user, by request, by time window.
- **Human override endpoints + UI**:
  - Pause train (stop accepting new requests; finish in-flight cleanly)
  - Resume train
  - Force-release a stuck lock (admin-only, audited)
  - Force-land a request (skip verify — emergency only, requires explicit reason)
  - Force-reject a stuck verify
- **Integrator health channel**: integrator emits heartbeats into PM. Missed heartbeats raise a `train.integrator_unhealthy` event. Dashboard shows "last heard from integrator: 47s ago."
- **Webhook alerts**: configurable hooks on `train.stuck`, `train.abandon_rate_high`, `train.integrator_unhealthy`. Defaults route to Discord (already integrated).
- **SLO definitions** (recorded, not enforced): target p95 time-to-land, target verify success rate, target abandon rate. The dashboard surfaces SLO compliance per project.

**Success criteria**:
- An operator who has never seen the codebase can diagnose 8/10 simulated train incidents from the dashboard alone.
- Every break-glass action is auditable and reversible (or rollforward-safe).
- Stuck trains can be unwedged via the UI; no DB surgery, no SSH.
- Alerts fire before users notice.

**Game_one impact**: When the train misbehaves (it will), the team can see and act. No 2am SSH sessions.

---

## Phase 7.5 — Month 5: Smart Verification

**Goal**: p50 time-to-land drops by 50%+. Cheap failures fail in <30s. Stacked changes reuse predecessor build state.

**Why now**: Verify is the throughput ceiling. Making verify smarter (cache, skip, parallelize, fail-fast) is the highest-leverage performance work. Until this month we've been throwing parallelism at a fixed cost; this month attacks the cost.

**Deliverables**:
- **Verify-result caching**: keyed by tree SHA + verify-step identity. If `(tree=abc, step=cargo test --workspace)` passed yesterday, today's identical attempt skips. Stacked changes (A → B where B doesn't touch A's deps) reuse A's artifacts.
- **Multi-stage verify pipeline**: per-project DAG of verify steps. Cheap stages first (format → lint → typecheck), expensive stages last (unit → integration → e2e). Fail-fast on cheap failures (<30s to known-bad).
- **Test impact analysis** (per-project, opt-in): the integrator computes changed paths against the integration base and runs only affected tests. Per-project config maps paths → test selectors (e.g. `crates/renderer/**` → `cargo test -p renderer`). Falls back to full suite when uncertain.
- **Parallelism within a verify pipeline**: independent steps run concurrently. The pipeline DAG declares dependencies.
- **Artifact handoff between batched verifies**: predecessor build cache feeds successor incremental build, so B's verify doesn't compile from scratch.
- **Per-step metrics**: which steps take longest, which fail most, time saved from caching. Surfaced on the dashboard. Operators see exactly where time goes.
- **Cache invalidation discipline**: a verifiable rule for what makes a cache entry stale (tree-SHA change + step-config-SHA change). No "stale cache passed but real run would have failed" bugs.

**Success criteria**:
- p50 time-to-land for game_one drops from 3–5 min to <2 min.
- Cheap-fail attempts (formatting, lint) cost <30s end-to-end.
- Cache hit rate exceeds 50% for stacked changes (measurable, dashboarded).
- No false-pass incidents traced to caching.

**Game_one impact**: Verify is no longer the user-perceived bottleneck. Most lands feel "instant."

---

## Phase 7.6 — Month 6: Hardening + Multi-Train

**Goal**: Production-grade reliability. Operator's guide answers the real questions. Multiple train lanes (hotfix vs feature) supported. The deferred advisory board ships, informed by 5 months of observed behavior.

**Why now**: Months 1–5 built the system. Month 6 makes it operable at scale by people who didn't build it.

**Deliverables**:
- **Crash recovery**: deliberate kill-switch tests at every state transition. On integrator restart, in-flight batches are rolled back to consistent state. No state corruption from random crashes.
- **Disk / network partition handling**: worktree disk full, git push timeout, lost connection mid-batch — each has a defined recovery path, tested, surfaced as a structured incident when human action is required.
- **Chaos test suite**: weekly automated runs against a real-git fixture, killing the integrator at randomly chosen points, asserting state recoverability and no corruption.
- **Multi-train support**: per-project, multiple named train configs (e.g. `main` and `release-branch`), each with its own `verifyCommand`, `parallelism`, `priority`. The Stage 1 `resource` field already supports the naming; this month operationalizes the per-resource config layer.
- **Lane priority**: `hotfix` lane can preempt `feature` lane (configurable). Permissions: who can submit to which lane.
- **Permissions model**: per-project roles for `train.integrator_override` (force-land/reject), `train.lane_submit:<lane>` (per-lane submission), `train.pause` (pause/resume). Layered on existing PM user roles.
- **Advisory / bulletin board**: the deferred Stage 1 item. Now informed by 5 months of observed knowledge flow. Likely shape: `type: "advisory"` tasks pinned project-level + an explicit `promotedToDoc` lifecycle so durable knowledge gets exfiltrated to docs/memory.
- **Operator's guide**: troubleshooting runbook for the top 15 incident classes seen during Months 4–5. Each entry: symptom, diagnosis, fix, prevention.
- **Integrator deployment guide**: install, configure per-project, verify command setup, multi-train config, permissions, alerting wire-up.
- **End-to-end SLO report**: 90-day retrospective on p95 time-to-land, throughput, abandon rate, verify success rate. Drives priority for any 7.7+ work.

**Success criteria**:
- Chaos suite passes: zero state-corruption incidents over a month of random-kill testing.
- Multi-train deployed for game_one's hotfix vs feature use case.
- Operator's guide diagnoses 12+ of the top 15 historical incidents.
- A new operator can deploy a fresh integrator in <30 minutes following the guide.

**Game_one impact**: The train is production. New team members can operate it. New projects can adopt it.

---

## Cross-cutting tracks (run alongside all phases)

1. **Reference integrator lockstep**: every PM API change ships with the reference integrator updated and tested in the same PR. The integrator is the contract enforcer.
2. **Real-git integration tests**: each phase adds tests against an actual git fixture, not mocks. Unit tests verify logic; integration tests verify behavior. End-to-end correctness matters more than coverage count.
3. **Backwards compatibility**: Stage 1 `acquire`/`release`/`heartbeat` keep working throughout. A worker can ignore Stage 2 and continue self-integrating. Migration to `pm_request_merge` is opt-in per agent.
4. **Documentation**: per-month design doc in `docs/design/`. Operator's guide grows monthly. Reference integrator README + deployment guide kept current.
5. **Security review**: each phase's new MCP tools and HTTP endpoints get reviewed for authz before merge. Especially Month 4 break-glass and Month 6 permissions.
6. **Game_one feedback loop**: weekly checkpoint with the game_one agents to confirm the next phase's design lands the actual pain points, not theoretical ones.

## Non-goals (intentionally not building)

- **Code review / PR system**. PM is not a Gerrit or GitHub clone. The train integrates already-reviewed commits.
- **Build artifact storage**. Verify outputs are pointers (log URLs); we don't host artifacts.
- **General-purpose CI runner**. The integrator runs verify commands the project configures; it's not a parallel SaaS CI.
- **Multi-tenant cloud deployment**. PM remains small-team local/LAN.
- **Cross-project merge coordination**. Each project's train is independent.
- **Web-based merge submission flow**. Workers are agents, not humans clicking buttons. Humans use the dashboard to *observe* and *intervene*, not to submit.

## Risks

1. **Single-integrator bottleneck**. Mitigated by Month 2 speculative batching and Month 5 smart verification. If still insufficient at scale, multi-integrator-per-resource is a future addition (probably 7.7).
2. **Flaky verify**. Random test failures will block real work. Month 2 retry policy + Month 4 metrics + Month 5 smart selection compound to address this. Honest reality: until flaky tests get fixed at the source, no train can fully solve it.
3. **Cross-repo atomicity correctness**. The orphaned-inner case (Month 3) is genuinely tricky. Recovery state machine needs proof-level care. Plan: write the design doc first, get a second review, then implement.
4. **Worktree disk usage**. N parallel worktrees + verify artifacts = significant disk. Need monitoring and cleanup. Surface in Month 4 dashboard; address concretely if observed.
5. **Reference integrator forks**. If projects modify the reference integrator, lockstep breaks. Mitigation: design for config-not-code; reserve "extension hooks" for project-specific glue rather than encouraging forks.
6. **Permissions complexity**. Month 6 layers role-based access on top of existing PM users. Risk of permissions overreach (locking out humans) or underreach (agents bypassing controls). Plan: ship with sane defaults; document override paths.

## Open questions (to resolve as we approach each phase)

1. **Integrator process locality**. Always external (separate process), or can it run embedded in PM for small deployments? Current lean: external for separation of concerns; revisit if game_one's operational overhead becomes a complaint.
2. **Worktree pool sizing**. Static config or dynamic based on observed verify runtime? Lean: static for Month 2, revisit in Month 5 when we have metrics.
3. **One integrator per train, or multi-train per integrator?** Affects deployment model. Lean: one process per train for fault isolation; one container per project is fine.
4. **Advisory board scope** (Month 6). Is it the same surface as the train's audit log? They might converge. Decide based on observed knowledge-flow patterns during Months 4–5.
5. **Per-step verify event granularity**. Emit events per step, or only on overall success/failure? Lean: minimal events until Month 4 dashboard shows what operators actually need.
6. **Stage 1 migration path**. At what point do we deprecate the direct acquire/release flow? Lean: never. Both coexist; Stage 2 is the recommended path but Stage 1 stays for emergencies and simple use cases.

## Sequencing rationale

Phases are ordered by dependency, not difficulty. Month 1 (worker/integrator split) is the foundation everything else builds on. Month 2 (batching) needs Month 1's request model. Month 3 (cross-repo) needs Month 2's batch state. Month 4 (observability) is most valuable once there's real volume to observe — earlier is premature, later is too late. Month 5 (smart verify) needs Month 4's per-step metrics to know what to optimize. Month 6 (multi-train + hardening) is operational maturity work, naturally last.

A team could compress 2 → 3 if they're willing to do cross-repo before batching, but speculative batching exposes more state machine corners earlier and surfaces design issues that matter for cross-repo. Recommended order is the natural one.

## Definition of done (end of Month 6)

- game_one runs production merges through the train. Humans intervene <1x/week.
- p95 time-to-land < 5 minutes including queue wait. p50 < 2 minutes.
- Verify success rate > 85%. Abandon rate < 5%.
- Cross-repo (rynx + gitlink) atomicity verified in production. Zero half-landed states observed.
- Dashboard answers operator questions. Audit log answers historical questions.
- Reference integrator deployable by a new project in <30 minutes.
- Operator's guide covers all top-15 incident classes.
- Phase 8 (whatever it is) has a clear motivation from observed data, not speculation.
