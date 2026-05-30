# Phase 7.4: Observability + Break-Glass — Roadmap

**Goal**: A human can answer "what's wrong with the train" in 60 seconds from a dashboard. When something is genuinely stuck, humans can unwedge it via the UI — no database surgery, no SSH. Every break-glass action is auditable and reversible-or-rollforward-safe. Alerts fire before users notice.

**Design reference**: `roadmaps/phase-7-merge-train-vision.md` Phase 7.4. Builds on 7.1 (worker/integrator split), 7.2 (speculative batching), 7.3 (cross-repo atomicity). This file is the Month 4 execution roadmap.

**Prerequisites**: Phases 7.1–7.3 complete and committed (merge_requests/attempts, merge_locks, merge_request_groups/incidents, the reference integrator on runBatchLoop + the group path, the SSE event stream with merge.request.*/merge.attempt.*/merge.batch.*/merge.group.*/merge.incident.* events, the existing web app + webhooks route + activity_log). 1429 tests green.

## Architectural decisions (settled with the director before drafting)

1. **The audit log is a DEDICATED `audit_log` table** (NOT an extension of the entity-centric `activity_log`). Audit is ACTION-centric: every land/reject/override/pause/resume/force-* records actor, action, target (request/group/lock/train id), reason, timestamp, and before/after where applicable. Break-glass actions (pause, force-*) don't map to a single entity, and audit needs immutable + reason-carrying rows that `activity_log` lacks. Queryable by user, by target, by time window. This is the canonical record of "who did what to the train and why."

2. **Integrator health is a DEDICATED health channel** (NOT derived from lane-lock heartbeat freshness). The integrator POSTs a periodic heartbeat to a new PM endpoint carrying status + worktree-pool utilization + in-flight counts; PM tracks last-seen and raises `train.integrator_unhealthy` when the heartbeat goes stale (configurable threshold). This works even when the integrator is idle (holds no lane lock) — exactly when lock-derived health is blind and you most need to distinguish "healthy but idle" from "dead."

3. **All 5 break-glass overrides** ship in this campaign: Pause train (stop accepting new pickups, finish in-flight cleanly), Resume train, Force-release a stuck lock (admin-only, audited), Force-land a request (skip verify — emergency only, requires explicit reason, admin-only, audited), Force-reject a stuck verify. The two verify-bypassing ones (force-land, force-reject) are admin-only + require an explicit reason + are prominently audited; force-land is the riskiest (it advances main past an unverified tree, the ONE place R1 is deliberately overridden by a human — the audit row is the accountability).

4. **The full vision dashboard** ships: queue depth, in-flight batches/groups with per-member state, integrator heartbeat freshness, recent landings/rejections, last-24h time-to-land p50/p95/p99, verify success rate, abandon rate, worktree-pool utilization, per-request timeline, and SLO compliance per project. SLO targets are per-project config (recorded, not enforced); the dashboard surfaces compliance.

5. **Backend-first, then web.** The dashboard/timeline/audit/controls UI consumes PM REST APIs; build the data + APIs first (audit, health, train-state+overrides, metrics, SLO, webhooks), regenerate the web API types, then build the React UI, then the integrator changes (emit heartbeats + honor pause), then full-stack E2E. This keeps each step independently testable and the web steps consuming a stable contract.

6. **Webhook alerts reuse the existing `webhooks.ts` + Discord integration.** New train alerts (`train.stuck`, `train.abandon_rate_high`, `train.integrator_unhealthy`) extend the shipped webhook delivery, defaulting to Discord. No new delivery mechanism.

**Design liberties**: Implementing agents may make tactical decisions within these constraints. The dedicated-audit-table, dedicated-health-channel, all-5-overrides, full-dashboard, backend-first, and reuse-existing-webhooks decisions are NOT negotiable.

**Risk note**: This is the first phase that is mostly web UI + human-facing operations rather than backend/git mechanics. The riskiest backend piece is force-land (a deliberate, audited R1 override). The riskiest integration piece is the pause semantics (the integrator must stop picking up NEW work while cleanly finishing in-flight). The web steps' risk is surface area + flake, not deep correctness.

---

## Steps

### Step 1 — Month 4 design doc

