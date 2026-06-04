import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
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
  materializeConflict(
    baseSha: string,
    ref: string,
  ): Promise<MaterializeConflictResult>;
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
  runVerify(
    command: string,
    timeoutMs: number,
    opts: RunVerifyOptions,
  ): Promise<VerifyResult>;
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
function runGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
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
 * Run `git merge-base --is-ancestor` as a DIRECT spawn, reading the NUMERIC
 * process exit code (the R1-critical precedent — see GitOps.isAncestor). Resolves
 * `true` on exit 0, `false` on exit 1, and REJECTS on any other exit code (e.g.
 * 128 — a bad/nonexistent object or a not-a-repo error) so the caller can
 * escalate rather than silently treat an error as "not ancestor".
 */
function runIsAncestor(
  ancestor: string,
  descendant: string,
  cwd: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      { cwd, env: process.env, stdio: ["ignore", "ignore", "pipe"] },
    );
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
function runTreesIdentical(
  a: string,
  b: string,
  cwd: string,
): Promise<boolean> {
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
      else
        reject(
          new Error(
            `git diff --quiet ${a} ${b} exited ${code}: ${stderr.trim()}`,
          ),
        );
    });
  });
}

// ─── Factory ──────────────────────────────────────────────────────

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
      await git.rebase([base]);
      const treeSha = (await git.revparse(["HEAD"])).trim();
      return { ok: true, treeSha };
    } catch (err) {
      let conflictingFiles: string[] = [];
      try {
        const diff = await git.raw([
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]);
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
      await git.rebase([baseSha]);
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

  async function updateSubmoduleGitlink(
    gitlinkPath: string,
    sha: string,
  ): Promise<string> {
    // Stage the 160000 gitlink at `gitlinkPath` -> `sha`. `--add` is required to
    // introduce the cacheinfo entry; forward slashes are the git index
    // convention. `cacheinfo` does NOT need `sha` present locally.
    await git.raw([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${sha},${gitlinkPath}`,
    ]);
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

      // ── LFS overlay (opt-in) ──
      // checkout-index wrote POINTERS for the inner's LFS-tracked files (smudge
      // was skipped). Overlay the REAL binaries by copying each inner LFS file
      // from the inner pool worktree (which holds the correctly-smudged content
      // at `sha`) over its pointer in the outer working tree.
      if (innerWorktreePath) {
        // Enumerate inner LFS files. git-lfs absent (or any failure) → non-zero
        // exit → treat as EMPTY (overlay no-op), so a non-LFS inner on a host
        // without git-lfs is byte-identical. Do NOT throw on non-zero.
        const ls = await runGitCapture(
          ["-C", innerWorktreePath, "lfs", "ls-files", "--name-only"],
          innerWorktreePath,
        );
        const relpaths =
          ls.code === 0
            ? ls.stdout
                .split("\n")
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
            : [];
        for (const relpath of relpaths) {
          const src = path.join(innerWorktreePath, relpath);
          const dst = path.join(topLevel, gitlinkPath, relpath);
          await mkdir(path.dirname(dst), { recursive: true });
          // copyFile overwrites the pointer with the real binary; overwriting an
          // existing file's content preserves its mode. A genuinely missing src
          // (a real defect) rejects — a missing inner binary must fail loud.
          await copyFile(src, dst);
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

      const finish = (
        exitCode: number,
        exitSignal: NodeJS.Signals | null,
      ): void => {
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

  async function isAncestor(
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
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
