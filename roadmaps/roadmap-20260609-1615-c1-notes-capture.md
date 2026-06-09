# Campaign C1 — Notes capture foundation (+ dedup-on-post)

**Derived from:** `roadmaps/vision-20260609-notes-findings-inbox.md` (campaign C1)
**Date:** 2026-06-09
**Tier:** S (foundation)
**PM tracking:** project `project-manager` (01KT1VN1BEMF1KZGBFMGXBY5W1), vision epic 01KTP3Y628M4JQFY7EMZVMZFAJ, C1 task 01KTP3YPNC2F1PP2KWNP2BQHP4

## Confirmed decisions (from user)

- **Entity name:** `note`
- **Kind taxonomy:** `bug | question | idea | tech_debt | wtf | observation`

## Goal

Ship the ownerless `note` entity end-to-end — persistence, anchor model, search, dedup-on-post, and the agent-facing capture path — so an observation is recorded in one cheap call, deduped against open notes, and read back by anyone. C1 alone delivers standalone value: agents post (deduped), humans read via API.

## Engineering values (non-negotiable)

- No investment ceiling — the bar is end-result quality, not minimum diff.
- Less code, in the right sense — concise expression of the *best* solution.
- Automatic > manual — structural correctness over callsite discipline.
- Getting it right > getting it done fast.

## House conventions to honor

- Zod schemas: canonical Zod-3 in `@pm/shared`, route-local Zod-4 mirror (the established split).
- Migrations: Drizzle applies via `meta/_journal.json` (idx + tag), **NOT** by globbing `*.sql`. Every new `.sql` needs a matching journal entry. Latest is `0023_claims_alert_state` (idx 23) → next is **`0024`**.
- Heterogeneous-target anchor idiom: `anchorType`/`anchorId` as nullable text, **not** an FK (mirrors `audit_log.targetType/targetId`, `claim_leases.entityType/entityId`).
- SSE: new events added to `EVENT_NAMES`, auto-forwarded via `onAll`.
- Read-path side effects (alerts, etc.) are fire-and-forget and guarded (the `alerts-listener.ts` NOTE-2 discipline) — none of that lands in C1, but note the discipline for C2.

## Available commands

```
pnpm build                          # turbo build (shared → server → web → mcp-server)
pnpm test                           # all vitest
pnpm --filter @pm/server test       # server tests
pnpm --filter @pm/shared test       # shared tests
pnpm --filter @urtela/pm-mcp-server test
pnpm typecheck
pnpm lint
pnpm --filter @pm/server db:generate   # generate drizzle migration after schema change
pnpm --filter @pm/web generate:api     # regen web api types from OpenAPI (not needed until C3)
pnpm --filter @pm/server openapi:export
```

Verification preference order: **unit tests > build > manual.**

---

## Phases

### P1 — `@pm/shared` schemas + types

- **Adds:** `NOTE_KINDS` (`bug | question | idea | tech_debt | wtf | observation`), `NOTE_STATUSES` (`open | triaged`), `NOTE_ANCHOR_TYPES` (`task | epic | proposal | none`) const tuples + types; the `Note` Zod schema; create/list/patch DTO schemas; a `CodeLocator` schema (`{ path: string, line?: number, commitSha?: string }`). Export from the shared package barrel.
- **Note:** C1 introduces only `open | triaged` for statuses and does NOT add triage-outcome enums (those are C2). Keep the surface minimal to C1.
- **Verify:** `pnpm --filter @pm/shared build` + `pnpm --filter @pm/shared test` (add a small schema test if the package has a test convention; otherwise type-level is fine). Confirm consumers compile.

### P2 — `schema.ts` `notes` table + migration `0024`

- **Adds:** `notes` sqliteTable: `id` (pk), `projectId` (FK projects), `kind`, `status` (default `open`), `title`, `body`, `anchorType` (nullable), `anchorId` (nullable, not FK), `codeLocator` (JSON mode, nullable), `severity` (nullable), `authorId` (FK users), `createdAt`, `updatedAt`. Indexes: `(projectId, status)`, `(anchorType, anchorId)`, `(projectId, kind, status)`.
- **Migration:** hand-author `0024_notes.sql` (or via `db:generate`, then verify) **and** add the `{idx: 24, tag: "0024_notes", ...}` entry to `meta/_journal.json`. Decide title nullability (recommend `title` NOT NULL — a note needs a one-line handle; `body` may be optional, but recommend body NOT NULL too with title as the short summary). Commander note: P1/P2 must agree on which fields are required — planner resolves and states it.
- **Verify:** server boots + migration applies on a fresh in-memory db (the server test harness creates one); `pnpm --filter @pm/server test` green (existing migration/boot tests still pass).

