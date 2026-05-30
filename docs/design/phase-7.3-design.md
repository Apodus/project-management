# Phase 7.3 Design: Cross-Repo Atomicity

**Target audience**: Claude agents (design, implementation, testing) and the human director
**Created**: 2026-05-30
**Status**: Shipped (Steps 2–13 complete) — see §16 for implementation-driven deviations. Step 1 was the load-bearing design step; its adversarial verification was the vision's required "second review."
**Parent roadmap**: `roadmaps/phase-7.3-cross-repo-atomicity.md`
**Vision reference**: `roadmaps/phase-7-merge-train-vision.md` (Phase 7.3, Risk #3)

This document is the authoritative architecture spec for Phase 7.3 (Month 3) of the merge-train build. Every later step (Steps 2-14 of the roadmap) treats this file as the single source of truth for the linked-repo model, the PM-owned group + incident data models and their state machines, the assembled-state verify sequence, the atomic-land protocol, the orphaned-inner recovery state machine, the lane-lock-under-groups model, the PM-invariant audit, the SSE event set, and the failure catalog. **When this document and the roadmap disagree on a detail, this document wins.**

This doc **builds on `docs/design/phase-7.2-design.md`** (and transitively on `phase-7.1-design.md`). Those contracts are unchanged unless explicitly noted here. In particular the following are inherited verbatim:

- 7.1 §5 (request + attempt state machines), §6 (the decision matrix + canonical idempotency rule), §9 (SSE wire frame), §14 (the reference-integrator architecture), §15 (failure catalog).
- 7.2 §3 (in-memory batch model), §5 (concurrency), §6 (structural land-gate), §7 (suffix invalidation), §9 (lane-ownership lock), §12 (PM-invariant audit - the **template** §9 of this doc mirrors), §13 (batch observability / the integrator-relay model - which §10 here deliberately **diverges from**).

Where 7.3 changes something - the addition of PM-owned durable coordination state (§1, §3, §4), the multi-repo assembled verify (§5), the atomic land protocol (§6), the recovery state machine (§7) - the change is called out at the point of divergence. Everything else in 7.1/7.2 stands.

---

## 0. Reading guide

The load-bearing sections, in dependency order: **§1** (the divergence principle that justifies PM tables), **§3/§4** (the group + incident data models - every later contract names these columns), **§6** (the atomic land protocol + its three failure points), and **§7** (the orphaned-inner recovery state machine - the proof-level-care part). The remaining sections compose around those four: §2 grounds the linked-repo config; §5 grounds assembled verify on the 7.2 worktree pool; §8 confirms no second lock; §9 is the PM-invariant audit; §10 the events; §11 the failure catalog; §12 the backwards-compat proof; §13 the roadmap pointer.

The single most important invariant, stated once here and proven in §6/§7: **outer `main` is NEVER advanced to a gitlink that points at an inner SHA whose assembled tree has not passed verify - not during normal land, not during orphan recovery.** Every push to outer is verify-gated. This is the structural elimination of the half-landed-gitlink corruption case.

---

## 1. Goals, non-goals, and the settled decisions

Month 3 makes a change that spans game_one's **rynx inner Rust workspace** and the **outer game repo** (which embeds rynx as a git submodule / gitlink) land **as a unit or not at all**. No half-landed gitlink state ever reaches outer `main`. When the dangerous middle case does occur - inner landed, outer push failed - it is recorded as a durable, PM-queryable **incident**, auto-recovered on the common path and human-escalated on the un-reconcilable path.

### 1.1 The settled decisions (non-negotiable, restated from the roadmap)

> 1. **Group + incident state is PM-OWNED (durable coordination state) - a deliberate divergence from 7.2.** 7.2 kept batch state integrator-owned because it is transient EXECUTION state. Groups and incidents are different: they are durable COORDINATION state, and a hard 7.3 success criterion is *"the orphaned-inner case is detectable from PM alone (no SSH into the integrator host)."* That requires PM tables + query endpoints. So 7.3 ADDS `merge_request_groups` and `merge_incidents` to PM. This does NOT walk back 7.2 - batch execution state stays integrator-owned; only group-membership and incident records are PM-side.
> 2. **Atomic land order: inner-first, then outer gitlink, in one integrator transaction.** Inner push fails -> reject the whole group cleanly (nothing landed). Outer push fails AFTER the inner landed -> mark the inner SHA `orphaned` and open a `merge_incident`.
> 3. **Orphaned-inner recovery: auto-rollforward + human fallback.** The next group integration auto-rolls the gitlink forward to absorb the orphaned inner SHA (verify-gated). If it cannot reconcile (orphaned inner SHA conflicts with intervening outer history) -> escalate to humans: incident stays open, `merge_incident` comment on the linked task + dashboard alert. NEVER auto-mutate in a way that could break outer main - the verify-gate-before-fast-forward invariant from 7.1/7.2 still holds for the roll-forward push.
> 4. **Verify runs against the ASSEMBLED multi-repo state.** Inner rebuilt at its new SHA; outer checked out with the new submodule SHA pointing at the inner's rebased tree; per-repo verify commands all run against that assembled state. All must pass before any land.
> 5. **Backwards compatible.** A single-repo merge request (no group) flows exactly as 7.2. Groups are opt-in. `parallelism` batching still applies to single-repo lanes; a group integrates as an atomic unit (its members are not speculatively interleaved with each other).

The PM-owned-group/incident-state decision, inner-first atomic land order, auto-rollforward+human-fallback recovery, assembled-state verify, and single-repo backward compatibility are NOT negotiable. Implementing agents may make tactical decisions within these constraints.

### 1.2 The divergence principle (state this explicitly)

> **Transient EXECUTION state lives in the integrator (in-memory). Durable COORDINATION / INCIDENT state lives in PM (tables).**

7.2's `Batch`/`Member` model is transient execution state: it exists only while a batch is draining, a crash discards it entirely, and recovery rebuilds nothing (7.2 §3). That was correct for speculative batching because nothing outside the draining process needs to query "what batch is in flight" - the observability contract was events, not tables (7.2 §13, decision 1).

7.3 is different in exactly one respect that forces the divergence: the **orphaned-inner case must be detectable and recoverable from PM alone, with no SSH into the integrator host** (vision success criterion). An orphaned inner is a *durable fact about main* - the inner repo's `main` has advanced to a SHA that the outer gitlink does not yet reference. That fact outlives the integrator process that created it (the integrator may crash, restart, or be replaced), must survive across group integrations (recovery happens on a *later* group's integration, §7), and must be queryable by a human operator and the Phase 7.4 dashboard. A transient in-memory record cannot satisfy any of those. Therefore:

- **Group membership** (`merge_request_groups` + `merge_requests.group_id`) is PM-owned: it is the durable record of "these N requests must land or fail atomically," queried by workers (did my group land?), by the integrator (pick up a whole group as a unit), and by the dashboard.
- **Incidents** (`merge_incidents`) are PM-owned: the durable record of an orphaned inner, queryable from PM alone, surfaced as a task comment + dashboard alert, and resolved (auto or human) by a later integration.
- **Batch execution state STAYS integrator-owned.** 7.3 does not add a PM batch table, does not persist speculative ordering, and does not change the 7.2 in-memory `Batch`/`Member` model. A group is integrated *inside* the integrator's existing batch machinery (§5/§8) as one atomic unit; the integrator still owns the worktree pool, the rebase chains, and the land sequencing. The only new PM-side persistence is the two coordination/incident tables.

This is the one place 7.3 deliberately departs from a 7.2 design decision, and the departure is principled: 7.2 decision 1 ("integrator-owned, no PM tables") was scoped to *batch execution state*; it never spoke to *durable cross-repo coordination/incident state*, which did not exist until 7.3. The principle above is the rule that tells future phases which side of the line a new piece of state falls on.

### 1.3 Non-goals (and the deferred generalization)

- **No N-repo general DAG.** 7.3 targets the **inner + outer 2-repo gitlink** shape game_one needs (one inner submodule embedded in one outer parent at a known path). A general N-repo dependency DAG is deferred (roadmap "Out of scope"). §2.4 notes where the data model is already N-tolerant and where the land/recovery algorithms assume exactly one inner + one outer; the algorithms are written for the 2-repo case and the design does NOT claim the N-repo generalization is free.
- **No dashboard / break-glass UI** - Phase 7.4. 7.3 emits the group + incident events the dashboard consumes (§10) and exposes the PM query endpoints, but builds no UI.
- **No verify-result caching / multi-stage verify** - Phase 7.5.
- **No multi-lane-per-process** - Phase 7.6. One integrator process owns exactly one `(project, resource)` lane (7.1 §14.1, unchanged).

### 1.4 Prime invariant (the backwards-compat anchor)

> **A single-repo merge request (`group_id` null) is byte-identical in PM state and integrator behavior to 7.2.**

The `group_id` FK is nullable; every existing query, the 7.2 scheduler, the suffix-invalidation, the lane lock, and the crash-recovery sweep treat a null-`group_id` request exactly as today. Groups are a strictly additive opt-in. §9 audits this; §12 proves it.

---

## 2. The linked-repo model

### 2.1 Config shape

`linkedRepos` is a new optional field on the per-project integrator settings (roadmap Step 4 adds it to `integratorSettingsSchema` in `packages/shared/src/schemas/project.ts`, its server-route Zod-4 mirror in `routes/projects.ts`, and the integrator `config.ts`). Default **empty** (`[]` / absent) = single-repo, the 7.2 behavior.

```jsonc
// projects.settings.integrator.linked_repos  (snake_case in PM settings JSON)
"linked_repos": [
  {
    "name": "rynx",                    // logical repo name (matches the group member's target repo)
    "path": "/srv/git/rynx.git",       // the inner repo's remote (clone URL or bare path)
    "role": "inner",                   // "inner" | "outer"
    "gitlink_parent": "game",          // the OUTER repo's `name` that embeds this inner (inner only)
    "gitlink_path": "vendor/rynx"      // path within the outer tree where the gitlink/submodule lives (inner only)
  },
  {
    "name": "game",
    "path": "/srv/git/game.git",
    "role": "outer"
  }
]
```

