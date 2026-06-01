# Phase 7.6 Design: Intelligent merge-conflict resolution

**Status:** draft (proposal `01KT1W67ZB400S13HVK7ATGE9K`, accepted into `in_progress` 2026-06-01).
**Companion specs:** `phase-7.1` (serial baseline), `phase-7.2` (speculative batching),
`phase-7.3` (cross-repo atomicity), `phase-7.4` (observability + break-glass),
`phase-7.5` (smart verification). When this guide and a shipped contract disagree, the
shipped code wins and this doc is the bug.

---

## 0. Reading guide

This phase adds **automated resolution of textual rebase conflicts** to the merge train.
When the integrator rebases a request onto live `main` and gets a conflict, instead of
rejecting straight back to the worker it may — behind an opt-in flag — spawn a headless
Claude Code session to reconcile the two intents, re-verify, and resubmit the resolved
change as a new merge request. If that fails, the original author gets the conflict back as
ordinary work; a human is the last resort. **No proven work is ever discarded, and `main`
is never advanced to anything verify hasn't passed.**

Everything here is inert until `settings.integrator.resolver.enabled = true`. With it off
(the default) the train is **byte-identical to 7.5**.

---

## 1. Goals, non-goals, and the settled decisions

### 1.1 Goals

1. **Submit-and-move-on** (Track A, doc-only): decouple "task done" from "merge landed" in
   the worker workflow. A rejection is a new ticket, never a blocking wait. Ships first and
   independently — no code.
2. **Automated conflict resolution** (Track B): on a textual rebase conflict, attempt a
   bounded, verify-gated auto-resolution before involving a human, and preserve the work.

### 1.2 The five settled decisions (non-negotiable)

1. **Off by default, opt-in like the 7.5 cache.** `resolver.enabled` defaults `false`. Off ⇒
   a conflict rejects exactly as it does in 7.5. One attempt per conflict, no retry loop.
2. **Resolution spawns a linked NEW merge request; the original is never mutated.** The
   original is rejected `conflict` and tagged `resolution_pending`; the resolver's output
   enters the train carrying `resolved_from = <originalId>`. The audit trail stays truthful:
   the original genuinely conflicted, the resolution is a separate, separately-verified
   artifact.
3. **Verify is the ONLY arbiter.** We never trust a model's self-asserted confidence to gate
   a land. The resolver attempts; its output runs the normal verify gate. Pass ⇒ land.
   Fail OR budget-exceeded ⇒ "too hard" ⇒ escalate.
4. **Never discard work.** "Redo the task from scratch" is never a path. A rejected request
   still holds the author's commit; escalation hands the conflict *back* to the author, who
   fixes forward.
5. **Conflict-only for v1.** Semantic verify failures (rebased clean, broke a test) are out
   of scope — that is open-ended bug-fixing, a different problem. Revisit as v2.

### 1.3 Non-goals (deferred)

- Resolving **semantic** verify failures (v2).
- Resolving cross-repo **group** conflicts via the resolver (v1 leaves group conflicts on the
  existing 7.3 reject/incident path; the resolver engages only on single-repo lane conflicts).
- Multi-round / iterative resolution (one bounded attempt only).
- Any human-in-the-loop *during* a resolution attempt (escalation is the handoff point).

---

## 2. Canonical naming

| Term | Meaning |
| --- | --- |
| **resolution** | One bounded attempt to reconcile a textual conflict for a single request. |
| **resolver** | The integrator-side engine that runs a resolution (worktree + headless Claude + verify). |
| **origin request** | The merge request that conflicted; rejected `conflict`, tagged `resolution_pending`. |
| **resolved request** | The new merge request the resolver submits, with `resolved_from = origin.id`. |
| **escalation** | Handing the conflict back to the origin author (then human) when resolution can't land. |
| **resolver budget** | `time_budget_sec` (+ optional `token_budget`); exceeding it = escalate. |

`merge.resolution.*` is the SSE event namespace. `resolved_from` is the lineage column.

---

## 3. Configuration — `settings.integrator.resolver`

Stored under `projects.settings.integrator.resolver` (snake_case, sibling to `verify_steps`
etc.). Canonical Zod-3 in `@pm/shared`; route-local Zod-4 mirror (the established split).

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Master kill-switch. `false` ⇒ inert; a conflict rejects as in 7.5. |
| `max_concurrent` | integer ≥ 1 | `1` | Size of the resolver pool (separate from the verify worktree pool). |
| `time_budget_sec` | number | `600` | Wall-clock cap on one resolution (SIGTERM→SIGKILL); exceeding ⇒ escalate. |
| `token_budget` | number? | (none) | Optional model-token cap passed to the headless session; exceeding ⇒ escalate. |
| `command` | string? | (none) | Override for how the headless agent is invoked (default: `claude -p` against the worktree). Lets operators swap the resolver binary. |

