# Campaign A2 — Land via the verify-gated merge train + escalation post-back

**Parent vision:** `roadmaps/vision-20260613-responder-auto-implement.md` (rev2, trust-first)
**Tier:** S/A. **PM task:** 01KV107AP4SX8WMVTX13K2ABGA. **Depends on:** A1 (the responder produces a verified, pushed `pm/escalation-<id>` branch) + the merge train (Phase 7.x).
**Goal:** The verified branch lands through the merge train (never a direct push — main is structurally unbreakable: the train verifies the rebased tree before fast-forwarding), and the land resolves the escalation back to the origin (auto-noticed via C2). On reject, no proven work is discarded.

## Trust-first stance (every sub-agent)
The merge-train verify gate is the STRUCTURAL FLOOR — a wrong autonomous diff is caught by verify and rejected, never landed; main never breaks regardless of what the agent wrote. We trust the agent + the autonomous land; the train is the floor, not a human gate.

## What A1 shipped (the entry condition)
The responder's implement session (A1 P3): on `branch_ready` it pushes `pm/escalation-<id>` to the remote + posts an `addMessage(pendingLand metadata)` leaving the escalation **acknowledged** (held by the responder). A2 turns "pushed branch" into "submitted merge request → landed → escalation resolved."

## What exists to reuse (read first)
- The merge train: `pm_request_merge` (task-less submit OK — merge_requests.taskId nullable), the integrator rebase→verify-against-tree-SHA→FF-or-reject, `merge_requests.resolvedFrom` (the 7.6 no-recursion precedent + the forward-ref self-FK pattern to mirror for `escalationId`). `packages/server/src/services/merge-request.service.ts` (create/land/reject — land() attaches landed_sha + reject() posts the merge_rejection comment ONLY when taskId != null today → the escalation post-back is a NEW code path). `packages/server/src/db/schema.ts` (merge_requests). The 7.6 conflict resolver (resolver-pool/loop) fires on a rebase conflict.
- The responder: `packages/responder-ref/src/{loop.ts (runImplementSession branch_ready), api-client.ts}` — the branch_ready handling that A2 extends to submit an MR.
- The escalation service: acknowledge/answer/resolve/escalateToHuman/addMessage; the lifecycle; C2 delivery (the origin auto-notices a resolved escalation / a new message).

## Engineering values
No investment ceiling; reuse the merge train + the 7.6 resubmit pattern; additive — C1-C4/notes/the existing merge-train/A1 stay byte-identical; the escalationId post-back is purely additive (a nullable column + a new land/reject branch).

## Verify commands
`pnpm --filter @pm/shared test`, `pnpm --filter @pm/server test`, `pnpm --filter @urtela/pm-responder test`, `pnpm --filter @pm/server openapi:export` + `generate:api` if the MR routes/response change, `pnpm build`, `pnpm typecheck`, `pnpm lint`.

## Phases (each: plan → adversarial verify → execute → commit)

### P1 — escalationId column + the responder submits a merge request
`merge_requests.escalationId` nullable additive column (mirror resolvedFrom's forward-ref self-FK; new migration; honest journal when; bump the schema.test table-column canary if asserted). The responder's `runImplementSession` branch_ready: after the push, SUBMIT a task-less merge request for `pm/escalation-<id>` (via the responder's api-client → POST the merge-request create, with escalationId set + verify_cmd). Reconcile with A1 P3's addMessage(pendingLand): the MR-submit replaces/augments the pendingLand message (e.g. addMessage "submitted merge request <id> for branch X" + the MR carries escalationId) — decide. The escalation stays acknowledged (the train will resolve it on land). Tests: the column migration; the responder submits an escalationId-linked task-less MR on branch_ready; the reclaim still skips pendingLand/submitted escalations.

### P2 — land post-back (land → resolve the escalation + notify the origin)
Extend merge-request `land()`: when the landed MR has `escalationId` (and taskId may be null), post the landed_sha + a summary to the escalation thread (answer/addMessage) AND transition the escalation → resolved (resolvedBy = the responder/system) so the origin auto-notices via C2. (Today land() attaches landed_sha to a TASK; this is the new escalation branch — additive, guarded on escalationId.) Mirror in the integrator land path / the land service. Tests: a landed escalationId-MR → the escalation resolved + landed_sha+summary on the thread + the origin's undelivered cursor surfaces it.

### P3 — reject post-back (reject → escalate to human + preserve the branch)
Extend merge-request `reject()`: when the rejected MR has `escalationId`, transition the escalation → needs_human with the structured reject payload (verify-fail/conflict reason) + the branch preserved (no proven work discarded; a human takes over). (Today reject() posts a merge_rejection comment to a TASK; this is the new escalation branch — additive, guarded on escalationId.) Tests: a rejected escalationId-MR (verify-fail) → escalation needs_human + reject reason + branch ref preserved.

### P4 — resolver composition (trust-first: propagate escalationId) + no-recursion
A responder-authored MR (escalationId != null, resolvedFrom == null) that hits a rebase conflict: the 7.6 conflict resolver MAY auto-reconcile it (trust-first default = PROPAGATE escalationId through the resolution's resubmitted MR so the post-back survives + the loop stays autonomous). DECIDE: propagate escalationId (trust-first) vs escalate-to-human-on-responder-MR-conflict (conservative fallback). Recommend propagate (the user's trust-first stance), with escalate-to-human as a config/fallback. No-recursion: a responder-authored MR (and any escalation its landing spawns) never re-triggers auto-implement (the responder's no-recursion guard + the escalation author/origin checks). Tests: a responder-MR conflict → resolved + escalationId propagated → post-back still fires on land; no-recursion (a responder MR landing doesn't re-enter auto-implement).

### P5 — seal + close
Full-stack seal: assess→implement→submit MR→(train) land→escalation resolved→origin notified closes (extend the C3/responder-seal test or a server integration test; injected runner + a real-or-scripted train land). Reject path seal (verify-fail→needs_human). Docs (CLAUDE.md A2 paragraph / the responder README). Full suite + build/typecheck/lint green; openapi/web regen if the MR surface changed. Commit; campaign-close checkpoint.

## Done when
All 5 phases committed, all unit suites + the seal green, build/typecheck/lint green, the land→resolve and reject→needs_human post-backs work, the resolver composition handles a responder-MR conflict, main never breaks (verify-gated), C1-C4/A1/the existing merge train byte-identical. The full loop closes: a client escalation → autonomous implement → verify-gated land → resolved, no human in the transport. Ships behind auto_implement.enabled=false.
