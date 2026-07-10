# Campaign — Cross-repo gitlink-bump auto-convert (kill the outer_conflict ping-pong)

**Date:** 2026-07-10
**Tier:** A (kills a live, recurring failure class at the only client)
**Approved by:** Fable architect (direction C; A stays rejected; B's deployment audit folded in as P0)
**Goal:** a legacy TWO-member cross-repo group whose outer member is a **pure gitlink bump** can never be rejected `outer_conflict`. The integrator recognizes the bump as content-free ceremony and synthesizes the outer candidate against **live** outer main — exactly as the sanctioned `synthesize_outer` path already does — so main-moving-underneath no longer ping-pongs the group.
**Branch:** `campaign-xrepo-gitlink-bump-autoconvert` off `main`, in a dedicated git worktree (do not disturb the primary checkout).

## The gap (observed live, game_one / rynx)

Workers submit a two-member cross-repo group = an inner rynx branch + a hand-minted outer
branch whose sole content is the gitlink bump (`160000` at `rynx` → inner candidate). The
integrator rebases each member onto live main (`group-assembly.ts:161`). The moment ANY
other gitlink change lands on outer main first, the worker's outer branch — which also
edits the gitlink — hits both-sides-modified on the `rynx` entry → instant `outer_conflict`.
Main moves again, resubmit, conflict again → **ping-pong**. Live evidence: `fix/grass-
stability-*` rejected repeatedly with `group assembly failed (outer_conflict): rynx`, the
`conflictingFiles` value literally the single token `"rynx"` — the conflict is ONLY on the
gitlink pointer, never on real outer source. The bump branch is pure ceremony: assembly
step 8 (`updateSubmoduleGitlink`, `git-ops.ts:692`) OVERWRITES the gitlink to the rebased
inner SHA (`Ri`) regardless of what the branch said.

The sanctioned fix — inner-only groups with `synthesize_outer: true` — already shipped
(`roadmap-20260610-xrepo-inner-only-groups.md`) and makes `outer_conflict` structurally
unreachable (the only statement that can mint it lives inside `if (deps.outerRef !== null)`,
`group-assembly.ts:160`). But the ping-pong persists, because workers keep sending the
two-member bump-branch form. This campaign makes worker behavior **permanently irrelevant**.

## Design (settled — Fable ruling)

**Direction C: classification-time normalization on the SUCCESS path.** At assembly, BEFORE
the outer rebase, detect that the outer member's net contribution vs `merge-base(outerRef,
live outer main)` is *exactly* the gitlink entry — nothing else — and take the already-
existing synthetic arm (`outerRef := null`). No branch is re-minted, no conflict is resolved,
no failure path is decorated. The ceremony is recognized as content-free and discarded; the
outer candidate is synthesized fresh against live main (steps 7–9, unchanged).

**Why this is NOT the rejected alternative.** The 2026-06-10 campaign rejected "auto-re-minting
a worker's stale bump branch **on the failure path**." C is different in kind: it is a
pre-rebase, success-path recognition that the outer rebase would be pointless (step 8
overwrites the gitlink regardless), so the rebase is never performed. A only ever fired on
the conflict signature; the stale bump is wrong even when it rebases *cleanly*. C removes the
mechanism; A patched the symptom. **A stays rejected.**

**Placement: inside `assembleGroup` (`group-assembly.ts:157-174`), NOT at PM submit.** PM never
runs git (the 7.4 invariant; `roadmap-20260610` line 20). Detection needs the outer clone and
live main, and assembly steps 4–6 is exactly where `baseOuterSha` is fresh, the ref is
fetched, and `outer_conflict` is minted. Doing it there covers both the specs arm and the
bind-by-ids arm, and is stateless per attempt — re-derived every pass, so re-integration
after further drift is automatically correct.

**Do NOT flip the DB row to `synthetic: true`.** The binding code enforces "synthetic ⇒
ref-less" as defense-in-depth (`group-integration.ts` refuses a synthetic member carrying
refs). The DB row stays an honest record of what the worker submitted; conversion is an
integration-time interpretation surfaced via log + a timeline/audit entry (reuse the
requeue-audit-row pattern from the 2026-06-06 legibility fix). `landedSha = Ro` fills exactly
as the legacy path already does — no land-path change.

## Safety invariants (each one gets a seal)

1. **Verify-sole-gate / main-unbreakable** — conversion is pre-verify; the synthesized
   candidate goes through the identical §5.3 AND-verify and §6 land. Assert in the e2e.
2. **No empty bump commits / no-op lands preserved** — `updateSubmoduleGitlink` idempotence
   is already contractual (`git-ops.ts:697-709`); the converted arm inherits it.
3. **Strict detection, fail-open to legacy** — convert *only* when `git diff --name-only
   <merge-base> <outerRef>` yields exactly `[gitlinkPath]`. Any other path (`.gitmodules`,
   `tools/rynx-treegen`, real source), a merge-base failure, an unresolvable ref, or ANY
   detection error ⇒ legacy arm untouched. Worst case is today's behavior, never worse.
4. **Legacy two-member with real outer changes: byte-identical** — a mixed bump-plus-source
   outer member must still produce `outer_conflict` when it genuinely conflicts; that
   rejection is *signal*, not noise. Wire-seal + behavior-seal.
5. **No silent magic** — every conversion emits a visible record (logger + PM timeline/audit).
6. **Idempotence** — conversion is derived fresh per assembly attempt; a rejected-then-
   resubmitted or drift-requeued group re-converts correctly with zero persisted state.
7. **Synthetic-row invariant untouched** — `synthetic === true` remains "PM-minted, ref-less"
   only; conversion never sets it.

## Scope

**In:**
- GitOps detection primitive: `isPureGitlinkBump(outerRef, gitlinkPath)` = merge-base +
  `diff --name-only`, exactly-`[gitlinkPath]` (real-git).
- The conversion branch in `assembleGroup` steps 4–6 + an `outerConverted` marker on
  `AssembledGroupOk`.
- Legibility: log line + PM timeline/audit row ("outer member superseded: pure gitlink bump,
  outer candidate synthesized against live main").
- Seals (P3, below).
- Docs: `docs/integrator-deployment.md` §14.x, worker doc, CLAUDE.md 7.3 blurb.
- Ops handoff: server restart + bundle redeploy + daemon restart, with the P0 audit findings
  attached.

**Out (stay parked, no scope creep without evidence):** multi-gitlink synthesis
(`tools/rynx-treegen` is not in `linked_repos`); auto-cancel of duplicate stale submissions;
the `gitlink_mismatch` §11-assertion class (keep on the P0 audit checklist, do NOT scope in
without evidence); verify-failure triage (the `c2/rotational-wind` rejections are REAL verify
signal — must not be masked); 7.6 resolver interaction (group conflicts stay out of resolver
scope, per the prior watch-item); >2-repo topologies.

## The open question — resolved in P0 (shapes messaging, not the structural need)

**What is actually running at game_one right now?** (a) live PM server migration level — is
0027+ applied, does a `synthesize_outer` submit succeed, or does it 400 (⇒ workers rationally
fell back to bump branches)? (b) integrator daemon bundle vintage + start time; (c) merge-
request data since 2026-06-10 — are any groups inner-only, and do the July `outer_conflict`
rejections postdate the redeploy? If the audit shows the server never restarted, that is the
proximate root cause and the ops handoff leads with it — but it does **not** descope C: C makes
worker behavior permanently irrelevant and needs a daemon redeploy regardless. **Scope-change
trigger:** only if the audit reveals workers *did* use inner-only and it *failed* in
production — then the campaign pivots to fixing that defect first.

## Verification

- Full gate (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`) green at every commit;
  one logical commit per phase.
