# Campaign — Cross-repo gitlink normalization (widen the umbrella; kill stale-gitlink friction)

**Date:** 2026-07-13
**Tier:** A (kills a live, recurring failure class at the only client; direct escalation trail — game_one P6 placement)
**Proposal:** `01KXEBB9ZV1TVRVCWC1AHXE9S7` (project-manager) — accepted by director in-session, **maximal-autonomy** scope.
**Goal:** the integrator auto-lands *any* cross-repo outer member whose gitlink merely fast-forwards-or-behind the landing inner (not just pure-bump branches), and makes *every* residual gitlink failure **legible** (a structured rejection on the task, never a silent 0-attempt stall). Worker branch hygiene becomes a convenience, not a precondition.
**Branch:** `campaign-xrepo-gitlink-umbrella-widening` off `main`, in a dedicated git worktree (do not disturb the primary checkout).
**Builds on:** `roadmap-20260710-xrepo-gitlink-bump-autoconvert.md` (the pure-bump special case this generalizes) and `roadmap-20260610-xrepo-inner-only-groups.md` (`synthesize_outer`).

## The gap (observed live, game_one / rynx, 2026-07-13)

The pure-bump auto-convert shipped and runs correctly in production, but its scope is *exactly* the single-gitlink diff. Three friction cases remain, all seen on the game_one **P6 mission-plan placement** branch:

