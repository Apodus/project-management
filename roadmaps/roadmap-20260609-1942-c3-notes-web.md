# Campaign C3 — Web inbox + triage surface + anchored-note badges

**Derived from:** `roadmaps/vision-20260609-notes-findings-inbox.md` (campaign C3)
**Date:** 2026-06-09
**Tier:** A (user-visible)
**Branch:** `campaign-c3-notes-web` (off `main`; C1+C2 now merged to main at 1f284a3)
**PM tracking:** project `project-manager` (01KT1VN1BEMF1KZGBFMGXBY5W1), vision epic 01KTP3Y628M4JQFY7EMZVMZFAJ, C3 task 01KTP3ZCRBDBJFG41Y29RC3MP2

## Goal

Give humans an ergonomic console — an inbox to scan/filter/search notes, one-click triage (promote-to-proposal, promote-to-task [human-only], dismiss-with-reason), the live backlog banner, and badges surfacing anchored notes on the entities they reference. The director is the primary triager, so this is where the proposal-gate decision happens day to day.

## What C1+C2 already shipped (the backend this wires — all on main)

REST (route-local Zod-4 schemas, OpenAPI-registered → consumable via `generate:api`):
- `POST /api/v1/projects/{projectId}/notes` → `{data: note, similar: [{id,title,kind}]}` (201)
- `GET /api/v1/notes/{id}` → `{data: note}`
- `GET /api/v1/projects/{projectId}/notes` (query: status/kind/anchorType/anchorId/severity) → `{data: note[], pagination:{total}}`
- `PATCH /api/v1/notes/{id}` → `{data: note}` (open-only)
- `POST /api/v1/notes/{id}/dismiss` (body {reason}) → `{data: note}` (403 author-or-human / 404 / 409)
- `POST /api/v1/notes/{id}/promote-to-proposal` (body {title?, description?}) → `{data: note, proposal}` (404 / 409)
- `POST /api/v1/notes/{id}/promote-to-task` (body {title?, description?, epicId?}) → `{data: note, task}` (403 non-human / 404 / 409)
- `GET /api/v1/projects/{projectId}/notes/health` → `{data: {open_count, oldest_untriaged_age_ms}}` (fires the backlog alert)

The note shape carries triage read-shape fields: `triagedAt, triagedBy, triageOutcome (promoted|dismissed), triageReason, promotedProposalId, promotedTaskId` (all nullable) + `kind, status (open|triaged), title, body, anchorType (task|epic|proposal|null), anchorId, codeLocator {path,line?,commitSha?}, severity (low|medium|high|null), authorId, createdAt`.

SSE: `note.created`, `note.updated`, `note.dismissed`, `note.promoted`, `note.backlog_alert` all stream via `onAll` (the backlog alert is the identity-masked aggregate {projectId, openCount, oldestUntriagedAgeMs}).

## Engineering values (non-negotiable)

- No investment ceiling — end-result quality over minimum diff.
- Match the existing web conventions EXACTLY (TanStack Router/Query, the page/component patterns, the SSE hook, the banner stack).
- Getting it right > getting it done fast.

## House conventions to honor (confirm by reading)

- Routing: TanStack Router `createRoute` under `appLayoutRoute` in `packages/web/src/router.tsx` (existing: /proposals, /tasks, /board, /epics, /roadmap, /train, /train/audit). Add `/notes`.
- Data: TanStack Query hooks (see existing `use-*` hooks, e.g. `use-train`); the API client in `packages/web/src/lib/api.ts` + generated types `api-types.d.ts` (regen via `pnpm --filter @pm/web generate:api` after the server OpenAPI is exported).
- SSE: `packages/web/src/hooks/use-sse.ts` (the live-update + banner mechanism).
- Banner: `packages/web/src/components/layout/app-layout.tsx` hosts the alert banner stack (stale-claim / train alerts) — the notes backlog banner is one more entry, NOT a new mechanism.
- Component tests: clone the shape of `train-dashboard-page.test.tsx` / `board-page.test.tsx`. E2E: Playwright (`pnpm test:e2e`, builds + starts a prod server).
- Nav: the sidebar / project nav (wherever /proposals, /board, /train links live) gets a Notes/Inbox entry.

## Available commands

```
pnpm --filter @pm/server openapi:export      # regenerate OpenAPI JSON (after C1/C2 routes)
pnpm --filter @pm/web generate:api            # regen web api-types from the OpenAPI spec
pnpm --filter @pm/web test                    # web unit/component tests (vitest)
pnpm --filter @pm/web dev                      # dev server (manual check)
pnpm test                                      # full unit/integration suite
pnpm test:e2e                                  # Playwright E2E (builds + prod server)
pnpm typecheck
pnpm lint
pnpm build
```