Validation: `max_concurrent ≥ 1`; `time_budget_sec > 0`. Absent/empty `resolver` ⇒ treated as
`{ enabled: false }`. No env var — config lives on the project, set via `PATCH /projects/{id}`
(same as 7.5).

---

## 4. Data model (PM-owned)

### 4.1 `merge_requests.resolved_from` (migration 0017, nullable)

A nullable text column. On a resolved request it holds the origin request id; null on every
normal request. This is the only change to an existing table — byte-compatible, no backfill.

### 4.2 `merge_resolutions` (new table, migration 0017)

One row per resolution attempt. PM owns the state; the integrator drives transitions over the
REST surface (§6).

| Column | Notes |
| --- | --- |
| `id` | ULID. |
| `project_id`, `resource` | The lane. |
| `origin_request_id` | The conflicting request (FK → merge_requests). |
| `resolved_request_id` | The new request, once submitted (nullable until then). |
| `state` | `pending → resolving → resolved \| escalated \| failed` (see §5). |
| `conflicting_files` | JSON array, copied from the `RebaseConflict`. |
| `attempt_started_at` / `attempt_ended_at` | Timestamps. |
| `escalation_target` | `author` \| `human` \| null. |
| `detail` | JSON: budget consumed, verify verdict, escalation reason, log URL. |
| `created_at` / `updated_at` | — |

No batch tables: like 7.2 the integrator owns in-flight scheduling in memory; `merge_resolutions`
is the durable record, not the scheduler.

### 4.3 Resolution state machine

```
            enqueue (conflict + resolver.enabled)
pending ─────────────────────────────────────▶ resolving
                                                  │
   resolver worktree built, headless agent runs,  │
   output verified locally + resubmitted          │
                                                  ▼
                            ┌────── resolved   (resolved_request_id set; it now rides the train)
   resolving ───────────────┤
                            ├────── escalated  (verify-fail / budget / unresolvable → author, then human)
                            └────── failed     (infra error: worktree/spawn/PM I/O — escalates too, but
                                                tagged distinctly so operators can tell "model couldn't"
                                                from "the resolver itself broke")
```

`resolved` is **not** terminal-happy on its own: the resolved request still has to pass the
real verify gate and land like anything else. `merge_resolutions.state = resolved` means
"the resolver produced a clean, locally-verified, resubmitted change" — the land is then
tracked on the resolved request as usual.

---

## 5. The integrator flow

### 5.1 The seam (grounded in shipped code)

Today, in `loop.ts` / `batch.ts`, a rebase calls `GitOps.rebaseOnto(base, branch)` which
returns either `{ ok: true, treeSha }` or a `RebaseConflict { ok: false, conflictingFiles,
stderr }` (it already `--abort`s and captures the conflicting files — see `git-ops.ts`). On
`ok: false` the current code assigns the `conflict` category **directly at the rebase seam**
and rejects — in `loop.ts` (~lines 238/245: after `rebaseOnto` returns `!ok`, it completes the
attempt `failed` and rejects the request with category `"conflict"`) and in `batch.ts`
(~lines 1405/1410 → `onMemberFailed(..., { kind: "conflict", conflictingFiles, stderr })`,
handled at ~lines 572/580). Note `categorize.ts` is **not** involved here: it only classifies
*verify* output (build/test/lint/timeout) and never produces the `conflict` category — that
category exists solely at these two rebase-seam rejection sites. (Aside: `rebaseOnto`'s success
`treeSha` field is actually the rebased HEAD commit SHA — `git rev-parse HEAD`, `git-ops.ts`
~line 349 — not a literal tree-object id; the name is a shipped quirk.)

7.6 inserts a single branch at exactly that point:

```
on RebaseConflict:
  if not resolver.enabled:        → reject 'conflict'         (UNCHANGED 7.5 behavior)
  else:
    reject origin 'conflict', tag resolution_pending
    release the lane lock         (do NOT resolve under the lock)
    enqueue a resolution { origin_request_id, conflicting_files }
    emit merge.resolution.pending
```

