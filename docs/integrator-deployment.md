# Integrator deployment guide

**Audience**: operators deploying and running the reference integrator (`@pm/integrator-ref`) for a PM project.
**Scope**: the merge train — one integrator process per `(project, resource)` lane. Phase 7.1 (serial, `parallelism: 1`) is the baseline; **Phase 7.2 adds speculative batching** (`parallelism: N`, §13).
**Companion specs**: `docs/design/phase-7.1-design.md` (serial baseline) and `docs/design/phase-7.2-design.md` (speculative batching — data model, lock protocol, observability, failure catalog). When this guide and a design doc disagree on a contract detail, the design doc wins.

This guide is written so a fresh operator can take a project from "integrator disabled" to "a test merge request landed" in about 30 minutes. The fast path is the checklist in §12; everything before it is reference.

---

## 1. Overview

The integrator is a **separate, long-lived process**. PM itself never spawns build commands — the server only records coordination state (`queued` / `integrating` / `landed` / `rejected` facts). The integrator's job is to make those facts true. This split is the load-bearing architectural commitment of Phase 7: workers call `pm_request_merge` and walk away; no worker is parked on a lock while a verify build runs.

You run **one integrator process per `(project, resource)` lane**. For `game_one` in Month 1 that is exactly one process: `(game_one, main)`.

Each process loops. At `parallelism: 1` (the default, Phase 7.1 behavior) it processes one request at a time, serially:

1. Watch the PM project for the next `queued` merge request in its lane (oldest first).
2. Pick it up (`queued → integrating`), acquire the Stage 1 lock as a defense-in-depth gate, and start an attempt.
3. Reset an isolated git worktree to live `main`, then rebase the request's branch/commit onto it.
4. Run the project's configured verify command against the rebased tree.
5. Either **land** it — fast-forward `main` to the verified tree, attach a `landed_sha` git_ref to the linked task — or **reject** it — record a structured payload (category, failed files, log pointer) and auto-post a comment of type `merge_rejection` on the linked task.

**Main is never broken**: verify runs against a tree SHA *before* `main` fast-forwards. A verify failure terminates as `rejected`; it can never land.

At `parallelism: N > 1` (**Phase 7.2 speculative batching**, §13) the same process runs **N integrations in flight at once** in a pool of N isolated worktree clones — members rebase speculatively on `main + predecessors`, verify concurrently, and land serialized in batch order. The lane lock is then acquired **once per batch** (lane ownership), not once per request. `parallelism: 1` is exactly the serial loop above (a degenerate batch of one). Read §13 before enabling N > 1.

Cross-reference: design doc §14 (7.1 reference integrator architecture) and 7.2 design §3–§9/§13–§15 are the authoritative descriptions of the loop this process implements.

---

## 2. Prerequisites

Before deploying an integrator for a project, confirm all of the following:

- **Project has the integrator enabled.** `projects.settings.integrator.enabled = true`, with the required fields set: `verify_command` and `worktree_root` (both must be non-empty when enabled). See §4 for the full field list and a sample `PATCH` body.
- **Project has `gitRepoUrl` set.** This is a **top-level project field** (not under `settings`). The integrator clones this URL on first use. Without it the integrator refuses to start.
- **A PM `ai_agent` user with an API token.** The integrator authenticates as this user. In Month 1, *any* `ai_agent` token works — `requireIntegrator` only checks `user.type === "ai_agent"`; there is no special integrator role yet (that ships in Phase 7.6). Do not use a human user's token.
- **`git` on PATH** on the integrator host (the integrator shells out to git via `simple-git`).
- **Node.js >= 22** on the integrator host.
- **Network reachability** from the integrator host to the PM API URL (`--pm-url`), over HTTP. The integrator polls and opens an SSE stream against this URL.

---

## 3. Install and build

From the monorepo root:

```bash
pnpm install
pnpm --filter @pm/integrator-ref build
```

The build runs `tsc --build` and then adds an executable shebang to the entry file. It produces:

```
packages/integrator-ref/dist/index.js
```

The package declares a `pm-integrator` bin, but for deployment you typically invoke the built file directly:

```bash
node packages/integrator-ref/dist/index.js …
```

---

## 4. Configuration

