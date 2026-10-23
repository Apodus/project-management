# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning is **lockstep** across the monorepo: every package shares one
release line, so a client can cite a single version for the system they run.

## [Unreleased]

### Changed

- **server: no merge group of any form without `linked_repos` (C4-P3b).** Creating a group by
  `members[]`, `member_request_ids[]`, `synthesize_outer` or `synthesize_inner` on a project whose
  `settings.integrator.linked_repos` is absent or empty is now 400 `GROUPS_REQUIRE_LINKED_REPOS`
  ("project <name> has no linked_repos; submit pm_request_merge per repo in its own project"),
  from one gate in front of the form switch. Previously only the synthesize forms were refused.
  **Breaking** for any project that grouped requests without declaring linked repos.
- **distribute: N integrator lanes on one host from ONE generated supervisor.** Lanes are a host
  property, declared once at the top level of `distribute.config.json` (`lanes: [{ name, projectId,
resource?, pmUrl?, env? }]`); every target with an `integratorDest` gets the same generated
  `lanes.json` and one `run_daemon_supervised.ps1` / `run_daemon.bat <lane>` / `run_daemon.sh
<lane>`. Each lane's token, `stop.flag`, `supervisor.log`, `daemon.log` and working directory live
  in `lanes/<lane>/`; no launcher contains a project id; `lanes.json` is re-read before every daemon
  start, so a lane's `env` reaches the next start. Launchers and `lanes.json` now go through the
  write-receipt guard, and every target is checked before any is written. Targets take any subset
  of the four artifacts (a deploy directory needs only `integratorDest`); unknown keys and shared
  destinations are refused. **Breaking for launcher users:** a legacy target `projectId` is now one
  lane named `default`, whose token moves to `lanes/default/pm_token.txt`; it cannot be combined
  with top-level `lanes`. See `docs/integrator-deployment.md` §11.1.

### Added

- **Transfer a task, an epic (with all its tasks) or a proposal to another project** of the same
  workspace: `POST /api/v1/{tasks|epics|proposals}/{id}/transfer` `{target_project_id,
target_epic_id?, reason}` and `pm_transfer_task|epic|proposal`. The id, comments, git refs, claim
  and task dependencies follow; project-scoped labels (dropped and listed), an epic's milestone and
  a task's old epic do not. Refused (409) while a moving task has a queued/integrating merge
  request or a forming/integrating group, a held or queued merge lock or an open incident, when a
  parent/subtask would be split, and for an epic with any epic dependency. Claim holder or human
  only; audited (`transfer`) in the source project, activity `transferred` in both. Cross-project
  task dependencies are now an explicit, tested contract.
- **integrator: the host verify semaphore (`hostSlots`).** Declared once per host at the top level
  of the distribute config, emitted into `lanes.json`, passed by the supervisor as
  `--host-slots-file`. Every verify pipeline (single-repo, group, orphan recovery) takes a slot
  from a FIFO ticket queue in an absolute directory before its first step and releases it in a
  `finally`; holder liveness is pid + start time read only through `identityCommand` (the daemon
  self-probes at startup, exit 2 on failure); dead holders are reclaimed and their recorded verify
  trees killed only on an identity re-read at kill time. Heartbeats carry `host_slots`.
  `--host-slots-probe` prints the queue. See `docs/integrator-deployment.md` sec. 11.2.
- **integrator: `settings.integrator.reject_merge_commits` (C4-P3c, default `false`).** When `true`, a
  single-repo request whose `<main tip>..<commit>` range holds a merge commit is rejected before the
  rebase (category `other`, reason `merge-commit-in-range: <shas>. ...`; no verify, no resolution).
  The rebase flattens merges, so after it no merge is left to detect and a trailer on a merge commit
  never reaches main. New `rebaseOnto(base, ref, { rejectMergeCommits })` option; the result carries
  `mergeCommits`. Off/absent is byte-identical. See `docs/integrator-deployment.md` §4.3.
- **integrator: a slot holds no nested repository its `HEAD` does not declare (C4-P3).** After every
  reset, candidate checkout, verify-tree rebase and committed resolution the slot is swept of
  nested repositories (working-tree checkouts and `.git/modules/<name>` gitdirs) that `HEAD` does
  not declare as a gitlink, so a submodule retired by the candidate itself no longer survives into
  its own verify. State-based, no exemption list, directory-entry walk with build trees pruned by
  name; removals log `nested_repo_removed`, and `clean_keep` entries that went with a removed parent
  are named. See `docs/integrator-deployment.md` §4.5.
- **integrator: `--stop-file <path>`.** The daemon stops gracefully (as on SIGTERM) once the file
  exists and leaves it for the supervisor. The generated supervisor passes the lane's
  `lanes/<lane>/stop.flag`, so a stop flag stops a RUNNING daemon -- before, it was read only
  between daemon runs and a healthy Windows daemon could not be stopped gracefully at all. Deploy
  the supervisor and the bundle together (an older bundle rejects the flag).

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