Here "release the lane lock" maps to the **existing** `releaseLock({ reason: ... })` helper
already called at the conflict seam in `loop.ts` (~line 251, today `reason: "rebase conflict"`) —
7.6 does not add a new release. The new `enqueue a resolution` step runs **after** that existing
release call, so the lane is already unlocked before any resolution begins; the
"lane-never-held" invariant (§10, test 6) thus holds **by construction**, not by added
discipline.

The scheduler (admit / rebase / land / suffix / retry / kill) is **otherwise unchanged**. The
conflict path was already terminal-for-this-request; we keep it terminal for the *origin* and
spin resolution off to the side. **The lane lock is never held across a resolution** — that is
the load-bearing latency decision: a multi-minute Claude session must not stall the train.

### 5.2 The resolver worker

Runs in the resolver pool (`max_concurrent` slots, isolated worktrees, separate from verify
slots):

1. **Materialize the conflict.** Build an isolated worktree at `main` (live), replay the
   origin branch to reproduce the same conflict the rebase hit (the markers are the agent's
   working material).
2. **Spawn headless Claude Code** (`claude -p` / Agent SDK, or `resolver.command`) with a
   reconcile prompt: "two changes touched these files; reconcile BOTH intents, resolve the
   conflict markers, then run the verify command and report." Bounded by `time_budget_sec`
   (and `token_budget` if set). **One attempt.**
3. **Local verify.** Run the project verify pipeline (the 7.5 DAG) on the resolved tree, cache
   **OFF** (a resolution is novel; don't pollute or trust the cache here — same stance as
   group orphan-recovery in 7.5).
4. **Branch on the outcome:**
   - clean + local verify passes → **§5.3 resubmit**.
   - verify fails, or budget exceeded, or the agent reports it can't → **§5.4 escalate**
     (`escalated`).
   - worktree/spawn/PM I/O throws → **§5.4 escalate**, state `failed`.

### 5.3 Resubmit as a linked new request

The resolved branch is submitted as a **new** merge request with `resolved_from = origin.id`,
`task_id` copied from the origin. Note the integrator's `pm-client.ts` today has **no**
submit-merge-request method (only pickup/land/reject/attempts/orphan/group/incident/cache) —
submitting requests has so far been worker-side (MCP). Step 7 therefore **adds** that method to
`pm-client.ts`; the seam does not already exist. It enters the train normally and **passes the
real verify gate again** before landing — local verify in §5.2 is a fast pre-filter, not the
authority.
`merge_resolutions`: `resolved_request_id` set, `state = resolved`. Emit
`merge.resolution.succeeded`.

> The resolved request lands (or, rarely, conflicts again — see §7) through the ordinary path.
> A second conflict on the resolved request does **not** recurse into another resolution
> (one-attempt rule, enforced by `resolved_from != null` ⇒ resolver skips it).

### 5.4 Escalation — hand back to the author, never discard

`merge_resolutions.state = escalated` (or `failed`), `escalation_target = author`. Post a
`merge_rejection` comment on the origin task with: the conflicting files, the verify verdict
or budget reason, and an explicit note that **auto-resolution was attempted and the original
commit is intact — fix forward, don't redo**. Emit `merge.resolution.escalated`. If the author
cannot resolve, normal human escalation applies (no new machinery — it's just an unresolved
task with a clear trail).

---

## 6. REST surface

Integrator-only (`ai_agent`), HTTP-only — no worker MCP tools (the resolver is operator/
integrator machinery, like the 7.4/7.5 channels). All under the project.

| Method + path | Purpose |
| --- | --- |
| `POST /api/v1/projects/{id}/merge-resolutions` | Open a resolution (`pending`) for an origin request. |
| `POST /api/v1/merge-resolutions/{id}/start` | → `resolving` (worktree built, agent spawned). |
| `POST /api/v1/merge-resolutions/{id}/resolved` | Record `resolved_request_id`, → `resolved`. |
| `POST /api/v1/merge-resolutions/{id}/escalate` | → `escalated`/`failed` with reason + target. |
| `GET  /api/v1/projects/{id}/merge-resolutions` | List/inspect (any authenticated user; debug + dashboard). |
| `GET  /api/v1/merge-resolutions/{id}` | Single resolution detail (any authenticated user). |

Each write records its transition in one transaction with the state change (audit-consistent,
per the 7.4 pattern). Config still flows through `PATCH /projects/{id}` (§3).

---

## 7. SSE events + observability

