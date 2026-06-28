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

## What this phase (T2·P2) does

This is the **scaffold**: config + api-client + the poll/seed loop wired
end-to-end **except** the assessment brain (P3) and decision execution (P4).

- Polls `GET /api/v1/projects/{id}/notes?status=open` per watched project, per
  tick.
- Resolves effective enablement per project per tick
  (`resolveNotesTriage(masterEnv, project.settings)`); a disabled project is
  skipped, a `getProject` failure **fail-safes OFF**.
- Seeds candidate notes (not self-authored, not the designated triage agent's,
  not already in flight) **oldest-first**.
- Calls a pure-log **STUB `decide()`** per candidate that logs
  `would assess note <id>` and **mutates nothing** — no note edits, no triage
  decisions recorded, no proposals/tasks created. There are no action wrappers
  yet; the proposal-gate invariant is untouched.

P3 replaces the stub with the sniff + assessment brain; P4 adds decision
execution (record-decision / promote / dismiss / flag).

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
