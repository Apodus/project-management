# Roadmap — Group-path parity: the kill seam and the resolver both stop at the group boundary (2026-08-15)

**Goal.** Two capabilities the train already has stop dead at the cross-repo
boundary, and game_one is a cross-repo lane — so for most of its traffic neither
exists. Close both.

**The two holes, verified in code:**

1. **The kill seam.** `group-integration.ts:818-836` passes `signal: undefined`
   to both `runPipeline` calls, with the comment "Groups have no member-level
   kill". So neither trigger from the 2026-08-04 campaign — the cancellation
   watcher nor the output-stall watchdog — can reach a grouped merge. A cancelled
   or hung cross-repo verify still burns to `verify_timeout_sec` (9000s on
   game_one).

2. **The resolver.** `maybeOpenResolution` has exactly **two** call sites
   (`batch.ts:943`, `loop.ts:324`), both inside `failure.kind === "conflict"` in
   the SINGLE-REPO path. `group-integration.ts` / `group-assembly.ts` /
   `group-land.ts` contain **zero** references to it. A cross-repo lane therefore
   never spins a resolver, no matter how mechanical the failure — which is the
   reported symptom: "the auto-resolve workflow almost never seems to activate."
   The grunt work it was built to absorb lands back on the client agents.

**Precondition to check before believing any of this fixes anything:**
`settings.integrator.resolver.enabled` defaults to **false**. Confirm it is
`true` on the game_one project — if it is not, that alone explains the silence
and this campaign changes nothing until it is flipped.

---

## What already exists — do NOT rebuild it

- **The kill seam itself** — `kill-tree.ts`, `runVerify`'s `signal` +
  `liveness` options (`git-ops.ts`), and the two watcher arms in `batch.ts`
  (`startCancellationWatcher`, `isTerminalForUs`, `onMemberCancelled`). The group
  work is a SECOND CALLER of these, not a second implementation.
- **The group reject choke-point** — `rejectGroupLegibly`
  (`group-integration.ts:517`) is already the single place a group reject is
  surfaced. The resolver hook belongs there, mirroring how `maybeOpenResolution`
  sits immediately after `rejectMergeRequest` in `batch.ts:943`.
- **The resolver loop** — Phase 7.6.1 already gives the session its own verify
  loop and makes the TRAIN re-verify the sole landing gate. Widening the trigger
  cannot land unverified work.
- **The no-recursion guard** — `maybeOpenResolution` already refuses to resolve
  a request that is itself a resolution product (`resolvedFrom != null`), with a
  fresh re-read to close the mid-flight window. Reuse it; do not reinvent it.
- **The assembly failure taxonomy** — `AssembledGroupErr.reason` is already a
  closed union (`group-assembly.ts:86-92`).

## Deliberately OUT of scope

- **Tier B (semantic verify failures → resolver).** Pointing the resolver at
  `build_failed` / `test_failed` / `lint_failed` needs a guardrail this campaign
  does not build: the resolver can satisfy the verify gate by WEAKENING it
  (deleting an assertion, skipping a test). That needs a diff-scope restriction
  (no test/verify/CI files unless the origin diff already touched them) and a
  shadow→on rollout, and it deserves its own campaign.
- **Tier C, permanently.** `verify_timeout`, `verify_stall`, transient/spawn
  errors, push races, drift. A resolver cannot fix infrastructure; letting it try
  burns budget and pollutes the audit trail.

---

## S1 — The group verify kill seam

Give the cross-repo lane the same two triggers the single-repo lane got on
2026-08-04.

- `runGroupLaneOnce` processes ONE group per call and awaits inner + outer
  `runPipeline` concurrently, so this is SIMPLER than `batch.ts`'s case: there is
  no admit/drain loop and no speculative suffix. One `AbortController` per group
  pass, one liveness box shared by both repos' pipelines, one watcher started
  around the verify await and stopped in a `finally`.
- **A group is one atom.** Killing one repo's verify must tear down BOTH — a
  half-verified group is meaningless. That is the same "invalidate together"
  logic the group path already applies everywhere else.
- **Cancellation arm.** Poll the group's MEMBER request statuses (a group
  member's status is what a worker cancels). Any member no longer `integrating`
  ⇒ abort the whole group pass. Same fail-open rule: only a positive, successful
  terminal read may kill; every read failure leaves the verify running.
  - **Watch the pre-pickup window.** Assembly happens while the group is
    `forming` and members are still `queued`; `isTerminalForUs` treats `queued`
    as terminal (correct in the single-repo post-pickup context, WRONG here).
    The group watcher must only run once the group is `integrating`, or it will
    kill every group during assembly. This is the single sharpest trap in S1 —
    call it out in the code and pin it with a test.
- **Stall arm.** Reuse `verify_stall_sec` unchanged; the shared liveness box
  means "either repo is still talking" counts as alive, which is right.
- **Terminal bookkeeping.** A cancelled group must go through the group's own
  reject/abandon path (`rejectGroupLegibly` or the existing cancel handling), NOT
  `onMemberCancelled` — that function is `batch.ts` member-shaped and knows
  nothing about atomic group state.

