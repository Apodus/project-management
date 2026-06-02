# Setup guide — clone to running, then connect agents

This walks a fresh operator from a clone all the way to a running PM with AI agents connected,
and (optionally) the merge-train integrator deploying to a client repo. It works the same on
macOS, Linux, and Windows.

> **Trust model:** the PM is built for a small team on localhost or a trusted LAN. API tokens and
> agent-pool secrets are **LAN-trust** credentials — treat them like a shared house key, not a
> public-internet secret. Do not expose the server to the open internet without a reverse proxy
> and your own auth in front of it.

For the full command catalog, architecture, and environment variables see
[`../CLAUDE.md`](../CLAUDE.md). This guide is the journey, not the reference.

---

## 1. Install and run

```bash
pnpm install       # install all workspace dependencies
pnpm build         # build shared -> server -> web -> mcp-server
pnpm start:prod    # serve API + SPA on http://localhost:3000
```

(For day-to-day development use `pnpm dev` instead — API on 3000, web with HMR on 5173. See
[`../CLAUDE.md`](../CLAUDE.md) for the dev workflow.)

To allow other machines on your LAN to reach the server, bind to all interfaces:

```bash
PM_HOST=0.0.0.0 pnpm start:prod    # then browse to http://<this-machine-ip>:3000
```

## 2. First-run admin wizard

Open http://localhost:3000 in a browser. On the very first run the app shows a **setup wizard**
that creates the initial admin account. Pick a username and password and finish the wizard — you
land in the app authenticated as that admin.

## 3. Create a project

From the projects view, create your first project (name + slug). A project is the container for
proposals, epics, tasks, the activity feed, and — if you use it — the merge train. Open the
project to get its **project id** from the URL; you'll need it for the integrator later.

## 4. Connect AI agents

AI agents talk to the PM through the **MCP server** (`packages/mcp-server`), a stdio process your
agent (e.g. Claude Code / Claude Desktop) launches. There are two ways for an agent to
authenticate: a **per-agent static token**, or — recommended for multi-agent teams — an
**agent pool** where each agent claims its own identity from one shared pool secret.

> If your build includes the **connect-agents wizard step** (the in-product shortcut), open it
> from the project and follow it — it walks you through creating a pool and produces a ready-to-paste
> `.mcp.json`. The manual flow below is the same thing by hand, and is the fallback if that step
> isn't present yet.

### The manual flow (agent pool)

1. Go to **Settings → Users** (admin only).
2. Under **Agent pools**, **create a pool** (e.g. `default`) and set a **secret** (≥ 8 chars).
   The secret is hashed server-side; it is the shared credential your agents present to claim an
   identity from the pool. You can pre-seed named agents in the pool, or let agents claim on
   first connect.
3. **Copy the pool secret** and keep it handy — you'll put it in each agent's `.mcp.json`.
4. **Assemble `.mcp.json`** for the agent's working directory. The pool-secret form lets one
   shared config serve every agent — each MCP process claims a distinct identity on startup:

```json
{
  "mcpServers": {
    "project-management": {
      "command": "node",
      "args": ["/absolute/path/to/project-management/packages/mcp-server/dist/index.js"],
      "env": {
        "PM_API_URL": "http://localhost:3000",
        "PM_POOL_SECRET": "your-pool-secret",
        "PM_POOL_NAME": "default"
      }
    }
  }
}
```

`PM_POOL_NAME` defaults to `default`, so you can omit it if that's your pool name. `PM_API_URL`
can point at any reachable host (e.g. `http://192.168.1.x:3000` for a LAN server). Restart the
agent (or the Claude Code session) after editing `.mcp.json` so it re-reads the config.

### Alternative: a static per-agent token

If you'd rather give one agent its own dedicated token: in **Settings → Users**, create an AI
agent user and copy the API token it shows **once** (it can't be retrieved later). Then use
`PM_API_TOKEN` instead of the pool vars:

```json
"env": {
  "PM_API_URL": "http://localhost:3000",
  "PM_API_TOKEN": "the-token-shown-once"
}
```

`PM_API_TOKEN` takes precedence; the pool secret is only used when no static token is set.

## 5. Optional: the merge-train integrator

If your team uses the worker/integrator merge train, deploy one long-lived integrator process per
`(project, resource)` lane. It rebases each merge request onto live `main`, runs the project's
verify command in an isolated worktree, and lands or rejects it — `main` is never broken.

Full install, configuration, monitoring, and the 30-minute deploy checklist live in the operator
guide — **do not re-derive them here**:

- [`integrator-deployment.md` §3 — Install and build](integrator-deployment.md#3-install-and-build)
- [`integrator-deployment.md` §12 — 30-minute deploy checklist](integrator-deployment.md#12-30-minute-deploy-checklist)

In short: enable the integrator in the project's settings, point the daemon at the PM, and run it
with the project id you noted in step 3:

```bash
node /path/to/pm-integrator.mjs --project <project-id> --resource main --pm-url http://localhost:3000
```

## 6. Distribution models

To run the MCP server and integrator **next to a client repo** (so agents and the daemon don't
need this monorepo checked out), vendor the built bundles into the client.

- **Vendored bundle (today).** Build the bundles and copy the four artifacts (MCP bundle,
  integrator daemon, operator guide, worker workflow doc) into each client target using the
  cross-platform script:

  ```bash
  cp distribute.config.example.json distribute.config.json   # then edit the dest paths
  node scripts/distribute.mjs            # builds the bundles, copies to every target
  node scripts/distribute.mjs --dry-run  # preview: writes nothing, logs intended copies
  ```

  `distribute.config.json` is **gitignored** (it holds machine-specific absolute paths). Each
  target's `docsDest`/`workerDocDest` are full **file** paths; the worker workflow doc is copied
  **as** `pm-workflow.md` at the dest. Operators who prefer a one-word local command may keep a
  small `distribute.bat` (or shell) wrapper that simply calls `node scripts/distribute.mjs` — the
  wrapper is local/gitignored; the script is the reproducible path.

- **`npx` (future).** Publishing the MCP server and integrator as runnable packages so a client
  can `npx @pm/mcp-server` without vendoring is a planned alternative; not available yet.