Write `docs/design/phase-7.4-design.md` (target 700–1000 lines). Load-bearing; every later step references it. Cover:
- **Audit-log data model**: the `audit_log` table columns (id, project_id, actor_id, action, target_type, target_id, reason, metadata JSON before/after, created_at), the action taxonomy (land/reject/pause/resume/force_release_lock/force_land/force_reject + the natural land/reject the train already does), the query surface (by user/target/time-window).
- **Integrator health model**: the heartbeat payload (status, pool utilization, in-flight counts, version), where PM stores last-seen (a table or the project settings / a dedicated `integrator_health` row), the staleness threshold + the `train.integrator_unhealthy` detection (a sweep or on-read), and how the dashboard reads "last heard 47s ago."
- **Train state + the 5 overrides**: where train pause-state lives (per-project: a `train_state` row/column — paused/running), the pause semantics (integrator stops NEW pickups, finishes in-flight), and each override's service + endpoint + authz + audit row: pause/resume (admin or operator), force-release-lock (admin, audited), force-land (admin, reason-required, the R1 override — pin EXACTLY what it does: completeAttempt(passed, override) + land without verify + the audit row), force-reject (admin, reason-required).
- **Metrics model**: how the dashboard metrics are computed (queue depth = queued count; in-flight = integrating; time-to-land p50/p95/p99 = enqueuedAt→resolvedAt over the last 24h; verify success rate = passed/total attempts; abandon rate; pool utilization — from the heartbeat). Pin whether metrics are computed on-read (query aggregation) or pre-aggregated. Lean on-read (small data, simple, always-fresh).
- **SLO model**: per-project SLO config (target p95 time-to-land, target verify success rate, target abandon rate) in project settings; compliance = computed metric vs target.
- **Webhook alerts**: the 3 train alert events + how they extend the existing webhooks delivery; the trigger conditions (train.stuck = queue non-draining / oldest-queued-age threshold; abandon_rate_high = abandon rate over threshold; integrator_unhealthy = stale heartbeat).
- **The REST surface**: the dashboard data API (GET metrics, GET in-flight, GET health), the timeline API (GET /merge-requests/{id}/timeline), the audit API (GET /audit-log with filters), the 5 override endpoints, the heartbeat POST, the SLO config.
- **SSE**: the new train.* events (train.paused/resumed, train.integrator_unhealthy, train.stuck, train.abandon_rate_high) + whether the dashboard subscribes to the existing SSE stream for live updates.
- **Web architecture**: how the dashboard/timeline/audit/controls pages fit the existing React app (TanStack Router routes, TanStack Query for the data APIs, the SSE hook for live updates, the existing component library).
- **Authz**: who can pause/resume vs force-* (the admin-only set); the audit row is mandatory for every override.

**Verify**: doc exists, internally consistent, every later step finds its contracts; the force-land R1-override semantics + the pause semantics + the audit-on-every-override invariant are pinned. Adversarial review.

### Step 2 — Audit-log table + service

- `audit_log` table (Drizzle, migration). Hand-author the migration matching the prior .sql style (the drizzle-kit snapshot chain is broken — do NOT run db:generate). Columns per §design.
- `audit.service.ts`: `record(action, actor, { targetType, targetId, reason, before?, after? })` (append-only, immutable), `list({ projectId, userId?, targetType?, targetId?, from?, to? })`. Emit nothing (audit is a record, not an event) OR a `audit.recorded` event if the dashboard wants live audit — pin in design.
- Wire `audit.record` into the EXISTING land/reject paths (the natural train actions get audited too, not just overrides) — surgically, emit-after-commit-safe.
- Tests: record + list filters; the land/reject audit wiring; immutability (no update/delete).

**Verify**: `pnpm --filter @pm/server test` audit tests + the land/reject-audited tests pass.

### Step 3 — Integrator health channel

- Health storage (a `integrator_health` row per (project, resource) or a table): last_seen, status, pool_utilization, in_flight counts, version.
- `POST /api/v1/projects/{projectId}/integrator/heartbeat` (ai_agent gate): the integrator POSTs its heartbeat; PM upserts last_seen + the payload.
- Staleness detection: `train.integrator_unhealthy` raised when last_seen older than the threshold (on-read in the health GET, or a periodic sweep — pin in design). `GET .../integrator/health` returns last-seen + freshness for the dashboard.
- `health.service.ts` + the route + the SSE event name.
- Tests: heartbeat upsert; health read with freshness; stale → unhealthy event/flag.

**Verify**: `pnpm --filter @pm/server test` health tests pass.

### Step 4 — Train state + the 5 break-glass overrides

- Train state (per-project paused/running) — a column or a `train_state` row.
- `train.service.ts` (or extend) with: `pause(projectId, actor, reason)`, `resume(projectId, actor, reason)`, `forceReleaseLock(projectId, resource, actor, reason)`, `forceLand(requestId, actor, reason)` (the R1 override: land without verify — completeAttempt(passed, overridden) + the land side-effects + attach landed_sha + the audit row), `forceReject(requestId, actor, reason)`. EVERY override calls `audit.record(...)` in the same transaction (emit-after-commit). Authz: pause/resume (admin or operator role), force-* (admin-only). force-land/force-reject require a non-empty reason (400 otherwise).
- Routes: POST .../train/pause, .../train/resume, .../merge-locks/{resource}/force-release, .../merge-requests/{id}/force-land, .../merge-requests/{id}/force-reject. ai_agent NOT required (these are HUMAN operator actions — admin/operator humans).
- SSE: train.paused/resumed events.
- Tests: each override's happy path + audit row written + authz (non-admin 403 on force-*; reason-required 400); force-land lands without an attempt verify-pass (the R1 override is recorded); pause sets state.

