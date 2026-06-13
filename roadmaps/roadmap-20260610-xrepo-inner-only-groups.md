# Campaign — Inner-only merge groups (synthetic outer gitlink member)

**Date:** 2026-06-10
**Tier:** A (kills a live, recurring failure class at the only client)
**Goal:** a worker landing an inner-repo (rynx) change submits ONE member; PM + the integrator synthesize the outer gitlink-bump member at integration time, so the stale-outer-bump `outer_conflict` rejection class is structurally impossible.
**Branch:** `campaign-xrepo-inner-only-groups` off `main`, in a dedicated git worktree (do not disturb the primary checkout).

## The gap (observed live, 2026-06-10, game_one)

A cross-repo group today needs a worker-minted outer branch whose only content is the
gitlink bump (`160000` at `rynx` → inner candidate). That branch goes stale the moment
ANY other gitlink change lands on outer main — the rebase hits both-sides-modified on
the gitlink → instant `outer_conflict: rynx` rejection. Observed: every worker group
rejection on 2026-06-10 after the materialize hardening (render-audit ×5,
wind-bone-decimate ×3, grass-stability ×7 incl. resubmissions of already-landed work)
was EXACTLY this. Workers re-submit the same stale pair and see "just rejections."
The bump branch is pure ceremony: assembly step 8 (`updateSubmoduleGitlink`) overwrites
the gitlink to the REBASED inner SHA (`Ri`) regardless of what the branch said.