## S2 — Tell the worker a resolver is on it

The cheapest win in the campaign, and it is worth landing even alone.

Today the origin is rejected FIRST and the resolution opens after, so the
`merge_rejection` auto-comment — the thing a worker agent actually reads via
`pm_get_merge_request` — cannot mention the resolution that does not exist yet.
The worker therefore starts the manual fix that a resolver is concurrently
doing. That is the exact duplicated-grunt-work complaint.

- Keep the ordering (reject first, resolve after): an immediate honest answer is
  better than a slow one, and the resolution is additive.
- After a resolution is opened, ADD to the origin's rejection surface that a
  resolver session is running and what to watch for (the linked resolution id,
  and later the resubmitted request). Verify first whether the existing
  `resolution` / `resolution_origin` timeline events already carry enough — if
  they do, the gap is only in the rejection COMMENT, which is the agent-facing
  surface.
- Say plainly what the worker should do: **wait for the linked MR, do not start
  a manual fix**, and what happens if the resolver fails (it escalates back).

## S3 — Cross-repo resolution plumbing

The two structural blockers, both verified:

- **`createResolverPool` is single-repo** (`resolver-pool.ts:169-192`): N
  worktrees from ONE `gitRepoUrl`. A cross-repo resolution needs CORRELATED
  inner+outer worktrees, the way `assembleGroup` leases from two per-repo pools.
- **`merge_resolutions` is single-request shaped** (`schema.ts:1043-1060`): one
  `originRequestId`, one `resolvedRequestId`. A group resolution has two origin
  members and must resubmit a NEW GROUP.

Decide and justify ONE of:
- **(a)** migration adding `origin_group_id` / `resolved_group_id`; or
- **(b)** no migration — the resolution row points at the failing MEMBER, and the
  resubmit creates a new group via the existing group-submit path, linked through
  the resubmitted request.

Bias toward **(b)** unless (a) buys something concrete: this repo's migration
history is a hazard area (the 2026-06-10 silent-skip incident), and a resolution
that names its failing member is not obviously worse than one that names a group.
Whichever is chosen, the resolver's prompt and completion criterion must be
group-aware: the agent must see BOTH trees and understand that its output is a
group resubmission.

## S4 — Wire the group reject to the resolver

At the `rejectGroupLegibly` choke-point, open a resolution for the
**resolver-eligible** assembly reasons only:

| reason | eligible? | why |
| --- | --- | --- |
| `inner_conflict` | **yes** | textual rebase conflict — the resolver's home ground |
| `outer_conflict` | **yes** | same, on the outer repo |
| `gitlink_diverged` | **yes** | the bump branch is stale; a two-repo agent can genuinely rebase it |
| `gitlink_unreachable` | **NO** | the inner commit was never pushed. The objects do not exist anywhere the daemon can reach — no agent can materialize them. Rejecting is the only honest answer, and the reject message should say "push your inner branch". |
| `gitlink_mismatch` | **NO** | a post-assembly assertion failure = a TRAIN bug. A resolver papering over it destroys the evidence. |
| `backpressure` | **NO** | not a failure; the group retries next pass. |

- Reuse `maybeOpenResolution`'s no-recursion guard.
- Non-fatal, exactly like the single-repo hook: a resolver failure must never
  reach the group reject path or the lane loop.
- Also consider the POST-PICKUP verify-fail path
  (`group-integration.ts:871+`) — but only for `conflict`-category failures.
  Verify failures are Tier B and out of scope.

## S5 — Seal

- Tests: the pre-pickup trap (S1), a cancelled group aborting both repos, a
  stalled group, eligibility for each assembly reason (a table-driven test is the
  honest shape — it fails when someone adds a reason without deciding), the
  no-recursion guard on the group path, and the worker-facing rejection text.
- Deployment guide: extend §14.17 (the kill seam now covers groups) and add a
  resolver-reach section explaining the tier taxonomy and WHY
  `gitlink_unreachable` is deliberately never resolved.
- CLAUDE.md capability-index update.
- Full suite + E2E.

---

## Design locks

1. **One kill seam, one watcher implementation.** The group lane is a second
   CALLER of the 2026-08-04 machinery, never a second copy of it.
2. **Never kill a healthy verify.** Fail open on every read failure. And never
   kill during assembly — a `queued` member pre-pickup is not a cancelled one.
3. **A group is an atom.** Kill both repos or neither; reject the group, never a
   half-member.
4. **The resolver never lands anything.** The train re-verify remains the sole
   landing gate (7.6.1). That is what makes widening the TRIGGER safe.
5. **Eligibility is a decision, not a default.** Every assembly reason is
   explicitly eligible or explicitly not, with a stated why. A new reason must
   not silently inherit either answer.
6. **Honest rejects stay honest.** `gitlink_unreachable` and `gitlink_mismatch`
   must keep rejecting. Absorbing an unfixable failure into a resolver session
   converts a clear answer into a slow, confusing one.