**Verify**: `pnpm --filter @pm/server test` override tests pass; every override writes an audit row (asserted).

### Step 5 — Metrics aggregation + dashboard data API

- `metrics.service.ts`: compute (on-read) queue depth, in-flight count, time-to-land p50/p95/p99 (last 24h), verify success rate, abandon rate, pool utilization (from the latest heartbeat). Per-project (+ per-resource if cheap).
- `GET /api/v1/projects/{projectId}/train/metrics` returns the metric bundle. `GET .../train/in-flight` returns the in-flight batches/groups with per-member state (compose from the existing merge-request/group/batch state).
- Tests: metrics computed correctly over a seeded dataset (percentiles, rates); in-flight composition.

**Verify**: `pnpm --filter @pm/server test` metrics tests pass.

### Step 6 — Per-request timeline + SLO config

- `GET /api/v1/merge-requests/{id}/timeline`: the ordered state history (queued→integrating→verifying→landing→done) with timestamps + every attempt with its log pointer + reject/land/orphan outcome. Compose from the request + its attempts + the audit rows + any incident.
- SLO config: per-project SLO targets (p95 time-to-land, verify success rate, abandon rate) in the integrator/project settings (canonical + Zod-4 mirror). Compliance computed in metrics.service (metric vs target).
- Tests: timeline composition over a multi-attempt request; SLO config accept/default; compliance computation.

**Verify**: `pnpm --filter @pm/server test` timeline + SLO tests pass.

### Step 7 — Webhook alerts (train.* → Discord)

- Add the 3 train alert events to EVENT_NAMES: `train.stuck`, `train.abandon_rate_high`, `train.integrator_unhealthy` (the last from Step 3).
- Trigger conditions (a periodic sweep or on-metric-read): train.stuck (oldest-queued-age over threshold / queue non-draining), abandon_rate_high (abandon rate over threshold), integrator_unhealthy (stale heartbeat). Pin the sweep mechanism (a lightweight interval in the server, or computed on the metrics read — design §).
- Extend the EXISTING `webhooks.ts` + Discord delivery to fire on these events (defaulting to Discord, reusing the shipped delivery). Per-project webhook config.
- Tests: each alert condition triggers the event + the webhook delivery is invoked (mocked Discord).

**Verify**: `pnpm --filter @pm/server test` webhook-alert tests pass.

### Step 8 — Shared schemas + API types + MCP (if any)

- Shared Zod schemas for the audit row, health payload, metrics bundle, timeline, train-state, SLO — in @pm/shared (canonical), re-exported. Add any enums (audit actions, train state).
- Regenerate the web API types (`pnpm --filter @pm/web generate:api`) so the web steps consume a typed contract. Regenerate openapi.json.
- MCP: only if a worker-facing tool makes sense (e.g. pm_get_train_status) — lean MINIMAL or none (the dashboard is human-facing; the overrides are human operator actions, not agent tools). Pin: likely no new MCP tools (or one read-only status tool); confirm against design.
- Tests: shared schema round-trips; openapi/api-types regenerate clean.

**Verify**: `pnpm --filter @pm/shared test` + build + `pnpm --filter @pm/web generate:api` + typecheck pass.

### Step 9 — Web: Train dashboard page

- New dashboard route/page (TanStack Router) consuming the metrics + in-flight + health APIs via TanStack Query, with live updates via the existing SSE hook. Surfaces: queue depth, in-flight batches/groups (per-member state), integrator heartbeat freshness ("last heard 47s ago"), recent landings/rejections, time-to-land p50/p95/p99, verify success/abandon rates, pool utilization, SLO compliance per project. Use the existing component library (Radix/Tailwind).
- Tests: component/page tests (the web test setup); the dashboard renders the seeded metrics. (E2E in Step 13.)

**Verify**: `pnpm --filter @pm/web test` + typecheck + build pass; the dashboard renders.

### Step 10 — Web: Per-request timeline view

- A timeline page/component (linked from the dashboard + the request view): queued→batched→verifying→landing→done with timestamps, every verify attempt with a link to its log, the land/reject/orphan outcome. Consumes the Step-6 timeline API.
- Tests: renders a multi-attempt timeline; the log links.

**Verify**: `pnpm --filter @pm/web test` + typecheck pass.

