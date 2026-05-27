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
