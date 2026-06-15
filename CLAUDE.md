# Project Management System

Human-AI Collaborative Project Management System. A focused tool for small teams (1-3 humans, multiple AI agents) working locally or on a shared LAN. Monorepo powered by pnpm + Turborepo.

## Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** (install via `npm install -g pnpm`)

## Quick Start

### Development

```bash
pnpm install          # Install all dependencies
pnpm dev              # Starts API server (port 3000) + web dev server (port 5173, with HMR)
```

The web dev server proxies `/api` requests to the backend automatically.

### Production

```bash
pnpm install          # Install dependencies (if not already done)
pnpm build            # Build all packages (shared -> server -> web -> mcp-server)
pnpm start:prod       # Start production server (serves API + web UI on port 3000)
```

In production mode the server serves both the REST API and the pre-built React SPA from a single Node.js process.

## Commands

```bash
# Install all dependencies
pnpm install

# Build all packages
pnpm build

# Start all dev servers (server + web)
pnpm dev

# Start production server (NODE_ENV=production)
pnpm start:prod

# Start server (without setting NODE_ENV)
pnpm start

# Run all tests (unit/integration via Vitest)
pnpm test

# Run E2E tests (Playwright â€” builds, starts server, runs in Chromium)
pnpm test:e2e

# Lint all packages
pnpm lint

# Type-check all packages
pnpm typecheck

# Format code with Prettier
pnpm format

# Check formatting
pnpm format:check
```

### Package-specific commands

```bash
# Run command for a specific package
pnpm --filter @pm/server dev
pnpm --filter @pm/web dev
pnpm --filter @pm/shared build
pnpm --filter @urtela/pm-mcp-server build

# Generate Drizzle migration after schema changes
pnpm --filter @pm/server db:generate

# Export OpenAPI spec to JSON
pnpm --filter @pm/server openapi:export

# Regenerate API types from OpenAPI spec (in web package)
pnpm --filter @pm/web generate:api
```

## Package Structure

```
project-management/
â”œâ”€â”€ packages/
â”‚   â”œâ”€â”€ shared/        # Shared Zod schemas, types, and constants (single source of truth)
â”‚   â”œâ”€â”€ server/        # Hono REST API server with SQLite (Drizzle ORM)
â”‚   â”œâ”€â”€ web/           # React 19 SPA (Vite + Tailwind CSS + TanStack Router/Query)
â”‚   â””â”€â”€ mcp-server/    # MCP server for Claude AI agent integration (stdio transport)
â”œâ”€â”€ docs/design/       # Design documents (high-level-design.md)
â”œâ”€â”€ roadmaps/          # Phase roadmaps
â”œâ”€â”€ turbo.json         # Turborepo pipeline config
â”œâ”€â”€ tsconfig.base.json # Shared TypeScript config (strict mode)
â””â”€â”€ eslint.config.js   # ESLint 9 flat config
```

## Architecture

- **Backend**: Hono framework on Node.js with SQLite via Drizzle ORM. OpenAPI spec auto-generated from Zod schemas. Full-text search via FTS5.
- **Frontend**: React 19 + Vite + Tailwind CSS v4. TanStack Router for routing, TanStack Query for data fetching, Zustand for client state. Component library built on Radix UI primitives.
- **MCP Server**: Separate process using stdio transport. Communicates with the REST API over localhost HTTP. Provides tools for AI agents to manage projects, proposals, tasks, and more.
- **Shared**: Zod schemas as the single source of truth for types across all packages. Exported as ESM.
- All packages use TypeScript with strict mode enabled.

## Merge train (worker / integrator split)

Workers submit a merge request and walk away; a separate long-lived **integrator** process
picks it up, rebases onto live main, runs the project's verify command in an isolated
worktree, and either lands it (fast-forwards main, attaches a `landed_sha` git_ref to the
linked task) or rejects it with a structured payload (auto-comment of type `merge_rejection`).
Main is never broken â€” verify runs against a tree SHA before main fast-forwards.
If a request's content is already on main (landed out-of-band under a different SHA, or a
duplicate), the land path detects the rebased tree is byte-identical to live main
(`GitOps.treesIdentical`, under the lane lock) and records a **no-op land** at the current
main SHA without pushing â€” it never advances main by an empty commit or re-applies. (Grouped
cross-repo re-submissions are no-op'd naturally by the fast-forward push; see
`docs/integrator-deployment.md` Â§9.)

