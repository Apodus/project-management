# Campaign — Notes follow-ups + tooling hardening

**Date:** 2026-06-10
**Derived from:** the follow-ups flagged at the close of the Notes/Findings Inbox arc (`roadmaps/vision-20260609-notes-findings-inbox.md`, C1–C3 all shipped & merged to main @ bb4052b). Each item below was investigated on 2026-06-10; root causes are pinned, not speculative.
**Scope:** four do-now phases (all small/medium, independent — any order, no DAG edges) + one explicitly parked campaign with trigger conditions.

---

## Investigation summary (what the follow-ups actually are)

| # | Follow-up | Root cause (pinned) | Verdict |
|---|---|---|---|
| 1 | openapi.json silent drift | NO drift guard exists anywhere — no CI test job at all (`.github/workflows/` = gitleaks + release only), no vitest touches the spec. The committed file drifted ~5800 lines stale until C3 P1 regenerated it by accident of needing note types. | **Do now (P1)** — highest leverage, S |
| 2 | `db:generate` blocked | `meta/0006_snapshot.json` is a **byte-identical hand-copy of 0005** (same `id`, same `prevId` → drizzle sees a fork and aborts). Hand-typed sequential-hex ids prove 0004/0005 were also hand-authored. Snapshots **0007–0026 are entirely missing** — hand-authoring has been the workaround since migration 0007, not since the notes arc. | **Do now (P2)** — S |
| 3 | Dedup recall AND-gated | `findSimilarOpenNotes` → `sanitizeFtsQuery` joins quoted tokens with spaces = FTS5 implicit AND. A candidate must contain **every** token of the new note's title+body; recall collapses as notes get longer. | **Do now (P3)** — S |
| 4 | 3 flaky E2E specs | All three are **spec/helper bugs**, not infra noise: (01) `helpers.ts setupAdmin` assumes an obsolete post-setup auto-navigation that the wizard no longer does — passing depends on a stale-`needsSetup` timing window; (02) `Accept` button `not.toBeVisible()` races the load skeleton AND TanStack's stale-cache refetch; (05) `.react-flow__edge` `toBeVisible()` asserted mid-`fitView` animation when the SVG has a degenerate box. Plus the Windows footgun: a zombie server's open handle on `test-e2e.db` survives global-setup's warn-and-continue delete → tests silently run on stale data → cascade. | **Do now (P4)** — M |
| 5 | Inbox search client-side | Server FTS fully built+wired to REST (`GET /search?entity_type=note`); web has NO search wrapper (command palette is also client-side). Client-side is *complete* today (the notes list has no server cap) — just lexically weaker and O(n). | **Park** — trigger below |
| 6 | Dangling-anchor detection | Client maps can never resolve existence (task map caps at 50). The right fix is server-side enrichment of the notes list (`{exists, title}` per anchor/promoted-target), mirroring the `enrichActivityEntries` precedent + the `(anchor_type, anchor_id)` index. | **Park** — bundle with #5 |

---

## Engineering values (non-negotiable)

- Getting it right > getting it done fast. The E2E fixes address root causes — no retries-masking, no sleeps.
- Automatic > manual: P1 makes spec drift structurally impossible to miss; P2 restores generated migrations over hand-authoring discipline.
- Each phase is one logical commit; full suite green at every commit.

## Available commands

```
pnpm --filter @pm/server test / openapi:export / db:generate
pnpm --filter @pm/web test
pnpm test            # full suite
pnpm test:e2e        # Playwright (builds + prod server, ~12 min)
pnpm typecheck / lint / build
```

---

## Phases (independent — no ordering dependencies; listed by leverage)

### P1 — openapi.json drift-guard (S)

- **Add a vitest in `@pm/server`** that does in-memory exactly what `scripts/export-openapi.ts` does — `initializeDatabase({inMemory:true})`, `createApp()`, `app.request("/api/v1/openapi.json")`, serialize with the same `JSON.stringify(spec, null, 2)` formatting — and asserts equality against the committed `packages/server/openapi.json`. Failure message must say: `run pnpm --filter @pm/server openapi:export and commit the result`.
- Read `scripts/export-openapi.ts` first and mirror its serialization EXACTLY (byte-equality is the assertion; any formatting mismatch = false positive).
- Rides the existing `pnpm test` pipeline — no new CI infra (there is no general CI test job today; if one is added later, this test comes free).
- **Verify:** the new test passes against the current committed spec (it was freshly regenerated in C3 P1); mutate a route schema locally → test fails with the actionable message → revert. `pnpm --filter @pm/server test` green.

### P2 — drizzle snapshot baseline rebuild (unblock `db:generate`) (S)

- **The fix (validated):** snapshots are diff-bookkeeping ONLY — runtime `migrate()` reads `_journal.json` + `.sql`, never snapshots. So: delete `meta/0000–0006_snapshot.json`; generate ONE fresh baseline snapshot from the current `schema.ts` (34 tables); keep it as the sole snapshot named `0026_snapshot.json` (matching the latest journal tag) with `prevId` = all-zeros; discard any generated `.sql` (schema already applied via the existing 0000–0026 files); journal untouched.
  - Mechanics for the executor: temporarily empty the journal `entries` (or move the `.sql` files aside) so `db:generate` emits a clean full baseline, then restore. Keep the original `meta/` recoverable via git.
