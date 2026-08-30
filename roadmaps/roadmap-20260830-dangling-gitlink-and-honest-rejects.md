# Roadmap — A dangling gitlink on outer main, and a reject that asserts its own innocence (2026-08-30)

**Goal.** On 2026-08-29/30 game_one's cross-repo lane died for every group,
regardless of contents, and every author was told the failure was *"a defect in
the train, not in the change"* — a sentence the train had also been wrong about
five times that week. Nothing detected the state, nothing named it, and
`pm_list_merge_incidents` said "No merge incidents" throughout. Close all three
gaps: make the invariant checkable, make the check run, and stop the reject from
exonerating itself.

Source: game_one note `01M18QWM9RAFVQNFX4FE461B23` (five recommendations) and
`01M18PB8DX5VYZ4QQGVX20MBGH` (the outage), plus their
`docs/merge-train-orphaned-inner-incident.md`.

---

## What actually happened — verified in code, not taken on report

**1. The train did not create the bad gitlink, and could not have.**
`group-assembly.ts` step 8 (`updateSubmoduleGitlink`) authors the committed
gitlink to `Ri` in **every** arm, and `group-land.ts` pushes inner **before**
outer. A train landing therefore yields gitlink→landed-inner, or fails before
pushing, or produces the *opposite* orphan (inner landed, outer push failed →
`orphaned_inner` incident, `group-land.ts:400`). Outer main's gitlink at an
unlanded inner commit is reachable **only** by a push that bypassed the train.
`1ba6a1ffd` was such a push.

**2. What turned a bad commit into a lane-wide outage is our own fetch.**
`worktree.ts:148` `resetForAttempt()` runs `git fetch <remote>` with git's
default `fetch.recurseSubmodules=on-demand`. Git tried to recurse into the
`rynx` gitlink at the new superproject commit, could not, and exited non-zero.
The client's pasted reject detail is the proof — the fetch's own progress line
`ecc5687c4d..faf7bc9e24  main -> origin/main` immediately followed by git's
`Could not access submodule 'rynx' at commit 1ba6a1ffd6`, which is
`submodule.c`'s fetch-recursion message, not ours. It throws inside
`assembleGroup`'s `try`, **before any classification runs**.

**2b. AMENDED 2026-08-30 after empirical reproduction (git 2.53, real repos).**
The dangling target is **not a necessary condition**. The fetch fails when BOTH:
(a) the fetch advances main across a commit that *changes* the managed gitlink —
reachable or dangling, it does not matter; and (b) the gitlink path in the slot
is **populated but not an openable repo**. Condition (b) is exactly what
`materializeSubmoduleWorktree` (`git-ops.ts:1133`) leaves in the OUTER slot
**permanently**: the outer pool is constructed with `gitlinkPurgePaths: []` on
purpose (`index.ts:331`), and `reset --hard` / `clean -fdx` are blind to content
at a committed gitlink path. Measured: empty dir + dangling target → exit 0;
populated overlay + dangling → exit 1; populated overlay + **reachable** target →
exit 1; `fetch.recurseSubmodules=no` → exit 0 in every case.

Two consequences, both load-bearing for this campaign:

- **The outer slot is poisoned from its first cross-repo assembly onward**, and
  any later gitlink bump on main kills the next fetch in that slot — **including
  a bump the train itself just landed**. This is a standing, self-inflicted,
  recurring lane-killer independent of the invariant this campaign is named
  after, and it is the most plausible account of the part of the client's report
  the original analysis could not explain: *"it had already been wrong five times
  that week for a different cause."* A lane that lands cross-repo groups poisons
  its own next fetch.
- **S2 MUST NOT assume "the fetch succeeded ⇒ the gitlink is fine."** The two
  conditions are orthogonal. S2's gate is not implied by S1's fix and must stand
  on its own reading of the invariant.