Verification preference: **unit/component tests > build > manual**. An E2E happy-path is the seal for the inbox→triage flow.

---

## Phases

### P1 — API types + data hooks
- Regen the OpenAPI spec (`openapi:export`) so the note endpoints are in the spec, then `generate:api` to refresh `api-types.d.ts`. Add `use-notes` TanStack Query hooks: list (with filters), get-by-id, the mutations (create? — capture is agent-side; the web needs at least dismiss / promote-to-proposal / promote-to-task / patch), and the `notes/health` query. Mirror an existing hooks module (e.g. how proposals/tasks hooks are structured — find them). Query-key conventions + invalidation on mutation.
- **Verify:** typecheck (generated types compile + hooks typecheck); a hook unit test if the web package tests hooks; `pnpm --filter @pm/web test`.

### P2 — Inbox page + nav
- Route `/projects/$projectId/notes` under `appLayoutRoute` (router.tsx) → a new `notes-page.tsx` (or `inbox-page.tsx`). List notes with: filter by kind / status / anchorType, an FTS search box (reuse the search API or the list filters), kind chips, severity styling, the triage state (open vs triaged + outcome). Dangling anchors render "(removed)"; a promoted note whose target was deleted renders "(promoted target removed)". Add a sidebar/nav link.
- **Verify:** component/render test (clone train-dashboard-page.test.tsx): renders the list, filters work, empty state. `pnpm --filter @pm/web test`.

### P3 — Triage actions UI
- In the inbox (and/or a note detail view): promote-to-proposal (any user), promote-to-task (rendered + enabled for humans only — gate the control on the current user's type/role, mirroring how the web gates other human-only actions), dismiss-with-reason (a reason prompt/modal). Wire to the C2 endpoints via the P1 mutation hooks; on success, optimistic/refetch update + surface the created proposal/task id (a link). Handle 403 (non-human promote-to-task) + 409 (already triaged) gracefully.
- **Verify:** component tests (each action calls the right mutation; promote-to-task control hidden/disabled for non-human; dismiss requires a reason). `pnpm --filter @pm/web test`.

### P4 — Backlog banner + live SSE updates
- Subscribe the inbox to SSE (`use-sse`) so `note.created/updated/dismissed/promoted` live-update the list. Add the backlog-age banner to the `app-layout` banner stack, driven by the `note.backlog_alert` SSE event (identity-masked aggregate → "N untriaged notes, oldest Xd — triage"). Reuse the existing banner stack component; the notes banner is one more entry.
- **Verify:** SSE update test (a note.* event refreshes the list / banner appears on note.backlog_alert); confirm the banner reuses the stack (no new mechanism). `pnpm --filter @pm/web test`.

### P5 — Anchored-note badges (the defensible trim)
- Badges on task-detail / epic-detail / proposal-detail: "N open findings reference this" linking to the inbox filtered by anchor (anchorType+anchorId). Lazy count via the list endpoint filtered by anchor (the `(anchorType, anchorId)` index makes it a single indexed query). 
- **NOTE (cost honesty from the vision):** the inbox + banner (P2-P4) are load-bearing; **badges are a discoverability nicety, the defensible cut if C3 must shrink.** Ship them, but if a real blocker appears in P5, the commander may defer badges to a follow-up rather than hold the campaign.
- **Verify:** badge-count derivation test on each detail page. Then the E2E seal.

### E2E seal (after P5, or as the campaign's final gate)
- A Playwright happy-path: post a note via API → it appears in the inbox → promote it → the proposal exists with provenance. (Mirrors the existing E2E flows; `pnpm test:e2e`.)

---

## Completion criteria

- All phases complete (P5 badges may be deferred only if a real blocker surfaces — commander notes it), each committed (one logical commit per phase).
- `pnpm build`, `pnpm typecheck`, `pnpm lint` (0 errors) pass.
- `pnpm --filter @pm/web test` green + the full `pnpm test` green; the E2E happy-path green.
- Working tree committed on `campaign-c3-notes-web`.

## Cross-phase invariants

- The proposal gate stays sealed: the web promote-to-task control is human-only (UI gate), and the server already enforces it (403) regardless of UI — the UI gate is ergonomics, the server is the seal.
- Existing web pages/tests stay green; the notes additions are additive.
- The backlog banner reuses the existing app-layout banner stack (no new banner mechanism).
- Identity-masked: the backlog banner shows aggregate only (no holder/author ids), matching the SSE payload.
