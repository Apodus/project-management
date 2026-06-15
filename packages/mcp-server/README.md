# @urtela/pm-mcp-server

MCP server for the [Human-AI Collaborative Project Management system](https://github.com/Apodus/project-management).
It lets Claude (or any MCP-compatible agent) manage projects, proposals, epics, tasks, the activity
feed, search, and the merge train by talking to the PM REST API over a stdio MCP transport.

The published package ships a single self-contained ESM bundle as its `pm-mcp-server` bin (no
runtime dependencies), so it runs with nothing but Node.js 22+.

## Usage

Point your agent at the MCP server via `npx`. The server is a stdio process the agent launches; it
reads its configuration from environment variables.

```bash
PM_API_URL=http://localhost:3000 \
PM_POOL_SECRET=your-pool-secret \
  npx @urtela/pm-mcp-server
```

Pin a version for reproducibility, e.g. `npx @urtela/pm-mcp-server@0.1.0`.

### Environment variables

| Variable         | Default                 | Description                                                                                                                                                                   |
| ---------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PM_API_URL`     | `http://localhost:3000` | Base URL of the PM server. Any reachable host works (e.g. a LAN IP).                                                                                                          |
| `PM_API_TOKEN`   | (none)                  | Static per-agent API token. Takes precedence over the pool vars.                                                                                                              |
| `PM_POOL_SECRET` | (none)                  | Agent-pool secret — each MCP process auto-claims a distinct identity from the pool.                                                                                           |
| `PM_POOL_NAME`   | `default`               | Name of the agent pool to claim from.                                                                                                                                         |
| `PM_WORKER_KEY`  | (none)                  | Stable per-worker identity key. With the pool secret, re-binds the SAME identity across reconnect/restart. Must be DISTINCT per worker. Unset ⇒ legacy (grab any free agent). |

Authenticate with **either** a static `PM_API_TOKEN` **or** an agent pool
(`PM_POOL_SECRET` + optional `PM_POOL_NAME`). `PM_API_TOKEN` takes precedence when both are set;
the pool secret is used only when no static token is present. With a pool, set a **distinct**
`PM_WORKER_KEY` per worker so a reconnect/restart re-binds that worker's existing identity (and
refreshes its token) instead of stranding the claim and grabbing a new free agent.

## Sample `.mcp.json`

Agent-pool form (recommended for multi-agent teams — one shared config, distinct identity per
process):

```json
{
  "mcpServers": {
    "project-management": {
      "command": "npx",
      "args": ["-y", "@urtela/pm-mcp-server@0.1.0"],
      "env": {
        "PM_API_URL": "http://localhost:3000",
        "PM_POOL_SECRET": "your-pool-secret",
        "PM_POOL_NAME": "default",
        "PM_WORKER_KEY": "worker-1"
      }
    }
  }
}
```

Give each worker a **distinct** `PM_WORKER_KEY` (e.g. `worker-1`, `worker-2`, …) — it is the stable
handle the server uses to re-bind the same identity across restarts.

Static-token form:

```json
{
  "mcpServers": {
    "project-management": {
      "command": "npx",
      "args": ["-y", "@urtela/pm-mcp-server@0.1.0"],
      "env": {
        "PM_API_URL": "http://localhost:3000",
        "PM_API_TOKEN": "the-token-shown-once"
      }
    }
  }
}
```

Restart the agent (or the Claude Code session) after editing `.mcp.json` so it re-reads the config.

## Documentation

Full setup, agent-pool walkthrough, and the merge-train workflow live in the repo:
[`docs/SETUP.md`](https://github.com/Apodus/project-management/blob/main/docs/SETUP.md) and
[`CLAUDE.md`](https://github.com/Apodus/project-management/blob/main/CLAUDE.md).

## License

MIT
