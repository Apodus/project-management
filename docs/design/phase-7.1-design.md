# Phase 7.1 Design: Worker / Integrator Split

**Target audience**: Claude agents (design, implementation, testing) and the human director
**Created**: 2026-05-29
**Status**: Approved plan — adversarial verification complete
**Parent roadmap**: `roadmaps/phase-7.1-worker-integrator-split.md`
**Vision reference**: `roadmaps/phase-7-merge-train-vision.md`

This document is the authoritative architecture spec for Phase 7.1 (Month 1) of the merge-train build. Every later step (Steps 2–13 of the roadmap) treats this file as the single source of truth for column types, state machine transitions, event payloads, MCP tool shapes, authz rules, and integrator behavior. When this document and the roadmap disagree on a detail, this document wins.

---

## 1. Goals & non-goals

Month 1 delivers the smallest train that satisfies the worker-walks-away contract: a worker calls `pm_request_merge` and exits. A single long-lived integrator process per `(project, resource)` picks each request up serially, rebases onto live `main`, runs the project-configured verify command in an isolated worktree, and either lands the result (advancing `main` and attaching a `git_refs` row to the linked task) or rejects it with a structured payload (category + failed files + log pointer) that auto-posts as a comment on the linked task. Verification happens off to the side; `main` only fast-forwards after a tree SHA proves green.

### 1.1 Non-negotiable architectural commitments

These are inherited verbatim from the vision doc and reaffirmed here. Implementing agents may make tactical decisions about file layout, helper signatures, and test fixtures, but they may not change any of the following:

1. **PM owns coordination state; the reference integrator (a separate process) owns execution.** PM never spawns build commands. The server's job is to record queued/integrating/landed/rejected facts; the integrator's job is to make them true.
2. **Workers call `pm_request_merge` and exit.** No worker is parked on a lock for the duration of a verify build. This is the load-bearing user-visible improvement over Stage 1.
3. **Main is never broken.** Verify runs against a tree SHA before `main` fast-forwards. A verify failure terminates as `rejected`; it cannot land.
4. **Rejection is a first-class operation with structured payload.** `(category, failedFiles[], logExcerpt | logUrl, attemptId, reason)` is recorded on the request row, in the SSE event, and in an auto-posted comment of type `merge_rejection` on the linked task.
5. **Stage 1 `acquire`/`release`/`heartbeat` continue to work unchanged.** The new flow is opt-in. Stage 1 callers see no behavior change.
6. **Parallelism for this phase is exactly 1.** The worktree pool, batching, cross-repo atomicity all come later. Serial integration is intentional and the design relies on it (only one in-flight `integrating` request per `(project, resource)` lane).

### 1.2 Out of scope (covered by later phases)

- **Speculative batching / parallelism > 1** — Phase 7.2. The worktree pool, batch state machine, and suffix invalidation are explicitly deferred.
- **Cross-repo atomicity (rynx + outer gitlink)** — Phase 7.3. No `merge_request_groups`, no atomic multi-repo land.
- **Train dashboard, audit log surface, break-glass UI** — Phase 7.4. The data plumbing (events, audit-able actions, force-cancel endpoint) is built now; the UI and richer override semantics come later.
- **Verify-result caching, multi-stage verify, test impact analysis** — Phase 7.5.
- **Chaos test suite, multi-train lanes, permissions model, advisory board** — Phase 7.6. In particular: a per-project `train.integrator` role does not exist yet (see Section 11).

---

## 2. Canonical naming

This section is the authoritative naming table for the entire phase. Every later section, every test name, every database column, every SSE event payload field, and every MCP tool argument cites these names verbatim. Drift between locations is a defect.

| Concept | Canonical name | Notes |
|---|---|---|
| Request statuses (full set) | `"queued"`, `"integrating"`, `"landed"`, `"rejected"`, `"abandoned"` | Source enum: `MERGE_REQUEST_STATUSES` (section 3). |
| Attempt statuses (full set) | `"pending"`, `"running"`, `"passed"`, `"failed"`, `"cancelled"` | Source enum: `MERGE_ATTEMPT_STATUSES` (section 3). |
| Reject categories (full set) | `"conflict"`, `"build_failed"`, `"test_failed"`, `"lint_failed"`, `"verify_timeout"`, `"policy"`, `"other"` | Source enum: `MERGE_REJECT_CATEGORIES` (section 3). Same value-space everywhere: `merge_requests.rejectCategory`, `merge_attempts.failureCategory`, the SSE event payload, the auto-comment metadata. |
| `git_refs.refType` value for a landed merge | **`"landed_sha"`** | The roadmap mentions both `"landed"` (lines 36 and 305) and `"landed_sha"` (line 142). The canonical value is **`"landed_sha"`** because (a) the column value IS a SHA and the type name should say so, and (b) roadmap Step 5 is the authoritative implementation directive, which uses `"landed_sha"`. Steps 5 and 13 must align with this name; any documentation that uses `"landed"` for this concept is wrong and should be corrected when touched. |
| `comments.commentType` value for auto-rejection | **`"merge_rejection"`** | Added to `COMMENT_TYPES`. |
| Resource name for the default lane | `"main"` | Matches `merge_locks.resource` default. Stage 1 already enforces `MERGE_LOCK_RESOURCE_PATTERN`. |
| Default verify timeout | `600` seconds | Per-project override via `projects.settings.integrator.verify_timeout_sec`. |
| Stage 1 lease TTL | `5 * 60 * 1000` ms | See `merge-lock.service.ts:25` (`LEASE_TTL_MS`). The integrator reuses this — no new TTL constant. |
| Log excerpt size cap | `4 KB` | First 4096 bytes of failed verify output. Larger output is referenced only by `logUrl`. |

---

## 3. Enum location specification

Every enum and constant introduced by this phase has exactly one home file. Other packages import from there; nothing redeclares the value list. Adding a value means editing one file, period.

| Constant / type | File | Notes |
|---|---|---|
| `MERGE_REQUEST_STATUSES`, `MergeRequestStatus` | `packages/shared/src/schemas/merge-request.ts` | Mirrors the Stage 1 pattern in `schemas/merge-lock.ts` where `MERGE_LOCK_ACQUIRE_STATUSES` lives alongside the corresponding Zod schema. |
| `MERGE_ATTEMPT_STATUSES`, `MergeAttemptStatus` | `packages/shared/src/schemas/merge-request.ts` | Same file; attempts are an extension of the request lifecycle. |
| `MERGE_REJECT_CATEGORIES`, `MergeRejectCategory` | `packages/shared/src/schemas/merge-request.ts` | Same file. Used by the request rejection enum, the attempt failure enum (same value-space), the SSE event payload schema, and the comment metadata schema. |
| `mergeRequestSchema`, `mergeAttemptSchema` | `packages/shared/src/schemas/merge-request.ts` | Full GET-response shapes. |
| `mergeRequestSubmitSchema`, `mergeRequestLandSchema`, `mergeRequestRejectSchema` | `packages/shared/src/schemas/merge-request.ts` | Request-body shapes for the corresponding REST endpoints. |
| `mergeAttemptStartSchema`, `mergeAttemptCompleteSchema` | `packages/shared/src/schemas/merge-request.ts` | Integrator-facing request bodies. |
| Re-export | `packages/shared/src/schemas/index.ts` | `export * from "./merge-request.js";` |
| `"landed_sha"` (new value) | Appended to `GIT_REF_TYPES` in `packages/shared/src/constants/enums.ts` | The existing enum is `["branch", "commit", "pull_request"]`. After this phase: `["branch", "commit", "pull_request", "landed_sha"]`. |
| `"merge_rejection"` (new value) | Appended to `COMMENT_TYPES` in `packages/shared/src/constants/enums.ts` | The existing enum is `["comment", "progress_update", "decision", "question", "handoff", "review_note", "design_discussion"]`. After this phase: `[..., "merge_rejection"]`. |

The reject-category single-source-of-truth is the explicit invariant from the roadmap (Step 3, lines 110–114). Schema validation, DB column, event payload, and comment metadata all import the same array.

---

## 4. Data model

Two new tables, both following the existing convention: ULID primary keys, ISO 8601 timestamps as TEXT, JSON arrays serialized as TEXT, and indexes on every column appearing in a query filter.

### 4.1 `merge_requests`

| Column | Type | Null | FK / default | Notes |
|---|---|---|---|---|
| `id` | TEXT | NO | PK (ULID) | Generated by `createId()`. |
| `projectId` | TEXT | NO | FK → `projects.id` | The lane scope. |
| `resource` | TEXT | NO | default `"main"` | Matches `merge_locks.resource`. The named lane within the project. |
| `submittedBy` | TEXT | NO | FK → `users.id` | The worker user who called `submit`. |
| `taskId` | TEXT | YES | FK → `tasks.id` **ON DELETE SET NULL** | Required for the land/reject auto side-effects. Nullable so a request whose task is deleted mid-flight still resolves cleanly (see Section 12). |
| `branch` | TEXT | YES | — | Worker-declared branch to integrate. At least one of `branch` or `commitSha` should be set in practice but the schema doesn't enforce it (Stage 1 doesn't either). |
| `commitSha` | TEXT | YES | — | Worker-declared commit. |
| `verifyCmd` | TEXT | YES | — | Per-request override of `projects.settings.integrator.verify_command`. The integrator uses this if set, else falls back to the project default. |
| `worktreePath` | TEXT | YES | — | Informational only — per-machine, recorded so observability tools can correlate to the worker's host. The integrator uses its own configured `worktreeRoot/worktreeName`. |
| `status` | TEXT | NO | default `"queued"` | One of `MERGE_REQUEST_STATUSES`. |
| `enqueuedAt` | TEXT | NO | ISO 8601 | Set on insert. The integrator's "next queued in this lane" query orders by this. |
| `pickedUpAt` | TEXT | YES | — | Set on `queued → integrating`. Cleared on `integrating → queued` (see Section 5.1, push-race recovery). |
| `resolvedAt` | TEXT | YES | — | Set on the first transition into any terminal state (`landed`, `rejected`, `abandoned`). Never cleared. |
| `landedSha` | TEXT | YES | — | Set on `landed`. The SHA of the commit now at the head of the lane's branch. |
| `rejectCategory` | TEXT | YES | — | One of `MERGE_REJECT_CATEGORIES`. Set on `rejected`. |
| `rejectReason` | TEXT | YES | — | Human-readable reason. Set on `rejected`. |
| `failedFiles` | TEXT | YES | JSON-encoded `string[]` | Files implicated in the failure (e.g. unresolved conflict files, failing test paths). |
| `logExcerpt` | TEXT | YES | — | First 4 KB of failed verify output. |
| `logUrl` | TEXT | YES | — | `file://` URI or operator-managed URL pointing at the full log. |
| `createdAt` | TEXT | NO | ISO 8601 | Standard. Same value as `enqueuedAt` for the initial insert. |
| `updatedAt` | TEXT | NO | ISO 8601 | Refreshed on any mutation. |

