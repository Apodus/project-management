# Integrator deployment guide

**Audience**: operators deploying and running the reference integrator (`@pm/integrator-ref`) for a PM project.
**Scope**: the merge train — one integrator process per `(project, resource)` lane. Phase 7.1 (serial, `parallelism: 1`) is the baseline; **Phase 7.2 adds speculative batching** (`parallelism: N`, §13); **Phase 7.3 adds cross-repo atomicity** (linked inner/outer repos landing as a unit, §14); **Phase 7.4 adds observability + break-glass** (§15); **Phase 7.5 adds smart verification** (§16); **Phase 7.6 adds intelligent conflict resolution** (an opt-in headless resolver, §18).
**Companion specs**: `docs/design/phase-7.1-design.md` (serial baseline), `docs/design/phase-7.2-design.md` (speculative batching — data model, lock protocol, observability, failure catalog), `docs/design/phase-7.3-design.md` (cross-repo atomicity — linked-repo model, group + incident tables, assembled verify, atomic-land protocol, orphaned-inner recovery), `docs/design/phase-7.4-design.md` (observability + break-glass), `docs/design/phase-7.5-design.md` (smart verification — verify DAG + verify-result cache), and `docs/design/phase-7.6-design.md` (intelligent conflict resolution — resolver config, resolution state machine, escalation ladder). When this guide and a design doc disagree on a contract detail, the design doc wins.

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

**Main is never broken**: verify runs against a tree SHA _before_ `main` fast-forwards. A verify failure terminates as `rejected`; it can never land.

At `parallelism: N > 1` (**Phase 7.2 speculative batching**, §13) the same process runs **N integrations in flight at once** in a pool of N isolated worktree clones — members rebase speculatively on `main + predecessors`, verify concurrently, and land serialized in batch order. The lane lock is then acquired **once per batch** (lane ownership), not once per request. `parallelism: 1` is exactly the serial loop above (a degenerate batch of one). Read §13 before enabling N > 1.

Cross-reference: design doc §14 (7.1 reference integrator architecture) and 7.2 design §3–§9/§13–§15 are the authoritative descriptions of the loop this process implements.

---

## 2. Prerequisites

Before deploying an integrator for a project, confirm all of the following:

- **Project has the integrator enabled.** `projects.settings.integrator.enabled = true`, with the required fields set: `verify_command` and `worktree_root` (both must be non-empty when enabled). See §4 for the full field list and a sample `PATCH` body.
- **Project has `gitRepoUrl` set.** This is a **top-level project field** (not under `settings`). The integrator clones this URL on first use. Without it the integrator refuses to start.
- **A PM `ai_agent` user with an API token.** The integrator authenticates as this user. In Month 1, _any_ `ai_agent` token works — `requireIntegrator` only checks `user.type === "ai_agent"`; there is no special integrator role yet (that ships in Phase 7.6). Do not use a human user's token.
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

> **Pre-bundled artifact (no monorepo checkout).** If you received a single-file
> `pm-integrator.mjs` instead of the full repo (e.g. it was distributed into your
> client repo under `tools/pm-integrator/`), you do **not** need to install or
> build anything — skip this section. Run that file directly in place of the
> `dist/index.js` path; every CLI flag and environment variable below is
> identical:
>
> ```bash
> node tools/pm-integrator/pm-integrator.mjs --project <id> --resource main --pm-url http://localhost:3000
> ```

---

## 4. Configuration

The integrator is configured from three places: CLI args (per process), environment variables (mostly for secrets), and the per-project `settings.integrator` block (shared, stored in PM).

### 4.1 CLI arguments

| Flag                        | Default                                     | Meaning                                                                                                                                                                        |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--project <id>`            | (none — else `PM_PROJECT_ID`)               | **Required.** The project ULID. If omitted, falls back to `PM_PROJECT_ID`; if neither is set, the process exits with a config error.                                           |
| `--resource <name>`         | `main`                                      | The lane within the project.                                                                                                                                                   |
| `--pm-url <url>`            | `http://localhost:3000` (else `PM_API_URL`) | PM API base URL. Trailing slashes are stripped.                                                                                                                                |
| `--token <envVar>`          | `PM_API_TOKEN`                              | **Names the environment variable** that holds the API token. The token is never passed on the command line (it would leak to `ps`). The process reads `process.env[<envVar>]`. |
| `--log-level <level>`       | `info` (else `PM_LOG_LEVEL`)                | pino level: `trace` / `debug` / `info` / `warn` / `error` / `fatal`.                                                                                                           |
| `--poll-interval-sec <sec>` | `30`                                        | Polling interval. This is the **correctness floor** — the integrator always finds work by polling DB truth. SSE is only a latency hint that lets it poll sooner.               |

A CLI flag always wins over the corresponding environment variable.

### 4.2 Environment variables

| Variable                 | Used for                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| `PM_PROJECT_ID`          | Fallback for `--project`.                                                    |
| `PM_API_URL`             | Fallback for `--pm-url`.                                                     |
| `PM_API_TOKEN`           | The default token env var (overridable by `--token <envVar>`).               |
| (var named by `--token`) | If you pass `--token MY_TOKEN`, the integrator reads `process.env.MY_TOKEN`. |
| `PM_LOG_LEVEL`           | Fallback for `--log-level`.                                                  |

### 4.3 Per-project `settings.integrator` fields

Stored in PM under `projects.settings.integrator`. The `settings` column is already JSON TEXT — no migration is required. Keys are **snake_case** (matching the sibling `ai_autonomy` / `workflow` / `git` blocks).

| Field                | Type        | Default                      | Required when `enabled` | Notes                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ----------- | ---------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | boolean     | `false`                      | always                  | Master switch. If not `true`, the integrator logs a fatal error and exits cleanly.                                                                                                                                                                                                                                                                                                                                           |
| `verify_command`     | string      | (none)                       | yes                     | Shell command line. Run as `spawn(verify_command, { shell: true, cwd: worktreePath })`. A per-request override is the request's `verifyCmd`.                                                                                                                                                                                                                                                                                 |
| `verify_timeout_sec` | number      | `600`                        | no                      | Kill the verify process after this many seconds (SIGTERM then SIGKILL); the failure is categorized as `verify_timeout`.                                                                                                                                                                                                                                                                                                      |
| `worktree_root`      | string      | (none)                       | yes                     | Absolute path to the directory that owns this integrator's isolated worktree (and its logs). See §5.                                                                                                                                                                                                                                                                                                                         |
| `git_remote`         | string      | `origin`                     | no                      | Remote to fetch from and push to.                                                                                                                                                                                                                                                                                                                                                                                            |
| `git_main_branch`    | string      | `main`                       | no                      | The branch on the remote that the lane maps to.                                                                                                                                                                                                                                                                                                                                                                              |
| `worktree_name`      | string      | `${project.slug}-integrator` | no                      | Base subdirectory name under `worktree_root`. The pool appends `-0`, `-1`, … per slot (§5). Useful when one host runs multiple integrators.                                                                                                                                                                                                                                                                                  |
| `parallelism`        | integer ≥ 1 | `1`                          | no                      | **Phase 7.2.** Number of integrations in flight at once = number of worktree slots in the pool (§5, §13). `1` = exact 7.1 serial behavior. There is **no env var** for this — it lives only here, on the project.                                                                                                                                                                                                            |
| `linked_repos`       | array       | `[]`                         | no                      | **Phase 7.3.** Declares the inner/outer linked repos for cross-repo atomic landing (§14). Empty/absent = single-repo (byte-identical to 7.2). Each entry: `{ name, path, role: "inner"\|"outer", gitlink_parent?, gitlink_path? }`. The integrator requires **exactly one `inner` and one `outer`** entry when this is non-empty; the inner entry carries `gitlink_path` (and `gitlink_parent`).                             |
| `verify_steps`       | array       | `[]`                         | no                      | **Phase 7.5.** The multi-step verify DAG (cheap-first, fail-fast, independent steps parallel). Each entry: `{ id, command, depends_on?, cache_key_inputs?, timeout_sec? }`. Empty/absent → a single synthetic `verify` step running `verify_command` (byte-identical 7.2/7.3/7.4). A non-empty array makes `verify_command` optional. Validated (unique ids / no dangling `depends_on` / no cycles → 400). Deep dive: §16.1. |
| `cache_enabled`      | boolean     | `false`                      | no                      | **Phase 7.5.** Master kill-switch for the verify-result cache. `false` (default) = no lookup, no record (byte-identical to no cache table). Flip `false` for an instant revert. Deep dive: §16.2.                                                                                                                                                                                                                            |
| `cache_mode`         | string      | `"off"`                      | no                      | **Phase 7.5.** `"off" \| "on" \| "shadow"`. `off` = inert; `on` = HIT skips the step / MISS runs + records; `shadow` = always runs + compares + emits `verify.cache_mismatch` + uses the real verdict. Adopt via shadow → on (§16.2). Only consulted when `cache_enabled` is `true`.                                                                                                                                         |

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