- Real-git integrator tests following `group-assembly.test.ts` / `group-e2e.test.ts` idioms
  (spawn-the-built-integrator seal for the e2e).
- Detection matrix (P1): pure bump; bump + `.gitmodules`; bump + real source; second gitlink;
  orphan/merge-base-failure ⇒ fail-open; **empty outer branch** (zero diff vs merge-base ⇒
  not `[gitlinkPath]` ⇒ fail-open); **bump-to-already-landed-value** (branch carries the
  gitlink SHA now already on main; diff vs the *older* merge-base still shows `[gitlinkPath]`
  ⇒ converts, and step-8 idempotence + no-op `treesIdentical` land must absorb it — ties
  invariant 2 to a concrete case).
- **The campaign seal (P3):** reproduces the live grass-stability ×7 failure and must pass.

## Engineering values

No investment ceiling; structural elimination > guidance (workers are fresh-session LLM
agents — discipline decays by construction); legacy two-member-with-real-outer stays
byte-identical (back-compat is a hard constraint, the wire/behavior seals prove it).

## Phases (DRAFT — pending adversarial verify inside /campaign)

- **P0** — worktree + baseline gate; read `phase-7.3-design.md` §5–6 +
  `group-assembly.ts` / `group-integration.ts` / `merge-group.service.ts` end-to-end. Produce
  an **operator-executable deployment-audit runbook/probe** (server migration level; does a
  `synthesize_outer` submit succeed; daemon vintage + start time; post-06-10 merge data by
  category). Findings recorded here before P2 merges. No code commit.
