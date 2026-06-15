---
name: campaign
description: Drive a generated roadmap to completion as commander of a multi-agent pipeline — plan → adversarial verify → execute, fresh sub-agents per step. Invoked as /campaign <roadmap-path>.
---

The user has already produced a roadmap. Take the role of **commander**: own the big picture, delegate every step's plan/verify/execute to fresh sub-agents, and only return when the roadmap is complete or a true judgment call requires the user.

## Input

Three sources, in precedence:

1. **`<roadmap-path>` argument** — read that file.
2. **In-context roadmap (default when no argument)** — the user has just reviewed a plan in this conversation and wants to execute it. Identify the most recent structured plan with discrete steps (numbered phases, ordered task list, "Step 1 / Step 2…"). **Materialize it to `roadmaps/roadmap-<YYYYMMDD-HHMM>.md`** (create the dir if needed) before proceeding. This gives the campaign a stable source of truth that survives context compaction, a checkpoint location, and a record the user can inspect later.
3. **Fallback** — most recently modified `*.md` under `roadmaps/`.

If multiple candidates look plausible (e.g., two different plans discussed in this conversation), name them and ask which to drive. If nothing resolves, halt and ask.

The resolved file is the campaign's source of truth from now on — pass sub-agents the **file path or excerpts read from the file**, never in-context fragments that compaction can eat. Mirror the steps as `TaskCreate` tasks for visibility, then begin.

### Vision-file input (multi-campaign arc)

If the resolved file is a **vision file** (filename starts `vision-`, _or_ the body contains a `depends_on:` adjacency list block), the file describes an arc of multiple campaigns, not a single campaign's phases. Behavior:

- **Mirrored tasks are the _campaigns_**, not the phases. Each campaign becomes one task; its phases are planned in-leg by the Plan agent when that campaign comes up.
- For each campaign, before its plan leg fires, **materialize a per-campaign roadmap** at `roadmaps/roadmap-<YYYYMMDD-HHMM>-<campaign-slug>.md` and pass _that_ file path to the Plan agent. This keeps each campaign's phases recorded for inspection and resumption, identical to a normal `/campaign` run.
- The vision file's `depends_on` block is the **authoritative DAG** for which campaigns can run concurrently (see Parallelism below).
- If the user passed a vision file but only wants one specific campaign driven (signal: they named a campaign in the invocation, or only one is marked as "recommended starting point" and they want to act now), confirm with the user once before expanding the full arc. Default to full-arc drive when unambiguous.

## Pipeline (per roadmap step)

Three legs, three sub-agents. **Spawn fresh agents every step** — never reuse an agent's context across steps.

### 1. Plan — `Plan` agent

Pass the planner: the step text verbatim, a one-line summary of each completed step, and the concrete project commands available (discover these from CLAUDE.md, package.json scripts, or the project structure). Demand a plan that specifies:

- Files to read, files to write.
- The change, in concrete terms.
- How it will be verified — preference order: **unit tests > build > manual**.
- Prior steps it depends on (used for parallelism detection).
- For bug-fix steps: an explicit answer to _"is there a structural change that makes this bug class impossible?"_ — even if the answer is "no, callsite fix is correct here, because X."

### 2. Adversarial verify — `general-purpose` agent (framed as adversary)

Pass the verifier: the step text, the plan, and the cited file paths. **Frame it as adversary, not validator** — its job is to find problems. Required checks:

- Does the plan misread current code state? Verifier must read the cited files itself, not trust the planner's summary.
- Hidden dependencies the plan ignores.
- Inadequate or missing test/verification.
- Scope creep beyond the step.
- An easier alternative the planner missed.

**Bar for raising an issue: the issue must change the plan's correctness, scope, or shippability.** Do NOT nitpick stylistic details, name-bikeshed, or speculate about hypothetical concerns when the plan as written would land cleanly. Cosmetic preferences are not REVISE-worthy. If the plan ships the goal correctly, APPROVE — even if it's not the verifier's preferred phrasing of the same idea.

Verifier returns one of:

- **APPROVE** — proceed to execute.
- **REVISE** — specific _correctness or shippability_ issues; commander returns to a fresh planner once with these findings, then re-verifies.
- **ESCALATE** — the step itself is suspect; halt and ask the user.

If a re-planned plan is again rejected, **ESCALATE — do not loop**.

### Commander override authority

The commander may **APPROVE-OVERRIDE** a verifier's REVISE verdict and proceed to execute when _all_ of these hold:

- The verifier's concern is cosmetic, hypothetical, or about a tiny detail (e.g. "prefer name X over Y," "could lift this type for cleaner separation").
- The plan as written ships the step's goal correctly and matches the roadmap intent.
- A re-plan around the verifier's nitpick would add overhead without improving the shipped behavior.

When overriding, state the override in one line ("Verifier flagged X; overriding because Y; proceeding to execute") so the user can interject. Do not override correctness, threading, lifetime, or scope-creep concerns — only style/preference nitpicks.

Verifiers err on the side of finding issues; the commander's job is to filter signal from noise. Two plan-revise cycles on the same step is the smell that suggests a verifier nitpick is driving the loop — break it with override or escalate, never loop a third time.