**Design (settled):** synthesis happens **integrator-side at assembly** — PM never runs
git (7.4 invariant). PM's job is the data model + API form; the integrator's job is
"outer candidate := live outer main + gitlink commit → Ri" (which is steps 4→8 of
today's assembly with the rebase skipped). A synthetic outer member CANNOT hit
`outer_conflict` because there is nothing to rebase.

**Rejected alternative:** auto-re-minting a worker's stale bump branch on conflict —
keeps the ceremony, adds magic on the failure path instead of removing the failure.

## Scope

1. **Data model (PM):** a group member row may be **synthetic** — born with no
   branch/commit (nullable refs + a `synthetic` flag on `merge_requests`; migration via
   `db:generate` single-baseline flow). The integrator fills `landedSha = Ro` at land.
   Timeline/`pm_get_merge_group` render it distinctly ("synthetic gitlink bump").
2. **API form (PM, REST + MCP):** `pm_request_merge_group` accepts
   `members: [<one inner spec>]` + `synthesize_outer: true` (explicit flag — a 1-member
   array without it stays a 400, no accidental semantics change). Validation: project
   declares exactly one inner+outer in `settings.integrator.linked_repos` (else 400);
   the legacy ≥2-member forms stay byte-identical. Zod: canonical Zod-3 in `@pm/shared`
   + the route-local Zod-4 mirror (the established split).
3. **Binding guard (integrator):** the single real member must resolve in the INNER
   repo; binds-to-outer or ambiguous → reject from `forming` with a legible reason
   (outer-only changes don't need a group).
4. **Assembly (integrator):** synthetic outer ⇒ skip the outer rebase (steps 4–6
   degenerate to `resetForAttempt` + `HEAD` as `baseOuterSha`); steps 7–9 (fetch Ri,
   commit gitlink, materialize incl. nested submodules/LFS) unchanged. §11 assertions,
   verify (per-repo, AND), land (inner-first), recovery, no-op detection: unchanged.
   The outer verify runs against the synthesized candidate exactly as today.
5. **Re-queue/self-heal property:** a rejected inner-only group is resubmitted by
   resubmitting ONE member; a land-race non-FF re-integration re-synthesizes against
   the NEW main automatically. Prove with a test that advances outer main's gitlink
   between submit and pickup — the group must land anyway (the exact failure observed
   live today).
6. **Docs + distribution:** worker doc (`docs/worker-pm-workflow.md`): inner-only form
   becomes THE recommended way to land an inner-repo change; two-member form remains
   for real outer changes, with the mint-at-submit-time warning for anyone still
   hand-bumping. `docs/integrator-deployment.md` §14.7 + CLAUDE.md 7.3 blurb updated.
   MCP tool description rewritten. Bundle redistribution to game_one is the deploy
   step (operator action, post-merge).

**Out of scope:** multi-gitlink synthesis (game_one's second gitlink
`tools/rynx-treegen` is not in `linked_repos`; bumping it still needs a real outer
member); >2-repo topologies; auto-cancel of duplicate stale submissions.

## Verification

- Full gate (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`) green at every
  commit; one logical commit per phase.
- Real-git integrator tests for the synthetic path (assembly skip-rebase, land,
  re-integration after gitlink drift) following `group-assembly.test.ts` /
  `group-e2e.test.ts` idioms (spawn-the-built-integrator seal for the e2e).
- The conflict-immunity test (scope item 5) is the campaign's seal — it reproduces
  today's live failure and must pass.
- Server: service/route/Zod tests incl. the 400 matrix (no flag, flag+2 members,
  flag without linked_repos, member binds to outer).

## Engineering values

No investment ceiling; structural elimination > guidance; the legacy form stays
byte-identical (back-compat is a hard constraint, the wire-seal tests prove it).

## Phases (DRAFT — pending adversarial verify)

- **P0** — worktree + baseline gate; read `phase-7.3-design.md` §5–6 + `group-assembly.ts` / `group-integration.ts` / `merge-group` service end-to-end before writing code. No commit.
- **P1** — PM data model: `merge_requests.synthetic` (migration), group service inner-only submit (validation matrix), member-spec Zod (shared Zod-3 + route Zod-4), `pm_get_merge_group`/timeline rendering. Server tests.
- **P2** — MCP: `pm_request_merge_group` `synthesize_outer` form + rewritten description; mcp-server tests.
- **P3** — integrator: binding guard (inner-only), assembly synthetic-outer path (skip rebase), land fills the synthetic member's `landedSha`; real-git unit tests.
- **P4** — seals: spawn-built-integrator e2e (inner-only group lands end-to-end) + the gitlink-drift conflict-immunity test + legacy-form byte-identity regression suite.
- **P5** — docs (worker / deployment §14.7 / CLAUDE.md / MCP descriptions) + ops handoff note (redistribute bundle, broadcast "stop minting bump branches" to game_one workers).
- **P6** — close-out: outcomes recorded here, full gate, diff-stat audit.

**Watch-items for the verifier:** the group state machine assumes every member is a
real merge_request row — confirm the synthetic row passes every status transition +
the `GROUPED_MEMBER` 409 pickup guard untouched; crash-recovery sweeps
(`reclaimStrandedGroups`) must tolerate a ref-less member; `pm_cancel_merge_request`
on a synthetic member should follow the group like any grouped member; check the
no-op-land path (`treesIdentical`) still short-circuits when the inner change is
already on main (synthesized Ro == main + same gitlink ⇒ no-op, never an empty bump
commit); decide whether `synthesize_outer` group with an INNER conflict engages the
7.6 resolver (it should NOT in v1 — group conflicts stay out of resolver scope).

## Close-out (executed 2026-06-10, branch `campaign-xrepo-inner-only-groups`, base f42054c)

All phases shipped; one logical commit per phase; full gate (typecheck 6/6, lint 6/6,
test 10/10 turbo incl. integrator 308 passed, build 5/5) green on the final tree.

- **P1 `1d11d0a`** — PM data model: `merge_requests.synthetic` (migration 0027, single ALTER);
  `synthesizeOuter` submit form behind a single exported `classifyCreateForm` classification
  point (legacy error strings preserved exactly); synthetic member born group-bound in one txn
  (null refs, taskId null); ZERO new state-machine guards needed (the existing GROUPED_MEMBER
  409s cover — proven by test pins, not assumed); web timeline badge + MCP get-renderer; legacy
  wire delta = additive `synthetic: false` only (key sets pinned both forms). shared 467→475,
  server 1455→1487, mcp 153→155. Verifier REVISE folded: web timeline rendering was unowned —
  amended in.
- **P2 `d6a715b`** — MCP `synthesize_outer` (snake_case) + rewritten three-form tool description
  (inner-only RECOMMENDED); flag forwarded even on the ids arm (server 400s legibly, never a
  silent drop); tests pin the REAL wire tiers (route Zod-tier 400s surface as
  ApiError UNKNOWN_ERROR + ZodError issues blob — empirically confirmed, no defaultHook; only
  the topology gate is a clean service-tier VALIDATION_ERROR). mcp 155→161.
- **P3 `c1fa85b`** — integrator: binding guard (real member must bind INNER; legible
  forming-rejects); assembly `outerRef: string | null` — the ONLY statement that can produce
  `outer_conflict` sits inside `outerRef !== null`, so conflict-immunity is structural;
  `updateSubmoduleGitlink` no-change idempotence made explicit/contractual (verifier
  EMPIRICALLY DISPROVED the planner's "latent throw" claim — behavior was incidental via
  simple-git's empty-stderr heuristic; reframed as hardening). group-land/recovery/resolver
  untouched (verified ref-agnostic). New `group-synthetic.test.ts`: binding matrix, assembly
  shape, land fills synthetic landedSha, unit-level conflict-immunity + no-op (outer main
  byte-unchanged). integrator 297→306.
- **P4 `e3690f4`** — e2e seals, purely additive (249/0): flow (g) in `group-e2e.test.ts` —
  it 1 = THE campaign seal (submit → drift BOTH remotes → spawn built integrator → lands;
  deterministic submit/drift/spawn ordering); it 2 = live-drain born-group-bound composition.
  Legacy regression = flows (a)–(f)+chaos byte-unmodified and green (10/10 in 363s). NOTHING
  new minted for legacy (P1/P2/P3 pinned wire/MCP/binding tiers — redundancy is negative value).
- **P5 `2ef4435`** — docs: worker inner-only flow (worked example, never-mint-bump-branches),
  deployment §14.7 three shapes + §14.6 row + new §14.9 operator view, CLAUDE.md inner-only
  blurb. Verifier corrections applied: no-op = assembly idempotence + natural FF no-op push
  (no "short-circuit" path); synthetic is the outer BY CONSTRUCTION (never ref-resolved).
  MCP descriptions deliberately untouched (done in P2).

**Spend-limit interruption note:** P1's executor was cut off by the monthly limit before
committing; the commander verified the full gate and committed. P3/P4 executors orphaned their
background gate runs the same way (P4's later self-resumed and reported). All work recovered;
nothing lost.

**Parked / out of scope (unchanged from the header):** multi-gitlink synthesis
(`tools/rynx-treegen`), >2-repo topologies, auto-cancel of duplicate stale submissions.
`group-e2e.test.ts` remains prettier-dirty at its pre-existing 80-col style (deliberate:
reformatting legacy flows would have broken the byte-identity seal; normalize tree-wide later).

## Ops handoff (operator actions after merge — NOT executed by the campaign)

1. Merge `campaign-xrepo-inner-only-groups` → `main` (full gate green; one commit per phase).
2. Rebuild + redistribute the bundle to game_one: `pnpm build`, then `node scripts/distribute.mjs` (ships the integrator bundle, MCP bundle, and the updated worker/operator docs to the target).
3. Restart the integrator daemon (`run_daemon.bat` at the game_one target). Caution: launch from a plain shell where `NoDefaultCurrentDirectoryInExePath` is NOT set (a Claude Code-spawned shell sets it; the daemon's children then fail to resolve bare `pm-verify.bat`).
4. Workers reconnect MCP to pick up the rewritten `pm_request_merge_group` tool description.
5. Broadcast to game_one workers: inner-repo (rynx) changes → `pm_request_merge_group(members: [<one inner spec>], synthesize_outer: true)`. STOP minting gitlink-bump outer branches. Rejected inner-only group: just resubmit the same one inner member (re-synthesis is automatic). Exception: real outer content changes and `tools/rynx-treegen` bumps still need the ≥2-member form.
6. Watch the first inner-only lands on `/projects/{id}/train` — the outer member shows the "synthetic gitlink bump" badge and gets `landedSha` filled at land.
