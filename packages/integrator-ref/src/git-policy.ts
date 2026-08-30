import type { SimpleGit } from "simple-git";
import type { Logger } from "./logger.js";

/**
 * Repo-local git config written into every clone the integrator owns, so git
 * never recurses into a submodule on its own initiative.
 *
 * ── Why (measured, not inferred) ───────────────────────────────────────────
 *
 * The integrator manages the cross-repo gitlink BY HAND: assembly authors the
 * 160000 entry, `fetchFromPath` + `materializeSubmoduleWorktree` populate the
 * path, and §14.8 of the deployment guide already forbids a verify command from
 * running `submodule update --init` there. Automatic recursion is therefore
 * pure liability — git chasing a pointer we are in the middle of rewriting.
 *
 * `fetch.recurseSubmodules=no` closes the headline failure. `git fetch` exits 1
 * with `Could not access submodule '<path>'` when BOTH hold:
 *
 *   1. the fetch advances main across a commit that CHANGES the managed
 *      gitlink, and
 *   2. the gitlink path in the working tree is populated but is not an openable
 *      git repo.
 *
 * Condition 2 is exactly what `materializeSubmoduleWorktree` (git-ops.ts) leaves
 * behind in the OUTER slot, permanently — the outer pool is constructed with
 * `gitlinkPurgePaths: []` on purpose, and `reset --hard` / `clean -fdx` are
 * documented-blind to content at a committed gitlink path (see
 * WorktreeOptions.gitlinkPurgePaths). So an outer slot is poisoned from its
 * first cross-repo assembly onward and ANY later gitlink bump on outer main —
 * including one the train itself landed — kills the next fetch in that slot.
 *
 * Note what is NOT in that list: a DANGLING gitlink target. Measured — the fetch
 * fails byte-identically whether the recorded target is reachable or not. The
 * dangling target that opened this campaign was incidental to this failure; the
 * fix is broader than the campaign's title, and "the fetch succeeded" is NOT
 * evidence that the gitlink is sane.
 *
 * The failure lands inside `assembleGroup`'s try BEFORE any classification runs,
 * which is why the outage surfaced as `gitlink_mismatch` — the catch-all reason
 * — carrying a reject that asserted its own innocence.
 *
 * `submodule.recurse=false` is here for the INNER lane, whose vendored nested
 * submodules `materializeSubmoduleWorktree` deliberately initializes into real,
 * openable checkouts. Measured on that shape, with a global
 * `submodule.recurse=true` in the operator's ~/.gitconfig and a nested gitlink
 * advanced to an absent object: `resetForAttempt`'s `reset --hard origin/main`
 * fails **exit 128** (`failed to unpack tree object …`) and its `checkout` fails
 * exit 1 — one step PAST the fetch the other key protects. `fetch.
 * recurseSubmodules=no` alone does not save it; the repo-local `false` defeats
 * the global `true` in both directions, which is the whole point of writing
 * policy repo-locally rather than trusting the machine's config.
 *
 * It is NOT here for `read-tree`, which git documents as honoring
 * `submodule.recurse`: measured inert for our invocation, which passes
 * `--prefix` with no `-u` and writes a throwaway `GIT_INDEX_FILE`, so there is
 * no working-tree update for recursion to attach to. Recorded so nobody
 * re-derives it.
 *
 * Neither key reaches `materializeSubmoduleWorktree`'s EXPLICIT `submodule
 * update --init --recursive`: `git submodule update` carries no
 * `--recurse-submodules` option, so `submodule.recurse` does not apply to it.
 * Verified against production code, not assumed (group-assembly.test.ts's
 * nested-submodule case runs with this policy applied to its inner pool clone).
 *
 * `push.recurseSubmodules` is deliberately ABSENT: both `check` and `on-demand`
 * were measured inert against the poisoned slot, so no test could ever go red
 * for it, and a key we cannot pin is a key we cannot defend.
 *
 * ── Why repo-local config rather than per-invocation flags ─────────────────
 *
 * The integrator drives git through three mechanisms — simple-git methods,
 * direct `spawn` via runGit/runGitCapture, and runGitStdin — across roughly
 * forty call sites, plus verify child processes we did not write. Only
 * `.git/config` is read by all of them, so only `.git/config` closes the class
 * instead of patching today's instances of it.
 *
 * ── Scope caveat ───────────────────────────────────────────────────────────
 *
 * `git config --local` does NOT fail when run from a directory whose `.git` is
 * invalid: it walks up and silently writes into an ANCESTOR repository's config
 * (exit 0). So "we only ever write config into a repo we own" holds while the
 * slot is a valid repo, or while `cfg.worktreeRoot` has no repository ancestor.
 * Both hold in production (slots live under a dedicated worktree root) and in
 * the tests (`mkdtempSync(tmpdir())`), but a worktree root nested inside a
 * checkout would widen the blast radius of a damaged slot.
 */
export const GIT_LOCAL_POLICY: readonly (readonly [key: string, value: string])[] = [
  ["fetch.recurseSubmodules", "no"],
  ["submodule.recurse", "false"],
];

/**
 * Write {@link GIT_LOCAL_POLICY} into `git`'s repo-local config. Idempotent —
 * `git config --local k v` is single-valued, so reapplication is a no-op write.
 *
 * NEVER THROWS, deliberately. The two callers are the clone lifecycle's only
 * owners — `createWorktree.ensureExists()` and `binding-clone.ensureBind()` —
 * and a throw from either is strictly worse than a policy-less repo:
 *
 *  - `ensureAll()` is wrapped in `logger.fatal` + `process.exit(1)` at three
 *    sites in index.ts. A slot whose `.git` exists but is INVALID (interrupted
 *    clone, power loss, a `.git/config.lock` an antivirus scanner is holding)
 *    sails through `ensureExists()` today — `needsClone` is false and the reuse
 *    branch touches git not at all — so a throw here would take the whole daemon
 *    down at boot, permanently, over one damaged slot. That slot is currently
 *    SELF-HEALING: it fails its first `resetForAttempt`, batch.ts detects the
 *    corruption and calls `pool.repair()` → `wt.repair()` → rm -rf → a fresh
 *    clone → this policy applied. A throw pre-empts that repair and replaces it
 *    with a crash-loop.
 *  - In `binding-clone`, every failure is already funnelled through
 *    `resolveRefInClone`'s catch, which reports it as `null` = "this member's
 *    ref does not exist" — an actively misleading reject. This campaign exists
 *    to end that failure mode, not to add a new source of it.
 *
 * Be precise about what the warning buys, because the temptation to "tidy" this
 * back into a throw is real: `detectCorruption()` owns the CORRUPT-repo case
 * only. A HEALTHY repo whose config merely could not be written (a stale
 * `.git/config.lock`, a file lock) passes `resetForAttempt` fine, is never
 * detected, and stays policy-less until the next daemon restart. The log line is
 * the only signal in that case — which is why it is a warning and not a debug.
 */
export async function applyGitLocalPolicy(git: SimpleGit, logger?: Logger): Promise<void> {
  try {
    for (const [key, value] of GIT_LOCAL_POLICY) {
      await git.raw(["config", "--local", key, value]);
    }
  } catch (err) {
    logger?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "could not write the git recursion policy into this clone; git may recurse into a managed gitlink here until the next restart",
    );
  }
}
