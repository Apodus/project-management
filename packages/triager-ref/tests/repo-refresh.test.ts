import { describe, it, expect, vi } from "vitest";
import {
  createGitRepoRefresher,
  createFakeRepoRefresher,
  deriveRemote,
  type ExecFileFn,
} from "../src/repo-refresh.js";

describe("deriveRemote", () => {
  it("takes the segment before the first slash", () => {
    expect(deriveRemote("origin/main")).toBe("origin");
    expect(deriveRemote("upstream/release/1.x")).toBe("upstream");
  });

  it("falls back to origin for a bare ref (no slash) or a leading slash", () => {
    expect(deriveRemote("main")).toBe("origin");
    expect(deriveRemote("/weird")).toBe("origin");
  });
});

describe("createGitRepoRefresher", () => {
  it("issues fetch <remote> then reset --hard <ref>, in order, with -C <path>", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec: ExecFileFn = vi.fn(async (file, args) => {
      calls.push({ file, args });
    });
    const refresher = createGitRepoRefresher({ exec });

    await refresher.refresh("/repos/game_one", "origin/main");

    expect(calls).toEqual([
      { file: "git", args: ["-C", "/repos/game_one", "fetch", "origin"] },
      { file: "git", args: ["-C", "/repos/game_one", "reset", "--hard", "origin/main"] },
    ]);
  });

  it("propagates (rejects) when git fetch fails — reset is never attempted", async () => {
    const exec: ExecFileFn = vi.fn(async (_file, args) => {
      if (args.includes("fetch")) throw new Error("fatal: could not read from remote");
    });
    const refresher = createGitRepoRefresher({ exec });

    await expect(refresher.refresh("/repos/x", "origin/main")).rejects.toThrow(
      /could not read from remote/,
    );
    // reset must NOT have run (fetch rejected first).
    expect((exec as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("propagates (rejects) when git reset --hard fails", async () => {
    const exec: ExecFileFn = vi.fn(async (_file, args) => {
      if (args.includes("reset")) throw new Error("fatal: not a git repository");
    });
    const refresher = createGitRepoRefresher({ exec });

    await expect(refresher.refresh("/repos/x", "origin/main")).rejects.toThrow(
      /not a git repository/,
    );
  });
});

describe("createFakeRepoRefresher", () => {
  it("records calls and can simulate a git failure via fn", async () => {
    const ok = createFakeRepoRefresher();
    await ok.refresh("/r", "origin/main");
    expect(ok.calls).toEqual([{ repoPath: "/r", ref: "origin/main" }]);

    const boom = createFakeRepoRefresher(() => {
      throw new Error("refresh boom");
    });
    await expect(boom.refresh("/r", "origin/main")).rejects.toThrow(/refresh boom/);
    expect(boom.calls).toEqual([{ repoPath: "/r", ref: "origin/main" }]);
  });
});