- **Verify (three gates):** (a) `pnpm --filter @pm/server db:generate` → exits 0 with "No schema changes, nothing to migrate" (proves chain healthy + baseline faithful to schema.ts); (b) make a trivial throwaway schema tweak → generate emits a correct single-table `0027_*` diff → revert fully; (c) `pnpm --filter @pm/server test` green (runtime migration path untouched).
- Add a short note to CLAUDE.md's migrations section: migrations are generated again; hand-authoring no longer required.

### P3 — dedup two-pass OR-fallback (S)

- In `note.service.ts findSimilarOpenNotes`: keep the current AND query as pass 1 (high precision). **Only if it returns zero rows**, run pass 2 with OR semantics — tokens joined by ` OR ` (title tokens + a capped subset of body tokens, e.g. first ~10, to avoid low-signal rank on long bodies) — ordered by rank, **capped at top-3**.
- Sanitizer: add an OR mode to `sanitizeFtsQuery` (or a sibling helper in note.service) — do not change the existing AND behavior used by `/search`.
- Invariants preserved: advisory-only (try/catch → `[]`, never blocks a post), open + same-project scope, the existing `similar` response shape (no schema/OpenAPI change).
- **Verify:** unit tests — AND-hit short-circuits (no OR pass); zero AND-hits + a partial-token overlap note → OR surfaces it; cap respected; distinct notes still excluded; empty input → []. Existing dedup tests green. `pnpm --filter @pm/server test`.

### P4 — E2E stabilization (M)

Four sub-fixes, one commit (or two if the infra fix is split):
1. **Spec 01 / `helpers.ts setupAdmin`:** drive the wizard deterministically — after the admin POST settles, click **Skip** (project step → connect) then **Skip** (→ `/projects`), then `waitForURL("**/projects")`. Delete the `waitForTimeout(1_000)` + URL-sniff branch (the stale-`needsSetup` race). The `/setup`-redirect assertion in spec 01 itself is fine once the DB is guaranteed fresh (see 4).
2. **Spec 02:** after `page.reload()`, gate on positive loaded content first (the "Accepted" badge AND a content element, e.g. the proposal description visible), then assert the Accept button via `toHaveCount(0)` — removes both the passes-while-skeleton false-positive and the stale-cache false-negative.
3. **Spec 05:** replace the edge `toBeVisible()` with `toHaveCount(1)` (or `toBeAttached()`), and move it AFTER the node-ordering `.toPass()` block so it runs against a settled `fitView`. Wrap the Today-toggle `toHaveCount(0)` in a `.toPass()` poll.
4. **global-setup hardening (the Windows lock footgun):** unique per-run DB path (e.g. `test-e2e-${Date.now()}.db`) threaded into the `webServer` env, so a zombie server's handle on the old file can't poison the run; clean up old run DBs opportunistically. Fallback if threading proves awkward: retry-loop on delete + **throw** on persistent lock (never warn-and-continue into stale data).
5. **Retries:** no change (CI=2 stays as safety net; local stays 0 — fixes are at the source).
- **Verify:** `pnpm test:e2e` full run — target 20/20 (the 3 fixed specs + the 17 already passing). Run twice if feasible to demonstrate stability. Component/unit suites untouched.

---

## Parked (one future campaign, do together — shared surface)

**"Notes inbox server-side search + anchor enrichment"** — explicitly NOT in this campaign:

- **FTS wiring (gap 5):** generic `search()` wrapper in `api.ts` → hybrid inbox (structured filters via list; free-text via `/search?entity_type=note`), adopt the same wrapper in the command palette. Friction to solve then: search returns `{entityId, title, excerpt, rank}`, not full Note rows — needs a join strategy for the card render.
- **Anchor enrichment (gap 6):** `enrichNotes()` in `note.service.list`/`getById` (mirror `enrichActivityEntries` — batched `inArray` per entity type) adding `anchor: {exists, title}` + `promotedTarget: {exists, title}`; route schema + `openapi:export` regen + web drops its three client maps and can finally render a truthful "(removed)".
- **Why bundled:** both touch `note.service.list` + the route schema + an OpenAPI regen + a notes-page refactor — one campaign amortizes that surface.
- **Trigger:** a project sustaining roughly **>500–1000 notes** (client-side search/fetch cost becomes real), OR anchored-note volume making the 50-cap map-miss visibly wrong, OR the next time the notes list schema is opened for another reason. Note: P1's drift-guard makes the regen step of this future campaign safer.

## Completion criteria

- P1–P4 complete, each committed; `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` green; `pnpm test:e2e` 20/20.
- `db:generate` produces "no changes" on a clean tree (P2's standing proof).
- Working tree clean on a campaign branch; parked campaign documented (this file is the record).
