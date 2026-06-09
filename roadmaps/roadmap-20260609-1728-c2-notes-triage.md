# Campaign C2 — Triage lifecycle + proposal-gate seal (+ backlog-age alert)

**Derived from:** `roadmaps/vision-20260609-notes-findings-inbox.md` (campaign C2)
**Date:** 2026-06-09
**Tier:** A (workflow + structural seal)
**Branch:** `campaign-c2-notes-triage` (stacked on `campaign-c1-notes-capture` — C1 not yet merged to main)
**PM tracking:** project `project-manager` (01KT1VN1BEMF1KZGBFMGXBY5W1), vision epic 01KTP3Y628M4JQFY7EMZVMZFAJ, C2 task 01KTP3Z3WPRNSJYVWDA55TVEHY

## Goal

Give a note a triage destiny — `open → triaged(promoted | dismissed)` — where **promote-to-proposal** (provenance-linked) is the canonical AI-reachable path and **promote-to-task** is a human-gated escape hatch for the trivially-clear; structurally guarantee notes never auto-spawn epics/tasks; and fire an edge-triggered alert when the untriaged backlog ages out.

## What C1 already shipped (build on these)

- `@pm/shared` note schemas: `NOTE_KINDS`, `NOTE_STATUSES` (`open | triaged`), `NOTE_ANCHOR_TYPES`, `NOTE_SEVERITIES`, `Note`/create/list/patch DTOs, `CodeLocator`.
- `notes` table (migration 0024): id, projectId, kind, status (default 'open'), title, body, anchorType/anchorId (soft, no FK), codeLocator, severity, authorId, timestamps. Enum cols carry `.$type<>()`.
- `note.service.ts` (create/getById/list/update — update has an **open-only guard** already, throws 409 INVALID_STATUS for non-open). Emits `NOTE_CREATED`/`NOTE_UPDATED`; activity via the event→onAll-listener path.
- `routes/notes.ts` (POST create `{data, similar}` 201, GET by id, GET list, PATCH). `findSimilarOpenNotes` + FTS.
- MCP `pm_post_note` / `pm_list_notes` / `pm_get_note`; api-client `createNote`/`listNotes`/`getNote`.

## Engineering values (non-negotiable)

- No investment ceiling — end-result quality over minimum diff.
- Automatic > manual — the proposal-gate invariant must be **structural**, not callsite discipline.
- Getting it right > getting it done fast.

## House conventions to honor

- Zod-3 canonical in `@pm/shared`; route-local Zod-4 mirror in routes.
- Migrations applied via `meta/_journal.json` (idx + tag), NOT `*.sql` glob. Latest after C1 is `0024_notes` (idx 24) → C2 uses **`0025`** (triage columns + provenance) and **`0026`** (notes_alert_state). Each needs a journal entry. (NOTE: `db:generate` is blocked by a pre-existing 0005/0006 snapshot collision — hand-author migrations + journal entries, as C1 P2 did.)
- Activity rows: emit an event; the `onAll` listener (`events/listeners.ts` `eventToAction`) writes `activity_log`. Add new event names to `EVENT_NAMES` + map them in `eventToAction`.
- Edge-triggered alert idiom: clone `claims-health.service.ts` + `claims_alert_state` (latch row, on-read aggregate, fire-once-per-episode + re-arm on drain) + the `alerts-listener.ts` Discord `formatAlert` branch (NOTE-2 non-fatal discipline) + SSE via `onAll`.
- `human` role gate idiom: `actor.type === "human"` (see `claim-helpers.ts`, proposals force-claim).

## Available commands

```
pnpm --filter @pm/server test         # server tests (primary gate for most phases)
pnpm --filter @pm/shared test
pnpm --filter @urtela/pm-mcp-server test
pnpm typecheck
pnpm lint
pnpm build
pnpm test                              # full suite (final gate)
```

Verification preference: **unit tests > build > manual.**

---

## Phases

### P1 — Triage data model + state-machine core
- `@pm/shared`: add `NOTE_TRIAGE_OUTCOMES` (`promoted | dismissed`) const tuple + type; any triage transition validation helper. Extend `noteSchema` with the new nullable triage fields (triagedAt, triagedBy, triageOutcome, promotedProposalId, promotedTaskId) — all nullable, additive.
- `schema.ts` + migration **0025**: add to `notes` — `triagedAt`, `triagedBy` (FK users, the accountability datum), `triageOutcome`, `promotedProposalId` / `promotedTaskId` (FK with ON DELETE SET NULL). Add nullable `sourceNoteId` to `proposals` and `tasks` (FK notes, ON DELETE SET NULL; additive + default null ⇒ existing creates byte-identical). Journal entry idx 25. Update `schema.test.ts` expected-table list only if a table is added (none here — columns only; but check for column-count assertions).
- `note.service.ts`: a triage-transition core (a `triage(id, outcome, ...)` internal helper or guards) — terminal-state guard (a `triaged` note is immutable; the open-only update guard from C1 already covers PATCH). NO endpoints yet (P2/P3/P4 expose them).
- **Verify:** shared test (new enum tuple + schema parse); server test (migration applies on in-memory boot; the new columns exist; existing suite green). `pnpm --filter @pm/shared test`, `pnpm --filter @pm/server test`, `pnpm typecheck`.