- **P1** — GitOps: `isPureGitlinkBump` (merge-base + name-only diff). Real-git unit tests for
  the full detection matrix incl. fail-open cases (pure bump; bump+`.gitmodules`; bump+source;
  second gitlink; orphan/merge-base-failure; empty outer branch; bump-to-already-landed).
  One commit.
- **P2** — `assembleGroup` conversion arm (take the synthetic arm when `isPureGitlinkBump`) +
  `outerConverted` marker on `AssembledGroupOk`; `group-integration.ts` surfacing (log + PM
  audit/timeline entry). Binding untouched. Unit tests: conversion matrix + structural
  conflict-immunity on the converted arm. One commit.
- **P3** — seals (purely additive): (i) **campaign seal** — spawn-built-integrator e2e: submit
  a legacy two-member group with a stale pure-bump outer branch, advance outer main's gitlink
  between submit and pickup (the exact grass-stability ×7 failure), group must LAND with the
  outer `landedSha` filled and zero `outer_conflict`. The seal ALSO asserts, after land:
  the converted outer member row still reads `synthetic === false` in the DB (invariant 7 —
  conversion is an integration-time interpretation, never a row mutation) AND a visible
  conversion record exists (log line + PM timeline/audit row) (invariant 5). (ii) negative
  seal — a mixed bump-plus-source outer member still rejects `outer_conflict` byte-identically;
  (iii) legacy flows (a)–(g) green unmodified; (iv) **happy-path equivalence seal** — a
  pure-bump outer where main did NOT move the gitlink (legacy would rebase cleanly and land):
  assert the *converted* path lands with the identical `Ro` gitlink value (→ `Ri`) the legacy
  clean-rebase path produces — conversion is behaviorally invisible on the happy path, not
  only on the conflict path. One commit.
