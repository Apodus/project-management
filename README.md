# Project Management System

A focused, human-AI collaborative project management tool for small teams (1-3 humans plus
multiple AI agents) working locally or on a shared LAN. Monorepo powered by pnpm + Turborepo.

- **Backend** — Hono REST API on Node.js, SQLite via Drizzle ORM, OpenAPI auto-generated from
  Zod schemas, full-text search via FTS5.
- **Frontend** — React 19 SPA (Vite + Tailwind CSS v4, TanStack Router/Query, Zustand).
- **MCP server** — a separate stdio process letting Claude (or any MCP-compatible agent) manage
  projects, proposals, and tasks over the REST API.

## Prerequisites

- **Node.js** >= 22
- **pnpm** (`npm install -g pnpm`)

## Install

```bash
pnpm install
```

## Develop

```bash
pnpm dev
```

Starts the API server on port **3000** and the web dev server (with HMR) on port **5173**. The
web dev server proxies `/api` requests to the backend automatically. Open http://localhost:5173.

## Production

```bash
pnpm build         # builds shared -> server -> web -> mcp-server
pnpm start:prod    # serves the API + pre-built SPA from one process on port 3000
```

Open http://localhost:3000 and complete the first-run admin wizard.

## Where to go next

- **[docs/SETUP.md](docs/SETUP.md)** — the full first-time journey: first-run admin, create a
  project, connect AI agents (`.mcp.json`), and the optional merge-train integrator.
- **[CLAUDE.md](CLAUDE.md)** — the complete command catalog, architecture, package layout,
  environment variables, testing, and database management.
- **[docs/integrator-deployment.md](docs/integrator-deployment.md)** — operator guide for
  deploying the merge-train integrator (install, config, monitoring, break-glass).
- **[scripts/distribute.mjs](scripts/distribute.mjs)** — cross-platform script to vendor the
  built MCP + integrator bundles and docs into a client repo (see SETUP.md → Distribution models).
- **[docs/RELEASING.md](docs/RELEASING.md)** — versioning + npm-publishing status (the publish
  scaffold is ready but **parked**), the release process, and what's left to publish.