Indexes:

| Index | Columns | Purpose |
|---|---|---|
| `idx_merge_requests_project_status` | `(projectId, status)` | List by project + status filter. The MCP `pm_list_merge_requests` tool uses this. |
| `idx_merge_requests_resource_status` | `(projectId, resource, status, enqueuedAt)` | The integrator's hot-path query: "next queued in this lane, oldest first." |
| `idx_merge_requests_task` | `(taskId)` | Look up requests by linked task (UI surface in Phase 7.4; also useful for back-references). |

### 4.2 `merge_attempts`

| Column | Type | Null | FK / default | Notes |
|---|---|---|---|---|
| `id` | TEXT | NO | PK (ULID) | |
| `requestId` | TEXT | NO | FK → `merge_requests.id` | Parent request. |
| `attemptNumber` | INTEGER | NO | — | 1-based, monotonic per request. The unique index enforces this at the schema layer. |
| `baseSha` | TEXT | NO | — | The `main` SHA the integrator rebased onto. Recorded so push-race detection has a baseline. |
| `treeSha` | TEXT | YES | — | The post-rebase commit SHA that verify ran against. Null until the attempt completes successfully (passed). |
| `status` | TEXT | NO | — | One of `MERGE_ATTEMPT_STATUSES`. Initial value is `"pending"` on insert; the service flips it to `"running"` immediately. |
| `startedAt` | TEXT | YES | — | Set when status flips to `running`. |
| `completedAt` | TEXT | YES | — | Set when status flips to a terminal value (`passed`, `failed`, `cancelled`). |
| `verifyDurationMs` | INTEGER | YES | — | `completedAt - startedAt` in milliseconds. Convenience field; phase 7.5 will use it. |
| `failureCategory` | TEXT | YES | — | One of `MERGE_REJECT_CATEGORIES`. Set only when `status = "failed"`. |
| `failureReason` | TEXT | YES | — | Human-readable. |
| `failedFiles` | TEXT | YES | JSON-encoded `string[]` | |
| `logExcerpt` | TEXT | YES | — | First 4 KB of output. |
| `logUrl` | TEXT | YES | — | Pointer to the full log. |
| `createdAt` | TEXT | NO | ISO 8601 | |

Indexes:

| Index | Columns | Purpose |
|---|---|---|
| `idx_merge_attempts_request_num` | UNIQUE on `(requestId, attemptNumber)` | Enforces monotonic-per-request numbering at the schema level so a concurrent integrator (which shouldn't exist — parallelism=1 — but defense-in-depth) cannot insert a duplicate. Service-layer numbering uses `MAX(attemptNumber) + 1` within the same operation; the unique index is the backstop. |

### 4.3 ER additions

```
project          1──* merge_request                (existing project — many requests over time)
merge_request    1──* merge_attempt                (each rebase + verify cycle)
merge_request    *──1 task                         (taskId; nullable; ON DELETE SET NULL; gates auto side-effects)
merge_request    *──1 user                         (submittedBy; the worker)
merge_request    1── 0..1 git_ref                  (the `landed_sha` row, via taskId — only when landed and task present)
merge_request    1── 0..1 comment                  (the `merge_rejection` row, via taskId — only when rejected and task present)
```

The relationship to `git_refs` and `comments` is **transitive via the task**. The auto side-effect rows themselves carry the `mergeRequestId` in their `metadata` JSON so the back-link is queryable, but there is no foreign-key column on `git_refs` or `comments` pointing at `merge_requests`. This keeps the existing tables and their FTS triggers untouched.

---

## 5. State machines

### 5.1 Request state machine

```
                                    ┌──────────────┐
                                    │   (none)     │
                                    └──────┬───────┘
                                           │  submit()
                                           ▼
                                    ┌──────────────┐
                                    │   queued     │◄──────────────────┐
                                    └──────┬───────┘                   │
                                           │  transitionToIntegrating()│
                                           ▼                            │
                                    ┌──────────────┐                    │
                                    │ integrating  │───── resetToQueued
                                    └──┬────┬────┬─┘    (crash recover
                                       │    │    │      or push race)
                                land()│    │    │
                                       │    │    │ forceCancel() [admin]
                                       ▼    │    ▼
                                ┌──────────┐│┌──────────┐
                                │  landed  │││abandoned │ ◄── cancel()
                                └──────────┘│└──────────┘     [from queued only,
                                            │                  submitter or admin]
                                            │ reject()
                                            ▼
                                       ┌──────────┐
                                       │ rejected │
                                       └──────────┘
```

Terminal states: `landed`, `rejected`, `abandoned`. Once a request is in a terminal state, only the canonical idempotency rule applies (see Section 6) — no forward progress, no rollback.

**Transition table:**

| From | To | Actor | Trigger | Side effects |
|---|---|---|---|---|
| (none) | `queued` | submitter (worker) | `submit()` | Emit `merge.request.queued`. |
| `queued` | `integrating` | integrator | `transitionToIntegrating()` | Emit `merge.request.integrating`. Set `pickedUpAt`. |
| `integrating` | `landed` | integrator | `land(landedSha)` after verify pass + successful push | Emit `merge.request.landed`. Insert `git_refs` row (transactional with the status update — see Section 12). Set `resolvedAt`, `landedSha`. |
| `integrating` | `rejected` | integrator | `reject(category, …)` | Emit `merge.request.rejected`. Insert `merge_rejection` `comments` row (transactional). Set `resolvedAt`, `rejectCategory`, `rejectReason`, `failedFiles`, `logExcerpt`, `logUrl`. |
| `queued` | `abandoned` | submitter OR admin | `cancel()` | Emit `merge.request.abandoned`. Set `resolvedAt`. |
| `integrating` | `abandoned` | admin only | `forceCancel(reason)` | Emit `merge.request.abandoned`. Set `resolvedAt`. The integrator's next service call (likely `completeAttempt`, `land`, or `reject`) returns 409 INVALID_TRANSITION; it's the integrator's job to catch that and tidy up its local state (see Section 14.8 and Section 15 row "Admin force-cancel mid-verify"). |
| `integrating` | `queued` | integrator | `resetToQueued(reason)` — two trigger cases: **(a)** crash recovery on integrator restart, where a request is stranded in `integrating` with no live attempt running; **(b)** push race detected after a verify pass — `git push` returned non-fast-forward because `main` moved between fetch and push, so the verified tree is stale | Emit `merge.request.queued` again (re-emit; observers should expect this). Cancel any open `merge_attempts` for this request (status `pending` or `running` → `cancelled`). Clear `pickedUpAt`. |

The `integrating → queued` transition is the **only non-terminal back-edge** in the entire machine. It exists for the two operational realities (crash, push race) and is documented as such; no other code path may use it.

### 5.2 Attempt state machine

```
   ┌─────────┐  startAttempt()   ┌─────────┐ (set running    ┌─────────┐
   │ (none)  │ ─────────────────▶│ pending │  immediately    │ running │
   └─────────┘                   └─────────┘ ───────────────▶└────┬────┘
                                                                  │
                                                  completeAttempt│
                                                                  │
                          ┌───────────────────┬───────────────────┼───────────────────┐
                          │                   │                   │                   │
                          ▼                   ▼                   ▼                   ▼
                    ┌─────────┐         ┌─────────┐         ┌──────────┐         (no state — illegal,
                    │ passed  │         │ failed  │         │cancelled │          returns 409)
                    └─────────┘         └─────────┘         └──────────┘
```

Terminal states: `passed`, `failed`, `cancelled`. Once an attempt is terminal, no further transitions are allowed.

**One-shot ownership**: only the integrator that created the attempt (i.e., the actor whose `startAttempt` call inserted the row) can complete it. The service enforces this via `requireIntegrator` + the implicit invariant that for a given `(project, resource)` there is exactly one integrator process at parallelism=1, so the only way a non-creating integrator could call `completeAttempt` is across a process restart — at which point the design says the new process discovers stranded attempts in `running` state and cancels them on its own (Section 14.8).

**Attempt failure ≠ request rejection.** This is a deliberate decoupling. `completeAttempt(status="failed", …)` records the attempt outcome and emits `merge.attempt.completed`, but it does NOT change `merge_requests.status`. The integrator then decides — based on attempt outcome — whether to call `reject()` (giving up on the request), `resetToQueued()` (push-race retry), or, in some future phase, retry with a fresh attempt. Month 1 always goes "completeAttempt → reject" on a failed attempt; the decoupling is forward-compatible for the smart-verify retry policies of Phase 7.5.

---

## 6. Decision matrix

This table is the **single specification** of state-machine guards and idempotency. The state-machine helpers in `merge-request.service.ts` (Step 4) and the attempt+terminal calls in `merge-attempt.service.ts` (Step 5) must mirror it cell-for-cell. The HTTP layer (Step 6) propagates the resulting status code unchanged.

Operations: `submit`, `cancel`, `forceCancel`, `transitionToIntegrating`, `resetToQueued`, `startAttempt`, `completeAttempt`, `land`, `reject`.

Actors: `submitter` (the worker who submitted the request), `admin` (a human admin), `integrator` (an `ai_agent` user — see Section 11), `other-worker` (any other authenticated user not in the above categories).

The cells below cover every (current state × operation × actor) tuple that the API can encounter.

| State | Operation | Actor | Outcome |
|---|---|---|---|
| (none) | `submit` | submitter | **201**: new row at `queued`; emit `merge.request.queued`. |
| `queued` | `cancel` | submitter | **200**: `abandoned`; emit `merge.request.abandoned`. |
| `queued` | `cancel` | admin | **200**: `abandoned`; emit `merge.request.abandoned`. (Admin is a permitted cancel-actor even when not the submitter.) |
| `queued` | `cancel` | other-worker | **403 NOT_REQUEST_OWNER**: only the submitter or an admin may cancel. |
| `queued` | `forceCancel` | admin | **200**: `abandoned`; emit `merge.request.abandoned`. (`forceCancel` and `cancel` produce the same terminal state from `queued`; the distinction matters in `integrating`.) |
| `queued` | `forceCancel` | non-admin | **403** (admin only). |
| `queued` | `transitionToIntegrating` | integrator | **200**: `integrating`; set `pickedUpAt`; emit `merge.request.integrating`. |
| `queued` | `transitionToIntegrating` | non-integrator | **403** (integrator only). |
| `queued` | `resetToQueued` | any | **409 INVALID_TRANSITION** (already queued). |
| `queued` | `startAttempt` | integrator | **409 INVALID_TRANSITION**: request must be `integrating` first. |
| `queued` | `completeAttempt` | integrator | **404** (no attempt exists), or **409** if an attempt id from a prior cancelled cycle is passed — depends on whether the attempt row exists. Either way: no transition. |
| `queued` | `land` | integrator | **409 INVALID_TRANSITION**: no attempt was started. |
| `queued` | `reject` | integrator | **409 INVALID_TRANSITION**. |
| `integrating` | `submit` | n/a | (No-op — submit creates new rows, doesn't transition existing ones.) |
| `integrating` | `cancel` | any authenticated user | **200**: `abandoned`; emit `merge.request.abandoned`. Self-service (collaborative env — no ownership gate). The abandon + a `cancel` audit row (action `cancel`, NO `overridden` flag — that distinguishes it from the admin `force_cancel`) commit in ONE transaction; the integrator discovers the abandon on its next `completeAttempt`/`land`/`reject` (which 409s) — see Section 15. (`cancel` and `forceCancel` now both reach `abandoned` from `integrating`; `forceCancel` remains the admin break-glass that additionally tags the audit row `overridden`.) |
| `integrating` (grouped member) | `cancel` | any authenticated user | **409 GROUPED_MEMBER**: a cross-repo group member is never cancellable individually (it would corrupt the group atom) — reject the group instead. Mirrors the symmetric land-side guard. |
| `integrating` | `forceCancel` | admin | **200**: `abandoned`; emit `merge.request.abandoned`. The integrator will discover this on its next service call (`completeAttempt`, `land`, or `reject`) and treat the resulting 409 as "request was force-cancelled" — see Section 15. |
| `integrating` | `forceCancel` | non-admin | **403** (admin only). |
| `integrating` | `transitionToIntegrating` | integrator | **409 INVALID_TRANSITION** (already integrating). |
| `integrating` | `resetToQueued` | integrator | **200**: `queued`; cancel any open attempts; clear `pickedUpAt`; emit `merge.request.queued`. |
| `integrating` | `resetToQueued` | non-integrator | **403** (integrator only). |
| `integrating` | `startAttempt` | integrator | **201**: new attempt at `running`; emit `merge.attempt.started`. The service does not bound attempt count for Month 1 — push-race retry could theoretically loop, but Section 14.7 limits this to a single retry per loop iteration. |
| `integrating` | `completeAttempt` | integrator | **200**: attempt transitions to `passed`, `failed`, or `cancelled`; emit `merge.attempt.completed`. Request status unchanged. |
| `integrating` | `land` | integrator | **200**: `landed`; transactionally insert `git_refs` (if `taskId !== null`); emit `merge.request.landed`. |
| `integrating` | `reject` | integrator | **200**: `rejected`; transactionally insert `merge_rejection` comment (if `taskId !== null`); emit `merge.request.rejected`. |
| `landed` | `cancel`, `forceCancel` | any | **409 INVALID_TRANSITION** (terminal). |
| `landed` | `land` | integrator | **200 idempotent**: returns the existing row. (Idempotency rule.) |
| `landed` | `reject` | integrator | **409 INVALID_TRANSITION** (cross-terminal). |
| `landed` | `transitionToIntegrating`, `resetToQueued`, `startAttempt`, `completeAttempt` | any | **409** (terminal). |
| `rejected` | `cancel`, `forceCancel` | any | **409** (terminal). |
| `rejected` | `reject` | integrator | **200 idempotent**: returns the existing row. |
| `rejected` | `land` | integrator | **409 INVALID_TRANSITION** (cross-terminal). |
| `rejected` | other ops | any | **409** (terminal). |
| `abandoned` | `cancel` | any authenticated user | **200 idempotent**: returns the existing row. |
| `abandoned` | `forceCancel` | admin | **200 idempotent**: returns the existing row. |
| `abandoned` | `land`, `reject` | integrator | **409 INVALID_TRANSITION** (cross-terminal). |
| `abandoned` | other ops | any | **409** (terminal). |

### 6.1 The canonical idempotency rule

> *Calling a terminal-producing operation on a row already in its target terminal state returns 200 with the existing row. Any other terminal-to-terminal or wrong-direction call returns 409 INVALID_TRANSITION.*

Concretely: `land` on `landed` → 200; `reject` on `rejected` → 200; `cancel` on `abandoned` (any authenticated user) → 200; `forceCancel` on `abandoned` (by admin) → 200. Everything else from a terminal state is 409.

This rule is small, consistent, and lets the integrator's loop tolerate any single-step retry (e.g. an HTTP retry after a transient network error) without contorting itself into "was that already done?" preflight checks.

---

## 7. Stage 1 / Stage 2 coexistence and dual emission

Stage 1 (the `merge_locks` table and `merge-lock.service.ts`) ships unchanged. Stage 2 (this phase) layers requests on top. They are intentionally separate state machines and they communicate only through (a) the integrator's deliberate use of both APIs and (b) the dual SSE emission described below.

### 7.1 Lock lifetime vs request lifetime

| | Lock (Stage 1) | Request (Stage 2) |
|---|---|---|
| When does the row exist? | One row per `(projectId, resource)`, created lazily on first contact. Always exists once created. | One row per submission. Persists from `enqueuedAt` until terminal; never deleted. |
| Lifetime semantics | Acquired and released repeatedly across many distinct landings. Holds `landedSha` from the most recent successful release. | Lifecycle is the request's own: queued → integrating → terminal. |
| Held by | At most one user at a time, with a FIFO queue. | N/A — the request is not "held"; the integrator either has picked it up (`integrating`) or hasn't. |
| TTL | `LEASE_TTL_MS = 5 * 60 * 1000` (5 min). Self-heals on expiry via `sweepExpired`. | None. A stuck `integrating` request is recovered by the integrator restart loop (Section 14.8). |

### 7.2 Integrator's use of Stage 1

The integrator continues to acquire the Stage 1 lock during active integration of a request. This is the atomic gate that prevents two integrator processes from claiming the same request (defense-in-depth — Month 1 says exactly one integrator per `(project, resource)`, but the lock makes that constraint enforceable instead of policy-only).

The integrator's per-request flow against Stage 1:

1. `acquire(intent)` on pickup. `intent` is the landing intent derived from the request (`taskId`, `branch`, `commitSha`, `verifyCmd`, `worktreePath`).
2. `heartbeat()` every minute during verify. Refreshes the lease; if the integrator crashes, the lease expires within `LEASE_TTL_MS` and Stage 1's `sweepExpired` cleans up.
3. `release(landedSha)` on successful land — the existing Stage 1 "main moved" signal.
4. `release(reason)` on reject — the existing Stage 1 "main did not move because X" signal.

No changes to Stage 1's API. The integrator passes the request's intent through unchanged.

### 7.3 Dual emission contract

Both Stage 1 and Stage 2 emit events. Two distinct audiences consume them, by design. **Do not** attempt to dedupe between the two streams; they serve different purposes.

| Audience | Subscribes to | Why |
|---|---|---|
| Stage 1 backwards-compat consumers ("did main move?") | `merge.lock.released` | This is the historical Stage 1 signal. The existing dashboards, alerting, and any worker code that still self-integrates rely on it. Stage 2 must not break this. |
| Request-lifecycle consumers (the submitting worker watching its own request; the Phase 7.4 dashboard) | `merge.request.landed` / `merge.request.rejected` | These payloads are richer — they include `mergeRequestId`, `attemptId`, the structured rejection envelope, the `gitRefId` of the auto-attached `landed_sha`, and the `commentId` of the auto-posted `merge_rejection`. A worker submitting a request and walking away should listen for these, not for `merge.lock.released`. |

**Emission order on a successful land:**

```
1. land() service call:
     [TXN BEGIN]
       UPDATE merge_requests SET status='landed', resolvedAt=…, landedSha=…
       INSERT INTO git_refs (refType='landed_sha', refValue=landedSha, taskId=…, …)   -- if taskId !== null
     [TXN COMMIT]
     getEventBus().emit(MERGE_REQUEST_LANDED, payload)
       -- payload extra: { attemptId, gitRefId, landedSha, resource }

2. Integrator separately calls Stage 1 release:
     mergeLockService.release(projectId, resource, integrator, { landedSha })
       -- updates merge_locks; emits MERGE_LOCK_RELEASED with the landedSha extra
       -- promotes queue head if any (no queue expected in normal Stage 2 flow,
       -- since workers go through merge_requests, not the lock queue)
```

**Symmetrically for reject:**

```
1. reject() service call:
     [TXN BEGIN]
       UPDATE merge_requests SET status='rejected', resolvedAt=…, rejectCategory=…, rejectReason=…, failedFiles=…, logExcerpt=…, logUrl=…
       INSERT INTO comments (taskId=…, authorId=integratorUserId, commentType='merge_rejection', body=…, metadata=…)   -- if taskId !== null
     [TXN COMMIT]
     getEventBus().emit(MERGE_REQUEST_REJECTED, payload)
       -- payload extra: { attemptId, commentId, category, reason, failedFiles, logExcerpt, logUrl, baseSha }

2. Integrator separately calls Stage 1 release:
     mergeLockService.release(projectId, resource, integrator, { reason })
       -- updates merge_locks; emits MERGE_LOCK_RELEASED with the abandonReason extra
```

### 7.4 Crash-window between Stage 2 commit and Stage 1 release

If the integrator process crashes after the Stage 2 transaction commits but before it calls Stage 1's `release()`:

- The Stage 1 lock remains held. Its lease expires within `LEASE_TTL_MS` (5 min) and `sweepExpired` releases it automatically.
- The Stage 1 lock's `landedSha` field is **not** updated to reflect the just-landed SHA, because `release()` never ran. Observers that consume `merge.lock.released` to learn "main moved at SHA X" will miss this event during the crash window.
- The Stage 2 event `merge.request.landed` has already fired with the `landedSha` in its payload. Observers that subscribe to Stage 2 events are unaffected.

This is a known observability gap, not a correctness break: `main` has objectively moved (the push succeeded), the canonical record of "what landed" is the `merge_requests` row with `status='landed'` and `landedSha=…`, and the `git_refs` row on the linked task is the durable artifact. We accept it because (a) the gap is bounded by `LEASE_TTL_MS`, (b) Stage 2 consumers are the recommended new path, and (c) closing it requires either ditching Stage 1 entirely or making Stage 1's `landedSha` field eventually-consistent with main itself, both of which are out of scope.

---

## 8. REST API surface

All endpoints mount under `/api/v1/`. The router lives in `packages/server/src/routes/merge-requests.ts` and is wired into `packages/server/src/app.ts` next to `createMergeLockRoutes()`. Naming and shape follow the existing OpenAPIHono patterns in `routes/merge-locks.ts` and `routes/proposals.ts`.

| Method | Path | Body | Response | Actor (see Section 11) |
|---|---|---|---|---|
| POST | `/api/v1/projects/{projectId}/merge-requests` | `mergeRequestSubmitSchema` — `{ resource?, taskId?, branch?, commitSha?, verifyCmd?, worktreePath? }` | `201 { data: mergeRequestSchema }` | `requireAuth` (any authenticated user — this is a worker action). |
| GET | `/api/v1/projects/{projectId}/merge-requests` | query: `resource?`, `status?`, `taskId?`, `page?`, `perPage?` | `200 { data: mergeRequestSchema[], pagination: { total, page, perPage } }` | `requireAuth`. |
| GET | `/api/v1/merge-requests/{id}` | — | `200 { data: mergeRequestSchema & { attempts: mergeAttemptSchema[] } }` (attempts most-recent-first) | `requireAuth`. |
| POST | `/api/v1/merge-requests/{id}/cancel` | — | `200 { data: mergeRequestSchema }` | `requireAuth && (requireSubmitter || requireAdmin)`. |
| POST | `/api/v1/merge-requests/{id}/pickup` | — | `200 { data: mergeRequestSchema }` | requireAuth && requireIntegrator |
| POST | `/api/v1/merge-requests/{id}/force-cancel` | `{ reason: string }` | `200 { data: mergeRequestSchema }` | `requireAuth && requireAdmin`. |
| POST | `/api/v1/merge-requests/{id}/reset-to-queued` | `{ reason: string }` (1–500 chars) | `200 { data: mergeRequestSchema }` | requireAuth && requireIntegrator |
| POST | `/api/v1/merge-requests/{id}/attempts` | `mergeAttemptStartSchema` — `{ baseSha: string }` | `201 { data: mergeAttemptSchema }` | `requireAuth && requireIntegrator`. |
| PATCH | `/api/v1/merge-attempts/{id}` | `mergeAttemptCompleteSchema` — `{ status: "passed" \| "failed" \| "cancelled", treeSha?, failureCategory?, failureReason?, failedFiles?, logExcerpt?, logUrl? }` | `200 { data: mergeAttemptSchema }` | `requireAuth && requireIntegrator`. |
| POST | `/api/v1/merge-requests/{id}/land` | `mergeRequestLandSchema` — `{ landedSha: string }` | `200 { data: mergeRequestSchema }` | `requireAuth && requireIntegrator`. |
| POST | `/api/v1/merge-requests/{id}/reject` | `mergeRequestRejectSchema` — `{ category: MergeRejectCategory, reason: string, failedFiles?: string[], logExcerpt?: string, logUrl?: string }` | `200 { data: mergeRequestSchema }` | `requireAuth && requireIntegrator`. |

Response envelopes use `{ data }` on success and `{ error: { code, message } }` on failure, per the existing convention (`high-level-design.md` Section 5). New error codes added by this phase:

| Code | HTTP | Used when |
|---|---|---|
| `INVALID_TRANSITION` | 409 | The current state does not allow the requested operation (e.g. `land` on `queued`, `cancel` on `landed`). See the decision matrix (Section 6) for the full list. |
| `NOT_REQUEST_OWNER` | 403 | `cancel` called by an authenticated user who is neither the submitter nor an admin. |

Existing error codes used by these routes without modification: `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403).

**Idempotency** is per Section 6.1 — a terminal-producing operation on a row already in its target terminal state returns 200 with the existing row, not 409. The route handlers do not implement separate idempotency logic; they delegate to the service layer, which encodes Section 6.

**Path placement note**: read/cancel/pickup/force-cancel/reset-to-queued/attempts/land/reject endpoints all use the top-level `/api/v1/merge-requests/{id}/…` shape (no project prefix). Only the submit and list endpoints are project-scoped. This mirrors how `proposals` routes are structured — list/create under `/projects/{projectId}/…` and per-entity ops under `/proposals/{id}/…`. The `/merge-attempts/{id}` endpoint follows the same pattern: attempts are global once created.

**`pickup` and `reset-to-queued` are dedicated `requireIntegrator` endpoints** (both shipped — see Section 11):

- `POST /merge-requests/{id}/pickup` drives `queued → integrating` (the handler calls `transitionToIntegrating`). It returns 409 from any non-queued state — there is no idempotent re-pickup.
- `POST /merge-requests/{id}/reset-to-queued` drives `integrating → queued` for the two operational realities: crash recovery (a stranded `integrating` request reclaimed on integrator restart) and post-verify push-race retry (main moved between fetch and push). It cancels any open attempts on the request and returns 409 if the request is not `integrating`.

The integrator calls **`pickup` and then `startAttempt`** as two separate service calls; it does NOT rely on `startAttempt` to implicitly transition the request out of `queued`.

---

## 9. SSE events

Add the following entries to `EVENT_NAMES` in `packages/server/src/events/event-bus.ts`:

```ts
// Merge request events
MERGE_REQUEST_QUEUED:       "merge.request.queued",
MERGE_REQUEST_INTEGRATING:  "merge.request.integrating",
MERGE_REQUEST_LANDED:       "merge.request.landed",
MERGE_REQUEST_REJECTED:     "merge.request.rejected",
MERGE_REQUEST_ABANDONED:    "merge.request.abandoned",
// Merge attempt events
MERGE_ATTEMPT_STARTED:      "merge.attempt.started",
MERGE_ATTEMPT_COMPLETED:    "merge.attempt.completed",
```

All seven events use the existing `EventPayload` interface:

```ts
{
  entity: <the mergeRequest or mergeAttempt row, post-mutation>,
  entityType: "merge_request" | "merge_attempt",
  entityId: <the row's id>,
  projectId: <the projectId>,
  actorId: <user id who triggered the transition; null for system-driven events>,
  timestamp: <ISO 8601>,
  // ... plus event-specific extras spread onto `entity` per the dual-emission contract,
  //     mirroring how merge_locks does this in `merge-lock.service.ts:238`.
}
```

The Stage 1 pattern is to set `entity: { ...lockRow, ...extra }`. Phase 7.1 follows the same pattern **on the in-process `EventPayload`**: the `entity` field of the emitted payload contains the merge_request (or merge_attempt) row spread with the event-specific extras below.

**These extras live on the in-process payload consumed by server-side listeners** (the activity-log listener, etc.). They do **not** appear on the SSE wire frame: `routes/events.ts` projects the payload down to the flattened shape in §9.2 before writing it to clients. SSE clients that need an extra (e.g. `attemptId`, `gitRefId`, the rejection envelope) fetch it via `GET /api/v1/merge-requests/{id}` after seeing the frame.

### 9.1 Per-event extras (in-process payload only)

The table below describes the extras spread onto `EventPayload.entity` for **server-side listeners**. They are not carried on the SSE wire frame (see §9.2).

| Event | Extra payload fields (spread onto `entity`) |
|---|---|
| `merge.request.queued` | (none — base row only) |
| `merge.request.integrating` | `attemptId` (the just-started attempt, since `transitionToIntegrating` and `startAttempt` happen as a unit in the integrator loop — though they are separate service calls). |
| `merge.request.landed` | `attemptId` (the attempt that passed), `gitRefId` (the inserted `landed_sha` git_refs row id, or `null` if `taskId` was null). |
| `merge.request.rejected` | `attemptId` (the attempt that failed), `commentId` (the inserted `merge_rejection` comments row id, or `null` if `taskId` was null), `category`, `reason`, `failedFiles`, `logExcerpt`, `logUrl`. |
| `merge.request.abandoned` | `cancelledBy` (the user id who triggered the cancel — submitter or admin), `reason` (for force-cancel, the admin's reason; null for submitter cancel). |
| `merge.attempt.started` | `requestId`, `baseSha`. |
| `merge.attempt.completed` | `requestId`, the attempt's terminal `status`, `treeSha` (if passed), `failureCategory` and `failureReason` (if failed). |

### 9.2 Example SSE frame

The wire frame emitted to SSE clients is **flattened** — it is a projection of the in-process `EventPayload`, not the payload itself, and it does not carry the full row:

```
event: merge.request.rejected
data: {
  "entity_type": "merge_request",
  "entity_id": "01JE7KQXZJ9P3M4ABCDEF0X1Y2",
  "action": "request.rejected",
  "actor": {
    "id": "01JE7KQ0000000000000INTEGR01",
    "name": "game_one-integrator",
    "type": "ai_agent"
  },
  "timestamp": "2026-05-29T14:24:48.902Z"
}
```

The fields of the wire frame, as built by `routes/events.ts`:

- `entity_type` — the payload's `entityType`.
- `entity_id` — the payload's `entityId`.
- `action` — the event name with its first segment removed: `event.split(".").slice(1).join(".")`. So `merge.request.rejected` becomes `request.rejected`.
- `actor` — resolved from `actorId` via `userService.getById` to `{ id, name, type }`. When `actorId` is null or the user can't be found, it falls back to `{ id: null, name: "system", type: "system" }`.
- `timestamp` — the payload's `timestamp`.
- `changes?` and `entity_title?` — present only when the payload carries them; otherwise omitted. The wire frame does NOT carry the full entity row or per-event extras.

Clients that need full detail (the rejection envelope, attempt ids, etc.) fetch it via `GET /api/v1/merge-requests/{id}` after seeing the frame.

---

## 10. MCP tools

Four worker-facing and observer-facing tools live in `packages/mcp-server/src/tools/merge-requests.ts`. The integrator-facing endpoints (start/complete attempt, land, reject) are **HTTP only** — they are not exposed as MCP tools because no Claude agent ever calls them; the reference integrator package (Step 10) calls them directly via its HTTP client.

The Stage 1 merge-lock MCP tools (`pm_merge_lock_*`) stay in place unchanged. Update their tool descriptions to point at `pm_request_merge` as the recommended path (Stage 2) and keep the lock tools as low-level / advanced.

### 10.1 `pm_request_merge`

```
Arguments:
  project_id:     string         (required)
  resource:       string         (default "main")
  task_id:        string         (optional but strongly recommended — required for the auto side-effects)
  branch:         string         (optional)
  commit_sha:     string         (optional)
  verify_cmd:     string         (optional — overrides project default)
  worktree_path:  string         (optional — per-machine, informational)
Returns:
  - request id
  - status: "queued"
  - queue position summary (computed from list({ resource, status: "queued" }))
```

Calls `POST /api/v1/projects/{project_id}/merge-requests` with the body shaped as `mergeRequestSubmitSchema`. After the request returns, the tool calls `list({ resource, status: "queued" })` to compute the position and renders both.

**Formatted output example:**

```
Merge request 01JE7KQXZJ9P3M4ABCDEF0X1Y2 queued.

  Project:  game_one
  Resource: main
  Task:     01JE7KQ0000000000000000TASK99 ("Add skinned mesh API")
  Branch:   feat/skinned-renderer-api
  Commit:   8f3c1d2e

  Queue position: 2 of 3
  Status:         queued — waiting for the integrator to pick this up.

Subscribe to SSE events for "merge.request.landed" / "merge.request.rejected"
with entityId 01JE7KQXZJ9P3M4ABCDEF0X1Y2 to learn the outcome.
```

### 10.2 `pm_list_merge_requests`

```
Arguments:
  project_id:  string                            (required)
  resource:    string                            (optional)
  status:      MergeRequestStatus | "all"       (optional, default "all")
  task_id:     string                            (optional)
Returns:
  - array of request summaries: { id, status, branch/commit, submitter name, queue position (for queued ones), short summary }
```

Calls `GET /api/v1/projects/{project_id}/merge-requests` with the appropriate query params. The tool joins on users to surface the submitter's display name (server-side via the existing `users` table — no new endpoint needed; the request's `submittedBy` is a user id and the server can populate the displayName in its response if the column is present in the GET response shape).

**Formatted output example:**

```
3 merge requests in game_one (main lane):

  1. 01JE7KQXZJ9P3M4ABCDEF0X1Y2   integrating
     feat/skinned-renderer-api @ 8f3c1d2e
     by agent7 (claude_implementer)  Picked up 14:21:05Z (3m in flight)

  2. 01JE7KQXZJ9P3M4ABCDEF0X1Y3   queued (position 1)
     feat/bootstrap-rediscovery @ 4a2b8c1
     by agent5 (claude_implementer)  Enqueued 14:23:11Z

  3. 01JE7KQXZJ9P3M4ABCDEF0X1Y4   queued (position 2)
     feat/audio-loop @ d7e9f2a
     by agent3 (claude_implementer)  Enqueued 14:24:50Z
```

### 10.3 `pm_get_merge_request`

```
Arguments:
  request_id: string  (required)
Returns:
  - full request detail with attempts history
  - for status="rejected", surface the structured rejection prominently:
    category, first line of reason, log URL, failed files (top 5)
```

Calls `GET /api/v1/merge-requests/{request_id}`. Renders the request, then renders attempts most-recent first. For a rejected request, the rejection envelope is at the top of the output (above the attempts) so the worker sees it without scrolling.

**Formatted output example (rejected case):**

```
Merge request 01JE7KQXZJ9P3M4ABCDEF0X1Y2  REJECTED

  Project:  game_one
  Resource: main
  Task:     01JE7KQ0000000000000000TASK99 ("Add skinned mesh API")
  Branch:   feat/skinned-renderer-api @ 8f3c1d2e
  Submitted by: agent7   2026-05-29T14:21:03Z
  Resolved at:  2026-05-29T14:24:48Z

  REJECTION (build_failed):
    cargo build --workspace failed: 3 errors in crates/renderer
    Failed files:
      - crates/renderer/src/skinned.rs
      - crates/renderer/src/lib.rs
    Log: file:///home/agent7/work/game_one-int/logs/01JE7KQXZJ9P3M4ATTEMPT01.log

  Attempts (1):
    #1  failed    base=2c8f1d9  duration=3m43s  build_failed
        "cargo build --workspace failed: 3 errors in crates/renderer"
```

**Formatted output example (landed case):**

```
Merge request 01JE7KQXZJ9P3M4ABCDEF0X1Y2  LANDED

  Project:  game_one
  Resource: main
  Task:     01JE7KQ0000000000000000TASK99 ("Add skinned mesh API")
  Branch:   feat/skinned-renderer-api @ 8f3c1d2e -> 9e4f7d3 (landed)
  Landed SHA: 9e4f7d3
  Submitted by: agent7   2026-05-29T14:21:03Z
  Resolved at:  2026-05-29T14:31:12Z

  Attempts (1):
    #1  passed    base=2c8f1d9  tree=9e4f7d3  duration=9m12s
```

### 10.4 `pm_cancel_merge_request`

```
Arguments:
  request_id: string  (required)
Returns:
  - the updated request row (now abandoned, or unchanged if it was already terminal)
```

Calls `POST /api/v1/merge-requests/{request_id}/cancel`. The submitter or an admin invokes this; the route's authz rule (Section 11) returns 403 otherwise.

**Formatted output example:**

```
Merge request 01JE7KQXZJ9P3M4ABCDEF0X1Y2 abandoned.

  Was: queued (position 2)
  Now: abandoned (resolved at 2026-05-29T14:22:50Z)

Use pm_list_merge_requests to see remaining queue.
```

---

## 11. Authz spec

Three helpers compose the authorization for the routes in Section 8. Each helper has a single responsibility and a clearly-bounded failure mode.

```ts
// 401 UNAUTHORIZED if not authenticated; otherwise returns the user.
function requireAuth(c: AppContext): AuthUser;

// 403 FORBIDDEN unless user.type === "ai_agent".
//
// MONTH-1 LIMITATION (accepted, not a bug):
//   Any user with type "ai_agent" can call integrator-only operations
//   (startAttempt, completeAttempt, land, reject, resetToQueued, transitionToIntegrating).
//   We do NOT have a per-project `train.integrator` role yet — that ships in
//   Phase 7.6 alongside the broader permissions model.
//
//   Practical risk is bounded because:
//     (a) game_one deploys exactly one integrator process per (project, resource).
//         Other ai_agent users are workers; they don't call these endpoints because
//         their MCP tooling only exposes `pm_request_merge` / `pm_cancel_merge_request`.
//     (b) `land()` does NOT push to git — only the integrator's own git_ops do.
//         A misbehaving ai_agent calling land(landedSha=X) would mark the request
//         landed in PM-DB without main moving — observable as a divergence between
//         the request's landedSha and the actual main HEAD.
//
//   Worst-case misuse: PM-DB inconsistency (status=landed but main never moved).
//   This is detectable (next merge request's integrator will see main at a SHA
//   different from the recorded landedSha and surface it as a rebase oddity).
//   We accept this tradeoff for Month 1.
function requireIntegrator(user: AuthUser): void;

// 403 FORBIDDEN unless user.id === request.submittedBy.
function requireSubmitter(user: AuthUser, request: MergeRequest): void;

// 403 FORBIDDEN unless user.role === "admin".
// Mirrors the existing `requireAdminRole` pattern in agent-pool.ts (line 463).
function requireAdmin(user: AuthUser): void;
```

### 11.1 Composition per route

| Route | Composition |
|---|---|
| `POST /projects/{projectId}/merge-requests` (submit) | `requireAuth` (any authenticated user). The `submittedBy` is auto-set to the current user. |
| `GET /projects/{projectId}/merge-requests` (list) | `requireAuth`. |
| `GET /merge-requests/{id}` (read) | `requireAuth`. |
| `POST /merge-requests/{id}/cancel` | `requireAuth`, then `requireSubmitter || requireAdmin`. The handler reads the request, checks ownership, and falls through to admin if not owner. |
| `POST /merge-requests/{id}/force-cancel` | `requireAuth && requireAdmin`. |
| `POST /merge-requests/{id}/attempts` | `requireAuth && requireIntegrator`. |
| `PATCH /merge-attempts/{id}` | `requireAuth && requireIntegrator`. |
| `POST /merge-requests/{id}/land` | `requireAuth && requireIntegrator`. |
| `POST /merge-requests/{id}/reject` | `requireAuth && requireIntegrator`. |

The `transitionToIntegrating` and `resetToQueued` operations each ship as a dedicated `requireIntegrator` endpoint: `POST /merge-requests/{id}/pickup` (drives `queued → integrating` via `transitionToIntegrating`) and `POST /merge-requests/{id}/reset-to-queued` (drives `integrating → queued` via `resetToQueued`). The integrator calls **`pickup` and then `attempts`** as two separate steps — it does NOT rely on `startAttempt` to implicitly perform the `queued → integrating` transition.

---

## 12. Auto side-effects and transactional integrity

> **Stage 2 commitment.** `land()` and `reject()` MUST wrap their multi-step writes in `db.transaction(() => { ... })`. Stage 1's `release()` does multi-row updates serially without a transaction (see `merge-lock.service.ts:528–598`). Stage 2 deliberately strengthens this because (a) the auto side-effects are atomic with the status update — there is no acceptable state where `merge_requests.status='landed'` exists without the corresponding `git_refs` row (when a task is linked), and (b) a process crash mid-call must not leave the request stuck between status update and side-effect insert.

### 12.1 Transaction scope

In scope (inside the transaction):

- Status field update on `merge_requests`: `status`, `resolvedAt`, plus the resolution-specific fields (`landedSha` on land; `rejectCategory`, `rejectReason`, `failedFiles`, `logExcerpt`, `logUrl` on reject).
- Side-effect insert: `git_refs` row on land (when `taskId !== null`), `comments` row on reject (when `taskId !== null`).

Out of scope (outside the transaction):

- **Event emission.** `getEventBus().emit(...)` runs after the transaction commits. Events are best-effort fire-and-forget; a duplicate event on retry is acceptable because SSE consumers handle their own dedup via `entityId + timestamp`. Holding the write transaction across event listeners risks SQLite deadlock if a listener does its own DB writes (the existing activity-log listeners do, for example).
- The Stage 1 `release()` call. The integrator calls Stage 1 `release()` separately, after `land()` or `reject()` returns. This call is intentionally outside the Stage 2 transaction — see Section 7.4 for the crash-window discussion.

### 12.2 On land

If `request.taskId !== null`:

1. **Pre-insert duplicate check.** Before inserting, `SELECT id FROM git_refs WHERE taskId = ? AND refType = 'landed_sha' AND refValue = ? LIMIT 1`. If a row exists, skip the insert and reuse that id. This handles the idempotency case where `land(landedSha=X)` is called twice (the second call returns 200 per Section 6.1; the side-effect row is created exactly once).
2. **Insert.** Otherwise insert:
    ```
    INSERT INTO git_refs (id, taskId, refType, refValue, url, title, status, metadata, createdAt) VALUES (
      <new ULID>,
      <request.taskId>,
      'landed_sha',
      <landedSha>,
      NULL,
      'Landed via merge request <requestId>',
      NULL,
      json_object('mergeRequestId', <requestId>, 'resource', <request.resource>),
      <now ISO>
    )
    ```
3. The transaction commits both the `merge_requests` update and the `git_refs` insert together.
4. Emit `MERGE_REQUEST_LANDED` with `gitRefId` set to either the newly-inserted id or the pre-existing one. Pass `null` if the request had no `taskId`.

Note: uniqueness of `(taskId, refType, refValue)` is enforced at the **service** level (pre-insert SELECT), not via a new schema-level unique index. This deliberately avoids touching the existing `git_refs` table, which already has its own indexes and is referenced by FTS triggers. The pre-insert SELECT is correct for Month 1 because parallelism=1 — only one integrator process per `(project, resource)` ever calls `land()`.

### 12.3 On reject

If `request.taskId !== null`:

1. **Insert** (no pre-check; comments are inherently append-only and a duplicate retry is fine — see below):
    ```
    INSERT INTO comments (id, taskId, proposalId, authorId, body, commentType, metadata, createdAt, updatedAt) VALUES (
      <new ULID>,
      <request.taskId>,
      NULL,
      <actor.id>,         -- the integrator user
      'Merge rejected: <category>.\n\n<reason>\n\n<failedFiles.length> failed file(s).\nSee log: <logUrl ?? "(none)">',
      'merge_rejection',
      json_object(
        'mergeRequestId', <requestId>,
        'attemptId',      <attemptId>,
        'category',       <category>,
        'reason',         <reason>,
        'failedFiles',    json(<failedFiles>),
        'logExcerpt',     <logExcerpt>,
        'logUrl',         <logUrl>,
        'baseSha',        <baseSha>
      ),
      <now ISO>,
      <now ISO>
    )
    ```
2. The transaction commits both the `merge_requests` update and the `comments` insert together.
3. **Idempotency handling.** A retry call to `reject()` on a row that's already `rejected` returns 200 per Section 6.1, and the service detects "already rejected, don't insert again" via the early-return before the transaction opens. So a duplicate comment is never inserted in practice.
4. Emit `MERGE_REQUEST_REJECTED` with `commentId` set to the newly-inserted id (or `null` if no insert happened because `taskId` was null).

The existing FTS5 triggers on `comments` (`comments_fts` virtual table) automatically index the `body` field of the new row. The rejection text becomes searchable via the existing `/api/v1/search` endpoint with no extra wiring.

### 12.4 The `taskId === null` rule

If `request.taskId` is null (because the worker didn't supply one, or because the task was deleted while the request was in flight — see Section 15):

- Side-effects are skipped silently. No `git_refs` row, no `comments` row.
- The structured rejection payload still appears on the SSE event (the consumer gets `commentId: null` but `category` / `reason` / `failedFiles` / `logExcerpt` / `logUrl` are all populated from the request row).
- The structured rejection payload is still recorded on the `merge_requests` row itself (`rejectCategory`, etc), so it's observable via `GET /merge-requests/{id}` and `pm_get_merge_request`.

The auto side-effects are a convenience layer that lights up when the worker linked a task. The system remains correct without them.

---

## 13. Per-project integrator config

The integrator config lives in `projects.settings.integrator`. The `projects.settings` column is already a JSON TEXT column — no migration is needed. The keys are **snake_case**, matching the existing convention for sibling blocks (`ai_autonomy`, `workflow`, `git`; see `packages/shared/src/schemas/project.ts:5–22` and `high-level-design.md:266–284`).

### 13.1 Schema

```ts
// In packages/shared/src/schemas/project.ts, alongside gitSettingsSchema:

export const integratorSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  verify_command: z.string().min(1).optional(),         // required when enabled
  verify_timeout_sec: z.number().int().min(1).default(600),
  worktree_root: z.string().min(1).optional(),          // required when enabled (absolute path)
  git_remote: z.string().min(1).default("origin"),
  git_main_branch: z.string().min(1).default("main"),
  worktree_name: z.string().min(1).optional(),          // defaults to `${project.slug}-integrator`
}).refine(
  (v) => !v.enabled || (Boolean(v.verify_command) && Boolean(v.worktree_root)),
  {
    message: "When integrator.enabled is true, verify_command and worktree_root are required and must be non-empty.",
    path: ["enabled"],
  },
);

