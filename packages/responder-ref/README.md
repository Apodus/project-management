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
| `PM_RESPONDER_MODE` / `--mode`    | `shadow`                | `off`/`shadow`/`on` — gates what an outcome POSTs          |
| `--poll-interval-sec`             | `15`                    | Poll cadence                                               |
| `PM_LOG_LEVEL` / `--log-level`    | `info`                  | pino log level                                             |
| `PM_AUTO_IMPLEMENT_ENABLED`       | `false`                 | Kill-switch for the write-capable auto-implement regime (Campaign A1) |
| `PM_AUTO_IMPLEMENT_VERIFY_CMD`    | (empty)                 | Project verify command the implement agent runs in-session before declaring `branch_ready` (empty ⇒ skip; A2's train re-verify is the floor) |
| `PM_AUTO_IMPLEMENT_ALLOWED_PATHS` | (empty = no restriction) | CSV of coarse path prefixes — the blast-radius allowlist (default `[]` = whole PM repo allowed; an opt-in operator narrowing) |
| `PM_RESPONDER_GIT_REPO_URL`       | (empty)                 | Repo URL the implement worktree clones (REQUIRED when auto-implement is enabled) |
| `PM_RESPONDER_GIT_REMOTE`         | `origin`                | Remote the implement branch pushes to                      |
| `PM_RESPONDER_GIT_MAIN_BRANCH`    | `main`                  | Main branch the worktree resets to / diffs against         |
| `PM_RESPONDER_GIT_CLEAN_KEEP`     | (empty)                 | CSV of paths to preserve across the worktree git-clean      |

## Auto-implement (Campaign A1)

Beyond answering, the responder can — behind an **opt-in kill-switch** — turn a
bounded code-change escalation into a pushed branch a human (and the merge-train)
can land. The flow:

1. **Assess + sniff** — the answering session may declare an `implement` intent
   (`bounded`/`systemic`). When auto-implement is enabled, an injection
   sniff-test gates admission first (suspicious/error ⇒ escalate, never spawn —
   fail-safe). `systemic` drives the autonomous arc (see Autonomous drive below).
2. **Isolated-worktree implement** — a `bounded` change runs a write-capable
   session in an **isolated worktree clone** (never the live repo / main),
   committing onto `pm/escalation-<id>`.
3. **In-session verify** — the implement agent runs `PM_AUTO_IMPLEMENT_VERIFY_CMD`
   itself and iterates to green before declaring `branch_ready` (empty ⇒ skip).
4. **Coarse blast-radius bound** — on `branch_ready`, the branch's diff vs main is
   checked against `PM_AUTO_IMPLEMENT_ALLOWED_PATHS` (literal path prefixes).
   Default `[]` = **no restriction** (permissive-by-design: the clone IS the PM
   repo). When set, a touched path outside every prefix is NOT pushed — it
   escalates to a human. A diff failure fails safe (escalate, do not push).
5. **Push + pending-land handoff** — the branch is pushed and a `pendingLand`
   handoff message is appended; the escalation stays **acknowledged**. **The
   responder never lands** — that is A2's merge-train, the real verify floor.

Ships behind `PM_AUTO_IMPLEMENT_ENABLED` (**default `false`**). At `mode=off`
the whole path is silent; `shadow`/`on` follow the same outcome-disposition rules
as answering.

`mode` is **not** `enabled`: `enabled=false` idles the process; `mode` (off/shadow/on)
selects the answering behavior and only acquires meaning in P3/P5. In P1 it is
parsed and validated but has no behavioral branch.

Fixed defaults (P1): `maxConcurrent` 1 (serial), `spawnBudget` {maxSpawns 10,
windowSec 3600}, `timeBudgetSec` 900 — the last three are parsed for forward
compatibility (P2 enforces them).

## Autonomous drive (Campaign A3)

Past landing a *bounded* fix, the responder can drive a *systemic* escalation
through the full proven vision+campaign pipeline **unattended** — same opt-in
kill-switch as auto-implement (`PM_AUTO_IMPLEMENT_ENABLED`, **default `false`**).
The flow:

1. **Assess → `implement{systemic}` → drive a vision** — when the answering session
   declares `systemic` (and the injection sniff is clean), a bounded headless
   **drive session** runs in an isolated worktree clone and produces an
   adversarial-verified **vision** (`roadmaps/vision-*.md`). The vision file is
   **cross-checked on disk** — `vision_ready` is never inferred from the sentinel.
2. **The loop builds the arc over HTTP** — from the drive result the loop creates
   the vision's **PM epic + one task per campaign** over HTTP (the worktree clone
   has no PM MCP) and appends a `pendingDrive` marker, leaving the escalation
   **acknowledged**. An early pre-epic intent marker closes the duplicate-epic
   window on a daemon restart.
3. **Each reclaim tick → `advanceArc`** — the self-held arc is routed to
   `advanceArc`, which derives the arc's state **strictly from the server** (the
   epic's campaign-tasks + each phase's MR land status by `escalationId`) and
   advances **one phase per cycle**: it implements the next un-landed phase via the
   A1 implement session onto `pm/escalation-<id>-<taskId>` and lands it via the A2
   **verify-gated train** with a **task-LINKED, `escalationId`-linked** MR. The
   task-link is load-bearing — the A2 land/reject post-back is gated on
   `taskId === null`, so a phase land threads `escalationId` for attribution
   **without** an early phase resolving the root; arc completion is driven solely by
   `advanceArc`.
4. **All phases landed → resolve-as-holder + C2 origin-notice** — `advanceArc`
   resolves the escalation as the holder (`answer`→`resolve`) with a summary naming
   the epic + landed shas; the origin **auto-notices it via the C2 delivery layer**.
5. **Mid-arc reject → `needs_human`, proven phases preserved** — a rejected phase MR
   escalates the root to a human with the partial payload (landed shas + remaining
   phases). **No proven work is discarded, no rollback** — the landed phases stay
   landed and the rejected task is never re-submitted.

Restart-survival is **structural** — the arc carries no in-memory checkpoint (a
fresh daemon state re-derives the arc from the server), and no-recursion is
structural too (phase MRs are self-authored + `taskId`-gated + `resolved` is
terminal). The drive is a **superset of the A1 bounded implement** (the per-phase
executor IS the A1 session; the per-phase land IS the A2 train). Ships behind the
auto-implement enable flag (**default `false`**); **no new env var, no new MCP
tool**.

Exit code 2 = configuration error (no token / no project / bad mode); exit 1 =
unexpected runtime error (e.g. `/auth/me` unreachable when enabled).

> The game_one distribute bundle will ship this daemon as a bundled artifact (a
> separate repo — not edited here); the full bundle wiring lands later in C3.
