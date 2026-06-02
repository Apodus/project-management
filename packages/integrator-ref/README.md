# @urtela/pm-integrator

Reference integrator daemon for the [PM merge train](https://github.com/Apodus/project-management).
One long-lived process per `(project, resource)` lane.

It watches a PM project for queued merge requests, rebases each onto live `main` in an isolated
worktree, runs the project's verify command, and either lands the change (fast-forwarding `main`)
or rejects it with a structured payload. `main` is never broken — verify runs against a tree SHA
before `main` fast-forwards.

## Install / run

The integrator is a long-lived process, so it is typically run directly via `npx` or vendored as a
bundle next to the client repo:

```bash
PM_API_TOKEN=<ai_agent token> \
  npx @urtela/pm-integrator \
  --project <project-id> \
  --resource main \
  --pm-url http://localhost:3000
```

The published package ships a single self-contained ESM bundle as its `pm-integrator` bin (no
runtime dependencies). Pin a version for reproducibility, e.g. `npx @urtela/pm-integrator@0.1.0`.

> The integrator authenticates as a PM **`ai_agent`** user. Create the agent and its API token in
> PM (Settings → Users), then export the token under the env-var name passed to `--token` (default
> `PM_API_TOKEN`).

## CLI flags

| Flag                  | Default        | Description                                               |
| --------------------- | -------------- | --------------------------------------------------------- |
| `--project`           | (required)     | PM project id for the lane.                               |
| `--resource`          | `main`         | Lane resource (the merge-lock resource).                  |
| `--pm-url`            | (required)     | Base URL of the PM server (e.g. `http://localhost:3000`). |
| `--token`             | `PM_API_TOKEN` | Name of the env var holding the `ai_agent` API token.     |
| `--log-level`         | `info`         | Pino log level.                                           |
| `--poll-interval-sec` | `30`           | Seconds between queue polls.                              |
| `--version`           |                | Print the integrator version and exit.                    |

Per-project behavior (verify command, worktree layout, `parallelism`, `linked_repos`, heartbeat,
verify cache, conflict resolution) lives in `projects.settings.integrator` and is set via
`PATCH /api/v1/projects/{id}` — **not** on the process. See the deployment guide.

With `parallelism > 1` it runs N integrations in flight at once: each member rebases speculatively
on `main + predecessors`, all verify concurrently in a pool of N isolated worktree clones, and
lands serialize in batch order (Phase 7.2). `linked_repos` adds cross-repo atomic landing of an
inner Rust workspace + an outer repo that embeds it as a gitlink (Phase 7.3).

## Documentation

- **Operator deployment guide** (start here):
  [`docs/integrator-deployment.md`](https://github.com/Apodus/project-management/blob/main/docs/integrator-deployment.md)
  — install, configuration, worktree setup, verify conventions, logging, monitoring, failure modes,
  and the single-machine multi-agent layout. Covers speculative batching (§13), cross-repo
  atomicity (§14), observability + break-glass (§15), smart verification (§16), and intelligent
  conflict resolution (§18).
- **Architecture & contracts**: `docs/design/phase-7.1-design.md` (serial baseline) through
  `docs/design/phase-7.6-design.md` (intelligent conflict resolution) in the repo.

## License

MIT
