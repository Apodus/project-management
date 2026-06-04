import { existsSync } from "node:fs";
import { simpleGit, type SimpleGit } from "simple-git";

export interface BindingResolver {
  resolveRefInClone(ref: string): Promise<string | null>;
}

/**
 * Lazily maintains a local `--mirror` clone of `repoPath` (which may be a local
 * path OR a remote/`file://` URL — simple-git cannot bind directly to a URL, so
 * we mirror it locally) under `bindDir`, and resolves a member's ref against it.
 * Returns the full commit SHA for a present ref, or null (never throws) for an
 * absent one. Fetches before each resolution to pick up just-pushed refs. A
 * `--mirror` clone copies refs+objects only (no working tree, no LFS smudge), so
 * binding stays cheap even for an LFS repo.
 */
export function createBindingResolver(repoPath: string, bindDir: string): BindingResolver {
  let bindGit: SimpleGit | null = null;
  const ensureBind = async (): Promise<SimpleGit> => {
    if (!bindGit) {
      if (!existsSync(bindDir)) {
        await simpleGit().clone(repoPath, bindDir, ["--mirror"]);
      }
      bindGit = simpleGit(bindDir);
    }
    return bindGit;
  };
  return {
    resolveRefInClone: async (ref) => {
      try {
        const git = await ensureBind();
        // Refresh refs: the worker pushed this member just before grouping.
        await git.fetch();
        return (await git.revparse(["--verify", `${ref}^{commit}`])).trim();
      } catch {
        return null;
      }
    },
  };
}