export type IntegratorSettings = z.infer<typeof integratorSettingsSchema>;
```

The existing `projectSettingsSchema` gains an optional `integrator` property:

```ts
export const projectSettingsSchema = z
  .object({
    ai_autonomy: aiAutonomySettingsSchema,
    workflow: workflowSettingsSchema,
    git: gitSettingsSchema,
    integrator: integratorSettingsSchema.optional(),    // new
  })
  .nullable()
  .optional();
```

### 13.2 Field semantics

| Field | Type | Default | Required when `enabled` | Notes |
|---|---|---|---|---|
| `enabled` | boolean | `false` | always | Master switch. If false, the integrator process refuses to start for this project. |
| `verify_command` | string | (none) | yes | A shell command line. The integrator runs `child_process.spawn(verify_command, { shell: true, cwd: worktreePath })`. Per-request override is `merge_requests.verifyCmd`. |
| `verify_timeout_sec` | number | `600` | no (default applies) | Kill the verify process group after this many seconds. Recorded on the failed attempt as `verify_timeout`. |
| `worktree_root` | string | (none) | yes | Absolute path to the directory containing the integrator's isolated worktree. The actual worktree is `${worktree_root}/${worktree_name}`. Logs go in `${worktree_root}/logs/`. |
| `git_remote` | string | `"origin"` | no | The remote name to fetch from and push to. |
| `git_main_branch` | string | `"main"` | no | The branch name on the remote. The integrator's lane name (`resource`) maps to this branch. (Multi-lane support — different resources → different branches — comes in Phase 7.6.) |
| `worktree_name` | string | `${project.slug}-integrator` | no | Subdirectory name under `worktree_root`. Useful when one operator hosts multiple integrators on one machine. |

### 13.3 Validation surface

The `PATCH /projects/{id}` route runs the Zod schema. Invalid configs return 400 with field-level errors. Existing projects without an `integrator` block continue to work — `enabled: false` is the implicit default and the integrator process simply isn't deployed for them.

The integrator process, on startup, fetches the project settings via the API and re-validates locally; if `integrator.enabled !== true` it logs an error and exits cleanly. This makes the deployment story "wrong config = early, loud failure" instead of "wrong config = silent no-op."

---

## 14. Reference integrator architecture

What Steps 10–11 of the roadmap implement. Lives in `packages/integrator-ref/`.

### 14.1 Process model

One long-lived Node/TS process per `(project, resource)`. For game_one in Month 1 that's exactly one process: `(game_one, main)`. The operator deploys it via systemd, docker-compose, or `pnpm exec node packages/integrator-ref/dist/index.js --project <id> --resource main --pm-url <url> --token <env-var-name>`.

The process runs as a PM user with `type: "ai_agent"` and an API token. The user does not need any special role — `requireIntegrator` (Section 11) only checks `type === "ai_agent"`. For Month 1, any ai_agent token works; Phase 7.6 narrows this with a `train.integrator` role.

### 14.2 CLI and config loading

CLI signature:

```
pm-integrator --project <projectId> --resource <name> --pm-url <url> --token <env-var-name>
              [--log-level info|debug] [--poll-interval-sec 30]