### P3 — `note.service.ts` + `routes/notes.ts` + activity integration

- **Adds:** `note.service.ts` — `create`, `getById`, `list` (filter by `status`/`kind`/`anchorType`+`anchorId`), `update` (patch body/kind/severity/title **while `open`** — a guard rejects patching a non-open note, anticipating C2's triaged-immutability). `routes/notes.ts` (OpenAPIHono): `POST /api/v1/projects/{projectId}/notes`, `GET /api/v1/notes/{id}`, `GET /api/v1/projects/{projectId}/notes`, `PATCH /api/v1/notes/{id}`. Wire into the app router + OpenAPI registration.
- **Activity:** emit `activity_log` rows on create/update (follow the existing service pattern), AND add a `note` branch to `enrichActivityEntries` in `activity.service.ts` (currently switches on `task|epic|proposal|project`) so note entries render with a title in the feed / `pm_check_updates`.
- **Authz:** posting open to any authenticated user (ownerless-to-post is the feature). `authorId` derived from auth context (AI self-attributes; do not accept a spoofed author from the body — mirror the proposals `createdBy` derivation).
- **Verify:** `note.service` unit tests (create/list/each filter/open-only patch guard); REST contract test (envelope shape, 404s); activity enrichment test (a note renders with its title). `pnpm --filter @pm/server test`.

### P4 — FTS5 `notes_fts` + search + dedup-on-post

- **Adds:** `notes_fts` external-content virtual table (title, body) in `fts.ts` + the 3 sync triggers (AFTER INSERT/UPDATE/DELETE) in `fts-triggers.ts`, registered in the FTS bootstrap. A `note` branch in `search.service.ts` (join back to `notes` for id/project) + the `/search` route's entityType union. `findSimilarOpenNotes(projectId, title+body, limit)` in `note.service` (FTS over `status='open'` in-project). The create path returns `similar: [...]` in its response; **advisory, never blocking**; an optional `dedupeAck` field on the create body lets the caller post past similars deliberately (it does not change behavior in C1 beyond being accepted/echoed — there is no block to override, so keep it as a forward-compatible no-op flag OR omit it if the planner judges it premature; planner decides and states rationale).
- **Verify:** FTS round-trip test (post → `/search` finds it; delete → gone); dedup unit (near-duplicate open note surfaces; a distinct note does not; triaged/other-project notes excluded). `pnpm --filter @pm/server test`.

### P5 — SSE events + MCP capture tools

- **Adds:** `EVENT_NAMES.NOTE_CREATED` (`note.created`) + `NOTE_UPDATED` (`note.updated`); emit from `note.service` create/update; confirm `onAll` auto-forwards them to the SSE stream (and the `routes/events.ts` projection handles a `note` entity if it special-cases entity types). MCP: `pm_post_note` (kind, body, title, optional anchorType/anchorId + codeLocator; renders the `similar` list for dedup), `pm_list_notes` (filter project/status/kind/anchor), `pm_get_note` + `api-client.ts` wrappers + register in the MCP tools index.
- **Verify:** SSE emit test (creating a note emits `note.created`); MCP tool tests (`@urtela/pm-mcp-server` test convention — render shape, similar-list rendering). `pnpm --filter @urtela/pm-mcp-server test` + full `pnpm test`.

---

## Completion criteria

- All 5 phases complete, each committed (one logical commit per phase).
- `pnpm build`, `pnpm typecheck`, `pnpm lint` pass.
- `pnpm test` green (existing 1650+ suite + new note tests).
- Working tree committed on a campaign branch.

## Cross-phase invariants

- Existing FTS search (proposals/tasks/comments) unchanged; `notes_fts` additive.
- Existing test suite stays green at every phase commit.
- No triage/promotion surface in C1 (that is C2) — C1 is capture + read + search + dedup only.
- Anchor is a soft reference (no FK, no cascade); a dangling anchor is a non-error (rendering handled in C3).