- **Architecture & contracts**: `docs/design/phase-7.1-design.md` (data model, state machines,
  REST surface, SSE events, authz, failure catalog); `phase-7.2` (speculative batching),
  `phase-7.3` (cross-repo atomicity), `phase-7.4` (observability + break-glass),
  `phase-7.5` (smart verification).
- **Operator deployment guide**: `docs/integrator-deployment.md` (install, config, monitoring,
  failure modes, single-machine layout; Â§15 = observability + break-glass).
  The integrator config (`settings.integrator` editable fields + `gitRepoUrl`, including `clean_keep`)
  is now editable in the admin **Integrator** settings page (`/projects/{id}/settings/integrator`);
  deferred fields (`verify_steps`/cache/`slo`/`resolver`) stay REST-only.
- **MCP tools** (worker-facing): `pm_request_merge`, `pm_list_merge_requests`,
  `pm_get_merge_request`, `pm_cancel_merge_request`. The integrator-facing operations
  (pickup, start/complete attempt, land, reject, reset-to-queued) are HTTP-only.
- **Reference integrator**: `packages/integrator-ref` (`@urtela/pm-integrator`, bin `pm-integrator`).
  Deploy one process per `(project, resource)` lane.

### Capability index (phases & campaigns)

The merge train and the campaigns that build on it are summarized below — one
entry per capability with its key operational facts and a spec pointer. The full
chronological narrative lives in **`docs/capability-history.md`**; the
authoritative per-feature spec is the linked `docs/design/phase-*.md` /
`roadmaps/*.md`.

**Merge train (Phases 7.1–7.6.1)** — `docs/design/phase-7.*.md`, operator guide
`docs/integrator-deployment.md`.

- **7.2 Speculative batching** — `settings.integrator.parallelism` (≥1, **default
  1** = serial 7.1). N members rebase speculatively + verify concurrently + land
  in order; a failure invalidates only its dependent suffix.
- **7.3 Cross-repo atomicity** — a change spanning linked repos (inner Rust
  workspace + outer gitlink) lands as a unit or not at all. `settings.integrator.
linked_repos` (`[]` = single-repo). Orphaned-inner → durable incident +
  auto-rollforward. **Inner-only groups** (`synthesize_outer: true`) mint a
  synthetic outer member. **Verify contract:** the outer verify must NOT
  `submodule update --init` the gitlink path (see deployment guide §14.8).
- **7.4 Observability + break-glass** — train dashboard / per-request timeline /
  audit; on-read metrics + SLO; 5 admin-only overrides (pause/resume/
  force-release-lock/**force-land**/force-reject), each one audit row; integrator
  heartbeat; dual (SSE + Discord) alerts.
- **7.5 Smart verification** — multi-step verify DAG (`settings.integrator.
verify_steps`) + PM-owned `verify_cache` (`cache_enabled` **default false**,
  `cache_mode off|on|shadow` **default off**). Discipline: shadow → on.
- **7.6 / 7.6.1 Conflict resolver** — on a textual rebase conflict, an opt-in
  bounded headless Claude session (`settings.integrator.resolver`, **default
  off**) reconciles + re-verifies + resubmits as a linked new MR; the **train
  re-verify is the sole landing gate**. Never discards proven work.

**Claim liveness (Campaigns C1–C3)** — `docs/design/phase-c*.md`.

- Leases (`claim_leases`) are the liveness layer beside the holder pointer.
  **As of 2026-06-15 the lease engine is ALWAYS ON** — no `PM_LEASE_MODE`; every
  claim creates a lease, a lapsed claim (`now > expiresAt + grace`) is always
  reclaimed, and a holder with no lease row reads **stale by definition**. Only
  `PM_LEASE_TTL_SEC` / `PM_LEASE_GRACE_SEC` are tunable. **C1 stable worker
  identity** (`PM_WORKER_KEY`) is the precondition — set a distinct key per
  worker or a reconnect churns identity and strands/reclaims a live claim.
- **C3 liveness surfacing** — identity-masked `claim_state` (unclaimed/live/
  stale/yours) on REST + MCP + web badges; pick-next skips live / reclaims stale;
  stale-claim alert; release-to / request-takeover handoffs (live is never
  stomped). The claims page also has a plain **Release** action.