- **P4** — docs (`integrator-deployment.md` §14.x + worker doc + CLAUDE.md) + ops handoff
  (lead with the P0 audit findings; broadcast becomes "inner-only is still the recommended
  form; the train now tolerates bump branches anyway"). One commit.
- **P5** — close-out: outcomes recorded here, full gate, diff-stat audit.

**Watch-items for the verifier:** confirm the converted arm inherits the no-op-land
`treesIdentical` short-circuit when the inner change is already on main; confirm detection is
truly stateless (drift-requeue re-converts with zero persisted state); confirm the audit/
timeline row does not perturb the legacy wire (additive only); confirm `classifyCreateForm`
(`merge-group.service.ts:321`) is byte-identical (assert, don't assume) — this campaign does
NOT touch PM submit; confirm a bind-by-ids outer member is covered by the assembly-time
placement (not just the specs arm); confirm fail-open genuinely reaches the legacy rebase on
EVERY non-pure / error case.

**Key files:** `packages/integrator-ref/src/group-assembly.ts:157-174` (conversion site),
`git-ops.ts:547` (`rebaseOnto`) / `:692` (`updateSubmoduleGitlink`),
`group-integration.ts:160-269` (binding, untouched) / reject surfacing,
`packages/server/src/services/merge-group.service.ts:321` (`classifyCreateForm`, untouched —
assert byte-identity).

## Ops handoff (operator actions after merge — NOT executed by the campaign)

1. **P0 deployment-audit FIRST.** Run `docs/gitlink-autoconvert-p0-deployment-audit.md` Probes A–C
   on the game_one machine before anything else. Findings shape the broadcast and confirm the
   proximate cause: the server predating migration 0027 ⇒ `synthesize_outer` 400s ⇒ workers fell
   back to bump branches; the July `outer_conflict` persistence; and whether inner-only is used at
   all. **If the SCOPE-CHANGE TRIGGER fires (inner-only groups are FAILING in prod), HALT and fix
   that first** — auto-convert is a safety net for legacy bumps, not a substitute for a working
   inner-only path.
2. Merge `campaign-xrepo-gitlink-bump-autoconvert` → `main` (full gate green; one commit per phase).
3. Rebuild + redistribute the bundle to game_one: `pnpm build`, then `node scripts/distribute.mjs`
   (ships the integrator bundle + the updated worker/operator docs to the target).
4. Restart the integrator daemon (`run_daemon.bat` at the game_one target). Gotcha: launch from a
   plain shell where `NoDefaultCurrentDirectoryInExePath` is NOT set (a Claude Code-spawned shell
   sets it; the daemon's children then fail to resolve bare `pm-verify.bat`). Auto-convert is
   **daemon-side only** — it takes effect on this restart; there is **no PM-server migration** in
   this campaign. **P0 audit executed 2026-07-10:** the live server is already current (migration
   0027 present, 38 applied through 2026-06-28) and `synthesize_outer` is reachable and used
   (60 synthetic members) — so no server *migration* is needed. BUT the server STILL needs a
   **redeploy** for the new `outer_converted` audit action + `POST /merge-requests/{id}/outer-converted`
   route: the conversion itself is daemon-side (lands groups with just the daemon redeploy), but the
   audit-row surfacing needs the server too, else the daemon's best-effort POST 404s (swallowed) and
   you get log-only legibility. **Redeploy both `run.bat` (server) and the integrator daemon.**
5. Broadcast to game_one workers: "inner-only `synthesize_outer` is still recommended; the train now
   **tolerates** pure gitlink-bump outer branches automatically (auto-converts on drift) — stop
   hand-fixing or rebasing bump branches on drift." Do NOT tell workers bump branches are correct.
6. Watch the first converted land on `/projects/{id}/train`: the outer member's timeline shows an
   `outer_converted` audit row, and the member row still reads `synthetic: false` (the conversion is
   an integration-time interpretation, never a row mutation).

## Close-out (executed 2026-07-10, branch `campaign-xrepo-gitlink-bump-autoconvert`, base 923160d)

All phases shipped; one logical commit per phase (+ one P5 fixup). Direction C exactly as
Fable approved; A stayed rejected; every safety invariant sealed.

- **P0 `d2424a7`** — campaign roadmap + operator-executable deployment-audit runbook
  (`docs/gitlink-autoconvert-p0-deployment-audit.md`, Probes A–C). Baseline gate green (main
  healthy; `batch.test.ts` flakes 3/51 with `ECONNRESET` under full-parallel turbo load — passes
  51/51 isolated, a known load flake). Live probe: game_one train idle (0 queued/integrating/
  incidents). Docs-only, no code.
- **P1 `5bcda1b`** — `GitOps.isPureGitlinkBump(outerRef, gitlinkPath)`: net-diff over
  `merge-base(HEAD, outerRef)` is exactly `[gitlinkPath]`; strict fail-open to `false` on any
  error/ambiguity. New real-git matrix test, **8/8** (incl. the bump-to-already-landed keystone
  proving the merge-base — not HEAD — diff base). git-ops +52.
- **P2 `768176b`** — `assembleGroup` conversion arm: a real outer member that is a pure gitlink
  bump SKIPS the outer rebase (via `resolveDetectRef`, which resolves a bare branch through
  `<remote>/<ref>^{commit}` — production binds bare branches via the `--mirror` clone) and takes
  the existing synthetic arm; `outerConverted` marker; surfacing = unconditional log line +
  best-effort `noteOuterConverted` audit row (new `outer_converted` AUDIT_ACTION + server
  service + `POST /api/v1/merge-requests/{id}/outer-converted` route; OpenAPI regenerated). DB
  `synthetic` flag NOT flipped. `GroupIntegrationDeps.gitRemote` made required. group-convert
  **5/5**, server **1831/1831**.
- **P3 `8ba8dcd`** — e2e seals appended to `group-e2e.test.ts` (h/i/j), legacy flows (a)–(g)
  byte-unmodified: (h) **campaign seal** reproduces the grass-stability ×7 drift (stale pure-bump
  outer + outer main's gitlink advanced between submit and pickup) → group LANDS, zero
  `outer_conflict`, outer `landedSha` filled, both members `synthetic===false`, `outer_converted`
  audit row present; (i) negative — mixed bump+source still rejects `outer_conflict`, neither bare
  main advances, no audit row; (j) happy-path equivalence — pure bump, no drift, lands with
  gitlink === `Ri` AND the audit row proves the converted path was taken. group-e2e **13/13**.
- **P4 `bd998d6`** — docs (deployment guide §14.10 + §14.7 edit, worker doc, CLAUDE.md 7.3 clause)
  + ops handoff (leads with the P0 audit; broadcast = "inner-only still recommended; the train now
  tolerates bump branches"). Accuracy read-back against the shipped code; every overclaim guardrail
  respected. Prose-only.
- **P5 `<this commit>`** — close-out. Final full gate caught ONE real regression the P2
  package-scoped run missed: `@pm/shared tests/audit.test.ts` "AUDIT_ACTIONS … canonical order"
  pinned the enum and P2 added `outer_converted` without updating it — **fixed here** (added
  `outer_converted` in canonical position; shared **16/16**). Also observed a second gate failure,
  `@urtela/pm-wake-daemon worker-runner.test.ts` "sleep beyond a tiny budget → timeout" — an
  UNTOUCHED package, timing-sensitive; **4/4 isolated** ⇒ confirmed a load flake, not a regression.

**Final gate:** `pnpm typecheck` 10/10, `pnpm lint` 10/10, `pnpm build` 8/8 green. Tests green on
the touched surface (git-ops 8/8, group-convert 5/5, group-e2e 13/13, server 1831/1831, shared
16/16 post-fix). Known non-blocking load flakes under full-parallel turbo: `batch.test.ts` (3/51,
ECONNRESET) and `wake-daemon/worker-runner` (1, timeout) — both pass isolated, neither in this
campaign's surface.

**Footprint:** 22 files, ~+2012 lines. Core (integrator): `git-ops.ts`, `group-assembly.ts`,
`group-integration.ts`, `batch.ts`, `pm-client.ts`. Surfacing (server): `audit.ts`,
`merge-request.service.ts`, `routes/merge-requests.ts`, `openapi.json`. Tests:
`git-ops-pure-gitlink-bump.test.ts` (+176), `group-convert.test.ts` (+628), `group-e2e.test.ts`
(+265), `merge-requests-outer-converted.test.ts` (+119), + `gitRemote` fixture wiring.

**Parked / out of scope (unchanged from the header):** multi-gitlink synthesis
(`tools/rynx-treegen` — still needs a real outer member); auto-cancel of duplicate stale
submissions; the `gitlink_mismatch` §11-assertion class; verify-failure triage
(`c2/rotational-wind`-style rejections are real signal); 7.6 resolver interaction (group conflicts
stay out of resolver scope); >2-repo topologies.

**Status:** on branch `campaign-xrepo-gitlink-bump-autoconvert`, NOT merged, NOT pushed. Ships
**always-on / fail-open** (no toggle) once the daemon bundle is deployed. Operator actions in the
Ops handoff above (run P0 audit first; merge; rebuild+redistribute; restart daemon; broadcast).
