# Campaign C1 — CI guardrail & config truth

**Date:** 2026-06-10
**Vision:** `roadmaps/vision-20260610-repo-quality-consolidation.md` §C1 (authoritative spec)
**Tier:** S (foundation)
**Goal:** every push to main is structurally verified (typecheck/lint/test/build in CI, tests before publish), and every config artifact tells the truth.
**Branch:** `campaign-c1-ci-guardrail` off `main` (bb4052b), in a **dedicated git worktree** — the primary checkout at `D:\code\project-management` is occupied by another agent executing `campaign-notes-followups-hardening` (P2–P4 in flight). DO NOT switch branches or modify files in the primary checkout. PM tracking task: `01KTQS6B7BCVX4BK7128Y8D040`.

## Scope (from the vision, verified findings)

1. **`.github/workflows/ci.yml`** — on push + PR: `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm build`. A separate E2E job is **phase-pinned**: do NOT add it until the in-flight hardening campaign's P4 (E2E stabilization, 20/20) lands on main — leave a commented stub or a follow-up note instead.
2. **`release.yml` verify gate** — add typecheck + test steps before the publish steps (currently: install → build → publish with zero verification).
3. **`.env.example` completion** — add commented `PM_POOL_SECRET`, `PM_POOL_NAME`, `PM_WEB_DIST_PATH` entries matching the existing one-line comment discipline; sync CLAUDE.md env table if it diverges.
4. **Remove dead `PM_SESSION_SECRET`** — verified read nowhere in code. Three locations: `.env.example:5`, CLAUDE.md env table, `docs/design/high-level-design.md:1306`. Document the actual auth mechanism in its place (verify what it actually is by reading the auth code — token/cookie mechanism — before writing).
5. **Vitest unification** — server/shared/web on `^3`, integrator-ref/mcp-server on `^4.1.7`. Unify on ONE major (prefer the newer if all suites pass); if a real incompatibility appears, document the split as intentional in both package.jsons and stop — documentation beats a forced upgrade. Own phase, full-suite gate.
6. **De-flake `packages/integrator-ref/tests/batch.test.ts:1101`** — the wall-clock overlap assertion (`latest-start < earliest-end for ≥2 members`) failed under machine load on 2026-06-10. Replace with an instrumented concurrency probe (e.g. an in-flight counter peak inside the fake verify step) that proves overlap without depending on scheduler timing. This test WILL flake on shared CI runners if left as-is — it gates ci.yml's usefulness.

## Verification

