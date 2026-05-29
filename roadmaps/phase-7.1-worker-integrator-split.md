# Phase 7.1: Worker / Integrator Split — Roadmap

**Goal**: Workers submit a merge request and walk away. A single dedicated integrator agent (long-lived, isolated checkout, serial integration for this phase) picks each request up, rebases onto live main, runs the project's verify command, and either lands it (advancing main, emitting events, attaching a git_ref to the linked task) or rejects it (with structured category + failed files + log pointer, auto-posted as a comment on the linked task). Main is never broken because verification happens off to the side and only proven-green tree SHAs fast-forward.

**Design reference**: `roadmaps/phase-7-merge-train-vision.md` — the six-month vision. This file is the execution roadmap for Month 1 only.

**Prerequisites**: Stage 1 merge lock complete. Per-project named locks with FIFO queue, TTL lease, landing intent (taskId/branch/commitSha/verifyCmd/worktreePath), abandon reason, SSE event stream, MCP tools. Task claims + label-based awareness shipped. 662 server tests, 97 MCP tests, typecheck clean.

**Design liberties**: Implementing agents may make tactical decisions (internal file organization, helper function signatures, test fixture structure) as long as they stay within the architectural commitments below. Schema names, state machine, event names, MCP tool names, and the worker/integrator separation are not negotiable.

**Architectural commitments** (carried from the vision doc):

1. PM owns coordination state; the reference integrator (a separate process) owns execution. PM never spawns build commands.
2. Workers call `pm_request_merge` and exit. They are never parked on a lock for the duration of verify.
3. Main is never broken — verify runs against a tree SHA before main fast-forwards.
4. Rejection is a first-class operation with structured payload (category + failedFiles + logExcerpt/logUrl). Every rejection auto-comments on the linked task with `commentType: "merge_rejection"` and the structured payload as metadata.
5. Stage 1 `acquire`/`release`/`heartbeat` continue to work unchanged. The new flow is opt-in.
6. Parallelism for this phase is **1**. The worktree pool, batching, cross-repo atomicity all come later. Serial integrator is intentional.

---

## Steps

### Step 1 — Month 1 design doc

Write the architecture sketch that every subsequent step will reference. Goes in `docs/design/phase-7.1-design.md`. Keep it tight (target 800–1200 lines including code blocks) but complete.

- Data model: `merge_requests`, `merge_attempts`. Column definitions, constraints, indexes, FKs.
- State machine for `merge_requests`: `queued → integrating → landed | rejected | abandoned`. Allowed transitions, who may trigger each (worker / integrator / human admin), terminal states.
- State machine for `merge_attempts`: `pending → running → passed | failed | cancelled`. One request has many attempts (each rebase-and-verify cycle is an attempt). Last attempt's outcome determines request resolution.
- Relationship to the Stage 1 merge lock: the integrator still uses the lock — it `acquires` while integrating an attempt, `releases(landedSha)` on land, `releases(reason)` on reject. The lock remains the atomic-land primitive. What's new is that the *request* lives outside the lock's lifetime: requests are queued while no integrator is touching them.
- REST API surface: every endpoint name + method + path + request shape + response shape. No implementation, just contracts.
- SSE events: `merge.request.queued`, `merge.request.integrating`, `merge.request.landed`, `merge.request.rejected`, `merge.request.abandoned`, `merge.attempt.started`, `merge.attempt.completed`. Payload contracts.
- MCP tool surface: `pm_request_merge`, `pm_list_merge_requests`, `pm_get_merge_request`, `pm_cancel_merge_request`. Input schemas + output formatting examples.
- Per-project integrator config (lives in `projects.settings.integrator`): `verifyCommand` (string), `verifyTimeoutSec` (number, default 600), `worktreeRoot` (string path), `gitRemote` (string, default "origin"), `gitMainBranch` (string, default "main"), `worktreeName` (string, default derived from project slug).
- Auto-side-effects on land: a new `git_refs` row of type `landed` linked to the request's `taskId` (when set) carrying the landed SHA. On reject: an auto-comment on `taskId` with type `merge_rejection` and the structured payload as metadata.
- Backwards compatibility note: how Stage 1 `acquire`/`release` continues to work alongside this. The two paths share the lock — when a Stage 2 integrator holds the lock, a Stage 1 `acquire` either queues normally or gets `held` if the integrator is idle.
- Reference integrator architecture: process layout (one long-lived process per project per resource), config loading, PM API client, SSE subscription strategy, isolated worktree management (create on first use, reset between attempts, recover on crash restart), `verifyCommand` execution (spawn process, capture stdout+stderr, parse exit code, classify failure category by exit code conventions), categorization heuristic for `failedFiles` from common build output formats (deferred to "best effort" for Month 1 — log pointer is the load-bearing piece).
- Failure-mode catalog: integrator crash mid-attempt, verify timeout, rebase conflict, push race (main moved during integration), disk full, network drop. For each: what the user sees, what the recovery is.