New events (relayed like the existing `merge.*` frames): `merge.resolution.pending`,
`merge.resolution.started`, `merge.resolution.succeeded`, `merge.resolution.escalated`,
`merge.resolution.failed`. Each tagged with `origin_request_id`, `resolution_id`, and (on
success) `resolved_request_id`.

These five are the exact event-constant names. They register in the event-bus `EVENT_NAMES`
under the existing `merge.*` namespace and auto-forward to SSE via the established `onAll`
relay — **no `routes/events.ts` edit is needed**, same as the other `merge.*` frames. Minor
convention note: the existing terminal `merge.*` events use `landed`/`rejected`/`completed`,
whereas here we keep `succeeded` deliberately for the resolution domain (it reads correctly for
"the resolver produced a clean, resubmitted change") rather than forcing a `landed`/`completed`
spelling.

**Timeline / dashboard (extends 7.4 §8.3):** the per-request timeline renders the lineage
chain — `origin (rejected conflict) → resolution attempt (state) → resolved request (its own
land timeline)`. The resolved request's timeline back-links to its origin via `resolved_from`.
A resolution in `resolving` shows as in-flight composition on the train dashboard so a
long-running resolver is visible, not mysterious latency.

**Metrics sub-block:** resolution attempt count, auto-resolve success rate (resolved-and-landed
/ attempts), escalation rate, mean resolver wall-clock + budget utilization. These feed the
existing 7.4 metrics bundle; no SLO enforcement (recorded, like 7.4).

---

## 8. Failure catalog

| Situation | Behavior |
| --- | --- |
| `resolver.enabled = false` + conflict | Plain `conflict` reject. **Byte-identical to 7.5.** |
| Resolver worktree build fails | `failed` → escalate to author. Origin already rejected; no `main` impact. |
| Headless agent spawn fails / `command` missing | `failed` → escalate. |
| Agent runs, output still conflicted / verify fails | `escalated` → author. Honest "too hard". |
| Budget (time/token) exceeded | Kill the session, `escalated` → author. |
| Resolved request conflicts AGAIN on the train | Normal `conflict` reject; resolver does **not** re-engage (`resolved_from != null`). Goes to author. |
| Resolved request fails verify on the train | Normal verify reject on the resolved request → author. (Local pre-verify was stale vs. a main that moved again.) |
| PM I/O throws mid-resolution | Best-effort: log + escalate. Never blocks the lane (lane was released at enqueue). |
| Two integrators on the lane | Lane-lock ownership unchanged (7.2); resolution is off-lock, keyed by `merge_resolutions` row so it isn't double-run. |

**Invariant:** `main` is only ever advanced by the normal land path on a verify-passed tree.
The resolver never pushes `main` directly — it only ever *submits a request*. Recovery and
resolution both route through the same verify gate.

---

## 9. Backward-compatibility invariant (the prime test)

With `resolver.enabled = false` (default), every code path added by 7.6 is skipped: a
`RebaseConflict` categorizes and rejects exactly as in 7.5, no `merge_resolutions` rows are
written, no events fire. This is asserted by a dedicated test (§10) and is the safety
guarantee for shipping the engine dark.

---

## 10. Testing

1. **off=inert** — `resolver.enabled=false`, force a conflict ⇒ plain `conflict` reject, zero
   `merge_resolutions` rows, zero `merge.resolution.*` events. (Byte-identical to 7.5.)
2. **happy path** — conflict ⇒ resolve ⇒ local verify pass ⇒ resubmit ⇒ resolved request
   lands; lineage chain intact (`resolved_from`, timeline).
3. **escalate on verify-fail** — agent produces a tree that fails verify ⇒ `escalated` ⇒
   author gets a `merge_rejection`; origin commit still present.
4. **escalate on budget** — session exceeds `time_budget_sec` ⇒ killed ⇒ `escalated`.
5. **no recursion** — resolved request conflicts again ⇒ plain reject, resolver does not
   re-engage.
6. **lane never held** — assert the lane lock is released before `resolving` begins (a second
   admit can proceed while a resolution runs).

---

## 11. Open items / v2

- **Semantic verify-failure resolution** (rebased clean, broke a test): the harder, open-ended
  cousin. Deferred to v2 once conflict resolution proves out.
- **Cross-repo group conflicts** through the resolver (v1 leaves them on the 7.3 path).
- **Iterative / multi-round** resolution with bounded rounds, if one-shot proves too weak.
- **Confidence-aware routing** — explicitly rejected for v1 (verify is the only arbiter); only
  revisit if a cheap, *verifiable* confidence signal emerges.