### Step 11 — Web: Audit log view + break-glass controls

- Audit log view: queryable by user/target/time-window (the Step-2 API), each row showing actor/action/target/reason/timestamp.
- Break-glass controls UI: Pause/Resume buttons (operator), and the admin-only Force-release-lock / Force-land / Force-reject controls — each with a confirm dialog requiring a reason (for force-land/force-reject) and a clear "this overrides the verify gate" warning on force-land. Wire to the Step-4 endpoints.
- Tests: the controls render per-role (admin sees force-*; operator sees pause/resume); the reason-required dialog; the API calls.

**Verify**: `pnpm --filter @pm/web test` + typecheck pass.

### Step 12 — Integrator: emit heartbeats + honor pause

- The integrator POSTs heartbeats to the Step-3 endpoint on an interval (status + pool utilization + in-flight counts). READ the pool/scheduler for the utilization + in-flight numbers.
- The integrator honors train pause: before picking up NEW work (runBatchOnce / runGroupLaneOnce), check the train state (via a config read or a paused flag on a poll); when paused, finish in-flight cleanly + stop new pickups. Pin the pause-check mechanism (the integrator polls train-state, or the pause is surfaced via the lock/pickup returning a paused signal).
- pm-client: postHeartbeat + getTrainState (or the paused flag). index.ts wiring.
- Tests: the integrator emits a heartbeat (unit, fake pm-client); honors pause (no new pickup when paused, in-flight completes).

**Verify**: `pnpm --filter @pm/integrator-ref test` heartbeat + pause tests pass.

### Step 13 — Full-stack E2E

- Self-contained E2E (in-process PM + spawned integrator + the web served, OR API-level): (a) the integrator heartbeats → the health API shows fresh → stop the integrator → health goes stale → train.integrator_unhealthy fires; (b) pause the train → the integrator stops picking up new requests → resume → it picks up again; (c) force-land a request (admin) → it lands without verify + the audit row is written + visible via the audit API; (d) the dashboard metrics API reflects a real seeded train (queue/in-flight/rates); (e) a break-glass force-release-lock unwedges a stuck lock. Mirror the 7.2/7.3 E2E harness shape (spawned integrator + in-process PM). The web UI E2E (Playwright) is OPTIONAL — lean on API-level E2E for the train behavior + the web component tests for the UI; add a Playwright dashboard smoke if cheap.
- Tests RUN (not skipped); `pnpm test` green across the monorepo.

**Verify**: the E2E runs + all flows pass; monorepo `pnpm test` green.

### Step 14 — Documentation

- Update `docs/integrator-deployment.md`: the dashboard, the heartbeat config, the break-glass controls (esp. force-land's R1-override semantics + the audit trail), the alert webhooks, the SLO config.
- Finalize `docs/design/phase-7.4-design.md` with a deviations subsection.
- Update `CLAUDE.md`: the observability/break-glass surface (dashboard, audit, overrides, health).
- Update the web README / the integrator README (heartbeat + pause).
- Mark Phase 7.4 shipped in the vision.

**Verify**: docs cross-checked vs shipped source; `pnpm typecheck` + server tests green.

---

## Out of scope for Phase 7.4 (later phases)

- **Smart verification (caching, multi-stage, test-impact)** — Phase 7.5.
- **Multi-train lanes / permissions / advisory board** — Phase 7.6 (7.4 ships pause/resume/force-* as operator controls; the full per-lane permissions model is 7.6).
- **Enforced SLOs** — 7.4 records + surfaces SLO compliance; enforcement (auto-actions on breach) is deferred.
- **A full Playwright dashboard E2E suite** — 7.4 leans on API-level E2E + component tests; a deep web E2E is a follow-up if the dashboard surface warrants it.

## Definition of done

- An operator who has never seen the codebase can diagnose a stuck train from the dashboard alone (queue/in-flight/health/timeline/metrics).
- Every break-glass action (pause/resume/force-release/force-land/force-reject) is audited (actor/action/target/reason/timestamp) and visible in the audit log; force-land's R1 override is prominently recorded.
- Stuck trains can be unwedged via the UI — no DB surgery, no SSH.
- The integrator health channel shows "last heard Ns ago" and raises train.integrator_unhealthy on a stale heartbeat (even when the integrator is idle).
- Alerts (train.stuck / abandon_rate_high / integrator_unhealthy) fire to Discord via the existing webhook delivery.
- The dashboard surfaces the full metric set (queue, in-flight, p50/p95/p99, success/abandon rates, pool utilization, SLO compliance).
- All existing tests stay green; new unit + integration + E2E cover audit, health, overrides, metrics, timeline, alerts. Build + typecheck clean.
- Docs let an operator run the dashboard, read the audit log, and use the break-glass controls.
