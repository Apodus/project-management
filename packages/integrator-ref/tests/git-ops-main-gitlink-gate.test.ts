/**
 * Campaign 2026-08-30 §S2 — `checkMainGitlinkInvariant`, the gate that asks
 * whether OUTER MAIN's committed gitlink is reachable from the inner side.
 *
 * Two questions, one pass, four verdicts:
 *   HEALTH  (target ∈ ancestors(innerMainSha))   → drives the incident
 *   LANDING (target ∈ ancestors(landingInnerSha)) → drives the gate
 * `holds` = both, `heals` = health fails but landing holds, `dangling` = both
 * fail, `undecided` = no probe answered (fail open, design lock 5).
 *
 * Real temp repos, modeled on `git-ops-classify-gitlink.test.ts`: gitlinks are
 * seeded with `update-index --add --cacheinfo 160000,<sha>,<path>`, so no real
 * submodule is needed. Every case supplies BOTH comparands explicitly — the
 * whole point of the design is that they are separate inputs.
 *
 * The inner store is READ-ONLY across cases (the gate only reads / fetches it),
 * so it is built once; each outer is fresh to isolate its committed gitlink.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import {
  checkMainGitlinkInvariant,
  createGitOps,
  describeDanglingMainGitlink,
  type GitOps,
  type MainGitlinkVerdict,
} from "../src/git-ops.js";

function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

async function configIdentity(g: SimpleGit): Promise<void> {
  await g.addConfig("user.email", "int@test.local");
  await g.addConfig("user.name", "Integrator Test");
  await g.addConfig("commit.gpgsign", "false");
}

const GITLINK_PATH = "vendor/rynx";
const GIT_REMOTE = "origin";
/** A well-formed 40-hex that names no object anywhere (isAncestor → exit 128 → throw). */
const BOGUS_SHA = "d".repeat(40);
/** A well-formed 40-hex the inner store will never hold, even after a fetch. */
const ABSENT_SHA = "e".repeat(40);

interface Inner {
  gitOps: GitOps;
  /** c1 → c2 on main. */
  c1: string;
  c2: string;
  /** d1: off main (branch `diverged`, pushed) — present, NOT an ancestor of c2. */
  d1: string;
  /** ahead: c2 → a1 (branch `ahead`, pushed) — a landing inner ahead of main. */
  a1: string;
  /** heal: d1 → h1 (branch `heal`, pushed) — a landing inner that CONTAINS d1. */
  h1: string;
}

