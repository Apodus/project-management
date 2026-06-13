import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SimpleGit } from "simple-git";
import { killTree } from "./kill-tree.js";

async function pathExistsLocal(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ─── Result types ─────────────────────────────────────────────────

export interface RebaseSuccess {
  ok: true;
  treeSha: string;
}

export interface RebaseConflict {
  ok: false;
  conflictingFiles: string[];
  stderr: string;
}

export type RebaseResult = RebaseSuccess | RebaseConflict;

/**
 * Campaign A4 P2. The result of `git revert <sha>` on the current worktree. On
 * success the worktree HEAD is the revert commit (one new commit undoing `sha`);
 * on a textual conflict the revert is `--abort`ed (no partial state) and
 * `conflict: true`; any other git failure is `{ ok: false, conflict: false }`
 * (fail-safe — never a partial state).
 */
export type RevertResult = { ok: true } | { ok: false; conflict: boolean; stderr: string };

/**
 * Phase 7.6 §5.2 step 1. The result of materializing a textual rebase conflict
 * IN PLACE — the worktree is left mid-rebase with conflict markers + `UU` index
 * entries (the resolver agent's working material), unlike `rebaseOnto` which
 * `--abort`s. `conflictingFiles` is the `--diff-filter=U` set git reported.
 */
export interface MaterializeConflictResult {
  conflictingFiles: string[];
}

export interface PushSuccess {
  ok: true;
  pushedSha: string;
}

export interface PushFailure {
  ok: false;
  reason: "non_fast_forward" | "auth" | "network" | "other";
  stderr: string;
}

export type PushResult = PushSuccess | PushFailure;

export interface VerifyResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  logPath: string;
  /**
   * Set ONLY when the child failed to spawn (e.g. ENOENT/EACCES) — the
   * `child.on("error")` handler captures the error message here BEFORE resolving.
   * Undefined on every normal exit (including a normal non-zero exit), so the
   * retry classifier never mistakes a real verify failure for a transient spawn
   * failure. Threaded as a closure var into the resolved result, mirroring how
   * `timedOut` is reported.
   */
  spawnError?: string;
}

export interface RunVerifyOptions {
  cwd: string;
  logPath: string;
  killGracePeriodMs?: number;
  /**
   * External-cancel seam (phase 7.2 Step 6). When aborted, the verify child's
   * whole process tree is killed via the SAME `killTree` the internal timeout
   * uses (no second kill path). An aborted verify RESOLVES cleanly via the
   * `child.on("exit") → finish()` path (finish only resolves, never rejects),
   * so the killed task settles like any other. Backward compatible: callers
   * that omit `signal` (e.g. loop.ts) are unaffected.
   */
  signal?: AbortSignal;
}

