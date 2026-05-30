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

# Run E2E tests (Playwright — builds, starts server, runs in Chromium)
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
pnpm --filter @pm/mcp-server build

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
├── packages/
│   ├── shared/        # Shared Zod schemas, types, and constants (single source of truth)
│   ├── server/        # Hono REST API server with SQLite (Drizzle ORM)
│   ├── web/           # React 19 SPA (Vite + Tailwind CSS + TanStack Router/Query)
│   └── mcp-server/    # MCP server for Claude AI agent integration (stdio transport)
├── docs/design/       # Design documents (high-level-design.md)
├── roadmaps/          # Phase roadmaps
├── turbo.json         # Turborepo pipeline config
├── tsconfig.base.json # Shared TypeScript config (strict mode)
└── eslint.config.js   # ESLint 9 flat config
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
Main is never broken — verify runs against a tree SHA before main fast-forwards.

- **Architecture & contracts**: `docs/design/phase-7.1-design.md` (data model, state machines,
  REST surface, SSE events, authz, failure catalog).
- **Operator deployment guide**: `docs/integrator-deployment.md` (install, config, monitoring,
  failure modes, single-machine layout).
- **MCP tools** (worker-facing): `pm_request_merge`, `pm_list_merge_requests`,
  `pm_get_merge_request`, `pm_cancel_merge_request`. The integrator-facing operations
  (pickup, start/complete attempt, land, reject, reset-to-queued) are HTTP-only.
- **Reference integrator**: `packages/integrator-ref` (`@pm/integrator-ref`, bin `pm-integrator`).
  Deploy one process per `(project, resource)` lane.

**Speculative batching (Phase 7.2).** The integrator can run **N integrations in flight at once**,
configured by `project.settings.integrator.parallelism` (integer ≥ 1, **default 1** = exact 7.1
serial behavior — no env var). With `parallelism > 1` each member rebases speculatively on
`main + predecessors` (member K assumes 0..K-1 land first), all verify concurrently in a pool of N
isolated worktree clones, and lands serialize in batch order. A member failure invalidates exactly
its dependent suffix (predecessors still land; the suffix re-verifies against the corrected base);
transient verify failures retry with backoff. The lane lock is now acquired **once per batch**
(lane ownership), so a second integrator on the same lane idles. Batch observability is delivered
via SSE: `merge.batch.started/member_landed/member_invalidated/completed` markers (relayed through
`POST /api/v1/projects/{projectId}/merge-batches/events`) plus `batch_id`/`speculative_position` tags
on the existing `merge.request.*` / `merge.attempt.*` frames. No PM batch tables — the integrator owns
batch state in memory. Full spec: `docs/design/phase-7.2-design.md`.

**Cross-repo atomicity (Phase 7.3).** A change that spans linked repos (game_one's `rynx` inner Rust
workspace + the outer game repo that embeds it as a `160000` gitlink) lands as a unit or not at all.
Workers submit each repo's change as a normal merge request, then bind them into a **merge group**
(`pm_request_merge_group`); the integrator picks up the whole group under the **same lane lock**,
assembles the multi-repo state (inner rebased to `Ri` + outer gitlink committed to `Ri` + the inner
sources materialized into the outer working tree), runs per-repo verify concurrently (AND-combined),
and lands **inner-first then outer**. If the inner push fails the whole group rejects cleanly (outer
never touched); if the outer push fails *after* the inner landed, the inner commit is marked
`orphaned` and a durable **incident** (`orphaned_inner`) is opened so the divergence is detectable
from PM alone (no SSH into the host). Recovery is **auto-rollforward**: a later integration rolls the
outer gitlink forward to absorb the orphaned SHA via a verify-gated fast-forward push (when the
current gitlink is an ancestor of the orphan) and resolves the incident `auto_resolved`; an
un-reconcilable orphan escalates and the incident stays `open` for a human (`human_resolved`). Outer
`main` is **never** advanced to a gitlink whose assembled tree has not passed verify — not in land,
not in recovery. State is PM-owned in two new tables — `merge_request_groups`
(forming → integrating → landed | rejected | partially_landed) and `merge_incidents`
(open → auto_resolved | human_resolved) — plus a nullable `merge_requests.group_id`. Linked repos are
declared per project in `settings.integrator.linked_repos` (`[{ name, path, role: "inner"|"outer",
gitlink_parent?, gitlink_path? }]`; default `[]` = single-repo, byte-identical to 7.2). Worker MCP
tools: `pm_request_merge_group`, `pm_get_merge_group`, `pm_list_merge_incidents`,
`pm_get_merge_incident`. Full spec: `docs/design/phase-7.3-design.md`.

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

### Available MCP Tools

The MCP server exposes tools for:
- **Projects**: List, create, and manage projects
- **Proposals**: List, create, discuss, and transition proposals
- **Tasks**: List, get, create, and update tasks
- **Search**: Full-text search across all entities
- **Updates**: Activity feed and status updates
- **Workflow**: Status transitions and workflow management
- **Write operations**: Create and modify project entities

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | (none) | Set to `production` for production mode |
| `PM_PORT` | `3000` | Server port |
| `PM_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN access) |
| `PM_DB_PATH` | `./data/pm.db` | SQLite database file path |
| `PM_SESSION_SECRET` | (generated) | Session signing secret |
| `PM_LOG_LEVEL` | `info` | Logging verbosity |
| `PM_WEB_DIST_PATH` | (auto-resolved) | Override path to web dist directory |
| `PM_API_URL` | `http://localhost:3000` | MCP server: API base URL |
| `PM_API_TOKEN` | (none) | MCP server: API authentication token |

See `.env.example` for a template.

## Testing

```bash
# Run all unit/integration tests (Vitest)
pnpm test

# Run tests for a specific package
pnpm --filter @pm/server test
pnpm --filter @pm/shared test
pnpm --filter @pm/mcp-server test

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
