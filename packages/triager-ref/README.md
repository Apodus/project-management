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
- Runs `decide()` (injection sniff → **refresh the project's checkout** → bounded
  assessment session in that checkout) to produce a structured `TriageAssessment`,
  then **executes** it via `executeDecision`:
  - **off** — defensive noop (mode can be off even while the daemon is enabled);
  - **shadow** — records a triage-decision side-log row and **leaves the note
    open** (mutates nothing else);
  - **on** — records the decision **and** performs the action (promote to
    proposal / dismiss / flag needs_human), backlinking any minted proposal.

The **proposal-gate** is preserved: the only task-minting path is
`implementProposal` on a fast_track proposal (note → proposal → breakdown).
There is no direct note → task path.

### Repo-aware assessment (dedicated checkout, required for real triage)

A note can only be judged against the **project's code** — the crux is whether
the issue it describes _still exists_. So each watched project is paired with a
**dedicated checkout** of its code via `--project-repo <projectId>=<path>`
(repeatable) or `PM_TRIAGE_PROJECT_REPO` (single). Before every assessment the
daemon refreshes that checkout to `--repo-ref` (default `origin/main`):

```
git -C <path> fetch <remote>
git -C <path> reset --hard <ref>
```

then runs the sniff + assessment session with that path as its `cwd`, so the
agent reads current code.

- **Use a DEDICATED checkout, never a live working tree.** The pre-assessment
  `reset --hard` discards local changes — point it at a throwaway clone, not a
  repo anyone is actively working in (the game_one worktrees, the integrator lane,
  etc.).
- **No checkout configured for a watched project ⇒ every note resolves
  `needs_human`** (never a blind assessment). This is not a startup error — a
  project can be watched before its checkout is set up; it simply punts to a human
  until one is.
- **A refresh failure** (bad path, not a git repo, network) ⇒ that note resolves
  `needs_human` (never assess against unknown/stale code).
- **`maxConcurrent`:** one dedicated checkout backs a project, so same-project
  assessments are **serialized** by the daemon regardless of `maxConcurrent`
  (a concurrent `reset --hard` would corrupt a live read). Cross-project
  assessments still run concurrently up to `maxConcurrent`.

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

| Variable                      | Default                 | Description                                                                                                                            |
| ----------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `PM_API_URL`                  | `http://localhost:3000` | PM API base URL (or `--pm-url`).                                                                                                       |
| `PM_API_TOKEN`                | (required)              | PM API token for the triager's ai_agent identity.                                                                                      |
| `PM_PROJECT_ID`               | (none)                  | Single project to watch (or `--project <id>`, repeatable).                                                                             |
| `PM_TRIAGE_PROJECT_REPO`      | (none)                  | Dedicated checkout as `<projectId>=<path>` (or `--project-repo`, repeatable). No checkout ⇒ the project's notes resolve `needs_human`. |
| `PM_TRIAGE_REPO_REF`          | `origin/main`           | Ref the checkout is refreshed to before each assessment (or `--repo-ref`).                                                             |
| `PM_NOTES_TRIAGE_ENABLED`     | (unset ⇒ master allows) | Env master. Explicit-false ⇒ force OFF for all projects.                                                                               |
| `PM_TRIAGE_POLL_INTERVAL_SEC` | `15`                    | Poll interval (or `--poll-interval-sec`).                                                                                              |
| `PM_TRIAGE_COMMAND`           | `claude -p`             | Headless sniff + assessment command.                                                                                                   |
| `PM_TRIAGE_LOGS_DIR`          | `<tmp>/pm-triager-logs` | Directory for status sentinels + logs (outside any git tree).                                                                          |
| `PM_LOG_LEVEL`                | `info`                  | pino log level (or `--log-level`).                                                                                                     |

### Isolation

The sniff + assessment sessions are **read-only by prompt** in the project's
**dedicated checkout** (refreshed to the configured ref), spawned with no
built-in tool restriction — the same posture as the escalation responder's
read-only sessions. The triager has **no write / commit / push path at all**, and
the pre-assessment `reset --hard` wipes any stray write anyway, so the project's
**live working tree is never touched** and the only artifacts a session should
produce are the status sentinel + log under `PM_TRIAGE_LOGS_DIR` (outside any git
tree). Defense-in-depth: the cheap injection sniff gates every assessment (a
suspicious verdict short-circuits to needs_human and the assessment session is
never spawned), the prompts instruct read-only investigation, and the sentinels
live outside the checkout.

If you want a **hard** tool restriction, supply one via `PM_TRIAGE_COMMAND`
without any code change — e.g. point it at a wrapper that passes
`--allowedTools` / `--permission-mode`. The command is threaded verbatim into
both the sniffer and the assessment runner.

## Run

```bash
PM_API_TOKEN=… \
PM_PROJECT_ID=<projectId> \
PM_TRIAGE_PROJECT_REPO=<projectId>=/path/to/dedicated/checkout \
PM_NOTES_TRIAGE_ENABLED=1 \
  pnpm --filter @urtela/pm-triager dev

# multiple projects: repeat --project / --project-repo
pnpm --filter @urtela/pm-triager start -- \
  --project P1 --project-repo P1=/checkouts/p1 \
  --project P2 --project-repo P2=/checkouts/p2 \
  --repo-ref origin/main
```