describe.skipIf(!GIT_AVAILABLE)("checkMainGitlinkInvariant (real two-repo)", () => {
  let tmpRoot: string;
  let inner: Inner;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-maingate-"));

    const innerBare = path.join(tmpRoot, "inner.git");
    await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
    const seed = path.join(tmpRoot, "inner-seed");
    await simpleGit().clone(innerBare, seed);
    const ig = simpleGit(seed);
    await configIdentity(ig);

    writeFileSync(path.join(seed, "lib.txt"), "v1\n");
    await ig.add(["lib.txt"]);
    await ig.commit("c1 inner");
    await ig.branch(["-M", "main"]);
    const c1 = (await ig.revparse(["HEAD"])).trim();

    writeFileSync(path.join(seed, "lib.txt"), "v2\n");
    await ig.add(["lib.txt"]);
    await ig.commit("c2 inner (main tip)");
    const c2 = (await ig.revparse(["HEAD"])).trim();
    await ig.push(["-u", GIT_REMOTE, "main"]);

    // `ahead`: a landing inner strictly ahead of main.
    await ig.checkout(["-b", "ahead", c2]);
    writeFileSync(path.join(seed, "ahead.txt"), "landing\n");
    await ig.add(["ahead.txt"]);
    await ig.commit("a1 (landing inner ahead of main)");
    const a1 = (await ig.revparse(["HEAD"])).trim();
    await ig.push(["-u", GIT_REMOTE, "ahead"]);

    // `diverged`: off c1 → d1 — present, but on neither main nor `ahead`.
    await ig.checkout(["-b", "diverged", c1]);
    writeFileSync(path.join(seed, "sidecar.txt"), "divergent\n");
    await ig.add(["sidecar.txt"]);
    await ig.commit("d1 (off main)");
    const d1 = (await ig.revparse(["HEAD"])).trim();
    await ig.push(["-u", GIT_REMOTE, "diverged"]);

    // `heal`: d1 → h1 — a landing inner that CONTAINS the off-main target.
    await ig.checkout(["-b", "heal", d1]);
    writeFileSync(path.join(seed, "heal.txt"), "carries d1\n");
    await ig.add(["heal.txt"]);
    await ig.commit("h1 (landing inner containing d1)");
    const h1 = (await ig.revparse(["HEAD"])).trim();
    await ig.push(["-u", GIT_REMOTE, "heal"]);

    // The inner clone the gate probes/fetches.
    const work = path.join(tmpRoot, "inner-work");
    await simpleGit().clone(innerBare, work);
    await configIdentity(simpleGit(work));
    // Fetch every branch so presence is a real property, not a clone artifact.
    await simpleGit(work).fetch(GIT_REMOTE);

    inner = { gitOps: createGitOps(simpleGit(work)), c1, c2, d1, a1, h1 };
  }, 60_000);

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** A fresh outer whose main commits `target` at GITLINK_PATH (or nothing at all). */
  async function newOuter(
    label: string,
    target: string | null,
  ): Promise<{ gitOps: GitOps; outerMainSha: string }> {
    const dir = path.join(tmpRoot, label);
    await simpleGit().init(["--initial-branch=main", dir]);
    const g = simpleGit(dir);
    await configIdentity(g);
    writeFileSync(path.join(dir, "top.txt"), "top v1\n");
    await g.add(["top.txt"]);
    if (target !== null) {
      await g.raw(["update-index", "--add", "--cacheinfo", `160000,${target},${GITLINK_PATH}`]);
    }
    await g.commit("outer main");
    await g.branch(["-M", "main"]);
    return { gitOps: createGitOps(g), outerMainSha: (await g.revparse(["HEAD"])).trim() };
  }

  /** Wrap the shared inner gitOps with per-probe counters. */
  function spyInner(over?: Partial<GitOps>): {
    gitOps: GitOps;
    counts: { isAncestor: number; fetch: number; objectPresent: number };
  } {
    const counts = { isAncestor: 0, fetch: 0, objectPresent: 0 };
    const gitOps: GitOps = {
      ...inner.gitOps,
      async isAncestor(a: string, b: string): Promise<boolean> {
        counts.isAncestor += 1;
        return inner.gitOps.isAncestor(a, b);
      },
      async fetch(remote: string): Promise<void> {
        counts.fetch += 1;
        return inner.gitOps.fetch(remote);
      },
      async objectPresent(ref: string): Promise<boolean> {
        counts.objectPresent += 1;
        return inner.gitOps.objectPresent(ref);
      },
      ...over,
    };
    return { gitOps, counts };
  }

  async function run(
    o: { gitOps: GitOps; outerMainSha: string },
    innerGitOps: GitOps,
    innerMainSha: string,
    landingInnerSha: string,
    gitlinkPath = GITLINK_PATH,
  ): Promise<MainGitlinkVerdict> {
    return checkMainGitlinkInvariant({
      outerGitOps: o.gitOps,
      innerGitOps,
      gitlinkPath,
      outerMainSha: o.outerMainSha,
      innerMainSha,
      landingInnerSha,
      gitRemote: GIT_REMOTE,
    });
  }

  it("T1. target a strict ancestor of inner main, Ri ahead → holds, and the LANDING probe never runs", async () => {
    const o = await newOuter("t1", inner.c1);
    const spy = spyInner();
    const v = await run(o, spy.gitOps, inner.c2, inner.a1);
    expect(v.kind).toBe("holds");
    // The short-circuit, pinned: HEALTH ⟹ LANDING, so one `merge-base
    // --is-ancestor` is the whole cost of a healthy lane.
    expect(spy.counts.isAncestor).toBe(1);
    expect(spy.counts.fetch).toBe(0);
  }, 40_000);

  it("T2. target == inner main tip → holds (`--is-ancestor x x` exits 0)", async () => {
    const o = await newOuter("t2", inner.c2);
    const spy = spyInner();
    const v = await run(o, spy.gitOps, inner.c2, inner.c2);
    expect(v.kind).toBe("holds");
    expect(spy.counts.isAncestor).toBe(1);
  }, 40_000);

  it("T3. target off inner main but an ancestor of Ri → HEALS (both probes run)", async () => {
    const o = await newOuter("t3", inner.d1);
    const spy = spyInner();
    const v = await run(o, spy.gitOps, inner.c2, inner.h1);
    expect(v).toMatchObject({ kind: "heals", presence: "present", target: inner.d1 });
    expect(spy.counts.isAncestor).toBe(2);
    // A heals verdict carries all five facts — the log line names the commits.
    if (v.kind !== "heals") throw new Error("not heals");
    expect(v.innerMainSha).toBe(inner.c2);
    expect(v.landingInnerSha).toBe(inner.h1);
    expect(v.outerMainSha).toBe(o.outerMainSha);
  }, 40_000);

  it("T4. target off inner main AND off Ri → dangling/present", async () => {
    const o = await newOuter("t4", inner.d1);
    const spy = spyInner();
    const v = await run(o, spy.gitOps, inner.c2, inner.a1);
    expect(v).toMatchObject({ kind: "dangling", presence: "present", target: inner.d1 });
    expect(spy.counts.isAncestor).toBe(2);
  }, 40_000);

  it("T5. synthetic-inner arm (landingInnerSha === innerMainSha) → dangling, and the health answer is REUSED", async () => {
    const o = await newOuter("t5", inner.d1);
    const spy = spyInner();
    const v = await run(o, spy.gitOps, inner.c2, inner.c2);
    expect(v).toMatchObject({ kind: "dangling", presence: "present" });
    // Not two identical spawns: the landing comparand IS the health comparand.
    expect(spy.counts.isAncestor).toBe(1);
  }, 40_000);

  it("T6. target absent even after an all-refs fetch → dangling/absent, and NO landing probe", async () => {
    const o = await newOuter("t6", ABSENT_SHA);
    const spy = spyInner();
    const v = await run(o, spy.gitOps, inner.c2, inner.a1);
    expect(v).toMatchObject({ kind: "dangling", presence: "absent", target: ABSENT_SHA });
    // The all-refs fetch ran exactly once (never fetch-by-sha)...
    expect(spy.counts.fetch).toBe(1);
    // ...and an object the store does not hold is in no commit's history, so
    // neither ancestry question was asked.
    expect(spy.counts.isAncestor).toBe(0);
  }, 40_000);

  it("T7. the HEALTH isAncestor throws → undecided, never dangling, never heals", async () => {
    // A bogus innerMainSha is a bad object: `merge-base --is-ancestor` exits
    // 128 and GitOps.isAncestor THROWS by design.
    const o = await newOuter("t7", inner.c1);
    const v = await run(o, inner.gitOps, BOGUS_SHA, inner.a1);
    expect(v.kind).toBe("undecided");
    if (v.kind !== "undecided") throw new Error("not undecided");
    expect(v.detail).toMatch(/health isAncestor threw/i);
  }, 40_000);

  it("T8. the LANDING isAncestor throws (health decided false) → undecided", async () => {
    const o = await newOuter("t8", inner.d1);
    const v = await run(o, inner.gitOps, inner.c2, BOGUS_SHA);
    // An undecidable LANDING must not reject — and must not open an incident,
    // which the `undecided` verdict is what prevents downstream.
    expect(v.kind).toBe("undecided");
    if (v.kind !== "undecided") throw new Error("not undecided");
    expect(v.detail).toMatch(/landing isAncestor threw/i);
  }, 40_000);

  it("T9. readSubmoduleGitlink throws (no 160000 entry at the path) → undecided", async () => {
    const o = await newOuter("t9", null);
    const v = await run(o, inner.gitOps, inner.c2, inner.a1);
    expect(v.kind).toBe("undecided");
    if (v.kind !== "undecided") throw new Error("not undecided");
    // A misconfigured gitlinkPath and a git failure are equally UNDECIDED.
    expect(v.detail).toMatch(/could not read outer main's gitlink/i);
  }, 40_000);

  it("T10. objectPresent throws, and the inner fetch throws → undecided in both", async () => {
    const o = await newOuter("t10", ABSENT_SHA);
    const probeThrew = await run(
      o,
      spyInner({
        objectPresent: async () => {
          throw new Error("cat-file exploded");
        },
      }).gitOps,
      inner.c2,
      inner.a1,
    );
    expect(probeThrew.kind).toBe("undecided");

    const fetchThrew = await run(
      o,
      spyInner({
        fetch: async () => {
          throw new Error("transport is down");
        },
      }).gitOps,
      inner.c2,
      inner.a1,
    );
    expect(fetchThrew.kind).toBe("undecided");
    if (fetchThrew.kind !== "undecided") throw new Error("not undecided");
    // A transport error is TRANSIENT and must never become a terminal reject.
    expect(fetchThrew.detail).toMatch(/transport/i);
  }, 40_000);

  it("T11. totality: an inner GitOps whose every method throws → undecided, and the call itself does not throw", async () => {
    const o = await newOuter("t11", inner.d1);
    const exploding = new Proxy({} as GitOps, {
      get() {
        return () => {
          throw new Error("everything is broken");
        };
      },
    });
    const v = await run(o, exploding, inner.c2, inner.a1);
    expect(v.kind).toBe("undecided");
  }, 40_000);

  it("the outer gitOps is never asked to mutate anything — detection only", async () => {
    const o = await newOuter("t12", inner.d1);
    const touched: string[] = [];
    const watched = new Proxy(o.gitOps, {
      get(target, prop: string, recv) {
        touched.push(prop);
        return Reflect.get(target, prop, recv) as unknown;
      },
    });
    await run({ gitOps: watched, outerMainSha: o.outerMainSha }, inner.gitOps, inner.c2, inner.a1);
    // One read, and only a read.
    expect(touched).toEqual(["readSubmoduleGitlink"]);
  }, 40_000);

  describe("describeDanglingMainGitlink", () => {
    const facts = {
      gitlinkPath: GITLINK_PATH,
      target: "2f448c0a",
      outerMainSha: "9f3c1a2b",
      innerMainSha: "0d82eba4",
      landingInnerSha: "7e11aa90",
    };

    it("names ALL THREE commits it judged, in both presence variants", () => {
      for (const presence of ["present", "absent"] as const) {
        const text = describeDanglingMainGitlink({ kind: "dangling", presence, ...facts });
        // The 2026-08-22 lesson: a rejection that names no commit is
        // investigated as a conflict in the author's own change.
        expect(text).toContain(facts.outerMainSha);
        expect(text).toContain(facts.innerMainSha);
        expect(text).toContain(facts.landingInnerSha);
        expect(text).toContain(facts.target);
        expect(text).toContain(facts.gitlinkPath);
        // The composition appends ` — <why>` next, so it must not terminate.
        expect(text.endsWith(".")).toBe(false);
      }
    });

    it("distinguishes present from absent, and says the fetch already ran", () => {
      expect(
        describeDanglingMainGitlink({ kind: "dangling", presence: "present", ...facts }),
      ).toMatch(/present in the inner repo/);
      expect(
        describeDanglingMainGitlink({ kind: "dangling", presence: "absent", ...facts }),
      ).toMatch(/absent from the inner repo even after an all-refs fetch/);
    });
  });
});