**Escalation channel (Campaigns C1–C4)** — `roadmaps/*escalation*.md`. A
bidirectional agent-to-agent cross-team channel replacing the human relay:
`escalations` + `escalation_messages` (migrations 0029–0031), 8 MCP tools, REST +
SSE + activity-feed audit. **C2 delivery** (wake daemon `@urtela/pm-wake-daemon`

- piggyback + `pm_check_messages` + Discord needs-human bridge). **C3
  auto-responder** (`@urtela/pm-responder`, answer/diagnose-only, **ships
  `enabled=false`**, `mode off|shadow|on` default shadow). **C4 legibility** (web
  dashboard + timeline + metrics + SLA alert + FTS dedup/auto-link + rate-limit).

**Auto-implement / autonomous drive (Campaigns A1–A5)** — `roadmaps/*a[1-5]*.md`.
The responder can autonomously land a code fix or drive a full `/vision`+
`/campaign` arc, **verify-gated by the merge train** (`main` is structurally
unbreakable). Enablement = per-project **`settings.autoImplement.enabled`/`mode`**
(web-toggleable, **default off / shadow**) composed with the env master
`PM_AUTO_IMPLEMENT_ENABLED` (explicit-false ⇒ force-off-all; true/unset ⇒ defer to
DB). Deployment knobs (git url / budget / allowlist / verify) stay env. A4 adds
budget/revert/reclaim guardrails; A5 adds the off|shadow|on rollout + audit-chain
dashboard. **The whole arc ships OFF.**

### Production Deployment

In production (`NODE_ENV=production`), the server process:

- Serves the REST API on `/api/v1/*`
- Serves the SSE event stream on `/api/v1/events`
- Serves the pre-built React SPA on `/*` (with SPA fallback for client-side routing)
- Uses SQLite database at `./data/pm.db` (configurable)

## MCP Server Setup

The MCP server allows Claude (or any MCP-compatible AI agent) to interact with the project management system.

### Configuration

