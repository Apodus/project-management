# Roadmap — Stop bouncing merges the train could land itself (2026-08-15)

**Goal.** A cross-repo merge that fails for a reason nobody did anything wrong
about — main moved, a push raced — must be retried by the train, not handed back
to a human. And when a merge really does need its author, the author's SESSION
must learn about it without a person carrying the message from Discord.

Three findings, all verified in code, in descending order of how much they cost
today:

### A. On a cross-repo lane, "main moved" is a HARD REJECT

`group-land.ts:154-165` — the pre-land drift guard re-fetches both mains and, on
any movement, **rejects the whole group**. The reason string it writes is
literally `"live main drifted before land; re-verify next pass"` — the intent was
plainly a retry, and the implementation terminates the group instead.

The single-repo lane does the opposite in the identical situation:
`onMemberFailed` with `kind: "drift"` calls `resetToQueued`, and the member
**re-competes automatically on the next pass** with nobody notified. So the same
event is a self-healing hiccup on one lane and a bounce-to-human on the other.

`group-land.ts:184-202` is the same shape: an inner push that comes back
`non_fast_forward` — the definition of a lost race — rejects the group.

**This is almost certainly the bulk of the reported pain**, and it needs no AI at
all. `resetGroup(groupId, {reason})` already exists on the PM client, is already
used by `reclaimStrandedGroups`, and already does exactly the right thing:
integrating → forming, members back to queued, idempotent, with a corruption
fence that refuses to reset a group with an open orphan incident.

### B. A real cross-repo conflict never reaches the resolver

`maybeOpenResolution` has two call sites, both in the single-repo
`failure.kind === "conflict"` branch. The group path has none. So an assembly
conflict on a cross-repo lane is a hard reject even with `resolver.enabled: true`
— which it is on the rynx lane. The eligibility taxonomy that decides *which*
group failures deserve a resolver shipped in the previous campaign
(`resolution-eligibility.ts`); the executor behind it does not exist.

### C. The agent's session never hears the outcome

The wake daemon (`packages/wake-daemon-ref`) and `pm_check_messages` are
**escalation-only** — the daemon polls for unread escalation replies and spawns a
session; `check-messages.ts` drains "directed replies on escalations you raised".
A merge rejection reaches Discord and the web UI, and no further. So the author
agent either polls its own merge request on a babysitting timer or a human reads
Discord and pastes the news into the session. Both are the human acting as
transport for an event the system already has.

---

## What already exists — do NOT rebuild it

- **`resetGroup`** (pm-client `:508`, service `merge-group.service.ts:927`) —
  the group re-queue primitive, ai_agent-only, idempotent, incident-fenced.
- **The single-repo drift precedent** — `onMemberFailed` kind `"drift"`. Copy its
  SEMANTICS, and note it also cancels the open attempt before re-queueing.
- **`resolution-eligibility.ts`** — the per-assembly-reason decision, pinned to
  `AssembledGroupErr` both ways. R4 consumes it; do not re-litigate it.
- **The resolver session machinery** — pool, runner, in-session verify loop,
  no-recursion guard, 7.6.1's "train re-verify is the sole landing gate".
- **The wake daemon's shape** — poll → cooldown → spawn a bounded session with a
  built prompt, with a consecutive-failure park. R3 extends its SUBJECT, not its
  architecture.
- **`merge_resolution` comments** (previous campaign) — the author-facing "a
  resolver has this, don't start a manual fix" notice.

---

## R1 — Re-queue a group when nothing is wrong with the change

The cheapest, highest-value step in the campaign. No AI, no new machinery.

- **Drift before land** (`group-land.ts:154-165`) ⇒ cancel both attempts (as it
  already does), then `resetGroup` instead of `rejectGroup`. The group re-forms
  and re-integrates against the new main on the next pass.
- **Inner push `non_fast_forward`** (`:184-202`) ⇒ same treatment. A lost push
  race is not a verdict on the change.
- **Everything else stays a reject.** `auth`, `network` and `other` push failures
  are NOT races — retrying them silently would spin a lane against a broken
  remote. Categorize deliberately, and say in a comment why each arm is what it
  is.

**BOUNDED, or this trades a bounce for a silent infinite loop.** A group that can
never land must eventually stop and say so. Track a per-group re-queue count
(PM-side, so it survives a daemon restart) and after N (suggest 3):
- reject with a reason that names the loop — "re-queued 3× on live-main drift; the
  lane is moving faster than this group can assemble" — because that is a REAL
  finding about lane contention, not a failure of the change; and
- prefer that message over silence: the author needs to know the difference
  between "your change is wrong" and "you keep losing a race".

**Design question to settle in the plan:** does the re-queue count live on the
group row (a migration) or is it derived from the audit/attempt history (no
migration)? Bias to derived — this repo's migration history is a hazard area —
but only if the derivation is honest and cheap.

## R2 — Tell a stale base apart from a real conflict

A rebase that conflicts because main moved *while we were assembling* is a race;
a rebase that conflicts against the newest main is a real conflict that needs a
human or a resolver. Today both surface as `inner_conflict` / `outer_conflict`.

