# Campaign — Integrator Admin Config UI + `clean_keep`

Hand-authored single-campaign roadmap (not part of a `/vision` arc). Driven by `/campaign`.
Motivated by game_one daemon bring-up friction: the entire `settings.integrator` block and the
top-level `gitRepoUrl` are REST-only today (no UI), and the daemon's per-attempt
`git clean -fdx` wipes out-of-git build inputs (e.g. a ~100MB libclang.dll / codegen output)
with no way to preserve them.

**Goal:** Make the merge-train daemon fully configurable by a non-web admin from the browser —
a dedicated **Integrator** settings page covering every `settings.integrator` field + the
top-level `gitRepoUrl` + a `linked_repos` editor — and add a `clean_keep` capability so declared
paths survive the daemon's per-attempt clean. No human should ever hand-write a settings PATCH.

**Engineering values (non-negotiable):** No investment ceiling — bar is end-result quality, not
minimum diff. Getting it right > fast. Less code in the right sense (reuse the resolver page's
read-merge-write pattern, the `resolverConfigFromProject` lib shape, the autonomy/route schemas).

**Established conventions to honor (from the repo):**

- Shared Zod schemas are the single source of truth in `@pm/shared` (Zod-3 canonical), with a
  route-local Zod-4 mirror in `packages/server/src/routes/projects.ts` (the established split —
  keep them in lockstep; see the `verify_steps` / `resolver` precedent).
- Settings writes are PARTIAL and read TOLERANTLY: the recent fix made the core settings
  sub-blocks `.partial().optional()`; every settings page does a client-side read-merge-write that
  preserves sibling sub-blocks. `settings` is REPLACED wholesale server-side, so the merge MUST
  happen client-side (fetch fresh, merge, PATCH the whole object).
- Web: React 19 + TanStack Router/Query + Zustand + Radix-based `@/components/ui/*`. Settings pages
  live in `packages/web/src/pages/settings/`, registered in `packages/web/src/router.tsx`, nav in
  `packages/web/src/components/layout/sidebar.tsx`. Admin-gate via `useCurrentUser()` `role==="admin"`.
- The conflict-resolution page (`conflict-resolution-page.tsx`) + `lib/resolver.ts` +
  `useUpdateResolverConfig` are the canonical template to mirror for THIS page.
- The integrator config is consumed by the reference daemon in `packages/integrator-ref`
  (`src/config.ts` maps `settings.integrator.*` → daemon config; `src/worktree.ts` `resetForAttempt`
  is the SINGLE clean chokepoint every pool/loop/batch/group path calls).