S1 is therefore independently valuable, not merely the enabler for S2. The
ordering trap below is UNCHANGED — S1 alone still lets assembly rewrite main's
pointer backward — so the sequencing does not move, only the stakes.

**3. The exoneration is one line, reached by a catch-all.**
`group-assembly.ts:627-640` catches **any** throw mid-assembly and maps it to
`reason: "gitlink_mismatch"` — a reason whose own doc comment (`:81`) says "the
§11 post-assembly assertion failed". `resolution-eligibility.ts:136` then
hard-codes that reason as class `train_bug` with the sentence *"That is a defect
in the train, not in the change"*, and since the group-path-parity campaign
(`group-integration.ts:785-787`) that `why` string is appended **verbatim** to
the author-facing reject. So the sentence is not rhetoric anyone chose for this
failure: **it is bolted to the one reason that is also the dumping ground for
every unclassified error.** Both halves of the client's complaint are the same
catch block.

**4. The detector genuinely watches one direction only.**
`MERGE_INCIDENT_TYPES = ["orphaned_inner"]` (`packages/shared/src/schemas/merge-incident.ts:14`)
— one value, opened from exactly one site (`group-land.ts:400`) when the outer
push fails after the inner landed. No code path anywhere evaluates
`outer main gitlink ∈ inner main`, and `group-recovery.ts:93` keys **solely** off
open PM incident rows, so nothing can detect the inverse. The client's reading is
exactly right.

**5. Their three-dot finding is correct, and the rule is not ours.**
`git diff --name-only origin/main...<branch> -- rynx` compares against the merge
base, so it catches the submitter's own gitlink commit and can never catch one
already on main. That rule lives in *their* repo; our deployment guide never
states it. The right home for "is main itself sane" is not a submitter rule at
all — submitters should not be asked to audit main — it is the assertion in S2.

---

## The two recommendations we are NOT taking as written

**R1 — reject a user-authored gitlink change at submission.** It would not have
prevented this outage: `1ba6a1ffd` never went through `pm_request_merge*`, so
there was nothing to reject. It also cuts against **§14.11**, which deliberately
*tolerates* a user-authored gitlink hunk and normalizes it (strip + author to
`Ri`) rather than refusing it — reinstating a refusal would undo a shipped
campaign. And PM-server holds no clone, so it cannot run `git diff` at submit
time. **The honest replacement is S2**: assert the invariant where a clone
exists. Say this back to them explicitly; it is a correction, not a decline.

**R5 — make cross-repo landing atomic.** It already is, for anything the train
lands (finding 1). The gap is that outer `main` accepts direct pushes, which is
outside the train's reach entirely — a branch-protection / pre-receive concern on
their forge. That makes R2 the compensating control, and this campaign agrees
with them that it must be mandatory rather than advisory.

---

## THE ORDERING TRAP — read before sequencing anything

**S1 must not ship without S2.** If the fetch stops choking, assembly proceeds
and step 8 rewrites outer main's gitlink to `Ri` = live inner main — moving the
submodule pointer **backward**, from `2f448c0a` to `0d82eba4`. That is precisely
the resolution the client's owner examined and **rejected**: "two landed outer
commits depend on the new engine code, so that would have traded an assembly
failure for a compile failure." A loud unclassifiable stall would become a silent
submodule regression that breaks the outer build for everyone on main.

So S1 is not the fix. S1 is what lets us **reach** the gate. S2 is the gate.

---

## What already exists — do NOT rebuild it

- **Every primitive S2 needs.** `GitOps.readSubmoduleGitlink(path)` reads the
  committed 160000 target from the worktree HEAD; `objectPresent(ref)` is a
  numeric-exit presence probe; `isAncestor(a, b)` is a **direct spawn** reading
  the numeric exit code (0/1/other→throw) precisely so an undecided ancestry
  escalates instead of being misread. `group-recovery.ts:186-200` already
  composes exactly this trio for the other direction — mirror its rigor.