Add the following to your Claude MCP settings (e.g., `claude_desktop_config.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "project-management": {
      "command": "node",
      "args": ["/path/to/project-management/packages/mcp-server/dist/index.js"],
      "env": {
        "PM_API_URL": "http://localhost:3000",
        "PM_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Replace `/path/to/project-management` with the absolute path to this project. `PM_API_URL` can point to any machine running the server (e.g., `http://192.168.1.x:3000` for a remote host).

When auto-claiming from an agent pool (`PM_POOL_SECRET` instead of a static `PM_API_TOKEN`), also set a **distinct** `PM_WORKER_KEY` per worker so a reconnect/restart re-binds the SAME identity instead of grabbing a new free agent (avoids stranded claims). The game*one distribute bundle (a separate repo â€” do not edit from here) should write a distinct `PM_WORKER_KEY` per worker alongside the per-worker `PM_POOL*\*` it already emits.

### Available MCP Tools

The MCP server exposes tools for:

- **Projects**: List, create, and manage projects
- **Proposals**: List, create, discuss, and transition proposals
- **Tasks**: List, get, create, and update tasks
- **Notes**: Capture, list, and get lightweight ownerless notes (bug/question/idea/tech_debt/wtf/observation) via `pm_post_note`/`pm_list_notes`/`pm_get_note`
- **Search**: Full-text search across all entities
- **Updates**: Activity feed and status updates
- **Workflow**: Status transitions and workflow management
- **Write operations**: Create and modify project entities

## Environment Variables

| Variable             | Default                 | Description                                                                                                                                                                                                                     |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`           | (none)                  | Set to `production` for production mode                                                                                                                                                                                         |
| `PM_PORT`            | `3000`                  | Server port                                                                                                                                                                                                                     |
| `PM_HOST`            | `127.0.0.1`             | Bind address (`0.0.0.0` for LAN access)                                                                                                                                                                                         |
| `PM_DB_PATH`         | `./data/pm.db`          | SQLite database file path                                                                                                                                                                                                       |
| `PM_LOG_LEVEL`       | `info`                  | Logging verbosity                                                                                                                                                                                                               |
| `PM_WEB_DIST_PATH`   | (auto-resolved)         | Override path to web dist directory                                                                                                                                                                                             |
| `PM_POOL_SECRET`     | (none)                  | Agent-pool secret. Server: auto-creates the `default` pool on first claim. MCP server: auto-claims an agent identity from the pool (alternative to a static `PM_API_TOKEN`).                                                    |
| `PM_POOL_NAME`       | `default`               | MCP server: name of the agent pool to claim from                                                                                                                                                                                |
| `PM_LEASE_TTL_SEC`   | `1800`                  | Claim lease TTL (seconds) before a lease lapses. The lease engine is always active (no on/off/shadow switch): every claim creates a lease and a lapsed claim is always reclaimed.                                               |
| `PM_LEASE_GRACE_SEC` | `86400`                 | Reclaim grace (seconds) beyond TTL before sweep                                                                                                                                                                                 |
| `PM_API_URL`         | `http://localhost:3000` | MCP server: API base URL                                                                                                                                                                                                        |
| `PM_API_TOKEN`       | (none)                  | MCP server: API authentication token                                                                                                                                                                                            |
| `PM_WORKER_KEY`      | (none)                  | MCP server: stable per-worker identity key. With the pool secret, re-binds the SAME agent identity across reconnect/restart (no stranded claims). Must be DISTINCT per worker. Unset â‡’ legacy behavior (grab any free agent). |

There is no session-signing secret: sessions and API tokens are opaque random tokens stored
bcrypt-hashed server-side (sessions ride an httpOnly `pm_session` cookie; API tokens go in the
`Authorization` header).

See `.env.example` for a template.

## Testing

```bash
# Run all unit/integration tests (Vitest)
pnpm test

# Run tests for a specific package
pnpm --filter @pm/server test
pnpm --filter @pm/shared test
pnpm --filter @urtela/pm-mcp-server test

# Run tests in watch mode (package-level)
cd packages/server && npx vitest

# Run E2E tests (Playwright)
pnpm test:e2e
```

Unit/integration tests use Vitest. Server tests use in-memory SQLite databases for isolation.

E2E tests use Playwright with Chromium. They build the app, start a production server on a dedicated port (default 3099, configurable via `E2E_PORT`), and test critical user flows: setup wizard, login/logout, project creation, proposals, task management, board view, and command-palette search.

## Database Management

### Migrations

Drizzle ORM handles schema migrations automatically on server startup. To generate a new migration after changing the schema:

```bash
# Edit schema in packages/server/src/db/schema.ts
# Then generate migration SQL:
pnpm --filter @pm/server db:generate
```

Migration files are stored in `packages/server/src/db/migrations/`.

`db:generate` works again: the snapshot history was rebuilt to a single baseline
`meta/0026_snapshot.json` (after a historical hand-copied-snapshot collision â€” `0005`/`0006`
were byte-identical, which broke drizzle-kit's snapshot diffing). Under this one-baseline model,
a future `db:generate` diffs the current `schema.ts` against that baseline and emits `0027_*`
automatically â€” the `.sql`, its `meta/0027_snapshot.json`, and the `_journal.json` entry are all
written for you. Hand-authored migrations remain possible, but each must append its own
`_journal.json` entry â€” migrations apply by journal order, not by `.sql` glob.

**Journal `when` MUST be the real current time (`Date.now()`), strictly greater than the previous
entry and NEVER in the future.** Drizzle applies a migration iff `when > MAX(created_at)` of the
applied log — a future-stamped entry raises the watermark so the NEXT (honestly-stamped) migration
silently skips on every existing DB (the 2026-06-10 incident: hand-authored entries 0004–0026
carried fabricated sequential-midnight stamps marching to 2026-06-21; the auto-generated 0027 sat
below the watermark, skipped, and the server 500'd per request). Guards now exist
(`src/db/migration-journal.ts`): boot HEALS drifted `created_at` values (hash-matched to the
journal) and then FAIL-LOUD asserts every journal migration is applied — plus a journal-hygiene
test pins monotonic, non-future `when`s. Don't fight the guards; stamp honestly.

### Backup

The database is a single SQLite file (default: `./data/pm.db`). To back up:

```bash
# Simple file copy (stop server first for consistency, or use SQLite backup API)
cp ./data/pm.db ./data/pm.db.backup

# Or use SQLite CLI
sqlite3 ./data/pm.db ".backup ./data/pm.db.backup"
```

### Reset

To reset the database, delete the file and restart the server:

```bash
rm ./data/pm.db
pnpm start:prod   # Server will recreate and run migrations
```
