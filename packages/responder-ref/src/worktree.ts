/**
 * Slim isolated-worktree primitive for the auto-implement regime (Campaign A1 P2).
 *
 * Grafted near-verbatim from `integrator-ref/src/worktree.ts` so the responder's
 * write-capable session runs in an ISOLATED git clone (cwd = the worktree, never
 * the live repo / `main`). This is the SLIM copy — the responder loop already owns
 * its scheduler (maxConcurrent), so the full resolver-pool is NOT grafted; the
 * runner spawns into a single worktree this module manages.
 *
 * Self-contained: deps are only node:fs/promises, node:path, simple-git. Adding
 * simple-git to responder-ref mirrors the integrator-ref bundle (external:[] +
 * createRequire shim) and is precedented/safe.
 *
 * Consumed in P3 (the loop wires worktreeRoot → createWorktree → the runner's
 * cwd). P2 only adds the primitive + its tests.
 */
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
}

/**
 * Build the simple-git `clean` options list. Empty cleanKeep ⇒ ["-d","-x"]
 * (with the "f" force mode ⇒ `git clean -fdx`). Each kept pattern adds
 * `-e <pattern>`, preserving matching untracked paths.
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
