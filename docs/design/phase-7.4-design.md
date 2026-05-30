# Phase 7.4 Design: Observability + Break-Glass

**Target audience**: Claude agents (design, implementation, testing) and the human director
**Created**: 2026-05-30
**Status**: Shipped (Steps 2–13 complete) — see §14 for implementation-driven deviations. Step 1 was the load-bearing design step (adversarial verification before Step 2).
**Parent roadmap**: `roadmaps/phase-7.4-observability-breakglass.md`
**Vision reference**: `roadmaps/phase-7-merge-train-vision.md` (Phase 7.4)

This document is the authoritative architecture spec for Phase 7.4 (Month 4) of the merge-train build. Every later step (Steps 2–14 of the roadmap) treats this file as the single source of truth for the audit-log + health table columns, the train-state model, the five break-glass overrides (especially force-land — the deliberate R1 override), the metric formulas, the SLO model, the webhook alert mechanism, the REST surface, the SSE event set, the web architecture, and the authz rules. **When this document and the roadmap disagree on a detail, this document wins.**

This doc **builds on `docs/design/phase-7.1-design.md`, `phase-7.2-design.md`, and `phase-7.3-design.md`.** Those contracts are unchanged unless explicitly noted here. In particular the following are inherited verbatim:

- 7.1 §5 (request + attempt state machines), §6 (the decision matrix + the canonical idempotency rule), §8 (REST surface conventions: `{ data }` / `{ error: { code, message } }` envelopes), §9 (the SSE wire frame projected by `routes/events.ts`), §11 (the authz helpers `requireAuth` / `requireIntegrator` / `requireAdmin` and the `ai_agent` gate), §12 (the transactional auto-side-effect discipline), §14 (the reference-integrator architecture).
- 7.2 §9 (the lane-ownership lock — acquired once per batch, the single-owner race-guard), §13 (the events-not-tables observability contract the dashboard already consumes: `batchId`/`speculativePosition`-tagged frames + the four `merge.batch.*` markers).
- 7.3 §1.2 (the divergence principle: **transient EXECUTION state lives in the integrator; durable COORDINATION / INCIDENT / ACCOUNTABILITY state lives in PM tables**), §3/§4 (the group + incident models), §6 (the atomic land protocol whose R1 verify-gate force-land deliberately overrides), §10 (the group/incident SSE events).

Where 7.4 adds something — the dedicated `audit_log` table (§2), the dedicated `integrator_health` channel (§3), the per-project `train_state` + the five overrides (§4), on-read metrics (§5), per-project SLO config (§6), the dual alert delivery (§7 — in-app SSE/banner PLUS a NEW minimal outbound Discord webhook) — the addition is called out at the point of divergence. Everything else in 7.1/7.2/7.3 stands.

---

## 0. Reading guide

The load-bearing sections, in dependency order: **§2** (the `audit_log` table — every override and natural land/reject writes to it; its columns are named by §4/§8/§11), **§3** (the `integrator_health` channel — the heartbeat payload + staleness detection named by §5/§7/§8), **§4** (train state + the five overrides — the highest-risk part, with force-land pinned EXACTLY), and **§5** (the on-read metric formulas, each grounded against a shipped column). The remaining sections compose around those four: §6 (SLO config = metric-vs-target), §7 (the three webhook alerts), §8 (the REST surface, every path pinned), §9 (the new `train.*` SSE events), §10 (the web architecture grounded against the shipped React app), §11 (authz), §12 (the roadmap-step pointer).

The single most important invariant, stated once here and pinned in §2/§4:

> **Every break-glass override (pause, resume, force_release_lock, force_land, force_reject) writes exactly one `audit_log` row, in the same `db.transaction` as the state change it performs, before any event is emitted. The audit row is the accountability record; it is the ONE thing that may not be skipped. force-land — the deliberate human override of the 7.1/7.2/7.3 R1 verify-gate — is admin-only, reason-required, and its audit row is the sole record of who advanced `main` past an unverified tree and why.**

### 0.1 Why observability now (the framing)

Through 7.1–7.3 the train became a real system that does real work: it picks up worker requests, batches them speculatively, lands them atomically across repos, and opens incidents when a cross-repo land half-completes. It also gets stuck in ways the authors did not fully predict — a stranded `integrating` request after a crash, a lane lock held by a dead integrator until its 5-minute TTL sweep, an orphaned-inner incident awaiting roll-forward, a verify command that wedges. Today the only way to see any of that is to query SQLite directly or read integrator logs over SSH. **A system that requires its authors to operate it has not shipped.** 7.4 makes the train legible (a dashboard that answers "what's wrong" in 60 seconds), recoverable by a human via the UI (five break-glass overrides — no DB surgery, no SSH), accountable (a dedicated audit log), and self-alerting (the three `train.*` alerts surface BOTH in-app — via the existing SSE stream + a dashboard banner — AND out-of-band via a minimal NEW per-project outbound Discord webhook, so an alert reaches a human whether or not the dashboard is open). This is the first phase that is mostly human-facing web UI rather than backend git mechanics.

---

## 1. Goals, non-goals, and the six settled decisions

### 1.1 The six settled decisions (non-negotiable, restated from the roadmap)

