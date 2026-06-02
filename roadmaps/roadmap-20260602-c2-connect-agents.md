# Campaign C2 — Wizard continuation + .mcp.json snippet (reuse existing pool/token UI)

Per-campaign roadmap materialized from `roadmaps/vision-20260602-setup-distribution.md` §C2
(read that for full context). Tier A. Concurrency-eligible with C1 (only a doc cross-link couples
them). **RESCOPED by the vision verifier:** the agent-pool/token management UI ALREADY EXISTS at
`packages/web/src/pages/settings/users-page.tsx` + `packages/web/src/hooks/use-agent-pool.ts` (pool
create, secret rotate, `useCreatePoolAgents`, token `TokenDialog`). **Do NOT rebuild it.**

**Goal:** walk a first-run admin from "account created" to "an agent connected," ending with a
copy-paste `.mcp.json` — no hand-assembly from docs.

## Deliverables (the ONLY deltas — reuse everything else)

1. **Post-admin wizard steps** in `packages/web/src/pages/setup-page.tsx` (currently a single
   admin-creation step, ~205 lines): after admin → a "create your first project" step → a "connect
   your agents" hand-off step. Keep it skippable (an admin may not want to connect agents yet).
2. **A `.mcp.json` snippet renderer** (a small new component, e.g.
   `packages/web/src/components/mcp-config-snippet.tsx`) that assembles the connection config and
   offers copy-to-clipboard. Default to the **pool-secret** form (matches game_one's `.mcp.json`
   and `packages/mcp-server/src/index.ts` auto-claim via `PM_POOL_NAME`/`PM_POOL_SECRET`), with the
   `PM_API_TOKEN` form as an alternative. Reuse the existing `use-agent-pool` hooks to source/mint
   the pool + secret; reuse the `TokenDialog` "shown once" pattern. Surface this snippet BOTH in the
   wizard "connect agents" step AND (ideally) make it reusable from the existing settings/users page.

## Reuse (do NOT reimplement)

- `packages/web/src/hooks/use-agent-pool.ts` — pool CRUD, `useUpdatePoolSecret`, `useCreatePoolAgents`, token mint.
- `packages/web/src/pages/settings/users-page.tsx` — the existing pool/token management UI + `TokenDialog`.
- The MCP connection contract: `PM_API_URL` + (`PM_POOL_NAME` + `PM_POOL_SECRET`) OR `PM_API_TOKEN`,
  pointing the `project-management` MCP server at the bundle (see game_one `.mcp.json` for the shape).

## Tests / verification (prefer unit > build > manual)

- Web tests (match the existing `*.test.tsx` mock-the-hooks pattern): the new wizard steps render +
  advance (admin → project → connect → done); the snippet renderer produces the correct `.mcp.json`
  text for a given pool/secret (and the token variant) and the copy action fires.
- `pnpm --filter @pm/web test`, `pnpm typecheck`, `pnpm lint` stay green.

## Notes

- The wizard generates CONFIG + instructions; it cannot run the client-side bundle copy (that's
  C1's `distribute.mjs` / `distribute.bat`). The UI copy must say so and point at `docs/SETUP.md`.
- Tokens/secrets are LAN-trust (note it in the UI + SETUP.md).
- Admin-gating: the first-run wizard is inherently the admin; the reusable settings entry stays
  admin-gated like the rest of settings/users.
- Commit as one logical commit: "Add connect-agents wizard steps + .mcp.json snippet (C2)".