```

`--token <env-var-name>` reads the actual token from `process.env[<env-var-name>]`. Never accept the token as a CLI argument directly — it would leak to `ps`.

Startup sequence:

1. Parse CLI args and read the token from the named env var.
2. `GET /api/v1/projects/{projectId}` via the HTTP client.
3. Validate `settings.integrator` via the Zod schema from Section 13.
4. If `integrator.enabled !== true` or required fields are missing or invalid, log a fatal error and exit with code 2. (Code 1 is reserved for unexpected runtime errors so systemd can restart-on-1 without restart-on-2.)
5. Initialize the worktree (Section 14.4).
6. Open the SSE stream (Section 14.3).
7. Enter the integration loop (Section 14.7).

### 14.3 SSE + polling fallback

Subscribe to `/api/v1/events?project_id=<projectId>`. Listen for:

- `merge.request.queued` matching the configured `resource` — primary trigger.
- `merge.request.abandoned` matching a request the integrator is currently working on — secondary trigger (admin force-cancelled while integrator was mid-verify; integrator should bail out gracefully).

**Belt-and-suspenders polling.** SSE is best-effort (the server might restart; the client's TCP might drop without `onerror` firing in time; events might be missed across reconnect). The integrator also polls `GET /api/v1/projects/{projectId}/merge-requests?status=queued&resource=<resource>` every `poll-interval-sec` seconds (default 30). The poll is the **correctness floor**; SSE is the latency optimization.

When the SSE stream drops, the integrator logs the disconnect, attempts immediate reconnect with exponential backoff (1s, 2s, 5s, 10s, 30s capped), and continues polling in the meantime. There is no "SSE healthy" precondition — the loop runs purely off DB-truth via the poll, with SSE as a hint to poll sooner.

### 14.4 Isolated worktree management

Worktree path: `${worktree_root}/${worktree_name}`.

**First-use creation.** If the path doesn't exist, the integrator runs `git clone <repo_url> <worktree_path>` (where `repo_url` comes from `projects.gitRepoUrl`). It then sets the remote: `git -C <worktree_path> remote set-url <git_remote> <repo_url>`.

**Between attempts.** Before each new request, the integrator runs (in `worktree_path`):

```
git reset --hard
git clean -fdx
git fetch <git_remote>
git checkout <git_main_branch>
git reset --hard <git_remote>/<git_main_branch>
```

This guarantees a clean state regardless of how the last attempt left things (rebase aborted, verify killed mid-build, etc.).

**Corruption recovery.** If any of the reset/clean/fetch commands fail with a non-recoverable error (e.g., `.git` directory corrupted), the integrator logs the corruption, deletes the worktree directory, and re-runs first-use creation. The current request being processed is `resetToQueued`'d before the recovery starts.

### 14.5 Verify-command execution

```
const child = child_process.spawn(verify_command, {
  shell: true,
  cwd: worktree_path,
  env: { ...process.env, /* project-specific env if config grows later */ },
});
```

Capture `stdout` + `stderr` to a file at `${worktree_root}/logs/${attempt_id}.log`. Apply the `verify_timeout_sec` deadline: at deadline, send SIGTERM to the process group; after a grace period (e.g. 5s), SIGKILL. Record the wall-clock duration as `verifyDurationMs`.

Exit code semantics:
- `0` → verify passed.
- Any non-zero → verify failed.
- Process killed by our timeout → exit code 124 (matches GNU `timeout` convention) OR a SIGTERM signal value (-15 on `child.signalCode`); either way the integrator categorizes the failure as `verify_timeout`.

### 14.6 Failure categorization heuristic

Month 1 is best-effort — the load-bearing piece is the `logUrl`, which surfaces the raw verify output to the worker. The category is a hint, not a contract.

| Heuristic | Signal | Resulting category |
|---|---|---|
| Process was killed by our timeout | exit code 124 OR `signalCode === "SIGTERM"` from our kill | `verify_timeout` |
| stderr contains `"error[E"` or `"error:"` near `"could not compile"` | rustc/cargo build failure | `build_failed` |
| stderr contains `"FAILED (failures="` or pytest's `"= FAILURES ="` | pytest test failure | `test_failed` |
| stdout/stderr contains `"test result: FAILED"` or `"FAIL "` line markers | cargo test / generic test runner | `test_failed` |
| Output matches clippy/eslint/prettier failure patterns (e.g. `"warning:"` + non-zero exit on a lint-strict project) | linter failure | `lint_failed` |
| Rebase failed before verify ran: `git rebase` non-zero AND `git diff --name-only --diff-filter=U` returned files | rebase conflict | `conflict` |
| Push failed with non-fast-forward (push race) | `git push` exit non-zero AND stderr mentions `"non-fast-forward"` or `"fetch first"` | `conflict` with subcategory note in `failureReason` (e.g. `"push race: main moved between fetch and push"`) |
| Otherwise | non-zero exit code, no recognized pattern | `other` |

The patterns are codified in `packages/integrator-ref/src/categorize.ts` as a small functional module that takes `(exitCode, signalCode, stdout, stderr) => MergeRejectCategory`. Tests cover the matrix above. Future phases (7.5 in particular) will extend this with project-configurable patterns.

### 14.7 Integration loop

The main loop pseudocode. Concrete TS lives in `packages/integrator-ref/src/integrator.ts` (Step 11).

```
forever:
  request = next_queued_request(project_id, resource)   // poll or SSE-driven
  if !request:
    wait_for_sse_event_or_poll_tick()
    continue

  // Acquire Stage 1 lock — atomic gate against duplicate integrator processes.
  // For Month 1 this is essentially a no-op (parallelism=1), but it's
  // architecturally correct.
  acquire_lock(project_id, resource, integrator_user, {
    taskId:     request.taskId,
    branch:     request.branch,
    commitSha:  request.commitSha,
    verifyCmd:  request.verifyCmd ?? project.integrator.verify_command,
    worktreePath: worktree_path,
  })

  // Transition the request to integrating + start the first attempt.
  // The service combines these so that a successful startAttempt implies
  // a successful queued→integrating transition.
  attempt = start_attempt(request.id, { baseSha: current_main() })

  // Reset the worktree to a clean main.
  worktree.reset()

  // Rebase the request's branch (or commit) onto baseSha.
  rebase = worktree.rebase(request.branch ?? request.commitSha, onto = attempt.baseSha)
  if rebase.conflict:
    complete_attempt(attempt.id, {
      status: "failed",
      failureCategory: "conflict",
      failureReason: "rebase conflict",
      failedFiles: rebase.conflicting_files,
      logExcerpt: rebase.log.slice(0, 4096),
      logUrl: log_url(attempt.id),
    })
    reject_request(request.id, {
      category: "conflict",
      reason: "rebase conflict on " + rebase.conflicting_files.join(", "),
      failedFiles: rebase.conflicting_files,
      logExcerpt: rebase.log.slice(0, 4096),
      logUrl: log_url(attempt.id),
    })
    release_lock(reason = "rebase conflict")
    continue

  // Run verify against the rebased tree.
  verify = run_verify(
    cmd = request.verifyCmd ?? project.integrator.verify_command,
    timeout_sec = project.integrator.verify_timeout_sec,
    cwd = worktree_path,
    log_path = log_url_to_path(attempt.id),
  )

  if verify.failed:
    category = categorize(verify.exit_code, verify.signal, verify.stdout, verify.stderr)
    complete_attempt(attempt.id, {
      status: "failed",
      failureCategory: category,
      failureReason: verify.summary_line(),
      failedFiles: parse_failed_files(category, verify.output),
      logExcerpt: verify.output.slice(0, 4096),
      logUrl: log_url(attempt.id),
    })
    reject_request(request.id, {
      category, reason: verify.summary_line(),
      failedFiles: parse_failed_files(category, verify.output),
      logExcerpt: verify.output.slice(0, 4096),
      logUrl: log_url(attempt.id),
    })
    release_lock(reason = verify.summary_line())
    continue

  // Verify passed. Push the tree to the remote.
  push = worktree.push(git_remote, git_main_branch, fast_forward_only = true)
  if push.non_fast_forward:
    // Push race: main moved between fetch and push. Cancel this attempt
    // and re-queue the request; the next loop iteration will rebase onto
    // the new main and verify again.
    complete_attempt(attempt.id, { status: "cancelled" })
    reset_to_queued(request.id, reason = "push race; main moved during verify")
    release_lock(reason = "push race")
    continue

  // Successful land.
  complete_attempt(attempt.id, { status: "passed", treeSha: push.sha })
  land_request(request.id, { landedSha: push.sha })
  release_lock(landedSha = push.sha)
