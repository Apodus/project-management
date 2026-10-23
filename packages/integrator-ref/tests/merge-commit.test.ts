/**
 * C4-P3c: `reject_merge_commits`. The train's rebase flattens merge commits, so
 * after it none is left to find; the range is judged BEFORE the rebase, by
 * `rebaseOnto(base, ref, { rejectMergeCommits: true })`. Real git throughout.
 * (The batch / loop wiring has its own cases in batch.test.ts and loop.test.ts;
 * the config key in config.test.ts.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { createGitOps, mergeCommitRejectionReason } from "../src/git-ops.js";

function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

async function configIdentity(g: SimpleGit): Promise<void> {
  await g.addConfig("user.email", "mc@test.local");
  await g.addConfig("user.name", "Merge Commit Test");
  await g.addConfig("commit.gpgsign", "false");
}

describe("mergeCommitRejectionReason", () => {
  it("names up to five 12-char shas, then counts the rest", () => {
    const shas = Array.from({ length: 7 }, (_, i) => `${i}`.repeat(40));
    const reason = mergeCommitRejectionReason(shas);
    expect(reason).toBe(
      "merge-commit-in-range: 000000000000, 111111111111, 222222222222, 333333333333, 444444444444 (+2 more). " +
        "The train's rebase flattens merges and drops their messages (trailers on a merge commit never reach main): rebase your branch.",
    );
  });
});

describe.skipIf(!hasGit())("rebaseOnto rejectMergeCommits (real git)", () => {
  let tmpRoot: string;
  let work: string;
  let author: SimpleGit;
  let mainSha: string;
  let mergeSha: string;
  let syncMergeSha: string;

  async function commitFile(name: string, text: string): Promise<string> {
    writeFileSync(path.join(work, name), text);
    await author.add([name]);
    await author.commit(`add ${name}`);
    return (await author.revparse(["HEAD"])).trim();
  }

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-mc-"));
    const bare = path.join(tmpRoot, "bare.git");
    work = path.join(tmpRoot, "work");
    await simpleGit().init(["--bare", "--initial-branch=main", bare]);
    await simpleGit().clone(bare, work);
    author = simpleGit(work);
    await configIdentity(author);
    await commitFile("base.txt", "base\n");
    await author.branch(["-M", "main"]);
    await author.push(["-u", "origin", "main"]);
    mainSha = (await author.revparse(["HEAD"])).trim();

    // linear: two plain commits.
    await author.checkoutLocalBranch("feature/linear");
    await commitFile("lin1.txt", "1\n");
    await commitFile("lin2.txt", "2\n");
    await author.push(["-u", "origin", "feature/linear"]);

    // merged: a side branch merged with --no-ff.
    await author.checkout("main");
    await author.checkoutLocalBranch("side/a");
    await commitFile("side-a.txt", "a\n");
    await author.checkout("main");
    await author.checkoutLocalBranch("feature/merged");
    await commitFile("m1.txt", "m\n");
    await author.raw(["merge", "--no-ff", "-m", "merge side/a", "side/a"]);
    mergeSha = (await author.revparse(["HEAD"])).trim();
    await author.push(["-u", "origin", "feature/merged"]);

    // synced: the branch merged MAIN into itself (the common "update branch" merge),
    // after main moved on.
    await author.checkout("main");
    await author.checkoutLocalBranch("feature/synced");
    await commitFile("s1.txt", "s\n");
    await author.push(["-u", "origin", "feature/synced"]);
    await author.checkout("main");
    await commitFile("main2.txt", "main moved\n");
    await author.push("origin", "main");
    mainSha = (await author.revparse(["HEAD"])).trim();
    await author.checkout("feature/synced");
    await author.raw(["merge", "--no-ff", "-m", "sync main", "main"]);
    syncMergeSha = (await author.revparse(["HEAD"])).trim();
    await author.push("origin", "feature/synced");
    await author.checkout("main");
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** A fresh slot: a clone of origin with identity configured. */
  async function slot(name: string): Promise<{ ops: ReturnType<typeof createGitOps>; git: SimpleGit }> {
    const dir = path.join(tmpRoot, name);
    await simpleGit().clone(path.join(tmpRoot, "bare.git"), dir);
    const git = simpleGit(dir);
    await configIdentity(git);
    return { ops: createGitOps(git, { gitRemote: "origin" }), git };
  }

  it("a branch with a merge commit is rejected before the rebase, naming the merge", async () => {
    const { ops, git } = await slot("s-merged");
    const r = await ops.rebaseOnto(mainSha, "feature/merged", { rejectMergeCommits: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mergeCommits).toEqual([mergeSha]);
    expect(r.conflictingFiles).toEqual([]);
    expect(r.stderr).toBe(mergeCommitRejectionReason([mergeSha]));
    expect(r.checkedOutSha).toBe(mergeSha);
    // No rebase was started: nothing in progress, HEAD still the candidate.
    expect((await git.revparse(["HEAD"])).trim()).toBe(mergeSha);
    expect((await git.status()).current).not.toBe("HEAD");
  });

  it("merging main INTO the branch counts: the sync merge is rejected", async () => {
    const { ops } = await slot("s-synced");
    const r = await ops.rebaseOnto(mainSha, "feature/synced", { rejectMergeCommits: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mergeCommits).toEqual([syncMergeSha]);
  });

  it("a pinned 40-hex sha is judged the same way as a branch name", async () => {
    const { ops } = await slot("s-pinned");
    const r = await ops.rebaseOnto(mainSha, mergeSha, { rejectMergeCommits: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mergeCommits).toEqual([mergeSha]);
  });

  it("a linear branch is rebased normally with the option on", async () => {
    const { ops } = await slot("s-linear");
    const r = await ops.rebaseOnto(mainSha, "feature/linear", { rejectMergeCommits: true });
    expect(r.ok).toBe(true);
  });

  it("option off or absent: the same merge branch is flattened and rebased, as before", async () => {
    for (const [name, opts] of [
      ["s-off-absent", undefined],
      ["s-off-false", { rejectMergeCommits: false }],
    ] as const) {
      const { ops } = await slot(name);
      const r = await ops.rebaseOnto(mainSha, "feature/merged", opts);
      expect(r.ok, name).toBe(true);
      if (r.ok) expect(r.mergeCommits).toBeUndefined();
    }
  });
});
