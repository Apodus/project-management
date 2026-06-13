# Campaign C3 — Headless PM-side responder: auto-react without a human (answer/diagnose)

**Parent vision:** `roadmaps/vision-20260613-agent-to-agent-escalation-channel.md`
**Tier:** A (large/xl). **PM task:** 01KTZXTVNN8K3ZPS6F8D9EBYV3. **Depends on:** C1 (escalation entity/lifecycle/MCP/REST/SSE) + C2 (delivery — its answers reach the client).
**Goal:** A new escalation is triaged, investigated, and ANSWERED (or escalated to a human) automatically by a bounded PM-side agent — closing the loop with no human in the transport.

## Scope boundary (verifier-enforced — DO NOT cross)
**ANSWER/DIAGNOSE ONLY.** The responder may reply with diagnosis + instructions/workarounds, open a proposal for the platform team, or escalate to a human. It does **NOT** author code that lands — auto-implement via the merge train is a PARKED follow-on arc (a different, higher risk class). No code mutation in C3.

## Safety discipline (the whole repo's idiom)
- `responder.enabled` **default false**; `responder.mode: off | shadow | on` **default shadow**.
- **shadow** drafts the reply and routes it to a human for approval (Discord) instead of auto-sending. Discipline: shadow → observe answer quality → on.
- **Permanent human-approval boundary** (NOT just a shadow rung): certain escalation classes ALWAYS route through a human even at `on` — `needs_human`, high-severity, and anything the responder flags low-confidence. `on` removes the human only for routine answerable escalations.
- **Runaway seals:** responder-authored messages NEVER re-trigger a responder (no-recursion; mirror 7.6 resolved_from + MAX_AUTOMATION_DEPTH); one-active-responder-per-escalation (the escalation holderId/acknowledge claim); global concurrency cap + per-window spawn budget; kill-switch (enabled=false).

## Proven machinery to reuse (read first)
- `packages/integrator-ref/src/resolver-runner.ts` — the headless `claude -p` spawn (status sentinel `complete|needs_human|give_up`, time/token budget, SIGTERM→SIGKILL killTree, injectable runner seam) + `resolver-pool.ts` + `reclaim-resolutions.ts` (the stranded-session reclaim sweep).
- `packages/wake-daemon-ref/` (C2 P2, just built) — the most recent daemon: loop, config, injectable WorkerRunner, kill-tree copy, give-up counter, api-client (WakeClient). The responder daemon mirrors THIS structure closely.
- C1 escalation service/REST: `acknowledge` (PM pickup, auto-claims holder), `answer` (acknowledged→answered, optional diagnosis message), `escalateToHuman`, `addMessage`. SSE `escalation.opened`.
- `packages/server/src/events/alerts-listener.ts` (C2 P5) — the Discord bridge (for shadow-mode approval + needs_human).
- `automation.service.ts` MAX_AUTOMATION_DEPTH (the recursion-guard precedent).

## Engineering values (every sub-agent)
No investment ceiling; reuse the daemon/spawn machinery (do not reinvent); additive — C1/C2/notes/merge-train byte-identical. The PM server NEVER spawns Claude / runs git — the responder is daemon-side (the integrator split). Fail-safe: off/shadow/on, bounded, no-recursion, reclaimable, kill-switchable. `main` never at risk (no code lands).

## Verify commands
The new daemon package's tests, `pnpm --filter @pm/server test` (if server config schema touched), `pnpm --filter @pm/shared test`, `pnpm build`, `pnpm typecheck`, `pnpm lint`. E2E/full-stack seal at P6.

## Phases (each: plan → adversarial verify → execute → commit)

### P1 — Daemon skeleton + escalation pickup queue/claim
New PM-side daemon package (mirror wake-daemon-ref / integrator-ref; e.g. `packages/responder-ref`, bin `pm-responder`). Config: PM_API_URL + ai_agent token, responder.enabled (default false), responder.mode (off|shadow|on, default shadow), concurrency cap, per-window spawn budget, time/token budget, poll interval. The loop: discover open escalations needing a response (poll `pm_list_escalations`/REST for status=open, OR subscribe escalation.opened) and CLAIM one via `acknowledge` (the holder = the responder; one-active-responder-per-escalation is the acknowledge gate from C1). NO spawn yet (P2). Skeleton + config + claim + tests (injectable everything). enabled=false → inert (kill-switch).

### P2 — Responder-runner (reuse) — the bounded headless claude in the PM repo
The injectable `ResponderRunner` (transplant resolver-runner: `claude -p` / configurable command, status sentinel `answered|needs_human|give_up`, time/token budget, killTree, log). Spawned IN THE PM REPO (cwd = the PM repo checkout) so the agent can investigate the codebase. Seeds a prompt with the escalation + thread. Returns the agent's declared outcome via the sentinel. Injectable seam for tests (no real claude). NO wiring into the loop's outcome handling yet (P3) — just the runner + tests.

### P3 — Answer outcome
Wire the loop: claimed escalation → spawn ResponderRunner → on `answered` (sentinel), the responder posts the answer via `answer`/`addMessage` (the diagnosis the agent produced — read from the sentinel/a result file), transitioning acknowledged→answered. The answer reaches the client via C2 delivery. Tests: injected `answered` → escalation answered + the answer message posted; the C1→C2 loop closes (an answer becomes an undelivered directed reply for the origin).

### P4 — needs_human / give_up + escalate
On sentinel `needs_human` (the agent decided a human is needed) → `escalateToHuman` (→ Discord via C2 P5 bridge). On `give_up` / timeout / spawn_error → escalateToHuman with the reason (no proven work discarded; a human takes over). Tests: each outcome → the right transition + Discord path.

### P5 — Shadow mode + the permanent human-approval boundary
`mode: shadow` → the responder DRAFTS the answer but does NOT auto-send; instead routes the draft to a human for approval (Discord notify with the draft; the escalation stays acknowledged or a pending-approval marker). `mode: on` → auto-sends routine answers. **Permanent boundary (even at `on`):** needs_human / high-severity / low-confidence-flagged → always human approval, never auto-sent. Tests: shadow drafts-not-sends; on auto-sends routine; on STILL routes high-severity/needs_human to human.

### P6 — No-recursion + reclaim seals + e2e seal + campaign close
No-recursion: the responder NEVER picks up an escalation authored by a responder/PM-side identity (only client-origin escalations) + a depth/marker guard (mirror resolved_from + MAX_AUTOMATION_DEPTH); a responder's own answer never triggers another responder. Reclaim sweep: an escalation stranded `acknowledged` by a dead responder past `claimed_at + budget + grace` is reclaimed (re-opened for another responder or escalated) — mirror reclaim-resolutions. Concurrency cap + spawn-rate budget enforced/tested. E2E/full-stack seal: client raises → responder (injected/fake runner in the seal, OR a scripted real flow) acknowledges + answers → the answer is delivered. Docs (CLAUDE.md C3 paragraph, integrator-deployment responder section, worker-pm note). Full suite green. SHIP IN SHADOW (enabled=false by default; operator flips).

## Done when
All 6 phases committed, build/typecheck/lint green, all unit suites + the new daemon tests green, the answer loop proven end-to-end, the safety seals (shadow default, approval boundary, no-recursion, reclaim, concurrency/budget, kill-switch) tested, C1/C2/notes/merge-train byte-identical. Ships OFF by default (shadow when enabled).