```

Heartbeat: while the verify step is running, a separate timer calls `mergeLockService.heartbeat` every 60 seconds. The timer is cleared when verify completes (success or failure or timeout).

### 14.8 Crash recovery

On integrator startup, before entering the main loop:

```
stranded = GET /merge-requests?projectId=<p>&resource=<r>&status=integrating
for req in stranded:
  // No live attempt should be running — this process just started.
  // Any open attempts in pending/running status are orphans.
  reset_to_queued(req.id, reason = "integrator restart; reclaiming stranded request")
  // reset_to_queued internally cancels any open attempts.
```

This is idempotent: a request that was just marked `abandoned` by an admin while the integrator was restarting will return 409 INVALID_TRANSITION from `reset_to_queued`, which the integrator catches and skips (it's already in a terminal state — no recovery action needed).

The Stage 1 lock, if held by the dead integrator, is reclaimed via `LEASE_TTL_MS` expiry. The new integrator does not need to explicitly release it — `sweepExpired` on the next `acquire` call handles it.

---

## 15. Failure-mode catalog

The user-visible behavior and recovery path for every realistic failure mode in Month 1. Phase 7.4's dashboard will surface most of these directly; for now they're documented operator concerns.

| Failure | Symptom (user / SSE) | Recovery | Final state |
|---|---|---|---|
| Integrator crash mid-attempt | Stage 1 lock TTL expires (`merge.lock.expired` fires after ≤5 min); request stuck `integrating` with no progress; SSE shows no `merge.attempt.completed` | On integrator restart: scan stranded `integrating` requests and call `reset_to_queued` per Section 14.8. Any open `merge_attempts` rows transition to `cancelled`. | Re-queued; eventually landed or rejected on the next loop iteration. |
| Verify timeout | `merge.attempt.completed` with `status=failed, failureCategory=verify_timeout`; `merge.request.rejected` with `category=verify_timeout`; worker sees structured rejection comment on the linked task | Automatic: integrator categorizes and calls `reject()`. | `rejected` |
| Rebase conflict | `git rebase` exits non-zero before verify runs; `failedFiles` populated from `git diff --name-only --diff-filter=U`; `merge.request.rejected` with `category=conflict` | Automatic: integrator categorizes and calls `reject()`. Worker rebases locally and resubmits with the resolved branch. | `rejected` |
| Push race | `git push` returns non-fast-forward after verify passed; the verified tree is stale | Automatic: integrator calls `complete_attempt(cancelled)`, then `reset_to_queued`, then releases the lock. Next loop iteration rebases onto the new main and tries again. | Eventually landed or rejected via a fresh attempt. |
| Disk full | Verify, log write, or worktree ops fail with `ENOSPC` | Categorized as `other` with the system error message in `failureReason`. The request is rejected. Operator-visible from log inspection and from the Phase 7.4 dashboard (when it ships). | `rejected`; manual disk recovery on the integrator host. |
| Network drop (PM unreachable from integrator) | HTTP calls return connection-refused / timeout; SSE drops | Retry with exponential backoff. If the Stage 1 heartbeat misses long enough, `sweepExpired` evicts the holder; the integrator detects this on its next call (heartbeat returns `not_holder`) and triggers crash-recovery flow for whatever request was in flight. | Reconciled via crash-recovery flow. |
| PM crash | Integrator sees `ECONNREFUSED` on every call | Pause the loop, exponential backoff on reconnect attempts. On reconnect, resume from DB state — the integrator polls `?status=integrating` to find any request it was working on and either resumes (if attempt is still running per attempt status) or `reset_to_queued`s it. | Reconciled via crash-recovery flow. |
| **Task deleted while request in-flight** | Request resolves normally on land or reject; the auto side-effects are skipped silently (no `git_refs` row, no `merge_rejection` comment); the structured payload still appears on the SSE event and on the `merge_requests` row | FK `ON DELETE SET NULL` on `merge_requests.taskId` handles the DB layer. Service code checks `taskId !== null` before attempting the side-effect insert. | `landed` or `rejected` per normal flow. |
| **Verify command missing or non-executable** | `child_process.spawn` exits with a system error (e.g. `ENOENT`, `EACCES`); the verify "fails" with no useful output beyond the system error | Categorized as `other`; `failureReason` is the system error message; `logExcerpt` captures whatever the shell produced (typically a one-line error). Request is rejected. Operator fixes `verify_command` in project settings. | `rejected` |
| **Admin force-cancel mid-verify** | Admin POSTs to `/force-cancel`; request transitions `integrating → abandoned`; the integrator is still mid-verify and unaware | The integrator's next service call (`complete_attempt`, `land`, `reject`, or `reset_to_queued`) returns 409 INVALID_TRANSITION. The integrator catches the 409, marks its local attempt as cancelled (in memory), kills any running verify process, releases the Stage 1 lock with `reason: "admin force-cancelled"`. No DB writes from the integrator's failed call. | `abandoned` (admin's transition is the final write). |

---

## 16. Open questions deferred to implementation

These are explicitly out of scope for Month 1 design decisions but are listed so Step 13 (documentation) doesn't get blindsided:

1. **Log retention and rotation.** `${worktree_root}/logs/${attempt_id}.log` accumulates one file per attempt. For Month 1 this is an operator concern — the deployment guide will say "set up a logrotate rule or a cron job." Phase 7.4 (dashboard) will revisit whether PM itself should manage log lifecycle.
2. **Worktree pre-warming.** Should the integrator keep the worktree at the latest `main` between requests, or only update it on demand? Lazy is fine for parallelism=1; Phase 7.2's worktree pool will need an answer.
3. **`pm_get_merge_request` log handling.** The MCP tool returns the `logUrl` in the response (a `file://` URI). For Month 1 we don't ship the log content over MCP — the first 4 KB excerpt is sufficient for a quick read, and the URL lets a determined consumer pull the rest. If the operator hosts the integrator on a different machine than the agent, the `file://` URI is meaningless to the agent — Phase 7.4's dashboard will need to surface logs via HTTP, but that's a UI problem, not a Month 1 one.
4. **Multiple integrators per `(project, resource)` lane.** Section 7.2 says "exactly one for Month 1." The Stage 1 lock would prevent two from working the same request simultaneously, but two competing for the same queued request via `transitionToIntegrating` would race — whichever wins the `queued → integrating` update first integrates, the other gets a 409. Acceptable for Month 1 because deployment policy is single-process; Phase 7.6 makes this a hard invariant via the permissions model.