> 1. **The audit log is a DEDICATED `audit_log` table** — action-centric (actor / action / target / reason / metadata-before-after / timestamp), NOT an extension of the entity-centric `activity_log`. Break-glass actions don't map to a single entity, and audit needs immutable, reason-carrying rows that `activity_log` lacks. Queryable by user / target / time-window. Append-only (no update, no delete).
> 2. **Integrator health is a DEDICATED health channel** — the integrator POSTs a periodic heartbeat (status + worktree-pool utilization + in-flight counts + version) to a new PM endpoint; PM tracks `last_seen` per `(project, resource)` and raises `train.integrator_unhealthy` on a stale heartbeat. This works when the integrator is IDLE (holds no lane lock), exactly when lock-derived health is blind.
> 3. **All 5 break-glass overrides ship**: pause (stop new pickups, finish in-flight), resume, force-release-lock (admin, audited), force-land (the R1 override — land WITHOUT verify, admin-only + reason-required + prominently audited), force-reject (admin + reason). Every override writes an audit row.
> 4. **The full vision dashboard ships**: queue depth, in-flight batches/groups with per-member state, integrator heartbeat freshness, recent lands/rejects, last-24h time-to-land p50/p95/p99, verify success rate, abandon rate, worktree-pool utilization, per-request timeline, and SLO compliance per project.
> 5. **Backend-first, then web.** Data + APIs (audit, health, train-state + overrides, metrics, SLO, webhooks) → regenerate the web API types → React UI → integrator changes (emit heartbeats + honor pause) → full-stack E2E.
> 6. **Alert delivery is DUAL: in-app (SSE + dashboard banner) PLUS a NEW minimal outbound Discord webhook.** The three train alerts (`train.stuck`, `train.abandon_rate_high`, `train.integrator_unhealthy`) (a) ride the existing `/api/v1/events` SSE stream and raise a dashboard banner in-app, AND (b) are POSTed to a per-project Discord webhook URL by a new minimal event-bus listener. **Director ruling (supersedes the roadmap's "reuse the existing webhooks" wording): there is NO existing OUTBOUND delivery to reuse — the shipped `webhooks.ts` is INBOUND-only (§7.1). 7.4 ADDS the smallest outbound mechanism that satisfies the intent: a `discord_url` in project settings + an event-bus listener that POSTs the alert payload.** Defaults to Discord; no queue, retry daemon, or pluggable-provider abstraction.

The dedicated-audit-table, dedicated-health-channel, all-5-overrides, full-dashboard, backend-first, and dual-alert-delivery decisions are NOT negotiable. Implementing agents may make tactical decisions within these constraints.

### 1.2 The divergence principle, applied to 7.4 (where each new piece of state lives)

7.3 §1.2 drew the line: *transient EXECUTION state lives in the integrator (in-memory); durable COORDINATION / INCIDENT state lives in PM (tables).* 7.4 adds a third category that lands on the PM side of the line for the same reason 7.3's incidents did — **it must outlive the integrator process and be queryable from PM alone:**

- **Audit / accountability state** (`audit_log`): who did what to the train and why. Survives integrator crashes, survives the process that performed the natural land. A human operator and the dashboard query it from PM. → PM table (§2).
- **Health / liveness state** (`integrator_health`): the last heartbeat from each integrator lane. The whole point is to know the integrator is alive *when it is idle and holds no lock* — a fact only PM can durably track. → PM table (§3).
- **Train control state** (`train_state`): paused vs running, per `(project, resource)`. The integrator reads it to decide whether to pick up new work; a human writes it via the pause/resume overrides. It must be readable by an integrator that just restarted. → PM table (§4).

Conversely, what STAYS integrator-owned (unchanged): the in-memory `Batch`/`Member` model (7.2 §3), the worktree pool, the speculative ordering. The dashboard's in-flight view (§5.3) is composed from the PM `merge_requests`/`merge_attempts`/`merge_request_groups` rows the integrator already maintains plus the `batchId`-tagged SSE frames (7.2 §13) — 7.4 adds NO PM batch table (decision 1 of 7.2 still holds).

### 1.3 Non-goals (deferred to later phases)

- **Enforced SLOs.** 7.4 records SLO targets and surfaces compliance; auto-actions on breach (auto-pause, auto-escalate) are deferred.
- **A `train.integrator` role / per-lane permissions / advisory board.** 7.4 ships pause/resume/force-* gated by the EXISTING `admin` role (see §11 and the operator-role judgment call). The full per-lane permissions model is Phase 7.6.
- **Smart verification (caching, multi-stage, test-impact).** Phase 7.5.
- **A deep Playwright dashboard E2E suite.** 7.4 leans on API-level E2E (Step 13) + web component tests; a Playwright smoke is optional.
- **Pre-aggregated / time-series metrics storage.** 7.4 computes metrics on-read (§5.6); a rollup table is a later optimization if the data outgrows on-read.

### 1.4 Prime invariant (the accountability anchor)

> **No grouped or single merge request reaches a terminal state via a break-glass override without a corresponding `audit_log` row. The audit row is written in the same transaction as the override's state change. For force-land specifically, this is the ONLY record that the R1 verify-gate was bypassed by a named human for a stated reason.**

§4 enforces this at the service layer; §11 makes "audit row mandatory" a guarded invariant, not a convention; Step 4 asserts it per-override in tests.

---

## 2. Audit-log data model (PM-owned, append-only)

### 2.1 Why a dedicated table, not `activity_log`

The shipped `activity_log` (schema.ts:289) is **entity-centric**: `(entityType, entityId, projectId, actorId, action, changes, createdAt)`. It answers "what happened to THIS task/proposal/epic." It is the wrong shape for audit for three concrete reasons:

1. **Break-glass actions don't map to a single entity.** `pause`/`resume` act on the train (a `(project, resource)` lane), not a row. `force_release_lock` acts on a lock. Forcing these into `activity_log` would mean inventing synthetic `entityType` values and losing the action-centric query ("show me every override this operator did across all targets").
2. **Audit needs a `reason` and structured before/after.** `activity_log.changes` is a field-diff JSON for UI rendering; it has no first-class `reason`. A force-land's reason ("hotfix for prod outage, verify infra down") is the load-bearing accountability datum and deserves its own column.
3. **Audit must be immutable and queryable by actor + target + time-window.** `activity_log` has no immutability contract and is indexed for entity lookups, not actor/time-window scans.

So 7.4 adds `audit_log` — the canonical, append-only record of "who did what to the train and why." (This mirrors 7.3's reasoning for `merge_incidents`: a durable, PM-queryable fact that outlives the process that created it.)

### 2.2 The `audit_log` table

New Drizzle table in `packages/server/src/db/schema.ts` (roadmap Step 2). Column conventions match the existing `merge_*` tables exactly: `text("id").primaryKey()` ULID, `text` ISO-8601 timestamps (NOT integer epoch), snake_case DB column names, `.references()` FKs, non-unique `index(...)` for every query path. The hand-authored migration is `0012_audit_log.sql` (the drizzle-kit snapshot chain is broken — do NOT run `db:generate`; hand-author matching the `0010`/`0011` style, journal idx 12).

```ts
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    // The lane scope. Audit is always project-scoped (every override targets a
    // project's train). NOT nullable — there is no cross-project audit row.
    projectId: text("project_id").notNull().references(() => projects.id),
    // The HUMAN (override) or ai_agent (natural land/reject) who performed the
    // action. NOT nullable — audit always has a named actor (the accountability
    // datum). For a natural land/reject this is the integrator's ai_agent user.
    actorId: text("actor_id").notNull().references(() => users.id),
    // The action taxonomy (§2.3). Enum AUDIT_ACTIONS lives in @pm/shared (Step 8,
    // re-exported). Stored as text; the enum is the validation gate.
    action: text("action").notNull(),
    // What the action targeted: "merge_request" | "merge_lock" | "train"
    // | "merge_group". Enum AUDIT_TARGET_TYPES. Lets the query filter by target
    // class. "train" targets carry targetId = the resource name (e.g. "main").
    targetType: text("target_type").notNull(),
    // The target's identifier: a merge_requests.id, a merge_locks resource name,
    // a group id, or the resource for a train-level action. NOT an FK (targets
    // are heterogeneous — a resource name is not a row id), so no .references().
    targetId: text("target_id").notNull(),
    // Free-text reason. REQUIRED (non-null, non-empty) for force_land and
    // force_reject; optional (nullable) for pause/resume/force_release_lock and
    // the natural land/reject. The service enforces the required cases (§4).
    reason: text("reason"),
    // Structured snapshot of the target's relevant fields BEFORE the action.
    // JSON. e.g. for force_land: { status: "integrating", landedSha: null }.
    metadataBefore: text("metadata_before", { mode: "json" }),
    // Structured snapshot AFTER. e.g. for force_land:
    // { status: "landed", landedSha: "<sha>", overridden: true }.
    metadataAfter: text("metadata_after", { mode: "json" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // Query-by-time-window within a project (the audit-log view default).
    index("idx_audit_log_project_created").on(table.projectId, table.createdAt),
    // Query-by-actor (the "everything this operator did" view).
    index("idx_audit_log_actor").on(table.actorId, table.createdAt),
    // Query-by-target (the "history of this merge request / lock / lane" view —
    // feeds the per-request timeline §8.3 and the lock/lane audit panels).
    index("idx_audit_log_target").on(table.targetType, table.targetId, table.createdAt),
  ],
);
```

Note: there is deliberately **no `updatedAt`** column. An audit row is written once and never mutated — the absence of `updatedAt` makes the append-only contract structurally visible (an UPDATE would have nothing meaningful to set).

### 2.3 The action taxonomy

Enum `AUDIT_ACTIONS` in `packages/shared/src/schemas/audit.ts` (canonical; re-exported via `schemas/index.ts`, the Step-8 home, mirroring how `MERGE_REQUEST_STATUSES` lives in `schemas/merge-request.ts`):

```ts
export const AUDIT_ACTIONS = [
  // ── Break-glass overrides (HUMAN operator actions, §4) ──
  "pause",                // train: stop new pickups, finish in-flight
  "resume",               // train: resume new pickups
  "force_release_lock",   // lock: admin force-release a stuck lane lock
  "force_land",           // request: THE R1 override — land without verify
  "force_reject",         // request: admin reject a stuck verify
  // ── Natural train actions (ai_agent integrator actions, §2.5) ──
  "land",                 // request: the integrator's normal verified land
  "reject",               // request: the integrator's normal reject
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = [
  "merge_request",
  "merge_lock",
  "train",
  "merge_group",
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];
```

The five overrides plus the two natural actions are the complete set. Adding an action means editing one array (the canonical enum), period — the DB column is plain `text` validated against the enum, so no schema migration is needed to add a future action.

### 2.4 The audit service

`packages/server/src/services/audit.service.ts` (Step 2). Two functions:

```ts
// Append one immutable audit row. MUST be called inside the caller's
// db.transaction (takes the tx handle) so the audit row and the state change
// it records commit atomically (the §1.4 invariant). Emits nothing inside the
// tx; the caller may emit audit.recorded AFTER commit (§2.6). Returns the id.
export function record(
  tx: TxHandle,
  args: {
    projectId: string;
    actorId: string;
    action: AuditAction;
    targetType: AuditTargetType;
    targetId: string;
    reason?: string | null;
    before?: unknown;
    after?: unknown;
    now: string;
  },
): string;

// Query the audit log. All filters optional EXCEPT projectId. Ordered
// createdAt DESC (newest first), paginated (page/perPage, default 1/50,
// max 200 — the merge-request list convention). Composes the three indexes
// in §2.2 depending on which filters are present.
export function list(args: {
  projectId: string;
  userId?: string;       // actorId filter
  action?: AuditAction;
  targetType?: AuditTargetType;
  targetId?: string;
  from?: string;         // ISO 8601 inclusive lower bound on createdAt
  to?: string;           // ISO 8601 inclusive upper bound
  page?: number;
  perPage?: number;
}): { data: AuditLogView[]; pagination: { total: number; page: number; perPage: number } };
```

`record` is **write-only and has no public update/delete counterpart** — immutability is enforced by omission (the service exports no mutator) and reinforced by the absence of `updatedAt`. The query surface (`list`) is the dashboard's audit-log view (§10) and the per-request timeline's override rows (§8.3).

### 2.5 Wiring the natural land/reject into audit (Step 2)

Decision: the integrator's natural `land()` and `reject()` (the verified, non-override paths in `merge-request.service.ts`, 7.1 §12) ALSO write an audit row — so the audit log is a complete record of every land/reject, not just the overrides. This is surgical:

- Inside `land()`'s existing `db.transaction((tx) => { ... })` (after the status UPDATE + `attachLandedRef`), call `auditService.record(tx, { action: "land", actorId: actor.id, targetType: "merge_request", targetId: id, before: { status: "integrating", landedSha: null }, after: { status: "landed", landedSha: body.landedSha }, ... })`.
- Inside `reject()`'s transaction, call `record(tx, { action: "reject", ... before/after the rejection fields ... })`.
- The group-land path (`merge-group.service.ts:landGroup`, 7.3 §6.7) writes one `land` audit row per landed member inside its existing transaction, plus the orphan path (`markInnerOrphaned`) writes a `reject` audit row for the rejected outer member. (The incident itself is already PM-recorded in `merge_incidents`; the audit row is the actor-centric complement.)

`reason` is null for natural actions (the rejection's category/reason already live on the request row; audit's `reason` is reserved for the human's override justification). This wiring is emit-after-commit-safe: `record` writes inside the same tx the land/reject already opens; no new transaction, no event inside the tx.

### 2.6 The `audit.recorded` event (pinned: YES, emit it)

**Decision: emit `audit.recorded` AFTER each audit write commits**, so the dashboard's audit-log view updates live without polling (mirroring how every other PM mutation drives the SSE stream). It is added to `EVENT_NAMES` (§9). The payload's `entity` is the audit row; `entityType: "audit_log"`. The wire frame is the standard flattened projection (7.1 §9.2) — `action` becomes `recorded` (the event name minus its first segment). The dashboard subscribes and invalidates its audit query on receipt (§10). This is additive and costs nothing when no client listens.

---

## 3. Integrator health model (the dedicated heartbeat channel)

### 3.1 Why a dedicated channel, not lock-derived freshness

The lane lock already heartbeats (7.2 §9.2: a single 60s timer for the batch lifetime, refreshing `merge_locks.expiresAt`). It is tempting to derive "is the integrator alive?" from lock freshness. **This is blind exactly when it matters most: when the integrator is IDLE.** An idle integrator holds NO lane lock (it released on drain, 7.2 §9.3) — so there is nothing heartbeating. A healthy-but-idle integrator and a dead integrator look identical through the lock. The whole operational question — "the queue is empty, is that because there's no work, or because the integrator died?" — is unanswerable from the lock.

So the integrator POSTs a heartbeat on a fixed interval **regardless of whether it holds a lock or is idle**, and PM tracks `last_seen` per `(project, resource)`. Staleness of THAT timestamp is the liveness signal, and it works in every integrator state.

### 3.2 The heartbeat payload

The integrator POSTs this body (Step 3 / Step 12). Shared schema `integratorHeartbeatSchema` in `packages/shared/src/schemas/health.ts` (canonical; Zod-4 mirror in the route per the `integratorSettingsSchema` pattern):

```jsonc
// POST body to .../integrator/heartbeat
{
  "status": "idle",            // "idle" | "integrating" — the integrator's lane state
  "pool_utilization": {        // from worktree-pool.ts (size + leasedCount, confirmed shipped)
    "size": 3,                 // pool.size — total worktree slots
    "leased": 1                // pool.leasedCount — slots currently in use
  },
  "in_flight": {               // counts the integrator knows from its in-memory Batch + group lane
    "requests": 1,             // members currently integrating
    "batches": 1,              // in-flight batches (0 or 1 — one batch per lane, 7.2 §3.3)
    "groups": 0                // in-flight groups (0 or 1)
  },
  "version": "0.0.0"           // the integrator's package version (index.ts .version())
}
```

`status`, `pool_utilization.size/leased`, and `version` are required; `in_flight` defaults to all-zero if omitted. The pool numbers come straight from the shipped `WorktreePool` (`worktree-pool.ts` exposes `size` and `leasedCount`); the in-flight counts come from the integrator's in-memory batch/group state. **`pool_utilization` is the source of the dashboard's "worktree-pool utilization" metric (§5.5) — it is reported here, NOT computed by PM, because the pool lives only in the integrator.**

### 3.3 Where PM stores last-seen — the `integrator_health` table

**Decision: a dedicated `integrator_health` table, one row per `(project, resource)` lane.** Not a column on the project settings JSON (settings is config, not fast-moving telemetry, and a heartbeat every N seconds would thrash the projects row + its FTS). Not on `merge_locks` (that conflates liveness with lock-holding — the exact thing §3.1 separates). One row per lane mirrors the lock's `(project, resource)` cardinality.

```ts
export const integratorHealth = sqliteTable(
  "integrator_health",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    resource: text("resource").notNull().default("main"),
    // The integrator user (ai_agent) that last heartbeated this lane. The
    // heartbeat is an authenticated POST; actorId is the caller. ON DELETE SET
    // NULL so a deleted integrator user doesn't cascade away the health row.
    integratorId: text("integrator_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // The heartbeat's status ("idle" | "integrating").
    status: text("status").notNull(),
    // Pool utilization, denormalized from the heartbeat payload.
    poolSize: integer("pool_size"),
    poolLeased: integer("pool_leased"),
    // In-flight counts, denormalized.
    inFlightRequests: integer("in_flight_requests").notNull().default(0),
    inFlightBatches: integer("in_flight_batches").notNull().default(0),
    inFlightGroups: integer("in_flight_groups").notNull().default(0),
    version: text("version"),
    // THE liveness datum — the ISO timestamp of the most recent heartbeat.
    // Staleness of this is train.integrator_unhealthy (§3.4).
    lastSeenAt: text("last_seen_at").notNull(),
    // Tracks whether we have ALREADY raised integrator_unhealthy for the
    // current stale episode, so on-read detection (§3.4) fires the event /
    // alert exactly ONCE per stale→healthy→stale cycle (edge-triggered, not
    // level-triggered). Reset to false on the next fresh heartbeat.
    unhealthyNotified: integer("unhealthy_notified", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_integrator_health_project_resource").on(
      table.projectId,
      table.resource,
    ),
  ],
);
```

The unique index on `(project, resource)` makes the heartbeat an **upsert**: the first heartbeat inserts the row; every subsequent one updates `lastSeenAt` + the denormalized payload (matching the lazy-create + update pattern of `merge-lock.service.ts:getOrCreateLock`). Migration `0013_integrator_health.sql` (journal idx 13).

### 3.4 Staleness detection — ON-READ, not a sweep (pinned)

**Decision (director-ruled): staleness is computed ON-READ — in the health GET, the metrics GET, and opportunistically on the integrator's heartbeat POST — NOT by a background sweep timer. There is NO server `setInterval`/sweep anywhere in 7.4.** The heartbeat POST's upsert re-arms the edge for its own lane (a fresh beat clears `unhealthyNotified`); the staleness DETECTION fires on the dashboard's metrics/health reads (and, for a lane that another caller reads, on that read). Rationale (consistent with 7.2/7.3's preference for opportunistic-on-read over daemons, and with the lock's `sweepExpired`-on-every-op pattern):

- The data is tiny (one row per lane) and the only consumers that care about freshness — the dashboard health panel and the alert evaluation (§7) — read it anyway. Computing freshness at read time is always-fresh and adds one timestamp comparison.
- A background sweep is a second moving part (a `setInterval` in the server process) that must be started/stopped with the server lifecycle and tested for it. On-read avoids that entirely.

The staleness threshold is **`HEALTH_STALE_MS`**: the heartbeat interval (default 30s, §3.6) times a tolerance factor of 3 = **90 seconds** by default, per-project-overridable via `projects.settings.integrator.heartbeat_interval_sec` (§6.1 adds the setting). "Stale" means `now - lastSeenAt > HEALTH_STALE_MS`.

`health.service.ts` (Step 3):

```ts
// Read the lane health, computing freshness on-read. If the heartbeat is
// stale AND we have not yet notified for this stale episode, transactionally
// flip unhealthyNotified=true and (after commit) emit train.integrator_unhealthy
// + evaluate the webhook alert (§7). Edge-triggered: fires once per stale episode.
export function getHealth(projectId: string, resource: string): IntegratorHealthView;
```

The `IntegratorHealthView` carries the raw `lastSeenAt`, a derived `staleness_ms` (= `now - lastSeenAt`), a derived `healthy` boolean (`staleness_ms <= HEALTH_STALE_MS`), and the denormalized status/pool/in-flight/version. **The dashboard renders "last heard 47s ago" from `staleness_ms`** (formatted client-side). When `getHealth` finds a stale lane that has not yet been notified, it raises the event/alert exactly once and sets `unhealthyNotified=true`; the next fresh heartbeat upsert resets it to `false`, re-arming the edge for the next episode. If no row exists yet (the integrator has never heartbeated), the view reports `healthy: false`, `status: "never_seen"`, `lastSeenAt: null` — distinguishing "never started" from "died."

### 3.5 The heartbeat upsert

`health.service.ts:recordHeartbeat(projectId, resource, integratorId, payload)`:

1. Validate project exists (mirrors `ensureProjectExists`).
2. Upsert the `integrator_health` row for `(project, resource)`: insert-if-absent, else update `lastSeenAt = now`, the denormalized payload fields, `status`, `version`, `integratorId`, `unhealthyNotified = false` (a fresh heartbeat re-arms the edge), `updatedAt = now`.
3. No event on a normal heartbeat (heartbeats are high-frequency; emitting per-beat would flood the SSE stream). The dashboard's health panel polls the health GET on a short interval (§10) and/or refreshes on the `train.integrator_unhealthy` / `train.*` events; it does not need a per-heartbeat event.

### 3.6 Heartbeat interval (integrator side, Step 12)

The integrator POSTs a heartbeat every **30 seconds** (`HEARTBEAT_INTERVAL_MS = 30_000`), on a `setInterval` timer started at process boot (`index.ts`) and cleared on shutdown — independent of the lock heartbeat (which only runs during a batch). It also POSTs one immediately on startup (so "last heard" is fresh the moment the integrator comes up) and one on each lane-state transition (idle↔integrating) so `status` is timely. The 30s interval × 3 tolerance = the 90s `HEALTH_STALE_MS` gives two missed beats of slack before "unhealthy," tolerating a transient network blip without false alarms.

---

## 4. Train state + the five break-glass overrides (load-bearing)

### 4.1 Where pause-state lives — the `train_state` table

**Decision: a dedicated `train_state` table, one row per `(project, resource)` lane, holding `state ∈ {running, paused}`.** Not a column on the project settings JSON (pause is operational control state, mutated by a human override and read by the integrator on every poll — it does not belong in the config blob, and it is per-resource, which a single project setting can't express). One row per lane mirrors the lock + health cardinality.

```ts
export const trainState = sqliteTable(
  "train_state",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    resource: text("resource").notNull().default("main"),
    // "running" | "paused". Enum TRAIN_STATES in @pm/shared. Default "running".
    state: text("state").notNull().default("running"),
    // The actor who last paused/resumed, and when — surfaced on the dashboard
    // ("paused by alice 4m ago") and redundant with the audit row (which is the
    // canonical record; these are a denormalized convenience for the read).
    changedBy: text("changed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    changedAt: text("changed_at"),
    // Edge-trigger debounce flags for the on-read alerts (§7.3). Each is set
    // true when its alert fires and reset to false when the condition clears,
    // so the alert (SSE banner + Discord POST) fires once per breach episode,
    // not on every read. (integrator_unhealthy's equivalent flag lives on
    // integrator_health.unhealthyNotified, §3.3.)
    stuckNotified: integer("stuck_notified", { mode: "boolean" })
      .notNull()
      .default(false),
    abandonNotified: integer("abandon_notified", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_train_state_project_resource").on(
      table.projectId,
      table.resource,
    ),
  ],
);
```

Lazy-created on first read/write (the `getOrCreateLock` pattern), defaulting to `running`. Migration `0014_train_state.sql` (journal idx 14).

### 4.2 Pause semantics — how the integrator learns it's paused (pinned)

> **Pause means: the integrator stops picking up NEW work, but finishes the in-flight batch/group cleanly. It is NOT a kill. In-flight members keep verifying, land or reject normally, the lane lock releases on drain as usual. Only the ADMISSION of new requests is gated.**

The mechanism (the pause-check, Step 12):

- The integrator's batch loop (`runBatchLoop`, the admission gate in 7.2 §11 / §14) reads the train state **before admitting any new request** — concretely, before the FIFO `listMergeRequests(status: "queued")` admission pull at the top of a drain pass. It calls `pmClient.getTrainState(projectId, resource)` (a new GET, §8.6) or reads the paused flag carried on a lightweight poll.
- **If `state === "paused"`: admit NOTHING new.** Members already admitted to the current in-flight batch/group continue to completion (verify → land/reject), exactly as if the queue were empty. When the batch drains, the lane lock releases (7.2 §9.3) and the loop parks in `waitForWork` — but on each wake it re-checks the state and stays parked while paused. No new lock acquire happens while paused (acquiring a lane lock is part of starting a batch, 7.2 §9.1, which only happens when there's admissible work).
- **The integrator also honors pause as a fast-path on the poll tick:** while paused, `waitForWork` returns and the loop sees `paused` → it does not even attempt admission. This is the "stop new pickups" that makes a paused train visibly drain to idle and stay there.
- The integrator polls train-state cheaply (the same poll cadence as the queue poll, default 30s, plus the SSE `train.paused`/`train.resumed` events as a latency hint — §9). The poll is the correctness floor; SSE is the fast-path. This mirrors the existing "poll is the correctness floor, SSE is the latency hint" discipline (`index.ts` `waitForWork` + `sse-subscriber`).

This is deliberately a **read-side gate on the integrator**, not a PM-enforced block. PM does not refuse `pickup` while paused (that would race a batch the integrator legitimately wants to finish, and PM has no clean way to know "in-flight vs new"). The integrator is the single lane owner (7.2 §9) and is the right place to make the "new vs in-flight" distinction. PM's role is to durably record the pause state and let the integrator read it.

### 4.3 The train service + the five overrides

`packages/server/src/services/train.service.ts` (Step 4) owns pause/resume + the three force-* overrides (force-release-lock delegates to `merge-lock.service`, force-land/force-reject delegate to `merge-request.service` with an override flag). **Every override writes exactly one `audit_log` row inside the same `db.transaction` as its state change, then emits its event after commit (the §1.4 invariant).**

The five operations:

#### 4.3.1 `pause(projectId, resource, actor, reason?)`

- **Authz**: admin (see §11 for the operator-role judgment call — today `admin` is the gate for all overrides; pause/resume are documented as the "operator-or-admin" tier for when 7.6 adds an operator role).
- **Effect**: transactionally upsert `train_state` for the lane to `state: "paused"`, `changedBy: actor.id`, `reason`, `changedAt: now`; `audit.record(tx, { action: "pause", targetType: "train", targetId: resource, reason, before: { state: <prior> }, after: { state: "paused" } })`.
- **Emit** (after commit): `train.paused` (§9).
- **Idempotent**: pausing an already-paused lane is a 200 no-op that still writes an audit row (the act of "confirming pause" is auditable) — OR returns the current state without a duplicate audit row. **Pinned: idempotent no-op WITHOUT a duplicate audit row** (re-pausing an already-paused lane writes nothing and returns the row), matching the 7.1 idempotency rule (a terminal-producing op on an already-terminal target is a clean no-op).

#### 4.3.2 `resume(projectId, resource, actor, reason?)`

- **Authz**: admin (operator-or-admin tier).
- **Effect**: transactionally set `train_state.state: "running"` (+ changedBy/reason/changedAt); `audit.record(tx, { action: "resume", targetType: "train", targetId: resource, ... before: { state: "paused" }, after: { state: "running" } })`.
- **Emit**: `train.resumed`.
- **Idempotent**: resuming an already-running lane is a clean no-op (no audit row).

#### 4.3.3 `forceReleaseLock(projectId, resource, actor, reason)`

- **Authz**: admin only.
- **Effect**: a human force-release of a stuck lane lock — for when an integrator died and the operator does not want to wait out the 5-minute `LEASE_TTL_MS` sweep. Transactionally: read the current lock holder (for the `before` snapshot), then perform the lock release. **Mechanism**: call into `merge-lock.service` to clear the holder (this is the same field-clearing `sweepExpired`/`release` already do — `holderId=null`, intent cleared — but actor-initiated, not lease-expiry-initiated). Then `audit.record(tx, { action: "force_release_lock", targetType: "merge_lock", targetId: resource, reason, before: { holderId: <prior holder> }, after: { holderId: null } })`.
- **Emit**: `merge.lock.released` (the existing Stage-1 event, so existing consumers see the release) — the force-release reuses the shipped release path's emission. (No new SSE event for the lock release itself; the audit row + the existing `merge.lock.released` cover it.)
- **Note**: force-release does NOT touch any in-flight `merge_requests` — it only frees the lock. If a request was mid-integration under a dead integrator, the integrator's crash-recovery sweep (`reclaimStrandedRequests`) resets it on restart; force-release just lets a NEW integrator acquire the lane immediately.

#### 4.3.4 `forceLand(requestId, actor, reason)` — THE R1 OVERRIDE (pinned EXACTLY)

This is the single highest-risk operation in 7.4. It is the ONE place the verify-gate-before-fast-forward invariant (R1, established in 7.1 §1.1 commitment 3, reaffirmed in 7.2 §6 and 7.3 §7.1) is **deliberately overridden by a named human**. The audit row is the entire accountability mechanism.

- **Authz**: **admin only** (403 FORBIDDEN otherwise). NOT operator-tier — force-land advances `main` past an unverified tree; it is the most dangerous override.
- **Reason**: **required** (non-empty). A force-land with an empty/missing reason is **400 VALIDATION_ERROR** before any state change. The reason is the load-bearing accountability datum ("why did a human bypass verify?").
- **Precondition**: the request must be `integrating` (the same state a normal `land` requires, 7.1 §6). Force-landing a `queued` request is **409 INVALID_TRANSITION** (there is no integration to force-complete) — the operator must let the integrator pick it up first, or the force-land has no tree to land. Force-landing a terminal request follows the canonical idempotency rule (force-land on `landed` → 200 idempotent; on `rejected`/`abandoned` → 409).
- **Effect — EXACTLY** (one `db.transaction`):
  1. **Complete the open attempt as passed-with-override.** Find the request's current open attempt (the `running`/`pending` one). Write `status: "passed"` AND an `overridden: true` marker into the attempt's `failureReason`/metadata (there is no `treeSha` from a real verify — record `treeSha: <the landedSha the operator/integrator provides>` if known, else null; the attempt's `overridden` marker is what flags this as a non-verified pass). If NO open attempt exists (the request is `integrating` but the integrator never started one, or it was cancelled), **create-and-complete a synthetic attempt** at `passed`/`overridden` so the timeline (§8.3) shows the force-land as an attempt with no verify, never a phantom land with no attempt row.
     **IMPLEMENTATION HAZARD (pinned):** force-land is a HUMAN admin action, so it MUST NOT delegate to the shipped public service functions `land()`, `startAttempt()`, or `completeAttempt()` — all three hard-gate on `actor.type === "ai_agent"` (confirmed in `merge-request.service.ts`/`merge-attempt.service.ts`) and would throw `403 FORBIDDEN` for the human actor. The override service performs the attempt + request row writes DIRECTLY inside its own `db.transaction` (the tx-handle `attachLandedRef(tx, ...)` helper is already non-gated and reusable; the attempt insert/update and the request UPDATE are written inline, NOT via the gated wrappers). Step 4 either inlines these writes or extracts a non-gated tx-internal core from `land()`/`completeAttempt()` that both the ai_agent path and the admin override call.
  2. **Land the request without verify.** Apply the same land side-effects as the normal `land()` (7.1 §12.2): set `status: "landed"`, `resolvedAt`, `landedSha` (the SHA the operator supplies in the body — see §8.5 for where the SHA comes from), and `attachLandedRef(tx, ...)` to write the `landed_sha` git_ref on the linked task. **This is identical to the normal land's durable side-effects** — the ONLY difference from a normal land is that no verify gated it.
  3. **Write the mandatory audit row.** `audit.record(tx, { action: "force_land", actorId: actor.id, targetType: "merge_request", targetId: requestId, reason: <the required non-empty reason>, before: { status: "integrating", landedSha: null }, after: { status: "landed", landedSha: <sha>, overridden: true } })`. This row — admin actor, `force_land` action, the reason, the before/after — is the sole record that R1 was bypassed.
- **Emit** (after commit): `merge.request.landed` with an additional `overridden: true` extra on the payload (so the dashboard's "recent lands" can badge it as a force-land) + `audit.recorded`. The `landedSha` and `attemptId` extras are carried exactly as the normal land (7.1 §9.1).
- **What force-land does NOT do — and the PM-vs-git consistency contract (pinned)**: force-land does NOT push to git. Like the normal `land()` (which also only records the PM-side `landedSha` supplied in its body and never runs git — confirmed in `merge-request.service.ts:land`), `forceLand` records ONLY the PM-side landed fact. **Therefore PM-state and the git remote can diverge: force-land sets PM `status: "landed"` regardless of whether remote `main` actually points at `landedSha`.** This is COHERENT and deliberate, NOT a hole, because of the explicit operator contract: **force-land is "PM-records-landed; the operator advances the git remote separately."** The `landedSha` in the request body is the operator's ASSERTION of the SHA main is (or will be) at; the mandatory audit row records the human who made that assertion and why. The operator's runbook (Step 14, `integrator-deployment.md`) MUST state: a force-land is only correct after (or paired with) the operator manually fast-forwarding remote `main` to the asserted `landedSha` — PM does not and cannot verify the remote advanced (PM never runs git; only the integrator does). The integrator's lane lock is unaffected (force-land is a PM operation; if the integrator is alive and holds the lock, the operator typically pairs force-land with force-release-lock or pause to stop the integrator racing the manual push). **This is the deliberate, recorded, human-accountable bypass — the incident model's analogue for "a human chose to advance main past verify."**

**Grouped requests**: `forceLand` on a non-null-`group_id` member is **409** with a message directing the operator to the group (a grouped member can only land via the group-land family, 7.3 §3.4 G1; force-landing a single group member would violate atomicity). Force-landing a stuck GROUP is out of scope for 7.4 (deferred — the group's incident model + force-release-lock + re-integration is the recovery path; a `force_land_group` override is a candidate for a later phase). Director-accepted as a scoped-out edge (deferred per 7.3 G1).

#### 4.3.5 `forceReject(requestId, actor, reason)`

- **Authz**: **admin only**.
- **Reason**: **required** (non-empty); empty → 400.
- **Precondition**: request must be `integrating` (same as normal `reject`, 7.1 §6); idempotency rule applies for terminal states.
- **Effect** (one `db.transaction`): complete the open attempt as `failed` (with `failureCategory: "policy"` — the operator is rejecting on policy/judgment grounds, reusing the shipped `MERGE_REJECT_CATEGORIES` value `"policy"`; synthetic attempt if none open, as in force-land), set the request `status: "rejected"` + the rejection fields (`rejectCategory: "policy"`, `rejectReason: <the operator reason>`), write the `merge_rejection` comment on the linked task (the existing reject side-effect, 7.1 §12.3 — guard `taskId !== null`, matching the shipped `reject()`), and `audit.record(tx, { action: "force_reject", targetType: "merge_request", targetId: requestId, reason, before: { status: "integrating" }, after: { status: "rejected", rejectCategory: "policy" } })`. Same IMPLEMENTATION HAZARD as force-land: do NOT delegate to the ai_agent-gated public `reject()`/`completeAttempt()`; write the rows inline in the override's transaction (or via a shared non-gated tx-internal core).
- **Emit**: `merge.request.rejected` (with `overridden: true`) + `audit.recorded`.
- Used to unwedge a request stuck `integrating` (e.g. an integrator died mid-verify and the operator wants the request rejected so the queue clears, rather than waiting for crash-recovery to reset it to `queued` for a retry that will hang again).

### 4.4 The override-state-machine summary

| Override | Target | Authz | Reason required? | Audit action | State change |
|---|---|---|---|---|---|
| `pause` | train (resource) | admin (operator-tier) | no | `pause` | `train_state → paused` |
| `resume` | train (resource) | admin (operator-tier) | no | `resume` | `train_state → running` |
| `force_release_lock` | merge_lock (resource) | admin only | no | `force_release_lock` | lock `holderId → null` |
| `force_land` | merge_request | **admin only** | **YES (400 if empty)** | `force_land` | request `integrating → landed`, attempt `passed/overridden`, git_ref attached |
| `force_reject` | merge_request | **admin only** | **YES (400 if empty)** | `force_reject` | request `integrating → rejected (policy)`, attempt `failed/overridden`, reject comment |

Every row writes exactly one audit row in the same transaction as the state change (§1.4).

---

## 5. Metrics model (on-read aggregation)

### 5.1 On-read, not pre-aggregated (pinned)

**Decision: every dashboard metric is computed ON-READ by SQL aggregation over the shipped `merge_requests` / `merge_attempts` tables, NOT pre-aggregated into a rollup table.** Rationale: the data is small (a single train lane resolves on the order of tens of requests per day, not millions), the queries are simple `count`/percentile/ratio aggregations over indexed columns, and on-read is always-fresh with zero staleness and zero extra moving parts (no rollup job to schedule, no cache to invalidate). This matches the on-read preference 7.2/7.3 established. If a future phase's data outgrows on-read, a rollup table is the obvious optimization — explicitly deferred (§1.3).

`packages/server/src/services/metrics.service.ts` (Step 5) computes the bundle below per `(project, resource)` (resource optional — defaults to all resources in the project, or scoped to one if cheap). The metrics GET (§8.2) returns it.

### 5.2 Queue depth + in-flight

- **Queue depth** = `count(*) FROM merge_requests WHERE projectId = ? AND resource = ? AND status = 'queued'`. Uses `idx_merge_requests_resource_status`.
- **In-flight count** = `count(*) ... WHERE status = 'integrating'`. Same index. (Under 7.2 batching, N can be `integrating` at once, 7.2 §12 — the count is honest.)

### 5.3 In-flight composition (the per-member view)

`GET .../train/in-flight` (§8.2) returns the in-flight batches/groups with per-member state, composed PM-side (no PM batch table — 7.2 §13):

- Select all `merge_requests WHERE status = 'integrating'` for the lane, plus each one's latest `merge_attempt` (status, baseSha, treeSha, startedAt) and its `groupId`.
- Group rows by `groupId` (non-null → a group's members; null → speculative-batch members of the current in-flight batch). The dashboard renders each in-flight group's members with their per-member attempt state (`rebasing`/`verifying`/`verified` mapped from the attempt status, 7.2 §3.2), and the speculative batch's members with their `speculativePosition` (read from the latest `batchId`-tagged SSE frame the dashboard already holds, 7.2 §13.1 — OR omitted server-side and the dashboard correlates from the SSE stream). **Pinned: the server returns the `integrating` requests + their latest attempt + groupId; the speculative `batchId`/`speculativePosition` enrichment is the dashboard's job from the SSE stream it subscribes to (consistent with 7.2's events-not-tables contract).**

### 5.4 Time-to-land percentiles (last 24h)

- **Time-to-land** for a landed request = `resolvedAt - enqueuedAt` in milliseconds (both columns shipped on `merge_requests`; `enqueuedAt` set on submit, `resolvedAt` set on the terminal transition, 7.1 §4.1).
- **The 24h window**: compute the cutoff in JS as an ISO string — `const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString()` — and bind it: `WHERE status = 'landed' AND resolvedAt >= :cutoff`. **Do NOT use SQLite `datetime(now, '-24 hours')`**: its output format (`YYYY-MM-DD HH:MM:SS`, space-separated, no `T`/`Z`) is NOT lexicographically comparable to the stored `resolvedAt`, which is `new Date().toISOString()` (`YYYY-MM-DDTHH:MM:SS.sssZ`, `T`-separated, trailing `Z`) — the codebase stores ALL timestamps via `toISOString()` and compares them either in JS (`new Date(a) > new Date(b)`, the `merge-lock.service` pattern) or as ISO-vs-ISO string bounds. A JS-computed ISO cutoff bound is ISO-vs-ISO and lexicographically valid.
- **p50 / p95 / p99**: SQLite has no native percentile function, so compute it in the service: select the durations for the window ordered ascending, then index into the sorted array at `ceil(p/100 * n) - 1` (nearest-rank method) for p ∈ {50, 95, 99}. For small n (the expected case) this is trivial in JS after the ordered SELECT. Returns `{ p50_ms, p95_ms, p99_ms, sampleSize }`; null percentiles when `sampleSize === 0`.

### 5.5 Rates + pool utilization

- **Verify success rate** = `passed_attempts / total_completed_attempts` over the 24h window, where `passed = count(merge_attempts WHERE status = 'passed')` and `total_completed = count(WHERE status IN ('passed','failed'))` (cancelled attempts — push-race / invalidation re-admits, 7.2 — are EXCLUDED from the denominator; they are not verify outcomes). Computed over attempts whose `completedAt >= :cutoff` (the same JS-computed ISO cutoff as §5.4). Returns a 0–1 ratio + the raw counts; null when no completed attempts.
- **Abandon rate** = `abandoned_requests / resolved_requests` over the 24h window, where `abandoned = count(merge_requests WHERE status = 'abandoned')` and `resolved = count(WHERE status IN ('landed','rejected','abandoned') AND resolvedAt >= :cutoff)`. "Abandon" here is the request-level `abandoned` terminal (cancel / force-cancel, 7.1 §5). Returns a 0–1 ratio + counts.
- **Pool utilization** = `poolLeased / poolSize` from the LATEST `integrator_health` row for the lane (§3 — the integrator reports it; PM does not compute it because the pool lives in the integrator). Returns `{ size, leased, ratio }`, or null if no heartbeat exists. Stale-heartbeat caveat: the dashboard renders pool utilization greyed/"stale" when the health row is stale (§3.4), since the numbers are only as fresh as the last heartbeat.

### 5.6 The metric bundle

`metricsBundleSchema` (`@pm/shared`, Step 8):

```jsonc
{
  "resource": "main",
  "queue_depth": 2,
  "in_flight": 1,
  "time_to_land": { "p50_ms": 540000, "p95_ms": 720000, "p99_ms": 900000, "sample_size": 14 },
  "verify_success_rate": { "ratio": 0.92, "passed": 23, "total": 25 },
  "abandon_rate": { "ratio": 0.04, "abandoned": 1, "resolved": 25 },
  "pool_utilization": { "size": 3, "leased": 1, "ratio": 0.33 },
  "health": { "healthy": true, "staleness_ms": 12000, "status": "idle", "last_seen_at": "..." },
  "slo": { /* §6 compliance block */ },
  "window_hours": 24,
  "computed_at": "2026-05-30T14:24:48.902Z"
}
```

The `health` block embeds the §3.4 health view so the dashboard gets metrics + freshness in one request. The `slo` block is §6.

---

## 6. SLO model (per-project config + compliance)

### 6.1 SLO config lives in the integrator/project settings

Per-project SLO targets are recorded (NOT enforced — §1.3) in `projects.settings.integrator` alongside the existing `parallelism`/`linked_repos`, via a new optional `slo` sub-object. Canonical Zod in `integratorSettingsSchema` (`packages/shared/src/schemas/project.ts`), Zod-4 mirror in `routes/projects.ts` (the established split, 7.2 §2 / 7.3 §2.1). This is also where the `heartbeat_interval_sec` (§3.4) override lives:

```ts
// added to integratorSettingsSchema (Step 6):
heartbeat_interval_sec: z.number().int().min(5).default(30),
slo: z
  .object({
    // Target p95 time-to-land in seconds. Compliance = measured p95 <= target.
    target_p95_time_to_land_sec: z.number().int().min(1).optional(),
    // Target verify success rate (0–1). Compliance = measured >= target.
    target_verify_success_rate: z.number().min(0).max(1).optional(),
    // Target abandon rate ceiling (0–1). Compliance = measured <= target.
    target_abandon_rate: z.number().min(0).max(1).optional(),
  })
  .optional(),
```

All three targets are individually optional — an operator can set just the one they care about. Default = no SLO config = the dashboard shows "no SLO set" rather than a compliance verdict.

### 6.2 Compliance = metric vs target

Computed in `metrics.service` (§5) as part of the bundle. For each configured target, compare the measured metric (from §5.4/§5.5) to the target and emit a per-dimension verdict:

```jsonc
"slo": {
  "p95_time_to_land": { "target_sec": 600, "measured_ms": 720000, "compliant": false },
  "verify_success_rate": { "target": 0.9, "measured": 0.92, "compliant": true },
  "abandon_rate": { "target": 0.1, "measured": 0.04, "compliant": true },
  "overall_compliant": false   // AND of all configured dimensions; null if none configured
}
```

A dimension with no configured target is omitted (not `compliant: null`). `overall_compliant` is the AND of the configured dimensions, or null when none are configured. The dashboard renders each dimension as a green/red chip and the overall as the headline SLO verdict per lane. Compliance is read-only surfacing; nothing acts on a breach (enforcement is 7.6+).

---

## 7. Alert delivery (the three train alerts → SSE/banner + a NEW outbound Discord webhook)

Alert delivery has TWO independent halves, BOTH of which ship (director ruling):

- **(a) In-app: SSE + dashboard banner.** The three `train.*` alert events are added to `EVENT_NAMES` (§9) and ride the existing `/api/v1/events` SSE stream. The dashboard subscribes (its `useSSE` hook, §10.3) and raises a banner — `train.integrator_unhealthy` flashes the health panel red, `train.stuck`/`train.abandon_rate_high` raise a warning banner/toast. This is the "watching the dashboard" path. It reuses the SHIPPED SSE transport — nothing new on the transport side, just the new event names.
- **(b) Out-of-band: a NEW minimal outbound Discord webhook.** A new per-project `discord_url` + an event-bus listener that POSTs the alert payload to it. This is the "nobody is watching the dashboard" path — the alert still reaches a human. This is a NEW mechanism (§7.1/§7.2); it is NOT reusing any existing outbound delivery.

### 7.1 The grounding reality (why half (b) is NEW, not reused)

**Director ruling, reconciled here: the roadmap's decision 6 wording "reuse the existing webhooks.ts + Discord integration" is superseded — there is NO existing OUTBOUND webhook / Discord delivery in the server to reuse.** `packages/server/src/routes/webhooks.ts` is an INBOUND endpoint only (it receives git `branch_created`/`commit_pushed` events to auto-link refs — confirmed by reading it: it calls `git-auto-link.service`, no outbound HTTP). The only "notify" affordance is `automation.service.ts`'s `notify` action, which merely writes an `activity_log` row (no HTTP to Discord). The Discord skills in the harness are a *Claude-Code-channel* integration, not a PM-server feature. The author confirmed this to the director; the director ruled half (b) is a NEW minimal outbound mechanism.

**Therefore 7.4 ADDS a minimal outbound webhook delivery (half (b)).** It is the *smallest* outbound delivery that satisfies the intent: a per-project Discord webhook URL in settings + an event-bus listener that POSTs a Discord-shaped JSON message, built on the EXISTING event-bus listener pattern (the SSE route and activity-log listener both register via `getEventBus().onAll`/`.on`). It does NOT add a queue, retry daemon, or pluggable-provider abstraction.

### 7.2 The webhook config + delivery

- **Per-project config**: a new optional `webhooks` sub-object on `projects.settings` (sibling to `integrator`): `{ discord_url?: string, alerts_enabled?: boolean }`. Canonical Zod + Zod-4 mirror, the established pattern.
- **Delivery**: `webhook-alert.service.ts` (Step 7) registers an event-bus listener (`getEventBus().on(EVENT_NAMES.TRAIN_STUCK, ...)`, etc., for the three alert events) at server boot (wired in `app.ts` next to where other listeners register). On each alert event, if the project has a configured `discord_url` and `alerts_enabled !== false`, it POSTs a Discord-webhook-shaped JSON body (`{ content: "<formatted alert>" }`) to the URL via `fetch`, fire-and-forget with a `.catch` that logs failure (a failed Discord POST must never crash the server — mirrors the integrator's `onBatchEvent` swallow discipline, `index.ts`). Defaulting to Discord = the body is Discord's webhook content shape; a non-Discord URL that accepts the same shape works too, but Discord is the documented default.

### 7.3 The three alert events + trigger conditions (ON-READ evaluation, no sweep)

Added to `EVENT_NAMES` (§9). **Alert evaluation is ON-READ ONLY — there is NO server `setInterval`/sweep (director ruling, consistent with §3.4).** Each alert condition is evaluated when a read path runs:

- The dashboard's **metrics GET / health GET** (`train.stuck` and `train.abandon_rate_high` evaluate in `metrics.service`; `train.integrator_unhealthy` evaluates in `health.service.getHealth`, also reached via the metrics GET which embeds health).
- The integrator's **30s heartbeat POST**, whose upsert path re-arms the `integrator_health` edge (a fresh beat clears `unhealthyNotified`); the staleness CHECK itself fires on the next read of that lane's health.

The alert fires edge-triggered (once per breach episode, the same `unhealthyNotified`-style debounce). **Accepted tradeoff (director-accepted): a dead integrator with NOBODY watching the dashboard delays the `integrator_unhealthy` alert until the next read of a metrics/health path. This is acceptable — a human-facing alert that fires when a human (or a polling dashboard client) looks is sufficient for 7.4; a hosted always-on evaluation would require the sweep, deferred.** When an alert condition is detected on-read, BOTH delivery halves fire after commit: the `train.*` SSE event (half (a), the in-app banner) AND the outbound Discord POST via the §7.2 listener (half (b)).

| Event | Trigger condition | Where evaluated |
|---|---|---|
| `train.integrator_unhealthy` | The lane's heartbeat is stale: `now - lastSeenAt > HEALTH_STALE_MS` (§3.4). Edge-triggered via `integrator_health.unhealthyNotified`. | `health.service.getHealth` (on-read, §3.4) — also reached via the metrics GET which embeds health. |
| `train.stuck` | The queue is non-draining: the oldest `queued` request's age exceeds a threshold while the lane is NOT making progress. **Pinned formula**: `oldest_queued_age > STUCK_THRESHOLD_MS` (default = `2 × HEALTH_STALE_MS` worth of staleness, i.e. the head of the queue has sat un-picked-up for longer than the integrator could plausibly be busy) AND `in_flight === 0` (nothing is integrating — so the queue genuinely isn't draining, not merely deep). Edge-triggered per stuck episode via a `stuckNotified` flag on `train_state` (added to the §4.1 table). Default `STUCK_THRESHOLD_MS = 600_000` (10 min), per-project overridable via a `stuck_threshold_sec` setting. | `metrics.service` (on-read, computed alongside queue depth + in-flight). |
| `train.abandon_rate_high` | The 24h abandon rate (§5.5) exceeds a threshold: `abandon_rate.ratio > ABANDON_ALERT_THRESHOLD` (default 0.3) AND `abandon_rate.resolved >= MIN_SAMPLE` (default 5 — don't alert on 1-of-1). Edge-triggered via an `abandonNotified` flag (on `train_state`). | `metrics.service` (on-read). |

All three drive BOTH delivery halves: the SSE event (half (a), §7 intro) for the in-app banner AND the §7.2 outbound Discord POST (half (b)). The edge-triggered flags live on `train_state` (`stuckNotified`, `abandonNotified` booleans, defaulting false, reset when the condition clears) and on `integrator_health` (`unhealthyNotified`, §3.3) — so each alert fires once per breach episode, not on every poll. The same flag gates BOTH halves, so the Discord POST and the banner fire exactly once per episode in lockstep.

---

## 8. The REST surface

All endpoints mount under `/api/v1/`. New routers: `routes/train.ts` (metrics, in-flight, health, the heartbeat, train-state, the overrides), `routes/audit.ts` (the audit query), and a timeline handler added to `routes/merge-requests.ts`. Each is wired into `app.ts` next to the existing `createMergeRequestRoutes()` (the §read app.ts wiring). Envelopes follow the shipped convention: `{ data }` on success, `{ error: { code, message } }` on failure (7.1 §8).

### 8.1 Dashboard data API

| Method | Path | Body / Query | Response | Authz |
|---|---|---|---|---|
| GET | `/api/v1/projects/{projectId}/train/metrics` | query: `resource?` | `200 { data: metricsBundle }` (§5.6, includes health + SLO) | `requireAuth` |
| GET | `/api/v1/projects/{projectId}/train/in-flight` | query: `resource?` | `200 { data: { groups: [...], members: [...] } }` (§5.3) | `requireAuth` |
| GET | `/api/v1/projects/{projectId}/train/health` | query: `resource?` | `200 { data: integratorHealthView }` (§3.4) | `requireAuth` |
| GET | `/api/v1/projects/{projectId}/train/state` | query: `resource?` | `200 { data: trainStateView }` (paused/running + changedBy/reason/changedAt) | `requireAuth` |

### 8.2 The metrics/in-flight/health reads

`requireAuth` only (any authenticated user can VIEW the dashboard — it's read-only observability; only the overrides are gated). The metrics GET drives the on-read alert evaluation (§7.3) as a side effect.

### 8.3 The per-request timeline API

| Method | Path | Response | Authz |
|---|---|---|---|
| GET | `/api/v1/merge-requests/{id}/timeline` | `200 { data: timelineView }` | `requireAuth` |

The `timelineView` is the ordered state history of a request, composed PM-side from: the request row (its `enqueuedAt`/`pickedUpAt`/`resolvedAt` give the `queued → integrating → terminal` boundaries), every `merge_attempt` (each attempt's `startedAt`/`completedAt`/`status`/`baseSha`/`treeSha`/`logUrl` is a `verifying → passed|failed|cancelled` segment with a log pointer), the `audit_log` rows targeting this request (the natural land/reject AND any force_land/force_reject — so the timeline shows "force-landed by alice, reason: ..." inline), and any `merge_incident` whose `innerRequestId` is this request (the orphan outcome, 7.3 §4). Ordered by timestamp. This is the data the Step-10 timeline view renders (queued → batched → verifying → landing → done, every attempt with its log link, the land/reject/orphan/override outcome).

### 8.4 The audit API

| Method | Path | Query | Response | Authz |
|---|---|---|---|---|
| GET | `/api/v1/projects/{projectId}/audit-log` | `userId?`, `action?`, `targetType?`, `targetId?`, `from?`, `to?`, `page?`, `perPage?` | `200 { data: auditLogView[], pagination }` | `requireAuth && requireAdmin` |

Filters map to `audit.service.list` (§2.4). **Authz: admin-only** — the audit log records who did what to the train, which is operator/admin-tier information (consistent with the overrides being admin-gated). Ordered newest-first, paginated.

### 8.5 The five override endpoints

| Method | Path | Body | Authz | Notes |
|---|---|---|---|---|
| POST | `/api/v1/projects/{projectId}/train/pause` | `{ resource?, reason? }` | `requireAuth && requireAdmin` | operator-tier (§11); idempotent |
| POST | `/api/v1/projects/{projectId}/train/resume` | `{ resource?, reason? }` | `requireAuth && requireAdmin` | operator-tier; idempotent |
| POST | `/api/v1/projects/{projectId}/merge-locks/{resource}/force-release` | `{ reason? }` | `requireAuth && requireAdmin` | admin-only |
| POST | `/api/v1/merge-requests/{id}/force-land` | `{ landedSha: string, reason: string }` | `requireAuth && requireAdmin` | admin-only; **reason required (400 if empty)**; the R1 override (§4.3.4). `landedSha` is the SHA the operator asserts main is/will be at. |
| POST | `/api/v1/merge-requests/{id}/force-reject` | `{ reason: string }` | `requireAuth && requireAdmin` | admin-only; **reason required** (§4.3.5) |

**`ai_agent` is NOT required and NOT permitted as the sole gate** — these are HUMAN operator actions (unlike the integrator endpoints in 7.1 §11 which require `ai_agent`). The actor is a human admin; the audit row records `actorId = the human`. (An admin who is also somehow an ai_agent is still admitted — the gate is `role === "admin"`, orthogonal to `type`.) New error codes: none new beyond the shipped `INVALID_TRANSITION` (409), `VALIDATION_ERROR` (400), `FORBIDDEN` (403), `NOT_FOUND` (404), `UNAUTHORIZED` (401).

The merge-lock force-release path placement is project-scoped (`/projects/{projectId}/merge-locks/{resource}/force-release`) because locks are addressed by `(project, resource)`, not a global id — mirroring how `merge-locks.ts` routes are project-scoped. The force-land/force-reject paths are top-level `/merge-requests/{id}/...` mirroring the shipped per-request endpoints (7.1 §8 path-placement note).

### 8.6 The heartbeat POST + train-state read (integrator-facing)

| Method | Path | Body | Authz | Notes |
|---|---|---|---|---|
| POST | `/api/v1/projects/{projectId}/integrator/heartbeat` | `integratorHeartbeatSchema` (§3.2): `{ resource?, status, pool_utilization, in_flight?, version }` | `requireAuth && requireIntegrator` (**ai_agent** gate) | The integrator POSTs its heartbeat; PM upserts (§3.5). |
| GET | `/api/v1/projects/{projectId}/train/state` | query: `resource?` | `requireAuth` | The integrator reads pause-state here (§4.2) — `requireAuth` suffices (an ai_agent is authenticated); humans read it too for the dashboard. |

The heartbeat is the ONE new integrator-facing (ai_agent) endpoint. The train-state read is shared (the integrator and the dashboard both read it). Everything else in §8 is human-facing.

### 8.7 SLO config

SLO targets are written via the EXISTING project-update endpoint (`PATCH /api/v1/projects/{id}`, the shipped projects route) by nesting them in `settings.integrator.slo` (§6.1) — no new endpoint. The Step-6 work is the schema + the compliance computation, not a new route.

---

## 9. SSE events

Add to `EVENT_NAMES` in `packages/server/src/events/event-bus.ts` (the §read shows the existing merge.* event blocks; append a train.* block + the audit event):

```ts
// Train control + alert events (Phase 7.4 — observability + break-glass)
TRAIN_PAUSED:               "train.paused",
TRAIN_RESUMED:              "train.resumed",
TRAIN_INTEGRATOR_UNHEALTHY: "train.integrator_unhealthy",
TRAIN_STUCK:                "train.stuck",
TRAIN_ABANDON_RATE_HIGH:    "train.abandon_rate_high",
// Audit (Phase 7.4 — emitted after every audit write commits, §2.6)
AUDIT_RECORDED:             "audit.recorded",
```

Payloads use the existing `EventPayload` interface and the flattened wire-frame projection (7.1 §9.2, the shipped `routes/events.ts`). The wire frame's `action` is the event name minus its first segment (`train.paused → paused`, `audit.recorded → recorded`). Per-event in-process extras (spread onto `payload.entity`, NOT carried on the wire — clients fetch detail via the GET, 7.1 §9.2):

| Event | entityType | Extras (in-process) |
|---|---|---|
| `train.paused` / `train.resumed` | `train` | `resource`, `changedBy`, `reason` |
| `train.integrator_unhealthy` | `train` | `resource`, `lastSeenAt`, `stalenessMs` |
| `train.stuck` | `train` | `resource`, `oldestQueuedAgeMs`, `queueDepth` |
| `train.abandon_rate_high` | `train` | `resource`, `ratio`, `resolved` |
| `audit.recorded` | `audit_log` | the audit row fields (`action`, `targetType`, `targetId`, `actorId`) |

`projectId` is set on every train.* payload (so the SSE project filter, `routes/events.ts:47`, scopes them to the project). The dashboard SUBSCRIBES to the existing `/api/v1/events` SSE stream (the same stream everything else uses, 7.1 §9 / 7.2 §13 / 7.3 §10) for live updates: a `train.paused` banner-flips the controls, `train.integrator_unhealthy` flashes the health panel red, `audit.recorded` invalidates the audit query, and `merge.request.landed`/`rejected` (with the `overridden` extra) update "recent lands/rejects." No new SSE transport — these ride the shipped stream. The integrator's `sse-subscriber` already consumes this stream; it can additionally listen for `train.paused`/`train.resumed` as the §4.2 latency hint (poll remains the correctness floor).

---

## 10. Web architecture (grounded against the shipped React app)

The shipped web app (read: `router.tsx`, `hooks/use-sse.ts`, `hooks/use-tasks.ts`, `pages/`, `components/ui/`) is React 19 + Vite + TanStack Router (code-defined route tree) + TanStack Query (keyed query factories per domain, e.g. `taskKeys`) + a single global SSE hook (`useSSE`) that invalidates query caches on events, + a Radix/Tailwind component library (`components/ui/*`: button, card, table, dialog, badge, tabs, etc.) + Zustand stores. 7.4's pages fit this exactly:

### 10.1 Routes (TanStack Router, `router.tsx`)

Add project-scoped child routes under the existing `projectRoute` (`/projects/$projectId`), mirroring how `projectBoardRoute`/`projectActivityRoute` are defined and added to `projectRoute.addChildren([...])`:

- `/projects/$projectId/train` → `TrainDashboardPage` (Step 9): the full vision dashboard.
- `/projects/$projectId/train/audit` → `AuditLogPage` (Step 11): the audit-log view + break-glass controls (admin-gated UI).
- The per-request timeline (Step 10) is a component reachable from the dashboard's in-flight/recent rows AND embedded in the existing task-detail / a `/merge-requests/$id/timeline`-style detail (tactical — likely a `MergeRequestTimeline` component rendered in a dialog/panel from the dashboard, plus a link from the task detail's git-refs section). Pinned: the timeline is a COMPONENT consuming the §8.3 API, surfaced from the dashboard; a dedicated full-page route is optional.

### 10.2 Data hooks (TanStack Query)

New hook files mirroring `use-tasks.ts`'s keyed-factory shape:

- `hooks/use-train.ts`: `trainKeys` factory + `useTrainMetrics(projectId, resource)`, `useTrainInFlight(...)`, `useTrainHealth(...)`, `useTrainState(...)` (each a `useQuery` against the §8.1 GETs, `enabled: !!projectId`). The health/metrics queries use a short `refetchInterval` (e.g. 10–15s) so "last heard Ns ago" stays live even between SSE events — SSE is the fast-path, the interval is the floor (same poll-vs-push discipline as the integrator).
- `hooks/use-audit.ts`: `auditKeys` + `useAuditLog(projectId, filters)`.
- Mutation hooks for the overrides: `usePauseTrain()`, `useResumeTrain()`, `useForceReleaseLock()`, `useForceLand()`, `useForceReject()` — each a `useMutation` POSTing the §8.5 endpoint, with `onSuccess` invalidating `trainKeys` + `auditKeys` (mirroring `useUpdateTask`'s invalidation).

### 10.3 SSE integration (`use-sse.ts`)

Extend the shipped `useSSE` hook's `eventTypes` array + `getInvalidationKeys` map to handle the new `train.*` and `audit.recorded` events: a `train.*` event invalidates `trainKeys.all` (refreshing the dashboard's metrics/health/state) and a `audit.recorded` invalidates `auditKeys.all`. The hook's existing toast affordance can surface a `train.integrator_unhealthy`/`train.stuck` as a warning toast. This is purely additive to the shipped hook (new switch cases + new event-type strings) — no structural change.

### 10.4 Components (Radix/Tailwind library)

The dashboard composes the shipped `ui/*` primitives: `Card` for each metric panel, `Table` for in-flight members + recent lands/rejects + the audit log, `Badge` for status/SLO-compliance chips, `Tabs` to switch metric/in-flight/audit views, `Dialog` for the break-glass confirm dialogs, `Button`/`Input`/`Textarea`/`Label` for the override forms. The force-land confirm dialog (Step 11) is a `Dialog` requiring a reason (`Textarea`, mandatory) and showing a prominent "**This overrides the verify gate — main will advance past an unverified tree**" warning; the submit is disabled until a non-empty reason is entered (the client-side mirror of the §4.3.4 400). The break-glass controls render per-role (read `useAuth`'s current user role): admins see force-release/force-land/force-reject; the pause/resume buttons render for the operator-tier (today = admin; §11). Health freshness renders as "last heard 47s ago" from `staleness_ms` (§3.4), greying when stale.

---

## 11. Authz

### 11.1 The role tiers + the operator-role decision (director-accepted)

The roadmap says "pause/resume (admin OR operator)" and "force-* (admin-only)." **Grounding fact: the shipped `USER_ROLES` enum is `["admin", "member"]` (read: `packages/shared/src/constants/enums.ts:45`) — there is NO "operator" role today.** A `train.integrator` / operator role is explicitly a Phase 7.6 deliverable (7.1 §1.2, §11; 7.2 §1.2). So 7.4 cannot gate on a role that does not exist.

**Decision (pinned): in 7.4, ALL five overrides are gated on the EXISTING `admin` role** (via the shipped `requireAdmin` middleware / the `requireAdmin` helper, 7.1 §11). The design documents pause/resume as the "operator-tier" overrides (lower-risk: reversible, no verify bypass) so that when 7.6 introduces an operator role, pause/resume widen to `admin OR operator` with a one-line change, while force-* stay admin-only. Until then, admin is the gate for everything. **Director-accepted: "admin-only for all five in 7.4, operator-tier widening deferred to 7.6" — no operator role is introduced now (that is 7.6's permissions-model scope).**

### 11.2 The authz rules per operation

| Operation | Authz | Audit row | Actor type |
|---|---|---|---|
| View dashboard (metrics/in-flight/health/state/timeline) | `requireAuth` | — | any (human or ai_agent) |
| View audit log | `requireAuth && requireAdmin` | — | human admin |
| `pause` / `resume` | `requireAuth && requireAdmin` (operator-tier, widens in 7.6) | mandatory | **human** |
| `force_release_lock` | `requireAuth && requireAdmin` | mandatory | **human** |
| `force_land` (R1 override) | `requireAuth && requireAdmin` + reason-required | mandatory | **human** |
| `force_reject` | `requireAuth && requireAdmin` + reason-required | mandatory | **human** |
| Heartbeat POST | `requireAuth && requireIntegrator` (**ai_agent**) | — | integrator |
| Train-state read | `requireAuth` | — | integrator + human |

### 11.3 The two invariants

1. **The audit row is mandatory for every override.** Enforced at the service layer: each override's `db.transaction` includes the `audit.record` call; there is no code path that performs an override's state change without the audit write in the same transaction (§1.4, §4). Step 4 asserts this per-override.
2. **Overrides are HUMAN operator actions, NOT ai_agent.** Unlike the integrator endpoints (7.1 §11, `requireIntegrator`/`ai_agent`), the override endpoints gate on the human `admin` role and record `actorId = the human`. An ai_agent calling an override endpoint is rejected by `requireAdmin` (an ai_agent is a `member`, not an `admin`, unless explicitly made admin — which is an operator's deliberate choice, not the default). This keeps the accountability honest: a force-land's audit row names a human who chose to bypass verify.

---

## 12. Implementation-roadmap pointer (sections → steps 2–14)

| Roadmap step | Sections that specify it |
|---|---|
| **Step 2** — Audit-log table + service | §2 (table, taxonomy, service, natural-land/reject wiring, `audit.recorded`) |
| **Step 3** — Integrator health channel | §3 (heartbeat payload, `integrator_health` table, on-read staleness, the GET + heartbeat POST) |
| **Step 4** — Train state + 5 overrides | §4 (the `train_state` table, pause semantics, the five overrides — force-land pinned EXACTLY), §8.5 (endpoints), §9 (`train.paused`/`resumed`), §11 (authz) |
| **Step 5** — Metrics + dashboard data API | §5 (on-read formulas), §8.1/§8.2 (metrics + in-flight GETs) |
| **Step 6** — Timeline + SLO config | §8.3 (timeline composition), §6 (SLO config + compliance) |
| **Step 7** — Alert delivery (SSE/banner + outbound Discord) | §7 (the three alerts, on-read trigger conditions, BOTH delivery halves: the in-app SSE/banner + the NEW outbound Discord webhook), §9 (the three alert events) |
| **Step 8** — Shared schemas + API types + MCP | §2.3/§3.2/§5.6/§6/§8 schemas in `@pm/shared`; regen api-types + openapi. MCP: **no new MCP tools** (the dashboard is human-facing; the overrides are human operator actions, not agent tools) — at most a future read-only `pm_get_train_status`, deliberately omitted in 7.4. |
| **Step 9** — Web: train dashboard | §10.1/§10.2/§10.4 (route, hooks, components), §5/§3/§6 (the data it renders) |
| **Step 10** — Web: per-request timeline | §10.1 (the timeline component), §8.3 (the API) |
| **Step 11** — Web: audit view + controls | §10.4 (controls + confirm dialogs), §8.4 (audit API), §8.5 (override endpoints), §11 (per-role rendering) |
| **Step 12** — Integrator: heartbeats + pause | §3.6 (heartbeat emit), §4.2 (pause-check mechanism), §8.6 (the endpoints) |
| **Step 13** — Full-stack E2E | the §3 health-stale flow, the §4 pause flow + force-land flow + force-release flow, the §5 metrics flow — all API-level, mirroring the 7.2/7.3 spawned-integrator + in-process-PM harness |
| **Step 14** — Documentation | finalize this doc's deviations subsection; update `docs/integrator-deployment.md` (dashboard, heartbeat config, break-glass — esp. force-land's R1 semantics + audit trail, the alert webhooks, SLO config), `CLAUDE.md`, the web/integrator READMEs; mark 7.4 shipped in the vision |

---

## 13. Judgment calls — RESOLVED by director ruling (recorded for traceability)

The following were flagged for the director and have been RULED ON; they are settled, not open. Recorded here so later steps see the resolution.

1. **§7.1 — alert delivery is DUAL (in-app + a NEW outbound Discord webhook). RESOLVED.** The shipped `webhooks.ts` is INBOUND-only; there is no outbound Discord delivery to reuse. **Director ruling: ship BOTH the in-app SSE/banner surface AND a minimal NEW per-project outbound Discord webhook** (a `discord_url` in settings + an event-bus listener that POSTs). The roadmap's "reuse existing webhooks" wording is superseded (§7 intro, §7.1, §1.1 decision 6).
2. **§11.1 — admin-only for all five overrides. RESOLVED (accepted).** `USER_ROLES = ["admin","member"]`; no operator role exists. All five overrides gate on `admin`; pause/resume are documented as "operator-tier, widens in 7.6." No operator role is introduced now (that is 7.6 scope).
3. **§4.3.4 — force-land RECORDS the operator-asserted `landedSha`, never runs git. RESOLVED (accepted).** PM never runs git; only the integrator does. Force-land records the PM-side landed fact + the operator-asserted `landedSha`; the operator handles the git remote separately (§4.3.4 makes the PM-vs-git consistency contract explicit).
4. **§4.3.4 — grouped-member force-land → 409 (deferred per 7.3 G1). RESOLVED (accepted).** Force-landing a single cross-repo group member violates G1 atomicity; 7.4 409s it and defers a `force_land_group` override. The group's incident model + force-release + re-integration is the recovery path.
5. **§4.3.4 — synthetic attempt on force-land/force-reject when none is open. RESOLVED (accepted).** When `integrating` with no open attempt, create-and-complete a synthetic attempt so the timeline never shows a land/reject with no attempt row, vs. a null attemptId.
6. **§3.4 / §7.3 — on-read evaluation, NO server sweep. RESOLVED (accepted).** Health staleness AND the stuck/abandon alerts evaluate on-read (the dashboard's metrics/health reads + the integrator's 30s heartbeat POST), edge-triggered via `*Notified` flags, NO background `setInterval`. **Accepted tradeoff: a dead integrator with nobody watching the dashboard delays the `integrator_unhealthy` alert until the next read.** A hosted always-on evaluation would need the sweep — deferred.

---

## 14. Implementation notes / deviations (post-ship)

This section records where the **shipped code** (Steps 2–13) diverged from, sharpened, or made-concrete the design above, and why. The design sections remain the authoritative *contract*; these are the soundness-driven adjustments made during implementation. Everything not listed here shipped as designed.

1. **The ai_agent-gate-collision avoidance (the design-review catch) — force-land/force-reject write the rows INLINE, never delegating to the gated public service functions.** §4.3.4/§4.3.5 flagged the hazard; the shipped `train.service.ts` honors it absolutely. `forceLand`/`forceReject` are HUMAN admin actions, and the shipped public `land()`/`reject()`/`startAttempt()`/`completeAttempt()` all hard-gate on `actor.type === "ai_agent"` (they would throw 403 for a human admin). So the overrides perform the attempt insert/update + the request-row UPDATE + the rejection comment **directly inside their own `db.transaction`**, reusing only the already-non-gated `attachLandedRef(tx, …)` tx-internal helper. There is no path where an override delegates to an ai_agent-gated wrapper. (`train.service.ts` header comment + `forceLand`/`forceReject` bodies.)

2. **The outbound Discord delivery is NEW — `webhooks.ts` was inbound-only.** §7.1's grounding held: the shipped `routes/webhooks.ts` is an INBOUND git-event receiver (auto-link refs), and `automation.service`'s `notify` only writes an `activity_log` row — there was **no outbound HTTP delivery to reuse**. Half (b) ships as a NEW minimal listener, `events/alerts-listener.ts` (`registerWebhookAlertListener`), registered at boot in `events/index.ts`. It reads `projects.settings.webhooks.discord_url` defensively, formats a Discord `{ content }` body per alert, and POSTs fire-and-forget. No queue, no retry daemon, no provider abstraction.

3. **On-read alerting, NO sweep — and a hardened sync-throw guard on the listener (NOTE 2).** All three alerts evaluate on-read (§3.4/§7.3): `train.integrator_unhealthy` in `health.service.checkStaleness` (reached via `getHealth`, itself reached via the metrics GET which embeds health), `train.stuck`/`train.abandon_rate_high` in `metrics.service.checkAlerts` after the bundle is assembled. Because the listener handler runs **synchronously** on the EventEmitter's `emit()` inside `computeMetrics`, and the bus does not try/catch handler bodies, the shipped `alerts-listener.ts` wraps its ENTIRE sync path (the settings read + format) in try/catch and runs the fetch via an un-awaited `.catch`'d promise — so a misshapen settings row or a failed Discord POST can never 500 (or block) the metrics read.

4. **The metrics 24h window is a JS-computed ISO cutoff, never SQLite `datetime()`.** §5.4 pinned this; the shipped `metrics.service.computeMetrics` computes `cutoff = new Date(now - 24h).toISOString()` **once** and binds it into every windowed query as an ISO-vs-ISO lexicographic bound (`sql\`${col} >= ${cutoff}\``). The stored timestamps are all `toISOString()` (`…T…Z`); a SQLite `datetime('now','-24 hours')` (space-separated, no `T`/`Z`) is NOT lexicographically comparable to them, so it is deliberately never used. The percentiles are computed in JS (nearest-rank, `ceil(p/100·n)−1`) since SQLite has no percentile function.

5. **Edge-trigger latches fire once per breach episode and reset on clear — three separate flags.** `integrator_health.unhealthyNotified` (cleared by the next fresh heartbeat upsert), `train_state.stuckNotified`, and `train_state.abandonNotified` (each explicitly reset to `false` by `checkAlerts` when its condition clears). Each latch write is a single-statement autocommit UPDATE, with the event emitted AFTER the write returns (mirroring `checkStaleness`). To keep ALL `train_state` writes in one module, `metrics.service` reads/sets the two alert latches via the thin `readAlertLatch`/`setAlertLatch` helpers exported from `train.service`; `setAlertLatch` touches ONLY the named latch column + `updatedAt` — NEVER `state`/`changedBy`/`reason` — so a metrics read can never clobber an admin pause.

6. **The paused-train-not-stuck guard (folded recommendation).** `checkAlerts` reads the lane's `train_state.state` (via `readAlertLatch`) and adds `row.state !== "paused"` to the `train.stuck` condition: a paused train is deliberately held, not stuck, so it never raises the stuck alert even when the queue head ages past the threshold with nothing in flight.

7. **The integrator's pause read is fail-open.** `batch.ts:isPaused` returns `false` (treat as running) on a `getTrainState` error: a paused train the integrator transiently can't read is far less dangerous than a wedged train that can't progress because a transient GET error read as "paused". The hard no-abort safety (in-flight members always drain) holds regardless. Pause is re-read once per drain pass (NOT per member), gating ONLY new admission; recovery (orphaned-inner rollforward) still runs while paused because a half-landed group is in-flight cross-repo work, not new admission.

8. **`HEALTH_STALE_MS` shipped as a fixed 90s constant; the per-project `heartbeat_interval_sec` override is config-present but not yet wired into staleness.** `health.service.HEALTH_STALE_MS = 90_000` (the default 30s interval × 3 tolerance) is a module constant. The `heartbeat_interval_sec` setting (default 30, min 5) ships in `integratorSettingsSchema` and IS consumed by the integrator to set its emit cadence (`config.ts` → `index.ts setInterval`), but PM's staleness threshold does not yet read it per-project — the design's "per-project-overridable" staleness is deferred (the in-code comment notes this). Documented as such; not a bug.

9. **The web test harness was stood up in Step 9.** The dashboard pages (`/projects/$projectId/train`, `…/train/audit`) and their TanStack Query hooks + the SSE wiring for the new `train.*`/`audit.recorded` events landed with a web component-test harness established in Step 9 (the first phase that is mostly human-facing web UI), carrying the audit/timeline/controls work in Steps 10–11.

10. **The group-e2e flake was root-caused in Step 13.** The full-stack E2E gate (Step 13, the spawned-integrator + in-process-PM harness) surfaced an intermittent group-integration flake during 7.4's E2E run; it was root-caused and stabilized in Step 13 so the named server-test + E2E gates are green.

11. **`force_release_lock` HARD-CLEARS inline, deliberately NOT calling `merge-lock.service:release()` (PIN 2).** §4.3.3 said "reuse the release path"; the shipped `forceReleaseLock` instead clears the EXACT field set `release()`/`sweepExpired()` clear, inline, **without** any queue promotion — calling `release()` would promote the FIFO queue head and emit `merge.lock.granted` to an unintended waiter, which is wrong for a break-glass force-release. It still emits the existing `merge.lock.released` (with `forced: true` + `priorHolderId` extras) so existing consumers see the release, and writes the mandatory `force_release_lock` audit row.
