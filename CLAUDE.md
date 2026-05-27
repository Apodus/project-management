# Project Management System

Human-AI Collaborative Project Management System. Monorepo powered by pnpm + Turborepo.

## Prerequisites

- Node.js >= 22.0.0
- pnpm (install via `npm install -g pnpm`)

## Commands

```bash
# Install all dependencies
pnpm install

# Build all packages
pnpm build

# Start all dev servers (server + web)
pnpm dev

# Run tests
pnpm test

# Lint all packages
pnpm lint

# Type-check all packages
pnpm typecheck

# Format code
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
```

## Project Structure

```
project-management/
├── packages/
│   ├── shared/        # Shared types, schemas, constants
│   ├── server/        # Hono REST API server
│   ├── web/           # React SPA (Vite)
│   └── mcp-server/    # MCP server for Claude integration
├── docs/design/       # Design documents
├── roadmaps/          # Phase roadmaps
├── turbo.json         # Turborepo pipeline config
├── tsconfig.base.json # Shared TypeScript config
└── eslint.config.js   # ESLint 9 flat config
```

## Architecture

- **Backend**: Hono (Node.js) with SQLite via Drizzle ORM
- **Frontend**: React 19 + Vite + Tailwind CSS
- **MCP Server**: Separate process communicating with REST API over localhost
- **Shared**: Zod schemas as single source of truth for types
- All packages are TypeScript with strict mode enabled
- Server reads config from environment variables: `PM_PORT` (default 3000), `PM_HOST` (default 127.0.0.1), `PM_DB_PATH` (default ./data/pm.db)
