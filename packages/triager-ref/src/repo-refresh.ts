/**
 * Dedicated-checkout refresh for repo-aware triage assessment.
 *
 * To judge whether a note's issue STILL EXISTS, the assessment session must read
 * the watched project's CURRENT code. The triager `cwd`s the session into a
 * per-project DEDICATED checkout (never the live working tree) and, before each
 * assessment, refreshes that checkout to the configured ref with:
 *
 *     git -C <repoPath> fetch <remote>
 *     git -C <repoPath> reset --hard <ref>
 *
 * `<remote>` is derived from the ref (`origin/main` → `origin`; a bare ref → the
 * default `origin`). A non-zero git exit REJECTS — `decide()` catches it and
 * fail-safes the note to `needs_human` (never assess against unknown/stale code).
 * `reset --hard` also wipes any stray write a prior read-only-by-prompt session
 * may have left, keeping the checkout clean without touching the live tree.
 *
 * The git invocation is an INJECTABLE seam (`exec`): tests pass a fake to assert
 * the exact argv (and to simulate a failure) without shelling out; production
 * uses `promisify(execFile)` — argv form, NO shell, so paths/refs are never
 * interpolated into a command string.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface RepoRefresher {
  /** Refresh `repoPath` to `ref` (fetch + hard reset). Rejects on git failure. */
  refresh(repoPath: string, ref: string): Promise<void>;
}

/** The injectable git seam: run `git <args>` and resolve on success / reject on failure. */
export type ExecFileFn = (file: string, args: string[]) => Promise<unknown>;

const defaultExec: ExecFileFn = (file, args) => promisify(execFile)(file, args);

/**
 * Derive the remote to fetch from a ref: `origin/main` → `origin`. A bare ref
 * (no `/`) or a leading-slash oddity falls back to the default `origin`.
 */
export function deriveRemote(ref: string): string {
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(0, slash) : "origin";
}

/** Production refresher: `git -C <path> fetch <remote>` then `reset --hard <ref>`. */
export function createGitRepoRefresher(opts: { exec?: ExecFileFn } = {}): RepoRefresher {
  const exec = opts.exec ?? defaultExec;
  return {
    async refresh(repoPath: string, ref: string): Promise<void> {
      const remote = deriveRemote(ref);
      await exec("git", ["-C", repoPath, "fetch", remote]);
      await exec("git", ["-C", repoPath, "reset", "--hard", ref]);
    },
  };
}

/**
 * Test/seam fake: records each refresh call and (optionally) runs `fn` — which may
 * throw to simulate a git failure. `calls` is exposed for assertions.
 */
export function createFakeRepoRefresher(
  fn?: (repoPath: string, ref: string) => void | Promise<void>,
): RepoRefresher & { calls: Array<{ repoPath: string; ref: string }> } {
  const calls: Array<{ repoPath: string; ref: string }> = [];
  return {
    calls,
    async refresh(repoPath: string, ref: string): Promise<void> {
      calls.push({ repoPath, ref });
      if (fn) await fn(repoPath, ref);
    },
  };
}
