# Campaign T1 — Triage contract, state machine, fast-track flavor, authz, settings & MCP

Parent vision: `roadmaps/vision-20260628-notes-triage-autonomy.md` (read "T1" section + cross-campaign invariants).
Tier S (foundation). Ships entirely behind `settings.notesTriage.enabled=false` — zero behavior change when disabled. **The proposal-gate invariant test (`packages/server/tests/services/note-proposal-gate.invariant.test.ts`) must stay byte-identical green at every phase.**

Project commands: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm --filter @pm/server test`, `pnpm --filter @pm/shared test`, `pnpm --filter @urtela/pm-mcp-server test`, `pnpm --filter @pm/server db:generate` (migration), `pnpm --filter @pm/server openapi:export`, `pnpm --filter @pm/web generate:api`.

---

## P1 — Note state machine: `needs_human` lane + reopen + `assertOpen`→mutable-predicate + migration

- **Goal:** Add the `needs_human` non-terminal status and the reopen/undo-triage path; convert the binary open-check into a mutable-state predicate.
- **Changes:**
  - `packages/shared/src/schemas/note.ts`: `NOTE_STATUSES = ["open","needs_human","triaged"]`. Keep `NOTE_TRIAGE_OUTCOMES = ["promoted","dismissed"]` (needs_human is a STATUS, not an outcome).
  - `packages/server/src/services/note.service.ts`: `assertOpen`→ a mutable-state predicate (mutable = {open, needs_human}; terminal = {triaged}). `applyTriage` accepts `{open,needs_human}→triaged`, rejects `triaged→*`. Add `flagNeedsHuman(id, actor)` — status-only `open→needs_human`, NO triageOutcome. Add `reopen(id, actor)` — human-only `{triaged,needs_human}→open`, clears triage metadata to null (audit the prior disposition). `dismiss`/`promoteToProposal` must accept a `needs_human` note (so a human can act on the queue), not only `open`.
  - DB migration (`db:generate` after schema.ts edit if needed; note status is text so the enum widening may need no column change — confirm). Reopen-cleared columns already nullable.
  - Server routes: REST endpoints for flag-needs-human + reopen (mirror existing dismiss/promote routes). Update OpenAPI export.
  - New SSE events if the codebase pattern needs them (NOTE_NEEDS_HUMAN / NOTE_REOPENED) — follow the NOTE_DISMISSED/NOTE_PROMOTED precedent in events.
- **Verify:** `pnpm --filter @pm/shared test` + `pnpm --filter @pm/server test`; new unit tests for every transition incl. `open→needs_human`, `needs_human→triaged`, reopen (both sources), `triaged→*` rejection, human-only on reopen; the proposal-gate invariant test still green; `openapi.json` drift guard passes (re-export).
- **Migration-journal hazard:** stamp `_journal.json` `when` with real current time, strictly monotonic, never future (repo's 2026-06-10 silent-skip incident). Let `db:generate` author it.
- **This is the phase-pin unblocker for T3.**

## P2 — Advisory fast-track proposal flavor

- **Goal:** Add `proposalKind ∈ {standard, fast_track}` (default `standard`) — a label + routing signal, NOT a server authz seal.
- **Changes:**
  - `packages/shared/src/schemas/proposal.ts` + `constants/enums.ts`: add `PROPOSAL_KINDS`/`proposalKind` (default `standard`).
  - `packages/server/src/db/schema.ts`: `proposals.proposalKind` column (default 'standard'); migration (honest journal stamp).
  - `proposal.service.ts` `create` + `note.service.ts` `promoteToProposal`: accept + persist `proposalKind`. **Do NOT** add `acceptAndImplementFastTrack` or loosen `PROPOSAL_TRANSITION_MAP` — the existing `promoteToProposal`→claim→`implementProposal` chain already breaks down from `open`.
- **Verify:** unit tests that a fast_track proposal is created with the flavor and is otherwise byte-identical to standard (same lifecycle); invariant test green; OpenAPI re-export.

## P3 — Dismiss-identity authz + `settings.notesTriage` + env master

- **Goal:** Let the designated triage identity dismiss non-authored notes; add the rollout settings block + env composition.
- **Changes:**
  - `packages/shared/src/schemas/project.ts`: `notesTriageSettingsSchema {enabled:false, mode: off|shadow|on (default shadow), triageAgentId?: string}`; add to `projectSettingsSchema`; mirror in the Zod-4 route mirror (`packages/server/src/routes/projects.ts`) in lockstep. Reuse the shared `AUTO_IMPLEMENT_MODES` value-set or a parallel `NOTES_TRIAGE_MODES` const (match the autoImplement idiom).
  - Env master `PM_NOTES_TRIAGE_ENABLED` composition (explicit-false ⇒ force-off-all; true/unset ⇒ defer to DB) — find where autoImplement composes its env master and mirror it.
  - `note.service.ts` `dismiss`: widen authz — a non-author `ai_agent` may dismiss iff it is the project's `settings.notesTriage.triageAgentId`. Ordinary worker agents still 403 (anti-signal-burying seal intact).
- **Verify:** settings read-tolerance + env composition tests; dismiss-widening allows the triage identity, still 403s an ordinary non-author agent; mirror-parity test (Zod-3 shared vs Zod-4 route).

## P4 — MCP tools + invariant tests

- **Goal:** Expose the autonomous-drive surface; seal with invariant tests.
- **Changes:**
  - `packages/mcp-server/src/tools/notes.ts`: `pm_flag_note_needs_human`, extend `pm_promote_note_to_proposal` (accept `fast_track` flavor + optional inline breakdown args), `pm_reopen_note` (human), add `needs_human` to the `pm_list_notes` status filter. `pm_dismiss_note` already routes to the widened service authz. **NO** new note→task MCP tool.
  - `packages/mcp-server/src/api-client.ts`: wrappers for the new endpoints.
- **Verify:** `pnpm --filter @urtela/pm-mcp-server test`; the proposal-gate invariant test passes UNCHANGED (assert no AI note→task path exists); end-to-end round-trip of flag-needs-human + reopen via MCP; full `pnpm build && pnpm lint && pnpm typecheck && pnpm test` green.

---

## Campaign invariants (green every phase)
- Proposal-gate invariant test byte-identical green; no note→task MCP tool; `sourceNoteId` non-client-settable.
- Ships OFF (`settings.notesTriage.enabled=false`) — disabled ⇒ byte-identical to today.
- Migration `when` stamps honest/monotonic/non-future.
- Zod-3 shared ⇄ Zod-4 route mirror kept in lockstep.