- CI proven by deliberate red: after the workflow lands on the branch, push a throwaway commit (or use a scratch branch) with a type error / failing test and confirm the run goes red on the right gate; then confirm green on the real branch. Pushing the campaign branch to origin is authorized for CI validation; do NOT push to main, do NOT merge PRs.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` green locally in the worktree at every commit.
- batch.test.ts de-flake proven by running the integrator suite under parallel load (or repeated runs) — the probe must be deterministic.

## Do-not-touch (other agent's in-flight scope)

`packages/server/tests/openapi-drift.test.ts`, `packages/server/src/db/migrations/meta/`, `note.service.ts` dedup internals, `tests/e2e/`.

## Engineering values

No investment ceiling; automatic > manual; getting it right > getting it done fast. One logical commit per phase; full suite green at every commit.

## Phases (approved by adversarial verify 2026-06-10)

- **P0** — worktree setup: `pnpm install` in `D:\code\pm-c1-ci-guardrail`, baseline gate (typecheck/lint/test/build), GitHub API access for run observation (git-credential-fill token or gh CLI). No commit.
- **P1** — de-flake `batch.test.ts` overlap test: rendezvous fake `runVerify` (inFlight counter + barrier at ≥2 + 10s safety timer → clean failure not hang); SLEEP_300 removed from the three overlap-test requests only. Verifier confirmed: barrier cannot deadlock (drain loop launches verifies un-awaited before Promise.race), and a bare counter probe WOULD re-flake (rebases serialize admissions).
- **P2** — `.github/workflows/ci.yml`: push+PR, one `verify` job ubuntu-latest (timeout 25m, bump to 35-40 if integrator suite needs it), pnpm/action-setup → setup-node 22 cache:pnpm → install --frozen-lockfile → typecheck → lint → test → build (separate named steps) + format:check; E2E job as commented stub with P4 phase-pin header. Deliberate-red proof: green on branch, then scratch branch `ci-red-probe` with type-error/lint/failing-test probes red at the right steps, then delete probe branch.
- **P3** — `release.yml` verify gate: typecheck + test after install; `workflow_dispatch` trigger; `if: startsWith(github.ref, 'refs/tags/v')` guard on publish steps. Dry-run via temporary branch trigger on a scratch branch (gh workflow run will refuse until on default branch — expected).
- **P4** — config/docs truth: PM_SESSION_SECRET removed from `.env.example:5` / CLAUDE.md:404 / high-level-design.md:1306 with the REAL mechanism documented (opaque random tokens bcrypt-hashed, pm_session httpOnly cookie, no signing secret — verified against auth.service.ts:34,99-108); .env.example gains PM_POOL_SECRET/PM_POOL_NAME/PM_WEB_DIST_PATH; CLAUDE.md table gains the pool rows.
- **P5** — vitest unification UP to ^4.1.7 (server/shared/web + @vitest/expect lockstep; configs verified v4-clean; vite ^6 in peer range). Fallback: revert + document intentional split. Held last (lockfile churn vs in-flight campaign).
- **P6** — close-out: record outcomes here, final gate, `git diff --stat main...campaign-c1-ci-guardrail` proves do-not-touch list respected.

Watch-items from verify: 25m timeout may be tight (bump not chase); if Apodus is a GitHub org, gitleaks may need GITLEAKS_LICENSE — judge green by the ci.yml run, not the rollup; expect CLAUDE.md + pnpm-lock.yaml merge conflicts with the other campaign at integration time; push+PR double-runs are cost-only (concurrency group mitigates).

---

## Close-out (executed 2026-06-10, branch `campaign-c1-ci-guardrail`)

All six scope items shipped. Commits (one logical commit per phase; P2 took three
extra friction commits, see below):

- **P1** `2d68c0a` — de-flake `batch.test.ts`: rendezvous probes replace wall-clock races.
  The overlap test now counts in-flight verifies inside a fake `runVerify` (barrier at ≥2,
  10s safety timer); `DELAY_FAIL` ("sleep 2; exit 1") was replaced across its five consumers
  with `headFailRendezvous` (head verify blocks until every dependent suffix member's verify
  has started, then returns a synthetic real failure) after the Step-7 invalidation test
  flaked under load exactly as predicted for the overlap test. **Proof: 10 consecutive green
  runs of tests/batch.test.ts (49 tests each)**, plus full integrator suite green.
- **P2** `64b0fde` + friction `9733aae`/`b13c5f7`/`1565d43` — `.github/workflows/ci.yml`:
  one verify job (ubuntu-latest, 25m timeout, concurrency group), install --frozen-lockfile →
  typecheck → lint → test → build as named steps; E2E job committed as a phase-pinned stub
  (enable when notes-followups-hardening P4 lands); format:check committed as a DISABLED stub
  (main is not prettier-clean: 359 files at printWidth 80 vs config 100 — pre-existing drift;
  enable with a dedicated tree-wide `pnpm format` commit after in-flight campaigns land).
  - **Deliberate-red proof** (scratch branch `ci-red-probe`, deleted from origin after):
    type error → red at Typecheck (run 27255283287); lint violation → red at Lint
    (27255357637); failing unit test → red at Test (27255431430). Steps gate correctly.
  - **The guardrail caught a real production bug on its first run**: 13 integrator tests
    red on the hosted runner — `GitOps.rebaseOnto` ran `git rebase` with NO explicit
    committer identity; pool clones have no configured user, so on any identity-less host
    (every CI runner, any fresh server) a commit-REPLAYING rebase fails "Committer identity
    unknown", which the catch misclassified as a CONFLICT → spurious rejects. Invisible on
    dev machines (global identity always present); reproduced + fix proven on Ubuntu/WSL
    with no global git identity (batch.test.ts 49/49 + all four spawn-the-built-integrator
    E2E files green). Fix = the established `-c user.email/-c user.name/-c commit.gpgsign`
    idiom (`COMMIT_IDENTITY_ARGS`) on `rebaseOnto` + `materializeConflict` (1565d43).
  - CI Test step runs `pnpm test --concurrency=1` (serialize package suites on the 2-vCPU
    runner for timing margin; the `pnpm test -- --concurrency=1` form forwards the flag into
    vitest and fails — pnpm passes script args verbatim). **Green run: 27257860605 (1565d43).**
- **P3** `10a3dba` — `release.yml` verify gate: typecheck + full test after install, before
  any build/publish; `workflow_dispatch` trigger; both publish steps guarded by
  `if: startsWith(github.ref, 'refs/tags/v')`. **Dry-run proven on the scratch branch via a
  temporary branch trigger: run 27258000315 — install→typecheck→test→build green, BOTH
  publish steps SKIPPED.** The temp trigger never touched the campaign branch.
- **P4** `0bd01fd` — config/docs truth: dead `PM_SESSION_SECRET` removed from `.env.example`
  / CLAUDE.md / high-level-design.md with the real mechanism documented (opaque random
  64-hex tokens bcrypt-hashed server-side; httpOnly `pm_session` cookie; Authorization
  header for API tokens; no signing secret — verified against auth.service.ts +
  middleware/auth.ts + routes/auth.ts). `.env.example` gains PM_WEB_DIST_PATH /
  PM_POOL_SECRET / PM_POOL_NAME; CLAUDE.md env table gains the pool rows.
  `PM_SESSION_SECRET` now greps only in this historical roadmap.
- **P5** `c494c85` — vitest UNIFIED on ^4.1.7 (server/shared/web + web's @vitest/expect,
  lockstep with integrator-ref/mcp-server). No incompatibility appeared: all five suites
  pass on v4 unchanged (shared 467 / server 1455 / web 393 / integrator 293 / mcp), full
  turbo gate green. The intentional-split fallback was not needed.

**Residual known risks (documented, deliberate):**
- `batch-e2e.test.ts` keeps its own wall-clock `DELAY_FAIL` + marker-mtime overlap
  assertions (out of P1's named scope — batch.test.ts only). CI margin comes from
  `--concurrency=1`; if these flake on the runner, apply the same rendezvous treatment.
- format:check and the E2E job are commented stubs with explicit enable-when headers.
- Expected merge conflicts with the in-flight notes campaign at integration time:
  CLAUDE.md (env table region) + pnpm-lock.yaml (vitest resolutions).

Verification at close: campaign CI run green on the runner, full local gate
(typecheck/lint/test/build) green on the final tree, `git diff --stat main...HEAD`
touches 11 files — none on the do-not-touch list.