export interface GitOps {
  fetch(remote: string): Promise<void>;
  /**
   * §4.3 cross-worktree materialization. Fetch a single not-yet-pushed COMMIT
   * `sha` from another clone's worktree path (used as a one-off local remote)
   * into THIS clone's object store, so a subsequent `rebaseOnto(sha, ref)` can
   * resolve it. `git fetch <local-path> <commit-sha>` over the local transport
   * copies the object reliably with no refspec — the SHA lands as a loose
   * object / `FETCH_HEAD`. This is how chain member K materializes member K-1's
   * rebased tree (which lives only in K-1's clone, never on the remote).
   */
  fetchFromPath(fromPath: string, sha: string): Promise<void>;
  checkout(ref: string): Promise<void>;
  rebaseOnto(base: string, branch: string): Promise<RebaseResult>;
  /**
   * Campaign A4 P2 (fast revert). Run `git revert --no-edit <sha>` on the
   * CURRENT (reset-to-main) worktree, creating one commit that undoes `sha`.
   * Uses the same EXPLICIT commit identity as rebaseOnto (pool clones have no
   * configured user). On a textual conflict, `git revert --abort` to leave NO
   * partial state and return `{ ok: false, conflict: true }`; any other failure
   * returns `{ ok: false, conflict: false }` (fail-safe). DETERMINISTIC — no LLM
   * is ever invoked, so a revert carries no injection surface.
   */
  revert(sha: string): Promise<RevertResult>;
  /**
   * Campaign A4 P2. Point a LOCAL branch `name` at the current HEAD (force).
   * After `revert` produces the commit in the worktree, the integrator creates
   * the local branch so the downstream `rebaseOnto(baseSha, name)` — which
   * `git checkout <name>`s — resolves it (a remote-only ref, the bare push
   * target, is not checkout-able by short name).
   */
  createBranch(name: string): Promise<void>;
  /**
   * Phase 7.6 §5.2 step 1. REPRODUCE the conflict the train's rebase hit, but
   * leave the markers in the working tree (the resolver agent reconciles them)
   * instead of `--abort`ing. Mechanism: `git checkout <ref>` then plain
   * `git rebase <baseSha>`. A PLAIN rebase (unlike `rebaseOnto`'s flow, and
   * unlike a rebase that auto-aborts on tooling error) halts WITH the conflict
   * markers written + the index in `UU` state when it hits a textual conflict —
   * so we SWALLOW the conflict throw and return the conflicting files, leaving
   * the worktree mid-rebase for the agent. If the replay does NOT conflict
   * (rare — main moved such that the conflict is gone), `conflictingFiles` is
   * empty and the rebase already completed cleanly; the caller treats an empty
   * set + clean tree as "nothing to resolve" downstream.
   */
  materializeConflict(baseSha: string, ref: string): Promise<MaterializeConflictResult>;
  /**
   * Phase 7.6 §5.2. After the resolver agent has edited the conflicted files,
   * COMMIT the resolution and complete the in-progress rebase. Stages everything
   * (`git add -A`) then runs `git rebase --continue` NON-INTERACTIVELY (a
   * `core.editor=true` / `GIT_EDITOR=true` no-op editor so `--continue` does not
   * block on the commit-message prompt) and with an EXPLICIT identity (the exact
   * pool-cloned-worktree pattern from `updateSubmoduleGitlink`, since these
   * clones have no configured user). If the agent ALREADY committed the
   * resolution (a clean tree with no rebase in progress), this resolves to the
   * current HEAD. Returns the resolved commit SHA (the tree Step 7 pushes).
   */
  commitResolution(): Promise<string>;
  push(remote: string, branch: string): Promise<PushResult>;
  resolveRef(ref: string): Promise<string>;
  /**
   * §5.4 / §5.2 step 8. In the CURRENT worktree, stage the 160000 gitlink at
   * `gitlinkPath` to point at inner commit `sha`, then COMMIT the outer tree.
   * Returns the new outer HEAD SHA (the assembled `Ro`).
   *
   * IDEMPOTENT — when the gitlink already references `sha`, returns the current
   * HEAD without creating a commit (never an empty bump commit; the up-to-date
   * FF push then makes the land a clean no-op). Explicit by construction:
   * previously this held only incidentally via simple-git's empty-stderr
   * heuristic on git's "nothing to commit" exit-1 (a simple-git bump or git
   * routing that message to stderr would have silently turned no-ops into
   * rejections); the staged-index-vs-HEAD check is now a direct numeric-exit
   * spawn (the runIsAncestor/runTreesIdentical precedent), never text parsing.
   *
   * Notes (per §5.4, confirmed on win32):
   *  - `--add` is REQUIRED to stage a gitlink path not already present in the
   *    index (harmless when it already exists — it updates in place).
   *  - `gitlinkPath` MUST use forward slashes (git index convention, even on
   *    Windows); callers pass the config `gitlinkPath` which is already POSIX.
   *  - The commit runs with an EXPLICIT committer identity because this is the
   *    integrator's FIRST authored commit and pool-cloned worktrees have no
   *    configured identity (otherwise the commit fails "Author identity
   *    unknown"). `commit.gpgsign=false` mirrors the test fixture identity.
   *  - `update-index --cacheinfo` does NOT require `sha`'s object to be present
   *    in this store to stage/commit the gitlink (git permits a gitlink to an
   *    absent object). The §5.2 step-7 `fetchFromPath` is for step 9's checkout,
   *    not for this op.
   */
  updateSubmoduleGitlink(gitlinkPath: string, sha: string): Promise<string>;
  /**
   * §5.4 / §7.4. Read the inner SHA the current outer tree's gitlink references
   * at `gitlinkPath` (used by the §11 post-assembly assertion and recovery's
   * reconciliation check). Parses `git ls-tree HEAD <gitlinkPath>` for the
   * `160000 commit <sha>\t<path>` line and returns the SHA (3rd whitespace
   * token). THROWS if no 160000 entry exists at `gitlinkPath` (a missing /
   * non-gitlink path is a real error, §11).
   */
  readSubmoduleGitlink(gitlinkPath: string): Promise<string>;
  /**
   * §5.4 / §5.2 step 9. Expand the inner tree `sha` into the outer WORKING TREE
   * at `gitlinkPath` on disk, so the outer verify sees the new inner SOURCES
   * (not merely the committed gitlink SHA). Requires `sha`'s objects present in
   * THIS store (the §5.2 step-7 `fetchFromPath`).
   *
   * Mechanism (empirically confirmed on win32 — see group-assembly.test.ts):
   * `git read-tree --prefix=<gitlinkPath>/ <sha>` into a SEPARATE temp index
   * (via GIT_INDEX_FILE) followed by `git checkout-index -a -f`. A separate
   * index is REQUIRED: the real index already holds the 160000 gitlink at
   * `gitlinkPath`, so read-tree-ing the expanded tree into it would collide;
   * the temp index isolates the expansion and leaves the committed gitlink
   * intact. checkout-index then writes the blobs to disk under the prefix.
   *
   * LFS OVERLAY (`innerWorktreePath` opt-in). When the inner repo tracks files
   * via git-lfs, a bare checkout-index would run the LFS smudge filter against
   * the OUTER repo's LFS endpoint — but the inner's LFS objects are NOT there,
   * so the smudge 404s and checkout-index throws ("smudge filter lfs failed",
   * exit 128). To avoid this, when `innerWorktreePath` is supplied (the inner
   * pool worktree, already rebased to `sha` and holding the correctly-smudged
   * real binaries), checkout-index runs with GIT_LFS_SKIP_SMUDGE=1 so it writes
   * LFS POINTERS (no outer-LFS lookup, no 404); the real binaries are then
   * OVERLAID by copying each `git lfs ls-files` entry from the inner worktree
   * over its pointer in the outer working tree. When `innerWorktreePath` is
   * omitted (recovery caller), the env is unchanged → byte-identical to before.
   */
  materializeSubmoduleWorktree(
    gitlinkPath: string,
    sha: string,
    innerWorktreePath?: string,
  ): Promise<void>;
  runVerify(command: string, timeoutMs: number, opts: RunVerifyOptions): Promise<VerifyResult>;
  /**
   * §7.4 RECONCILABLE ancestry check. Returns true iff `ancestor` is an ancestor
   * of `descendant` in THIS repo's history (i.e. `git merge-base --is-ancestor
   * ancestor descendant` exits 0). Returns false on exit 1 (NOT an ancestor).
   *
   * MANDATORY FIX (R1-critical): this is a DIRECT git spawn reading the numeric
   * process exit code, NOT `git.raw` + a text/regex inspection. simple-git's
   * `git.raw` RESOLVES (does not throw) on `--is-ancestor`'s exit-1-with-empty-
   * stderr, and `GitError` carries no numeric exitCode on this version, so a
   * raw-based implementation would misclassify a NOT-ancestor (regressing)
   * gitlink as reconcilable and auto-push it — an R1 BREAK. The direct spawn
   * reads exit 0 → true, exit 1 → false, anything else (128 / bad object /
   * corrupt repo) → REJECT, so recovery ESCALATES rather than silently treating
   * an error as "not ancestor".
   */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /**
   * No-op / already-landed detector. Returns true iff `a` and `b` resolve to
   * byte-identical trees — i.e. there is NO net diff between the two commits.
   * Used by the land path to recognize a request whose content is already on
   * the target branch (landed out-of-band under a different SHA, or a duplicate
   * of a predecessor) so it records a no-op land instead of pushing an empty
   * advance to `main`.
   *
   * Same direct-spawn rigor as `isAncestor`: `git diff --quiet <a> <b>` reads
   * the NUMERIC exit code (0 → identical/true, 1 → differ/false, anything else
   * → REJECT) rather than trusting `git.raw` text, so a bad object / corrupt
   * repo escalates instead of being silently read as "differ" (which would let
   * a no-op push through).
   */
  treesIdentical(a: string, b: string): Promise<boolean>;
}