**Verify**: Design doc exists at `docs/design/phase-7.1-design.md`, is internally consistent, and every column/endpoint/event/tool referenced in later steps appears in this doc first. A second-opinion read by the human (Mika) confirms the architecture before code lands.

### Step 2 — Database schema + migration 0010

Add the new tables and indexes per the design doc.

- `packages/server/src/db/schema.ts` additions:
  - `mergeRequests` table:
    - `id` PK
    - `projectId` FK → projects
    - `resource` text — names the train lane (default "main", matches the Stage 1 merge_locks.resource concept)
    - `submittedBy` FK → users (the worker who submitted)
    - `taskId` FK → tasks, nullable
    - `branch` text, nullable
    - `commitSha` text, nullable
    - `verifyCmd` text, nullable (overrides project default if set)
    - `worktreePath` text, nullable
    - `status` text NOT NULL, default 'queued'  — enum: queued/integrating/landed/rejected/abandoned
    - `enqueuedAt` text NOT NULL
    - `pickedUpAt` text, nullable
    - `resolvedAt` text, nullable
    - `landedSha` text, nullable
    - `rejectCategory` text, nullable — enum: conflict / build_failed / test_failed / lint_failed / verify_timeout / policy / other
    - `rejectReason` text, nullable
    - `failedFiles` text JSON-encoded array, nullable
    - `logExcerpt` text, nullable
    - `logUrl` text, nullable
    - `createdAt`, `updatedAt` text NOT NULL
  - `mergeAttempts` table:
    - `id` PK
    - `requestId` FK → mergeRequests
    - `attemptNumber` integer NOT NULL (1-based, monotonic per request)
    - `baseSha` text NOT NULL (the main SHA we rebased onto)
    - `treeSha` text, nullable (the post-rebase commit SHA we verified)
    - `status` text NOT NULL — enum: pending/running/passed/failed/cancelled
    - `startedAt`, `completedAt` text, nullable
    - `verifyDurationMs` integer, nullable
    - `failureCategory` text, nullable
    - `failureReason` text, nullable
    - `failedFiles` text JSON-encoded array, nullable
    - `logExcerpt` text, nullable
    - `logUrl` text, nullable
    - `createdAt` text NOT NULL
  - Indexes:
    - `idx_merge_requests_project_status` on (projectId, status)
    - `idx_merge_requests_resource_status` on (projectId, resource, status, enqueuedAt) — supports the integrator's "next queued in this lane" query
    - `idx_merge_requests_task` on (taskId)
    - `idx_merge_attempts_request_num` unique on (requestId, attemptNumber)
- Hand-written migration at `packages/server/src/db/migrations/0010_merge_requests.sql` mirroring the format of 0008/0009 (CREATE TABLE + indexes, no surrounding transaction).
- Append journal entry to `meta/_journal.json`.
- Re-export the new tables via the existing `export * from "./schema.js"` in `db/index.ts` (no change needed if the re-export pattern still holds).

**Verify**: `pnpm --filter @pm/server exec vitest run tests/db/schema.test.ts` — update the table-count assertion to 22 and list the two new tables. Migration applies cleanly to a fresh in-memory DB. All existing tests still pass.

### Step 3 — Shared Zod schemas

Add the contracts at the package boundary. Single source of truth for status enums, payload shapes, and tool args.