The integrator is configured from three places: CLI args (per process), environment variables (mostly for secrets), and the per-project `settings.integrator` block (shared, stored in PM).

### 4.1 CLI arguments

| Flag | Default | Meaning |
|---|---|---|
| `--project <id>` | (none — else `PM_PROJECT_ID`) | **Required.** The project ULID. If omitted, falls back to `PM_PROJECT_ID`; if neither is set, the process exits with a config error. |
| `--resource <name>` | `main` | The lane within the project. |
| `--pm-url <url>` | `http://localhost:3000` (else `PM_API_URL`) | PM API base URL. Trailing slashes are stripped. |
| `--token <envVar>` | `PM_API_TOKEN` | **Names the environment variable** that holds the API token. The token is never passed on the command line (it would leak to `ps`). The process reads `process.env[<envVar>]`. |
| `--log-level <level>` | `info` (else `PM_LOG_LEVEL`) | pino level: `trace` / `debug` / `info` / `warn` / `error` / `fatal`. |
| `--poll-interval-sec <sec>` | `30` | Polling interval. This is the **correctness floor** — the integrator always finds work by polling DB truth. SSE is only a latency hint that lets it poll sooner. |

A CLI flag always wins over the corresponding environment variable.

### 4.2 Environment variables

| Variable | Used for |
|---|---|
| `PM_PROJECT_ID` | Fallback for `--project`. |
| `PM_API_URL` | Fallback for `--pm-url`. |
| `PM_API_TOKEN` | The default token env var (overridable by `--token <envVar>`). |
| (var named by `--token`) | If you pass `--token MY_TOKEN`, the integrator reads `process.env.MY_TOKEN`. |
| `PM_LOG_LEVEL` | Fallback for `--log-level`. |

### 4.3 Per-project `settings.integrator` fields

Stored in PM under `projects.settings.integrator`. The `settings` column is already JSON TEXT — no migration is required. Keys are **snake_case** (matching the sibling `ai_autonomy` / `workflow` / `git` blocks).

| Field | Type | Default | Required when `enabled` | Notes |
|---|---|---|---|---|
| `enabled` | boolean | `false` | always | Master switch. If not `true`, the integrator logs a fatal error and exits cleanly. |
| `verify_command` | string | (none) | yes | Shell command line. Run as `spawn(verify_command, { shell: true, cwd: worktreePath })`. A per-request override is the request's `verifyCmd`. |
| `verify_timeout_sec` | number | `600` | no | Kill the verify process after this many seconds (SIGTERM then SIGKILL); the failure is categorized as `verify_timeout`. |
| `worktree_root` | string | (none) | yes | Absolute path to the directory that owns this integrator's isolated worktree (and its logs). See §5. |
| `git_remote` | string | `origin` | no | Remote to fetch from and push to. |
| `git_main_branch` | string | `main` | no | The branch on the remote that the lane maps to. |
| `worktree_name` | string | `${project.slug}-integrator` | no | Base subdirectory name under `worktree_root`. The pool appends `-0`, `-1`, … per slot (§5). Useful when one host runs multiple integrators. |
| `parallelism` | integer ≥ 1 | `1` | no | **Phase 7.2.** Number of integrations in flight at once = number of worktree slots in the pool (§5, §13). `1` = exact 7.1 serial behavior. There is **no env var** for this — it lives only here, on the project. |

> **`gitRepoUrl` is a top-level project field, NOT under `settings`.** It is required — the integrator clones it. Do not put it inside `settings.integrator`.

> **`parallelism` has no environment-variable or CLI override.** Operators looking for a `PM_PARALLELISM` env var or a `--parallelism` flag will not find one — it is configured **per project** in `settings.integrator.parallelism` and read at integrator startup. To change it, `PATCH` the project and restart the integrator process.

**Sample `PATCH` body to enable the integrator** (`PATCH /api/v1/projects/{id}`):

```json
{
  "gitRepoUrl": "git@github.com:acme/game_one.git",
  "settings": {
    "integrator": {
      "enabled": true,
      "verify_command": "cargo build --workspace && cargo test --workspace",
      "verify_timeout_sec": 900,
      "worktree_root": "/srv/game_one/integrators/main",
      "git_remote": "origin",
      "git_main_branch": "main",
      "worktree_name": "game_one-integrator",
      "parallelism": 3
    }
  }
}
```