export interface GitOpsOptions {
  /** Max bytes captured into the in-memory stdout/stderr buffers. */
  maxBufferBytes?: number;
}

const DEFAULT_MAX_BUFFER = 1024 * 1024; // 1 MiB
const DEFAULT_KILL_GRACE_MS = 5000;

// ─── Push failure classification ──────────────────────────────────

function classifyPushFailure(stderr: string): PushFailure["reason"] {
  if (/non-fast-forward|fetch first|stale info/i.test(stderr)) {
    return "non_fast_forward";
  }
  if (/permission denied|publickey|authentication failed|403/i.test(stderr)) {
    return "auth";
  }
  if (/could not resolve|connection refused|network|timed out|getaddrinfo/i.test(stderr)) {
    return "network";
  }
  return "other";
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ─── Direct git spawn (env-isolated) ──────────────────────────────

/**
 * Run a git subcommand with a SPECIFIC environment, isolated from the shared
 * simple-git instance. Used by materializeSubmoduleWorktree, which needs a
 * one-shot GIT_INDEX_FILE that must NOT leak onto the long-lived worktree git
 * instance (simple-git `.env()` is stateful and persists). Rejects on non-zero
 * exit with the captured stderr.
 */
function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Run a git subcommand with a SPECIFIC environment and CAPTURE stdout/stderr,
 * RESOLVING with the numeric exit code (does NOT reject on non-zero) — mirroring
 * the direct-spawn precedent (runIsAncestor). Used by materializeSubmoduleWorktree's
 * LFS overlay to enumerate inner LFS files via `git lfs ls-files`: git-lfs being
 * absent (or any other failure) surfaces as a non-zero `code` the caller treats
 * as an EMPTY list (overlay no-op) rather than a throw.
 */
function runGitCapture(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ stdout, code: code ?? -1, stderr });
    });
  });
}

/**
 * Enumerate every INITIALIZED submodule (all nesting levels) of `repoPath`,
 * as display paths relative to `repoPath` (POSIX slashes — git's own output).
 * Uses `submodule foreach`, which visits initialized submodules only and
 * exits 0 with empty output on a repo with none. A non-zero exit after a
 * successful `submodule update --init` is abnormal → throw (fail-loud; the
 * assembly catch rejects the pass), never a silent empty list that would
 * materialize an incomplete tree.
 */
