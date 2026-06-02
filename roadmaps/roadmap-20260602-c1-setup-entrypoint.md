# Campaign C1 — Reproducible setup entry point + parameterized distribute

Per-campaign roadmap materialized from `roadmaps/vision-20260602-setup-distribution.md` §C1
(read that for full "Where we are" + invariants). Tier S; the recommended starting campaign.
Concurrency-eligible with C2 (only a doc cross-link couples them).

**Goal:** a clone-to-running operator can stand up the PM and deploy to a client from any OS, via
committed docs + one parameterized script.

## Deliverables

1. **`README.md`** (root) — human getting-started: what this is, prerequisites, install (`pnpm install`),
   dev (`pnpm dev`), prod (`pnpm build` + `pnpm start:prod`), and "where to go next" (links to
   `docs/SETUP.md`, `CLAUDE.md`, `docs/integrator-deployment.md`). Lean; do NOT duplicate CLAUDE.md.
2. **`docs/SETUP.md`** — the full first-time journey: install server → first-run admin (the web
   wizard) → create a project → **connect agents** (point at C2's wizard step + the existing
   `settings/users` pool/token UI; show a sample `.mcp.json`) → **optional integrator** (LINK to
   `docs/integrator-deployment.md` §3/§12 — do NOT duplicate). One short "distribution models" note
   naming both the vendored-bundle approach and the future `npx` option. State tokens are LAN-trust.
3. **`scripts/distribute.mjs`** — cross-platform Node (ESM) successor to `distribute.bat`. Reads a
   **gitignored** `distribute.config.json` (`{ targets: [{ name, mcpDest, integratorDest, docsDest,
workerDocDest }] }`); builds the MCP + integrator bundles (reuse the existing per-package bundle
   scripts / `pnpm --filter … build` + bundle) and copies the 4 artifacts to each target's dests.
   Mirror what `distribute.bat` does today (MCP bundle, integrator daemon, operator guide, worker
   workflow doc). Support `--config <path>` and a `--dry-run`.
4. **`distribute.config.example.json`** — committed template with placeholder paths + a comment.
5. **`.gitignore`** — add `distribute.config.json` (keep the real local config out of the repo, like
   `distribute.bat` is). `distribute.bat` stays as the existing local wrapper (gitignored) — do not
   delete it; the new script is the reproducible path.

## Tests / verification (prefer unit > build > manual)

- A unit/integration test (Node, in the repo's test runner or a `scripts/`-level vitest) that runs
  `distribute.mjs` against a temp `distribute.config.json` with a temp target dir and asserts the 4
  artifacts land (build the bundles first, or stub the build step). At minimum: assert the script
  resolves config, errors clearly on a missing bundle, and copies to the target.
- `pnpm typecheck && pnpm lint && pnpm test` stay green (the script is standalone; don't break the build).
- Manual: a fresh-clone dry-run of SETUP.md's commands is internally consistent (paths/scripts exist).

## Notes

- Engineering values: no investment ceiling; the script should be the genuinely-right reproducible
  tool, not a thin port. But do NOT over-build (no CLI framework — plain Node arg parsing).
- Cross-link with C2: SETUP.md's "connect agents" section references the wizard step C2 adds; keep
  the reference resilient (describe the flow even if C2 lands after).
- Commit as one logical commit: "Add reproducible setup docs + cross-platform distribute script (C1)".
