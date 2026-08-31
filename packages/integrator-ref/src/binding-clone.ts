import { existsSync } from "node:fs";
import { simpleGit, type SimpleGit } from "simple-git";
import { applyGitLocalPolicy } from "./git-policy.js";
import type { Logger } from "./logger.js";

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
export function createBindingResolver(
  repoPath: string,
  bindDir: string,
  logger?: Logger,
): BindingResolver {
  let bindGit: SimpleGit | null = null;
  const ensureBind = async (): Promise<SimpleGit> => {
    if (!bindGit) {
      if (!existsSync(bindDir)) {
        await simpleGit().clone(repoPath, bindDir, ["--mirror"]);
      }
      const g = simpleGit(bindDir);
      // The mirror has no working tree, so it cannot hit the populated-but-
      // unopenable gitlink trigger directly — but it is cloned once and lives
      // forever, and EVERY failure here is funnelled through resolveRefInClone's
      // catch into `null` = "this member's ref does not exist". So it gets the
      // same policy as a slot, for the same reason: no fetch we drive should
      // recurse into a submodule on its own.
      //
      // Written BEFORE the memo assignment as belt-and-braces, not because
      // anything depends on it: applyGitLocalPolicy never throws (git-policy.ts),
      // so there is no window in which a failure could memoize a policy-less
      // mirror for the process lifetime. Keep the order anyway — it costs
      // nothing and it survives someone reintroducing a throw.
      await applyGitLocalPolicy(g, logger?.child({ bindDir }));
      bindGit = g;
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