async function listInitializedSubmodules(repoPath: string): Promise<string[]> {
  const out = await runGitCapture(
    ["submodule", "foreach", "--quiet", "--recursive", "echo $displaypath"],
    repoPath,
  );
  if (out.code !== 0) {
    throw new Error(`git submodule foreach (enumerate) exited ${out.code}: ${out.stderr.trim()}`);
  }
  return out.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Overlay the REAL Git LFS binaries from `srcRepoPath`'s working tree (which
 * holds correctly-smudged content) over the POINTERS `checkout-index` wrote
 * under `dstRoot` (smudge was skipped — see materializeSubmoduleWorktree).
 * Enumerates via `git lfs ls-files`; git-lfs absent (or any failure) → treat
 * as EMPTY (overlay no-op), so a non-LFS repo on a host without git-lfs is
 * byte-identical. Do NOT throw on a non-zero ls-files exit.
 */
async function overlayLfsReals(srcRepoPath: string, dstRoot: string): Promise<void> {
  const ls = await runGitCapture(["lfs", "ls-files", "--name-only"], srcRepoPath);
  const relpaths =
    ls.code === 0
      ? ls.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
  for (const relpath of relpaths) {
    const src = path.join(srcRepoPath, relpath);
    const dst = path.join(dstRoot, relpath);
    // FAIL-LOUD guard (P4): if `src` in the source worktree is itself an
    // UNSMUDGED LFS POINTER (the clone's smudge filter never ran — e.g. it was
    // cloned with GIT_LFS_SKIP_SMUDGE=1 or git-lfs is not configured there),
    // copying it would silently overlay a POINTER over the pointer
    // checkout-index already wrote — the outer verify would then build against
    // a text pointer, not the real binary (a false-green: the build "succeeds"
    // on garbage). An LFS pointer file is small and starts with the ASCII spec
    // line `version https://git-lfs.github.com/spec/v1`. Read the head of
    // `src` and refuse to overlay a pointer. (A correctly smudged worktree —
    // the normal case — has the real binary here, so this guard is inert.)
    const head = await readFile(src);
    if (
      head.subarray(0, 64).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")
    ) {
      throw new Error(
        `materialize: LFS file '${relpath}' in the source worktree '${srcRepoPath}' is an unsmudged pointer — cannot overlay the real binary (is git-lfs configured to smudge in that clone?).`,
      );
    }
    await mkdir(path.dirname(dst), { recursive: true });
    // copyFile overwrites the pointer with the real binary; overwriting an
    // existing file's content preserves its mode. A genuinely missing src
    // (a real defect) rejects — a missing binary must fail loud.
    await copyFile(src, dst);
  }
}

/**
 * Run `git merge-base --is-ancestor` as a DIRECT spawn, reading the NUMERIC
 * process exit code (the R1-critical precedent — see GitOps.isAncestor). Resolves
 * `true` on exit 0, `false` on exit 1, and REJECTS on any other exit code (e.g.
 * 128 — a bad/nonexistent object or a not-a-repo error) so the caller can
 * escalate rather than silently treat an error as "not ancestor".
 */
function runIsAncestor(ancestor: string, descendant: string, cwd: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve(true);
      else if (code === 1) resolve(false);
      else
        reject(
          new Error(
            `git merge-base --is-ancestor ${ancestor} ${descendant} exited ${code}: ${stderr.trim()}`,
          ),
        );
    });
  });
}

/**
 * Run `git diff --quiet <a> <b>` as a DIRECT spawn, reading the NUMERIC exit
 * code (same precedent as runIsAncestor). `--quiet` implies `--exit-code`:
 * exit 0 = no diff (identical trees) → `true`; exit 1 = a diff exists →
 * `false`; any other code (128 — bad object / not-a-repo) REJECTS so the caller
 * escalates rather than silently treating an error as "differ".
 */