### P2 — Dismiss endpoint + authz
- `note.service.ts`: `dismiss(id, actor, reason)` — guard note is `open` (else 409); set status `triaged`, triageOutcome `dismissed`, triagedAt/triagedBy, store reason (where? a dismiss reason — decide: a `triageReason`/`dismissReason` column added in P1's migration, OR reuse an existing field — planner decides; likely add a `triageReason` text column in the 0025 migration during P1, so P1 must include it). Emit `NOTE_DISMISSED`. 
- **Authz (explicit):** dismiss requires the note's **author OR a human** — an arbitrary agent must not bury another agent's signal. A human director may dismiss anything.
- `routes/notes.ts`: `POST /api/v1/notes/{id}/dismiss` (body {reason}) → 200 / 403 / 404 / 409. `EVENT_NAMES.NOTE_DISMISSED` + `eventToAction` mapping.
- **Verify:** service unit (dismiss open note; 409 on already-triaged; authz: author ok, other-agent 403, human ok); route contract. `pnpm --filter @pm/server test`.

### P3 — Promote-to-proposal + provenance (the canonical AI path)
- `note.service.ts`: `promoteToProposal(id, actor, {title?, description?})` — guard open; create a proposal (reuse proposal.service.create) carrying `sourceNoteId = note.id`; set note status `triaged`, triageOutcome `promoted`, promotedProposalId, triagedAt/triagedBy. Emit `NOTE_PROMOTED`. AI-reachable (it only mints a proposal — the human-owned artifact agents already create).
- `routes/notes.ts`: `POST /api/v1/notes/{id}/promote-to-proposal` (body {title?, description?}) → 200 (returns the note + created proposal id) / 404 / 409.
- **Verify:** service unit (promote open note → proposal exists with sourceNoteId, note has promotedProposalId + triaged(promoted); 409 on triaged); provenance round-trip; route contract.

### P4 — Promote-to-task (human-gated) + the structural invariant
- `note.service.ts`: `promoteToTask(id, actor, {...})` — **HUMAN role only** (`actor.type === "human"`, else 403); create a task carrying `sourceNoteId`; set note triaged(promoted)/promotedTaskId/triagedBy.
- `routes/notes.ts`: `POST /api/v1/notes/{id}/promote-to-task` → 200 / 403 / 404 / 409.
- **The structural invariant (load-bearing):** encode that the ONLY paths setting `sourceNoteId` on a proposal/task are the two promotion endpoints, and promote-to-task is human-gated. Add a dedicated **invariant test**: no AI-reachable path produces a task/epic with a `sourceNoteId`. Keep it green from here on.
- **Verify:** service unit (human promote-to-task ok → task with sourceNoteId; AI promote-to-task → 403); **the invariant test**; route contract.

### P5 — Backlog-age alert (anti-junk-drawer seal)
- `schema.ts` + migration **0026**: `notes_alert_state` latch table (one row/project, mirrors `claims_alert_state` exactly — id, projectId, a `backlogNotified` boolean, timestamps). Journal entry idx 26. Add `"notes_alert_state"` to `schema.test.ts` expected-table list.
- `notes-health.service.ts` (clone `claims-health.service.ts`): `computeNotesHealth(projectId)` → {openCount, oldestUntriagedAgeMs}; fire `NOTE_BACKLOG_ALERT` edge-triggered (rising edge when oldest-untriaged age > threshold AND openCount>0; re-arm on drain) latched on `notes_alert_state`. Aggregate-only payload. Threshold default 7 days (operator-tunable via project settings — follow the existing settings pattern; if a settings field is added, keep it optional/defaulted).
- `alerts-listener.ts`: a `NOTE_BACKLOG_ALERT` `formatAlert` branch (Discord), guarded (NOTE-2). SSE via `onAll`.
- REST `GET /api/v1/projects/{id}/notes/health` → the aggregate, fires the alert as a side effect (the `computeClaimsHealth` pattern).
- **Verify:** edge-trigger unit (fires once, re-arms on drain — clone `claims-alerts.test.ts`); non-fatal emission (Discord/settings throw never breaks the read); health REST contract. `pnpm --filter @pm/server test`.

### P6 — MCP triage tools
- MCP: `pm_dismiss_note` (note_id, reason), `pm_promote_note_to_proposal` (note_id, optional title/description) — promote-to-task is **NOT** exposed to MCP (human-only). + api-client wrappers + register in tools index.
- **Verify:** MCP tool render tests (dismiss + promote-to-proposal); `pnpm --filter @urtela/pm-mcp-server test`. Then full `pnpm test`.

---

## Completion criteria

- All 6 phases complete, each committed (one logical commit per phase).
- `pnpm build`, `pnpm typecheck`, `pnpm lint` (0 errors) pass.
- `pnpm test` green (existing suite + new triage/alert tests).
- Working tree committed on `campaign-c2-notes-triage`.

## Cross-phase invariants

- **The proposal gate:** no AI-reachable path creates an epic/task carrying `sourceNoteId` from a note. Promote-to-proposal is the only AI promotion; promote-to-task is human-gated. (Invariant test in P4, green from P4 onward.)
- Existing suite + C1 note capture/search stay green at every phase.
- Triaged notes are immutable (terminal-state guards).
- Alert emission + Discord are fire-and-forget, fully guarded (never 500 a read).
- Deletion graceful: promoted-target deletion (ON DELETE SET NULL) renders "(promoted target removed)" downstream; reciprocal `sourceNoteId` reconstructs the link.
