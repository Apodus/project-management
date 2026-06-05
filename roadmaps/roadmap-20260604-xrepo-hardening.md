# Campaign — Cross-Repo Train Hardening (GitHub URLs + inner LFS + atomic grouping)

Hand-authored campaign roadmap. Driven by `/campaign`. Motivated by the **first real
exercise** of the Phase 7.3 cross-repo merge path against the setup it was never tested on:
**remote GitHub URLs** for `linked_repos[].path` and an **inner repo that uses Git LFS**
(rynx's vendored `libclang.dll`). Two real bugs surfaced live:
1. The binding clone did `simpleGit(repo.path)` — throws on a URL (only worked with local bare repos).
2. `materializeSubmoduleWorktree` re-smudges inner LFS files via the OUTER repo's LFS endpoint → 404
   (`gitlink_mismatch`), because the inner's LFS objects live in the inner repo's LFS store.
Plus a usability gap the operator hit: the **submit→group race** (the daemon's SSE-triggered pickup
grabs an ungrouped member before it can be grouped).

**Goal:** make the cross-repo path actually work end-to-end over remote URLs with an inner LFS
repo, and close the submit-group race — all with tests, no live whack-a-mole. The single-repo
train is already production-ready; this hardens the cross-repo frontier.

**Engineering values (non-negotiable):** No investment ceiling — bar is end-result quality. Getting
it right > fast. The merge train is the crown jewel: prefer the most correct fix, adversarially
verified, with regression tests. NO network in tests — local git/LFS fixtures only.

**Established conventions to honor:**
- `packages/integrator-ref` (`@urtela/pm-integrator`): the reference daemon. `git-ops.ts` wraps
  simple-git; `group-assembly.ts` drives the §14.3 assemble protocol; `index.ts` wires the lanes.
  Tests are real-git, gated `describe.skipIf(!GIT_AVAILABLE)`; git-lfs 3.7.1 is installed on the host.
- PM-side: Zod-3 canonical in `@pm/shared` + route-local Zod-4 mirror in `@pm/server`; Drizzle
  service in a transaction; MCP worker tool in `packages/mcp-server` mirrors existing shapes
  (`pm_request_merge`, `pm_request_merge_group`).
- Absent/empty `linked_repos` ⇒ single-repo, byte-identical to 7.2. The prime invariant — **outer
  `main` is never advanced to a gitlink whose assembled tree has not passed verify** — is sacrosanct.
- Commands: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`,
  `pnpm --filter @urtela/pm-integrator test`, `pnpm --filter @pm/server test`,
  `pnpm --filter @pm/shared test`, `pnpm --filter @urtela/pm-mcp-server test`.

---

## P1 — Binding clone supports remote-URL `linked_repos[].path` (lock in + test)

- **Change:** The fix is ALREADY implemented in `packages/integrator-ref/src/index.ts` (`makeLane`):
  the per-repo binding clone is now a lazily-created local `--mirror` clone of `repo.path`, fetched
  before each `resolveRefInClone`, instead of `simpleGit(repo.path)` (which throws on a URL). Lock it
  in: read the current diff, confirm correctness, and add an integration test (real-git, skipIf no
  git) — set up a local source repo with a branch + a known commit, build a lane whose `path` is that
  repo (a local path and/or a `file://` URL), assert `resolveRefInClone` resolves the branch and the
  full sha (and returns `null`, not throws, for an absent ref + after the lazy mirror is created).
  Confirm the existing group-integration/batch tests still pass (they mock the lane, so should be
  untouched). Consider edge cases: the mirror dir already exists (re-run), fetch picks up a
  newly-pushed ref.
- **Verify:** `pnpm --filter @urtela/pm-integrator test` (new binding test + no regressions);
  `pnpm typecheck`; `pnpm --filter @urtela/pm-integrator build`.
- **Depends on:** nothing (fix present in working tree).

## P2 — Materialize is LFS-aware: inner LFS files land as REAL binaries in the outer worktree

- **Change:** Fix the `gitlink_mismatch` from `materializeSubmoduleWorktree` (`git-ops.ts`)
  re-smudging inner LFS files via the OUTER repo's LFS endpoint (→ 404). The inner pool worktree
  (rebased to `Ri`) already holds the correctly-smudged files. Approach: run the existing
  `read-tree --prefix` + `checkout-index -a -f` with **`GIT_LFS_SKIP_SMUDGE=1`** in the env (regular
  files written correctly; LFS files land as POINTERS, no download, no 404), then **overlay-copy the
  LFS-tracked files' real content from the inner worktree** into the outer `gitlinkPath`
  (`git -C <innerWt> lfs ls-files` → for each, copy `<innerWt>/<f>` → `<outerWt>/<gitlinkPath>/<f>`).
  Thread the inner worktree path into `materializeSubmoduleWorktree` (signature change) and its
  `group-assembly.ts` caller (which already has `innerWt.path`). When the inner has NO LFS files the
  result is byte-identical to today. Handle: git-lfs not installed (degrade gracefully / clear
  error), nested paths, the overlay preserving exec bits where relevant.
- **Verify:** integrator-ref test with a **LOCAL git+LFS fixture** (NO network): an inner repo with an
  LFS-tracked binary (local LFS store via a bare repo / `file://` / `lfs.url` to a local dir),
  materialized into an outer worktree at a gitlink path — assert the materialized file is the REAL
  binary content (not a pointer, not an error). Plus a no-LFS-inner test proving byte-identical
  behavior. Existing `group-assembly` tests green. `pnpm --filter @urtela/pm-integrator test`;
  typecheck; build.
- **Depends on:** nothing (same package as P1 — serialize the commits).

## P3 — Atomic submit-and-group (eliminate the pickup race)

- **Change:** Close the window where the daemon's SSE-triggered pickup grabs an ungrouped member
  before it can be grouped. Add an **atomic submit-members-and-form-group** path so members are never
  individually pickable: extend `pm_request_merge_group` (and the underlying server route + service)
  to ALSO accept member **submission specs** (`{ branch | commit_sha, verify_cmd?, task_id? }`),
  creating all member requests AND the forming group in **one transaction** (members created already
  group-bound / `forming`, never plain-`queued`-and-pickable). Canonical Zod-3 in `@pm/shared` +
  route-local Zod-4 mirror; the service does it transactionally; update the MCP tool param schema in
  `packages/mcp-server`. KEEP the existing "group already-queued request ids" form working
  (back-compat, union input). Confirm the integrator's pickup query cannot select a member of a
  forming group (verify the existing claim/pickup SQL excludes grouped/forming members; if not, that
  exclusion is part of this phase).
- **Verify:** `pnpm --filter @pm/server test` (atomic create+group in one txn; members never reach a
  pickable state; back-compat id-list form still works; bad specs rejected); `pnpm --filter @pm/shared
  test` (schema); mcp-server tool test if a harness exists; typecheck.
- **Depends on:** nothing (PM-side; independent of P1/P2 — commander serializes commits).

## P4 — Seal: end-to-end cross-repo integration test + docs + full suite

- **Change:** An integration test exercising the WHOLE group path over URL/local-path linked repos
  with an inner LFS file — bind (mirror clone) → assemble → materialize (LFS overlay) → land — using
  local fixtures only (no network). Update `docs/integrator-deployment.md` §14 to document: remote-URL
  `linked_repos[].path` support (the binding mirror), the inner-LFS materialize behavior, and the new
  atomic submit-group tool form. Final pass: one commit per phase, clean history.
- **Verify:** full `pnpm test` + `pnpm typecheck` + `pnpm lint` + `pnpm build` all green; the new
  integration test passes; docs accurate (don't claim more than is implemented).
- **Depends on:** P1, P2, P3.

---

## Cross-phase invariants

- Single-repo + existing 7.2/7.3 behavior never regresses; absent `linked_repos` = byte-identical.
- The prime invariant holds: outer `main` is never advanced to a gitlink whose assembled tree has
  not passed verify — not in land, not in recovery.
- NO network in tests — local git/LFS fixtures only (git-lfs is installed on the host).
- Zod-3 canonical / Zod-4 route-local split preserved for any new schema.
- `pnpm test` + `pnpm typecheck` + `pnpm lint` + `pnpm build` green at every phase boundary.
