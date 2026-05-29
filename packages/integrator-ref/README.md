# @pm/integrator-ref

Reference integrator process for the PM merge train. One process per `(project, resource)` lane.

It watches a PM project for queued merge requests, rebases each onto live main in an isolated
worktree, runs the project's verify command, and either lands the change (fast-forwarding main)
or rejects it with a structured payload.

## Quick start

```bash
pnpm --filter @pm/integrator-ref build
PM_API_TOKEN=... node packages/integrator-ref/dist/index.js \
  --project 01HXYZ... \
  --resource main \
  --pm-url http://localhost:3000
```

## Documentation

- **Operator deployment guide** (start here): `docs/integrator-deployment.md` — install,
  configuration, worktree setup, verify conventions, logging, monitoring, failure modes,
  and single-machine multi-agent layout.
- **Architecture & contracts**: `docs/design/phase-7.1-design.md`.

## Configuration at a glance

CLI flags: `--project`, `--resource` (default `main`), `--pm-url`, `--token` (env-var name,
default `PM_API_TOKEN`), `--log-level`, `--poll-interval-sec` (default `30`).
Per-project settings live in `projects.settings.integrator` — see the deployment guide.
