# @urtela/pm-triager

Reference **triager daemon** for the PM notes inbox. The same machine as the
escalation responder (`@urtela/pm-responder`), pointed at **notes** instead of
escalations: one long-lived process per watched project that polls the project's
**open notes** and (in later phases) assesses each one oldest-first, recording a
**triage decision** in the append-only side-log.

> **Ships OFF.** The daemon is gated by `PM_NOTES_TRIAGE_ENABLED` (the env
> master) composed with each project's `settings.notesTriage.enabled` (DB
> default **false**). With the master unset the daemon RUNS but every project
> resolves OFF until its DB toggle is flipped — so nothing is triaged out of the
> box.

## What it does

The triager polls each watched project's open notes, **assesses** each one in a
bounded headless session, and **executes** the resulting disposition under the
project's rollout mode:

- Polls `GET /api/v1/projects/{id}/notes?status=open` per watched project, per
  tick.
- Resolves effective enablement + mode per project per tick
  (`resolveNotesTriage(masterEnv, project.settings)`); a disabled project is
  skipped, a `getProject` failure **fail-safes OFF**.
- Seeds candidate notes (not self-authored, not the designated triage agent's,
  not already in flight / triaged / shadow-seen) **oldest-first**.
- Runs `decide()` (injection sniff → bounded assessment session) to produce a
  structured `TriageAssessment`, then **executes** it via `executeDecision`:
  - **off** — defensive noop (mode can be off even while the daemon is enabled);
  - **shadow** — records a triage-decision side-log row and **leaves the note
    open** (mutates nothing else);
  - **on** — records the decision **and** performs the action (promote to
    proposal / dismiss / flag needs_human), backlinking any minted proposal.

The **proposal-gate** is preserved: the only task-minting path is
`implementProposal` on a fast_track proposal (note → proposal → breakdown).
There is no direct note → task path.

### Deployment: on-mode dismiss authorization

The dismiss endpoint is authz-gated — only a note's **author** or a **human**
may dismiss. So for **on**-mode dismiss to be authorized, the daemon's
`PM_API_TOKEN` identity **MUST** be set as each watched project's
`settings.notesTriage.triageAgentId`. If it is not, dismiss decisions fail with a
403 and the executor **escalates the note to needs_human** (recording the
disposition truthfully) rather than hot-looping — but the intended dismiss never
lands. The daemon logs a warn-once-per-project on this mismatch at startup of the
affected tick. Promote and flag-needs-human have no authz gate and work
regardless.

## Configuration

| Variable                      | Default                 | Description                                                   |
| ----------------------------- | ----------------------- | ------------------------------------------------------------- |
| `PM_API_URL`                  | `http://localhost:3000` | PM API base URL (or `--pm-url`).                              |
| `PM_API_TOKEN`                | (required)              | PM API token for the triager's ai_agent identity.             |
| `PM_PROJECT_ID`               | (none)                  | Single project to watch (or `--project <id>`, repeatable).    |
| `PM_NOTES_TRIAGE_ENABLED`     | (unset ⇒ master allows) | Env master. Explicit-false ⇒ force OFF for all projects.      |
| `PM_TRIAGE_POLL_INTERVAL_SEC` | `15`                    | Poll interval (or `--poll-interval-sec`).                     |
| `PM_TRIAGE_COMMAND`           | `claude -p`             | Headless assessment command (consumed in P3).                 |
| `PM_TRIAGE_LOGS_DIR`          | `<tmp>/pm-triager-logs` | Directory for status sentinels + logs (outside any git tree). |
| `PM_LOG_LEVEL`                | `info`                  | pino log level (or `--log-level`).                            |

## Run

```bash
PM_API_TOKEN=… PM_PROJECT_ID=… PM_NOTES_TRIAGE_ENABLED=1 pnpm --filter @urtela/pm-triager dev
```
