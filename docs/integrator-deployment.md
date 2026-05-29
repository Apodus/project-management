# Integrator deployment guide

**Audience**: operators deploying and running the reference integrator (`@pm/integrator-ref`) for a PM project.
**Scope**: Phase 7.1 (Month 1) of the merge train — one serial integrator process per `(project, resource)` lane.
**Companion spec**: `docs/design/phase-7.1-design.md` (data model, state machines, REST surface, SSE events, authz, failure catalog). When this guide and the design doc disagree on a contract detail, the design doc wins.

This guide is written so a fresh operator can take a project from "integrator disabled" to "a test merge request landed" in about 30 minutes. The fast path is the checklist in §12; everything before it is reference.

---

## 1. Overview

The integrator is a **separate, long-lived process**. PM itself never spawns build commands — the server only records coordination state (`queued` / `integrating` / `landed` / `rejected` facts). The integrator's job is to make those facts true. This split is the load-bearing architectural commitment of Phase 7: workers call `pm_request_merge` and walk away; no worker is parked on a lock while a verify build runs.

You run **one integrator process per `(project, resource)` lane**. For `game_one` in Month 1 that is exactly one process: `(game_one, main)`.

Each process loops, serially (parallelism is exactly 1):

1. Watch the PM project for the next `queued` merge request in its lane (oldest first).
2. Pick it up (`queued → integrating`), acquire the Stage 1 lock as a defense-in-depth gate, and start an attempt.
3. Reset an isolated git worktree to live `main`, then rebase the request's branch/commit onto it.
4. Run the project's configured verify command against the rebased tree.
5. Either **land** it — fast-forward `main` to the verified tree, attach a `landed_sha` git_ref to the linked task — or **reject** it — record a structured payload (category, failed files, log pointer) and auto-post a comment of type `merge_rejection` on the linked task.

**Main is never broken**: verify runs against a tree SHA *before* `main` fast-forwards. A verify failure terminates as `rejected`; it can never land.

Cross-reference: design doc §14 (reference integrator architecture) is the authoritative description of the loop this process implements.

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
| `worktree_name` | string | `${project.slug}-integrator` | no | Subdirectory name under `worktree_root`. Useful when one host runs multiple integrators. |

> **`gitRepoUrl` is a top-level project field, NOT under `settings`.** It is required — the integrator clones it. Do not put it inside `settings.integrator`.

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
      "worktree_name": "game_one-integrator"
    }
  }
}
```

The `PATCH /projects/{id}` route validates this with the Zod schema; an invalid config returns 400 with field-level errors. The integrator also re-validates on startup and exits with code 2 if the config is wrong (see §7).

---

## 5. Worktree setup

The integrator keeps a single isolated git worktree per process. Layout under `worktree_root`:

```
${worktree_root}/
  ${worktree_name}/   ← the worktree (a clone of gitRepoUrl)
  logs/               ← per-attempt verify logs
```

- **Worktree path** = `${worktree_root}/${worktree_name}`.
- **Logs directory** = `${worktree_root}/logs/` — a **sibling of the worktree**. Both `logs/` and the worktree directory live directly under `worktree_root`. Logs are NOT placed inside the worktree (which gets wiped between attempts).

**Clone-on-first-use.** On startup, if the worktree path is missing or has no `.git` directory, the integrator clones `gitRepoUrl` into it and aligns the configured remote.

**Between attempts.** Before each request the integrator restores a clean state in the worktree:

```
git reset --hard
git clean -fdx
git fetch <git_remote>
git checkout <git_main_branch>
git reset --hard <git_remote>/<git_main_branch>
```

This guarantees a clean tree no matter how the previous attempt left things (rebase aborted, verify killed mid-build, etc.).

**Corruption detection and recovery.** If the `.git` directory is missing or `git status` fails, the worktree is considered corrupt: the integrator deletes the worktree directory and re-clones from `gitRepoUrl`.

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

**SSE frames are flattened.** Each frame carries `entity_type`, `entity_id`, `action`, `actor` (`{ id, name, type }`), and `timestamp` (plus `changes?` / `entity_title?` when present). It does **not** carry the full row. To get full detail, fetch `GET /api/v1/merge-requests/{id}`. Cross-reference: design doc §9.2.

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

---

## 10. Single-machine, multi-agent guidance

**The rule: `worktree_root` is per-integrator-process, never shared.** Two integrator processes must never point at the same `worktree_root` — they would clobber each other's worktree and logs. Give each lane its own root.

Recommended `game_one` layout (Month 1 has one lane, `main`):

```
/srv/game_one/
  integrators/
    main/                      ← worktree_root for (game_one, main)
      game_one-integrator/     ← the worktree (clone)
      logs/                    ← per-attempt logs
```

Adding a second lane later means a second root (e.g. `/srv/game_one/integrators/<resource>/`), a second process, and a second worktree — never a shared directory.

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
