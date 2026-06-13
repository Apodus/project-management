# Campaign C4 — Notes truth layer (anchor enrichment + server-side search)

**Date:** 2026-06-10
**Vision:** `roadmaps/vision-20260610-repo-quality-consolidation.md` §C4 (authoritative — read it)
**Tier:** B · **PM task:** `01KTQS78410Z9XYK93MZG5XYA3`
**Goal:** every anchor and promoted-target on a note renders truthfully ({exists, title} from the server — "(removed)" when gone), and inbox + command-palette search use the server FTS that already exists.
**Branch:** `campaign-c4-notes-truth` off main @ 733aa83 (post-C3), dedicated worktree `D:\code\pm-c4-notes-truth`.

## Post-C3 state of the surface (read it fresh — C3 just landed)

- notes-page.tsx now has the epic picker inside PromoteToTaskDialog (Radix Select over useEpics, `__none__` sentinel) — do not regress it.
- use-notes.ts promote mutations use project-scoped `listsFor(projectId)` invalidation keys.
- Routes are lazy (`lazyRouteComponent`); the notes page is one of the split chunks.
- e2e: per-run DB path; lease env injection (TTL/grace=1s) in playwright webServer; specs self-contained except the documented 01 ordering role; spec 06 covers the notes inbox.

## Scope (vision §C4 — the parked bundle from roadmap-20260610-notes-followups-hardening, adopted on its own named trigger)

1. **Anchor enrichment:** `enrichNotes()` in note.service `list`/`getById` (mirror the `enrichActivityEntries` precedent — batched `inArray` per entity type) adding `anchor: {exists, title}` and `promotedTarget: {exists, title}` to note payloads; route schema update + `openapi:export` + web `generate:api` regen in the SAME commit (the drift-guard enforces byte-equality).
2. **Web truth rendering:** drop the three 50-cap client entity maps in notes-page; render anchor/promoted-target titles from the enriched payload; a missing target renders a truthful "(removed)" (with whatever dismiss-vs-keep affordance that implies — keep it minimal and honest).
3. **Server-side search wiring:** generic `search()` wrapper in web `api.ts` over `GET /search` (FTS5 exists server-side, `entity_type=note` filter works); hybrid inbox — structured filters via the existing list endpoint, free-text via search; the command palette adopts the same wrapper (it is currently client-side).
4. **Search-hit hydration (open question #4, commander-delegated):** search returns `{entityId, title, excerpt, rank}`, not full Note rows — pick the hydration strategy (ids-filter list call vs batched gets) by measuring on a seeded ~500-note project; choose the simpler one that's fast enough; record the measurement in the report.
5. **Commander-approved slot-in:** fix the pre-existing e2e spec-01 strict-mode race ("Projects" heading vs "No projects yet" substring match — documented in roadmap-20260603-c3prime progress records; fails isolated too). It is the last known flake in the suite and blocks ever flipping the CI e2e job to required. Root-cause fix in the spec/helpers, no sleeps, no retries-masking.

## Constraints

- `findSimilarOpenNotes` dedup internals: do not change semantics (C2 adds a warn-log line in the catch — if you rebase over it, preserve it). The dedup `similar` response shape must not change.
- Keep the enrichment additive on the wire (new optional fields) — MCP note tools and existing web code must keep working mid-rollout.
- C2 (in flight) also regenerates openapi.json on its branch; at rebase time resolve by RE-RUNNING the regen, never hand-merging.
- Migrations: allowed if genuinely needed (db:generate works), but none is expected — the `(anchor_type, anchor_id)` index already exists.

## Tests (gate)

Service tests: enrichment (existing/missing/mixed anchors, promoted targets, batching — no N+1); route schema; drift-guard green after regen. Web: "(removed)" rendering, hybrid search behavior (filter+freetext compose), palette parity. e2e: spec 06 must stay green (it exercises the inbox this campaign rebuilds); the 01 fix proven by running 01 isolated ×5 + full suite. Full gate (typecheck/lint/test/build) at every commit; full e2e at campaign close ×2.

## Phases (P1–P7 per the approved plan — verifier verdict APPROVE)

P1 spec-01 exact:true fix (root cause: substring heading match vs the post-load empty-state "No projects yet" h3) → P2 enrichNotes() + shared/route schemas + regen (drift-guard exercise) → P3 web truth rendering (retire maps, "(removed)" on positive evidence only) → P4 search() wrapper + hybrid AND-model inbox + 500-note measurement → P5 command palette on FTS (tasks/proposals/notes parity) → P6 (optional) MCP presence-guarded anchor renders → P7 spec-06 positive load-gating + campaign seal (full e2e ×2).

**Binding executor notes from the verifier:**
- The "dangling promoted target" test row is unreachable via normal writes (`promotedTaskId`/`promotedProposalId` are real FKs with `onDelete: "set null"`, `PRAGMA foreign_keys=ON`): forge it with `pragma foreign_keys=OFF` in the test, or drop that row as unreachable-by-construction — NEVER weaken the schema to make it representable. Anchors are the real dangling case (no FK, arbitrary strings accepted).
- The web `search()` wrapper MUST pass `limit=100` explicitly (route default is 20 — otherwise the documented "100-hit cap" is a lie).
- Palette `RecentItem` requires `status` + renders badges; search hits carry neither — decide the recents shape deliberately (storing without badges is fine; nothing asserts it).
- Prepare-count batching test: spy `Database.prototype.prepare` scoped around the `list()` call, count-EQUALITY 5-vs-50; fallback if brittle = drizzle logger callback statement count.
- e2e paths are `tests/e2e/` at repo root. Keep the full-e2e-×2 close gate.
