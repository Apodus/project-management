import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { createBindingResolver } from "../src/binding-clone.js";

function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

let tmpRoot: string;
let srcBare: string;
let bindRoot: string;
let seedDir: string;
let mainSha: string;
let featureSha: string;

async function configIdentity(g: SimpleGit): Promise<void> {
  await g.addConfig("user.email", "int@test.local");
  await g.addConfig("user.name", "Integrator Test");
  await g.addConfig("commit.gpgsign", "false");
}

describe.skipIf(!GIT_AVAILABLE)("binding-clone (real git)", () => {
  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-bind-"));
    srcBare = path.join(tmpRoot, "src.git");
    bindRoot = path.join(tmpRoot, "binds");

    await simpleGit().init(["--bare", "--initial-branch=main", srcBare]);
    seedDir = path.join(tmpRoot, "seed");
    await simpleGit().clone(srcBare, seedDir);
    const seed = simpleGit(seedDir);
    await configIdentity(seed);

    // Base commit on main.
    writeFileSync(path.join(seedDir, "base.txt"), "base\n");
    await seed.add(["base.txt"]);
    await seed.commit("base");
    await seed.push(["-u", "origin", "main"]);
    mainSha = (await seed.revparse(["HEAD"])).trim();

    // Feature branch.
    await seed.checkoutLocalBranch("feature/x");
    writeFileSync(path.join(seedDir, "feature.txt"), "feature\n");
    await seed.add(["feature.txt"]);
    await seed.commit("feature");
    await seed.push(["-u", "origin", "feature/x"]);
    featureSha = (await seed.revparse(["HEAD"])).trim();
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("A: resolves refs against a local-path source repo", async () => {
    const bindDir = path.join(bindRoot, "bind-local.git");
    const resolver = createBindingResolver(srcBare, bindDir);
    expect(await resolver.resolveRefInClone("feature/x")).toBe(featureSha);
    expect(await resolver.resolveRefInClone(featureSha)).toBe(featureSha);
    expect(await resolver.resolveRefInClone("main")).toBe(mainSha);
    expect(await resolver.resolveRefInClone("does-not-exist")).toBe(null);
    expect(existsSync(bindDir)).toBe(true);
  });

  it("B: resolves refs against a file:// URL source repo (regression guard)", async () => {
    // Derive the URL from the actual bare path (host temp may be on any drive).
    const fileUrl = "file:///" + srcBare.split(path.sep).join("/");
    const resolver = createBindingResolver(fileUrl, path.join(bindRoot, "bind-url.git"));
    expect(await resolver.resolveRefInClone("feature/x")).toBe(featureSha);
    expect(await resolver.resolveRefInClone("main")).toBe(mainSha);
    expect(await resolver.resolveRefInClone("does-not-exist")).toBe(null);
  });

  it("C: a fresh resolver over an existing bind dir does not re-clone", async () => {
    const bindDir = path.join(bindRoot, "bind-reuse.git");
    const first = createBindingResolver(srcBare, bindDir);
    expect(await first.resolveRefInClone("feature/x")).toBe(featureSha);
    expect(existsSync(bindDir)).toBe(true);

    // A fresh resolver over the SAME (now populated) bindDir must resolve via the
    // existing mirror — the existsSync guard prevents a re-clone into a non-empty dir.
    const second = createBindingResolver(srcBare, bindDir);
    expect(await second.resolveRefInClone("feature/x")).toBe(featureSha);
  });

  it("D: per-call fetch picks up a newly pushed ref on a cached resolver", async () => {
    const resolver = createBindingResolver(srcBare, path.join(bindRoot, "bind-fetch.git"));
    // Clones + caches the mirror.
    expect(await resolver.resolveRefInClone("feature/x")).toBe(featureSha);

    // Push a brand-new branch to the source from the seed clone.
    const seed = simpleGit(seedDir);
    await seed.checkout("main");
    await seed.checkoutLocalBranch("feature/new");
    writeFileSync(path.join(seedDir, "new.txt"), "new\n");
    await seed.add(["new.txt"]);
    await seed.commit("new feature");
    await seed.push(["-u", "origin", "feature/new"]);
    const newSha = (await seed.revparse(["HEAD"])).trim();

    // The SAME cached resolver must see the new ref via its per-call fetch.
    expect(await resolver.resolveRefInClone("feature/new")).toBe(newSha);
  });
});