- `packages/shared/src/schemas/merge-request.ts`:
  - `MERGE_REQUEST_STATUSES` and `MergeRequestStatus` type
  - `MERGE_ATTEMPT_STATUSES` and type
  - `MERGE_REJECT_CATEGORIES` (`conflict`, `build_failed`, `test_failed`, `lint_failed`, `verify_timeout`, `policy`, `other`)
  - `mergeRequestSchema` — full view returned by GET
  - `mergeAttemptSchema` — full view
  - `mergeRequestSubmitSchema` — body for `pm_request_merge` and POST endpoint (taskId/branch/commitSha/verifyCmd/worktreePath, plus resource defaulting to "main")
  - `mergeRequestRejectSchema` — body for the integrator's reject call (category, reason, failedFiles[], logExcerpt | logUrl)
  - `mergeRequestLandSchema` — body for the integrator's land call (landedSha required)
  - `mergeAttemptStartSchema` and `mergeAttemptCompleteSchema` — integrator-facing
  - Re-export from `packages/shared/src/schemas/index.ts`
- The reject category enum is the same value-space used in:
  - the `merge_requests.rejectCategory` column,
  - the `merge.request.rejected` SSE event,
  - the auto-posted task comment metadata.
  Single source of truth — don't duplicate the list in three files.

**Verify**: `pnpm --filter @pm/shared build` passes. The Zod schemas validate sample payloads in a new unit test (`packages/shared/tests/merge-request.test.ts`). Type inference is correct (TypeScript types match column nullability exactly).

### Step 4 — Service layer: requests + state machine

The core business logic for the request lifecycle, decoupled from any HTTP shape.

- `packages/server/src/services/merge-request.service.ts`:
  - `submit({ projectId, resource = "main", submittedBy, taskId?, branch?, commitSha?, verifyCmd?, worktreePath? })` → creates a `queued` request, validates task belongs to project, emits `merge.request.queued`, returns the row.
  - `list(projectId, { resource?, status?, taskId?, page?, perPage? })` → filtered list.
  - `getById(id)` → single row including its attempts (most-recent first).
  - `cancel(id, actor)` → only the submitter or a human admin. Transitions queued → abandoned. No-op if already integrating/landed/rejected. Emits `merge.request.abandoned`.
  - State machine helpers used internally and by the integrator-facing service: `transitionToIntegrating`, `transitionToLanded`, `transitionToRejected`. Each validates the from-state, enforces actor type, updates `resolvedAt` and the resolution fields, emits the corresponding event.
- Validation: `taskId` must belong to the same project as the request (consistent with the merge-lock rule from Stage 1 — reuse the same helper).
- All emission goes through the existing `EVENT_NAMES` constant. Add the new names in step 7; reference them here.

**Verify**: Unit tests in `packages/server/tests/services/merge-request.test.ts` cover: submit happy path, submit with cross-project taskId rejected, cancel-while-queued works, cancel-after-landed is a no-op, state machine rejects illegal transitions (e.g. landed → queued), idempotent cancel by submitter.

### Step 5 — Service layer: attempts + structured reject + auto side effects

The piece that lets the integrator record its work and triggers the auto-comments / git_refs.

- `packages/server/src/services/merge-attempt.service.ts`:
  - `startAttempt(requestId, { baseSha })` → creates a new attempt with monotonic `attemptNumber`, status `pending` → flips to `running`. Emits `merge.attempt.started`. Requires the request to be in `integrating` (or transitions it on first attempt).
  - `completeAttempt(attemptId, { status: "passed" | "failed", treeSha?, failureCategory?, failureReason?, failedFiles?, logExcerpt?, logUrl? })` → records result, computes `verifyDurationMs`, emits `merge.attempt.completed`. Does NOT itself resolve the request — the integrator decides whether to land or reject based on attempt outcome.
- Extend `merge-request.service.ts` with `land(requestId, { landedSha })` and `reject(requestId, { category, reason, failedFiles?, logExcerpt?, logUrl? })`:
  - `land` validates request is in `integrating`, sets `status = landed`, `resolvedAt`, `landedSha`. Triggers two side effects:
    - **Auto git_ref**: if `taskId` is set, insert a `git_refs` row with `refType = "landed_sha"`, `refValue = landedSha`, `taskId = request.taskId`. Use the existing `git_refs` table — no schema change.
    - Emits `merge.request.landed` with the landed SHA in the payload.
  - `reject` validates request is in `integrating`, sets `status = rejected`, `resolvedAt`, `rejectCategory`/`rejectReason`/`failedFiles`/`logExcerpt`/`logUrl`. Triggers:
    - **Auto comment**: if `taskId` is set, insert a comment with `taskId = request.taskId`, `authorId = integrator user id (the actor calling reject)`, `commentType = "merge_rejection"`, `body` = a templated string (e.g. `"Merge rejected: ${category}. ${reason}"`), and `metadata` JSON containing the full structured payload (category, failedFiles[], logExcerpt, logUrl, attemptId, requestId).
    - Emits `merge.request.rejected` with the structured payload.
  - Both `land` and `reject` are integrator-only (actor type check). Humans go through the admin override path (Step 6).