- Before declaring an assembly conflict, **re-fetch and retry the assembly once**
  against the newest main. If the retry succeeds, it was a race and nobody needs
  to hear about it. If it conflicts again, it is real — hand it to R4 (or reject
  with the taxonomy's sentence).
- Cap at ONE extra attempt per pass. The lane lock is held during assembly, so an
  unbounded retry loop starves every other merge — say so in the comment.
- Log the distinction (`stale_base_retry` succeeded/failed). "How often is the
  lane simply too busy?" is an operational question this answers, and it feeds
  the R1 bound above.

## R3 — Deliver merge outcomes into the author's session

Remove the human as transport. The channel already exists and is proven; it is
just scoped to escalations.

- **Extend the wake daemon** to also wake on a terminal merge outcome (rejected /
  re-queued-past-bound / landed-if-wanted) for a request whose submitter is a
  worker key it manages. Same architecture: poll → cooldown → bounded session,
  with the same consecutive-failure park.
- **Extend `pm_check_messages`** (or add a sibling) so a session that is already
  running can drain "what happened to the merges I submitted" between work steps
  — the poll-based floor under the daemon's push, exactly as the train's own
  cancellation poll is the floor under SSE.
- **The prompt matters more than the plumbing.** A woken session must get the
  rejection category, the reason (which now carries the taxonomy's guidance), the
  log excerpt, and — critically — whether a RESOLVER is already working it, so it
  does not duplicate the work the previous campaign's `merge_resolution` comment
  exists to prevent.
- **Never load-bearing.** A missed wake must never change an outcome; the merge
  request row stays the source of truth. Same contract SSE has.
- **Opt-in per project/worker**, default off, so nobody's session pool starts
  waking on merge traffic without asking.

## R4 — The cross-repo resolver executor

The expensive one. Only build the reasons that survive R1+R2 — those two remove
the races, leaving the genuinely conflicting cases that actually want an agent.

Two structural blockers, both verified:

- **`createResolverPool` is single-repo** (`resolver-pool.ts:169-192`): N
  worktrees from ONE `gitRepoUrl`. A cross-repo resolution needs correlated
  inner+outer worktrees, the way `assembleGroup` leases from two per-repo pools.
- **`merge_resolutions` is single-origin** (`schema.ts:1043-1060`): one
  `originRequestId`, one `resolvedRequestId`. A group resolution has two origins
  and must resubmit a GROUP.

**Start with the cheap shape:** `inner_conflict` → resolve in an inner-repo
worktree → resubmit as an **inner-only group** (`synthesize_outer: true`), which
the project's own MCP tool description calls the recommended form. That avoids
reconstructing the outer member at all, and sidesteps most of the second blocker
— the resolution row can name the failing inner member, with the resubmit
creating a new group.

Also note the resolver's completion criterion is `hasRemainingMarkers()` —
conflict-marker shaped. It is correct for `inner_conflict`/`outer_conflict` and
**meaningless for `gitlink_diverged`**, which is a rebase of a bump branch, not a
marker reconciliation. Either give that reason its own criterion or leave it
ineligible in practice until it has one; do not pretend one criterion fits both.

## R5 — Wire the hook, and seal

- Wire `rejectGroupLegibly` → `maybeOpenResolution` gated on
  `assemblyResolutionEligibility`, only for reasons R4 can actually execute.
  (The gate has shipped; the hook was deliberately left unwired so nothing could
  open a resolution that no executor would drain.)
- Tests: re-queue-not-reject on drift and on `non_fast_forward`; the bound firing
  after N; the stale-base retry succeeding and failing; a woken session receiving
  the right facts; eligibility→executor routing.
- Deployment guide §14.17/§14.18 extensions + a wake-daemon section for the new
  subject. CLAUDE.md capability index. Full suite + E2E.

---

## Design locks

1. **A race is not a verdict.** If nothing about the change is wrong, the train
   retries. Only a statement about the CHANGE reaches the author as a rejection.
2. **Every retry is bounded and every bound is legible.** A loop that never ends
   is worse than the bounce it replaced, and "you keep losing a race" must be
   said out loud rather than left to look like a mystery rejection.
3. **Retry only what a retry can fix.** Drift and `non_fast_forward` yes; `auth`,
   `network`, `other`, and any open-incident group NEVER (the `resetGroup`
   corruption fence already refuses the last one — do not fight it).
4. **Delivery is never load-bearing.** A missed wake changes no outcome. The
   merge request remains the source of truth, and a poll is the floor under any
   push.
5. **The train re-verify stays the sole landing gate.** Nothing a resolver
   produces lands without passing the normal verify.
6. **Don't duplicate the author's work.** A woken session must be told when a
   resolver already owns the failure.

## Sizing note

R1 is small and pays for the whole campaign — it is a reject→reset swap at two
sites plus a bound. R2 is small. R3 is moderate and mostly prompt/plumbing on an
existing daemon. R4 is the only large one, and R1+R2 shrink the set of failures
it has to handle before it is written.
