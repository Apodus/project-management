# Campaign C1 — Escalation primitive: the bidirectional, directed, durable channel

**Parent vision:** `roadmaps/vision-20260613-agent-to-agent-escalation-channel.md`
**Tier:** S (foundation). **PM task:** 01KTZXTB6E7X84C892THE8E09F.
**Goal:** A client agent can raise a typed, directed, durable issue to the platform
team and exchange a threaded conversation with it — entirely agent-to-agent, no
human in the transport. (Auto-noticing is C2; auto-response is C3.)

## Engineering values (every sub-agent)
No investment ceiling — quality bar, not minimum diff. Less code in the right
sense. Automatic > manual (structural seals over callsite discipline). Reuse the
established patterns; do not invent parallel machinery. Notes/comments/proposals/
tasks/merge-train/claim-engine/SSE stay **byte-identical** — this entity is purely
additive.

## Established patterns to mirror (read these first)
- Schema: `packages/shared/src/schemas/note.ts` (Zod-3 canonical; codeLocator/anchor
  shapes to reuse) + `comment.ts`. Route-local Zod-4 mirror is the established split.
- Service: `packages/server/src/services/note.service.ts` (lifecycle guards, event
  emit, enrichment, authz — `author-or-human` dismiss at ~L334, FTS dedup ~L502).
- Routes: `packages/server/src/routes/notes.ts`, `comments.ts` (OpenAPIHono shape).
- Events: `packages/server/src/events/event-bus.ts` (EVENT_NAMES), `routes/events.ts`
  (additive SSE id projection), `events/listeners.ts` (activity_log mapping).
- MCP tools: `packages/mcp-server/src/tools/notes.ts` + `api-client.ts` (snake↔camel).
- Migrations: `packages/server/src/db/migrations/` (db:generate workflow; honest
  journal `when` per CLAUDE.md). Schema in `packages/server/src/db/schema.ts`.
- Audit: existing append-only `audit_log` (Phase 7.4).

## Verify commands
`pnpm --filter @pm/shared test`, `pnpm --filter @pm/server test`,
`pnpm --filter @urtela/pm-mcp-server test`, `pnpm build`, `pnpm typecheck`,
`pnpm lint`. E2E (`pnpm test:e2e`) only at the P6 seal.

## Phases (each is one pipeline step: plan → adversarial verify → execute → commit)

### P1 — Schema + migration
`escalations` + `escalation_messages` tables in `db/schema.ts`. Escalation:
id, projectId (target), kind (bug_report|question|request|blocked), status
(open|acknowledged|answered|resolved|needs_human), severity (low|medium|high),
title, body(nullable), codeLocator(nullable), anchorType/anchorId(nullable),
originRepo, originWorkerKey, holderId(nullable, PM-side claim), authorId,
createdAt/updatedAt, resolvedAt/resolvedBy(nullable). Message: id, escalationId(FK),
seq (monotonic per-thread int), authorId, body, messageType, metadata(nullable JSON),
createdAt. Generate migration via db:generate; honest journal `when`. Tests: a
migration/schema smoke + sequence-column presence.

### P2 — Service + lifecycle + cross-project authz
`services/escalation.service.ts`: create (open), addMessage (assigns next per-thread
seq atomically), acknowledge, answer, resolve, escalateToHuman, list/get (+ optional
enrichment). State machine: open→acknowledged→answered→resolved, plus →needs_human
from any non-terminal. **Authz matrix:** raise = any authenticated worker targeting
the platform project; reply = origin author | PM holder | human; resolve = origin
author | human (mirror note-dismiss) | PM holder under claim-lease. Emit domain
events. Tests: full state-machine, authz matrix (each role × action), seq
monotonicity under concurrent addMessage, cross-project isolation.

### P3 — REST surface
`routes/escalations.ts` (OpenAPIHono): POST raise, GET list (filters: status/kind/
severity/origin), GET by id (with thread), POST {id}/messages (reply), POST
{id}/acknowledge, POST {id}/answer, POST {id}/resolve, POST {id}/escalate-to-human.
Zod-4 route-local mirror of shared schemas. Wire into app.ts. Tests: route tests per
endpoint incl. authz 403s and 404s. Export OpenAPI (openapi:export) + regen web types
if the web build needs them (web UI is C4 — types only if the drift-guard test fails).

### P4 — MCP tools (both client + PM, symmetric)
`packages/mcp-server/src/tools/escalations.ts` + `api-client.ts` methods:
pm_raise_escalation, pm_reply_escalation, pm_get_escalation, pm_list_escalations,
pm_resolve_escalation, pm_escalate_to_human. Snake_case params → camel wire. Agent-
friendly renders (thread view, lifecycle, origin). Register in mcp-server index.
Tests: tool tests against a stubbed api-client.

### P5 — SSE events + audit
Add escalation.* to EVENT_NAMES (opened/acknowledged/replied/resolved/needs_human).
Additive id projection in `routes/events.ts` (escalation_id/origin_worker_key, the
established pattern). `events/listeners.ts` → activity_log mapping. One append-only
`audit_log` row per message/transition. Tests: event emission per transition, SSE
projection shape, audit row written per action.

### P6 — Docs + e2e seal
`docs/worker-pm-workflow.md` cross-team section (client raises → reads reply → resolve)
+ a new client-facing blurb; CLAUDE.md escalation paragraph. One e2e
(`tests/e2e/`) round-trip: raise → reply → read → resolve. Full `pnpm build` +
`pnpm test` + `pnpm typecheck` + `pnpm lint` green. Commit; campaign-close checkpoint.

## Done when
All 6 phases committed, build/typecheck/lint green, shared+server+mcp unit suites
green, the round-trip e2e green, notes/comments/etc. byte-identical (no regressions).
