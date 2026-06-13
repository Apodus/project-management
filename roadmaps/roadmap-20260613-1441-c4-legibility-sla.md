# Campaign C4 — Legibility, safety rails & SLAs

**Parent vision:** `roadmaps/vision-20260613-agent-to-agent-escalation-channel.md`
**Tier:** A. **PM task:** 01KTZXV1QJDYYP0G1YHTVCK2CE. **Depends on:** C1 (escalation entity/lifecycle/SSE) + C3 (the responder, observed/bounded here).
**Goal:** The escalation channel and its autonomous responder are observable, rate-limited, dedup'd, and self-alerting — a human can audit every exchange and is paged when an escalation goes unanswered. This is the gate that makes the `shadow → on` flip responsible.

## What C1-C3 shipped (the surface to observe)
- C1: `escalations` + `escalation_messages`, lifecycle open→acknowledged→answered→resolved (+needs_human), SSE `escalation.*` frames, activity-feed verbs, 8 REST routes (incl. `GET /projects/{id}/escalations` list + filters, `GET /escalations/{id}` thread), `escalation.needs_human`→Discord (C2 P5). authorId/holderId/severity/originRepo/originWorkerKey/createdAt/updatedAt/resolvedAt/resolvedBy on rows.
- C2: delivery cursor (originLastSeenSeq), FTS NOT wired for escalations (notes have `findSimilarOpenNotes` — the dedup precedent to mirror).
- C3: the responder daemon (answer/diagnose), reclaim/spawn-budget/no-recursion seals.

## Patterns to mirror (read first)
- Web: `packages/web/src/pages/notes-page.tsx` (the inbox page + filters), the train dashboard (`/projects/{id}/train`), `packages/web/src/hooks/use-notes.ts` (TanStack Query hooks), the SSE banner/toast idiom, anchored-notes-badge.
- Metrics: the train metrics (`GET .../train/metrics`, on-read p50/p95 etc.) — `packages/server/src/services/metrics.service.ts` / `routes/train.ts`.
- Alerts: `note.backlog_alert` / `claim.stale_alert` / `train.stuck` — edge-triggered, latched (`notes_alert_state` / `claims_alert_state`), re-arm on resolution; `events/alerts-listener.ts` Discord delivery (C2 P5 added escalation.needs_human there).
- Dedup: `note.service.ts findSimilarOpenNotes` (FTS5 MATCH, the advisory dedup precedent) + the notes_fts virtual table setup.
- OpenAPI drift-guard: adding routes mandates `openapi:export` + `generate:api` + commit.

## Engineering values (every sub-agent)
No investment ceiling; reuse the dashboard/metrics/alert/dedup patterns; additive — C1/C2/C3/notes/merge-train byte-identical. Edge-triggered+latched alerts (not per-tick). Dedup is advisory/fail-safe (never breaks a raise).

## Verify commands
`pnpm --filter @pm/shared test`, `pnpm --filter @pm/server test`, `pnpm --filter @pm/web test`, `pnpm build`, `pnpm typecheck`, `pnpm lint`; `openapi:export` + `generate:api` when routes change; `pnpm test:e2e` at the P5 seal.

## Phases (each: plan → adversarial verify → execute → commit)

### P1 — Web dashboard + per-escalation timeline
A `/projects/{id}/escalations` web page (mirror notes-page): list escalations with filters (status/kind/severity/origin), live SSE updates (escalation.* frames), and a per-escalation detail/timeline view (open→ack→messages in seq order→answered/resolved/needs_human, showing authors + the thread). TanStack Query hooks (use-escalations) over the C1 REST. Web component tests. Wire into the web router + nav (a sidebar entry + an inbox-style count badge for open escalations, mirroring the notes Inbox badge). No new server route unless the list/get is insufficient (it should suffice). openapi/web-types only if a server route is added.

### P2 — On-read metrics
A `GET /api/v1/projects/{id}/escalations/metrics` (mirror train/metrics, on-read, no new table): time-to-first-response p50/p95 (open→first non-origin reply / acknowledge), time-to-resolve p50/p95, auto-resolve rate (responder-answered / total), human-escalation rate (needs_human / total), reopen rate (if reopen exists; else omit), responder spawn/budget utilization (if derivable — else defer), open-backlog count + oldest-open age. Computed from the escalations/messages tables on read. A metrics sub-view on the dashboard (P1) surfaces them. Server metrics-computation tests. openapi/web-types regen for the new route.

### P3 — Edge-triggered unanswered-SLA alert
`escalation.sla_breached` — fires once per unanswered episode when an OPEN escalation ages past an SLA threshold (config, e.g. settings or env; default e.g. 1h) AND is unanswered/unacknowledged, latched (a new `escalation_alert_state` table OR reuse the alert-state pattern — mirror notes_alert_state), re-arms on resolution. On-read edge-triggered (no sweep), delivered BOTH in-app (SSE banner/toast — the codebase toast idiom) AND out-of-band Discord (reuse alerts-listener + settings.webhooks.discord_url). Identity-masked aggregate (count + oldest-unanswered age) like the other aggregate alerts. New EVENT_NAME + migration for the latch table. Tests: edge-trigger latch (fires once, re-arms), SSE + Discord delivery.

### P4 — Anti-spam: FTS dedup + rate limit
FTS dedup for escalations (mirror notes `findSimilarOpenNotes` + an `escalations_fts` virtual table + triggers, migration): on raise, find similar OPEN escalations (same project, fuzzy title/body match); if a strong duplicate exists, auto-LINK the new raise to the existing open thread (add the new content as a message on the existing escalation, OR return the existing + a "merged" signal) INSTEAD of opening a new escalation — and this short-circuits a responder spawn (one thread, one responder). Plus a client-side raise rate-limit (per origin_worker_key, e.g. N raises per window → 429 or advisory). Advisory/fail-safe (a dedup failure never breaks a raise). Tests: duplicate raise folds into the open thread (no 2nd escalation, no 2nd responder); rate-limit enforced; dedup fail-safe.

### P5 — C3 seals surfaced + e2e seal + campaign close
Surface the C3 runaway seals as tested/monitored invariants (e.g. the metrics expose responder spawn-rate/concurrency; the dashboard shows responder activity). An e2e/full-stack seal: the dashboard renders escalations + the timeline; an unanswered escalation triggers the SLA alert; a duplicate raise folds. Docs (CLAUDE.md C4 paragraph, the dashboard in the web nav). Full suite + e2e green. Campaign + arc close.

## Done when
All 5 phases committed, build/typecheck/lint green, all unit suites + web tests + the e2e seal green, the dashboard/timeline/metrics/SLA-alert/dedup all working, C1/C2/C3/notes/merge-train byte-identical. The arc is complete: the channel is legible, bounded, dedup'd, and self-alerting — the shadow→on flip is now responsible.