- Existing `comment_type` enum in shared: add `"merge_rejection"` to `COMMENT_TYPES`. Existing FTS triggers on comments index the body automatically — no extra wiring.

**Verify**: Unit tests cover: start/complete attempt happy paths, monotonic attempt numbering, `land` creates a `git_refs` row on the linked task with the landed SHA, `reject` creates a comment of type `merge_rejection` on the linked task with the structured payload in `metadata`, both emit the right events, land/reject from a non-`integrating` state is rejected.

### Step 6 — REST routes

Wire the services to HTTP. Naming and shape follow the existing OpenAPIHono patterns in `routes/merge-locks.ts` and `routes/proposals.ts`.

- `packages/server/src/routes/merge-requests.ts`:
  - `POST /api/v1/projects/{projectId}/merge-requests` — worker submission (uses `mergeRequestSubmitSchema`).
  - `GET /api/v1/projects/{projectId}/merge-requests` — list with filters.
  - `GET /api/v1/merge-requests/{id}` — single, with attempts array.
  - `POST /api/v1/merge-requests/{id}/cancel` — submitter or admin.
  - `POST /api/v1/merge-requests/{id}/attempts` — integrator starts an attempt.
  - `PATCH /api/v1/merge-attempts/{id}` — integrator completes an attempt (passed/failed payload).
  - `POST /api/v1/merge-requests/{id}/land` — integrator lands with `landedSha`.
  - `POST /api/v1/merge-requests/{id}/reject` — integrator rejects with structured payload.