1. **Feature branch + stale-but-reachable gitlink → wrongly rejected.** `g1-p6-placement-v3` carries real outer source **plus** a gitlink pinned to `rynx@624a0674`, which is an **ancestor** of live rynx main `48c9fda` (it landed at 15:24, then main moved two lands past it). The outer rebase (`group-assembly.ts:220`) hits both-sides-modified on the `rynx` gitlink entry → `outer_conflict` — even though step 8 (`updateSubmoduleGitlink`, `:240`) overwrites the gitlink to the landing inner SHA `Ri` regardless. **This should auto-land.** `isPureGitlinkBump` declines it (there's real source too), so today it drains every cycle at 0 attempts.

2. **Feature branch + unpushed/diverged inner gitlink → *silently* rejected.** `g1-p6-placement` (v1) pinned `rynx@bb057666`, a commit **never pushed to the rynx origin** ("fatal: remote error: upload-pack: not our ref bb057666"). This *cannot* be auto-resolved — the content isn't on the remote. But today it fails **silently**: `group assembly failed pre-pickup; rejecting from forming`, the request left `queued` at 0 attempts with **no rejection, no comment**. It looks exactly like an integrator bug. This silent stall cost 3 worker resubmits + a human escalation before diagnosis.

3. **Same class, three times in hours.** The daemon log shows `bb057666` (P6), `gib-r2-materials-inner`, and `7ceee81d…` all draining as "ref resolves in neither repo" / "not our ref" within one afternoon — a recurring worker-side pattern with zero legible signal back to the worker.

## Design (settled — maximal autonomy)

Root insight (already half-stated in the code, `group-assembly.ts:203`): **the outer member's gitlink hunk is *always* ceremony** — step 8 authors the landed gitlink to `Ri` in every arm. The pure-bump case recognized the special instance where the gitlink is the *entire* diff. The general rule:

> The outer branch is never entitled to *author* the submodule pointer when its gitlink hunk merely fast-forwards-or-behind the inner that is landing. Strip the hunk; let step 8 author it.

### Tier 1 — Ancestor-gated gitlink normalization (auto-resolve)
At assembly, before the outer rebase, classify the outer member's net diff vs `merge-base(outerRef, live outer main)` into **gitlink hunk(s)** and **source hunks**. Let **G** = the inner commit each gitlink hunk targets; **Ri** = the inner SHA that will land.
- **Pure bump** (no source hunks): unchanged — existing skip-rebase synthesize arm.
- **Mixed, and every G is `isAncestor(G, Ri)` (or `G === Ri`):** **strip the gitlink hunk(s)**, rebase source-only, let step 8 author gitlink → `Ri`. `outer_conflict` on the gitlink entry becomes unreachable; a *source* conflict still rejects normally.
- Applies to **all configured gitlink paths** (`rynx` and `tools/rynx-treegen`), independently — a branch may normalize one and legitimately reject on another.
- **Fail-open**: any spawn/parse/merge-base error ⇒ legacy rebase (today's behavior). No detection error can *cause* a land.

### Tier 2 — Legibility (kill the silent drain)
Every residual reject emits a **structured `merge_rejection`** (category + actionable message) posted as a comment on the linked task, never a silent 0-attempt stall:
- `gitlink_unreachable` — a G does not resolve on the inner remote ("push rynx@G to origin, or submit the inner change as a group member").
- `gitlink_diverged` — a G resolves but is **not** an ancestor of `Ri` ("outer pins inner state not contained in the landing inner; submit the matching inner change or rebase forward").
- Binding failures ("ref resolves in neither repo") get the same structured treatment instead of a bare `warn` drain.

### Tier 3 — Outer-only autonomy (no forced inner member)
A lone outer feature branch whose gitlink is reachable (ancestor of inner main) lands with **inner treated as a no-op** (`Ri` = live inner main). The worker does not have to submit a matching inner member for the common "my outer just needs current rynx" case. (When the gitlink is *not* reachable/ancestor, Tier 2 rejects legibly — Tier 3 never invents inner state.)

## Safety invariants (each gets a seal)

1. **Ancestor is the sole gate.** Normalization fires **iff** every stripped gitlink's target G satisfies `isAncestor(G, Ri)`. We never move the submodule pointer backward, sideways, or to an unlanded commit.
2. **No invented content.** Tier 3 uses `Ri` = inner main only; it never fabricates or moves inner. An unreachable/diverged G always rejects (Tier 2), never lands.
3. **Source is sacred.** Only gitlink hunks are ever stripped. Any real outer-source hunk that conflicts on rebase still mints `outer_conflict`, byte-identically to today.
4. **Success-path only.** This is pre-rebase classification-time normalization (declining to author a gitlink), NOT failure-path conflict resolution. Consistent with the 2026-06-10 "no magic on the failure path" ruling.
5. **Fail-open is total.** Every non-normalizable / error path reaches the legacy rebase. Detection is stateless — re-derived every attempt, so drift-requeue re-classifies correctly with zero persisted state.
6. **DB `synthetic` is never mutated** by a normalization (as with `outer_converted` — an integration-time interpretation, surfaced via audit row, never a row flip).
7. **Legibility is additive.** New reject categories/comments never perturb the existing wire for the untouched failure classes.

## Scope

**In:** `group-assembly.ts` classification + normalization arm; `git-ops.ts` detection primitives (diff-split, per-path gitlink target resolution, reuse of `isAncestor` `:244`); multi-gitlink; Tier-2 reject categories in `@pm/shared` + server route + client surfacing; Tier-3 outer-only path; e2e seals; docs; ops handoff.

**Out (non-goals):** auto-editing real source; moving inner main backward or to an unlanded commit; fabricating inner content not on the remote; any PM-submit-time git (the 7.4 invariant — PM never runs git); a toggle (always-on/fail-open like the pure-bump convert).

## Verification

Real-git unit tests for the full classification matrix; spawn-built-integrator e2e seals for each observed case; full existing suite green (legacy flows byte-identical); diff-stat audit. The campaign's own verify command is the repo `pnpm` gate; the *train's* seal is that the reproduced P6-v3 group **lands** and P6-v1 **rejects legibly**.

## Engineering values

Grounded in the real code (no memory-trust — assert byte-identity where "untouched"); fail-open by construction; every safety invariant gets a dedicated seal; legibility treated as a first-class deliverable, not a log line.

## Phases (DRAFT — pending adversarial verify inside /campaign)

- **P0** — worktree + baseline gate. Read `group-assembly.ts` / `git-ops.ts` / `group-integration.ts` / `merge-group.service.ts` end-to-end + the two prior gitlink roadmaps. **Adversarial invariant audit:** find any case where `isAncestor(G, Ri)` holds yet stripping is unsafe (e.g. G ancestor of Ri but the outer *source* semantically depends on a *later* inner API — argue why step-8→Ri makes this safe or identify a guard). Pin the **strip mechanic** (candidates: reset-gitlink-hunk-to-base pre-rebase and rebase remainder; vs. rebase then auto-resolve gitlink-only conflicts to base — pick one, justify, note the multi-gitlink interaction). No code commit; findings recorded here.
- **P1** — GitOps detection: `classifyOuterGitlinkDiff` (merge-base name-status split into gitlink-paths vs source) + per-path target resolution + reuse `isAncestor`. Real-git unit tests: pure bump; bump+source with G ancestor; bump+source with G *not* ancestor (→ diverged); unpushed G (→ unreachable); second gitlink normalizes while first diverges; `.gitmodules`-only; empty branch; orphan/merge-base-failure (fail-open). Strict fail-open. One commit.
- **P2** — `assembleGroup` normalization arm: when all gitlink targets are ancestor-of-`Ri`, strip the hunk(s), rebase source-only, step 8 authors `Ri`. Pure-bump keeps the skip-rebase arm. `outerGitlinkNormalized` marker on `AssembledGroupOk` + best-effort audit surfacing (mirror `outer_converted`). Unit tests: normalization matrix + gitlink-conflict-immunity on the normalized arm + source-conflict still rejects. One commit.
- **P3** — Legibility: new reject categories `gitlink_unreachable` / `gitlink_diverged` (+ binding-failure legibility) in `@pm/shared`, server route/action to attach a structured `merge_rejection` comment on the task, client surfacing on the request timeline. Replace the silent pre-pickup drain with an explicit legible rejection. Additive-wire seal. One commit.
- **P4** — Tier-3 outer-only autonomy: a lone reachable-gitlink outer member lands with inner = no-op (`Ri` = inner main). Unit + e2e. One commit.
- **P5** — e2e seals (spawn-built integrator): (i) **P6-v3 seal** — mixed outer + stale-but-ancestor gitlink, main moves the gitlink between submit and pickup → group **LANDS**, `outer` landedSha filled, zero `outer_conflict`, member row still `synthetic:false`, audit row present; (ii) **P6-v1 seal** — unpushed inner G → **legible** `gitlink_unreachable` rejection + task comment, NOT a silent stall; (iii) **diverged seal** — G resolves but not ancestor → `gitlink_diverged` reject; (iv) **pure-bump equivalence** — unchanged behavior; (v) **multi-gitlink** — one normalizes, one diverges → reject on the diverged one; (vi) **source-conflict** — mixed member with a real source conflict still rejects `outer_conflict` (not byte-identical to legacy — the squashed source `apply --3way` can differ in conflict incidence). One commit.
- **P6** — Docs (`integrator-deployment.md` §14.x + worker doc + CLAUDE.md capability index) + ops handoff. One commit.
- **P7** — Close-out: audit-action tests, outcomes recorded on the proposal + here, memory update, diff-stat audit, full gate.

**Watch-items for the verifier:** note that group-land does NOT use `treesIdentical` (`group-land.ts:143-149`) — no-op lands fall out of the FF `HEAD:main` push naturally, so the seal must assert the FF-push no-op, not a `treesIdentical` call; confirm detection is stateless (drift-requeue re-normalizes); confirm `classifyCreateForm` (`merge-group.service.ts`) is byte-identical (this campaign does NOT touch PM submit — assert it); confirm bind-by-ids outer members are covered (not just the specs arm); confirm fail-open reaches legacy rebase on EVERY non-normalizable/error case; confirm the strip mechanic handles two gitlink paths where only one is ancestor; confirm Tier-2 rejections don't double-fire with existing `outer_conflict` on mixed source+gitlink members.

**Key files:** `packages/integrator-ref/src/group-assembly.ts` (conversion/normalization site ~200–247, step 8 `:240`), `git-ops.ts` (`isAncestor` `:244`, `isPureGitlinkBump` `:286`, `updateSubmoduleGitlink` `:719`, `rebaseOnto`), `group-integration.ts` (binding + reject surfacing), `packages/server/src/services/merge-request.service.ts` + `routes/merge-requests.ts` (reject categories / audit route), `packages/shared/src/schemas/audit.ts` (+ reject category schema).

## Ops handoff (operator actions after merge — NOT executed by the campaign)

1. Merge `campaign-xrepo-gitlink-umbrella-widening` → `main` (full gate green; one commit per phase).
2. Rebuild + redistribute the bundle to game_one: `pnpm build`, then `node scripts/distribute.mjs`.
3. **PM-server redeploy** (`run.bat`) — required for the new reject categories + audit action/route (else legibility is log-only / best-effort POST 404s).
4. Restart the integrator daemon (`run_daemon.bat`). Gotcha: launch from a plain shell where `NoDefaultCurrentDirectoryInExePath` is NOT set (a Claude-spawned shell sets it; the daemon's children then fail bare `pm-verify.bat`).
5. **Re-drive P6 on the live train:** the stuck `g1-p6-placement-v3` should now normalize and land on the next assembly cycle (no worker resubmit needed). Confirm on `/projects/{id}/train`: `outer_gitlink_normalized` audit row, member `synthetic:false`.
6. Broadcast to game_one workers: "the train now tolerates stale-but-reachable gitlinks automatically; unreachable/diverged inner pins now reject **with a clear reason on your task** — push inner first or submit as a group. Inner-only `synthesize_outer` remains the clean form."

## P0 Findings — Design-lock (settled 2026-07-13)

This section is the authoritative design P1–P4 execute against. Grounded in a full
read of `group-assembly.ts` / `git-ops.ts` / `group-integration.ts` /
`merge-group.service.ts` + the two prior gitlink roadmaps. Adversarial-verified.

### A. Assembly ground truth (confirmed by reading the code)

- **Ri is a COMMIT sha, not a tree.** `rebaseOnto` returns `git rev-parse HEAD`
  (`git-ops.ts:578`); the `treeSha` field name is a misnomer (`group-integration.ts:541`).
- **The only `outer_conflict` producer** is the outer `rebaseOnto` failure block
  (`group-assembly.ts:219-228`), reachable only when `outerRef!==null && !skipOuterRebase`.
- **Step 8 (`updateSubmoduleGitlink`, `group-assembly.ts:240`) authors the committed
  gitlink to Ri UNCONDITIONALLY in every arm** (idempotent; `git-ops.ts:719-753`).
  The outer branch's gitlink-hunk value is therefore provably dead by construction —
  this is the root license for stripping.
- **The Direction-C conversion arm at `group-assembly.ts:207-234` is the exact plug-in
  site** for Tier-1 normalization. `resolveDetectRef` (`:112-125`) resolves a
  branch-only member via `origin/<branch>^{commit}`.

### B. Ancestor invariant — VERDICT: safe by construction, NO extra guard needed

With **G** = the inner commit the outer gitlink hunk targets and **Ri** = the landing
inner: when `isAncestor(G, Ri)`, stripping the gitlink hunk (→ step 8 authors Ri,
step 9 materializes Ri's real sources, `:240` / `:247`) is safe because the outer
verify already builds outer-source-against-Ri in **every** arm today (including legacy
rebase) — normalization is verify-equivalent to the shipped legacy path.

The verify cache **cannot manufacture a false pass**: the outer cache key is
content-addressed on `Ro^{tree}` (`group-integration.ts:556-559`), whose tree contains
the 160000 gitlink = Ri, so a cache HIT can only reuse a verdict for the identical
(outer-source, Ri) tree. An outer that genuinely can't build against the landing inner
is a REAL incompatibility that must reject, and verify catches it identically to today.

Ancestry is an **INNER-repo relation** — run it with the inner gitOps (the inner clone
holds Ri = the just-rebased HEAD).

### C. Strip mechanic — PINNED: source-only net-patch synthesized onto live main

Generalize the synthetic arm. Candidate (b) [rebase-then-auto-resolve-gitlink-conflict]
is **REJECTED** as failure-path magic (violates safety invariant 4).

When Tier-1 fires (all managed-gitlink targets ancestor-of-Ri), do NOT `rebaseOnto` the
outer. Instead:

1. Outer worktree is already at live outer main (`baseOuterSha`, `group-assembly.ts:198-199`).
2. `mergeBase = merge-base(baseOuterSha, outerRef)`.
3. Source-only patch = `git diff <mergeBase> <outerRef> -- ':(exclude)<gitlinkPath>'`.
4. **Empty patch ⇒ pure-bump** — take the existing skip-rebase arm unchanged.
5. **Else** `git apply --3way --index` onto the worktree — clean ⇒ commit with the
   existing COMMIT identity; conflict ⇒ abort, return `outer_conflict` with the
   conflicting files.
6. Fall through to unchanged steps 7 / 8 / 9 / §11.

This unifies **pure-bump** (empty source), **Tier-1 mixed** (source patch), and
**Tier-3 outer-only** (empty source, inner no-op) into ONE arm. The `mergeBase` /
`outerRef` blobs are present in the outer clone (reachable from `origin/<branch>`,
independent of the step-7 inner fetch). Squash-to-one-commit is safe: the cache is
tree-keyed (timestamp-free) and land is an FF `HEAD:main` push (`group-land.ts:152,182`),
both indifferent to commit count. `.gitmodules` correctly rides as source.

- **AMENDMENT (from adversarial verify):** a source conflict on the new path **"still
  rejects `outer_conflict`"** but is NOT byte-identical to today's per-commit rebase
  (a squashed `apply --3way` can differ in conflict incidence / conflicting-file set).
  Do NOT claim byte-identity for the source-conflict case.

### D. Multi-gitlink — COMMANDER RULING: single managed gitlink lane this campaign

Exactly ONE managed gitlink path exists today (`deps.gitlinkPath`, a single string,
`group-assembly.ts:97`; `linkedRepoSchema.gitlink_path`, single,
`shared/src/schemas/project.ts:90`; `tools/rynx-treegen` is NOT in `linked_repos`).
Write `classifyOuterGitlinkDiff` over a SET of managed paths (future-proof) but source
it from the single config path (a one-element set).

An **UNMANAGED 160000 change rides in the "source" patch** and lands/conflicts exactly
as legacy rebase does (no regression). A true two-MANAGED-gitlink case would need a
two-inner-lane data-model extension — **explicitly OUT OF SCOPE this campaign.** P1's
"second gitlink" test therefore means **managed-vs-unmanaged**, not two managed lanes.

### E. Fail-open vs fail-closed — THREE-way split (amended by adversarial verify)

Safety invariant 5: no error path may cause a land OR a false terminal reject.

- **normalize:** every managed-gitlink target G is present (see below) AND
  `isAncestor(G, Ri)` exits 0.
- **`gitlink_diverged` (Tier-2 reject):** G present AND `isAncestor` exits 1 (not
  ancestor). This is a DELIBERATE autonomy trade-off — more conservative than legacy
  (which would rebase + verify-gate and could land a compatibly-diverged case);
  rejecting is always safe.
- **`gitlink_unreachable` (Tier-2 reject):** G absent **ONLY AFTER an all-refs
  `git fetch origin` that SUCCEEDED.** CRITICAL: use an ordinary all-refs `fetch origin`
  then `resolveRef(G)` / `cat-file -e` — do NOT `git fetch origin <G-sha>` (servers
  commonly disallow `uploadpack.allowAnySHA1InWant`, which would false-unreachable the
  happy path where G is an ancestor of inner main). A genuinely unpushed commit (e.g.
  `bb057666`) is absent after the all-refs fetch ⇒ legitimate unreachable.
- **fail-open to legacy rebase:** any fetch TRANSPORT/network/auth error (transient —
  never a terminal reject), any merge-base/diff spawn error, and any `isAncestor` throw.
  NOTE: `isAncestor` THROWS on exit ≠ 0/1 (bad object → 128, `git-ops.ts:456-479`); the
  classifier MUST catch that throw and route to fail-open, never let it bubble into
  `assembleGroup`'s catch (which would surface as `gitlink_mismatch`, `:285-296`).

### F. Tier-2 legibility plumbing (P3) — needs NEW plumbing

The group-reject path `rejectGroup` posts NO per-member `merge_rejection` comment
BY DESIGN (`group-integration.ts:399-408`) — that is exactly why the live P6-v1 case
looked silent. The existing `reject()` route posts a structured comment but only for
`integrating` requests (`merge-request.service.ts:1563`), so it 400s pre-pickup.

P3 must add plumbing: after `rejectGroup`, the integrator best-effort
`postTaskComment(innerMember.taskId, {commentType:"merge_rejection", metadata:{category}})`
(`pm-client.ts` already has `postTaskComment`). Wire legibility for BOTH distinct
failure sites: (i) the gitlink-target G reachability/divergence (new categories), AND
(ii) the inner-member ref BINDING failure "resolves in NEITHER repo"
(`group-integration.ts:236-241`) — they are different sites; P3 wires both.

New reject categories `gitlink_unreachable` / `gitlink_diverged` append to
`MERGE_REJECT_CATEGORIES` (`shared/src/schemas/merge-request.ts:40-49`) AND the
duplicate `RejectCategory` union in `pm-client.ts:107-114` (kept in lockstep). This
touches a DB-persisted value space (rejectCategory / failureCategory) + the SSE surface —
P3 must handle the migration / SSE surface. If a distinct `outer_gitlink_normalized`
audit action is added (mirroring `outer_converted`, `audit.ts:45`), edit `AUDIT_ACTIONS`
in canonical position or the canonical-order test breaks (it bit the prior campaign).

### G. Tier-3 (P4) plug-in

Today `bindMembersToRoles` REJECTS a lone outer member ("outer-only changes don't need
a group", `group-integration.ts:242-250`). P4 adds a binding arm: a lone
reachable-ancestor outer member lands with inner = no-op (Ri = live inner main; skip
inner rebase `:184-195`; no inner member to land — the inner push is an up-to-date
no-op). Reuses the same ancestor gate; unreachable/diverged ⇒ Tier-2 reject (never
invents inner state, safety invariant 2).

### H. Watch-items carried

- Assert byte-identity of `classifyCreateForm` (`merge-group.service.ts:321`, untouched —
  PM never runs git).
- Classification is STATELESS, re-derived every attempt (no marker read back as input;
  the marker is per-`AssembledGroupOk` + a best-effort audit row, never a DB `synthetic`
  flip).
- Normalization lives in `assembleGroup` so it covers BOTH the specs and the
  bind-by-ids arms.
- Tier-2 must not double-fire with `outer_conflict` (a mixed member whose SOURCE
  conflicts rejects `outer_conflict`, orthogonal to the gitlink category).

## Close-out (to be filled by the campaign)