- **The incident record.** `merge_incidents` already carries `type` /
  `inner_repo` / `orphaned_sha` / `outer_repo` / nullable `group_id` /
  `inner_request_id` / `task_id`, and the state machine
  `open → auto_resolved | human_resolved` with an idempotent same-terminal
  resolve (`merge-incident.service.ts:assertCanTransition`). `type` is a plain
  text column with the enum in `@pm/shared`. **A new type needs no migration.**
- **The reject choke-point.** `rejectGroupLegibly` (`group-integration.ts`) is
  already the single place a group reject is surfaced with a `merge_rejection`
  comment and a category.
- **The eligibility taxonomy.** `resolution-eligibility.ts` is already an
  exhaustive switch over a **pinned mirror** of `AssembledGroupErr["reason"]`
  (`_AssemblyReasonMirrorIsExact`), so a new reason is a compile error until
  someone decides it. S3 rides this, it does not replace it.
- **The alert + Discord feed path.** Incidents already reach SSE + Discord
  (§15.4a, `train-feed-listener.ts`). A new type is additive.

## Deliberately OUT of scope

- **Blocking direct pushes to outer main.** Their forge's problem, not the
  train's. Name it in the write-back; do not build a half-guard here.
- **A submit-time gitlink refusal (R1).** See above.
- **Auto-healing a dangling gitlink.** Both cures — land the inner, or revert the
  outer gitlink — change what consumers of main compile, and the client's own
  incident shows the choice needed a human who knew whether the engine work was
  ready. The train must **detect and refuse**, never pick.

---

## S1 — Stop git chasing the gitlink on our own fetches

The integrator manages the gitlink by hand: assembly authors it (step 8),
`fetchFromPath` + `materializeSubmoduleWorktree` populate it, and **§14.8 already
forbids** a verify command from running `submodule update --init` there. Git
recursing into it automatically is pure liability — it is the difference between
"main has a bad gitlink" and "every cross-repo group dies with an error nobody
can classify."

- Suppress automatic recursion on the pool clones and every fetch/checkout/reset
  the integrator drives: `fetch.recurseSubmodules=no` (and
  `submodule.recurse=false`). Prefer setting it **on the clone**
  (`worktree.ts:126`, `binding-clone.ts:22`) so it is durable across the
  long-lived slot, rather than per-invocation flags scattered over `git-ops.ts` —
  but pin the behavior with a test either way.
- **Do not disturb the deliberate explicit recursion.** `git-ops.ts:1165-1190`
  runs `submodule update --init --recursive` in the INNER worktree on purpose, to
  prep nested submodules for the overlay. That is an explicit call and is
  unaffected by the automatic-recursion config; confirm this rather than assume
  it, and leave it alone.
- Verify the scope question: does this belong on both lanes or only the outer
  (the one carrying the managed gitlink)? Bias to **both** — an automatic
  recursion the integrator never wants is never wanted — but state the finding.

## S2 — Assert the invariant, in the direction nobody watches

The assertion, in the client's own terms: **`outer main gitlink ∈ inner main`.**

- **Where.** In `assembleGroup`, immediately after `baseOuterSha` is resolved
  (`group-assembly.ts:~325`) and **before** the outer classify/rebase and before
  step 8 can author anything. Both worktrees are already leased and already
  reset, so the check costs one `ls-tree` + one `cat-file -e` + one `merge-base
  --is-ancestor` and needs no new plumbing.
- **The three outcomes**, mirroring `classifyOuterGitlinkDiff`'s discipline:
  - **ancestor of live inner main (or equal)** → invariant holds, proceed
    unchanged. This is the happy path and must stay byte-identical.
  - **present but NOT an ancestor** → main is dangling. Reject (see below).
  - **absent after an all-refs fetch** → main references a commit that was never
    pushed. Same reject; the detail differs.