---

## Appendix A: Cross-reference to Steps 2–13

Every step of the roadmap finds its prerequisites in this document:

| Roadmap step | Sections of this doc |
|---|---|
| Step 2 — Database schema + migration 0010 | Section 4 (every column, FK, index, including `ON DELETE SET NULL` on `taskId`). |
| Step 3 — Shared Zod schemas | Sections 2 (canonical names), 3 (file locations), 4 (column types map to Zod field types), 12 (the `comments.commentType` and `git_refs.refType` additions). |
| Step 4 — Service layer: requests + state machine | Sections 5.1 (state machine), 6 (decision matrix), 11 (authz). |
| Step 5 — Service layer: attempts + structured reject + auto side effects | Sections 5.2 (attempt state machine), 6 (decision matrix rows for attempts/land/reject), 12 (transactional integrity, the exact INSERTs for git_refs and comments). |
| Step 6 — REST routes | Section 8 (every endpoint, body shape, response shape), Section 11 (route-by-route authz composition). |
| Step 7 — SSE events + event-bus wiring | Section 9 (every event name, every payload shape, example frame). |
| Step 8 — MCP tools | Section 10 (every tool, its arguments, its formatted output example). |
| Step 9 — Per-project integrator config | Section 13 (schema, semantics, validation surface). |
| Step 10 — Reference integrator package scaffold | Sections 14.1 (process model), 14.2 (CLI), 14.4 (worktree management), 14.5 (verify execution). |
| Step 11 — Reference integrator: integration loop + tests | Sections 14.3 (SSE + polling), 14.6 (categorization), 14.7 (loop), 14.8 (crash recovery). |
| Step 12 — Full-stack E2E | Sections 8, 9, 14 — the four flows (land, reject, queue order, cancel) all derive from the explicit state machine and event contracts. |
| Step 13 — Documentation | Sections 13 (operator-facing config), 14 (deployment surface), 15 (failure modes for the operator's guide). |
