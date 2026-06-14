# Campaign A5 — Operator rollout + observability/audit + e2e seal + arc close

**Parent vision:** `roadmaps/vision-20260613-responder-auto-implement.md` (rev2, trust-first)
**Tier:** A. **PM task:** 01KV10TC7QQ66Z8Z2FKQGB3F3F.
**Depends on:** A4 (the budget/revert/reclaim guardrails + the metrics DATA — DONE @ 8e49e4a). The LAST campaign of the arc.
**Goal:** Auto-implement + the autonomous drive are legible and audited; the operator rolls them out deliberately (shadow→on); the loop is sealed end-to-end. After A5, the whole arc (a client escalation → autonomous implement/drive → verify-gated land → resolved, no human in the transport) is shippable behind a deliberate operator graduation.

## Trust-first stance (every sub-agent)
The merge-train verify gate is the structural floor (main never breaks). A5 adds NO human-approval gate. `shadow` is a CONFIDENCE-BUILDING RUNG (the operator observes the branch/vision + diff the responder produces, WITHOUT landing), NOT a standing approval queue — once the operator is confident, they flip to `on` and it is autonomous. enabled=false stays the default kill-switch. The whole arc still ships OFF; A5 makes the graduation deliberate + legible.

## What A1-A4 shipped (the capability A5 rolls out)
- A1: assess + injection sniff-test + the write-capable bounded implement session → verified branch. A2: escalation-linked train land + post-back. A3: the autonomous multi-phase /vision+/campaign drive (advanceArc). A4: the budget caps + the verify-gated revert path + the per-MR stall reclaim + the `auto_implement` metrics sub-block on `GET …/escalations/metrics` (land/reject/revert rates; spend parked — no token source). All behind `auto_implement.enabled` (default false).
- The C4 escalation dashboard (web) already exists + reads the escalations metrics endpoint. A5 EXTENDS it.