**Startup garbage-collection (`gc`).** Before cloning, the pool prunes **stale numbered slots** left over from a previous run with a _larger_ `parallelism`. It scans `worktree_root` for directories matching `${worktree_name}-<digits>` that are not in the current `0..parallelism-1` set and removes them. (Only numeric-suffixed slot dirs are touched; unrelated directories are left alone.) So shrinking `parallelism` from 5 to 3 cleans up `-3` and `-4` on the next start.

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

**Categorization heuristic.** The category is a _hint_, not a contract — the load-bearing artifact is the `logUrl`, which surfaces the raw verify output to the worker. The integrator maps signals to categories as follows:

| Signal                                                                                | Category         |
| ------------------------------------------------------------------------------------- | ---------------- |
| timeout / exit code 124 / killed by SIGTERM / SIGKILL                                 | `verify_timeout` |
| `error[E…]`, or `error:` together with `could not compile`                            | `build_failed`   |
| pytest `FAILED (failures=…` / `= FAILURES =` / `test result: FAILED` / a `FAIL ` line | `test_failed`    |
| `warning:` / eslint / Prettier / clippy markers (with a non-zero exit)                | `lint_failed`    |
| anything else with a non-zero exit                                                    | `other`          |

(Rebase conflicts and push races are detected separately, before/after verify, and map to `conflict` / re-queue respectively — see the design doc §14.6.)

---

## 7. Logging

- The integrator emits **pino JSON to stdout** with ISO 8601 timestamps. For human-readable output, pipe through `pino-pretty` (not bundled — install it ad hoc):

  ```bash
  node packages/integrator-ref/dist/index.js … | npx pino-pretty
  ```

- **Per-attempt verify logs** are written to `${worktree_root}/logs/${attemptId}.log` and surfaced to workers as the request's `logUrl` (a `file://` URI). Log retention/rotation is the **operator's responsibility** (e.g. a logrotate rule or a cron sweep).

- **Exit codes for supervisors:**

  | Code | Meaning                                                                      | Supervisor action                               |
  | ---- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
  | `0`  | Clean shutdown (received SIGTERM/SIGINT, finished current iteration).        | No restart needed.                              |
  | `1`  | Runtime error (e.g. worktree init failed, missing token).                    | Safe to auto-restart.                           |
  | `2`  | Config error (integrator not enabled, missing required field, bad settings). | **Do NOT auto-restart** — fix the config first. |

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
- **Group + incident events (Phase 7.3):** `merge.group.started` / `.member_landed` / `.landed` / `.rejected` and `merge.incident.opened` / `.auto_resolved` / `.human_resolved` (see §14). Unlike the relayed batch markers, these are **PM-emitted** (the group/incident services write the row, then emit). Group/incident frames additionally carry `group_id` / `incident_id` / `orphaned_sha` when present.

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

