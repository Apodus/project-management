# @urtela/pm-responder

Reference **responder daemon** for the PM escalation channel (Campaign C3).

When a worker raises an escalation that no live worker picks up, it needs an
autonomous answerer. The **responder** is that process: it polls a watched
project's **open** escalations and **claims** each unclaimed, client-authored one
(via `acknowledge`, the C1 one-active-responder gate), then — from P2 onward —
spawns a fresh headless client turn (default `claude -p`) to read the thread,
answer, and resolve it.

This package's **C3 P1** ships only the **skeleton + claim**: it polls, claims,
and stops. **No claude is spawned yet** (that is P2). The responder is **off by
default** — the operator opts in by flipping `enabled`.

One process per watched project.

## How it works

Each poll tick, per watched project:

1. `GET /api/v1/projects/{projectId}/escalations?status=open` → `Escalation[]`
   (the `{ data, pagination }` envelope is unwrapped to the bare array).
2. SEED filter (**no-recursion**): keep escalations that are unclaimed
   (`holderId == null`), **not authored by this responder** (`authorId != selfId`),
   still `open`, and not already claimed this process. Oldest-first by `createdAt`.
3. Under a `maxConcurrent` semaphore, `POST /api/v1/escalations/{id}/acknowledge`
   (no body) to **claim** it:
   - **success** → record claimed; the escalation stays acknowledged (P2 will
     spawn the answering session here; P3 adds the answer).
   - **403** → another responder already holds it (the C1 gate) → skip.
   - **409** → it raced out of `open` (resolved/answered) → skip.
   - **other** → leave it un-claimed; a later tick retries.

## Enable / disable

The responder is **off by default**. It will not poll or claim until you opt in:

```bash
# Disabled (default): logs "Responder disabled …" and exits 0.
PM_API_TOKEN=… PM_PROJECT_ID=01PROJECT… pm-responder

# Enabled:
PM_RESPONDER_ENABLED=1 PM_API_TOKEN=… PM_PROJECT_ID=01PROJECT… pm-responder
# or: pm-responder --enabled --project 01PROJECT…
```

## Multi-project host

```bash
# Repeatable --project
pm-responder --enabled --project 01PROJECT_A… --project 01PROJECT_B…
```

Watch-all is **not allowed** — the responder claims work, so it must be scoped to
projects the operator has opted in (no project ⇒ config error, exit 2).

## Configuration

| Source                            | Default                 | Description                                                |
| --------------------------------- | ----------------------- | ---------------------------------------------------------- |
| `PM_API_URL` / `--pm-url`         | `http://localhost:3000` | PM API base URL (trailing slash stripped)                  |
| `PM_API_TOKEN`                    | (required)              | PM API token (an `ai_agent` Bearer token)                  |
| `PM_PROJECT_ID`                   | (none)                  | Single watched project (or use `--project`)                |
| `--project <id>`                  | (none)                  | Repeatable watched project                                 |
| `PM_RESPONDER_ENABLED` / `--enabled` | `false`              | Kill-switch — the responder is off until opted in          |
| `PM_RESPONDER_MODE` / `--mode`    | `shadow`                | `off`/`shadow`/`on` — **parsed only in P1** (inert)        |
| `--poll-interval-sec`             | `15`                    | Poll cadence                                               |
| `PM_LOG_LEVEL` / `--log-level`    | `info`                  | pino log level                                             |

`mode` is **not** `enabled`: `enabled=false` idles the process; `mode` (off/shadow/on)
selects the answering behavior and only acquires meaning in P3/P5. In P1 it is
parsed and validated but has no behavioral branch.

Fixed defaults (P1): `maxConcurrent` 1 (serial), `spawnBudget` {maxSpawns 10,
windowSec 3600}, `timeBudgetSec` 900 — the last three are parsed for forward
compatibility (P2 enforces them).

Exit code 2 = configuration error (no token / no project / bad mode); exit 1 =
unexpected runtime error (e.g. `/auth/me` unreachable when enabled).

> The game_one distribute bundle will ship this daemon as a bundled artifact (a
> separate repo — not edited here); the full bundle wiring lands later in C3.