## What exists to reuse (read first)
- `packages/responder-ref/src/{loop.ts, config.ts}` — `auto_implement.enabled` (the kill-switch) + the EXISTING responder `mode` (off|shadow|on) for the ANSWER/diagnose path (do NOT conflate — A5 adds a DISTINCT auto-implement rollout mode, OR carefully composes with the existing one; resolve in P1). The runImplementSession/runDriveSession/advanceArc paths that `shadow` must produce-without-landing.
- `packages/web/` — the C4 escalation dashboard + the escalations-metrics read (A4's `auto_implement` sub-block) + the merge-request/timeline views (the audit chain: escalation ↔ MR/epic ↔ landed_sha ↔ revertOf).
- The A2/A3 server post-back + the merge-request timeline (the 7.4 per-request timeline renders resolvedFrom/escalationId/revertOf — the audit chain).
- The responder-seal.test.ts (the A2/A3 seals) — the e2e seal harness to extend.

## Engineering values
No investment ceiling; reuse the C4 dashboard + the A4 metrics + the seal harness (don't reinvent); additive — answer-mode + A1-A4 + C1-C4 stay byte-identical; the whole arc ships `auto_implement.enabled=false`. The honest dependency (the vision): autonomous land quality tracks verify quality — A5 surfaces the land-success/reject/revert rates so the dependency is MONITORED, not blind.

## Verify commands
`pnpm --filter @urtela/pm-responder test`, `pnpm --filter @pm/server test`, `pnpm --filter @pm/shared test`, `pnpm --filter @pm/web test` (+ `pnpm test:e2e` for the Playwright seal if applicable), `pnpm build`, `pnpm typecheck`, `pnpm lint`, openapi:export + generate:api if a REST surface changes.

## Phases (each: plan → adversarial verify → execute → commit)

### P1 — The operator rollout mode (auto_implement.mode off|shadow|on)
Resolve the mode semantics FIRST (read the existing responder `mode` + `auto_implement.enabled`): does `auto_implement.mode` subsume `enabled` (off == disabled) or compose with it? Recommend a clean model: `auto_implement.mode: off | shadow | on` where **off** = inert (byte-identical to today, the kill-switch — likely subsumes/replaces `enabled` OR `enabled=false` forces off); **shadow** = the responder DOES the work (assess → sniff → implement/drive → produce the verified branch / the vision+diff) but does NOT SUBMIT the merge request / does NOT land — instead it posts the branch + diff/plan summary to the escalation thread for the operator to OBSERVE (the confidence-building rung; the escalation stays acknowledged/needs_human-for-operator, NOT auto-resolved); **on** = fully autonomous (submit → train → land → resolve, the A1-A4 behavior). Shadow must produce a REAL observable artifact (the pushed branch + the diff) so the operator sees exactly what `on` would land. Decide how shadow composes with the bounded path (A1/A2) AND the drive path (A3). Tests: shadow produces the branch + the diff/plan message but NO merge-request submit + NO land + NO auto-resolve; on submits+lands (A1-A4 behavior intact); off is inert (byte-identical); the existing answer-mode `mode` is untouched.

### P2 — The dashboard surface + the audit chain (web)
Extend the C4 escalation dashboard (web): auto-implemented + auto-driven escalations SHOW the linked MR / vision-epic, the landed_sha(s), the train outcome, the arc progress (which phases landed), and the revert chain — the audit chain escalation ↔ MR/epic ↔ landed_sha ↔ revertOf, rendered legibly. Surface the A4 metrics (the `auto_implement` sub-block: auto-implement rate, land-success/reject/revert rate; mean-time-to-land from the existing train metric; spend-per-arc shown as N/A or the cheap proxy [per-arc MR count × time-to-land / arc wall-clock] — decide). Reuse the existing escalations-metrics read + the merge-request/timeline views. Tests: web component/integration tests for the auto-implement panel + the audit-chain rendering + the metrics display; the dashboard reads the real endpoints. (If the dashboard is heavy, scope to the highest-value: the audit chain + the rate metrics.)

### P3 — The e2e seal (the whole loop, real server + train)
The full e2e seal against the real server + train (injected runner/LLM step, like the A2/A3 seals but the END-TO-END arc): assess → (bounded implement → land) AND (systemic → drive → land) → resolve → origin auto-notices. Plus the mode-rollout e2e: shadow observes (produces the branch/diff, no land), on is autonomous. Extend responder-seal.test.ts or a server integration test; a Playwright e2e for the dashboard if warranted. This is the campaign's proof that the whole arc closes. Tests: the bounded e2e (assess→implement→land→resolve→origin); the systemic e2e (assess→drive→phases land→resolve→origin); the shadow-mode e2e (produces, doesn't land); the revert e2e (a landed sha → revert → lands → audit chain).

### P4 — Arc close (docs + whole-arc retrospective + final seal)
The CLAUDE.md A5 paragraph (the operator rollout + the dashboard/audit + the e2e seal) + the responder README (the mode rollout — shadow→on graduation, the kill-switch). A whole-arc note: the complete loop (escalation → autonomous implement/drive → verify-gated land → resolved → origin, behind the deliberate shadow→on graduation, ships OFF). Full build/typecheck/lint + the whole-arc suite green; openapi/web regen if needed. Commit; campaign-close checkpoint. THE WHOLE A1-A5 ARC IS DONE after this.

## Done when
All phases committed, the whole-arc suite + build/typecheck/lint green, the operator rollout works (off inert / shadow observes-without-landing / on autonomous), the dashboard surfaces the auto-implement metrics + the audit chain, the e2e seal proves the whole loop closes (bounded + systemic + shadow + revert), A1-A4/C1-C4/answer-mode byte-identical. The arc ships behind `auto_implement.enabled=false` (or `mode=off`) with a deliberate, legible shadow→on graduation. **The whole responder-auto-implement vision is COMPLETE.**
