# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning is **lockstep** across the monorepo: every package shares one
release line, so a client can cite a single version for the system they run.

## [0.1.0] - 2026-06-02

First versioned release. Everything prior shipped under `0.0.0`; this cut draws
a line and gives the system a citable version. See `CLAUDE.md` and
`docs/design/` for the authoritative detail behind each area below.

### Added

- **Human↔AI project-management core.** Projects, proposals, tasks, and epics
  with a humans-propose / AI-breaks-down workflow. A Hono + SQLite (Drizzle)
  REST API with an OpenAPI spec generated from shared Zod schemas and FTS5
  full-text search, a React 19 web UI (TanStack Router/Query, Tailwind), and an
  MCP server exposing the same surface to AI agents over stdio.
- **Merge train.** A worker/integrator split where workers submit a merge
  request and walk away while a long-lived integrator rebases onto live main,
  verifies in an isolated worktree, and lands or rejects — main is never broken.
  Includes speculative batching (N integrations in flight), cross-repo
  atomicity (inner+outer gitlink lands as a unit, with orphan detection and
  auto-rollforward recovery), observability + break-glass (train dashboard,
  per-request timeline, audit log, five admin overrides, health heartbeat, and
  dual in-app/Discord alerts), and smart verification (a multi-step verify DAG
  plus a content-addressed verify-result cache with off/on/shadow modes).
  See `docs/design/phase-7.1`–`7.5` and `docs/integrator-deployment.md`.
- **Intelligent conflict resolver (Phase 7.6), off by default.** Optional
  assisted resolution of rebase conflicts on the integration path; disabled
  unless explicitly enabled. See `docs/design/phase-7.6-design.md`.
- **Setup & distribution UX.** README/SETUP onboarding, a cross-platform
  `distribute` flow that bundles the MCP server and integrator daemon as
  standalone artifacts, and a first-run connect-agents wizard.
- **Versioning.** package.json is the single source of truth; the version is
  embedded at build time and reported at runtime by the MCP server (serverInfo)
  and the integrator (`--version` and on every heartbeat) in both dev and
  standalone-bundle modes.

### Notes

- npm publishing is not yet wired up; it is the next track on top of this
  versioning foundation.

[0.1.0]: https://semver.org/spec/v2.0.0.html
