# Campaign T2 — Autonomous triage daemon (`@urtela/pm-triager`)

Parent vision: `roadmaps/vision-20260628-notes-triage-autonomy.md` (read "T2" + cross-campaign invariants). Builds on T1 (shipped on branch `campaign-notes-triage-autonomy`): note `needs_human` lane + reopen, advisory `proposalKind` flavor, `settings.notesTriage` + `resolveNotesTriage(masterEnv, settings)` env⊗DB helper in `@pm/shared`, dismiss-identity authz (enabled-gated), MCP triage tools.

Tier A (headline capability). Ships behind `settings.notesTriage.enabled=false`. Reuse the responder-ref daemon pattern wholesale (`packages/responder-ref`: loop.ts, config.ts, api-client.ts, injection-sniffer.ts, injectable runner seam, spawn budget, reclaim sweep, no-recursion).

Commands: `pnpm build`, `pnpm test`, `pnpm --filter @pm/server test`, `pnpm --filter @pm/server db:generate`, `pnpm --filter @pm/server openapi:export`, `pnpm typecheck`, `pnpm lint`.

**Cross-campaign invariants (green every phase):** proposal-gate invariant test byte-identical green; no AI note→task except via promote→claim→implementProposal; ships OFF (disabled ⇒ byte-identical); shadow mutates NOTHING (records a side-log, leaves the note open); needs_human never auto-resolved; honest/monotonic migration `when`; the migration-journal regression test's MAINTENANCE-NOTE must be updated for any new SCHEMA migration.

---

## P1 — Triage-decision side-log data model (server; the shared contract T3 reads)

- **Goal:** A durable record of every triage decision the daemon makes — in `on` mode AND `shadow` mode — keyed by note, so shadow is observable and the audit chain (T3) has a source. This is the contract T3's decision-mix metrics + audit feed consume.
- **Changes:** new `triage_decisions` table (id, projectId, noteId FK, mode at decision time, decision enum [promote_standard|promote_fast_track|dismiss|needs_human|give_up], rationale/triageReason, confidence?, resultingProposalId? / resultingTaskId?, actorId [the triage agent], createdAt). Shared Zod schema + enum (`TRIAGE_DECISIONS` / `TriageDecisionKind`). Migration (honest journal `when`; update migration-journal regression-test maintenance note). REST: a write path the daemon calls (or fold the write into the existing decision endpoints) + a list/read path for T3. SSE event for live T3 updates. OpenAPI re-export.
- **Decide:** whether shadow decisions write ONLY to this table (note untouched — REQUIRED invariant) while `on` decisions write the table AND perform the real triage action. Keep the table the single source for both so T3 metrics are uniform.
- **Verify:** table round-trips; shadow decision writes a row + leaves the note `open` (status unchanged); on decision writes a row + performs the action; list endpoint filters by project/mode/decision; invariant test green; migration applies + journal hygiene.

## P2 — `@urtela/pm-triager` package skeleton + config + api-client + poll/seed loop

- **Goal:** A new daemon package mirroring responder-ref: per-project tick that seeds open notes (oldest-first; exclude self-authored/already-triaged/in-flight) and is gated by `resolveNotesTriage` (env master `PM_NOTES_TRIAGE_ENABLED` ⊗ DB). No assessment yet — wire the loop, config, api-client, enablement gate, and a no-op decision stub.
- **Changes:** `packages/triager-ref` (package.json `@urtela/pm-triager`, bin `pm-triager`), `src/{index,loop,config,api-client,logger,version}.ts`. Config reads `PM_NOTES_TRIAGE_ENABLED`, `PM_API_URL`, token/pool, worker key, budgets, poll interval. Loop: list open notes per watched project → filter seed → (stub) decide. Enablement: a disabled/off tick is a no-op (defense-in-depth + index exit).
- **Verify:** unit tests for seed filtering, enablement gate (off ⇒ no-op; resolveNotesTriage composition), api-client wrappers; package builds.

## P3 — Injection sniff + bounded LLM assessment session (injectable runner)

- **Goal:** For each seeded note, run the cheap injection sniff (reuse the injectable `InjectionSniffer` seam from responder-ref; fail-safe ⇒ route needs_human, never assess), then a bounded assessment session (injectable runner; production wires a `claude -p` spawn with status sentinel, tests inject a fake) that emits a structured decision: `{ kind: promote_standard | promote_fast_track(+inline minimal breakdown) | dismiss | needs_human | give_up, rationale, confidence }`.
- **Changes:** `src/{injection-sniffer,assessment-runner,assessment-prompt}.ts` (graft responder-ref sniffer; new prompt encoding the bias-to-reversible discipline + the fast-track/systemic sizing heuristic). Decision schema in shared or the package.
- **Verify:** sniff suspicious ⇒ needs_human (never assess); sniff clean ⇒ assess; runner returns each decision kind (injected fake); assessment prompt encodes the dismiss-only-on-clear-no-merit + ambiguous⇒needs_human/promote_standard bias.

## P4 — Decision execution + mode gating + bias discipline

- **Goal:** Execute the assessed decision through T1 endpoints, gated by mode.
- **Changes:** execution router: `promote_standard` → `pm_promote_note_to_proposal` (standard); `promote_fast_track` → promote (fast_track) → CLAIM the proposal (assertClaimOk) → `implementProposal` with the inline minimal breakdown → tasks in backlog (the sanctioned chain, no new server op); `dismiss` → dismiss (daemon is the project triage identity); `needs_human` → flag-needs-human; `give_up` → flag-needs-human (fail-safe). Mode gate: `off` inert; `shadow` writes the P1 side-log row + leaves the note OPEN, mutates nothing (NO promote/dismiss/flag); `on` writes the side-log row AND performs the action. Bias: dismiss only on clear no-merit; ambiguous ⇒ needs_human.
- **Verify:** each decision executes correctly in `on`; shadow records-and-leaves-open for every decision kind (asserts note stays open, no proposal/task minted); fast-track path = promote+claim+implement; daemon dismiss works as triage identity; give_up ⇒ needs_human.

## P5 — Safety seals (budget / reclaim / no-recursion) + e2e seal + tests

- **Goal:** Production-safety seals (reuse responder precedent) + the campaign seal.
- **Changes:** spawn-rate + cost/concurrency budget (bound a backlog spike); reclaim sweep for stranded sessions; no-recursion (daemon authors no notes; exclude self + already-triaged); structured logging. A package-level e2e/integration test against an injected runner.
- **Verify:** budget caps spawns; reclaim recovers a stranded note; no-recursion holds; full daemon test green; `pnpm build && pnpm typecheck && pnpm lint && pnpm test` green; proposal-gate invariant byte-identical.
