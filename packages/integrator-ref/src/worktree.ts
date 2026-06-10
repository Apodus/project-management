import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

export interface Worktree {
  readonly path: string;
  readonly logsDir: string;
  readonly git: SimpleGit;
  ensureExists(): Promise<void>;
  resetForAttempt(): Promise<void>;
  detectCorruption(): Promise<boolean>;
  repair(): Promise<void>;
}

export interface WorktreeOptions {
  worktreeRoot: string;
  worktreeName: string;
  gitRemote: string;
  gitMainBranch: string;
  gitRepoUrl: string;
  cleanKeep: string[];
  /**
   * Gitlink (160000 submodule) paths — POSIX slashes, relative to the repo
   * root — to purge of stale MATERIALIZED overlays on every resetForAttempt.
   * A group assembly materializes the inner sources at the outer repo's
   * gitlink path as plain files with no .git; git is BLIND to content at a
   * committed gitlink path (`status` reports nothing, `clean -fdx` and
   * `reset --hard` never touch it), so without this purge the overlay
   * outlives the attempt and poisons every later verify in the slot (e.g. a
   * verify script's `git submodule update --init` hard-fails on the
   * populated-but-unregistered path). Derived from the linked_repos config
   * (each inner repo's gitlink_path); default [] = no-op.
   */
  gitlinkPurgePaths?: string[];
}

/**
 * Build the simple-git `clean` options list. Empty cleanKeep ⇒ ["-d","-x"]
 * (with the "f" force mode ⇒ `git clean -fdx`, byte-identical to pre-P1).
 * Each kept pattern adds `-e <pattern>`, preserving matching untracked paths.
 */
export function buildCleanArgs(cleanKeep: readonly string[]): string[] {
  return ["-d", "-x", ...cleanKeep.flatMap((p) => ["-e", p])];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Remove a stale materialized overlay at a committed gitlink path (see
 * WorktreeOptions.gitlinkPurgePaths). Guarded three ways so it can never eat
 * real content:
 *  - the path must be a 160000 gitlink in HEAD (a tracked regular dir at a
 *    misconfigured path is left alone);
 *  - a REAL initialized submodule checkout (a .git file/dir inside) is left
 *    alone — `submodule update` manages it and `git clean` correctly skips it;
 *  - anything else (populated, unregistered — exactly a leftover materialize
 *    overlay) is removed. `submodule update --init` recreates the checkout
 *    from the persistent .git/modules store when a verify needs it.
 */
async function purgeStaleGitlinkOverlay(
  g: SimpleGit,
  wtPath: string,
  gitlinkPath: string,
): Promise<void> {
  let lsTree: string;
  try {
    lsTree = await g.raw(["ls-tree", "HEAD", "--", gitlinkPath]);
  } catch {
    return; // unborn HEAD / bad path — never purge on uncertainty
  }
  if (!/^160000 commit [0-9a-f]/.test(lsTree.trim())) return;
  const dir = path.join(path.normalize(wtPath), ...gitlinkPath.split("/"));
  if (!(await isDirectory(dir))) return;
  if (await pathExists(path.join(dir, ".git"))) return;
  await rm(dir, { recursive: true, force: true });
}

export function createWorktree(opts: WorktreeOptions): Worktree {
  const root = opts.worktreeRoot.replace(/[\\/]+$/, "");
  // Keep forward-slash join for path string identity used in tests, but rely
  // on path.join for filesystem operations.
  const wtPath = `${root}/${opts.worktreeName}`;
  const logsDir = `${root}/logs`;

  // SimpleGit instance bound to the worktree path. simple-git refuses to
  // construct against a non-existent directory, so we bind lazily — only
  // after the path exists (post-clone). Until then, callers must not touch
  // `git`; the public flow always calls ensureExists() first.
  let git: SimpleGit | null = null;

  function rebind(): void {
    git = simpleGit(path.normalize(wtPath));
  }

  function requireGit(): SimpleGit {
    if (!git) {
      git = simpleGit(path.normalize(wtPath));
    }
    return git;
  }

  async function ensureExists(): Promise<void> {
    const gitDir = path.join(wtPath, ".git");
    const needsClone = !(await pathExists(wtPath)) || !(await pathExists(gitDir));

    if (needsClone) {
      await mkdir(path.normalize(root), { recursive: true });
      // Clone into the worktree path. Works with local filesystem paths and
      // remote URLs alike on all platforms.
      await simpleGit().clone(opts.gitRepoUrl, path.normalize(wtPath));
      rebind();
      const g = requireGit();
      // Ensure the remote points at the configured URL (clone uses "origin"
      // by default; align it with the configured remote name if different).
      try {
        await g.remote(["set-url", opts.gitRemote, opts.gitRepoUrl]);
      } catch {
        // Remote name may not exist yet (non-default git_remote). Add it.
        try {
          await g.addRemote(opts.gitRemote, opts.gitRepoUrl);
        } catch {
          /* best-effort */
        }
      }
    } else {
      rebind();
    }

    await mkdir(path.normalize(logsDir), { recursive: true });
  }

  async function resetForAttempt(): Promise<void> {
    const g = requireGit();
    await g.reset(["--hard"]);
    await g.clean("f", buildCleanArgs(opts.cleanKeep));
    await g.fetch(opts.gitRemote);
    await g.checkout(opts.gitMainBranch);
    await g.reset(["--hard", `${opts.gitRemote}/${opts.gitMainBranch}`]);
    // Reset/clean above are blind to materialized content at committed gitlink
    // paths — purge any leftover overlay explicitly (see WorktreeOptions).
    for (const p of opts.gitlinkPurgePaths ?? []) {
      await purgeStaleGitlinkOverlay(g, wtPath, p);
    }
  }

  async function detectCorruption(): Promise<boolean> {
    const gitDir = path.join(wtPath, ".git");
    if (!(await isDirectory(gitDir))) {
      return true;
    }
    try {
      await requireGit().status();
      return false;
    } catch {
      return true;
    }
  }

  async function repair(): Promise<void> {
    await rm(path.normalize(wtPath), { recursive: true, force: true });
    await ensureExists();
  }

  return {
    path: wtPath,
    logsDir,
    get git(): SimpleGit {
      return requireGit();
    },
    ensureExists,
    resetForAttempt,
    detectCorruption,
    repair,
  };
}
