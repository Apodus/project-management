# @urtela/pm-wake-daemon

Reference **wake daemon** for the PM escalation channel (Campaign C2).

When a human (or another worker) replies to an escalation a worker raised, that
reply needs to reach the worker. Piggyback/drain delivery covers a worker that is
still alive and polling. The wake daemon covers the case those cannot: a
**dormant or ended worker**. It polls for undelivered replies on the worker's
behalf and **spawns a fresh client worker turn** (default `claude -p`) seeded with
the reply so the worker reads the thread and acts — then advances the delivery
cursor.

One daemon per machine, watching the local worker key(s).

## How it works

Per watched `(workerKey[, projectId])`, each poll tick:

1. `GET /api/v1/escalations/undelivered?worker_key=K[&project_id=P]` →
   `{ escalation, unreadMessages, unreadCount }[]`.
2. Keep escalations that have unread messages, process **oldest-unread-first**.
3. Subject to guards (in-flight, already-woke-for-this-maxSeq, min-wake cooldown,
   a `maxConcurrentWakes` semaphore, and a per-escalation give-up park), spawn a
   worker turn with the reply on stdin, bounded by `timeBudgetSec`
   (SIGTERM→SIGKILL via a cross-platform process-tree kill).
4. On a **clean bounded exit** (exit 0, not timed out, not a spawn error):
   `POST /api/v1/escalations/{id}/mark-delivered { workerKey, uptoSeq }`
   (`uptoSeq` = max unread seq).
5. On a **timeout / spawn error / non-zero exit**: do NOT mark-delivered (it
   re-wakes after the cooldown) and increment the per-escalation give-up counter.

**Give-up park.** After `maxConsecutiveFailures` (default 5) consecutive wake
failures for one escalation, it is parked — no further spawns — until a new reply
arrives (its unread maxSeq advances), which resets the counter and un-parks it.
This prevents the infinite-spawn storm a missing/misconfigured `claude` binary
would otherwise cause (the daemon has no terminal reject sink like the integrator).

## Quick start (zero-config)

A single worker just needs its worker key and a PM API token:

```bash
PM_WORKER_KEY=worker-1 PM_API_TOKEN=… pm-wake-daemon
```

The daemon auto-derives one watch entry from `PM_WORKER_KEY` (optionally scoped by
`PM_PROJECT_ID`).

## Multi-worker host

```bash
# Repeatable --watch <key>[:<projectId>]
pm-wake-daemon --watch worker-1 --watch worker-2:01PROJECT…

# Or a JSON config file: { "watch": [ { "workerKey": "w1" }, { "workerKey": "w2", "projectId": "…" } ] }
pm-wake-daemon --config wake.json
```

## Configuration

| Source                         | Default                 | Description                                              |
| ------------------------------ | ----------------------- | -------------------------------------------------------- |
| `PM_API_URL` / `--pm-url`      | `http://localhost:3000` | PM API base URL (trailing slash stripped)                |
| `PM_API_TOKEN`                 | (required)              | PM API token (any `ai_agent` Bearer token)               |
| `PM_WORKER_KEY`                | (none)                  | Auto watch entry (zero-config single worker)             |
| `PM_PROJECT_ID`                | (none)                  | Scopes the auto watch entry to one project               |
| `--watch <key[:projectId]>`    | (none)                  | Repeatable explicit watch entry                          |
| `--config <file>`              | (none)                  | JSON `{ watch: [...] }`                                  |
| `--poll-interval-sec`          | `15`                    | Poll cadence                                             |
| `PM_WAKE_WORKER_COMMAND`       | `claude -p`             | The worker spawn command                                 |
| `PM_WAKE_PROMPT`               | (built-in)              | Wake prompt template (`{escalation}` / `{messages}`)     |
| `PM_LOG_LEVEL` / `--log-level` | `info`                  | pino log level                                           |

Fixed defaults (P2): `timeBudgetSec` 900, `maxConcurrentWakes` 1 (serial),
`minWakeIntervalSec` 60, `maxConsecutiveFailures` 5.

Exit code 2 = configuration error (no token / no watch entry); exit 1 = unexpected
runtime error.

> The game_one distribute bundle ships this daemon as a bundled artifact (a
> separate repo — not edited here); the full bundle wiring is C2 P5.
