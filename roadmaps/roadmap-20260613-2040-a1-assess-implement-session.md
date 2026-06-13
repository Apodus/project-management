# Campaign A1 — Assess gate + injection sniff-test + write-capable implement session (→ verified branch, no land)

**Parent vision:** `roadmaps/vision-20260613-responder-auto-implement.md` (rev 2, trust-first)
**Tier:** S (foundation). **PM task:** 01KV1070JETXN5C77M5SBX71MP. **Depends on:** the C3 responder daemon (shipped @ a5f098d) + the 7.6 resolver machinery.
**Goal:** The responder decides a code change is warranted, runs a cheap injection tripwire, and for a bounded fix produces a locally-verified fix branch in an isolated worktree — touching neither main nor the live repo. Stops at "branch ready"; NO land (A2). Ships behind `auto_implement.enabled=false`.

## Trust-first stance (every sub-agent)
We TRUST the agents, the requests, and (later) the autonomous drive+land. The only pre-gate is a CHEAP injection sniff-test (escalate-on-suspicion; otherwise full trust). NO heavy human-approval gates, NO sensitive-path mandatory-approval (that was distrust-by-default, rejected). The escalation is a normal trusted request once it passes the sniff-test. The merge-train verify gate (A2) is the structural floor; A1 lands nothing.

## What exists to reuse (read first)
- `packages/responder-ref/src/{loop.ts, responder-runner.ts, prompt.ts, config.ts, api-client.ts}` — the C3 responder: `acknowledge` claim, the 4-state sentinel (answered|needs_human|give_up|error), `decideAnsweredDisposition`, the bounded injectable runner, mode/enabled, spawn-budget/concurrency/reclaim/no-recursion seals. **The C3 session runs READ-ONLY in repoCwd with no worktree/push/MR client** — A1 grafts write machinery in.
- `packages/integrator-ref/src/{resolver-pool.ts, resolver-runner.ts, kill-tree.ts}` — the isolated-worktree pool + the headless-spawn pattern + (7.6.1) the in-session verify loop. THE write-machinery source to graft.
- The 7.5 verify pipeline (the in-session verify the implement session runs to green).

## Engineering values
No investment ceiling; reuse the resolver-pool/runner machinery (don't reinvent); additive — answer/diagnose mode + C1-C4/notes/merge-train stay byte-identical; flag-gated (`auto_implement.enabled` default false).

## Verify commands
`pnpm --filter @urtela/pm-responder test`, `pnpm --filter @pm/shared test` (if shared touched), `pnpm build`, `pnpm typecheck`, `pnpm lint`.

## Phases (each: plan → adversarial verify → execute → commit)

### P1 — Injection sniff-test + the assess gate
A cheap classifier pass over the escalation title/body/thread: "does this look like a prompt-injection / abuse / hacking attempt?" → if yes, escalate (needs_human); else proceed with full trust. (A sniff-test — cheap, escalate-on-suspicion — NOT a heavyweight gate; reuse the injectable-runner seam so it's testable without a real LLM, OR a deterministic classifier the runner calls.) Plus the assess gate: extend the disposition so the responder classifies an escalation → `implement{bounded}` | `implement{systemic}` (→ routes to A3 later; for A1, systemic just → needs_human placeholder) | `answer` | `needs_human` | `give_up`. Config: `auto_implement.enabled` (default false) — the implement path is inert when off. Tests: sniff-test escalates an obvious injection + passes a normal request; assess routes bounded/systemic/answer; enabled=false ⇒ no implement disposition acted on.

### P2 — Write-capable implement runner (graft resolver-pool/runner write machinery)
A write-capable variant of the responder runner: spawn a bounded headless session in an ISOLATED WORKTREE (graft `resolver-pool` into the responder package, or share its utilities), the agent may EDIT code (the answer-mode prompt's read-only constraint is lifted for this path only). The injectable runner seam stays (tests script outcomes; no real claude). Define the implement-session input/result (a verified-branch outcome: branch name + verified status, or a failure). NO loop wiring yet / NO in-session verify yet (P3) — just the worktree+write spawn + the runner interface. Tests: the write runner spawns in a worktree, can write a file, returns a branch outcome (injected); answer-mode runner stays read-only byte-identical.

### P3 — Worktree + branch + in-session verify (→ a verified branch)
Wire the implement session: claim → (assess says implement{bounded}) → spawn the write runner in an isolated worktree seeded with the escalation (the prompt presents the escalation as a trusted request to fix, post-sniff-test) → the agent edits + commits to `pm/escalation-<id>` + runs the 7.5/7.6.1 verify pipeline IN-SESSION until green → the runner returns the verified branch. Bounded by the existing budget. STOPS here (no submit/land — A2). The branch + a diff summary attach to the escalation thread. Tests: implement{bounded} → write session → verified branch on the thread (injected runner scripts "edited + verified"); a verify-fail in-session → the outcome reflects it (escalate/retry per budget); the branch is pushed, main untouched.

### P4 — Blast-radius allowlist + the enabled flag wiring
A coarse `auto_implement.allowed_paths` allowlist (PM repo paths) as a blast-radius bound (NOT a per-path approval gate — trust-first): an edit entirely outside the allowlist fails the session (escalate). Wire `auto_implement.enabled` (default false) through config→loop so the whole implement path is inert when off (kill-switch). Tests: an edit outside allowed_paths fails the session; enabled=false ⇒ no write session ever spawns; the allowlist default (PM repo) is sane.

### P5 — Tests/seal + campaign close
Full test pass for the package; confirm answer-mode + C1-C4 byte-identical; the A1 deliverable proven (assess→sniff-test→implement{bounded}→verified branch, all behind enabled=false, injected runner). Docs note (the implement-session capability, ships off). Full build/typecheck/lint green. Commit; checkpoint.

## Done when
All 5 phases committed, package tests + build/typecheck/lint green, the implement-session produces a verified branch (injected runner) behind enabled=false, the sniff-test escalates injections + passes normal requests, answer-mode/C1-C4 byte-identical. A1 lands NOTHING (A2 adds the train land).