(Omit `parallelism` — or set it to `1` — to keep the serial 7.1 behavior. `game_one` runs `parallelism: 3`.)

The `PATCH /projects/{id}` route validates this with the Zod schema; an invalid config returns 400 with field-level errors. The integrator also re-validates on startup and exits with code 2 if the config is wrong (see §7).

---

## 5. Worktree setup (the pool)

The integrator keeps a **pool of `parallelism` isolated git worktrees** per process — one slot per concurrent member. Each slot is a **separate clone** of `gitRepoUrl` (never a shared `.git`), so members never clobber each other. The slots are numbered `0..parallelism-1` under `worktree_root`:

```
${worktree_root}/
  ${worktree_name}-0/   ← pool slot 0 (a clone of gitRepoUrl)
  ${worktree_name}-1/   ← pool slot 1
  ${worktree_name}-2/   ← pool slot 2     (… up to ${worktree_name}-{parallelism-1})
  logs/                 ← per-attempt verify logs (shared across slots)
```

- **Slot path** = `${worktree_root}/${worktree_name}-{i}` for `i` in `0..parallelism-1`.
- At `parallelism: 1` there is exactly **one** slot, `${worktree_name}-0`. (Note: this is the `-0` suffixed dir, not a bare `${worktree_name}/` — the pool always suffixes the slot index, even for N=1.)
- **Logs directory** = `${worktree_root}/logs/` — a sibling of the slots, shared. Logs are NOT placed inside a worktree (which gets wiped between attempts).

**Clone-on-startup (`ensureAll`).** On startup the pool clones any missing slot from `gitRepoUrl` and aligns the configured remote. On-disk clones are **reused** across runs (no destructive teardown), matching the 7.1 single-worktree reuse.

**Startup garbage-collection (`gc`).** Before cloning, the pool prunes **stale numbered slots** left over from a previous run with a *larger* `parallelism`. It scans `worktree_root` for directories matching `${worktree_name}-<digits>` that are not in the current `0..parallelism-1` set and removes them. (Only numeric-suffixed slot dirs are touched; unrelated directories are left alone.) So shrinking `parallelism` from 5 to 3 cleans up `-3` and `-4` on the next start.

**Lease model (backpressure).** Slots are leased one per admitted member and released on terminal/invalidated. When all slots are leased, new queued requests are **not** picked up (backpressure, §13) — they stay `queued`, never dropped.

**Between attempts.** Before each request the integrator restores a clean state in the worktree:

```
git reset --hard
git clean -fdx
git fetch <git_remote>
git checkout <git_main_branch>
git reset --hard <git_remote>/<git_main_branch>
```

This guarantees a clean tree no matter how the previous attempt left things (rebase aborted, verify killed mid-build, etc.).

**Corruption detection and per-slot recovery.** If a slot's `.git` directory is missing or `git status` fails, that slot is considered corrupt: the integrator deletes **just that slot's** directory and re-clones it from `gitRepoUrl` (`pool.repair(slot)`). Because slots are separate clones, the other slots are untouched and the batch continues; the member that was in the corrupt slot is re-admitted (§13).

**Crash recovery on startup.** Before entering its loop, the integrator scans for requests stranded in `integrating` (from a prior crash) and resets each back to `queued`, cancelling any open attempts. This is idempotent — a request an admin already abandoned returns 409 and is skipped.

> **Each integrator process MUST own its `worktree_root`.** Never share a `worktree_root` between two integrator processes. See §10 for the single-machine multi-agent layout.

---

## 6. Verify command conventions

The verify command is the project's gate for "is this tree green?". It is run as:

```
spawn(verify_command, { shell: true, cwd: worktreePath })
```

- **Exit 0 = pass.** The integrator proceeds to push (land).
- **Any non-zero exit = fail.** The integrator rejects the request.
- A per-request override is available via the request's `verifyCmd` field; when set it replaces the project's `verify_command` for that request only.

**Timeout.** If the command runs longer than `verify_timeout_sec` (default `600`), the integrator sends SIGTERM to the process group, then SIGKILL after a short grace period. The failure is categorized as `verify_timeout`.

