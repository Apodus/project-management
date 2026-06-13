# Campaign C2 — Automatic delivery: the client notices replies with zero human prompting

**Parent vision:** `roadmaps/vision-20260613-agent-to-agent-escalation-channel.md`
**Tier:** A. **PM task:** 01KTZXTHXPCMP6RDE28MPXP51R. **Depends on:** C1 (shipped — the escalation entity, thread, MCP/REST/SSE).
**Goal:** An originating agent becomes aware of a reply **without a human prompting it** — including when its worker session has *ended* (the common submit-and-walk-away case). The crux of "how does the agent notice, automatically."

## The honest model (3 surfacing paths; the daemon is the structural one)
A Claude Code worker only reasons during prompt-driven turns with no always-on listener, so **no worker-side mechanism alone can guarantee noticing**. The structural guarantee lives in an always-on out-of-band process (the wake daemon), exactly as the integrator daemon exists because agents aren't listeners. Piggyback + drain are opportunistic fast paths for the already-active worker.

## Key C1 facts this builds on
- Escalation thread messages carry a monotonic per-thread `seq` (UNIQUE(escalation_id, seq)). A "directed reply" to the origin worker = a message authored by someone OTHER than the origin, beyond what the origin has consumed.
- `escalations.originWorkerKey` (+ `originRepo`) is the durable address (C1 stable identity / `PM_WORKER_KEY`). Origin params are explicit in C1; **C2 owns the env-based worker-key sourcing** for the wake daemon and piggyback.
- The MCP server already reads `PM_WORKER_KEY` (`packages/mcp-server/src/index.ts`).
- Discord out-of-band alerts exist (`events/alerts-listener.ts`, `settings.webhooks.discord_url`).
- Headless spawn pattern: `packages/integrator-ref/src/resolver-runner.ts` (claude -p, budget, killTree, injectable runner). The wake daemon reuses this to spawn a CLIENT worker turn.

## Engineering values (every sub-agent)
No investment ceiling; reuse patterns (don't reinvent the daemon/spawn machinery); additive — C1 + notes/merge-train stay byte-identical. The wake daemon is the structural mechanism; piggyback/drain are best-effort fast paths and must be described honestly (NOT "the guarantee").

## Verify commands
`pnpm --filter @pm/shared test`, `pnpm --filter @pm/server test`, `pnpm --filter @urtela/pm-mcp-server test`, the new daemon package's tests, `pnpm build`, `pnpm typecheck`, `pnpm lint`. E2E only if a server round-trip seal fits.

## Phases (each: plan → adversarial verify → execute → commit)

### P1 — Delivery cursor + "undelivered directed replies" query (server + shared)
Model the per-origin read position so the server can answer "for worker key K, which escalations have unread directed replies (messages authored by non-origin, seq beyond K's last-seen)?" Decide cursor representation (recommend: `escalations.originLastSeenSeq` column, advanced when the origin reads/drains; a "directed reply" = max(seq) of non-origin-authored messages > originLastSeenSeq). New service fns: `listUndeliveredForWorker(workerKey, projectId?)` → escalations with unread directed replies + the unread messages; `markDelivered(escalationId, uptoSeq, workerKey)` (advance cursor, only the origin's own key). REST: `GET /api/v1/escalations/undelivered?worker_key=K[&project_id]` + `POST /api/v1/escalations/{id}/mark-delivered`. Migration for the new column. Tests: cursor advance, directed-vs-own-message distinction, isolation by worker key.

### P2 — Wake daemon (the structural mechanism)
A new reference process (mirror `integrator-ref` structure; e.g. `packages/wake-daemon-ref`, bin `pm-wake-daemon`). Config: PM_API_URL + token/pool secret, the worker key(s) to watch (or auto from PM_WORKER_KEY), the worker launch command, poll interval / long-poll, budget. Loop: poll `GET .../undelivered?worker_key=K` (or server long-poll); on an unread directed reply, **spawn a fresh worker turn** (reuse the resolver-runner spawn: claude -p / configurable command, budget, killTree, injectable runner) seeded with the reply + escalation context, then `mark-delivered`. Rate-limit wakes per identity. Injectable spawn seam for tests (no real claude binary). Tests: an injected unread reply triggers a spawn + mark-delivered; none when empty; rate-limit; idempotent (no double-spawn for the same unread set).

### P3 — Piggyback (opportunistic, best-effort, demoted)
An MCP-server response wrapper: on any `pm_*` tool call, if the caller's identity (`PM_WORKER_KEY`) has undelivered directed replies, APPEND a `📬 unread escalation reply(s)` envelope (top-N + "call pm_check_messages for the rest" tail) to the tool result text. Backed by the P1 undelivered query. Explicitly NOT the guarantee (only fires on a tool call in a live turn). Must be additive — a worker with no unread replies / no PM_WORKER_KEY sees byte-identical tool output. Tests: envelope appears iff unread replies exist for the identity; absent → byte-identical; top-N cap.

### P4 — Drain tool (`pm_check_messages`)
A new MCP tool (model on `pm_check_updates`): explicit pull of undelivered directed replies for the caller's `PM_WORKER_KEY`, rendered as a thread-aware list, advancing the cursor (mark-delivered) on read. Tests: returns unread, advances cursor, empty case.

### P5 — Discord needs-human bridge + bundle wiring + docs
Wire `escalation.needs_human` → out-of-band Discord (reuse `alerts-listener` + `settings.webhooks.discord_url`) — the ONLY out-of-band path, and only for human-needed escalations (human for approval, never transport). Ship/doc the wake daemon in the distribute story (reference in this repo; the game_one bundle is a separate repo — document, don't edit). CLAUDE.md + worker-pm-workflow.md C2 updates (auto-notice now exists; how the wake daemon is deployed). E2E/full-stack seal of the delivery round-trip (raise → PM answer → undelivered query returns it → mark-delivered advances). Full suite green.

## Done when
All 5 phases committed, build/typecheck/lint green, all unit suites + the new daemon tests green, the delivery round-trip proven, C1/notes/merge-train byte-identical.