| Failure                                 | Symptom                                                                                                                                                                 | Recovery                                                                                                                                                      | Operator action                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Integrator crash mid-attempt            | Request stuck `integrating`; no `merge.attempt.completed`; Stage 1 lock TTL expires within ≤5 min                                                                       | On restart the integrator scans stranded `integrating` requests and resets them to `queued` (open attempts → `cancelled`); the lock self-heals via TTL expiry | Restart the process (a supervisor does this on exit code 1). |
| Verify timeout                          | `merge.attempt.completed` with `failureCategory=verify_timeout`; `merge.request.rejected` with `category=verify_timeout`                                                | Automatic: categorize → reject                                                                                                                                | None.                                                        |
| Rebase conflict                         | `merge.request.rejected` with `category=conflict`; `failedFiles` captured from the conflicting paths                                                                    | Automatic: categorize → reject (or, with the resolver enabled, an opt-in headless auto-resolution attempt — see §18)                                          | Worker resolves locally and resubmits.                       |
| Push race                               | `git push` is non-fast-forward after verify passed (main moved); verified tree is stale                                                                                 | Automatic: cancel the attempt, reset request to `queued`, release the lock; the next iteration rebases onto the new main and retries                          | None.                                                        |
| Already-landed / no-op request          | The request's content is already on `main` (landed out-of-band under a different SHA, or a duplicate submission); after rebase the tree is byte-identical to live `main` | Automatic **no-op land**: under the lane lock, the land path detects `HEAD`'s tree == live `main`'s tree (`git diff --quiet`) and records the request `landed` at the **current** `main` SHA **without pushing** — never advancing `main` by an empty commit, never re-applying. A passing attempt is recorded; the linked task's `landed_sha` git_ref points at current `main`. | None (the queue self-clears; nothing to re-apply). |
| Disk full                               | Verify / log write / worktree op fails with `ENOSPC`; rejected as `other` with the system error in `failureReason`                                                      | Automatic reject; integrator cannot make progress until space is freed                                                                                        | **Free disk space** on the integrator host.                  |
| Network drop / PM unreachable           | HTTP calls fail; SSE drops                                                                                                                                              | Retry with exponential backoff; reconcile from DB state on reconnect (poll for in-flight `integrating` request)                                               | None (unless the outage is on the operator's side).          |
| PM crash                                | Every call returns `ECONNREFUSED`                                                                                                                                       | Pause loop, backoff, resume from DB state on reconnect                                                                                                        | Bring PM back up.                                            |
| Task deleted in-flight                  | Request still resolves (`landed`/`rejected`); auto side-effects (git_ref / comment) are silently skipped; structured payload still on the SSE event and the request row | Automatic (`ON DELETE SET NULL` on `taskId`; service checks `taskId !== null`)                                                                                | None.                                                        |
| Verify command missing / non-executable | `spawn` fails with `ENOENT` / `EACCES`; rejected as `other` with the system error in `failureReason`                                                                    | Automatic reject                                                                                                                                              | **Fix `verify_command`** in project settings.                |
| Admin force-cancel mid-verify           | Admin POSTs `/force-cancel`; request → `abandoned` while the integrator is mid-verify                                                                                   | The integrator's next service call returns 409; it bails, kills any running verify, and releases the lock                                                     | None.                                                        |

### 9.1 Phase 7.2 batch failure modes (`parallelism > 1`)

Additional modes when speculative batching is enabled. Pulled from 7.2 design §15.

| Failure                    | Symptom                                                                                                               | Recovery                                                                                                                                                                                                                                         | Operator action                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Worktree pool exhaustion   | All `parallelism` slots leased; queue depth grows; new requests stay `queued` (not picked up)                         | **Backpressure** — requests are neither dropped nor picked up; slots free as members terminate and the next FIFO request is admitted. No data loss.                                                                                              | None (raise `parallelism` if throughput is the bottleneck and the host has capacity).       |
| One slot corrupt mid-batch | A member's git op fails on a corrupt `.git` in its slot                                                               | `pool.repair` rebuilds **that slot only** (delete + re-clone); the member is `resetToQueued` and re-admitted. Other slots/members continue.                                                                                                      | None.                                                                                       |
| Integrator crash mid-batch | In-memory batch lost; lane lock held by the dead process; N requests stuck `integrating`                              | The lane lock TTL-frees in ≤5 min; the next integrator's `acquire` reclaims it. On restart the crash-recovery sweep resets **ALL** `integrating` in the lane → `queued`. **No orphan `main` advance** — a push only happens under the live lock. | Restart the process (supervisor on exit code 1).                                            |
| Per-member verify hang     | One member's verify exceeds `verify_timeout_sec`                                                                      | The **per-member** `runVerify` timeout fires and kills **just that** worktree's verify subtree; `timedOut → category verify_timeout` (real, not retried) → reject + invalidate that member's dependent suffix. Siblings untouched.               | None.                                                                                       |
| Predecessor stale at land  | At land time, live `main` ≠ the expected predecessor SHA, or `push` is `non_fast_forward`                             | **Fast-forward-or-reverify guard**: cancel the attempt, `resetToQueued`, re-admit with the corrected base, re-verify. (Should not occur while holding the lane lock; guarded regardless.)                                                        | None.                                                                                       |
| Transient verify failure   | Verify child never ran (`ENOENT`/`EACCES`) or was killed by a signal the integrator did NOT fire (OOM, operator kill) | **Retry** the same member against the same speculative base, after backoff (**1s / 5s / 15s**, cap 3 retries). Each retry is a fresh attempt row. After the cap, treat as real → reject + suffix invalidation.                                   | None (investigate if it recurs — e.g. a flaky verify command or an under-provisioned host). |

---

## 10. Single-machine, multi-agent guidance

**The rule: `worktree_root` is per-integrator-process, never shared.** Two integrator processes must never point at the same `worktree_root` — they would clobber each other's worktrees and logs. Give each lane its own root.

Recommended `game_one` layout. game_one runs **cross-repo** (Phase 7.3): `rynx` (inner) embedded in
the `game` repo (outer) as a `160000` gitlink at `gitlink_path`. With `linked_repos` declared the
integrator builds **a separate worktree pool per linked repo** (in addition to the base
single-repo pool), each pool sized `parallelism`. The per-repo pool base name is
`${worktree_name}-${role}` (so `…-inner` / `…-outer`), then `-{0..N-1}` per slot. Layout for one
lane, `main`, `parallelism: 3`:

```
/srv/game_one/
  integrators/
    main/                              ← worktree_root for (game_one, main)
      game_one-integrator-0/           ← base (single-repo) pool slot 0 (clone of gitRepoUrl)
      game_one-integrator-1/           ← base pool slot 1
      game_one-integrator-2/           ← base pool slot 2
      game_one-integrator-inner-0/     ← INNER (rynx) pool slot 0 (clone of linked_repos[inner].path)
      game_one-integrator-inner-1/     ← inner pool slot 1
      game_one-integrator-inner-2/     ← inner pool slot 2
      game_one-integrator-outer-0/     ← OUTER (game, holds the gitlink) pool slot 0 (clone of linked_repos[outer].path)
      game_one-integrator-outer-1/     ← outer pool slot 1
      game_one-integrator-outer-2/     ← outer pool slot 2
      logs/                            ← per-attempt logs (shared)
```

At `parallelism: 1` each pool collapses to a single `-0` slot. Raising `parallelism` to N adds
slots `…-{0..N-1}` to every pool; lowering it prunes the now-extra numbered slots on the next
startup (`gc`, §5). **Single-repo (no `linked_repos`)** collapses to just the base pool
(`game_one-integrator-{0..N-1}/`) — exactly the 7.2 layout. The base pool is still cloned and
crash-swept even when `linked_repos` is set; group integration uses the inner/outer pools, the base
pool serves any single-repo (`group_id` null) requests on the same lane (§14, §13.1).

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
6. **Transient retry.** A verify that _never ran_ (spawn failure) or was killed by a signal the integrator did not fire (OOM / operator kill) is retried on the same base with **1s / 5s / 15s** backoff (cap 3). A verify that hits its own `verify_timeout_sec` is a **real** failure (not retried).

`parallelism: 1` is exactly the 7.1 serial loop (a batch of one): one slot, base = live `main`, immediate land — PM-observably identical to before.

### 13.2 Observability

There is **no PM batch table** — the integrator owns batch state in memory and relays observability over SSE. Two mechanisms:

**Tagged existing events.** `merge.request.integrating` and `merge.attempt.started` frames carry `batch_id` and `speculative_position` (the member's 0-based admission index) when batching is active. Absent on 7.1-style frames.

**Four batch-marker events.** The integrator POSTs each marker to a thin relay endpoint and PM re-emits it on the SSE stream (persisting nothing):

- **Endpoint:** `POST /api/v1/projects/{projectId}/merge-batches/events` — **integrator (`ai_agent`) only** (403 for any other caller). The reference integrator wires this automatically (`onBatchEvent` → `postBatchEvent`); a failed POST is logged and never crashes the loop.
- **Markers** (all carry `batchId`):

  | Event                            | Payload                                                                           |
  | -------------------------------- | --------------------------------------------------------------------------------- |
  | `merge.batch.started`            | `{ batchId, resource, memberCount, memberRequestIds[] }`                          |
  | `merge.batch.member_landed`      | `{ batchId, requestId, speculativePosition, landedSha }`                          |
  | `merge.batch.member_invalidated` | `{ batchId, requestId, speculativePosition, reason, failedPredecessorRequestId }` |
  | `merge.batch.completed`          | `{ batchId, landed, rejected, invalidated }` (counts)                             |

The `batchId` is a ULID **minted by the integrator**; PM never generates or persists it. These events are the entire batch-observability contract (the Phase 7.4 dashboard consumes them — there is no batch query API).

### 13.3 Sizing `parallelism`

`parallelism` is bounded by the host's capacity to run N concurrent verify builds (CPU/RAM/disk) and N worktree clones on disk. `game_one` runs `parallelism: 3`. Start small, watch the per-attempt verify logs and host load, and raise it only if the queue is verify-bound. Remember: each slot is a full clone of the repo under `worktree_root` (§5), so disk grows ~linearly with N. With `linked_repos` declared, disk grows ~linearly with `N × (1 + number_of_linked_repos)` — the base pool plus the inner and outer pools each get N slots (§14).

---

## 14. Cross-repo atomicity (Phase 7.3)

A **merge group** binds one merge request per linked repo so they land **as a unit or not at all** — game_one's `rynx` inner Rust workspace and the outer `game` repo that embeds it as a `160000` gitlink. No half-landed gitlink state ever reaches outer `main`. This section is the operator-facing summary; the authoritative spec is `docs/design/phase-7.3-design.md`.

The state is **PM-owned and durable** (unlike the in-memory batch state of §13): two tables, `merge_request_groups` and `merge_incidents`, plus a nullable `merge_requests.group_id`. That is what makes the dangerous middle case — inner landed, outer push failed — _detectable from PM alone, no SSH into the integrator host_.

### 14.1 Declaring linked repos

Set `settings.integrator.linked_repos` on the project (snake_case, sibling of `parallelism`). The integrator requires **exactly one `inner` and one `outer`** entry, or it exits with config code 2. Empty/absent = single-repo (byte-identical to 7.2).

```json
{
  "settings": {
    "integrator": {
      "enabled": true,
      "verify_command": "cargo build --workspace && cargo test --workspace",
      "worktree_root": "/srv/game_one/integrators/main",
      "parallelism": 3,
      "linked_repos": [
        {
          "name": "rynx",
          "path": "/srv/git/rynx.git",
          "role": "inner",
          "gitlink_parent": "game",
          "gitlink_path": "vendor/rynx"
        },
        {
          "name": "game",
          "path": "/srv/git/game.git",
          "role": "outer"
        }
      ]
    }
  }
}
```

- `name` — logical repo name (matches the group member's target repo).
- `path` — the repo's remote: a clone URL or a bare-repo path the integrator can clone from.
- `role` — `"inner"` or `"outer"`. The role is **config-declared and authoritative** (never inferred from git).
- `gitlink_parent` (inner only) — the `name` of the outer repo that embeds this inner.
- `gitlink_path` (inner only) — the path inside the outer working tree where the gitlink/submodule lives (e.g. `vendor/rynx`). The integrator only ever mutates the gitlink **SHA** at this path; it never touches `.gitmodules` (the operator seeds that once).

> `gitRepoUrl` (the top-level project field) still names the **base** single-repo pool's clone source. The linked repos' clone sources are their own `path` entries. All three are cloned under `worktree_root` (§10).

### 14.2 The inner/outer worktree pools

When `linked_repos` is non-empty the integrator builds **one worktree pool per linked repo**, each sized `parallelism`, with base name `${worktree_name}-${role}` (so `…-inner` / `…-outer`) and slots `-{0..N-1}` (the §10 layout). A group integration leases **one correlated pair** — one inner slot + one outer slot — for the whole assemble → verify → land cycle, and releases both exactly once when it resolves. If either pool is exhausted, the group stays `forming` (backpressure) and retries next pass; nothing is half-acquired.

### 14.3 The atomic-land protocol (inner-then-outer, under the lane lock)

A group is picked up and integrated **under the same `(project, resource)` lane lock** the integrator already uses — there is no second lock. The cycle:

1. **Bind members → roles.** Each member's identity ref (commitSha-preferred, else branch) is resolved in each linked repo's clone; the member binds to the repo whose clone resolves it, and its role comes from config. An ambiguous binding (resolves in both repos, or neither) rejects the group cleanly from `forming`.
2. **Assemble** (no push, no PM mutation yet): rebase the inner member onto live inner `main` → `Ri`; rebase the outer member onto live outer `main`; commit the outer gitlink at `gitlink_path` to `Ri` → `Ro`; **materialize** the inner@`Ri` sources into the outer working tree at `gitlink_path` so the outer verify actually sees them.
3. **Pick up** (`forming → integrating`, flips members) and start a per-member attempt.
4. **Verify the assembled state**: run the inner and outer verify commands **concurrently**, both against the assembled checkout, and AND the results. Any repo failing → reject the **whole** group (nothing pushed, no incident).
5. **Land**, under the lock, with a single pre-push drift re-check on both live mains:
   - **PUSH 1 (inner):** fast-forward inner `main` → `Ri`.
   - **PUSH 2 (outer):** fast-forward outer `main` → `Ro` (gitlink → `Ri`).

Both pushes are verify-gated fast-forwards; a non-fast-forward push is _rejected_ by git, never forced. The lane lock spans both pushes; there is deliberately no second outer-drift recheck between them (the FF push itself gates outer drift).

### 14.4 The three failure points

- **(a) Inner push fails** → reject the whole group cleanly. The outer is **never touched**, nothing landed.
- **(b) Outer push fails _after_ the inner landed → THE ORPHAN.** Outer `main` is unchanged (the push rejected → no half-landed gitlink). The integrator marks the inner member `orphaned`, opens a durable `merge_incident` (`orphaned_inner`, recording the orphaned inner SHA), rejects the outer member, and marks the group `partially_landed`. This is the only case that leaves a repo advanced relative to the other — and it is fully recorded in PM.
- **(c) Assembled verify fails** → reject the whole group. Nothing pushed, no incident.

### 14.5 Orphaned-inner incident model + recovery

An open `orphaned_inner` incident means: inner `main` is at the orphaned SHA `O`, and the outer gitlink references some earlier inner SHA. It is the **sole durable record** of a real orphan — recovery is **PM-keyed** (it queries open incidents), never reconstructed from git SHA comparison.

Recovery runs opportunistically on a later integration pass, under the lane lock:

- **Auto-rollforward** (the common path): the incident is **reconcilable** when the current outer gitlink is an _ancestor_ of `O` (checked in the inner repo). The integrator assembles the roll-forward outer tree (gitlink → `O`, inner sources materialized), **verifies it** (the safety gate), then does a verify-gated fast-forward push of outer `main`, and resolves the incident `auto_resolved`. Outer `main` advances **only** by a verified, fast-forward push.
- **Human escalation**: if the current gitlink is **not** an ancestor of `O` (divergent intervening outer history), or the ancestry check errors, or the assembled roll-forward tree fails verify — the integrator **escalates**: it logs an escalation warning and **leaves the incident `open`** (it never auto-mutates). A human lands a reconciling change and closes it `human_resolved` (admin-only resolve). Transient conditions (pool exhaustion, outer drift, a push race) are _deferred_ instead of escalated — the incident stays open and the next pass retries.

Operators detect incidents from PM alone:

```
GET /api/v1/projects/{projectId}/merge-incidents?state=open
GET /api/v1/merge-incidents/{id}
```

(or the worker MCP tools `pm_list_merge_incidents` / `pm_get_merge_incident`). An open incident is also surfaced as a `merge_incident` comment on the linked task and a `merge.incident.opened` SSE event.

### 14.6 Cross-repo failure modes

Additional modes when `linked_repos` is declared. Pulled from 7.3 design §11.

| Failure                                                            | Symptom                                                                                                                   | Recovery                                                                                                                                                                                                                                                                                     | Operator action                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Inner push race                                                    | `non_fast_forward` on PUSH 1 (another lander advanced inner main)                                                         | The **whole group** rejects cleanly; outer never touched; it re-integrates as a unit later. `merge.group.rejected`.                                                                                                                                                                          | None.                                                                                                     |
| Outer push race / network drop after inner landed (**the orphan**) | PUSH 2 fails after the inner landed; group → `partially_landed`; a `merge.incident.opened` event; member → `orphaned`     | Auto-rollforward on a later pass when the gitlink is an ancestor of the orphan (verify-gated outer FF push) → incident `auto_resolved`.                                                                                                                                                      | None (watch for incidents that stay `open` — those need a human).                                         |
| Un-reconcilable orphan                                             | Recovery finds the gitlink is **not** an ancestor of `O` (divergent outer history), or the roll-forward tree fails verify | **Escalate**: incident stays `open`, comment posted, outer untouched.                                                                                                                                                                                                                        | **Human lands a reconciling change**, then the incident is resolved `human_resolved` (admin-only).        |
| Assembled verify fails                                             | A repo's verify exits non-zero on the assembled tree                                                                      | The whole group rejects (`merge.group.rejected`); nothing pushed, no incident.                                                                                                                                                                                                               | Worker fixes the failing repo and resubmits the group.                                                    |
| Ambiguous member→role binding                                      | A group member's ref resolves in both linked repos or neither                                                             | The group rejects from `forming` with the binding reason (no worktrees leased).                                                                                                                                                                                                              | Worker resubmits with members whose `commit_sha` (preferred) or `branch` resolves unambiguously per repo. |
| Stranded group (crash between PUSH 1 and the incident write)       | A group left `integrating` by a crash with **no** open incident — the §6.4 window                                         | On startup the integrator's **stranded-group sweep** resets the whole group (+ members) to `forming` to re-integrate; the inner re-push is a fast-forward no-op and the outer push completes the atom. A stranded group **with** an open incident is left for orphan recovery (never reset). | Restart the process (supervisor on exit code 1).                                                          |
| Inner/outer pool exhaustion                                        | A correlated slot is unavailable                                                                                          | **Backpressure** — the group stays `forming` and retries when a slot frees.                                                                                                                                                                                                                  | None (raise `parallelism` if groups are throughput-bound).                                                |

Every row preserves the prime invariant: **outer `main` is never advanced to a gitlink whose assembled tree has not passed verify** — not in land, not in recovery.

### 14.7 Worker flow (MCP)

A worker submits each repo's change as a normal merge request (`pm_request_merge`, giving each member a `branch`/`commit_sha` and `verify_cmd`), then binds them with `pm_request_merge_group` (`member_request_ids`, ≥2, all already-queued and ungrouped). The group lands or fails atomically; the worker subscribes to `merge.group.landed` / `merge.group.rejected` with the returned group id. `pm_get_merge_group` reports the group + member statuses.

---

## 15. Observability + Break-glass (Phase 7.4)

Phase 7.4 makes the train **legible** (a dashboard that answers "what's wrong" in 60 seconds), **recoverable** by a human via the UI (five break-glass overrides — no DB surgery, no SSH), **accountable** (a dedicated audit log), and **self-alerting** (three `train.*` alerts delivered both in-app and out-of-band to Discord). This section is the operator-facing summary; the authoritative spec is `docs/design/phase-7.4-design.md` (incl. §14 implementation deviations). Three new PM-owned tables back it: `audit_log`, `integrator_health`, and `train_state` (all one-row-per-`(project, resource)`-lane except `audit_log`, which is append-only rows).

### 15.1 The dashboard

A human-facing web dashboard, reachable in the SPA at:

- **`/projects/{projectId}/train`** — the train dashboard: queue depth, in-flight batches/groups with per-member state, integrator heartbeat freshness ("last heard 47s ago"), recent lands/rejects, last-24h time-to-land p50/p95/p99, verify success rate, abandon rate, worktree-pool utilization, and SLO compliance per lane.
- **`/projects/{projectId}/train/audit`** — the audit-log view + the break-glass controls (admin-gated UI; the pause/resume/force-\* buttons render only for admins).
- The **per-request timeline** (queued → integrating → every verify attempt with its log link → landed/rejected/orphaned/overridden) is a component reachable from the dashboard's in-flight/recent rows, backed by `GET /api/v1/merge-requests/{id}/timeline`.

All dashboard reads are **read-only observability** (`requireAuth` — any authenticated user can view), EXCEPT the audit log (`requireAdmin`). Only the overrides are gated to admins. The dashboard data APIs:

| Method | Path                                                                                                                              | Authz                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| GET    | `/api/v1/projects/{projectId}/train/metrics?resource=`                                                                            | `requireAuth`                 |
| GET    | `/api/v1/projects/{projectId}/train/in-flight?resource=`                                                                          | `requireAuth`                 |
| GET    | `/api/v1/projects/{projectId}/integrator/health?resource=`                                                                        | `requireAuth`                 |
| GET    | `/api/v1/projects/{projectId}/train/state?resource=`                                                                              | `requireAuth`                 |
| GET    | `/api/v1/merge-requests/{id}/timeline`                                                                                            | `requireAuth`                 |
| GET    | `/api/v1/projects/{projectId}/audit-log` (filters: `userId`, `action`, `targetType`, `targetId`, `from`, `to`, `page`, `perPage`) | `requireAuth && requireAdmin` |

Metrics are computed **on-read** (no rollup table, no background job) — always fresh. The 24h window is a JS-computed ISO cutoff. Reading the metrics or health GET also drives the on-read alert evaluation (§15.4) as a side effect.

### 15.2 Integrator heartbeat + health channel

The integrator POSTs a **liveness heartbeat** on a fixed interval **regardless of whether it holds a lane lock or is idle** — this is the dedicated health channel that works exactly when lock-derived freshness is blind (an idle integrator holds no lock). PM upserts one `integrator_health` row per lane and tracks `last_seen_at`.

- **Endpoint:** `POST /api/v1/projects/{projectId}/integrator/heartbeat` — **integrator (`ai_agent`) only** (403 for any other caller). Body (snake_case): `{ resource?, status: "idle"|"integrating", pool_utilization: { size, leased }, in_flight?: { requests, batches, groups }, version }`. The reference integrator wires this automatically: one beat fires immediately on boot (so "last heard" is fresh the moment it comes up), then every `heartbeat_interval_sec` on a timer. Fire-and-forget — a failed heartbeat POST never breaks the integrator loop.
- **Config:** `settings.integrator.heartbeat_interval_sec` (default `30`, min `5`). This sets the integrator's emit cadence.
- **Staleness:** PM's freshness threshold is a fixed **`HEALTH_STALE_MS = 90s`** (the default 30s interval × 3 tolerance = two missed beats of slack). A lane whose `now - last_seen_at > 90s` is reported `healthy: false`; a lane that has never heartbeated reports `status: "never_seen"`, `last_seen_at: null` (distinguishing "never started" from "died"). Staleness is computed **on-read** in `GET integrator/health` and in the metrics GET (which embeds the health view) — there is no background sweep. (Note: `heartbeat_interval_sec` is consumed by the integrator's emit cadence; PM's 90s staleness threshold is currently fixed and does not yet read the per-project override.)

The dashboard renders "last heard Ns ago" from the derived `staleness_ms`, greying the pool-utilization numbers when the heartbeat is stale (they are only as fresh as the last beat).

### 15.3 The five break-glass overrides

All six are **admin-only HUMAN operator actions** (gated on the existing `admin` role via `requireAdmin` — NOT the `ai_agent` integrator gate; there is no `operator` role yet — that is Phase 7.6). **Every override writes exactly one `audit_log` row in the same database transaction as its state change** — the audit row is the accountability record and is the one thing that is never skipped.

| Override               | Endpoint                                                                 | Body                     | Reason                      | What it does                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------ | ------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pause**              | `POST /api/v1/projects/{projectId}/train/pause`                          | `{ resource?, reason? }` | optional                    | Sets the lane `paused`. The integrator stops admitting NEW work; in-flight members finish cleanly (§15.5). Idempotent no-op (no duplicate audit) when already paused.                                                                                                                                             |
| **Resume**             | `POST /api/v1/projects/{projectId}/train/resume`                         | `{ resource?, reason? }` | optional                    | Sets the lane `running`. Idempotent no-op (no audit) when already running.                                                                                                                                                                                                                                        |
| **Force-release lock** | `POST /api/v1/projects/{projectId}/merge-locks/{resource}/force-release` | `{ reason? }`            | optional                    | HARD-clears a stuck lane lock (for a dead integrator, without waiting out the 5-min lease TTL). Does NOT promote the queue head and does NOT touch in-flight merge_requests. Emits the existing `merge.lock.released` (with `forced: true`).                                                                      |
| **Force-land**         | `POST /api/v1/merge-requests/{id}/force-land`                            | `{ landedSha, reason }`  | **REQUIRED** (400 if empty) | **THE R1 override** — see §15.3.1.                                                                                                                                                                                                                                                                                |
| **Force-reject**       | `POST /api/v1/merge-requests/{id}/force-reject`                          | `{ reason }`             | **REQUIRED** (400 if empty) | Rejects a stuck `integrating` request on policy grounds (e.g. an integrator died mid-verify and you want the lane to clear rather than wait for crash-recovery to re-queue it). Completes/synthesizes the attempt as `failed`/`policy`, posts the `merge_rejection` comment, writes one `force_reject` audit row. |
| **Force-cancel**       | `POST /api/v1/merge-requests/{id}/force-cancel`                          | `{ reason? }`            | optional (UI requires it)   | Abandons a stuck request — valid from **`queued` OR `integrating`** → `abandoned`. This is the queued-state escape hatch that force-reject/force-land (both `integrating`-only) cannot reach — use it to clear a stale queued request whose content was hand-landed out-of-band. Writes one `force_cancel` audit row; idempotent no-op (no audit) when already `abandoned`. |

The audit actions recorded for the train are: `pause`, `resume`, `force_release_lock`, `force_land`, `force_reject`, `force_cancel` (the six overrides) plus `land` and `reject` (the integrator's natural verified outcomes — so the audit log is a complete record, not just overrides). Every audit row carries: `actor`, `action`, `target_type` (`merge_request`/`merge_lock`/`train`/`merge_group`), `target_id`, `reason`, `metadata_before`/`metadata_after`, and a timestamp. The audit log is **append-only** (no update, no delete; the table has no `updatedAt`) and queryable by user / action / target / time-window. Each override also emits `audit.recorded` on the SSE stream so the dashboard's audit view updates live.

#### 15.3.1 Force-land — the R1 verify-gate override (the single most dangerous control)

Force-land is the ONE place the "verify before fast-forward" invariant is **deliberately overridden by a named human**. It lands an `integrating` request **WITHOUT running verify**.

- **Admin-only + reason-required** (both 400 if absent/empty). The reason is the load-bearing accountability datum — _why_ a human bypassed verify.
- **Precondition:** the request must be `integrating` (force-landing `landed` is an idempotent 200 no-op; `queued`/`rejected`/`abandoned` → 409). A **grouped member → 409** (a cross-repo group member can only land via the group, never individually).
- **What it does:** completes (or synthesizes, if none is open) the request's attempt as `passed` with an `overridden` marker, sets the request `landed` with the operator-supplied `landedSha`, attaches the `landed_sha` git_ref to the linked task — **identical durable side-effects to a normal land**, the ONLY difference being that no verify gated it — and writes the mandatory `force_land` audit row (the sole record that R1 was bypassed, by whom, and why). Emits `merge.request.landed` with `overridden: true` so the dashboard badges it as a force-land.
- **CRITICAL operator contract — PM records landed; the operator advances git separately.** Force-land does **NOT push to git**. Like the normal land, PM only records the PM-side `landedSha` it was given; **PM never runs git** (only the integrator does). The `landedSha` in the body is the operator's **assertion** of the SHA `main` is (or will be) at. Therefore PM-state and the git remote can diverge: PM says `landed` regardless of whether remote `main` actually points at that SHA. **A force-land is only correct after (or paired with) the operator manually fast-forwarding the remote `main` to the asserted `landedSha`.** PM cannot and does not verify the remote advanced. In practice, pair force-land with **force-release-lock** or **pause** to stop a live integrator racing your manual push.

### 15.4 Alerts — dual delivery (in-app SSE/banner + outbound Discord)

Three `train.*` alert events fire **edge-triggered, on-read** (once per breach episode; re-arm when the condition clears). There is no background sweep — evaluation happens when a dashboard metrics/health read runs (and the integrator's heartbeat POST re-arms its own lane's health latch). **Accepted tradeoff:** a dead integrator with nobody watching the dashboard delays the unhealthy alert until the next read of a metrics/health path.

| Event                        | Trigger                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `train.integrator_unhealthy` | The lane's heartbeat is stale: `now - last_seen_at > 90s` (`HEALTH_STALE_MS`).                                                                   |
| `train.stuck`                | Oldest `queued` request's age `> 600s` (10 min) **AND** in-flight `== 0` **AND** the lane is **not paused** (a paused train is held, not stuck). |
| `train.abandon_rate_high`    | 24h abandon ratio `> 0.3` **AND** resolved-request sample `>= 5` (don't alert on 1-of-1).                                                        |

Each alert is delivered **two ways**, both firing once per episode in lockstep:

- **(a) In-app:** the `train.*` event rides the existing `/api/v1/events` SSE stream; the dashboard raises a banner (`train.integrator_unhealthy` flashes the health panel red; `train.stuck`/`train.abandon_rate_high` raise a warning).
- **(b) Out-of-band Discord:** a minimal outbound webhook listener POSTs a Discord-shaped `{ content }` message to the project's configured webhook URL. Fire-and-forget — a failed Discord POST never affects the read that emitted the alert.

**Config** (`settings.webhooks`, sibling of `settings.integrator`):

```json
{
  "settings": {
    "webhooks": {
      "discord_url": "https://discord.com/api/webhooks/.../...",
      "alerts_enabled": true
    }
  }
}
```

`discord_url` is the Discord webhook URL the three alerts POST to (a non-Discord endpoint that accepts the same `{ content }` shape works too, but Discord is the documented default). `alerts_enabled` defaults to on — set it `false` to silence the outbound POST without removing the URL. With no `discord_url` configured, only the in-app (SSE/banner) half fires.

### 15.5 Pause semantics

> **Pause means: the integrator stops picking up NEW work, but finishes the in-flight batch/group cleanly. It is NOT a kill.**

The integrator reads the lane's `train_state` (`GET train/state`) **before admitting any new request** — once per drain pass, not per member. While `paused`:

- It admits NOTHING new — no new batch starts, no new lock is acquired, the lane drains to idle and stays parked.
- Members already admitted to the in-flight batch/group **continue to completion** (verify → land/reject), and the lane lock releases on drain exactly as if the queue were empty (the no-abort invariant).
- **Recovery still runs while paused:** an open orphaned-inner incident is in-flight cross-repo work, so its rollforward sweep keeps running — only NEW forming-group admission is suppressed.

The read is **fail-open**: if the integrator can't reach `GET train/state` (transient error), it treats the lane as running. A paused train it can't read is far less dangerous than a wedged train that can't progress because a transient GET error read as "paused". The integrator polls train-state at its poll cadence and additionally consumes `train.paused`/`train.resumed` SSE events as a latency hint (poll remains the correctness floor).

### 15.6 SLO config (recorded, not enforced)

Per-project SLO targets are recorded under `settings.integrator.slo` and surfaced as compliance verdicts on the dashboard. Nothing acts on a breach (enforcement is a later phase). All three targets are individually optional:

```json
{
  "settings": {
    "integrator": {
      "slo": {
        "target_p95_time_to_land_sec": 600,
        "target_verify_success_rate": 0.9,
        "target_abandon_rate": 0.1
      }
    }
  }
}
```

Compliance is computed on-read as part of the metrics bundle: measured p95 ≤ target (seconds), measured verify-success ≥ target, measured abandon ≤ target. A dimension with no configured target (or no measured data) is omitted; `overall_compliant` is the AND of the configured dimensions, or null when none are set. SLO targets are written via the existing `PATCH /api/v1/projects/{id}` (no new endpoint) — nest them in `settings.integrator.slo`.

---

## 16. Smart verification (Phase 7.5)

Phase 7.5 makes verify stop being a fixed cost. It buys you two levers, both configured per project in `settings.integrator` and both **opt-in** (an unconfigured deployment is byte-identical to 7.2/7.3/7.4):

1. **A multi-step verify DAG** (`verify_steps`) — cheap stages first (format → lint → typecheck), expensive last (unit → integration), with **fail-fast** (the first failing step short-circuits the rest) and **independent steps running in parallel**. A change that breaks `lint` fails in seconds instead of after the full suite.
2. **A PM-owned verify-result cache** (`verify_cache`) — an identical re-verify (same tree, same step config) SKIPS the run and reuses the cached verdict. This collapses the cost of re-verifying a tree a sibling/predecessor already verified, and of a re-submitted unchanged tree.

The pipeline runs **inside** the existing per-member verify seam (`runVerifyTask`) — the scheduler (admit / rebase / land / suffix-invalidate / retry / kill) is unchanged. The cross-repo assembled verify (§14) runs the pipeline per repo, AND-combined; group orphan-recovery runs cache-OFF.

The authoritative spec is `docs/design/phase-7.5-design.md` (including §13, the post-ship deviations — read it before relying on the wire formats below). Two new PM tables back this: `verify_cache` (migration `0015`) and a nullable JSON `merge_attempts.steps` column (migration `0016`).

### 16.1 Configuring the verify DAG

`settings.integrator.verify_steps` is an array of step objects:

| Field              | Type        | Default                              | Notes                                                                                                                                                                        |
| ------------------ | ----------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | string      | (required)                           | Unique step id within the array. Cited by `depends_on` and by the cache key / timeline.                                                                                      |
| `command`          | string      | (required)                           | Shell command line, run as `spawn(command, { shell: true, cwd: worktreePath })`. Exit 0 = pass.                                                                              |
| `depends_on`       | string[]    | `[]`                                 | Predecessor step ids. This step only starts once every predecessor has **passed**. Roots (empty `depends_on`) form the first wave.                                           |
| `cache_key_inputs` | string[]    | `[]`                                 | Operator-declared out-of-tree inputs whose change should invalidate this step's cached verdict (toolchain version, lockfile hash, env marker). See §16.2 — **load-bearing.** |
| `timeout_sec`      | integer ≥ 1 | (falls back to `verify_timeout_sec`) | Per-step timeout. The step's process is killed (SIGTERM then SIGKILL) past this bound and the timeout is a real `fail` verdict.                                              |

**Validation (config-time → 400).** The `PATCH /projects/{id}` route validates `verify_steps` and rejects with `400 VALIDATION_ERROR` on:

- **Duplicate ids** — every `id` must be distinct.
- **Dangling `depends_on`** — every `depends_on` entry must resolve to a real `id` in the same array.
- **Cycles** — the `depends_on` graph must be acyclic (checked via Kahn's topological sort, which also catches a self-loop).

An **empty/absent** array is valid — it falls back to a single synthetic `verify` step running `verify_command` (the exact 7.2/7.3/7.4 behavior). A **non-empty** `verify_steps` makes `verify_command` optional (a steps-only project with `worktree_root` is valid without `verify_command`); the integrator re-validates the DAG on startup and exits with code 2 on a bad config.

**Sample multi-step PATCH body** (a cheap-first `format → {lint, typecheck} → unit` DAG; `lint` and `typecheck` run in parallel after `format`, `unit` only after both pass):

```json
{
  "settings": {
    "integrator": {
      "enabled": true,
      "worktree_root": "/srv/game_one/integrators/main",
      "verify_steps": [
        { "id": "format", "command": "cargo fmt --check", "cache_key_inputs": ["rustc-1.81.0"] },
        {
          "id": "lint",
          "command": "cargo clippy --workspace -- -D warnings",
          "depends_on": ["format"],
          "cache_key_inputs": ["rustc-1.81.0"]
        },
        {
          "id": "typecheck",
          "command": "cargo check --workspace",
          "depends_on": ["format"],
          "cache_key_inputs": ["rustc-1.81.0"]
        },
        {
          "id": "unit",
          "command": "cargo test --workspace",
          "depends_on": ["lint", "typecheck"],
          "cache_key_inputs": ["rustc-1.81.0", "pnpm-lock:sha256:abcd"],
          "timeout_sec": 900
        }
      ]
    }
  }
}
```

(With `verify_steps` set, `verify_command` is optional. To keep the legacy single-command behavior, omit `verify_steps` and keep `verify_command` — see §4.3.)

### 16.2 Enabling and adopting the cache — the shadow → on discipline

**The cache key.** A cache row is valid for a step **iff** the strict 5-tuple `(project_id, resource, tree_sha, step_id, step_config_sha)` matches exactly — **no fuzzy match, no nearest-neighbor.**

- `tree_sha` is **content-addressed** — the git _tree_ SHA of the rebased member (`resolveRef("<commit>^{tree}")`, NOT the commit SHA, which carries a committer timestamp and would dead-cache). Any one-byte source change → a different tree → a MISS. This is git's own invariant, not ours.
- `step_config_sha = sha256(JSON.stringify({ command, cache_key_inputs: sorted }))` — the fingerprint of everything else that affects the verdict. Change the command or a declared input → a MISS. (`depends_on`, `timeout_sec`, and `id` are deliberately **not** in this hash.)
- There is **no TTL** — a content-addressed row is correct forever for its exact key, so nothing goes stale (see §16.4 for the manual cleanup escape hatch).

**The kill-switch + the three modes.** `cache_enabled` (default `false`) is the master switch. When `cache_enabled: true`, `cache_mode` governs how the cache is used:

| `cache_mode` | Lookup?            | On HIT                                                                                                                                                      | On MISS                       | Latency win?                                  |
| ------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------- |
| `off`        | no                 | — (never looks up)                                                                                                                                          | run the step, no record       | none (inert — same as `cache_enabled: false`) |
| `on`         | yes                | **skip the run**, reuse the cached verdict                                                                                                                  | run the step, then **record** | yes (a hit skips the run)                     |
| `shadow`     | yes (compare only) | **run the step anyway**, compare the real verdict to the cached one, emit `verify.cache_mismatch` on a discrepancy, **always use the REAL verdict**, record | run the step, then **record** | none (shadow always runs — that is the point) |

**The adoption procedure (load-bearing — follow it in order):**

1. **Declare `cache_key_inputs` honestly, per step.** List every out-of-tree input whose change should invalidate that step's verdict: the toolchain version (`"rustc-1.81.0"`), the relevant lockfile hash (`"pnpm-lock:sha256:…"`), any environment marker (`"ci-image:2026-05"`). The `tree_sha` already captures every _in-tree_ dependency for free; `cache_key_inputs` is how you capture the _out-of-tree_ ones. **This is the irreducible operator responsibility — the system cannot know about an input you do not declare.**
2. **Set `cache_enabled: true` and `cache_mode: "shadow"`** (via `PATCH /projects/{id}`). Shadow runs every step for real — zero latency win — but compares each verdict against any cached row.
3. **Run shadow over a representative window** (a span that exercises your real change mix). Watch for `verify.cache_mismatch` — the **SSE event / dashboard banner**, NOT the metric (see §16.3 — the `cache_mismatches` metric is hardcoded 0).
4. **Zero mismatches over the window → flip `cache_mode: "on"`.** Now hits skip the run and you cash in the latency. A clean shadow window is your evidence that the declared key is correct.
5. **Keep `cache_enabled` as the kill-switch.** If a correctness concern ever surfaces in production, set `cache_enabled: false` for an instant, zero-risk revert (the integrator re-reads settings on its next pass and the cache goes inert).

> **The honest limitation — read this before trusting `on`.** In `cache_mode: on`, the cache is _exactly as correct as the operator's declared `cache_key_inputs`._ The `tree_sha` captures every in-tree dependency, and `step_config_sha` captures every input you **declared** — but a step whose verdict depends on an **undeclared** out-of-tree input (a global env var, an installed binary, an ambient service version you did not list) **can false-pass on a stale cache.** There is no way for the system to know about an undeclared dependency — that knowledge lives only in your head. The system does **not** claim to be structurally safe under arbitrary undeclared inputs. Its answer is the shadow mode: **run in shadow first, and any undeclared-input gap manifests as a `verify.cache_mismatch` before you flip to `on`.** Declare your inputs, prove it with shadow, then trust. Honest declaration is the part the system cannot do for you.

### 16.3 Reading the new observability

The train dashboard gains a **verify / cache block** (cache-hit-rate, time-saved, per-step pass rates) and the **per-request timeline** (`GET /api/v1/merge-requests/{id}/timeline`) gains per-step rows. A debug **`GET /api/v1/projects/{projectId}/verify-cache`** lists cache rows for inspection — filterable by `?resource=&step_id=&result=&page=&perPage=`, readable by **any authenticated user** (the same auth level as the metrics GET; not admin-only, not integrator-only).

**Pin the wire-format reality — the casing differs by surface, deliberately:**

- **`metrics.verify` is SNAKE_CASE.** The on-read metrics bundle (`GET .../train/metrics`) ships the `verify` sub-block as:

  ```json
  {
    "verify": {
      "cache_enabled": true,
      "cache_mode": "on",
      "cache_hit_rate": { "ratio": 0.62, "hits": 124, "lookups": 200 },
      "time_saved_ms": 845000,
      "per_step": [
        {
          "step_id": "lint",
          "runs": 40,
          "cached": 60,
          "pass_rate": 0.95,
          "avg_duration_ms": 4200,
          "fail_count": 2
        }
      ],
      "cache_mismatches": 0
    }
  }
  ```

- **`timeline.steps[]` is CAMELCASE.** The per-request timeline ships each step record (round-tripped from `merge_attempts.steps`) as:

  ```json
  {
    "steps": [
      {
        "stepId": "lint",
        "outcome": "pass",
        "cached": true,
        "durationMs": 0,
        "treeSha": "a1b2c3…",
        "stepConfigSha": "ff00…",
        "logUrl": "file:///…/attempt.log"
      }
    ]
  }
  ```

Do not conflate the two: `metrics.verify.per_step[].step_id` (snake) vs `timeline.steps[].stepId` (camel) is the same field name in two intentionally different casings.

> **`cache_mismatches` in the metrics bundle is HARDCODED 0.** The shadow mismatch is a non-persisted SSE relay (`verify.cache_mismatch`), so the on-read metric — which derives every other field from durable rows — has nothing to count and always reports `0`. **The live shadow-mismatch signal is ONLY the `verify.cache_mismatch` SSE event (the dashboard banner).** When you validate a shadow window (§16.2 step 3), you watch the SSE event / dashboard banner, **not** the `cache_mismatches` metric.

### 16.4 Failure and operational notes

- **Cache I/O is best-effort and never fatal.** A cache lookup that throws is treated as a **MISS** (the step just runs); a record/emit that throws logs a warning and continues. Cache I/O **never fails a member and never blocks a land** — the worst case is a missed cache hit, i.e. a re-run.
- **The kill-switch is the instant revert.** `cache_enabled: false` makes the cache inert on the integrator's next settings read — no restart needed, zero risk.
- **Per-step fail-fast.** A cheap-step failure short-circuits the pipeline: later steps never start and are **absent from the timeline** (the timeline shows only the steps that actually ran up to and including the failing one). The member rejects citing the specific step that failed.
- **A hung step is bounded by `timeout_sec`** (falling back to `verify_timeout_sec`). A timed-out step is a real `fail` verdict and **is** cacheable — a tree+step that deterministically times out should not be re-run on every encounter.
- **A DAG cycle is rejected at config-time** (`400`) — you cannot save a cyclic `verify_steps`; the integrator also re-checks defensively and fails the pipeline if a cycle somehow reaches it.
- **Orphan-recovery runs cache-OFF.** The R1 roll-forward verify (§14.5) runs the pipeline with no cache context — zero false-pass risk on the recovery gate.
- **No TTL / manual cleanup.** Content-addressed rows never go stale, so there is no automatic eviction. If the `verify_cache` table ever grows large, the operator's escape hatch is a manual age-based delete:

  ```sql
  DELETE FROM verify_cache WHERE created_at < '2026-01-01T00:00:00.000Z';
  ```

  (The debug GET in §16.3 shows the current rows for sizing.)

---

## 17. Runbooks (agent quick-reference)

Terse, copy-paste procedures. `{id}` = a merge_request ULID; `{pid}` = project ULID. Auth: a logged-in admin can run the `fetch` snippets from the dashboard tab's devtools console (rides the session cookie); otherwise send `Authorization: Bearer <admin-token>`.

### 17.1 Clear a stale / hand-landed queued request

Symptom: a `queued` (or `integrating`) request whose content is already on `main` (landed out-of-band), or that must not be picked up. The integrator's `ai_agent` identity **cannot** kill it (`cancel` is submitter-or-admin → 403). Two paths:

- **Submitter agent** (session under the request's `submittedBy`): `pm_cancel_merge_request({ id })`.
- **Admin** (no submitter session): force-cancel — works on `queued` AND `integrating`.
  - Dashboard: `/projects/{pid}/train/audit` → **Force-cancel…** → paste id + reason.
  - Or console:
    ```js
    for (const id of ["{id1}", "{id2}"]) {
      const r = await fetch(`/api/v1/merge-requests/${id}/force-cancel`, {
        method: "POST", headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reason: "content hand-landed out-of-band; clearing stale queued entry" }),
      });
      console.log(id, r.status, await r.text());
    }
    ```
  - Result: `status: "abandoned"`, one `force_cancel` audit row. Do NOT use force-reject/force-land here — both are `integrating`-only (→ 409 on a queued request).

Note: the daemon will not re-apply an already-landed request — at land it detects the rebased tree == live `main` and records a no-op land (§9). Abandoning is still preferred so the queue reflects reality.

### 17.2 First daemon bring-up

The "submit and walk away" contract requires a running integrator — PM never spawns builds. One process per `(project, resource)` lane.

1. Project config (admin, once): `PATCH /api/v1/projects/{pid}` with `gitRepoUrl` (top-level) + `settings.integrator` = `{ enabled: true, verify_command, worktree_root }` (see §4).
2. Need a PM `ai_agent` token (NOT a human token) for the integrator.
3. Build + run on the integrator host:
   ```bash
   pnpm install && pnpm --filter @pm/integrator-ref build
   PM_API_TOKEN=<ai_agent token> \
   node packages/integrator-ref/dist/index.js --project {pid} --resource main --pm-url http://<pm-host>:3000
   ```
4. Verify: submit a test merge request, watch `GET /api/v1/events?project_id={pid}` for `merge.request.queued → .integrating → merge.attempt.* → merge.request.landed`, and confirm a `landed_sha` git_ref on the linked task.

### 17.3 Cross-repo changes MUST be grouped

A change spanning linked inner+outer repos must be submitted as ONE group, never two bare `pm_request_merge` calls. Ungrouped pairs defeat atomicity and can land a regressing outer gitlink. Worker: submit each repo's request, then bind with `pm_request_merge_group`; watch with `pm_get_merge_group`. The integrator lands the group inner-first-then-outer under one lane lock (§14).

---

## 18. Intelligent conflict resolution (Phase 7.6)

Phase 7.6 lets the train **attempt to resolve a textual rebase conflict for you** before kicking the change back to a human. When the integrator rebases a request onto live `main` and hits a textual conflict, instead of rejecting straight back to the worker it may — behind an opt-in flag — spawn a **bounded headless resolver** (a `claude -p` session in an isolated worktree) to reconcile the two intents, run the **real verify gate** on the result, and resubmit it as a **linked new merge request** (tagged `resolved_from = <originalId>`). If the resolver can't produce a clean, verify-passing tree within its budget, the conflict is handed back along an **escalation ladder** (origin author → human). No proven work is ever discarded — the original commit stays intact — and `main` is only ever advanced by the normal verify-gated land path.

This is **opt-in**. With `settings.integrator.resolver.enabled = false` (the default) the train is **byte-identical to 7.5**: a conflict rejects exactly as before, zero resolution rows are written, zero resolution events fire. This section is the operator-facing summary; the authoritative spec is `docs/design/phase-7.6-design.md`.

Backing PM state (migration `0017`): a new `merge_resolutions` table (one row per resolution attempt — `state` transitions through `pending → resolving → resolved | escalated | failed`) and a nullable `merge_requests.resolved_from` lineage column. Like the 7.2 batch state, the integrator owns in-flight resolution scheduling in memory; `merge_resolutions` is the durable record, not the scheduler.

### 18.1 Configuring the resolver

Stored under `projects.settings.integrator.resolver` (snake_case, a sibling of `verify_steps` / `slo`). Canonical Zod-3 in `@pm/shared`; route-local Zod-4 mirror (the established split).

| Field             | Type        | Default   | Notes                                                                                                                                                  |
| ----------------- | ----------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | boolean     | `false`   | Master kill-switch. `false` ⇒ inert; a conflict rejects exactly as in 7.5. See §18.2.                                                                  |
| `max_concurrent`  | integer ≥ 1 | `1`       | Size of the resolver pool — number of resolutions running at once. Separate from the verify worktree pool. See §18.3.                                  |
| `time_budget_sec` | number > 0  | `600`     | Wall-clock cap on one resolution (SIGTERM then SIGKILL). Exceeding ⇒ escalate. See §18.3.                                                              |
| `token_budget`    | number > 0  | (none)    | Optional model-token cap passed to the headless session. Exceeding ⇒ escalate.                                                                        |
| `command`         | string      | (none)    | Optional override for how the headless agent is invoked. Default is `claude -p` against the resolver worktree. Lets operators swap the resolver binary. |

These are the **only** five resolver fields. An **absent/empty** `resolver` block is treated as `{ enabled: false, max_concurrent: 1, time_budget_sec: 600 }` (the inner defaults fire). Set it via `PATCH /api/v1/projects/{id}` under `settings.integrator.resolver` — there is **no env var or CLI flag** (config lives on the project, exactly like the 7.5 cache):

```json
{
  "settings": {
    "integrator": {
      "enabled": true,
      "verify_command": "cargo build --workspace && cargo test --workspace",
      "worktree_root": "/srv/game_one/integrators/main",
      "resolver": {
        "enabled": true,
        "max_concurrent": 1,
        "time_budget_sec": 600
      }
    }
  }
}
```

The `PATCH /projects/{id}` route validates this with the Zod schema (`max_concurrent ≥ 1`, `time_budget_sec > 0`); an invalid config returns 400.

### 18.2 The kill-switch (default-off = inert)

`resolver.enabled` is the master switch, and its default is **`false`**. With it off, a `RebaseConflict` categorizes and rejects **exactly as in 7.5** — every 7.6 code path is skipped: **zero `merge_resolutions` rows are written, zero `merge.resolution.*` events fire**. This is the prime backward-compatibility guarantee, and it is what lets the engine ship dark.

- **Enable** by `PATCH`ing the project with `settings.integrator.resolver.enabled = true` (§18.1). The integrator re-reads settings on its next pass.
- **Instant revert:** flip `enabled` back to `false`. The next conflict rejects the plain 7.5 way again. No restart, no risk.

### 18.3 Budget + cost controls

A resolution is **one bounded attempt** — there is **no retry loop**. Three controls bound its cost:

- **`time_budget_sec`** (default `600`) — the wall-clock cap on one resolution. When it's exceeded the session is killed (SIGTERM, then SIGKILL after a grace period) and the resolution **escalates** to the author. A resolution is never allowed to run unbounded.
- **`token_budget`** (optional) — a model-token cap passed to the headless session. Exceeding it likewise escalates.
- **`max_concurrent`** (default `1`) — the size of the **resolver pool**: how many resolutions run at once. Each slot is **an isolated worktree _plus_ a spawned headless Claude session**, so size it against **CPU/RAM _and_ API cost**, not just disk — every concurrent slot is another live model session.

> **The honest cost reality.** Each resolution spawns a **real headless Claude session** that consumes wall-clock and tokens **whether it succeeds or not** — a failed resolution still cost you a full agent run before it escalated. This is a genuine, metered cost, not free retry. **Start at `max_concurrent: 1`** and raise it only once you've watched the resolution metrics (§18.5) and decided the auto-resolve success rate justifies the spend.

### 18.4 The escalation ladder

A conflict travels down this ladder, stopping at the first rung that lands it:

1. **Auto-resolve.** The resolver reconciles the conflict in an isolated worktree, runs a local verify pre-filter, and resubmits the result as a **new** merge request (`resolved_from = origin.id`, `task_id` copied from the origin). That resolved request **rides the train like anything else and passes the REAL verify gate again** before it can land — the local pre-verify is a fast filter, never the authority. On a clean pass it lands; `merge_resolutions.state = resolved`.
2. **Author handback.** If the resolver can't produce a clean, verify-passing tree — the agent reports it's still conflicted, verify fails, or the time/token budget is exceeded — the conflict is handed **back to the origin author**. A `merge_rejection` comment is posted on the origin task carrying the **conflicting files**, the **verify verdict or budget reason**, and an explicit note that **auto-resolution was attempted and the original commit is intact — fix forward, don't redo**. The state is `escalated` (or `failed` for an infra error), `escalation_target = author`.
3. **Human.** If the author can't resolve it either, normal human escalation applies — no new machinery, just an unresolved task with a clear trail.

At no rung is work discarded: the origin request still holds the author's commit, and "redo the task from scratch" is never a path.

### 18.5 What operators see

- **Per-request timeline (lineage chain).** The timeline (`GET /api/v1/merge-requests/{id}/timeline`) renders the lineage `origin (rejected conflict) → resolution attempt (state) → resolved request (its own land timeline)`; the resolved request back-links to its origin via `resolved_from`. A resolution in `resolving` shows up as **in-flight composition** on the train dashboard, so a long-running resolver is visible rather than mysterious latency.
- **Dashboard metrics sub-block.** The on-read metrics bundle (`GET .../train/metrics`) gains a `resolution` sub-block (snake_case, inert — `attempts: 0`, ratios `null` — when the resolver is off):

  ```json
  {
    "resolution": {
      "attempts": 12,
      "auto_resolve_success_rate": { "ratio": 0.58, "resolved_and_landed": 7, "attempts": 12 },
      "escalation_rate": { "ratio": 0.42, "escalated": 5, "attempts": 12 },
      "mean_wall_clock_ms": 184000,
      "budget_utilization": { "ratio": 0.31, "mean_consumed_sec": 184, "budget_sec": 600 }
    }
  }
  ```

- **Five SSE events** (relayed like the existing `merge.*` frames): `merge.resolution.pending`, `merge.resolution.started`, `merge.resolution.succeeded`, `merge.resolution.escalated`, `merge.resolution.failed`. Each is tagged with `origin_request_id` and `resolution_id` (and, on success, `resolved_request_id`).
- **Inspection APIs** (any authenticated user — debug + dashboard): `GET /api/v1/projects/{projectId}/merge-resolutions` (list) and `GET /api/v1/merge-resolutions/{id}` (single detail). The integrator-driven writes (`POST .../merge-resolutions`, `.../{id}/start`, `.../{id}/resolved`, `.../{id}/escalate`) are `ai_agent`-only and HTTP-only — there are **no new worker MCP tools** (the resolver is integrator machinery, like the 7.4/7.5 channels).

### 18.6 Failure + operational notes

- **Off = inert.** `resolver.enabled = false` ⇒ a conflict rejects the plain 7.5 way; no rows, no events (§18.2).
- **Infra failures escalate, tagged `failed`.** A resolver worktree build failure, a headless-agent spawn failure, or a missing `command` resolves the attempt as **`failed`** and escalates to the author. The origin was already rejected, so there is no `main` impact.
- **"Too hard" escalates, tagged `escalated`.** The agent runs but its output is still conflicted, the verify fails, or the time/token budget is exceeded → **`escalated` → author** (an honest "too hard"). Work intact.
- **No recursion.** If a **resolved** request conflicts or fails verify **again** on the train, it takes the **normal** reject path — the resolver does **not** re-engage (one-attempt rule, enforced by `resolved_from != null`). It goes to the author like any other rejection.
- **The lane is never held across a resolution.** The lane lock is released at the conflict seam **before** any resolution begins (it maps to the existing `releaseLock` call), so a multi-minute resolver session never stalls the train. A PM I/O throw mid-resolution is best-effort: log + escalate; it **never blocks the lane**. Two integrators on the same lane don't double-run a resolution — it's keyed by the `merge_resolutions` row.
- **v1 limitation — a dangling `resolving` row.** If the integrator **crashes mid-resolution**, the `merge_resolutions` row is stranded in `resolving`. **No work is lost** (the origin commit is intact and `main` is untouched), but there is **no auto crash-recovery sweep** for resolution rows yet — the stranded row simply sits in `resolving`. A v2 follow-up adds a reclaim sweep; until then, an operator can spot it via `GET .../merge-resolutions` and treat the origin as an ordinary rejected conflict.
- **The honest limitation.** Verify is the **only** arbiter — the resolver's self-asserted confidence never gates a land. Resolution is bounded and **one-shot** (no iterative rounds in v1), and **conflict-only** (semantic verify failures and cross-repo group conflicts are out of scope for v1; group conflicts stay on the 7.3 reject/incident path). The prime invariant holds: **`main` is only ever advanced by the normal verify-gated land path** — the resolver only ever _submits a request_, never pushes `main` itself.