**Categorization heuristic.** The category is a *hint*, not a contract — the load-bearing artifact is the `logUrl`, which surfaces the raw verify output to the worker. The integrator maps signals to categories as follows:

| Signal | Category |
|---|---|
| timeout / exit code 124 / killed by SIGTERM / SIGKILL | `verify_timeout` |
| `error[E…]`, or `error:` together with `could not compile` | `build_failed` |
| pytest `FAILED (failures=…` / `= FAILURES =` / `test result: FAILED` / a `FAIL ` line | `test_failed` |
| `warning:` / eslint / Prettier / clippy markers (with a non-zero exit) | `lint_failed` |
| anything else with a non-zero exit | `other` |

(Rebase conflicts and push races are detected separately, before/after verify, and map to `conflict` / re-queue respectively — see the design doc §14.6.)

---

## 7. Logging

- The integrator emits **pino JSON to stdout** with ISO 8601 timestamps. For human-readable output, pipe through `pino-pretty` (not bundled — install it ad hoc):

  ```bash
  node packages/integrator-ref/dist/index.js … | npx pino-pretty
  ```

- **Per-attempt verify logs** are written to `${worktree_root}/logs/${attemptId}.log` and surfaced to workers as the request's `logUrl` (a `file://` URI). Log retention/rotation is the **operator's responsibility** (e.g. a logrotate rule or a cron sweep).

- **Exit codes for supervisors:**

  | Code | Meaning | Supervisor action |
  |---|---|---|
  | `0` | Clean shutdown (received SIGTERM/SIGINT, finished current iteration). | No restart needed. |
  | `1` | Runtime error (e.g. worktree init failed, missing token). | Safe to auto-restart. |
  | `2` | Config error (integrator not enabled, missing required field, bad settings). | **Do NOT auto-restart** — fix the config first. |

---

## 8. Monitoring

Subscribe to the PM event stream, scoped to the project:

```
GET /api/v1/events?project_id=<projectId>
```

Relevant events:

- `merge.request.queued` / `.integrating` / `.landed` / `.rejected` / `.abandoned`
- `merge.attempt.started` / `.completed`
- **Batch markers (Phase 7.2):** `merge.batch.started` / `.member_landed` / `.member_invalidated` / `.completed` (see §13).

**SSE frames are flattened.** Each frame carries `entity_type`, `entity_id`, `action`, `actor` (`{ id, name, type }`), and `timestamp` (plus `changes?` / `entity_title?` when present). It does **not** carry the full row. To get full detail, fetch `GET /api/v1/merge-requests/{id}`. Cross-reference: design doc §9.2.