- **Fail-open on an undecided check only, never on a decided one.** A spawn
  error / bad object / exit-128 must **not** reject the group — that would let a
  broken probe wedge a healthy lane. Log it, proceed with today's behavior. But a
  *successful* not-ancestor answer is a hard gate. This is the split
  `group-recovery.ts` already makes (`escalate` on an ancestry throw), inverted
  for a gate rather than a push.
- **New assembly reason** — `main_gitlink_dangling`, with its own
  `RejectCategory` (do not collapse it into `other`; that is how this became
  invisible).
- **What the reject says.** It must state, in the author's comment, that **main
  is in a broken state and this is not their change**, name the dangling target
  and the live inner main, name the incident id from S4, and give the two
  resolutions a human must choose between (land the inner commit, or revert the
  outer gitlink) with the warning that the second changes what consumers compile.
  Take the sentence from the eligibility taxonomy as S3 requires, so there is one
  source of truth.
- **Reject, do not re-queue.** The 2026-08-15 "a race is not a verdict" rule
  (`resetGroup` on drift / `non_fast_forward`) does **not** apply: a broken main
  is not a lost race that the next pass self-heals, it needs a human decision.
  Re-queuing would spin to the bounded 4 attempts and end in a worse-worded
  reject anyway. Justify this explicitly in the code comment — the next reader
  will reasonably wonder why this one rejects.

## S3 — Split the catch-all from the assertion, and drop the exoneration

- **New reason `assembly_error`** for `group-assembly.ts:627`'s catch-all. Keep
  `gitlink_mismatch` for the §11 post-assembly assertion **only** (`:596`,
  `:606`), which is what its doc comment already claims it is.
- **New eligibility class `unknown`** in `resolution-eligibility.ts`:
  `eligible: false`, but its `why` must **name the check to run** instead of
  assigning blame — e.g. *"an unexpected git failure during assembly; the cause
  is not classified. Before assuming a train defect, check that outer main's
  gitlink target is present on the inner main."* The existing classes are
  `mechanical` / `not_a_failure` / `author_only` / `train_bug`; none of them can
  honestly hold "we do not know", which is exactly why the catch-all borrowed
  `train_bug`'s.
- **Reword `gitlink_mismatch`'s `why`.** Even where a train bug is the genuine
  diagnosis, drop *"That is a defect in the train, not in the change"*. State
  what was asserted and what failed; let the reader draw the conclusion. The
  client's sharpest sentence — *"a message that pre-emptively exonerates itself
  trains readers to stop investigating"* — is the acceptance criterion.
- **Give `main_gitlink_dangling` its verdict too.** `eligible: false`. Class:
  reuse `author_only`? **No** — it is neither. Prefer a class that says the fault
  is in the lane's state, or fold it under `unknown` with a specific `why`.
  Decide and justify; the exhaustive switch will not let it be skipped.
- Both new reasons must appear in `group-integration.ts`'s
  `asm.reason → RejectCategory` map. The pinned mirror makes omission a compile
  error in `resolution-eligibility.ts` but **not** in that map — check whether
  that map is exhaustively typed, and make it so if it is not.

## S4 — Make `pm_list_merge_incidents` tell the truth

- **New incident type `dangling_gitlink`** in `MERGE_INCIDENT_TYPES`. Same broken
  invariant as `orphaned_inner`, opposite direction. **No migration** — `type` is
  a text column and the state machine is unchanged. Confirm this before writing
  code; this repo's migration history is a hazard area (the 2026-06-10
  silent-skip incident).
- **Column reuse, documented.** `orphaned_sha` holds the dangling gitlink target
  for this type; `group_id` / `inner_request_id` are null (no group produced it).
  The column name is imperfect for the new type — say so in the schema comment
  rather than minting a migration to rename it.
- **Opened from S2's gate**, best-effort and non-fatal: a failure to open the
  incident must never change the reject outcome (the `noteOuterConverted`
  precedent in `group-integration.ts`).