Integrator-side (camelCase on `IntegratorConfig`): `linkedRepos: [{ name, path, role, gitlinkParent?, gitlinkPath? }]`. The snake_case<->camelCase split mirrors the existing `parallelism` convention (7.2 §2).

### 2.2 The game_one shape, precisely

game_one has exactly two linked repos:

- **`rynx`** - the inner Rust workspace. `role: "inner"`. It is embedded in the outer repo as a git submodule. Its `gitlinkParent` is `"game"` and its `gitlinkPath` is the submodule path inside the outer working tree (e.g. `vendor/rynx`). The outer repo's `.gitmodules` entry and its tree gitlink (mode `160000`) at `gitlinkPath` both reference a rynx commit SHA.
- **`game`** - the outer game repo. `role: "outer"`. It contains the gitlink at `gitlinkPath` pointing at a rynx commit. It has no `gitlinkParent`/`gitlinkPath` of its own (it is the top of this 2-repo tree).

The relationship is fully derivable from config: given the inner entry, the integrator knows (a) which repo is the submodule (`role: "inner"`), (b) which repo is its parent (`gitlinkParent` -> the outer entry's `name`), and (c) where the gitlink lives in the outer tree (`gitlinkPath`). No SSH inspection of the repos is needed to understand the topology - it is declared.

### 2.3 How the integrator understands the gitlink

The gitlink is a tree entry of mode `160000` (a "commit" entry) at `gitlinkPath` in the outer repo's tree. "Bumping the submodule" means: stage that path to a new rynx commit SHA and commit the outer tree. The integrator's submodule-update op (a Step-9 git-ops addition, §5.4 / §6.4) performs exactly this: in the outer worktree, set the gitlink at `gitlinkPath` to the inner's rebased SHA, then commit. The `.gitmodules` `url`/`path` are configuration the operator seeds once; the integrator only ever mutates the gitlink SHA, never `.gitmodules` itself.

### 2.4 N-repo tolerance vs the 2-repo algorithm

The **data model** (§3/§4) is N-tolerant: a group can in principle carry N member requests, and `merge_incidents` records a single (inner_repo, outer_repo) pair per incident. But the **land protocol (§6) and recovery (§7) are written for exactly one inner + one outer**: "inner-first then outer" presumes a single inner whose SHA the single outer gitlink absorbs. A general N-repo DAG (multiple inners, transitive gitlinks, inner-of-inner) would need a topological land order and a per-edge incident model; that is explicitly deferred. The design does NOT prove the N-repo case free. Where the 2-repo assumption is load-bearing it is flagged inline (§6.2, §7.2).

---

## 3. Group data model (PM-owned)

### 3.1 The `merge_request_groups` table

New Drizzle table in `packages/server/src/db/schema.ts` (roadmap Step 2). Column conventions match the existing `merge_requests`/`merge_attempts` tables exactly: `text("id").primaryKey()` ULID, `text` ISO-8601 timestamps (not integer epoch), snake_case DB column names, `.references()` FKs, non-unique `index(...)` for query paths.

```ts
export const mergeRequestGroups = sqliteTable(
  "merge_request_groups",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    resource: text("resource").notNull().default("main"),
    // Group state machine (§3.3). Enum lives in @pm/shared
    // (MERGE_GROUP_STATES) - added in Step 3. Default "forming".
    state: text("state").notNull().default("forming"),
    submittedBy: text("submitted_by").notNull().references(() => users.id),
    // The integrator that picked the group up (mirrors the lane-lock holder).
    // Null until integration begins.
    integratorId: text("integrator_id").references(() => users.id),
    resolvedAt: text("resolved_at"),
    // Free-text summary of why the group rejected or partially landed -
    // observer context, like merge_locks.abandonReason.
    resolutionReason: text("resolution_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_merge_request_groups_project_state").on(table.projectId, table.state),
    index("idx_merge_request_groups_resource_state").on(
      table.projectId, table.resource, table.state, table.createdAt,
    ),
  ],
);
```

### 3.2 Association: nullable FK vs join (decision)

**Decision: a nullable `group_id` FK column on `merge_requests`, ON DELETE SET NULL. Not a join table.**

```ts
// added to the existing merge_requests table (Step 2):
groupId: text("group_id").references(() => mergeRequestGroups.id, { onDelete: "set null" }),
// + index("idx_merge_requests_group").on(table.groupId)
```

Justification:

1. **A request belongs to at most one group.** The relationship is strictly many-requests-to-one-group (a member is in exactly one atomic unit). A join table models many-to-many, which would *permit* a request in two groups - an illegal state we'd then have to forbid with a unique constraint anyway. A nullable FK encodes the real cardinality directly and makes "is this a group member?" a single-column read (`group_id IS NULL` = single-repo).
2. **`ON DELETE SET NULL` mirrors the shipped `taskId` discipline.** The existing `merge_requests.taskId` is `references(tasks.id, { onDelete: "set null" })` precisely so a deleted task orphans nothing (schema.ts:474). A deleted group must likewise orphan nothing: the member rows survive with `group_id` nulled, degrading cleanly to single-repo requests rather than cascade-deleting in-flight merge state.
3. **Backwards compat is free.** Existing rows get `group_id = NULL` by default; every existing query that does not mention `group_id` is unaffected (§9, §12). A join table would still leave `merge_requests` rows unchanged but would add a second table every list/detail query must LEFT JOIN to surface membership - strictly more query surface for no modeling benefit.
4. **`idx_merge_requests_group`** makes "all members of group G" a fast indexed lookup - the integrator's group-pickup and the group service's `getById(+members)` both need it.

### 3.3 Group state machine

```
forming ----------------> integrating ------> landed
   |                          |
   |                          +-------------> rejected
   |                          |
   |                          +-------------> partially_landed
   +--> rejected (abandoned while forming, e.g. worker cancels)
```

States (enum `MERGE_GROUP_STATES = ["forming","integrating","landed","rejected","partially_landed"]`, Step 3):

| State | Meaning | Member states implied |
|---|---|---|
| `forming` | Group created; member requests being associated; not yet picked up. | all members `queued` |
| `integrating` | The integrator owns the lane and is assembling + verifying the group as a unit. | all members `integrating` |
| `landed` | Inner AND outer both pushed; every member landed atomically. Terminal. | all members `landed` |
| `rejected` | Inner push failed, OR assembled verify failed, OR abandoned while forming -> nothing landed. Terminal. | all members `rejected`/`abandoned` |
| `partially_landed` | Inner landed but outer push failed -> the orphaned-inner case. An incident is open. Terminal for the group; the orphan is resolved via the incident. | inner member `orphaned` (landed on the inner remote, group-land not completed), outer member(s) `rejected` |

Legal transitions (enforced by a central `assertCanTransition` guard in `merge-group.service.ts`, mirroring `merge-request.service.ts:assertCanTransition`):

- `forming -> integrating` (integrator pickup of the whole group; ai_agent only)
- `forming -> rejected` (worker/admin cancel while forming)
- `integrating -> landed` (atomic land success, §6)
- `integrating -> rejected` (inner-push-fail or assembled-verify-fail, §6 failure points a/c)
- `integrating -> partially_landed` (outer-push-fail-after-inner-land, §6 failure point b)
- Terminal states are idempotent-noop on re-application (matching the 7.1 idempotency rule §6.1).

### 3.4 Member lifecycle vs group lifecycle - the pinned invariant

> **INVARIANT G1 (no independent land): a member request whose `group_id` is non-null MUST NOT transition to `landed` except as part of its group's atomic land. A group member never lands "on its own."**

Pinned precisely:

- A grouped member's `merge_requests.status` still moves through the 7.1 machine (`queued -> integrating -> landed | rejected`), but those transitions are **driven by the group integration**, not by an independent single-repo land path. 7.3 adds ONE grouped-only terminal member outcome to this set - **`orphaned`** (`integrating -> orphaned`, §6.5) - reachable only for a non-null-`group_id` inner member via the group-land-family `markInnerOrphaned` operation. The full grouped member outcome set is thus `landed | rejected | orphaned`. (Contract pin only: this `orphaned` member state must flow into the Step-2 member-state schema, the Step-3 shared enums, and the Step-5 group service; a single-repo / null-`group_id` request never reaches `orphaned` and its 7.1 machine is byte-identical.)
- **G1 is enforced at two layers.** (a) *Integrator discipline*: the group path (§6) is the only code that lands a grouped member, and it lands inner+outer together - there is no code path that lands a single grouped member in isolation. (b) *PM guard*: the member-land service path, when the request has a non-null `group_id`, requires the caller to be acting under the group-land operation (§6.6 / Step 7's integrator-facing group route). A stray `POST /merge-requests/{id}/land` on a grouped member is rejected (409) unless it is the group-land operation. This is the PM-side backstop that makes G1 a guarded invariant, not just a convention.
- **The group landing IS the conjunction of its member lands.** `group -> landed` happens only after every member individually reached `landed` (inner first, then outer, §6). The group state is the AND of member states.
- **The orphaned case is the ONE place member states diverge within a group, and is exactly why `partially_landed` exists.** The orphaned inner reaches a DISTINCT member-level **`orphaned`** outcome (NOT `landed`): the request really landed on the inner remote, but its GROUP outcome is "orphaned," not the clean `landed` that G1 reserves for group-land. So the orphaned case is inner `orphaned`, outer `rejected`, group `partially_landed`, incident open. This makes G1 read literally true: `landed` is reached ONLY via group-land; the orphaned inner reaches `orphaned`, not `landed`. This is not a G1 violation (the inner *did* land on its remote as part of the group's atomic attempt; the outer failed, so the group never completed the clean group-land that yields `landed`) - it is the modeled, recorded, recoverable middle state. The `orphaned` outcome is set by an operation in the group-land family (§6.5 `markInnerOrphaned`), so the PM guard (§6.7) admits it; G1 forbids a member reaching `landed` *outside* a group attempt, and it does not forbid the group attempt producing a partial `orphaned` result, which the incident model exists to track and heal.

---

## 4. Incident data model (PM-owned)

### 4.1 The `merge_incidents` table

```ts
export const mergeIncidents = sqliteTable(
  "merge_incidents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    // The group whose land produced the orphan. ON DELETE SET NULL so a
    // deleted group never cascade-deletes the incident (the orphan is a
    // fact about main that outlives the group).
    groupId: text("group_id").references(() => mergeRequestGroups.id, { onDelete: "set null" }),
    // Incident type. For 7.3 the only value is "orphaned_inner"; enum
    // (MERGE_INCIDENT_TYPES) so 7.4+ can add types without a schema change.
    type: text("type").notNull(),
    innerRepo: text("inner_repo").notNull(),
    // The orphaned inner commit SHA: inner main landed here, outer gitlink
    // does NOT yet reference it. The heart of the incident.
    orphanedSha: text("orphaned_sha").notNull(),
    outerRepo: text("outer_repo").notNull(),
    // The inner member request whose land orphaned. ON DELETE SET NULL.
    innerRequestId: text("inner_request_id").references(() => mergeRequests.id, { onDelete: "set null" }),
    // The task the incident comment is posted on (from the inner member's
    // taskId at open time). ON DELETE SET NULL.
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    // Incident state machine (§4.2). Enum MERGE_INCIDENT_STATES.
    state: text("state").notNull().default("open"),
    openedAt: text("opened_at").notNull(),
    resolvedAt: text("resolved_at"),
    // Structured resolution. JSON: { mode: "auto_rollforward"|"human",
    // outerLandedSha?, resolvedByGroupId?, note? }. Null while open.
    resolution: text("resolution", { mode: "json" }).$type<{
      mode: "auto_rollforward" | "human";
      outerLandedSha?: string;
      resolvedByGroupId?: string;
      note?: string;
    }>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_merge_incidents_project_state").on(table.projectId, table.state),
    index("idx_merge_incidents_group").on(table.groupId),
    // The recovery sweep's hot path: open orphaned_inner incidents for this
    // project, oldest first.
    index("idx_merge_incidents_open").on(
      table.projectId, table.state, table.type, table.openedAt,
    ),
  ],
);
```

### 4.2 Incident state machine

```
open ------> auto_resolved      (next group integration rolled the gitlink forward, verify-gated, §7)
  |
  +--------> human_resolved      (operator landed the reconciling outer change, §7.5)
```

Enum `MERGE_INCIDENT_STATES = ["open","auto_resolved","human_resolved"]` (Step 3). Transitions (central guard in `merge-incident.service.ts`):

- `open -> auto_resolved`: recovery (§7) rolled the gitlink forward and the verify-gated outer push succeeded. `resolution = { mode: "auto_rollforward", outerLandedSha, resolvedByGroupId }`.
- `open -> human_resolved`: a human resolved it. `resolution = { mode: "human", outerLandedSha?, note }`.
- Terminal states are idempotent-noop.
- There is intentionally **no `open -> open` "escalated" sub-state**: an incident that *cannot* auto-resolve simply STAYS `open` and is surfaced louder (the comment + dashboard alert, §7.5). "Escalated" is a presentation concern, not a state. (Flagged for the adversarial reviewer as a judgment call.)

### 4.3 How an incident links to the task and surfaces

Opening an incident (Step 6, `merge-incident.service.ts:openIncident`) does, transactionally (mirroring 7.1's `merge_rejection` comment mechanism, grounded against `comments` + `commentType`):

1. INSERT the `merge_incidents` row at `state: "open"`.
2. If `taskId !== null` (resolved from the inner member's `taskId`): INSERT a `comments` row with `commentType: "merge_incident"`, a templated body (`"Orphaned inner: <innerRepo>@<orphanedSha> landed but <outerRepo> gitlink was not updated. Awaiting auto-rollforward on the next group integration, or human resolution."`), and structured `metadata` (`{ incidentId, groupId, innerRepo, orphanedSha, outerRepo, innerRequestId }`).
3. AFTER commit: emit `merge.incident.opened` (§10).

Surfacing is three-fold and **PM-only** (the success criterion): (a) the `merge_incidents` row, queryable via `GET .../merge-incidents` (Step 7) - "detectable from PM alone, no SSH"; (b) the task comment; (c) the SSE event the Phase 7.4 dashboard consumes. Resolution posts a follow-up `merge_incident` comment (`"Incident resolved (<mode>): <outerRepo> gitlink now at <outerLandedSha>."`) and emits `merge.incident.auto_resolved` / `merge.incident.human_resolved`.

---

## 5. Assembled-state verify

A group's verify is NOT per-repo-in-isolation. The inner is rebuilt at its new SHA, the outer is checked out with the gitlink pointing at the inner's rebased tree, and each repo's verify command runs against that **assembled** state. All must pass before any land.

### 5.1 The correlated worktree lease (composing with the 7.2 pool)

The 7.2 worktree pool (`worktree-pool.ts`) leases ONE slot per member from a pool of `parallelism` slots, each a separate clone of a SINGLE repo (the pool is constructed with one `gitRepoUrl`). A group needs **>=2 correlated worktrees - one per linked repo - leased together**. This is a structural extension (Step 9), grounded on the pool's `acquire()`/`release()` contract:

- **Per-repo pools.** The integrator constructs ONE `WorktreePool` per linked repo (an inner-pool cloning `rynx`, an outer-pool cloning `game`), each with the project's `parallelism`. The existing single-repo lane uses exactly the inner-or-the-default pool as today (backwards compat, §12).
- **A group leases a CORRELATED SET.** Group assembly acquires one slot from EACH per-repo pool together: `innerWt = innerPool.acquire(); outerWt = outerPool.acquire()`. If EITHER returns null (pool exhausted), the group is NOT admitted this pass - **both** acquired slots are released and the group waits (backpressure, exactly the 7.2 idle-slot admission rule, 7.2 §11, generalized to "all correlated slots free"). Atomic correlated acquire avoids deadlock: acquire in a fixed order (inner before outer), and on partial failure release what was taken.
- **The set is released together** on group resolution (land / reject / partial), each slot back to its own pool.
- A group is the atomic unit: its members are NOT speculatively interleaved with each other (decision 5). Within a single-repo lane, 7.2 speculative batching is untouched; a group simply occupies a correlated slot-set for its integration.

### 5.2 The exact git assembly sequence

Given a group with an inner member (branch/commit on `rynx`) and an outer member (branch/commit on `game`), live inner main at `Mi`, live outer main at `Mo`:

```
# ---- inner worktree (innerWt) ----
1. innerWt.resetForAttempt()              # reset --hard; clean -fdx; fetch; checkout main; reset --hard origin/main  (== 7.1 sequence)
2. baseInnerSha = resolveRef("HEAD")      # = Mi
3. rebase = rebaseOnto(Mi, innerRef)      # innerRef = innerMember.branch ?? innerMember.commitSha
   #   -> rebase.treeSha = Ri   (the inner's rebased HEAD; the candidate new inner SHA)

# ---- outer worktree (outerWt) ----
4. outerWt.resetForAttempt()              # outerWt sits at live outer main Mo
5. baseOuterSha = resolveRef("HEAD")      # = Mo
6. rebaseOuter = rebaseOnto(Mo, outerRef) # outerRef = outerMember.branch ?? outerMember.commitSha
   #   -> rebaseOuter.treeSha = Ro'  (outer rebased, but gitlink still at the OLD inner SHA)

# ---- assemble: point the outer gitlink at the rebased inner tree Ri ----
7. fetchFromPath(outerWt, innerWt.path, Ri)        # copy Ri's objects into the OUTER clone's object store (§4.3 cross-worktree fetch, reused) — REQUIRED so step 9's working-tree checkout has the inner tree to expand
8. updateSubmoduleGitlink(outerWt, gitlinkPath, Ri)# stage the 160000 gitlink at gitlinkPath -> Ri, commit the outer tree
   #   -> Ro  = the ASSEMBLED outer HEAD: outer rebased + gitlink->Ri (COMMITTED tree)
9. materializeSubmoduleWorktree(outerWt, gitlinkPath, Ri)  # expand Ri's tree into outerWt/<gitlinkPath>/ on disk, so the outer verify sees the new inner SOURCES (not just the committed gitlink)
   #   -> the outer WORKING TREE at gitlinkPath now physically contains the inner@Ri files
```

After step 9 the assembled state is exactly: inner worktree at `Ri`; outer worktree at `Ro` whose **committed** gitlink at `gitlinkPath` references `Ri` **AND whose working tree at `gitlinkPath` is physically populated with the inner@Ri sources**. `Ri` and `Ro` are the two candidate SHAs the atomic land (§6) pushes.

**Why the working-tree materialization at step 9 (critical — do not skip).** `updateSubmoduleGitlink` (step 8) writes the 160000 gitlink into the *committed tree* only; `git update-index --cacheinfo` + `commit` does **not** check out the submodule's files on disk (after it, `git status` shows the `gitlinkPath` directory as deleted/absent). But §5.3's outer verify runs integration tests **against the working tree** and must see the new inner *sources* at `gitlinkPath`, not merely a committed gitlink SHA. So step 9 expands `Ri`'s tree into `outerWt/<gitlinkPath>/` on disk. **Without step 9 the outer verify runs against an empty `gitlinkPath` directory and falsely passes (tests silently skip the absent submodule) or falsely fails (tests can't find the inner sources) — either corrupts the verify gate that R1 (§7.1) depends on.** The post-assembly assertion (§11 "submodule SHA mismatch" row) therefore checks BOTH `readSubmoduleGitlink(outerWt, gitlinkPath) === Ri` (committed tree) AND that the working tree at `gitlinkPath` is populated.

**Why `fetchFromPath` at step 7.** `Ri` lives only in the inner clone (it is the not-yet-pushed rebased inner commit; nothing is pushed until land). The outer clone has never seen it. Note `update-index --cacheinfo` at step 8 does **not** require `Ri` to be present in the outer store to stage/commit the gitlink (git permits a gitlink referencing an absent object — normal submodule behavior). The fetch at step 7 is required for **step 9's working-tree checkout**: `materializeSubmoduleWorktree` expands `Ri`'s tree, which the outer clone can only do once `Ri`'s objects are present locally. So step 7 reuses the shipped §4.3 cross-worktree fetch (`git-ops.fetchFromPath(fromPath, sha)`, grounded in git-ops.ts:158) to copy `Ri` into the outer clone first. This is the SAME mechanism speculative chains use; it is reused, not reinvented.

### 5.3 Per-repo verify against the assembled state

Each linked repo declares a verify command (the group's per-repo verify; the inner runs rynx tests, the outer runs integration tests). Both run against the assembled checkout, concurrently, reusing the shipped `git-ops.runVerify` (its `cwd`/`logPath`/`signal` options, git-ops.ts:220):

```
verifyInner = runVerify(innerVerifyCmd, timeout, { cwd: innerWt.path, logPath: <inner attempt log>, signal })
verifyOuter = runVerify(outerVerifyCmd, timeout, { cwd: outerWt.path, logPath: <outer attempt log>, signal })
await Promise.all([verifyInner, verifyOuter])
```

The **combined result is the AND**: the group passes verify iff EVERY repo's verify exits 0 and not-timed-out. Any failure -> the whole group fails verify -> §6 failure point (c), reject the group, nothing landed. The outer verify runs with the gitlink ALREADY pointing at `Ri`, so it exercises the real assembled tree (the integration tests see the new inner) - this is the entire point of decision 4. Per-member attempt rows are recorded exactly as 7.2 (each member's `startAttempt(baseSha)` / `completeAttempt`), so attempt history stays truthful per repo.

### 5.4 Step-9 git-ops additions (do not exist yet)

§5.2/§6.4 require ops the shipped `git-ops.ts` does not have. Step 9 adds them (noted here so later steps find the contract):

- `updateSubmoduleGitlink(gitlinkPath: string, sha: string): Promise<string>` - in the current worktree, stage the gitlink at `gitlinkPath` to `sha` and commit; return the new outer HEAD SHA. Implemented via `git update-index --add --cacheinfo 160000,<sha>,<gitlinkPath>` + `git commit`. NOTES: (a) `--add` is required to stage a gitlink path not already in the index (harmless when it already exists); (b) `gitlinkPath` MUST use forward slashes (git index convention, even on Windows); (c) the commit MUST run with an explicit committer identity — `git -c user.email=<integrator> -c user.name=<integrator> -c commit.gpgsign=false commit` — because this is the FIRST commit the integrator authors and pool-cloned worktrees have no configured identity (otherwise the commit fails "Author identity unknown").
- `readSubmoduleGitlink(gitlinkPath: string): Promise<string>` - read the inner SHA the outer tree's gitlink currently references at `gitlinkPath` (used by recovery's reconciliation check, §7.4). `git ls-tree HEAD <gitlinkPath>` -> parse the `160000 commit <sha>\t<path>` line, return the SHA (3rd whitespace-delimited token). Throws if no 160000 entry is found at `gitlinkPath` (a missing/non-gitlink path is a real error, §11).
- `materializeSubmoduleWorktree(gitlinkPath: string, sha: string): Promise<void>` - expand the inner tree `sha` into the outer working tree at `gitlinkPath` on disk (so the outer verify sees the inner sources — §5.2 step 9). Implemented via `git read-tree --prefix=<gitlinkPath>/ <sha>` into a temp index + `git checkout-index -a -f`, OR `git -C <innerWt> archive <sha> | tar -x -C <outerWt>/<gitlinkPath>` — whichever the implementer confirms works on win32. Requires `sha`'s objects present in the outer store (the §5.2 step-7 `fetchFromPath`).
- The existing `fetchFromPath`, `rebaseOnto`, `push`, `resolveRef`, `runVerify`, `fetch` are reused unchanged.

---

## 6. Atomic land protocol

The group lands inner-first, then outer, under the lane lock (§8). The three failure points are pinned. **The verify-gate-before-fast-forward invariant (7.1/7.2) is preserved on BOTH pushes**: a push happens only after the assembled state passed verify (§5.3), and only when the target's live main is exactly where the rebase anchored (the fast-forward-or-reject guard, 7.2 §6.2).

### 6.1 Preconditions (all must hold before ANY push)

1. The group is `integrating` and the lane lock is held (§8).
2. Assembly (§5.2) produced `Ri` (inner candidate) and `Ro` (assembled outer candidate, gitlink->Ri).
3. Assembled verify (§5.3) passed for EVERY repo (the AND).
4. Live inner main == `Mi` (the SHA the inner rebase anchored to) AND live outer main == `Mo` (the SHA the outer rebase anchored to). Re-fetch + re-resolve both immediately before the land sequence; any drift -> the verified tree is stale -> reject the group cleanly (treated as failure point (c): nothing landed, re-admit later). Drift is guarded against by the lane lock but checked regardless (7.2 §6.2 discipline).

### 6.2 The land sequence (inner-first, then outer)

```
# ---- PUSH 1: inner ----
push1 = innerGitOps.push(gitRemote, innerMainBranch)   # fast-forwards inner main Mi -> Ri
if !push1.ok:
    # FAILURE POINT (a): inner push failed. NOTHING landed.
    -> reject the whole group cleanly (§6.3). Outer NEVER touched.
    return

# inner main is now at Ri on the remote. Hold the SHA in memory; do NOT yet set any
# terminal PM member state - the inner's PM outcome is decided by which branch below runs
# (clean group-land -> `landed`, §6.6; or outer-push-fail -> `orphaned`, §6.5).
innerLandedSha = push1.pushedSha   # = Ri

# ---- PUSH 2: outer ----
push2 = outerGitOps.push(gitRemote, outerMainBranch)   # fast-forwards outer main Mo -> Ro (gitlink->Ri)
if !push2.ok:
    # FAILURE POINT (b): outer push failed AFTER inner landed. THE orphaned case.
    -> mark inner member orphaned + open incident (§6.5). Outer main UNCHANGED.
    return

# both landed atomically.
outerLandedSha = push2.pushedSha   # = Ro
-> land the group (§6.6): inner member landed@Ri, outer member landed@Ro, group -> landed.
```

The 2-repo assumption is load-bearing here: exactly one inner push then exactly one outer push. (An N-repo DAG would push inners in topological order, each a potential orphan point; deferred, §2.4.)

### 6.3 Failure point (a): inner push fails -> reject group, nothing landed

Inner push returns `PushFailure` (any reason: `non_fast_forward`, `auth`, `network`, `other`). Nothing has landed - outer was never touched. Reject the whole group cleanly:

1. For the inner member: `completeAttempt(failed, category)` + `rejectMergeRequest(category, reason)` (the 7.1/7.2 reject path; `non_fast_forward` here is a drift/push-race -> the group can be re-admitted later, but for a GROUP we reject-and-retry-as-a-unit rather than re-queue a single member, since members are not independently re-admittable, G1).
2. For the outer member: `completeAttempt(cancelled)` + `rejectMergeRequest(category: "other", reason: "group sibling inner push failed; nothing landed")`.
3. `group -> rejected` with `resolutionReason`.
4. Release the correlated worktree set. Emit `merge.group.rejected` (§10).

No incident is opened (failure point (a) is the clean case - the success criterion's "inner push failures stop the whole group cleanly").

### 6.4 The transaction boundary (what "one integrator transaction" means)

"In one integrator transaction" (decision 2) is an **integrator-orchestrated sequence**, not a distributed 2-phase commit (two independent git remotes cannot share a real transaction). The boundary is: between PUSH 1 succeeding and PUSH 2 being attempted, the integrator holds the lane lock and does no awaitable work that could lose the in-memory plan except the outer push itself. Concretely the boundary's guarantee is: *the eventual durable outcomes are (a) nothing landed, (b) both landed, or (c) inner landed + incident open.*

**Incidents are opened ONLY synchronously, by §6.5, when PUSH 2 fails while the integrator process is alive. An incident is NEVER reconstructed retroactively from git SHAs.** That means there IS one transient intermediate window: a crash AFTER PUSH 1 succeeds but BEFORE the §6.5 incident-write. In that window the state is `inner-on-remote, no PM incident record, group still integrating` - i.e. the inner did land and PM has not yet recorded an incident. This window is NOT an orphan in the PM sense (no incident row exists), and it is NOT recovered by inventing an incident from git. It is recovered purely by **stranded-group recovery** (§9 finding 2): because no incident was written, the group is still `integrating`, so the crash-recovery sweep resets the WHOLE group to a re-integratable state and re-runs the clean atomic land. On that re-run the inner re-push is a fast-forward / no-op (inner main is already at `Ri`), and the outer push then completes the atom (or, if it fails again while alive, §6.5 opens the incident synchronously). So the "transaction" is the inner-push -> {outer-push | synchronous open-incident} atom, made durable EITHER by completing the atom on re-integration OR by the PM incident record - never by a git transaction that does not exist, and never by SHA-based orphan reconstruction.

### 6.5 Failure point (b): outer push fails after inner landed -> orphan + incident

Inner landed at `Ri`; outer push returned `PushFailure`. Outer main is UNCHANGED (the push failed - the gitlink never advanced, so no half-landed gitlink reached outer main; the corruption case is structurally avoided). This block runs synchronously while the integrator process is alive (it observed PUSH 2 fail); the incident is opened HERE, never reconstructed later from git. Now:

1. Set the inner member to the `orphaned` outcome in PM via `markInnerOrphaned(innerRequestId, Ri)` - a group-land-FAMILY operation (so §6.7's G1 guard ADMITS it; it is NOT the plain per-request `land`, which would 409 a grouped member). This sets `completeAttempt(passed, treeSha=Ri)` and the inner member's state to `orphaned` (distinct from `landed`): the inner DID land on its remote, but its group outcome is "orphaned," not the clean `landed` G1 reserves for group-land. PM reflects that truth without contradicting G1.
2. Record the orphan durably by **opening the incident** (the request is `orphaned`, not `landed`; the orphan is the *outer's* missing gitlink update). `openIncident({ type: "orphaned_inner", innerRepo, orphanedSha: Ri, outerRepo, groupId, innerRequestId, taskId: <inner member taskId> })` (§4.3). The open `orphaned_inner` incident row is THE durable record of a real orphan - recovery (§7.2) keys solely off it, never off a git SHA comparison.
3. Reject the outer member: `completeAttempt(failed, category)` + `rejectMergeRequest(category, reason: "outer push failed after inner landed; orphaned inner @Ri; incident <id> opened")`.
4. `group -> partially_landed` with `resolutionReason` referencing the incident.
5. Release the correlated worktree set. Emit `merge.incident.opened` (which itself carries `innerRepo`, `orphanedSha`, `innerRequestId` - the inner's orphaned outcome is surfaced via the incident, not via a `member_landed` event, since the inner is `orphaned`, not `landed`), and `merge.group.rejected`-or a dedicated partial marker (§10 pins `merge.group.rejected` carries an `outcome: "partially_landed"` field rather than a separate event - see §10).

The incident now durably records: inner main is at `Ri`, outer gitlink is NOT at `Ri`. Detectable from PM alone. Recovery is §7.

### 6.6 Failure point (c): assembled verify fails -> reject group, nothing landed

This is checked in §6.1 precondition 3, BEFORE any push. If the assembled verify (§5.3 AND) fails, or live-main drift is detected (precondition 4), reject the whole group exactly as §6.3 but with the verify failure category/reason (per the failing repo's `categorize` output, reusing 7.1 `categorize.ts`). Nothing landed; no incident. The outer (and inner) were never pushed. Emit `merge.group.rejected`.

### 6.7 The group-land PM operation (G1 enforcement point)

Landing a group is a SINGLE integrator-facing PM operation (Step 7's integrator route `POST /merge-groups/{id}/land`, ai_agent only), NOT N independent member-land calls. It takes the per-member landed SHAs and, in one PM `db.transaction`: lands each member (status `landed`, git_refs row per the 7.1 land side-effect), sets `group -> landed`, and (after commit) emits the member-landed + group-landed events. This single operation is the ONLY path that lands a grouped member, which is how G1 (§3.4) is enforced PM-side: the per-request `land` endpoint refuses a non-null-`group_id` request unless invoked through this group-land path. (Tactically, the per-request `land` service checks `group_id IS NULL` OR an internal "group land in progress" flag set by the group-land transaction; Step 5/7 pin the exact mechanism, the contract is: a grouped member cannot be landed except by group-land.)

**The G1 guard recognizes a group-land FAMILY, not just `POST /merge-groups/{id}/land`.** The orphaned-inner outcome operation `markInnerOrphaned` (§6.5 step 1), which sets the inner member to the member-level `orphaned` state, is a member of this family: it is ADMITTED by the same guard exactly as the clean group-land path is, because it is a group-driven outcome (not an independent single-member land). It does NOT set a grouped member to `landed` (it sets `orphaned`), so it does not even contend with the `landed`-reservation of G1; but it likewise must NOT be reachable via the plain per-request endpoint. The contract is therefore: a grouped member's terminal group outcome - whether `landed` (clean group-land) or `orphaned` (orphan-land) - is reachable ONLY through a group-land-family operation; the plain per-request `POST /merge-requests/{id}/land` still 409s any non-null-`group_id` request.

---

## 7. Orphaned-inner recovery state machine (proof-level)

This is the highest-risk section. An open `orphaned_inner` incident means: inner main is at `orphanedSha` (call it `O`), and outer main's gitlink at `gitlinkPath` references some earlier inner SHA `< O`. Recovery makes outer's gitlink absorb `O` - **without ever advancing outer main past an unverified assembled tree.**

### 7.1 The outer-main safety invariant (the thing being proven)

> **INVARIANT R1 (outer-main safety): outer `main` is advanced ONLY by a verify-gated fast-forward push of an ASSEMBLED tree (outer rebased + gitlink pointing at the inner SHA whose assembled tree just passed verify). This holds in normal land (§6) AND in recovery (§7). There is NO code path that pushes outer main to a gitlink whose assembled tree has not passed verify.**

R1 is what eliminates the half-landed-gitlink corruption case categorically: outer main can never reference an inner SHA that was not verified in assembly with the exact outer tree being pushed. The recovery path below is constructed to preserve R1 at every step.

### 7.2 When recovery runs

Recovery is **opportunistic and integration-triggered**, not a separate daemon. At the start of every group integration (and, as a cheap add, at the start of every single-repo batch on a lane that has linked repos), the integrator, while holding the lane lock:

1. Queries PM for open `orphaned_inner` incidents on this `(project, resource)`, oldest first (the `idx_merge_incidents_open` index, §4.1). This is a PM read - no SSH, the success criterion.
2. For each open incident, attempts auto-rollforward (§7.3). If it auto-resolves, the incident closes; if it cannot reconcile, the incident STAYS open and is escalated (§7.5).
3. Then proceeds with the group/batch integration as normal.

Because recovery holds the lane lock (§8), it cannot race a concurrent land - exactly one integrator owns the lane (the same guarantee 7.2 §9 gives). The 2-repo assumption: one inner, one outer, one gitlink to roll forward.

### 7.3 The auto-rollforward algorithm (step by step)

For an open incident with orphaned inner SHA `O`, inner repo, outer repo, gitlinkPath:

```
ROLLFORWARD(incident):
  # --- lease a correlated outer worktree (inner not needed - O is already on inner main) ---
  outerWt = outerPool.acquire()            # if null -> backpressure; retry next integration (incident stays open)

  # --- step 1: outer at live main ---
  outerWt.resetForAttempt()                # outer worktree at live outer main Mo'
  Mo' = resolveRef("HEAD")

  # --- step 2: reconciliation check (§7.4) - CAN the gitlink roll forward to O? ---
  currentGitlink = readSubmoduleGitlink(gitlinkPath)   # the inner SHA outer main currently references
  if !RECONCILABLE(currentGitlink, O, inner):
      # un-auto-resolvable -> ESCALATE. Incident stays open. Outer UNTOUCHED. (§7.5)
      release(outerWt); ESCALATE(incident); return

  # --- step 3: assemble the roll-forward outer tree ---
  fetchFromPath(outerWt, <inner remote/main>, O)   # O is on inner MAIN (it landed) -> a normal fetch from the inner remote suffices
  updateSubmoduleGitlink(gitlinkPath, O)           # stage gitlink -> O, commit -> Ro_rf (assembled roll-forward outer tree)

  # --- step 4: VERIFY the assembled roll-forward tree (R1 gate) ---
  v = runVerify(outerVerifyCmd, timeout, { cwd: outerWt.path, ... })
  if v failed:
      # the assembled tree does not pass verify -> DO NOT push outer. Escalate. (§7.5)
      release(outerWt); ESCALATE(incident); return

  # --- step 5: verify-gated fast-forward push (R1) ---
  refetch outer main; if live outer main != Mo' -> drift; abort this attempt, incident stays open, retry next integration
  push = outerGitOps.push(gitRemote, outerMainBranch)   # fast-forwards Mo' -> Ro_rf
  if !push.ok:
      if non_fast_forward -> drift/race; incident stays open; retry next integration
      else -> ESCALATE(incident) (auth/network/other); return

  # --- step 6: resolve the incident ---
  resolveIncident(incident.id, { state: "auto_resolved",
      resolution: { mode: "auto_rollforward", outerLandedSha: push.pushedSha, resolvedByGroupId: <current group> } })
  release(outerWt)
```

Key properties:
- **R1 holds**: outer main advances at step 5 ONLY after the assembled roll-forward tree (gitlink->O) passed verify at step 4. The gitlink->O is the assembled tree; it is verified before the push.
- **Outer main is never touched on any failure branch** (reconciliation-fail at step 2, verify-fail at step 4, push-fail at step 5) - the incident simply stays open. No partial mutation.
- **`O` is fetched from the inner remote's main** (step 3), not cross-worktree, because by definition `O` already landed on inner main - it is a normal published commit now. (Contrast §5.2 step 7, where the inner SHA was not yet pushed.)

### 7.4 The reconciliation predicate (RECONCILABLE) - exactly when auto-resolve is legal

`RECONCILABLE(currentGitlink, O, inner)` decides whether the gitlink can be cleanly rolled forward from `currentGitlink` to `O`. It is true iff:

> **`O` is a descendant of `currentGitlink` in the inner repo's history (i.e. `currentGitlink` is an ancestor of `O`): `git merge-base --is-ancestor currentGitlink O` succeeds in the inner repo.**

Rationale (and why this is the precise predicate):
- The orphaned `O` landed on inner main by fast-forward over the inner main that existed at land time. The outer gitlink references `currentGitlink`, the inner SHA outer main was built against.
- **The common, self-healing case**: no intervening outer change touched the gitlink, so `currentGitlink` is exactly the inner SHA from before the orphaning group, and `O` is its descendant on inner main. `--is-ancestor` is true -> roll forward is a clean gitlink bump to a strictly-newer inner commit. Auto-resolve.
- **The un-reconcilable case (§11 "orphaned-inner-SHA-conflicts-with-intervening-outer-history")**: an intervening outer change ALSO bumped the gitlink (to some inner SHA `C` on a different inner line, or forward past `O` independently), so `currentGitlink == C` is NOT an ancestor of `O`. Rolling the gitlink to `O` would REGRESS or DIVERGE the inner reference - the outer history already moved the gitlink somewhere incompatible with `O`. `--is-ancestor` is false -> NOT reconcilable -> escalate. Auto-rolling here could break outer main (regress the submodule), which R1 + decision 3 forbid.
- The predicate is purely an inner-repo ancestry check; it does not need the outer assembled verify to decide reconcilability (verify is the SEPARATE R1 gate at step 4). Two gates: (1) ancestry says "is the roll-forward semantically a clean forward bump?"; (2) verify says "does the assembled tree actually build/pass?". BOTH must hold to auto-resolve. (1)-fail and (2)-fail both escalate, for different reasons.
- **Reachability precondition (named explicitly).** The `git merge-base --is-ancestor currentGitlink O` check, and step 3's fetch of `O` from inner main, both assume `O` remains reachable from inner-main-HEAD - i.e. that inner `main` only ever fast-forwards and never rewinds or force-updates past `O`. This holds by the merge-train's fast-forward-only inner-main invariant: 7.1/7.2 land every inner request via a fast-forward push (7.1 §5 / 7.2 §6.2), so once `O` lands it stays an ancestor of inner-main-HEAD and is always fetchable and resolvable. The predicate's soundness rests on this invariant; it is not an additional algorithmic step, just the assumption made explicit.

### 7.5 Escalation (the human fallback)

ESCALATE does NOT change the incident state (it stays `open`, §4.2 - no separate "escalated" state). It makes the incident louder and human-actionable:

1. Post a follow-up `merge_incident` comment on the linked task: `"Auto-rollforward could not reconcile orphaned <innerRepo>@<O> with intervening outer history (outer gitlink at <currentGitlink> is not an ancestor of <O>) [or: assembled tree failed verify]. Human resolution required: land an outer change that reconciles the gitlink, then this incident will close."` (Idempotent-ish: avoid spamming - only post once per escalation reason; Step 12 dedups by reason.)
2. Emit a dashboard alert via the SSE stream. Since the incident state did not change, the alert is a distinct signal - Step 12 either re-emits `merge.incident.opened` semantics as an escalation marker OR (preferred, §10) emits nothing new and relies on the dashboard polling open incidents; the design pins: **escalation surfaces via the persisted comment + the still-open incident row** (PM-only, no new event strictly required), with an optional dashboard alert the Phase 7.4 dashboard derives from "incident open AND last auto-rollforward attempt failed" (a field the resolution-attempt log could carry; left as a Step-12 tactical choice, flagged for the reviewer).
3. A human resolves by landing an outer change that reconciles the gitlink (e.g. a manual submodule bump merging the divergence), then closing the incident via the integrator-facing resolve endpoint -> `human_resolved` (§4.2).

### 7.6 The incident state machine + worked cases

```
                        +-------------------- auto_resolved
                        |   (RECONCILABLE && assembled-verify passed && push ok, §7.3)
   [open] --------------+
     ^  |               |
     |  |  ESCALATE      +-------------------- human_resolved
     |  |  (NOT reconcilable OR verify-fail OR auth/network push-fail)   (operator lands reconciling outer change, §7.5)
     |  |
     +--+  stays open, surfaced louder; retried on the NEXT group integration
           (drift / pool-exhaustion / transient push-race also keep it open for retry)
```

**Worked case 1 - common self-healing.** Group G1 lands inner@O, outer push drops (network). Incident opened: inner main @O, outer gitlink @P (P ancestor of O). No outer change lands in between. Group G2 integrates; recovery runs: `readSubmoduleGitlink = P`; `RECONCILABLE(P, O)` -> `P is-ancestor O` = true; fetch O; gitlink->O; assembled verify passes; live outer main still at the P-gitlink commit (no drift); push fast-forwards; incident -> `auto_resolved`, outer gitlink now @O. G2 then proceeds normally. Outer main was advanced exactly once, to a verified assembled tree (R1 held).

**Worked case 2 - un-reconcilable (intervening outer history).** Group G1 lands inner@O, outer push drops. Incident opened (inner @O, outer gitlink @P). BEFORE recovery runs, a human (or a non-group outer change) lands an outer commit that bumps the gitlink to inner SHA C, where C is on a different inner line / forward of O independently -> outer main now references C, and `P` is no longer current. Group G2 integrates; recovery runs: `readSubmoduleGitlink = C`; `RECONCILABLE(C, O)` -> `C is-ancestor O`? false -> ESCALATE. Incident stays `open`; comment posted; outer main UNTOUCHED (R1 trivially held - no push). A human reconciles (merges O into the inner line referenced by C, lands an outer bump), then closes -> `human_resolved`.

**Worked case 3 - assembled verify regresses during recovery.** Reconcilable by ancestry (P is-ancestor O), but the assembled outer tree (gitlink->O) FAILS the outer verify (O introduced an inner change that breaks the outer integration tests). Step 4 verify fails -> ESCALATE, outer main untouched (R1 held). Human investigates. This is the case decision 3's "NEVER auto-mutate in a way that could break outer main" explicitly protects against: ancestry alone is not sufficient to auto-push; verify is the hard gate.

**Worked case 4 - integrator crashes mid-rollforward.** Crash between step 3 (gitlink committed locally) and step 5 (push). Nothing was pushed -> outer main untouched; the incident is still `open` in PM (no resolve happened); the local outer worktree is discarded by the pool on restart (`resetForAttempt` rebuilds it). The NEXT integration re-runs recovery from scratch. Idempotent: re-attempting a still-open incident is safe (R1 + "outer untouched on any non-push exit"). This is the §11 chaos requirement satisfied for the recovery path.

### 7.7 Why recovery never violates R1 (the proof sketch)

Every outer-main advance in recovery is step 5's push, which is reached ONLY after step 4's verify passed on the assembled tree (gitlink->O) being pushed. Every failure branch (reconciliation-fail, verify-fail, push-fail, drift, crash) leaves outer main untouched (no push executed). Therefore outer main is advanced only to a verified assembled tree, in recovery exactly as in normal land (§6). R1 holds by construction; there is no path that pushes an unverified gitlink. QED (sketch; the Step-12 tests prove the auto-resolve and escalate branches and the chaos-kill recoverability).

---

## 8. Lane-ownership lock under groups

### 8.1 A group integrates under the SAME lane lock - no second lock

A group is integrated under the 7.2 lane-ownership lock (`merge-lock.service.ts`, 7.2 §9), unchanged. When the integrator decides to integrate a group, it acquires the `(project, resource)` lock ONCE (exactly as it does to start a batch, 7.2 §9.1), holds it (single batch-lifetime heartbeat) for the whole group integration including any recovery sweep (§7.2), and releases it on group resolution (land / reject / partial). The group is integrated inside the lane the lock already protects.

### 8.2 Why a group needs NO second lock (the argument)

- The lane lock already means "exactly one integrator owns this `(project, resource)` lane" (7.2 §9, the structural race-guard). A group's pushes (inner and outer) to that lane's `main` happen only while the integrator holds that lock. A second integrator gets `status: "queued"` from `acquire` and never reaches the land path (7.2 §9.5). So two integrators cannot race on inner OR outer main.
- **The inner and outer pushes are both serialized by the single lane owner.** Within the lane, the integrator's own group-land logic (§6.2) sequences inner-then-outer. There is no concurrency between them to guard - they run sequentially in one process holding one lock. A second lock (e.g. a per-repo lock) would add deadlock surface and protect against nothing the lane lock does not already cover.
- **Recovery runs under the same lock** (§7.2), so the roll-forward outer push is serialized against any other land on the lane. No separate recovery lock.
- **The 2-repo caveat**: this holds because both repos' `main` advances are driven by the SAME lane's single owner. The lane is keyed on `(project, resource)`; the inner and outer repos share the project's lane (resource `main`). If a future N-repo design gave repos independent lanes, the single-lock argument would need revisiting - but for the 2-repo gitlink shape, one lane lock covers both pushes.

### 8.3 Lock landing-intent under a group

The lock's landing-intent fields (`taskId`/`branch`/`commitSha`/`verifyCmd`/`worktreePath`, schema.ts:402-406) describe a REPRESENTATIVE member of the group (the inner member by convention), exactly as 7.2 §12 finding 5 made them describe one representative batch member. Semantic reuse, no `merge-lock.service.ts` change. The lock's `landedSha` reflects the LAST land of the group (the outer's `Ro`) on release, paralleling 7.2's accepted "lock landedSha lags" nuance.

---

## 9. PM-invariant audit

Mirrors the 7.2 §12 audit (the template). **Conclusion up front: the new `group_id` column and the two PM tables are purely additive; every existing query and the integrator recovery sweep behave identically for single-repo (`group_id` null) requests, and the new grouped behavior is gated on `group_id` being non-null.** Each finding verified against source.

1. **Integrator pickup (`transitionToIntegrating`) - safe, unchanged for single-repo.** `merge-request.service.ts:transitionToIntegrating` is per-row (`assertCanTransition` on the single request's status, service.ts:541) and does not read `group_id`. A single-repo request picks up exactly as today. A GROUPED member is picked up via the group-pickup path (Step 7 integrator group route sets `group -> integrating` and transitions each member), which calls the same per-row transition - the guard does not trip. No cross-row assumption exists to break.
2. **Crash-recovery sweep (`reclaimStrandedRequests`) - safe, with a noted group-aware extension.** `recovery.ts` iterates ALL `integrating` requests and `resetToQueued`s each (recovery.ts:40-63), counting 409s as skipped. For single-repo this is byte-identical to 7.2. For a GROUPED member: resetting one member of a stranded `integrating` group while the group row is still `integrating` would desync member<->group. **The extension (Step 12)**: the sweep, for a member with non-null `group_id`, restores the whole GROUP to a re-integratable state atomically (group + members reset together) - it must NEVER leave a half-`integrating` group. Single-repo recovery is untouched. This is the one place the sweep gains group-awareness; additive, gated on `group_id != null`. **This is also the sole mechanism that recovers the crash-between-PUSH-1-and-incident-write window (§6.4).** A real orphan is detected SOLELY by an open `orphaned_inner` incident row (§7.2); the sweep does NOT inspect git SHAs and does NOT reconstruct an orphan from `readSubmoduleGitlink`. If the integrator crashed after PUSH 1 but before §6.5 wrote the incident, there is no incident, the group is still `integrating`, and this sweep simply resets + re-integrates the whole group. On re-integration the inner re-push is a fast-forward / no-op (inner main is already at the landed inner SHA), then the outer push completes the atom. No SHA-based orphan detection is involved anywhere.
3. **`list()` consumer - safe.** `merge-request.service.ts:list` orders by `enqueuedAt` and filters on project/resource/status/taskId (service.ts:362-388); no `group_id` assumption. The new optional `groupId` filter is additive. The integrator queued-FIFO pickup is unchanged for single-repo; grouped members are admitted as a unit via group-pickup, not the single-repo FIFO head - so a grouped member is NOT speculatively interleaved (decision 5). The list query shape does not change.
4. **merge-request detail (`getById`) - safe, additively extended.** Returns request + attempts (service.ts:403). Gains an optional `group_id` view field (additive; null for single-repo). A view addition, not a query-shape change.
5. **Attempt numbering - safe.** `getNextAttemptNumber` is per-request (attempt.service.ts:96) and `UNIQUE(requestId, attemptNumber)` is per-request. Group members each have independent sequences; nothing collides. Unchanged.
6. **The 7.2 batch scheduler - safe for single-repo, group is a distinct path.** `runBatchOnce`/speculative chains (batch.ts) operate on single-repo members of ONE pool. With `linkedRepos` empty, byte-identical to 7.2. With linked repos configured, the scheduler gains a group branch: a grouped FIFO head integrates as an atomic unit (§5/§6) rather than as a speculative member. Single-repo speculative batching on the same lane is untouched; a group does not participate in speculative interleaving (decision 5). No change to suffix invalidation, land-gate, or lane lock for single-repo members.
7. **merge-lock service - no code change (semantic reuse).** §8.3: the lock describes a representative member; `merge-lock.service.ts` (atomic claim, sweep, heartbeat, release) is unchanged, exactly as 7.2 §12 finding 5.
8. **No unique index forbids the new column - safe.** `merge_requests` indexes are non-unique; `group_id` + `idx_merge_requests_group` (non-unique) forbids nothing. N members share a `group_id`.
9. **No other consumer reads `group_id`.** A grep for `group_id` consumers finds only the new group/incident services + the group-aware pickup/recovery paths (all gated on non-null `group_id`). Absent (null) it is invisible.

**Net:** single-repo (`group_id` null) is unaffected end-to-end (prime invariant, §1.4). The only existing component that gains group-awareness is the crash-recovery sweep (finding 2), gated on `group_id != null`, leaving the single-repo path byte-identical.

---

## 10. SSE events

Group + incident events are added to `EVENT_NAMES` (`event-bus.ts`, Step 8) and emitted by the PM group/incident SERVICES (after-commit, the 7.1/7.2 discipline). They ride the existing `/api/v1/events` stream via `onAll` auto-forward (event-bus.ts:125).

### 10.1 The divergence from 7.2 relay model (state it explicitly)

7.2 batch markers were **integrator-relayed and NOT persisted**: the integrator POSTed to a thin relay endpoint and PM re-emitted them without writing anything (7.2 §13.2). 7.3 group + incident events are **PM-EMITTED from PM-owned state**: because the tables ARE PM-owned (§1.2), the services that mutate them emit directly (exactly as `merge-request.service.ts` emits `merge.request.*` after its UPDATE commits). There is NO relay endpoint for group/incident events - PM owns the state, so PM owns the emission. This is the observable consequence of the §1.2 divergence: durable PM state -> PM-emitted events; transient integrator state -> integrator-relayed events.

### 10.2 Event names + payloads

```ts
// Merge group events (Phase 7.3 - PM-owned, emitted by merge-group.service)
MERGE_GROUP_STARTED:        "merge.group.started",
MERGE_GROUP_MEMBER_LANDED:  "merge.group.member_landed",
MERGE_GROUP_LANDED:         "merge.group.landed",
MERGE_GROUP_REJECTED:       "merge.group.rejected",
// Merge incident events (Phase 7.3 - PM-owned, emitted by merge-incident.service)
MERGE_INCIDENT_OPENED:        "merge.incident.opened",
MERGE_INCIDENT_AUTO_RESOLVED: "merge.incident.auto_resolved",
MERGE_INCIDENT_HUMAN_RESOLVED:"merge.incident.human_resolved",
```

| Event | entityType | Payload (entity fields beyond the row) |
|---|---|---|
| `merge.group.started` | `merge_group` | `{ groupId, resource, memberCount, memberRequestIds }` (on `forming -> integrating`) |
| `merge.group.member_landed` | `merge_group` | `{ groupId, requestId, repo, role, landedSha }` (per member as it lands in §6.7) |
| `merge.group.landed` | `merge_group` | `{ groupId, innerLandedSha, outerLandedSha }` |
| `merge.group.rejected` | `merge_group` | `{ groupId, outcome: "rejected"\|"partially_landed", reason, incidentId? }` |
| `merge.incident.opened` | `merge_incident` | `{ incidentId, groupId, type, innerRepo, orphanedSha, outerRepo, innerRequestId, taskId }` |
| `merge.incident.auto_resolved` | `merge_incident` | `{ incidentId, groupId, outerLandedSha, resolvedByGroupId }` |
| `merge.incident.human_resolved` | `merge_incident` | `{ incidentId, groupId, outerLandedSha?, note }` |

### 10.3 Wire-frame pass-through

The `events.ts` flattened wire frame passes `entity_title`, `batch_id`, `speculative_position` additively (events.ts:101-113). Step 8 extends it to pass through group/incident identifying fields (`group_id`, `incident_id`, `orphaned_sha`) when present, mirroring the additive pattern - absent fields omitted, so all 7.1/7.2 frames stay byte-identical. The Phase 7.4 dashboard consumes these events AND queries the incident table directly for open incidents (both available because the state is PM-owned).

### 10.4 Synthetic-event FK safety

Group/incident events reference real persisted rows (the group/incident the service just wrote), so they are FK-safe by construction (the verified pattern from 7.2). No synthetic entity ids on the wire.

---

## 11. Failure-mode catalog

Extends 7.1 §15 / 7.2 §15. (trigger / detection / recovery / final state):

| Failure | Trigger | Detection | Recovery | Final state |
|---|---|---|---|---|
| **Inner push race** | Another lander advanced inner main between rebase and inner push -> `non_fast_forward` on PUSH 1 | `push1.reason === "non_fast_forward"` | Failure point (a), §6.3: reject the WHOLE group cleanly (nothing landed); the group re-integrates as a unit later (G1: no single-member re-queue). Outer never touched. | group `rejected`, no repo advanced |
| **Outer push race** | Another lander advanced outer main between assembly and outer push -> `non_fast_forward` on PUSH 2, AFTER inner landed | `push2.reason === "non_fast_forward"` | Failure point (b), §6.5: inner orphaned + incident opened. Outer main unchanged by us. | group `partially_landed`, incident `open` -> recovery |
| **Assembled verify fail** | A repo verify exits non-zero / times out on the assembled tree | §5.3 AND is false | Failure point (c), §6.6: reject the whole group. Nothing pushed, no incident. | group `rejected`, no repo advanced |
| **fs-full mid-assembly** | Disk fills during reset / fetch / submodule update / verify | Git op throws; worktree may be corrupt | Per-slot corruption-repair (7.2 `pool.repair`, separate clones); group rejected this pass (assembly precedes any push) and re-integrated when space frees. No partial land. | group `rejected` this pass |
| **Network drop between inner-push and outer-push (THE orphaned case)** | Inner PUSH 1 succeeded; network drops before/during PUSH 2 | `push2` fails (network) after `innerLandedSha` recorded | Failure point (b), §6.5: orphan + incident. Next group integration auto-rolls-forward (§7.3 case 1; no intervening outer change -> `RECONCILABLE` true -> verify-gated push) -> `auto_resolved`. | incident `open` -> `auto_resolved` |
| **Integrator crash between inner-push and outer-push** | Process dies after PUSH 1, before the §6.5 incident-write or PUSH 2 | Group is still `integrating` with NO `orphaned_inner` incident row (incidents are opened only synchronously on a live PUSH-2 failure, §6.4/§6.5 - never reconstructed from git SHAs) | Stranded-group recovery (§9 finding 2): the sweep resets the WHOLE group + members to re-integratable and re-runs the clean atomic land. The inner re-push is a fast-forward / no-op (inner main already at `Ri`); the outer push then completes the atom. No SHA-comparison orphan detection. Outer main is NEVER bumped except by a clean verify-gated group-land or a verify-gated recovery rollforward of an incident-backed orphan. | group re-integrated (then lands, or opens an incident synchronously if PUSH 2 fails again); outer never corrupt |
| **Submodule SHA mismatch** | After assembly the outer gitlink != intended inner SHA (bug / stale worktree) | Assembly assertion `readSubmoduleGitlink(outerWt, gitlinkPath) === Ri` after step 8 | Abort assembly, reject the group this pass (nothing pushed). Caught BEFORE any push, preserving R1. | group `rejected` this pass |
| **Orphaned inner SHA conflicts with intervening outer history (un-auto-resolvable)** | Recovery finds outer gitlink at `C`, `C` not ancestor of `O` (§7.4) | `RECONCILABLE(C, O)` false | ESCALATE (§7.5): incident stays `open`, comment posted, outer untouched. Human lands reconciling change, closes -> `human_resolved`. | incident `open` -> `human_resolved` |
| **Roll-forward assembled verify fails during recovery** | Reconcilable by ancestry but the assembled (gitlink->O) outer tree fails verify | §7.3 step 4 verify fails | ESCALATE (§7.5, case 3): outer untouched (R1). Human investigates. | incident `open` -> `human_resolved` |

Every row preserves R1: **outer main never advances to an unverified assembled gitlink.** The clean-reject cases (a)/(c) never push; the orphan case (b) pushes only inner (a non-gitlink advance); recovery pushes outer only verify-gated.

---

## 12. Backwards compatibility

> **Single-repo (`group_id` null) is byte-identical to 7.2. Groups are a strictly additive opt-in.**

The 7.2 contracts UNTOUCHED for non-group requests:

1. **The 7.2 scheduler** (`runBatchOnce`, speculative base chains, the drain loop, batch.ts) runs unchanged for single-repo members. With `linkedRepos` empty there is no group branch; the scheduler is the 7.2 path exactly. With `linkedRepos` configured, a single-repo request (`group_id` null) is still admitted via the 7.2 FIFO-head speculative path - only grouped members divert.
2. **Land + suffix invalidation** (7.2 §6/§7): structural land-gate, `survivingPredecessor`, `computeSuffix`, `invalidateSuffix`, fast-forward-or-reverify - all operate on single-repo members with no group awareness. A grouped member is never a speculative member (decision 5), so it never appears in a suffix or land-gate walk.
3. **The lane lock** (7.2 §9) is acquired/heartbeat/released identically; a group just holds it for its integration (§8).
4. **PM request/attempt state machines, merge-lock service, events.ts wire frame** - all additive: new columns default null/absent, new events are new names, the wire frame passes new fields through only when present. A 7.2 deployment that never creates a group and never configures `linkedRepos` produces byte-identical PM state, events, and integrator behavior.
5. **`parallelism` batching still applies to single-repo lanes** (decision 5): a lane with single-repo requests and an occasional group runs the single-repo requests speculatively (7.2) and the group atomically (7.3) under the same lane lock, never interleaving the group's members into a speculative chain.

Regression guard (Step 13 E2E): with `linkedRepos` empty and no groups, the full 7.2 E2E passes unchanged. The single-repo regression IS the empty-`linkedRepos` path.

---

## 13. Implementation roadmap pointer

| Roadmap step | Sections |
|---|---|
| Step 2 - DB schema + migration | §3.1 (`merge_request_groups`), §3.2 (`group_id` FK ON DELETE SET NULL), §4.1 (`merge_incidents`). |
| Step 3 - Shared Zod schemas | §3.3 (`MERGE_GROUP_STATES`), §4.2 (`MERGE_INCIDENT_STATES`), §4.1 (`MERGE_INCIDENT_TYPES`), row + create-group shapes. |
| Step 4 - linkedRepos config | §2.1 (config), §2.2 (game_one), §1.3 (empty default = 7.2). |
| Step 5 - Group service + state machine | §3.3 (state machine + `assertCanTransition`), §3.4 (G1), §3.2 (association). |
| Step 6 - Incident service | §4.1 (columns), §4.2 (state machine), §4.3 (task comment + surfacing). |
| Step 7 - REST routes + MCP tools | §3, §4, §6.7 (group-land op + G1 enforcement), §9 (auth split). |
| Step 8 - SSE events | §10 (names, payloads, PM-emitted divergence, wire-frame). |
| Step 9 - Multi-repo worktree assembly | §2.3 (gitlink), §5.1 (correlated lease), §5.2 (assembly), §5.4 (`updateSubmoduleGitlink`/`readSubmoduleGitlink`). |
| Step 10 - Group integration + assembled verify | §5.2, §5.3 (AND), §6.6. |
| Step 11 - Atomic land + orphan detection | §6 (sequence, three failure points), §6.5, R1 on both pushes. |
| Step 12 - Orphaned-inner recovery | §7 (§7.3 algorithm, §7.4 RECONCILABLE, §7.5 escalate, §7.6 worked cases, §7.7 R1 proof). |
| Step 13 - E2E + chaos | §6/§7, §11 (chaos kill points), §12 (single-repo regression). |
| Step 14 - Documentation | §2, §6, §7, §11; a post-ship §deviations subsection like 7.2 §16. |

---

## 16. Implementation notes / deviations (post-ship)

This section records where the **shipped code** (Steps 2–13) diverged from the design above and why.
The design sections remain the authoritative *contract*; these are the soundness-driven adjustments
made during implementation. Everything not listed here shipped as designed.

1. **§5.2 working-tree materialization added (the 2nd-review fix).** The original §5.2 assembly
   sequence committed the outer gitlink to `Ri` (mode `160000`) but did **not** populate the inner
   sources on disk at `gitlink_path` — so the outer verify would run against an *empty* submodule
   directory and could pass on a tree that does not actually build. The shipped `assembleGroup`
   (`group-assembly.ts`) adds **step 9, `materializeSubmoduleWorktree(gitlinkPath, Ri)`**: after
   `fetchFromPath(innerWt.path, Ri)` (step 7) copies `Ri`'s objects into the outer clone and
   `updateSubmoduleGitlink` (step 8) commits the gitlink, step 9 checks the inner@`Ri` tree out into
   the outer working tree on disk. The §11 post-assembly assertion is correspondingly **two-pronged**:
   (a) the *committed* gitlink reads back as `Ri`, AND (b) the working tree at `gitlink_path` is
   physically non-empty (`readdir().length > 0`). Either failing → `gitlink_mismatch`, reject this
   pass (pre-push, R1 preserved). This is the R1-critical correctness fix from the second review.

2. **`isAncestor` is a direct git spawn, not `simple-git`'s wrapper.** The RECONCILABLE predicate
   (§7.4) needs `git merge-base --is-ancestor C O` to return a clean boolean: exit 0 = ancestor,
   exit 1 = not-ancestor, exit ≥2/128 = undecidable (bad object). `simple-git`'s `git.raw(...)`
   **resolves its promise on exit 1** (treating non-zero as data, not error) instead of rejecting,
   which would make a non-ancestor look like a thrown error or vice-versa and break the §7.4 R1
   gate. The shipped `isAncestor` therefore spawns git directly and discriminates the exit code, so
   exit 1 returns `false` (escalate) and a real failure (128) throws (escalate) — never a silent
   auto-push on an undecided ancestry.

3. **Role binding = config-declared role + commitSha-preferred ref-existence + fail-loud.** §5.2 left
   "which member is inner vs outer" implicit. The shipped `bindMembersToRoles`
   (`group-integration.ts`, "FIX 1") resolves each member's identity ref **(commitSha preferred over
   branch — a SHA is globally ~unique and resolves in exactly one repo)** in *both* per-repo binding
   clones, binds the member to whichever clone resolves it, and takes the **role from config** (the
   `RepoLane.role`, not inferred from git). A member that resolves in **both** repos or **neither** is
   a true ambiguity → **fail loud** (reject the group from `forming`, no worktrees leased). The
   ref-existence check itself needed a fix: a bare `rev-parse <40-hex>` echoes any well-formed SHA
   back *without checking it exists*, so the clone uses **`rev-parse --verify <ref>^{commit}`**, which
   throws on an absent object — that throw (caught → `null`) is what makes commitSha-first binding
   resolve in exactly one repo (`index.ts` `resolveRefInClone`).

4. **`reclaimStrandedGroups` landed in Step 13, not Step 12.** The §6.4 / §9-finding-2 stranded-group
   crash-recovery sweep was nominally Step 12's territory (recovery) but was implemented late, with
   the E2E/chaos work in Step 13 (where the crash windows it guards are actually exercised). It lives
   in `recovery.ts` alongside `reclaimStrandedRequests` and is wired in `index.ts` only when a
   group lane exists. Its transition is **`integrating → forming`** via a new server op
   **`resetGroup`** (`POST /merge-groups/{id}/reset`), which atomically resets the group AND every
   `integrating` member back to `queued`. The sweep's discriminator is the **open `orphaned_inner`
   incident**: a stranded `integrating` group with *no* open incident is the crash-between-PUSH-1-and-
   incident-write window → reset (the inner re-push is a ff no-op, the outer push completes the atom);
   a group *with* an open incident is a real orphan → left untouched for §7 rollforward. The
   `resetGroup` route carries a second server-side fence: it 409s a group that has an open incident.

5. **The `ungrouped` list filter (§9 finding 3 realized).** So grouped members are never speculatively
   interleaved into the single-repo 7.2 chain, the merge-request list endpoint gained an
   **`ungrouped: true`** query filter, and `runBatchOnce`'s single-repo listing uses it. Symmetrically,
   `reclaimStrandedRequests` lists `ungrouped: true` so it never resets a grouped member out from
   under its group (grouped members are recovered as a whole group by `reclaimStrandedGroups`). This
   is the concrete realization of the §9 finding that a grouped member must never appear on the
   single-repo speculative path.

6. **Group land vs partially-land authz/reject split (CONSTRAINT B).** In the §6.5 orphan path the
   **outer member is rejected with the plain per-request `rejectMergeRequest`**, not the group-aware
   409-guarded reject — the G1 grouped-member guard lives on the group *land* route, not on per-member
   reject, so the orphan path can cleanly reject the single outer member while the group goes
   `partially_landed`. `markPartiallyLanded` sets only the **group** row (member states are set by the
   orphan-mark + the outer reject), and cross-links the incident id into its `resolution_reason`.

7. **Chaos fault hooks are test-only and env-gated (`chaos.ts`).** Step 13's crash-recoverability
   proof needs deterministic kill points. `chaosCrashPoint("after_inner_push" | "mid_assembly")`
   reads `PM_CHAOS_CRASH_AT` once at module load and `process.exit(137)` at exactly those two §6
   transitions (no `finally` runs → worktrees unreleased, no incident, group still `integrating` — the
   §6.4 window); `chaosFailOuterPushOnce()` reads `PM_CHAOS_FAIL_OUTER_PUSH=once` and makes the outer
   land push fail exactly once (the deterministic orphan trigger). Both are **no-ops unless the env var
   is set**, so production behavior is byte-identical. The one-shot outer-push failure is wired in
   `index.ts` by wrapping the inner lane's gitOps factory and discriminating on the `-outer` worktree
   path suffix (because assembly builds *both* GitOps from the inner lane's factory) — the real outer
   lane factory is left intact so the §7 recovery push succeeds.

---

## Appendix A: Settled-decisions compliance checklist

- [x] **Decision 1 (PM-owned group + incident state, divergence from 7.2).** §1.2 states the transient-execution-vs-durable-coordination principle; §3/§4 add the PM tables; §10 makes events PM-emitted (not relayed); §1.2 justifies batch execution state staying integrator-owned.
- [x] **Decision 2 (inner-first atomic land, one integrator transaction).** §6.2 sequences inner-then-outer; §6.4 the transaction boundary; §6.3/§6.5/§6.6 pin the three failure points.
- [x] **Decision 3 (auto-rollforward + human fallback; never break outer main).** §7.3 auto-rollforward; §7.4 RECONCILABLE; §7.5 escalation; R1 (§7.1) proves outer main never advances past an unverified assembled tree, in recovery as in land.
- [x] **Decision 4 (verify against the assembled state).** §5.2 assembles inner@Ri + outer@(gitlink->Ri); §5.3 runs per-repo verify, all-must-pass (the AND).
- [x] **Decision 5 (backwards compatible; group is the atomic unit).** §1.4 prime invariant; §12 the untouched 7.2 contracts; §9 audits; a group is never speculatively interleaved.
