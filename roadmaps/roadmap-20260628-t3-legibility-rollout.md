# Campaign T3 — Legibility, rollout, observability & e2e seal (campaign-closing)

Parent vision: `roadmaps/vision-20260628-notes-triage-autonomy.md` (read "T3" + cross-campaign invariants). Builds on T1 (contract + settings.notesTriage + needs_human/reopen/proposalKind) and T2 (the triager daemon + the `triage_decisions` side-log written in BOTH shadow + on).

Tier A. The web/observability surface that makes autonomous triage legible + operator-controlled. `@pm/web` uses OpenAPI-generated types (`pnpm --filter @pm/web generate:api`); it does NOT depend on @pm/shared (it MIRRORS shared logic locally). Commands: `pnpm build`, `pnpm test`, `pnpm --filter @pm/server test`, `pnpm --filter @pm/web test`, `pnpm --filter @pm/server openapi:export`, `pnpm --filter @pm/web generate:api`, `pnpm test:e2e`, `pnpm typecheck`, `pnpm lint`.

**Cross-campaign invariants (green every phase):** proposal-gate invariant test byte-identical green; ships OFF (settings.notesTriage.enabled=false default); shadow mutates nothing; needs_human never auto-resolved; honest/monotonic migration `when` + migration-journal regression-test MAINTENANCE-NOTE updated for any new schema migration.

---

## P1 — Web inbox: needs_human queue + fast-track badge + undo-triage + auto-decision audit feed

- **Goal:** Surface the new triage lanes/actions in the existing notes inbox web page.
- **Changes:** the inbox page (find `packages/web/src/pages/notes-page.tsx` + its components) gains: a `needs_human` queue/filter (the human-action lane); a fast-track-proposal badge (read proposalKind on the promoted target); an **undo-triage** action wired to `POST /notes/{id}/reopen` (human-only — surface the 403 cleanly); and an **auto-decision audit feed** per note (who/what triaged + triageReason + the resulting proposal/task link), reading the `triage_decisions` list endpoint (`GET /api/v1/projects/{projectId}/triage-decisions`). Live SSE (NOTE_NEEDS_HUMAN / NOTE_REOPENED / TRIAGE_DECISION_RECORDED → query invalidation). Run `generate:api` (T1's openapi changes may not yet be in web types).
- **Verify:** web component/page tests; the needs_human filter; undo calls reopen; the audit feed renders decisions; SSE invalidation. `pnpm --filter @pm/web test`.

## P2 — settings.notesTriage off→shadow→on rollout toggle (web settings page)

- **Goal:** An admin settings page control for `settings.notesTriage` (enabled + mode off|shadow|on + triageAgentId), mirroring the Integrator/auto-implement settings pages.
- **Changes:** find the project settings pages (e.g. `/projects/{id}/settings/integrator`) and add a notes-triage settings page/section: enabled toggle, mode select (off|shadow|on), triageAgentId field. Read-merge-write the single sub-block (the tolerant PATCH idiom). Mirror the autoImplement settings UI.
- **Verify:** settings page test; PATCH→GET round-trip of the notesTriage block; mode select persists.

## P3 — Observability: decision-mix + backlog burndown metrics + audit chain

- **Goal:** Metrics the operator reads to calibrate the decision-mix (esp. in shadow before flipping to on) + the audit chain.
- **Changes:** a metrics endpoint/derivation over `triage_decisions` (decision-mix: promote_standard / promote_fast_track / dismiss / needs_human rates; triage latency; daemon heartbeat) — read from the side-log so SHADOW decisions are visible WITHOUT mutating notes (the whole point); **filter by triageAgentId** (T2-P1 advisory: the record endpoint has no triage-agent gate, so the reader must scope to the daemon identity). Backlog burndown (open-note count over time). A web dashboard surface for the decision-mix + burndown. Audit chain: note ↔ decision ↔ proposal/task ↔ reopen as a timeline (reuse the activity-log/listeners precedent). Migration only if a metrics/heartbeat table is needed (prefer on-read derivation — no migration).
- **Verify:** metrics derivation tests (decision-mix counts, scoped by triageAgentId); burndown; dashboard renders; on-read (no migration) if achievable.

## P4 — Alerts: reuse backlog alert + add triage-error/daemon-down alert

- **Goal:** Operator alerting.
- **Changes:** REUSE the existing `NOTES_BACKLOG_THRESHOLD_MS` + `notes_alert_state` latch (enums.ts:125-129, Campaign C2 §P5 — already built) for backlog-stall. ADD a triage-error / daemon-down alert (e.g. no triage_decisions recorded within an expected window while enabled, or a daemon heartbeat lapse) via the existing train/escalation alert plumbing (SSE + Discord webhook).
- **Verify:** alert-firing tests; reuse of the existing latch confirmed (not a re-build).

## P5 — Full e2e seal + arc close

- **Goal:** A Playwright (or the project's e2e harness) seal proving the loop end-to-end against the real server, with an injected/scripted LLM step (NO real claude).
- **Changes:** e2e: post note → (injected) daemon triages → assert each branch: fast-track → tasks created via breakdown; needs_human → queued in the web inbox; dismiss → terminal with reason; reopen → back to open. Mode-toggle gating (shadow observes [side-log row, note open], on executes) end-to-end. Use the triager's injected fakes or a scripted decision feed; do NOT spawn a real claude.
- **Verify:** `pnpm test:e2e` (the seal); then the FULL repo suite (`pnpm build && pnpm typecheck && pnpm lint && pnpm test`) green + proposal-gate invariant byte-identical. This COMPLETES the arc.
