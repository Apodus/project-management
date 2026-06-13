# Campaign C3 — Claims operations web surface

**Date:** 2026-06-10
**Vision:** `roadmaps/vision-20260610-repo-quality-consolidation.md` §C3 (authoritative — read it)
**Tier:** A (user-visible) · **PM task:** `01KTQS712HZGS40FXF1FF19YPR`
**Goal:** humans can see every claim's liveness in one place and act on it — the shipped release-to/request-takeover primitives get their missing web surface.
**Branch:** `campaign-c3-claims-surface` off post-C1 main, dedicated worktree `D:\code\pm-c3-claims-ui`.

## Scope (verified findings; full detail in vision §C3)

1. **Claims panel** (`/projects/{id}/claims`, own route — commander resolved open question #3): all claimed tasks/epics/proposals with claim_state (live/stale/yours), holder, age. Holder names come from entity `assigneeId`/`claimedBy` (the human-facing pointer) — NEVER from the lease layer; claim_state payloads stay holder-masked (cardinal invariant). Build from existing list endpoints + claim_state filters; a thin aggregate endpoint only if composition proves too chatty (planner judgment, justify either way).
2. **Handoff actions:** release-to (worker picker — reuse the existing admin users listing) and request-takeover buttons wired to the existing REST endpoints (`POST .../{tasks|epics|proposals}/{id}/release-to`, `/request-takeover`), stomp-safety semantics surfaced in UI copy (live → notify-holder + `notified_holder` result; stale → auto-grant).
3. **Actionable stale toast:** the `claim.stale_alert` SSE toast (use-sse.ts ~92-97) gains a "View claims →" action navigating to the panel.
4. **Claim badge parity:** ClaimStateBadge on task-list-page and task-detail-page (component exists — used on board/epic-list/epic-detail/roadmap).
5. **Epic picker** in promote-to-task dialog (notes-page.tsx ~397-405): combobox over useEpics replaces the raw epic-ID text input.
6. **Slot-ins:** project-scoped invalidation keys in use-notes.ts (promote mutations currently invalidate proposal/task lists across ALL projects); route-level code-splitting (TanStack lazy routes) to retire the 1.2MB single-chunk vite warning — verify each lazy route renders standalone.

## Tests (gate)

Component tests: claims panel states (live/stale/yours/empty), both handoff dialogs, badge renders on task list/detail. E2E: claim → stale (injected) → takeover auto-grant flow following the existing E2E idiom — NOTE: e2e specs 02-06 are order-dependent (only 01 creates the admin; per-run DB path); a new spec must fit that chain or be self-contained the way the suite expects. Build emits >1 JS chunk (code-split smoke). Full gate green at every commit.

## Do-not-touch / coordination

C4 depends on this campaign (shared notes-page.tsx + use-notes.ts) — keep those edits tight and well-factored. Do not touch note.service.ts, migrations/meta/, openapi-drift test. If a new REST endpoint is added (aggregate claims), openapi.json MUST be regenerated in the same commit (the drift-guard test enforces this — `pnpm --filter @pm/server openapi:export`).

## Phases (P1–P7 per the approved plan, WITH the verifier's REVISE amendment — adopted)

The Plan leg's 7-phase plan was adversarially verified (all payload/masking/e2e-mechanics claims confirmed against code). Execute as planned PLUS:

1. **P1 amendment (the REVISE item):** the panel payload MUST include the spec'd **age** — nullable `claimedAt` per row, sourced from the lease layer (`claim_leases.claimedAt`; all claim flows acquire leases incl. humans; null only for legacy pre-C2 claims → render "—"). Not an identity leak (timestamp, no holder id). Ship it in P1's schema + regen so no second regen cycle is needed.
2. **Advisories (binding):** do NOT assert stale *counts* in e2e 07 (claims-health grace is pinned to the 24h default and diverges from the env-tuned row staleness — C2 fixes that divergence separately; coordinate at merge); `maybeShowToast` export is sanctioned; both C2 and C3 regen openapi.json/api-types — at rebase time resolve by RE-RUNNING the regen, never hand-merging.
3. **Gate cadence:** `pnpm typecheck/lint/test/build` at every commit; full `pnpm test:e2e` at P7 and at campaign close (×2 for stability proof) — NOT at every commit (e2e only changes in P6/P7; per-commit e2e is wasted wall-clock on a shared machine).

Verifier-confirmed facts: Task/Epic/Proposal all carry claimState on the wire (incl. task detail); no claim_state list filters exist (aggregate endpoint justified, sanctioned by spec); holder names for epics/proposals are new-on-the-wire but sit on the Task.assigneeName precedent (claimed_by/assignee_id raw ids are ALREADY exposed to all authed callers); stale_alert frame entity_id IS the projectId; TanStack v5 object-key partial matching makes listsFor(projectId) work as planned (keys ARE object-shaped); lazyRouteComponent with typed exportName exists in installed 1.170.8; pages are imported only in router.tsx; PATCH assigneeId acquires the lease AS the assignee (task.service.ts:667-673) so stale injection works; specs 01-06 contain zero claim calls (1s TTL cannot perturb them); requestTakeover has no lease-mode gate (auto-grant works in shadow mode — no PM_LEASE_MODE change needed).