function runTreesIdentical(a: string, b: string, cwd: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn("git", ["diff", "--quiet", a, b], {
      cwd,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve(true);
      else if (code === 1) resolve(false);
      else reject(new Error(`git diff --quiet ${a} ${b} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Run `git diff --cached --quiet` as a DIRECT spawn, reading the NUMERIC exit
 * code (same precedent as runIsAncestor / runTreesIdentical): exit 0 = the
 * staged index matches HEAD (a commit would be empty) → `true`; exit 1 = staged
 * changes exist → `false`; any other code (128 — corrupt repo / unborn HEAD)
 * REJECTS so the caller escalates rather than silently misreading an error.
 * Used by updateSubmoduleGitlink to make its no-change idempotence EXPLICIT
 * (never text-parsing git's "nothing to commit" message).
 */
function runIndexMatchesHead(cwd: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn("git", ["diff", "--cached", "--quiet"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve(true);
      else if (code === 1) resolve(false);
      else reject(new Error(`git diff --cached --quiet exited ${code}: ${stderr.trim()}`));
    });
  });
}

// ─── Factory ──────────────────────────────────────────────────────

// Explicit commit identity for pool-cloned worktrees. Pool clones have NO
// configured user, and on a host without a global git identity (a CI runner,
// a fresh server) every commit-creating git op fails "Committer identity
// unknown" — which a replaying rebase reports as a generic non-zero exit that
// rebaseOnto would misclassify as a CONFLICT (observed on the first hosted-CI
// run: every chained-member rebase "conflicted" → rejected, while dev
// machines with a global identity passed). commitResolution and
// updateSubmoduleGitlink already pass these flags; every rebase that can
// REPLAY commits (create new ones) must too.
const COMMIT_IDENTITY_ARGS = [
  "-c",
  "user.email=integrator@pm.local",
  "-c",
  "user.name=PM Integrator",
  "-c",
  "commit.gpgsign=false",
];

export function createGitOps(git: SimpleGit, opts: GitOpsOptions = {}): GitOps {
  const maxBuffer = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER;

  async function fetch(remote: string): Promise<void> {
    await git.fetch(remote);
  }

  async function fetchFromPath(fromPath: string, sha: string): Promise<void> {
    // Local-transport fetch of a single commit object by SHA. No refspec — git
    // copies the named object (and its history) into this clone's store.
    await git.raw(["fetch", fromPath, sha]);
  }

  async function checkout(ref: string): Promise<void> {
    await git.checkout(ref);
  }

  async function rebaseOnto(base: string, branch: string): Promise<RebaseResult> {
    await git.checkout(branch);
    try {
      await git.raw([...COMMIT_IDENTITY_ARGS, "rebase", base]);
      const treeSha = (await git.revparse(["HEAD"])).trim();
      return { ok: true, treeSha };
    } catch (err) {
      let conflictingFiles: string[] = [];
      try {
        const diff = await git.raw(["diff", "--name-only", "--diff-filter=U"]);
        conflictingFiles = diff
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      } catch {
        /* ignore — best-effort conflict-file capture */
      }
      try {
        await git.rebase(["--abort"]);
      } catch {
        /* ignore — abort may itself fail on a corrupt state */
      }
      return { ok: false, conflictingFiles, stderr: errText(err) };
    }
  }

  async function revert(sha: string): Promise<RevertResult> {
    // Revert `sha` on the CURRENT worktree (the caller has reset it to a clean
    // main). `--no-edit` skips the commit-message editor; the EXPLICIT identity
    // mirrors rebaseOnto (pool clones have no configured user, else the revert
    // commit fails "Committer identity unknown"). On conflict `git revert`
    // exits non-zero leaving conflict markers + a CHERRY_PICK/REVERT_HEAD — we
    // `--abort` to restore a clean tree (no partial state) and report
    // `conflict: true`. Any other failure also leaves NO partial state (best-
    // effort abort) and reports `conflict: false` (fail-safe).
    try {
      await git.raw([...COMMIT_IDENTITY_ARGS, "revert", "--no-edit", sha]);
      return { ok: true };
    } catch (err) {
      const stderr = errText(err);
      // A textual conflict leaves the worktree mid-revert with `UU` entries.
      const conflict = (await conflictingFilesNow()).length > 0;
      try {
        await git.raw(["revert", "--abort"]);
      } catch {
        /* ignore — abort may itself fail if no revert is in progress */
      }
      return { ok: false, conflict, stderr };
    }
  }

  async function createBranch(name: string): Promise<void> {
    // Force-point a local branch at the current HEAD (the revert commit), so a
    // later `git checkout <name>` (in rebaseOnto) resolves it.
    await git.raw(["branch", "-f", name, "HEAD"]);
  }

  async function conflictingFilesNow(): Promise<string[]> {
    try {
      const diff = await git.raw(["diff", "--name-only", "--diff-filter=U"]);
      return diff
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } catch {
      return [];
    }
  }

  async function materializeConflict(
    baseSha: string,
    ref: string,
  ): Promise<MaterializeConflictResult> {
    // Replay `ref` onto `baseSha`, leaving the markers in place (do NOT abort).
    await git.checkout(ref);
    try {
      await git.raw([...COMMIT_IDENTITY_ARGS, "rebase", baseSha]);
      // No conflict on replay (main moved so the collision is gone). The rebase
      // already completed; report an empty conflict set.
      return { conflictingFiles: [] };
    } catch {
      // Expected path: the rebase halted on a textual conflict. The markers +
      // `UU` index entries are now in the working tree — exactly what the
      // resolver agent reconciles. SWALLOW the throw (it is the conflict, not a
      // failure) and report the conflicting files.
      return { conflictingFiles: await conflictingFilesNow() };
    }
  }

  async function commitResolution(): Promise<string> {
    const topLevel = (await git.revparse(["--show-toplevel"])).trim();
    // Detect whether a rebase is still in progress. If the agent already
    // committed the resolution and completed the rebase, there is nothing to
    // continue — just resolve HEAD.
    const rebaseInProgress =
      (await pathExistsLocal(path.join(topLevel, ".git", "rebase-merge"))) ||
      (await pathExistsLocal(path.join(topLevel, ".git", "rebase-apply")));

    if (rebaseInProgress) {
      // Stage the agent's resolution, then complete the rebase NON-INTERACTIVELY
      // with an EXPLICIT identity (pool clones have no configured user) and a
      // no-op editor so `--continue` does not block on the message prompt.
      await git.add(["-A"]);
      await runGit(
        [
          "-c",
          "user.email=integrator@pm.local",
          "-c",
          "user.name=PM Integrator",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.editor=true",
          "rebase",
          "--continue",
        ],
        topLevel,
        { ...process.env, GIT_EDITOR: "true" },
      );
    }
    return (await git.revparse(["HEAD"])).trim();
  }

  async function push(remote: string, branch: string): Promise<PushResult> {
    try {
      // Push the rebased tree (current HEAD) to the target branch. After
      // rebaseOnto(), HEAD is the rebased feature commit but the local
      // `branch` ref still points at the old base — so a plain
      // `git push origin <branch>` would be a no-op that never advances the
      // remote. The explicit HEAD:<branch> refspec fast-forwards the remote
      // branch to the verified tree. (Discovered by the full-stack E2E:
      // land previously reported success without moving remote main.)
      await git.push(remote, `HEAD:${branch}`);
      const pushedSha = (await git.revparse(["HEAD"])).trim();
      return { ok: true, pushedSha };
    } catch (err) {
      const stderr = errText(err);
      return { ok: false, reason: classifyPushFailure(stderr), stderr };
    }
  }

  async function resolveRef(ref: string): Promise<string> {
    return (await git.revparse([ref])).trim();
  }

  async function updateSubmoduleGitlink(gitlinkPath: string, sha: string): Promise<string> {
    // Stage the 160000 gitlink at `gitlinkPath` -> `sha`. `--add` is required to
    // introduce the cacheinfo entry; forward slashes are the git index
    // convention. `cacheinfo` does NOT need `sha` present locally.
    await git.raw(["update-index", "--add", "--cacheinfo", `160000,${sha},${gitlinkPath}`]);
    // EXPLICIT no-change idempotence: if the staged index already matches HEAD
    // (the gitlink already referenced `sha`), return the current HEAD WITHOUT
    // committing — never an empty bump commit (the up-to-date FF push then makes
    // the land a clean no-op). This was previously only INCIDENTAL behavior —
    // git's no-change `commit` exits 1 with "nothing to commit" on STDOUT
    // (stderr empty) and simple-git's error detection only throws on
    // nonzero-exit-WITH-stderr — i.e. it hung on a heuristic a simple-git bump
    // or git message-routing change could silently break. The check is a direct
    // numeric-exit spawn (the treesIdentical precedent), never text parsing.
    const topLevel = (await git.revparse(["--show-toplevel"])).trim();
    if (await runIndexMatchesHead(topLevel)) {
      return (await git.revparse(["HEAD"])).trim();
    }
    // Commit with an EXPLICIT identity — pool-cloned worktrees have no
    // configured user, so without this the commit fails "Author identity
    // unknown" (this is the integrator's first authored commit).
    await git.raw([
      "-c",
      "user.email=integrator@pm.local",
      "-c",
      "user.name=PM Integrator",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      `assemble: gitlink ${gitlinkPath} -> ${sha}`,
      "--no-verify",
    ]);
    return (await git.revparse(["HEAD"])).trim();
  }

  async function readSubmoduleGitlink(gitlinkPath: string): Promise<string> {
    const out = await git.raw(["ls-tree", "HEAD", gitlinkPath]);
    // Each line: `<mode> <type> <sha>\t<path>`. Find the 160000 gitlink entry.
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      // Split on whitespace: [mode, type, sha, ...path]
      const parts = trimmed.split(/\s+/);
      if (parts[0] === "160000" && parts[2]) {
        return parts[2];
      }
    }
    throw new Error(
      `readSubmoduleGitlink: no 160000 gitlink entry found at "${gitlinkPath}" in HEAD`,
    );
  }

  async function materializeSubmoduleWorktree(
    gitlinkPath: string,
    sha: string,
    innerWorktreePath?: string,
  ): Promise<void> {
    // Expand `sha`'s tree into the working tree at `gitlinkPath` on disk.
    // Mechanism confirmed on win32: read-tree --prefix into a SEPARATE temp
    // index (the real index already holds the gitlink at this path, which would
    // collide), then checkout-index -a -f against that temp index. This writes
    // the inner blobs under `<gitlinkPath>/` without disturbing the committed
    // gitlink in HEAD or the real index.
    const topLevel = (await git.revparse(["--show-toplevel"])).trim();
    const overlayRoot = path.join(topLevel, ...gitlinkPath.split("/"));

    // ── PURGE the gitlink path before writing the overlay ──
    // A previous materialize's overlay here is INVISIBLE to git: the path is a
    // committed 160000 gitlink, so `git status` reports nothing and the
    // worktree's per-attempt `reset --hard` + `clean -fdx` never touch it
    // (confirmed empirically). Without this purge, (a) files deleted between
    // two materialized inner SHAs would survive (checkout-index -f overwrites
    // but never deletes), and (b) the stale overlay poisons every later verify
    // in this slot — e.g. a verify script's `git submodule update --init`
    // hard-fails on a populated-but-unregistered submodule path. `force: true`
    // makes the first run (no dir) a no-op. A REAL initialized submodule
    // checkout here is also safe to remove: its git dir lives under
    // .git/modules, not inside the path, so a later `submodule update --init`
    // re-checks-out from the existing module store without recloning.
    await rm(overlayRoot, { recursive: true, force: true });

    // ── Nested-submodule prep in the INNER worktree (assembly opt-in) ──
    // `sha`'s tree records the inner repo's own submodules as 160000 gitlink
    // entries, which checkout-index SKIPS (it writes blobs only) — so without
    // this step the materialized tree would lack every nested vendored
    // submodule, and the outer verify could not fetch them itself (the
    // gitlink path is not a git repo in the outer worktree, and the verify
    // contract forbids `submodule update` there — see
    // docs/integrator-deployment.md §14.8). Initialize them in the inner pool
    // worktree instead — a REAL clone where `submodule update` works, checked
    // out at `sha` by the assembly, and persistent across attempts (the
    // per-attempt `git clean` skips dirs carrying a .git). A failure here
    // throws → the assembly rejects this pass (gitlink_mismatch detail),
    // nothing pushed.
    let nestedPaths: string[] = [];
    if (innerWorktreePath) {
      await runGit(
        ["submodule", "update", "--init", "--recursive"],
        innerWorktreePath,
        process.env,
      );
      // Best-effort: pull LFS reals inside the nested submodules so the
      // working trees we export below hold real binaries. A non-zero exit
      // (git-lfs absent / no LFS use) is tolerated — the pointer fail-loud
      // guard in overlayLfsReals still catches a needed-but-missing binary.
      await runGitCapture(
        ["submodule", "foreach", "--recursive", "git", "lfs", "pull"],
        innerWorktreePath,
      );
      nestedPaths = await listInitializedSubmodules(innerWorktreePath);
    }

    const tmpIndex = path.join(
      topLevel,
      ".git",
      `pm-materialize-index-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    // NOTE: we spawn git DIRECTLY here rather than via the shared simple-git
    // instance. simple-git's `.env()` is STATEFUL — it persists GIT_INDEX_FILE
    // on the instance for ALL subsequent calls (confirmed empirically), which
    // would leak the throwaway temp index onto the long-lived worktree `git`
    // and corrupt every later op. A direct spawn scopes the env to exactly
    // these two commands. (cwd = the worktree top-level.)
    // When the inner pool worktree is supplied (assembly opt-in), set
    // GIT_LFS_SKIP_SMUDGE=1 so checkout-index writes LFS POINTERS rather than
    // invoking the smudge filter against the OUTER LFS endpoint (which lacks the
    // inner's LFS objects → 404 / "smudge filter lfs failed", exit 128). The real
    // binaries are overlaid below from the inner worktree. When omitted (recovery
    // caller), the env is unchanged → byte-identical to before.
    const env = {
      ...process.env,
      GIT_INDEX_FILE: tmpIndex,
      ...(innerWorktreePath ? { GIT_LFS_SKIP_SMUDGE: "1" } : {}),
    };
    try {
      // Forward slash + trailing slash on the prefix (git convention).
      await runGit(["read-tree", `--prefix=${gitlinkPath}/`, sha], topLevel, env);
      await runGit(["checkout-index", "-a", "-f"], topLevel, env);

      if (innerWorktreePath) {
        // ── LFS overlay (opt-in) ──
        // checkout-index wrote POINTERS for the inner's LFS-tracked files
        // (smudge was skipped). Overlay the REAL binaries from the inner pool
        // worktree (which holds the correctly-smudged content at `sha`).
        await overlayLfsReals(innerWorktreePath, overlayRoot);

        // ── Nested-submodule overlay ──
        // Export each initialized nested submodule's HEAD tree (== the gitlink
        // recorded in `sha`, per the `submodule update --init` above) from its
        // OWN git dir into the overlay — tree-exact, no working-tree junk.
        // A nested submodule's .git is a FILE (a gitdir pointer into the inner
        // clone's .git/modules), so the throwaway index lives in tmpdir.
        // Deeper nesting is covered by its own --recursive enumeration entry;
        // each level's gitlink entries are skipped by checkout-index exactly
        // like the top level's.
        for (const nested of nestedPaths) {
          const srcRepo = path.join(innerWorktreePath, ...nested.split("/"));
          const dstDir = path.join(overlayRoot, ...nested.split("/"));
          const nestedIndex = path.join(
            tmpdir(),
            `pm-materialize-nested-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          );
          const nestedEnv = {
            ...process.env,
            GIT_INDEX_FILE: nestedIndex,
            GIT_LFS_SKIP_SMUDGE: "1",
          };
          try {
            // checkout-index --prefix requires the destination dir to exist;
            // forward slashes + trailing slash (git convention, works on win32).
            await mkdir(dstDir, { recursive: true });
            await runGit(["read-tree", "HEAD"], srcRepo, nestedEnv);
            await runGit(
              ["checkout-index", "-a", "-f", `--prefix=${dstDir.replace(/\\/g, "/")}/`],
              srcRepo,
              nestedEnv,
            );
          } finally {
            await rm(nestedIndex, { force: true }).catch(() => {
              /* best-effort */
            });
          }
          await overlayLfsReals(srcRepo, dstDir);
        }
      }
    } finally {
      // The temp index is throwaway; remove it (best-effort).
      await rm(tmpIndex, { force: true }).catch(() => {
        /* best-effort */
      });
    }
  }

  function runVerify(
    command: string,
    timeoutMs: number,
    runOpts: RunVerifyOptions,
  ): Promise<VerifyResult> {
    const killGrace = runOpts.killGracePeriodMs ?? DEFAULT_KILL_GRACE_MS;
    const start = Date.now();

    return new Promise<VerifyResult>((resolve) => {
      const logStream = createWriteStream(runOpts.logPath, { flags: "a" });

      const child = spawn(command, {
        shell: true,
        cwd: runOpts.cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdoutBuf = "";
      let stderrBuf = "";
      let timedOut = false;
      let spawnError: string | undefined;
      let settled = false;
      let sigkillTimer: NodeJS.Timeout | undefined;

      // External-cancel seam: kill the child's process tree on abort, reusing
      // the SAME killTree the timeout path uses. The kill makes the child exit,
      // which resolves the promise via finish() (never rejects).
      const onAbort = (): void => {
        if (child.pid !== undefined) killTree(child.pid, "SIGTERM");
      };
      const signal = runOpts.signal;
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      const appendCapped = (current: string, chunk: string): string => {
        if (current.length >= maxBuffer) return current;
        const room = maxBuffer - current.length;
        return current + (chunk.length > room ? chunk.slice(0, room) : chunk);
      };

      child.stdout?.on("data", (d: Buffer) => {
        const s = d.toString();
        logStream.write(s);
        stdoutBuf = appendCapped(stdoutBuf, s);
      });
      child.stderr?.on("data", (d: Buffer) => {
        const s = d.toString();
        logStream.write(s);
        stderrBuf = appendCapped(stderrBuf, s);
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          killTree(child.pid, "SIGTERM");
          sigkillTimer = setTimeout(() => {
            if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
          }, killGrace);
          // Don't keep the event loop alive solely for the grace timer.
          sigkillTimer.unref?.();
        }
      }, timeoutMs);
      timeout.unref?.();

      const finish = (exitCode: number, exitSignal: NodeJS.Signals | null): void => {
        // Settled/finished guard: a spawn `error` can arrive after a partial
        // `exit` (or vice-versa); resolve exactly once so we never double-resolve.
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (signal) signal.removeEventListener("abort", onAbort);
        logStream.end(() => {
          resolve({
            exitCode,
            signal: exitSignal,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            durationMs: Date.now() - start,
            timedOut,
            spawnError,
            logPath: runOpts.logPath,
          });
        });
      };

      child.on("error", (err) => {
        // spawn-level failure (e.g. ENOENT). Surface as a non-zero exit with
        // the error text in the captured stderr so categorize() can read it.
        // Record `spawnError` (the retry classifier reads it to mark this
        // TRANSIENT) BEFORE calling finish — set it only on the first settle so
        // an `error` arriving after a partial `exit` does not overwrite/double.
        const s = errText(err);
        logStream.write(s);
        stderrBuf = appendCapped(stderrBuf, s);
        if (!settled) spawnError = s;
        finish(127, null);
      });

      child.on("exit", (code, signal) => {
        finish(code ?? (signal ? 1 : 0), signal);
      });
    });
  }

  async function isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    // The cwd is the worktree this gitOps is bound to. `--show-toplevel`
    // resolves it from the underlying simple-git instance (same precedent as
    // materializeSubmoduleWorktree). The direct spawn then reads the numeric
    // exit code (0 → true, 1 → false, else → reject).
    const topLevel = (await git.revparse(["--show-toplevel"])).trim();
    return runIsAncestor(ancestor, descendant, topLevel);
  }

  async function treesIdentical(a: string, b: string): Promise<boolean> {
    // Same cwd resolution as isAncestor — the worktree this gitOps is bound to.
    const topLevel = (await git.revparse(["--show-toplevel"])).trim();
    return runTreesIdentical(a, b, topLevel);
  }

  return {
    fetch,
    fetchFromPath,
    checkout,
    rebaseOnto,
    revert,
    createBranch,
    materializeConflict,
    commitResolution,
    push,
    resolveRef,
    updateSubmoduleGitlink,
    readSubmoduleGitlink,
    materializeSubmoduleWorktree,
    runVerify,
    isAncestor,
    treesIdentical,
  };
}