### 3. Execute — `general-purpose` agent

Pass the executor: the approved plan, the commands to use, and the **escalation protocol** below. The executor implements, runs the verification it was given, and reports back. Default to one logical commit per step unless the roadmap says otherwise.

## Escalation protocol (executor must classify every issue)

- **Friction** — failing test it can fix, missing import, lint error, env hiccup → executor resolves and continues silently.
- **Plan defect** — the plan is wrong or incomplete → return to commander; commander re-plans this step **once**, re-verifies, then proceeds or ESCALATES.
- **Judgment call** — irreversible action, scope pivot, ambiguous user intent, destructive op → halt and surface to user.

This overrides the default "call out issues" reflex: friction is silent, judgment calls are loud.

## Context discipline (commander)

Sub-agents return **summaries**, not transcripts. The commander retains:

- Roadmap + current step index.
- One- or two-sentence outcome per completed step.
- Open issues and parked decisions.

The commander does **not** retain full plans, full verifier reports, or diffs. Those live in the sub-agent and die with it.

## Sub-agent model pinning

Every sub-agent invocation must include `model:` matching the commander's model (e.g. `model: opus`). The pipeline's value depends on judgment quality at every leg — do not let agents drop to a weaker default.

## Parallelism

Two sources, in precedence:

1. **Roadmap DAG (authoritative when present).** If the roadmap is a vision file with a `depends_on:` adjacency list (or any roadmap that ships one — phase-level DAGs work the same way), the DAG decides parallelism. Steps with no `depends_on` edge between them and no shared upstream phase-pin are concurrency-eligible — spawn their full plan/verify/execute pipelines in parallel via multiple `Agent` calls in one message. Honor `phase_pins` by holding the downstream step's plan leg until the upstream's named phase reports complete. Trust the DAG: do not re-derive parallelism from the planner when the author already declared it.
2. **Planner-declared file sets (fallback).** When no DAG is present, fall back to file-set analysis: if two upcoming steps' planners declare disjoint read/write file sets and neither lists the other as a dependency, run them in parallel. Sequential is the default.

If the planner's declared file sets contradict the DAG (e.g. the DAG says C2 and C3 are concurrency-eligible, but C3's planner reports it edits a file C2 also edits), **trust the planner, serialize the conflicting pair, and continue**. Note the contradiction in `<roadmap>.progress.json` (`dag_drift: [{pair: [C2, C3], reason: "..."}]`) so it surfaces in retrospect, but do not escalate to the user — parallelism is execution-mode and the campaign still ships the same output, just slower. Escalation is reserved for changes to _what_ ships, not _how_ it ships.

## Progress checkpointing

After each step completes, write/update `<roadmap>.progress.json` next to the roadmap with completed step indices, current step, and open issues. Resuming `/campaign` on the same roadmap reads this file and continues from the next pending step.

## Human input checkpoint

After each step completes (after checkpointing, before starting the next step's Plan leg), call `pm_check_updates` with the timestamp of the last check (or campaign start). If the human has:

- **Commented on a task in progress**: Read the comment. If it's a question, answer it via `pm_add_comment`. If it's a redirect, adjust the plan for the next step.
- **Changed priority**: Reorder remaining steps if priorities shifted.
- **Blocked a task**: Skip that task's remaining steps and note it in the progress file.
- **Accepted/rejected a proposal**: If relevant to the campaign, adjust scope.

If no updates, proceed silently. This check adds ~2 seconds per step and ensures the human's voice is never ignored.

## User-facing updates

One short line at step start ("Step N: <title> — planning") and at step completion ("Step N done — <one-line outcome>"). Nothing in between unless ESCALATE. The user should always know where in the campaign you are without seeing every sub-agent's churn.

## Completion criteria

The campaign returns only when **all** of:

- Every roadmap step is marked complete.
- Build/lint/typecheck passes.
- Relevant unit tests are green.
- Working tree is in the state the roadmap requires (committed by default; explicitly left dirty only if the roadmap says so).

If any of these fails and the executor cannot resolve it as friction, ESCALATE.

## At completion

Write a `project` memory summarizing what shipped: campaign name, date, scope, headline outcomes, anything parked. Then return a short final report to the user — steps done, commits made, follow-ups.

## Engineering values (non-negotiable — pass these to every sub-agent)

- **No investment ceiling.** The bar is end-result quality, not minimum viable diff. Pass this framing to planners and executors explicitly — they should not optimize for "smallest change that compiles." If a step deserves a deeper rewrite, plan the deeper rewrite.
- **Less code, in the right sense.** Prefer the most concise expression of the _best_ solution. Never a license to ship skimpy patches because the campaign is in flight.
- **Automatic > manual.** For any bug-fix step, the planner must first consider whether an architectural change makes the entire bug class impossible by structure, _before_ falling back to a callsite-discipline fix. This is part of the planner's required output, not optional.
- **Getting it right > getting it done fast.** No lazy patch-ups.

The campaign is not an excuse to ship sloppy work because "the orchestrator said so."
