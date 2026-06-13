# Campaign C2 — Failure legibility & break-glass completeness

**Date:** 2026-06-10
**Vision:** `roadmaps/vision-20260610-repo-quality-consolidation.md` §C2 (authoritative — read it)
**Tier:** A · **PM task:** `01KTQS6KVFPQ7SJ663JS9VGQW9`
**Goal:** no failure path in the train or server is silent, and every stuck state a human can encounter has a visible cause and an audited exit.
**Branch:** `campaign-c2-failure-legibility` off post-C1 main, dedicated worktree `D:\code\pm-c2-legibility`.

## Scope (verified findings; full detail in vision §C2)

1. **Group-state-aware force-land** — BOTH guards must widen together (assertMemberLandableViaGroup groupId check at merge-group.service.ts:1117 called from train.service.ts:698, AND the `status !== "integrating"` guard at train.service.ts:705 — the stuck member of a partial group has status `rejected` per markIntegrating/markPartiallyLanded sequencing ~merge-group.service.ts:993-996). Legality matrix (vision §C2 — implement exactly): non-grouped unchanged byte-identical; grouped + group forming/integrating → 409; grouped + group terminal (rejected/partially_landed) + member rejected → force-landable (reason-required, audited force_land with group id in payload); orphaned-marked inner member → 409. Operator guide §15 runbook update. Open question #2 resolved by commander: force-landing the last stuck member of a partially_landed group SHOULD auto-resolve its open incident (human_resolved, same transaction, one audit row).
2. **releaseLock-failure surfacing** — integrator (batch.ts ~1100-1118 warn-and-continue): record the failure on the next heartbeat payload (additive optional field; route schema must tolerate absence — old integrators keep working) so GET .../integrator/health + train dashboard show why a lane idles.
3. **resolvedFrom fresh re-read** at the conflict seam (batch.ts ~680): re-fetch the request before maybeOpenResolution; fetch error → skip resolution + log (non-fatal), making the no-recursion invariant snapshot-independent.
4. **Verify-cache config guardrail** — PATCH-time warning when `cache_mode: "on"` while any verify step lacks `cache_key_inputs` (the documented false-pass precondition) + a hint on the admin Integrator settings page (`/projects/{id}/settings/integrator`).
5. **Silent-swallow slot-ins:** warn-log in findSimilarOpenNotes catch (NOTE: the function was just rewritten — two-pass AND→OR with one try/catch wrapping both, landed d8237cc; put the warn in THAT catch); warn-log when claim-lease reclaimOne skips a null-projectId entity (claim-lease.service.ts ~489-493); mcp api-client preserves non-JSON error bodies via res.text() fallback (api-client.ts:791,1532,1632); user.service.count() → SQL COUNT (user.service.ts:273); POST /auth/setup transactional check-and-create (routes/auth.ts ~186-219).

## Invariants (must hold)

Merge-train defaults unchanged (cache off, resolver off, parallelism 1). Existing 7.x invariant suites green untouched. The force-land contract is unchanged in kind: PM records operator-asserted landedSha and never runs git.

## Tests (gate)

Full force-land legality-matrix route tests (every row; non-grouped rows proven byte-identical); heartbeat-after-failed-release integrator test; mid-flight resolved_from write blocks resolution; config-PATCH warning test; unit tests per de-silenced path. `pnpm typecheck/lint/test/build` green at every commit; one logical commit per phase.

## Do-not-touch

`tests/e2e/` (just stabilized — order-dependent specs 02-06 are a known limitation, not yours). **AMENDED by commander 2026-06-10:** the original no-migration clause is lifted — `db:generate` works again (snapshot baseline rebuilt on main). Migration **0027** is reserved for this campaign (P2's durable column). Generate it with `pnpm --filter @pm/server db:generate`; never hand-edit `migrations/meta/`.

## Phases (P1–P5 per the approved plan, WITH the verifier's REVISE amendments — all adopted)

The Plan leg's full plan was adversarially verified: design confirmed against the real state machines (full force-land reachability table checked). Execute the plan as written PLUS these binding amendments:

1. **P2 → durable column, not in-memory map:** nullable `last_release_failure` (JSON text `{at, message}` or two nullable columns — pick the table's existing idiom) on `integrator_health`, via generated migration **0027**. Rationale (verifier): the table's design pin is "PM-owned; survives integrator crashes"; the documented operator reflex (restart the daemon) would erase an in-memory flag at exactly the wrong moment. Tri-state semantics: field absent in heartbeat (old integrator) → leave stored value untouched; explicit null → clear; value → set. Heartbeat emit is **omit-when-absent** so `batch.test.ts:2942`'s exact `toEqual` stays untouched (C1 owns that file).
2. **P1 union ordering pinned:** member-status-`landed` idempotent no-op evaluates FIRST; "group landed → 409" covers only the residue. Test both.
3. **P1 audit honesty:** the hardcoded audit `before` at train.service.ts:~800 (`{status:"integrating", landedSha:null}`) becomes status-derived (`{status: row.status, landedSha: row.landedSha}`) — identical output for the non-grouped path, truthful for the new path.
4. **P4 predicate:** warn only when `cache_enabled === true` AND `cache_mode === "on"` AND a step (incl. the synthetic verify_command step) lacks `cache_key_inputs`; `warnings` key omitted when empty (not `[]`).
5. **P5 setup-race structure:** bcrypt-hash FIRST, then the codebase's synchronous `db.transaction((tx) => { count-check; insert; })` — no await between check and insert.
6. **Explicit deliverables:** §15 runbook update (new §15.3.2 partially-landed-group recovery) and the train-dashboard health line are named phase outputs, not assumptions. P1's force-land route description update → openapi regen in the same commit.
7. **Commander-approved slot-in addition (P5):** `claims-health.service.ts:34` pins grace to `LEASE_GRACE_MS_DEFAULT`, ignoring `PM_LEASE_GRACE_SEC` — badge-staleness and alert-staleness disagree under tuned grace (found by C3's verifier). Fix: derive the alert grace from the same env-driven config as `claim-lease.service`. Byte-identical under defaults (env default = the constant). Unit test: tuned grace env → alert threshold follows.

Verifier-confirmed facts the executor can rely on: three releaseLock catch sites (batch.ts ~1100-1119 warn / ~1919-1928 debug→ both via one shared releaser factory; loop.ts not production-wired — leave it); heartbeat schemas tolerate both old→new and new→old; fetch-error→skip in maybeOpenResolution preserves never-discard-work (origin already rejected with comment before the seam); resolvedFrom is creation-only today so the mid-flight test injects via DB directly; web mirror precedent = IntegratorConfig in api.ts:71; 409 SETUP_COMPLETE envelope exists; bracketed-tag warn idiom = events/alerts-listener.ts:138.