- Commands: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`,
  `pnpm --filter @pm/shared test`, `pnpm --filter @pm/server test`,
  `pnpm --filter @pm/web test`, `pnpm --filter @urtela/pm-integrator test`.

---

## P1 — `clean_keep` end-to-end (schema + daemon + tests) — unblocks daemon bring-up

- **Change:** Add `clean_keep: z.array(z.string().min(1)).default([])` to `integratorSettingsSchema`
  in BOTH `@pm/shared` (`packages/shared/src/schemas/project.ts`, Zod-3) AND the route-local Zod-4
  mirror (`packages/server/src/routes/projects.ts`) — kept in lockstep. In `packages/integrator-ref`:
  `src/config.ts` maps `ic.clean_keep ?? []` into the daemon config (e.g. `cleanKeep: string[]`);
  thread it through the worktree-construction opts so `src/worktree.ts` `resetForAttempt()` builds
  its clean argument list as `["-d", "-x", ...cleanKeep.flatMap((p) => ["-e", p])]` (i.e.
  `git clean -fdx -e <pattern>...`). This is the ONLY clean site — all of batch/loop/group-assembly/
  group-recovery/resolver-pool go through `resetForAttempt`, so one change covers every path. Keep
  `clean_keep` absent/empty ⇒ byte-identical to today (`-fdx`, no excludes).
- **Verify:** `pnpm --filter @pm/shared test` (clean_keep defaults to `[]`, round-trips a list);
  `pnpm --filter @pm/server test` (PATCH `settings.integrator` with `clean_keep` persists + round-trips
  through GET; absent ⇒ `[]`); `pnpm --filter @urtela/pm-integrator test` (worktree clean-args builder
  emits `-e` per kept path; empty ⇒ plain `-fdx`); `pnpm typecheck` + `pnpm build`.
- **Depends on:** nothing.
- **NOTE:** At end of P1 the daemon-side capability is complete and shippable on its own — game_one
  can set `clean_keep` via REST immediately even before the UI lands.

## P2 — Web data layer: integrator config extract + read-merge-write update hook

- **Change:** Mirror the resolver pattern. Add `packages/web/src/lib/integrator.ts` with
  `integratorConfigFromProject(project)` — extract `settings.integrator` applying schema defaults
  for absent scalar fields (parallelism 1, verify_timeout_sec 600, git_remote "origin",
  git_main_branch "main", heartbeat_interval_sec 30, cache_enabled false, cache_mode "off",
  enabled false, linked_repos [], clean_keep [], verify_steps []), keeping optional fields
  (verify_command, worktree_root, worktree_name, slo, resolver, token-ish) absent when the server
  omitted them. Add `IntegratorConfig` + `LinkedRepo` types to `packages/web/src/lib/api.ts`. Add
  `useUpdateIntegratorConfig(projectId)` to `packages/web/src/hooks/use-projects.ts` that: fetches
  fresh, MERGES the new integrator block into `settings.integrator` (PRESERVING the `resolver`
  sub-block and every other settings sibling — ai_autonomy/workflow/git/webhooks/epic_categories),
  AND sets the top-level `gitRepoUrl` in the SAME PATCH; invalidates project + train queries. The
  resolver sub-block must never be dropped (the integrator block owns it as a child).
- **Verify:** `pnpm --filter @pm/web test` — `integratorConfigFromProject` defaulting + optional
  omission; the hook's merge preserves `resolver` + other settings siblings, includes `gitRepoUrl`,
  and round-trips `clean_keep` / `linked_repos`. `pnpm typecheck`.
- **Depends on:** P1 (clean_keep in the shape/types).

## P3 — Integrator settings page (admin): scalar form + `clean_keep` list + `linked_repos` editor

- **Change:** Add `packages/web/src/pages/settings/integrator-page.tsx` (mirror conflict-resolution
  page structure: project-guard, admin-gate via `role==="admin"`, hydrate-from-project `useEffect`,
  `isError` surfacing, Saved affordance). Fields: `gitRepoUrl` (top-level), `enabled` (Switch),
  `worktree_root`, `parallelism` (int ≥1), `verify_timeout_sec` (int ≥1), `git_remote`,
  `git_main_branch`, `verify_command`, `clean_keep` (add/remove string-list editor), and a
  `linked_repos` repeater editor (rows of `{name, path, role: inner|outer, gitlink_parent?,
  gitlink_path?}` with add/remove + a role Select). Client-side validation mirroring the server
  refine: when `enabled` is true, require (`verify_command` non-empty OR — out of scope here — a
  verify_steps DAG) AND `worktree_root`; numbers parsed/validated like the resolver page (string
  state for inputs). DEFER the full `verify_steps` DAG editor and `slo`/`cache`/`resolver` (resolver
  already has its own page) — show a short "advanced fields are REST-only for now" note linking the
  deployment guide. Register the route `/projects/$projectId/settings/integrator` in `router.tsx`;
  add an admin-only **Integrator** nav entry in `sidebar.tsx` near Conflict Resolution.
- **Verify:** `pnpm --filter @pm/web test` — page renders; admin gate (non-admin sees the gate);
  enabled-without-verify_command/worktree_root disables Save + shows the validation message; Save
  calls `useUpdateIntegratorConfig` with the merged payload incl. `gitRepoUrl`, `clean_keep`,
  `linked_repos`; add/remove rows in both editors. `pnpm typecheck` + `pnpm lint` + `pnpm build`.
- **Depends on:** P2.

## P4 — Docs, deployment-guide wiring, full-suite seal

- **Change:** Update `docs/integrator-deployment.md` to point operators at the new UI for the
  `settings.integrator` + `gitRepoUrl` config (replacing the raw-PATCH instructions; keep a REST
  appendix for the advanced/deferred fields and `verify_steps`). Document `clean_keep` (what it
  excludes from `git clean -fdx`, and the host-side alternative of placing the input outside the
  worktree on PATH). Add a one-line pointer in `CLAUDE.md`'s merge-train section. Final pass: one
  commit per phase, clean history.
- **Verify:** full `pnpm test` + `pnpm typecheck` + `pnpm lint` + `pnpm build` all green;
  `pnpm test:e2e` if the settings nav is covered. No regressions in the existing settings pages.
- **Depends on:** P3.

---

## Cross-phase invariants

- Existing settings pages (resolver, notifications, categories, automation) and the train dashboard
  never regress — this campaign is additive plus the one `clean_keep` field.
- Every settings write stays a client-side read-merge-write that preserves sibling sub-blocks; the
  `resolver` block (child of `integrator`) is never dropped by the integrator page, and the
  integrator block is never dropped by the resolver page.
- `clean_keep` absent/empty ⇒ daemon clean is byte-identical to today (`git clean -fdx`).
- Zod-3 canonical (`@pm/shared`) / Zod-4 route-local mirror split preserved and kept in lockstep.
- Admin-only: the integrator page is gated to `role==="admin"` (config is operator machinery).
- `pnpm test` + `pnpm typecheck` + `pnpm lint` + `pnpm build` green at every phase boundary.