- **Idempotent.** A blocked lane will hit the gate on every pass. Do not open N
  incidents — reuse the open one for the same `(project, resource, orphanedSha)`.
  Decide whether that dedup lives in the service or the integrator; bias to the
  **service**, so a restarted daemon cannot duplicate.
- **Auto-resolve when the invariant holds again.** Whoever fixes main (either
  cure) makes the check pass; the next gate evaluation should `resolveAuto` the
  open incident with a note naming what it observed. This is the same shape as
  `recoverOrphanedInner`'s rollforward, minus the push — the train observes the
  cure, it never applies one.
- **Update the MCP tool description**
  (`packages/mcp-server/src/tools/merge-groups.ts:201`): today it says incidents
  are "an inner repo's main landed but the outer gitlink was NOT updated", which
  is why a correct agent read "No merge incidents" and believed it. It must
  describe **both** directions.
- Web: the incident surface must render the new type without falling through to
  a blank or an `orphaned_inner` label.

## S5 — The periodic probe (R2's "cheap enough for a timer")

S2 fires only when a group is submitted — which is when it matters most, but it
means a lane with no traffic hides a broken main until someone tries to land.

- Evaluate the same assertion on a low-frequency schedule in the group lane.
  **Mind the fast path:** `batch.ts:2737-2762` deliberately avoids taking the
  lane lock when there is no forming group and no open incident. A probe that
  leases an outer worktree every pass would destroy that. Prefer: piggyback on
  passes that already lease worktrees, plus a coarse interval (a new knob in the
  §14.17 style, or reuse the existing sweep cadence) for the idle case.
- Decide whether this is worth its own step or should be deferred. **It is
  strictly less valuable than S2** and should not be allowed to delay it.

## S6 — Seal

- **Tests**: the invariant gate's three outcomes; an undecided probe failing open
  (a broken `isAncestor` must not wedge a healthy lane); the catch-all no longer
  producing `gitlink_mismatch`; a table-driven eligibility test that fails when a
  reason is added without a decision (extend the existing one); incident dedup
  across passes; incident auto-resolve once the invariant holds; and a text
  assertion that no author-facing reject string contains a pre-emptive
  exoneration.
- **Deployment guide**: a new §14.23 covering the invariant, both incident
  directions, the two human cures and their trade-off, and why the train refuses
  to pick. Amend §14.8 to state that automatic submodule recursion is disabled on
  the integrator's own git operations (S1) and why.
- **CLAUDE.md** capability index.
- **Write back to game_one**: reply on note `01M18QWM9RAFVQNFX4FE461B23` with what
  shipped, the R1/R5 corrections above, and — the part they most need — that
  their three-dot rule should be **retired in favor of the train's own check**,
  not supplemented by a second command every submitter has to remember.
- **Deployment**: no migration, but a PM-server redeploy (new incident type +
  reject category on the wire) **and** a bundle redistribute + daemon restart
  (S1/S2/S3 are integrator-side). State both in the guide, in the §14.11
  deployment-note style.
- Full suite + E2E.

---

## Design locks

1. **The gate comes before the fix that reaches it.** S1 without S2 converts a
   loud stall into a silent submodule regression — the exact outcome the client's
   owner rejected on purpose. Never ship S1 alone.
2. **The train detects; a human cures.** Both cures change what consumers of main
   compile. The train must refuse and say so, never auto-heal, never pick.
3. **No message asserts its own innocence.** A reject states what was observed
   and what to check. It may name a probable cause; it may not pre-emptively rule
   one out. That sentence cost five believed misdiagnoses.
4. **A catch-all is never a diagnosis.** An unclassified error gets a reason that
   says "unclassified", not the nearest specific reason with a spare slot.
5. **Fail open on an undecided check, hard-gate on a decided one.** A probe that
   cannot answer must leave today's behavior intact; a probe that answers "not an
   ancestor" must stop the land.
6. **The invariant is symmetric, so the detector must be.** Every future check on
   the inner/outer relationship states which direction it watches, and whether
   the other direction is covered.