**Phase 7.2 batch tags.** When `parallelism > 1`, the `merge.request.integrating` and `merge.attempt.started` frames additionally carry `batch_id` and `speculative_position` (the member's 0-based admission index within its batch) when the integrator supplied them. These are absent on 7.1-style frames. See §13 for the batch-observability contract.

**Healthy steady state:**

- A `queued` request moves to `integrating` within roughly one poll interval.
- Every request ends in exactly one of `landed` or `rejected` (or `abandoned` if cancelled).
- No request lingers in `integrating` without an eventual `merge.attempt.completed`.

**Startup confirmation.** On a healthy start the integrator prints, to stdout:

```
Integrator ready for project <X> resource <Y>
```

(and logs an `Integrator ready` JSON line with the project, resource, verify command, and worktree root).

---

## 9. Failure modes

Every realistic Month 1 failure, its symptom, and the recovery path. "Operator action" is called out where a human must intervene; everything else is automatic. Pulled from the design doc §15 catalog.

| Failure | Symptom | Recovery | Operator action |
|---|---|---|---|
| Integrator crash mid-attempt | Request stuck `integrating`; no `merge.attempt.completed`; Stage 1 lock TTL expires within ≤5 min | On restart the integrator scans stranded `integrating` requests and resets them to `queued` (open attempts → `cancelled`); the lock self-heals via TTL expiry | Restart the process (a supervisor does this on exit code 1). |
| Verify timeout | `merge.attempt.completed` with `failureCategory=verify_timeout`; `merge.request.rejected` with `category=verify_timeout` | Automatic: categorize → reject | None. |
| Rebase conflict | `merge.request.rejected` with `category=conflict`; `failedFiles` captured from the conflicting paths | Automatic: categorize → reject | Worker resolves locally and resubmits. |
| Push race | `git push` is non-fast-forward after verify passed (main moved); verified tree is stale | Automatic: cancel the attempt, reset request to `queued`, release the lock; the next iteration rebases onto the new main and retries | None. |
| Disk full | Verify / log write / worktree op fails with `ENOSPC`; rejected as `other` with the system error in `failureReason` | Automatic reject; integrator cannot make progress until space is freed | **Free disk space** on the integrator host. |
| Network drop / PM unreachable | HTTP calls fail; SSE drops | Retry with exponential backoff; reconcile from DB state on reconnect (poll for in-flight `integrating` request) | None (unless the outage is on the operator's side). |
| PM crash | Every call returns `ECONNREFUSED` | Pause loop, backoff, resume from DB state on reconnect | Bring PM back up. |
| Task deleted in-flight | Request still resolves (`landed`/`rejected`); auto side-effects (git_ref / comment) are silently skipped; structured payload still on the SSE event and the request row | Automatic (`ON DELETE SET NULL` on `taskId`; service checks `taskId !== null`) | None. |
| Verify command missing / non-executable | `spawn` fails with `ENOENT` / `EACCES`; rejected as `other` with the system error in `failureReason` | Automatic reject | **Fix `verify_command`** in project settings. |
| Admin force-cancel mid-verify | Admin POSTs `/force-cancel`; request → `abandoned` while the integrator is mid-verify | The integrator's next service call returns 409; it bails, kills any running verify, and releases the lock | None. |

### 9.1 Phase 7.2 batch failure modes (`parallelism > 1`)

Additional modes when speculative batching is enabled. Pulled from 7.2 design §15.

| Failure | Symptom | Recovery | Operator action |
|---|---|---|---|
| Worktree pool exhaustion | All `parallelism` slots leased; queue depth grows; new requests stay `queued` (not picked up) | **Backpressure** — requests are neither dropped nor picked up; slots free as members terminate and the next FIFO request is admitted. No data loss. | None (raise `parallelism` if throughput is the bottleneck and the host has capacity). |
| One slot corrupt mid-batch | A member's git op fails on a corrupt `.git` in its slot | `pool.repair` rebuilds **that slot only** (delete + re-clone); the member is `resetToQueued` and re-admitted. Other slots/members continue. | None. |
| Integrator crash mid-batch | In-memory batch lost; lane lock held by the dead process; N requests stuck `integrating` | The lane lock TTL-frees in ≤5 min; the next integrator's `acquire` reclaims it. On restart the crash-recovery sweep resets **ALL** `integrating` in the lane → `queued`. **No orphan `main` advance** — a push only happens under the live lock. | Restart the process (supervisor on exit code 1). |
| Per-member verify hang | One member's verify exceeds `verify_timeout_sec` | The **per-member** `runVerify` timeout fires and kills **just that** worktree's verify subtree; `timedOut → category verify_timeout` (real, not retried) → reject + invalidate that member's dependent suffix. Siblings untouched. | None. |
| Predecessor stale at land | At land time, live `main` ≠ the expected predecessor SHA, or `push` is `non_fast_forward` | **Fast-forward-or-reverify guard**: cancel the attempt, `resetToQueued`, re-admit with the corrected base, re-verify. (Should not occur while holding the lane lock; guarded regardless.) | None. |
| Transient verify failure | Verify child never ran (`ENOENT`/`EACCES`) or was killed by a signal the integrator did NOT fire (OOM, operator kill) | **Retry** the same member against the same speculative base, after backoff (**1s / 5s / 15s**, cap 3 retries). Each retry is a fresh attempt row. After the cap, treat as real → reject + suffix invalidation. | None (investigate if it recurs — e.g. a flaky verify command or an under-provisioned host). |

---

## 10. Single-machine, multi-agent guidance

**The rule: `worktree_root` is per-integrator-process, never shared.** Two integrator processes must never point at the same `worktree_root` — they would clobber each other's worktrees and logs. Give each lane its own root.

Recommended `game_one` layout (one lane, `main`, `parallelism: 3` → three pool slots):

```
/srv/game_one/
  integrators/
    main/                        ← worktree_root for (game_one, main)
      game_one-integrator-0/     ← pool slot 0 (clone)
      game_one-integrator-1/     ← pool slot 1 (clone)
      game_one-integrator-2/     ← pool slot 2 (clone)
      logs/                      ← per-attempt logs (shared)
```

At `parallelism: 1` this collapses to a single slot, `game_one-integrator-0/`. Raising `parallelism` to N adds slots `…-{0..N-1}`; lowering it prunes the now-extra numbered slots on the next startup (`gc`, §5).

Adding a second lane later means a second root (e.g. `/srv/game_one/integrators/<resource>/`), a second process, and its own pool of slots — never a shared directory.

**The lane-ownership lock (Phase 7.2).** Within a lane, the integrator acquires the `(project, resource)` merge lock **once per batch** (not once per request), heartbeats while the batch is in flight, and releases it when the lane drains. The lock means "exactly one integrator owns this lane." If you accidentally start a **second** integrator for the same `(project, resource)`, it requests the lock, gets a `queued` (not-granted) result, and **idles** — it never reaches the land path, so there is no double-push to `main`. This is the structural guard against two integrators racing `main`. (Still: run exactly one process per lane; a second one is wasted, not dangerous.)

**Workers are entirely separate.** A worker's own checkout has nothing to do with the integrator's worktree. The `worktreePath` field on a merge request is **informational only** (it records the worker's host path for observability); the integrator always uses its own configured `worktree_root` / `worktree_name`.

---

## 11. Deployment

### Manual run

```bash
PM_API_TOKEN=<token> \
  node packages/integrator-ref/dist/index.js \
    --project 01HXYZ... \
    --resource main \
    --pm-url http://localhost:3000 \
    --log-level info \
    --poll-interval-sec 30
```

### systemd

```ini
[Unit]
Description=PM integrator (game_one / main)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/project-management
EnvironmentFile=/etc/pm/integrator-game_one.env   # holds PM_API_TOKEN=...
ExecStart=/usr/bin/node packages/integrator-ref/dist/index.js \
  --project 01HXYZ... --resource main --pm-url http://localhost:3000
Restart=on-failure
RestartPreventExitStatus=2   # exit code 2 = config error: do NOT restart, fix config
KillSignal=SIGTERM           # triggers graceful shutdown

[Install]
WantedBy=multi-user.target
```

`RestartPreventExitStatus=2` honors the integrator's config-error exit code so a broken config fails loudly instead of crash-looping.

### docker

Mount the `worktree_root` as a volume (so worktree + logs survive restarts) and pass configuration via environment:

```bash
docker run -d \
  --name pm-integrator-game_one-main \
  -v /srv/game_one/integrators/main:/srv/game_one/integrators/main \
  -e PM_API_TOKEN=<token> \
  -e PM_PROJECT_ID=01HXYZ... \
  -e PM_API_URL=http://pm-host:3000 \
  <image> \
  node packages/integrator-ref/dist/index.js --resource main
```

### Graceful shutdown

On `SIGTERM` / `SIGINT` the integrator finishes its current loop iteration (it does not abort an in-flight land/reject), stops the SSE subscriber, and exits with code 0.

---

## 12. 30-minute deploy checklist

1. **Enable the integrator on the project.** `PATCH /api/v1/projects/{id}` with `settings.integrator.enabled = true` plus `verify_command` and `worktree_root` (see §4.3 for the sample body).
2. **Set `gitRepoUrl`** on the project (top-level field) to a clonable repo URL.
3. **Create an `ai_agent` user and API token** in PM; export it (e.g. `export PM_API_TOKEN=…`).
4. **Build:** `pnpm install && pnpm --filter @pm/integrator-ref build`.
5. **Run:**
   ```bash
   node packages/integrator-ref/dist/index.js --project <id> --resource main --pm-url <url>
   ```
   Confirm the `Integrator ready for project <id> resource main` line.
6. **Submit a test merge request** with a trivially-passing verify override:
   - via MCP: `pm_request_merge` with `verify_cmd: "exit 0"` (and a `branch` or `commit_sha` to integrate).
7. **Watch it land.** Subscribe to `GET /api/v1/events?project_id=<id>` and confirm the sequence `merge.request.queued → .integrating → merge.attempt.started → .completed → merge.request.landed`. Confirm a `landed_sha` git_ref appears on the linked task.

If step 7 lands, the lane is operational.

---

## 13. Speculative batching (Phase 7.2)

Setting `parallelism: N > 1` turns the serial loop into a **speculative batch scheduler**: N integrations run in flight at once, throughput scaling toward the verify-runtime ceiling instead of being capped by serial integration. This section is the operator-facing summary; the authoritative spec is `docs/design/phase-7.2-design.md`.

### 13.1 How a batch runs

1. **One acquire per batch.** When queued work exists and the lane is unowned, the integrator acquires the `(project, resource)` lock **once** (lane ownership), heartbeats every 60s for the whole batch, and releases it when the lane drains. A second integrator on the same lane gets a not-granted result and idles (§10).
2. **Speculative rebase.** Members admit FIFO. Member 0 (the prefix anchor) rebases on live `main`. Member K rebases on its surviving predecessor's already-rebased tree (i.e. `main + 0 + … + K-1`) — it assumes the predecessors land first. (The rebases serialize; the verifies overlap — that overlap is the throughput win.)
3. **Concurrent verify.** Each member runs its verify command in its own pool slot; up to N verifies run at once.
4. **Serialized lands.** Lands happen in batch order: a member lands only after every predecessor has landed, fast-forwarding `main` to its verified tree — **no re-verify** (it already verified against exactly that base).
5. **Suffix invalidation on failure.** When a member fails (verify non-zero / rebase conflict / push error — not a benign main-drift), exactly its **dependent suffix** (every member that speculated on it) is invalidated and re-admitted against the corrected base; **predecessors that already passed still land**. "A single failure invalidates exactly the dependent suffix — never more, never less."
6. **Transient retry.** A verify that *never ran* (spawn failure) or was killed by a signal the integrator did not fire (OOM / operator kill) is retried on the same base with **1s / 5s / 15s** backoff (cap 3). A verify that hits its own `verify_timeout_sec` is a **real** failure (not retried).

`parallelism: 1` is exactly the 7.1 serial loop (a batch of one): one slot, base = live `main`, immediate land — PM-observably identical to before.

### 13.2 Observability

There is **no PM batch table** — the integrator owns batch state in memory and relays observability over SSE. Two mechanisms:

**Tagged existing events.** `merge.request.integrating` and `merge.attempt.started` frames carry `batch_id` and `speculative_position` (the member's 0-based admission index) when batching is active. Absent on 7.1-style frames.

**Four batch-marker events.** The integrator POSTs each marker to a thin relay endpoint and PM re-emits it on the SSE stream (persisting nothing):

- **Endpoint:** `POST /api/v1/projects/{projectId}/merge-batches/events` — **integrator (`ai_agent`) only** (403 for any other caller). The reference integrator wires this automatically (`onBatchEvent` → `postBatchEvent`); a failed POST is logged and never crashes the loop.
- **Markers** (all carry `batchId`):

  | Event | Payload |
  |---|---|
  | `merge.batch.started` | `{ batchId, resource, memberCount, memberRequestIds[] }` |
  | `merge.batch.member_landed` | `{ batchId, requestId, speculativePosition, landedSha }` |
  | `merge.batch.member_invalidated` | `{ batchId, requestId, speculativePosition, reason, failedPredecessorRequestId }` |
  | `merge.batch.completed` | `{ batchId, landed, rejected, invalidated }` (counts) |

The `batchId` is a ULID **minted by the integrator**; PM never generates or persists it. These events are the entire batch-observability contract (the Phase 7.4 dashboard consumes them — there is no batch query API).

### 13.3 Sizing `parallelism`

`parallelism` is bounded by the host's capacity to run N concurrent verify builds (CPU/RAM/disk) and N worktree clones on disk. `game_one` runs `parallelism: 3`. Start small, watch the per-attempt verify logs and host load, and raise it only if the queue is verify-bound. Remember: each slot is a full clone of the repo under `worktree_root` (§5), so disk grows ~linearly with N.