- Admin override endpoints (used by Phase 7.4's break-glass UI; built minimally now):
  - `POST /api/v1/merge-requests/{id}/force-cancel` — admin only. Forces transition to `abandoned` from any non-terminal state.
- Wire into `packages/server/src/app.ts` next to `createMergeLockRoutes()`.
- All routes use the existing `OpenAPIHono` + `createRoute` pattern. Error envelope is unchanged. Response envelopes use `{ data }` consistently.
- Auth: existing middleware handles. AI-agent vs human distinction is read from `c.get("currentUser").type`. The integrator agent runs as a user with `type: "ai_agent"` and a role TBD (Month 6 ships permissions; for now, any authenticated agent can land/reject — game_one runs only one integrator process so practical risk is zero).

**Verify**: `packages/server/tests/routes/merge-requests.test.ts` covers every endpoint with at least one happy-path and one error case. Includes: submit→list→get round trip, cancel by submitter works, cancel by stranger 403s, start attempt → complete attempt → land path produces a `git_refs` row on the linked task, reject path produces a `merge_rejection` comment, force-cancel is admin-only.

### Step 7 — SSE events + event-bus wiring

Add the new event names; emission already happens from the service layer.

- `packages/server/src/events/event-bus.ts` — extend `EVENT_NAMES`:
  - `MERGE_REQUEST_QUEUED`, `MERGE_REQUEST_INTEGRATING`, `MERGE_REQUEST_LANDED`, `MERGE_REQUEST_REJECTED`, `MERGE_REQUEST_ABANDONED`
  - `MERGE_ATTEMPT_STARTED`, `MERGE_ATTEMPT_COMPLETED`
- The existing SSE route (`routes/events.ts`) picks them up via the `onAll` wiring; no changes needed there.
- All seven events use the existing `EventPayload` shape with `entityType: "merge_request"` or `"merge_attempt"` and the request/attempt row as the `entity`.

**Verify**: `packages/server/tests/events/event-bus.test.ts` confirms the new event names exist. `packages/server/tests/routes/events.test.ts` adds a streaming test: submit a request, subscribe to SSE, see `merge.request.queued` arrive. Integrator-side test (step 11) exercises the full event chain end-to-end.

### Step 8 — MCP tools

Worker-facing and observer-facing tools. The Stage 1 merge-lock tools stay for backwards compatibility.

- New file `packages/mcp-server/src/tools/merge-requests.ts`:
  - `pm_request_merge(project_id, resource? = "main", task_id?, branch?, commit_sha?, verify_cmd?, worktree_path?)` — calls `POST /merge-requests`. Returns request id + "Queued at position N" (compute position from `list({ resource, status: "queued" })`).
  - `pm_list_merge_requests(project_id, resource?, status?, task_id?)` — readable list with id, status, branch/commit, submitter name, queue position (for queued ones), short summary.
  - `pm_get_merge_request(request_id)` — full detail including attempts history. For rejected requests, surface the structured rejection prominently (category + first line of reason + log URL).
  - `pm_cancel_merge_request(request_id)` — convenience.
- `packages/mcp-server/src/api-client.ts` — add typed client functions for all six routes from step 6 (worker- and observer-facing, plus cancel). Integrator-facing endpoints (start/complete attempt, land, reject) get client functions too — these will be used by the reference integrator (step 10–11).
- Update `packages/mcp-server/src/tools/index.ts` to register the new tool set.
- Update tool descriptions in `packages/mcp-server/src/tools/merge-locks.ts` to point users at `pm_request_merge` as the recommended path (Stage 2) and keep the lock tools as "low-level / advanced." Don't remove or deprecate them.

**Verify**: `packages/mcp-server/tests/tools.test.ts` extended: mock `apiClient` for each new function; assert each tool calls the right client function with the right arguments; assert the rendered text contains the key fields (status, position, rejection category).

### Step 9 — Per-project integrator config

Extend the existing `projects.settings` JSON field. No schema migration needed (it's already a JSON column).

- Define the integrator config shape in shared schemas (`packages/shared/src/schemas/project.ts` extension):
  - `integrator: { enabled: boolean (default false), verifyCommand: string, verifyTimeoutSec: number (default 600), worktreeRoot: string, gitRemote: string (default "origin"), gitMainBranch: string (default "main"), worktreeName: string (optional, defaults to project slug + "-integrator") }`
- Server-side: when a project is fetched, expose the integrator config in the response (the existing project detail endpoint passes settings through unchanged — verify this still works).
- Validation: Zod schema for the integrator config, enforced on `PATCH /projects/{id}`. Invalid configs return 400 with field-level errors.
- Default behavior: a project with `integrator.enabled = false` (the default) does not run a train. Existing projects are unaffected.

**Verify**: A new project created without integrator config still works for all existing flows. Setting `integrator.enabled = true` plus the required fields is accepted; missing required fields are rejected with clear errors. Tests in `packages/server/tests/routes/projects.test.ts` cover the config validation paths.

### Step 10 — Reference integrator package scaffold

New package. This is the process game_one deploys.

- `packages/integrator-ref/`:
  - `package.json` — name `@pm/integrator-ref`, type module, deps: `@pm/shared`, `@modelcontextprotocol/sdk` (optional — likely uses HTTP only for Month 1), `commander` or similar for CLI, `winston` or `pino` for structured logging, `simple-git` for git operations.
  - `tsconfig.json` extending the monorepo base.
  - `src/index.ts` — CLI entry: `pm-integrator --project <id> --resource <name> --pm-url <url> --token <env-var-name>`.
  - `src/config.ts` — load the integrator config: CLI args + env vars + remote project settings (fetched from PM on startup).
  - `src/pm-client.ts` — typed HTTP client. Mirrors the API client in `packages/mcp-server/src/api-client.ts` but standalone (no MCP coupling). Covers: get project settings, list queued requests for (project, resource), start attempt, complete attempt, land, reject, acquire/release/heartbeat the underlying merge lock, subscribe to SSE events for the project.
  - `src/logger.ts` — structured logging (JSON output by default), levels controlled by env.
  - `src/git-ops.ts` — thin wrapper over `simple-git` for the operations we need: fetch, checkout SHA, rebase branch onto base, run a shell command and capture output, push, force-push (admin recoveries only).
  - `src/worktree.ts` — manage one isolated worktree for this process. Create on first run, reset between attempts, repair on detected corruption. Path is `${worktreeRoot}/${worktreeName}`.
  - `src/index.test.ts` placeholder — real tests in step 11.
  - `README.md` — minimal: "deploy this process per project per resource; see `docs/integrator-deployment.md` for full guide" (the guide ships in step 13).
- Wire into the monorepo: add to `pnpm-workspace.yaml` if needed; ensure `pnpm build` and `pnpm test` pick it up; ensure turbo task pipeline runs it.

**Verify**: `pnpm --filter @pm/integrator-ref build` passes. The CLI starts, loads config, prints "Integrator ready for project X resource Y" and exits cleanly on SIGTERM. No actual integration work yet (that's step 11).

### Step 11 — Reference integrator: integration loop + tests

The actual loop that picks up requests and integrates them.

- `src/integrator.ts` — the main loop:
  - On startup: fetch project settings (validates integrator config present and enabled). Open SSE stream. Verify the worktree exists and is healthy.
  - Subscribe to `merge.request.queued` for this project+resource. Also poll `list({ resource, status: "queued" })` every N seconds as a fallback (SSE can miss events on reconnect).
  - For each queued request, in `enqueuedAt` order:
    1. Acquire the Stage 1 merge lock for this project+resource. This is the atomic gate that prevents two integrators from claiming the same request.
    2. Transition the request to `integrating` (via the service-layer call).
    3. Fetch the current main SHA (`baseSha`) and start a `merge_attempt`.
    4. In the isolated worktree: fetch, checkout main, rebase the request's branch (or commitSha) onto main. On rebase conflict → mark attempt failed with `category: "conflict"`, capture conflicting files via `git diff --name-only --diff-filter=U`, reject the request, release the lock with the reason.
    5. Run `verifyCommand` with the configured timeout. Capture stdout+stderr, exit code, wall time. Write the log to a file at `${worktreeRoot}/logs/${attemptId}.log` and surface its path as `logUrl` (file://). For now log storage is local — log retention/rotation is operator concern.
    6. On verify pass: push to the remote main (fast-forward only). On push race (main moved between fetch and push): mark this attempt's tree stale, retry once. On still-conflicting: reject with `category: "conflict"` and the push-race context.
    7. On successful push: complete the attempt as `passed` with the final `treeSha`. Call `land(landedSha)`. Release the lock with `landedSha` (which Stage 1 already advertises as the "main moved" SSE signal).
    8. On verify fail: complete the attempt as `failed` with `category` (heuristic from exit code + log scan), `failedFiles` (best-effort parse), `logUrl`, first 4 KB of log as `logExcerpt`. Call `reject(...)`. Release the lock with the reason.
  - Heartbeat the lock every minute via the existing Stage 1 heartbeat endpoint while the attempt is running.
  - On integrator process crash mid-attempt: the lock TTL expires (5 min), Stage 1's sweep releases it, the request is left in `integrating` state. On restart, the integrator scans for `integrating` requests for this project+resource it doesn't have an active attempt for, and either resumes (if the attempt is still running per attempt status) or marks the open attempt as `cancelled` and re-queues — actually: simplest is to mark the open attempt cancelled, reset the request to `queued`, and proceed. Document this in the design doc.
- Tests:
  - Unit tests for `git-ops` and `worktree` against a temp directory using a real git binary (not mocked — `simple-git` is thin enough that mocking obscures bugs).
  - Integration test (`packages/integrator-ref/tests/integration.test.ts`): spin up an in-memory PM server (reuse `createTestApp`), spin up the integrator in-process with a temp worktree pointing at a temp bare git remote (also temp dir). Exercise both the land path and the reject path end-to-end. Assert: `git_refs` row appears on the linked task after land; `merge_rejection` comment appears after reject with the structured metadata; SSE events for the full lifecycle arrive in order at a third subscriber.
  - Crash-recovery test: kill the integrator mid-attempt, restart, assert the request is re-queued (or resumed) without corruption.

**Verify**: `pnpm --filter @pm/integrator-ref test` passes. The end-to-end test exercises a real fetch/rebase/push cycle against a temp git remote. No mocks for git operations. The flow can be observed via SSE in the test.

### Step 12 — Full-stack end-to-end test

Exercise the worker-submit → integrator-pick-up → land/reject path through the actual MCP tools and HTTP API in one integrated test.

- New test file `packages/server/tests/integration/worker-integrator.e2e.test.ts` (or extend the existing E2E suite under `e2e/`):
  - Setup: real server (`createTestApp`), real integrator process spawned as a child process, real temp git remote with a known initial state, a worker user and an integrator user.
  - Flow 1 (land path): worker calls `pm_request_merge` via MCP → request appears as `queued` → integrator picks it up (transitions to `integrating`, runs verify against a "verify success" command like `exit 0`) → request lands → SSE events fire in order → `git_refs` row exists on the linked task → main has moved.
  - Flow 2 (reject path): worker submits a request whose verify will fail (e.g. `verifyCommand: "exit 1"`) → integrator picks up → attempt fails → request rejected → `merge_rejection` comment posted on the linked task with structured metadata → main has not moved.
  - Flow 3 (queue ordering): two workers submit in sequence → integrator handles them in `enqueuedAt` order → both land sequentially (this phase is parallelism=1).
  - Flow 4 (cancel): worker submits, cancels before integrator picks up → request goes to `abandoned` → integrator skips it.
- This test is the regression net for the whole worker/integrator split. It should run on CI on every PR touching the merge-train code paths.

**Verify**: All four flows pass. The test runs in under 60 seconds. SSE events arrive at expected timestamps. Database state matches the expected diagram after each flow.

### Step 13 — Documentation

The deliverable that makes the system operable by people who didn't build it.

- `docs/integrator-deployment.md` — the operator's deployment guide:
  - Prerequisites: a project with `integrator.enabled = true` and required fields set.
  - Install: `pnpm --filter @pm/integrator-ref build` produces a CLI; run as `node packages/integrator-ref/dist/index.js`.
  - Configuration: env vars (`PM_API_URL`, `PM_API_TOKEN`), CLI args (`--project`, `--resource`).
  - Worktree setup: how to point it at an existing checkout, what happens on first run, how to recover from a corrupted worktree.
  - Verify command conventions: exit 0 = pass, non-zero = fail. Categorization heuristic (which exit codes map to which categories) — keep it simple for Month 1, document the heuristic so operators can predict behavior.
  - Logging: where logs go (`${worktreeRoot}/logs/`), retention guidance (operator's responsibility for now).
  - Monitoring: which SSE events to watch, what a healthy steady state looks like.
  - Failure modes: integrator crash, verify timeout, push race, disk full, network drop — each with what the user sees, what the recovery is.
  - Single-machine multi-agent guidance: `worktreeRoot` per integrator process, never shared. game_one specifically: spell out the recommended directory layout.
- `docs/design/phase-7.1-design.md` — the design doc from Step 1, now finalized with any implementation-driven adjustments.
- Update `CLAUDE.md` with a short "Merge train" section pointing at the two docs above.
- Update `packages/integrator-ref/README.md` to be the canonical entry point (link to the deployment guide).

**Verify**: A new operator following the deployment guide can stand up an integrator process against a fresh project in under 30 minutes. The design doc internally references the implementation correctly (no dangling references to non-existent functions). Mika reads both docs end-to-end and confirms they answer the questions they'd ask if onboarding a new project.

---

## Out of scope for Phase 7.1 (covered by later phases)

- **Speculative batching / parallelism > 1**. The worktree pool, batch state machine, suffix invalidation — all Phase 7.2.
- **Cross-repo atomicity (rynx + outer gitlink)**. Phase 7.3.
- **Train dashboard, audit log, break-glass UI**. Phase 7.4. The data plumbing (events, audit-able actions) is built now; the UI and human-override endpoints come later.
- **Verify-result caching, multi-stage verify, test impact analysis**. Phase 7.5.
- **Crash chaos suite, multi-train lanes, permissions, advisory board**. Phase 7.6.

## Definition of done

- A worker calls `pm_request_merge` from MCP and exits.
- A reference integrator process picks up the request and either:
  - lands it (main fast-forwards; `git_refs` row appears on the linked task; SSE `merge.request.landed` fires) OR
  - rejects it with structured payload (category + failedFiles + logUrl; auto-comment appears on the linked task with `commentType: "merge_rejection"` and structured metadata; SSE `merge.request.rejected` fires).
- Main is never advanced past a tree that didn't pass verify. Asserted by the E2E reject-path test.
- Stage 1 `acquire`/`release`/`heartbeat` continue to work. Asserted by existing Stage 1 tests still passing untouched.
- 662 server tests + 97 MCP tests + new Phase 7.1 tests all pass. Typecheck clean. No new lint regressions.
- Documentation lets a new operator deploy an integrator against a fresh project in under 30 minutes.
