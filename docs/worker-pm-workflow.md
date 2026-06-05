# Project Management Workflow

The PM MCP server (`project-management`) is the primary command-post interface. When proposals, tasks, or discussion threads arrive through the PM:

- **Act directly.** Do not ask the user for permission on the CLI. Read the proposal/task, investigate the codebase, and respond through the PM discussion thread (`pm_discuss_proposal`, `pm_add_comment`, `pm_report_progress`).
- **Communicate through PM.** Post design analysis, questions, progress updates, and decisions back into the PM chain — not to the CLI. The user monitors all activity from the PM dashboard.
- **Progress reporting** goes through `pm_report_progress` on the relevant task, not CLI text.

The CLI is for interactive pair-programming and ad-hoc requests. The PM is for async directed work.

Your PM identity is derived from your session (the pool claim — `PM_POOL_NAME` / `PM_POOL_SECRET`). You never pass an author/reporter/assignee id; the server derives it. **Caveat:** on an MCP reconnect your session may rebind to a different pool identity, which strands any claims you were holding under the old one (you'll hit `CLAIM_DENIED` on work you know is yours). The fix is `pm_force_claim_*` — see **Recovering stranded claims** below.

## Session startup protocol

On every session start, before doing anything else:

1. `pm_get_my_work` — check if you have tasks in progress or epics assigned. Resume those first. If it shows nothing but you believe you had work in flight (e.g. after a reconnect), your claims may be stranded under a prior identity — see **Recovering stranded claims**.
2. `pm_check_updates` — check for human comments or status changes since your last activity.
3. `pm_list_proposals(claim="available", status="open")` and `pm_list_proposals(claim="available", status="discussing")` — check for proposals needing your input. The `claim="available"` filter hides proposals other agents are already working on. Proposals take priority over task execution.

## Task lifecycle (MANDATORY)

You MUST update task status at every stage. The human director monitors your work via the dashboard — if you don't update statuses, you're invisible.

```
1. CLAIM       →  pm_pick_next_task  OR  pm_start_task(task_id)
                  This sets status to "in_progress" and assigns you (the claim).
                  NEVER start working on a task without calling one of these first.

2. WORK        →  pm_report_progress(task_id, summary, completion_pct)
                  Call this periodically (at minimum: when starting a subtask,
                  when hitting a milestone, when encountering a blocker).

3. DECISIONS   →  pm_log_decision(task_id, decision, rationale)
                  Record non-obvious design choices so the human can review.

4. COMPLETE    →  pm_complete_task(task_id, summary, files_changed)
                  OR pm_request_review(task_id, summary) if human review needed.
                  This is the handoff — summarize what you did and what to verify.
```

If you get blocked: `pm_block_task(task_id, reason)`. Don't silently abandon tasks.

**Tasks are claim-gated too.** A task's assignee IS its claim. AI agents must hold the claim (be the assignee) to `pm_update_task` / transition / `pm_complete_task` / `pm_report_progress` — the server returns 409 `CLAIM_DENIED` otherwise. `pm_pick_next_task` / `pm_start_task` claim atomically as they start. To claim/release without starting: `pm_claim_task(task_id)` / `pm_release_task(task_id)`. Humans (the director) bypass the gate.

## Claims & ownership (MANDATORY)

The same soft-claim mechanism guards **proposals, epics, and tasks** so multiple agents coordinate without stepping on each other. **AI agents must hold the claim before writing.** The server rejects un-held writes with 409 `CLAIM_DENIED`. Humans bypass (they're the director).

The atomic claim returns one of:

- `✓ Claimed` — yours to work on.
- `✓ Already claimed by you` — idempotent re-claim is fine.
- `⚠ Claimed by another agent` — pick something else; do **not** retry.
- `⚠ Closed` — already in a terminal state.

The server never reveals other agents' identities — you only see whether _you_ can act. If `claim_status` says "claimed by another agent," that's the whole signal; don't try to find out who.

| Entity   | Claim                    | Release                    | Pick / start                          |
| -------- | ------------------------ | -------------------------- | ------------------------------------- |
| Proposal | `pm_claim_proposal(id)`  | `pm_release_proposal(id)`  | —                                     |
| Epic     | `pm_claim_epic(epic_id)` | `pm_release_epic(epic_id)` | `pm_pick_next_task(epic_id=...)`      |
| Task     | `pm_claim_task(id)`      | `pm_release_task(id)`      | `pm_pick_next_task` / `pm_start_task` |

Terminal transitions (proposal `completed`/`rejected`, etc.) clear the claim automatically.

**Epic ownership:** for a multi-task effort, `pm_claim_epic(epic_id)` first, then `pm_pick_next_task(epic_id=...)` to pull tasks from _your_ epic, and `pm_release_epic` when done.

### Recovering stranded claims (force-claim)

When your session identity changes (most often an MCP reconnect rebinding you to a new pool identity), work you were holding stays claimed under the **old** identity. Re-claim and complete both fail with `CLAIM_DENIED` — "claimed by another agent" — even though that other agent is the previous you. To recover:

- `pm_force_claim_task(task_id, reason)` — take over the task's claim to **yourself**.
- `pm_force_claim_epic(epic_id, reason)` — same for an epic.
- `pm_force_claim_proposal(proposal_id, reason)` — same for a proposal.

`reason` is **required** and recorded in the audit log (e.g. `"session identity changed on reconnect; recovering my stranded C1 task"`). The takeover is atomic and surfaces on the activity feed, so the director sees what happened and why. After force-claiming to yourself, the normal write/complete path works again.

- **Claim to yourself** (omit `assignee_id`): any agent may do this — it is the self-recovery path.
- **Targeting another agent** (`assignee_id=<user>`): only a human director may do this; an AI agent gets 403.

Force-claim is a deliberate, audited override — use it to recover genuinely stranded work or for an explicit handoff, not to grab a claim another live agent is actively using.

## Subsystem awareness

Before starting work in a subsystem — and again when you cross into a new area mid-task — check who else is in flight there:

- `pm_awareness_check(project_id, label?)` — returns the in-progress tasks for the project, optionally narrowed to a `label` (the subsystem/area tag, e.g. `renderer`, `rynx-ecs`, `scene-spawn`). Omit `label` for all in-flight tasks.

This is the boundary-time guard against cross-agent API drift (two agents reshaping the same subsystem from different tasks). If someone is already in flight in your area, coordinate (or pick different work) before you start editing.

## Proposal workflow

**Autonomous pickup is the default.** When you see an available open proposal, act on it immediately — do not wait for CLI guidance or human permission to begin analysis.

1. `pm_list_proposals(claim="available", status="open")` — find unclaimed open proposals.
2. `pm_claim_proposal(id)` — **claim before reading or writing.** If "claimed by another agent," go back to step 1 and pick a different one.
3. `pm_get_proposal(id)` — read the full context and any existing discussion.
4. Investigate the codebase. Understand the scope, affected systems, risks, and design options.
5. `pm_discuss_proposal(id, body)` — post your design analysis, plan, and any clarifying questions. Auto-transitions the proposal from "open" to "discussing" on first AI comment. This is your deliverable — make it thorough: problem summary, proposed approach, alternatives considered, risk assessment, estimated scope.
6. **Stop and wait.** The human reviews and either accepts (`accepted`) or rejects (`rejected`). Do not implement until the proposal reaches `accepted`. Check via `pm_check_updates`.
7. Once accepted: `pm_implement_proposal(id, epics, tasks)` creates the work items in one shot and transitions the proposal to `in_progress`. Or create epics incrementally with `pm_create_epic(project_id, name, proposal_id=...)` — just keep holding the claim.
8. Claim the epic and start working through the tasks.

### Proposal state machine

```
open ──(claim, then comment or discuss)──▶ discussing
  │                                            │
  │  ╭─(human accepts)─────────────────────────╯
  │  ▼
  ├──▶ accepted ──(implement / transition)──▶ in_progress ──▶ completed
  │
  └──(human rejects)──▶ rejected
```

Shortcut: from `open`/`discussing`, the AI agent (or human) can transition directly to `in_progress` if the work is trivially accepted. Use sparingly — most proposals benefit from the discussion gate.

### Creating new proposals / work items

- `pm_create_proposal(project_id, title, description)` — when you discover work mid-execution that should be discussed first. Starts `open` and **unclaimed**; claim it before commenting/transitioning.
- `pm_create_task(project_id, title, ...)` — create a task. No `reporterId` needed.
- `pm_create_epic(project_id, name, proposal_id?=..., category?=...)` — create an epic, optionally linked to a proposal. **If `proposal_id` is set, you must hold the claim** on that proposal. `category` tags it for the roadmap (see below).
- `pm_implement_proposal(id, epics, tasks)` — bulk-create epics+tasks from an accepted proposal and move it to `in_progress`. Requires the claim.

### Epic structure: dependencies & categories (this is the roadmap DAG)

The director's primary view is a **roadmap DAG** — nodes are epics (colored/grouped by category), edges are epic dependencies. Keep this structure accurate as you plan; it is how the director reads "where is the project."

- **Epic dependencies — author these explicitly.** `pm_link_epic_dependency(project_id, epic_id, depends_on_epic_id, dependency_type?)` records that `epic_id` (the dependent) depends on `depends_on_epic_id` (the prerequisite); `dependency_type` is `blocks` (default) or `relates_to`. This is the right tool for **planning-time epic sequencing** — "B can't start until A ships", "C2 follows C1", "gated on Epic 1". Remove with `pm_unlink_epic_dependency(project_id, epic_id, dependency_id)`. Self-deps and duplicates are rejected; cycles are surfaced (not blocked).
- **Derived edges are automatic — but only CROSS-epic.** Epic edges are also rolled up from cross-epic task `blocks` deps (a task in B blocking a task in A ⇒ edge A→B). You don't author those. Note: phase ordering _within_ one epic (P1→P2→P3 via task `depends_on`) is intra-epic and produces **no** epic edge — so use explicit `pm_link_epic_dependency` for epic-level sequencing; don't expect it to fall out of phase deps.
- **Category.** Pass `category="<name>"` to `pm_create_epic` to group/color the epic on the roadmap (e.g. `rendering`, `terrain`, `editor`). The set is project-defined by the director — match an existing epic's category where you can (`pm_list_epics` shows them); if you don't know the set, leave it unset rather than invent one.

## Landing changes: the merge train

**This is the recommended way to land changes.** You do NOT manually merge to main, and you do NOT hold a lock during verify. You submit a merge request and walk away; a separate long-lived **integrator** process picks it up, rebases onto live main, runs the project's verify in an isolated worktree, and either lands it (fast-forwards main, attaches a `landed_sha` git_ref to your task) or rejects it (posts a structured `merge_rejection` comment). **Main is never broken** — verify runs against the rebased tree before main moves.

```
1. Commit your change to a branch (or pin a commit SHA).
2. pm_request_merge(project_id, task_id, branch="feat/...")  ← or commit_sha="..."
3. Walk away. Subscribe to the SSE events merge.request.landed /
   merge.request.rejected with the returned request id for the outcome,
   or poll pm_get_merge_request(id).
```

- `pm_request_merge(project_id, task_id, branch | commit_sha, resource?, verify_cmd?)` — submit. `task_id` is strongly recommended (it enables the `landed_sha` git_ref on land and the `merge_rejection` comment on reject). Pin `commit_sha` if you might keep committing on the branch while it's queued. `resource` defaults to `"main"` (the lane).
- `pm_list_merge_requests(project_id, resource?, status?, task_id?)` — see your queued/integrating/landed/rejected requests and queue position.
- `pm_get_merge_request(id)` — full detail incl. attempts. For a **rejected** request the structured envelope (category, reason, failed files, log URL) is at the top — read it, fix, resubmit.
- `pm_cancel_merge_request(id, reason?)` — cancel a request from **queued OR integrating** (not just queued). **Any agent may cancel any request** — it is not owner- or admin-gated (collaborative env); cancelling an `integrating` request interrupts the in-flight integration and is audit-logged (pass a `reason`). A **grouped member can't be cancelled individually** (409 `GROUPED_MEMBER` — reject the group instead).

**Verify is handled by the train, not you.** The integrator runs the project's configured verify — which may be a multi-step pipeline (cheap checks first, fail-fast, independent steps in parallel) with result caching, so a fast land can mean a cache hit. You normally just submit; only pass `verify_cmd` to override for a one-off.

The low-level Stage-1 `pm_acquire_merge_lock` / `pm_heartbeat_merge_lock` / `pm_release_merge_lock` tools still exist but are for driving integration yourself. As a worker, **use the merge train (`pm_request_merge`)** — don't hand-roll locks.

### Submit-and-move-on (do NOT babysit the merge)

"Task done" is **decoupled** from "merge landed." Once you have committed your change and submitted the merge request with proof of work, your task is **handed off** — immediately pick up the next work item. Do not sit and poll for a `landed` message.

```
finish work → pm_request_merge (with task_id, as proof) → mark task handed-off → pm_pick_next_task
```

Why this is safe to walk away from: the integrator rebases YOUR change onto live main on your behalf, under a lane lock. **You can no longer lose a race to a "moving main"** — if your change doesn't textually overlap something that landed while you were working, it just lands, with zero further involvement from you. That is the common case. Blocking on the outcome wastes your turn.

### When a merge is rejected: it's a new ticket, not a stall

A rejection is **ordinary new work**, not a failure state to halt on. It arrives asynchronously as a `merge_rejection` comment on your task — you'll see it via `pm_check_updates` on a later turn. Pick it up then, the same as any other task.

- **Your work is never lost.** A rejected request still holds your commit/branch. **Never redo the task from scratch** — read the rejection envelope (`pm_get_merge_request(id)`: category, reason, failed files, log URL), fix forward, and resubmit.
- **Two real reasons a merge rejects** (the "moving main" race is NOT one of them anymore): a **textual conflict** (you and another agent edited the same lines) or a **verify failure** (rebased clean but broke a test/build). Both are genuine and worth your attention — but only when the rejection comes back, not as a thing you wait for.
- _(An automated conflict resolver has SHIPPED behind the opt-in `resolver.enabled` flag: when enabled, the train may reconcile a textual conflict for you and resubmit the result as a linked new request, so many conflict rejections resolve without ever reaching you. It's opt-in and verify-gated — if it can't land a clean tree within its budget, the conflict is handed back to you as a normal `merge_rejection` with the original commit intact. Treat any `merge_rejection` that does reach you as a normal ticket.)_

## Cross-repo changes: merge groups (rynx inner + outer)

game_one is a cross-repo setup: the **rynx** inner Rust workspace is embedded in the outer game repo as a gitlink (submodule). A change that spans both must land as a unit or not at all — otherwise the outer gitlink points at an inner SHA that isn't on inner's main. Use a **merge group**:

```
1. Commit the inner (rynx) change and the outer (gitlink-bump) change on their branches.
2. Submit + group in ONE atomic call (PREFERRED — race-free):
     pm_request_merge_group(project_id, members=[
       { branch="rynx/feat-x",  task_id=... },
       { branch="outer/bump-x", task_id=... },
     ])
   Members are born group-bound — a single-repo pickup can never grab one mid-grouping.
3. Walk away. Subscribe to merge.group.landed / merge.group.rejected,
   or poll pm_get_merge_group(group_id).
```

- `pm_request_merge_group(project_id, members[] | member_request_ids[], resource?)` — submit ≥2 requests as one atomic cross-repo unit. **Provide exactly one form.** Prefer `members` (each `{ branch and/or commit_sha, task_id?, verify_cmd? }`) — PM submits AND groups in a single call, race-free. `member_request_ids` is the legacy form: bind ≥2 requests you already queued via `pm_request_merge`. The integrator lands the whole group atomically (inner first, then the outer gitlink) — **every member lands together or none does**.
- `pm_get_merge_group(group_id)` — member statuses + whether the group has landed/rejected/is still forming.

### When a cross-repo land half-fails: incidents

If the inner repo's main lands but the outer gitlink update then fails, the system records a durable **incident** (an "orphaned inner") rather than silently diverging — so the gap is detectable from PM alone. Recovery is automatic when possible (a later integration rolls the outer gitlink forward to absorb the orphan) and otherwise escalates to a human.

- `pm_list_merge_incidents(project_id, state?)` — open / auto_resolved / human_resolved.
- `pm_get_merge_incident(id)` — the orphaned inner repo/SHA, the outer repo whose gitlink wasn't updated, the linked task, and the resolution.

For a worker these are mostly informational — if `pm_get_merge_group` shows a partial land, check incidents to see whether it auto-recovered or needs a human.

## Dashboard visibility

The human sees "Active AI Agents" on the dashboard. You appear there ONLY when:

- You have tasks with status `in_progress` assigned to you (claimed), **or**
- You hold a claim on a proposal.

If you start coding without `pm_start_task` (or a proposal claim), you are invisible — the human will think no one is working. If your work ever shows as held by "another agent" after a reconnect, you've been re-identified; `pm_force_claim_*` to take it back (see **Recovering stranded claims**).
