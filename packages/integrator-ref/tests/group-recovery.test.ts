/**
 * Phase 7.3 Step 12 — orphaned-inner recovery tests (real two-repo fixture).
 *
 * Reuses the group-land.test.ts shape: inner + outer bare repos, per-repo
 * worktree pools, binding clones. The recovery SEED is the post-orphan world:
 * the inner bare main is at `O` (advanced past the gitlink'd SHA), the outer
 * bare main's gitlink references `P` (a pre-orphan inner SHA). An OPEN
 * `orphaned_inner` incident (orphanedSha = O) is the durable PM record recovery
 * keys off.
 *
 * Proves:
 *  (a) RECONCILABLE (P ancestor of O, linear) → auto-rollforward: outer bare
 *      main advances, gitlink → O, resolveIncident(auto_rollforward, ...),
 *      inner bare main UNCHANGED, worktrees reacquirable.
 *  (b) un-reconcilable (gitlink at a divergent C, isAncestor(C, O) false) →
 *      escalate: incident STAYS open, outer bare main UNCHANGED, escalation log
 *      fired, worktrees reacquirable.
 *  (c) recovery verify-fail (reconcilable but outer verify exits non-zero) →
 *      escalate: incident open, outer bare main UNCHANGED (R1), reacquirable.
 *  (d) push-race (outer push induced non_fast_forward) → deferred: incident
 *      open, outer UNCHANGED, no resolveIncident.
 *  (e) R1 cross-check: across all escalate/defer cases outer bare main is
 *      byte-identical pre/post; the auto-resolve case advances ONLY to gitlink→O
 *      AND pushedSha === resolution.outerLandedSha.
 *  (f) PM-keyed not git-keyed: git LOOKS like an orphan but NO open incident →
 *      recoverOrphanedInner returns empty outcomes, does NOTHING.
 *  (g) isAncestor git-ops unit (§1): linear + divergent + bad-object cases.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { MergeIncidentView } from "@pm/shared";
import { createGitOps, type GitOps, type PushResult, type VerifyResult } from "../src/git-ops.js";
import { createWorktreePool, type WorktreePool } from "../src/worktree-pool.js";
import { createLogger } from "../src/logger.js";
import type { RepoLane } from "../src/group-integration.js";
import { recoverOrphanedInner, type RecoverOrphanedInnerDeps } from "../src/group-recovery.js";

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
const GIT_MAIN = "main";

function nowIso(): string {
  return new Date().toISOString();
}

// ─── In-memory fake PM client (recovery surface) ──────────────────────

interface FakeIncidentStore {
  incidents: MergeIncidentView[];
  /** Ordered call log. */
  calls: string[];
  /** Recorded resolveIncident calls. */
  resolves: {
    incidentId: string;
    mode: string;
    outerLandedSha?: string;
    resolvedByGroupId?: string;
  }[];
}

function makeIncident(over: Partial<MergeIncidentView>): MergeIncidentView {
  return {
    id: "inc-1",
    projectId: "proj-1",
    groupId: "grp-1",
    type: "orphaned_inner",
    innerRepo: "rynx-inner",
    orphanedSha: "0".repeat(40),
    outerRepo: "app-outer",
    innerRequestId: "req-inner",
    taskId: "task-inner",
    state: "open",
    openedAt: nowIso(),
    resolvedAt: null,
    resolution: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...over,
  };
}

function makeFakePm(store: FakeIncidentStore): RecoverOrphanedInnerDeps["pmClient"] {
  const fake = {
    async listMergeIncidents(
      _projectId: string,
      filters?: { state?: string; type?: string },
    ): Promise<MergeIncidentView[]> {
      store.calls.push("listMergeIncidents");
      return store.incidents.filter(
        (i) =>
          (!filters?.state || i.state === filters.state) &&
          (!filters?.type || i.type === filters.type),
      );
    },
    async resolveIncident(
      incidentId: string,
      body: {
        mode: string;
        outerLandedSha?: string;
        resolvedByGroupId?: string;
      },
    ): Promise<MergeIncidentView> {
      store.calls.push("resolveIncident");
      store.resolves.push({ incidentId, ...body });
      const inc = store.incidents.find((i) => i.id === incidentId);
      if (inc) {
        inc.state = "auto_resolved";
        inc.resolvedAt = nowIso();
        inc.resolution = {
          mode: body.mode as "auto_rollforward" | "human",
          outerLandedSha: body.outerLandedSha,
          resolvedByGroupId: body.resolvedByGroupId,
        };
      }
      return inc as MergeIncidentView;
    },
  };
  return fake as unknown as RecoverOrphanedInnerDeps["pmClient"];
}

// ─── gitOps wrappers (induced push-fail / verify-fail) ────────────────

function failingPushGitOps(
  real: (p: string) => GitOps,
  reason: "non_fast_forward" | "auth" | "network" | "other",
  failOnPathSubstring: string,
): (p: string) => GitOps {
  return (p: string): GitOps => {
    const g = real(p);
    if (!p.includes(failOnPathSubstring)) return g;
    return {
      ...g,
      async push(): Promise<PushResult> {
        return { ok: false, reason, stderr: `induced ${reason}` };
      },
    };
  };
}

function failingVerifyGitOps(real: (p: string) => GitOps): (p: string) => GitOps {
  return (p: string): GitOps => {
    const g = real(p);
    return {
      ...g,
      async runVerify(): Promise<VerifyResult> {
        return {
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "induced verify fail",
          durationMs: 1,
          timedOut: false,
          logPath: "n/a",
        };
      },
    };
  };
}

// ─── Fixture ──────────────────────────────────────────────────────────

describe.skipIf(!GIT_AVAILABLE)("recoverOrphanedInner (real two-repo)", () => {
  let tmpRoot: string;
  let innerBare: string;
  let outerBare: string;
  let innerP: string; // pre-orphan inner SHA (the seeded gitlink target)
  let innerO: string; // orphaned inner SHA (inner main advanced here)
  let innerC: string; // a DIVERGENT inner SHA off P (for the un-reconcilable case)
  let innerPool: WorktreePool;
  let outerPool: WorktreePool;
  let innerBindGit: SimpleGit;
  let outerBindGit: SimpleGit;
  const logger = createLogger("error");

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-grprec-"));
    innerBare = path.join(tmpRoot, "inner.git");
    outerBare = path.join(tmpRoot, "outer.git");
    const worktreeRoot = path.join(tmpRoot, "wtroot");

    await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
    await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);

    // ── seed INNER: P (base) → O (advanced inner main), plus a divergent C off P ──
    const innerSeed = path.join(tmpRoot, "inner-seed");
    await simpleGit().clone(innerBare, innerSeed);
    const ig = simpleGit(innerSeed);
    await configIdentity(ig);
    writeFileSync(path.join(innerSeed, "lib.txt"), "v1\n");
    await ig.add(["lib.txt"]);
    await ig.commit("inner P (pre-orphan gitlink target)");
    await ig.branch(["-M", "main"]);
    innerP = (await ig.revparse(["HEAD"])).trim();

    // A divergent branch off P → C (NOT an ancestor of O).
    await ig.checkoutLocalBranch("divergent");
    writeFileSync(path.join(innerSeed, "diverge.txt"), "divergent line\n");
    await ig.add(["diverge.txt"]);
    await ig.commit("inner C (divergent off P)");
    innerC = (await ig.revparse(["HEAD"])).trim();
    // Publish the divergent branch so C is present in the inner bare (recovery's
    // fetchFromPath / the un-reconcilable bump need C reachable there).
    await ig.push(["-u", "origin", "divergent"]);

    // Back to main, advance P → O (linear; O is a descendant of P).
    await ig.checkout("main");
    writeFileSync(path.join(innerSeed, "lib.txt"), "v2\n");
    await ig.add(["lib.txt"]);
    await ig.commit("inner O (advanced inner main; orphaned SHA)");
    innerO = (await ig.revparse(["HEAD"])).trim();
    // Push inner main @O (O is published on inner main — the orphan precondition).
    await ig.push(["-u", "origin", "main"]);

    // ── seed OUTER: main with gitlink @ P (pre-orphan). ──
    const outerSeed = path.join(tmpRoot, "outer-seed");
    await simpleGit().clone(outerBare, outerSeed);
    const og = simpleGit(outerSeed);
    await configIdentity(og);
    writeFileSync(path.join(outerSeed, "top.txt"), "top v1\n");
    const innerUrlForGitmodules = innerBare.replace(/\\/g, "/");
    writeFileSync(
      path.join(outerSeed, ".gitmodules"),
      `[submodule "rynx"]\n\tpath = ${GITLINK_PATH}\n\turl = ${innerUrlForGitmodules}\n`,
    );
    await og.add(["top.txt", ".gitmodules"]);
    await og.raw(["update-index", "--add", "--cacheinfo", `160000,${innerP},${GITLINK_PATH}`]);
    await og.commit("outer main with gitlink @ P");
    await og.branch(["-M", "main"]);
    await og.push(["-u", "origin", "main"]);

    innerPool = createWorktreePool({
      worktreeRoot,
      worktreeName: "inner",
      gitRepoUrl: innerBare,
      gitRemote: GIT_REMOTE,
      gitMainBranch: GIT_MAIN,
      parallelism: 1,
      cleanKeep: [],
    });
    outerPool = createWorktreePool({
      worktreeRoot,
      worktreeName: "outer",
      gitRepoUrl: outerBare,
      gitRemote: GIT_REMOTE,
      gitMainBranch: GIT_MAIN,
      parallelism: 1,
      cleanKeep: [],
    });
    await innerPool.ensureAll();
    await outerPool.ensureAll();

    // The outer worktree embeds a gitlink whose target SHA shifts across the
    // recovery tests (P → O on auto-resolve, P → C on the un-reconcilable bump).
    // git's default `fetch.recurseSubmodules=on-demand` then tries to fetch the
    // (uninitialized) `vendor/rynx` submodule whenever resetForAttempt's fetch
    // observes the gitlink change — "Could not access submodule". The integrator
    // never initializes the submodule (it only manipulates the gitlink SHA, by
    // design §2.3), so disable submodule recursion on the outer worktree's git
    // config. Set it once (persists in .git/config across resetForAttempt).
    {
      const owt = outerPool.acquire();
      if (owt) {
        await simpleGit(owt.path).addConfig("fetch.recurseSubmodules", "false");
        outerPool.release(owt);
      }
    }

    const innerBind = path.join(tmpRoot, "inner-bind");
    const outerBind = path.join(tmpRoot, "outer-bind");
    await simpleGit().clone(innerBare, innerBind);
    await simpleGit().clone(outerBare, outerBind);
    innerBindGit = simpleGit(innerBind);
    outerBindGit = simpleGit(outerBind);
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function readSubmoduleGitlinkOnBareMain(): Promise<string> {
    const out = await simpleGit(outerBare).raw(["ls-tree", GIT_MAIN, GITLINK_PATH]);
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === "160000" && parts[2]) return parts[2];
    }
    throw new Error("no gitlink on outer bare main");
  }

  async function bareMainSha(bare: string): Promise<string> {
    return (await simpleGit(bare).revparse([GIT_MAIN])).trim();
  }

  // Push a NEW outer main commit that re-points the gitlink to `sha` (used to
  // simulate the un-reconcilable intervening-outer-history case before recovery).
  async function bumpOuterGitlinkTo(sha: string): Promise<void> {
    const bump = path.join(tmpRoot, `outer-bump-${Math.random().toString(36).slice(2)}`);
    await simpleGit().clone(outerBare, bump);
    const bg = simpleGit(bump);
    await configIdentity(bg);
    await bg.raw(["update-index", "--add", "--cacheinfo", `160000,${sha},${GITLINK_PATH}`]);
    await bg.commit("intervening outer: bump gitlink to divergent C");
    await bg.push(["origin", "main"]);
  }

  // Restore the outer bare main to gitlink @ P (so each test starts from the
  // canonical pre-orphan world regardless of prior test mutations).
  async function restoreOuterToP(): Promise<void> {
    const cur = await readSubmoduleGitlinkOnBareMain();
    if (cur === innerP) return;
    const restore = path.join(tmpRoot, `outer-restore-${Math.random().toString(36).slice(2)}`);
    await simpleGit().clone(outerBare, restore);
    const rg = simpleGit(restore);
    await configIdentity(rg);
    await rg.raw(["update-index", "--add", "--cacheinfo", `160000,${innerP},${GITLINK_PATH}`]);
    await rg.commit("restore outer gitlink to P");
    await rg.push(["origin", "main"]);
  }

  function innerLane(over?: Partial<RepoLane>): RepoLane {
    return {
      role: "inner",
      name: "rynx-inner",
      acquire: () => innerPool.acquire(),
      release: (wt) => innerPool.release(wt),
      gitOps: (p) => createGitOps(simpleGit(p)),
      gitlinkPath: GITLINK_PATH,
      resolveRefInClone: async (ref) => {
        try {
          return (await innerBindGit.revparse(["--verify", `${ref}^{commit}`])).trim();
        } catch {
          return null;
        }
      },
      ...over,
    };
  }
  function outerLane(over?: Partial<RepoLane>): RepoLane {
    return {
      role: "outer",
      name: "app-outer",
      acquire: () => outerPool.acquire(),
      release: (wt) => outerPool.release(wt),
      gitOps: (p) => createGitOps(simpleGit(p)),
      resolveRefInClone: async (ref) => {
        try {
          return (await outerBindGit.revparse(["--verify", `${ref}^{commit}`])).trim();
        } catch {
          return null;
        }
      },
      ...over,
    };
  }

  function depsFor(
    store: FakeIncidentStore,
    over?: Partial<RecoverOrphanedInnerDeps>,
  ): RecoverOrphanedInnerDeps {
    return {
      pmClient: makeFakePm(store),
      logger,
      innerLane: innerLane(),
      outerLane: outerLane(),
      gitRemote: GIT_REMOTE,
      gitMainBranch: GIT_MAIN,
      defaultVerifyCommand: "echo recovery-verify-ok",
      verifyTimeoutSec: 30,
      innerRemotePath: innerBare,
      ...over,
    };
  }

  function assertPoolsReacquirable(): void {
    const i = innerPool.acquire();
    const o = outerPool.acquire();
    expect(i).not.toBeNull();
    expect(o).not.toBeNull();
    if (i) innerPool.release(i);
    if (o) outerPool.release(o);
  }

  // ── (a) reconcilable → auto-rollforward ──
  it("reconcilable (P ancestor of O) → auto-rollforward: outer advances to gitlink→O, resolveIncident, inner UNCHANGED, reacquirable", async () => {
    await restoreOuterToP();
    const innerBefore = await bareMainSha(innerBare);
    const store: FakeIncidentStore = {
      incidents: [makeIncident({ orphanedSha: innerO })],
      calls: [],
      resolves: [],
    };
    const deps = depsFor(store);

    const result = await recoverOrphanedInner(
      { projectId: "proj-1", resource: "main", currentGroupId: "grp-current" },
      deps,
    );

    expect(result.outcomes).toHaveLength(1);
    const out = result.outcomes[0];
    expect(out.kind).toBe("auto_resolved");
    if (out.kind !== "auto_resolved") throw new Error("not auto_resolved");

    // Outer bare main advanced; gitlink now @ O.
    expect(await readSubmoduleGitlinkOnBareMain()).toBe(innerO);
    // resolveIncident(auto_rollforward, outerLandedSha = pushedSha, group).
    expect(store.resolves).toHaveLength(1);
    expect(store.resolves[0]).toMatchObject({
      incidentId: "inc-1",
      mode: "auto_rollforward",
      resolvedByGroupId: "grp-current",
    });
    // (e) R1: pushedSha === resolution.outerLandedSha === new outer main.
    expect(out.outerLandedSha).toBe(store.resolves[0].outerLandedSha);
    expect(await bareMainSha(outerBare)).toBe(out.outerLandedSha);
    // Inner bare main UNCHANGED (recovery never touches inner).
    expect(await bareMainSha(innerBare)).toBe(innerBefore);

    assertPoolsReacquirable();
  }, 30_000);

  // ── (b) un-reconcilable → escalate ──
  it("un-reconcilable (gitlink @ divergent C, isAncestor(C,O) false) → escalate: incident open, outer UNCHANGED, reacquirable", async () => {
    // An intervening outer commit bumps the gitlink to the divergent C.
    await bumpOuterGitlinkTo(innerC);
    const outerBefore = await bareMainSha(outerBare);
    const gitlinkBefore = await readSubmoduleGitlinkOnBareMain();
    expect(gitlinkBefore).toBe(innerC);

    const store: FakeIncidentStore = {
      incidents: [makeIncident({ orphanedSha: innerO })],
      calls: [],
      resolves: [],
    };
    const deps = depsFor(store);

    const result = await recoverOrphanedInner({ projectId: "proj-1", resource: "main" }, deps);

    expect(result.outcomes).toHaveLength(1);
    const out = result.outcomes[0];
    expect(out.kind).toBe("escalated");
    if (out.kind !== "escalated") throw new Error("not escalated");
    expect(out.reason).toMatch(/not ancestor/i);

    // Incident STAYS open (no resolveIncident).
    expect(store.resolves).toHaveLength(0);
    expect(store.incidents[0].state).toBe("open");
    // (e) R1: outer bare main BYTE-IDENTICAL pre/post.
    expect(await bareMainSha(outerBare)).toBe(outerBefore);
    expect(await readSubmoduleGitlinkOnBareMain()).toBe(gitlinkBefore);

    assertPoolsReacquirable();
    await restoreOuterToP();
  }, 30_000);

  // ── (c) recovery verify-fail → escalate ──
  it("verify-fail (reconcilable but outer verify exits non-zero) → escalate: incident open, outer UNCHANGED (R1), reacquirable", async () => {
    await restoreOuterToP();
    const outerBefore = await bareMainSha(outerBare);

    const store: FakeIncidentStore = {
      incidents: [makeIncident({ orphanedSha: innerO })],
      calls: [],
      resolves: [],
    };
    const deps = depsFor(store, {
      outerLane: outerLane({
        gitOps: failingVerifyGitOps((p) => createGitOps(simpleGit(p))),
      }),
    });

    const result = await recoverOrphanedInner({ projectId: "proj-1", resource: "main" }, deps);

    expect(result.outcomes).toHaveLength(1);
    const out = result.outcomes[0];
    expect(out.kind).toBe("escalated");
    if (out.kind !== "escalated") throw new Error("not escalated");
    expect(out.reason).toMatch(/verify/i);

    expect(store.resolves).toHaveLength(0);
    expect(store.incidents[0].state).toBe("open");
    // R1: outer main UNCHANGED (no push on verify-fail).
    expect(await bareMainSha(outerBare)).toBe(outerBefore);

    assertPoolsReacquirable();
  }, 30_000);

  // ── (d) push-race → deferred ──
  it("push-race (outer push induced non_fast_forward) → deferred: incident open, outer UNCHANGED, no resolveIncident", async () => {
    await restoreOuterToP();
    const outerBefore = await bareMainSha(outerBare);

    const store: FakeIncidentStore = {
      incidents: [makeIncident({ orphanedSha: innerO })],
      calls: [],
      resolves: [],
    };
    const deps = depsFor(store, {
      outerLane: outerLane({
        gitOps: failingPushGitOps((p) => createGitOps(simpleGit(p)), "non_fast_forward", "outer"),
      }),
    });

    const result = await recoverOrphanedInner({ projectId: "proj-1", resource: "main" }, deps);

    expect(result.outcomes).toHaveLength(1);
    const out = result.outcomes[0];
    expect(out.kind).toBe("deferred");
    if (out.kind !== "deferred") throw new Error("not deferred");
    expect(out.reason).toMatch(/push race/i);

    expect(store.resolves).toHaveLength(0);
    expect(store.incidents[0].state).toBe("open");
    // R1: outer main UNCHANGED (push rejected → no advance).
    expect(await bareMainSha(outerBare)).toBe(outerBefore);

    assertPoolsReacquirable();
  }, 30_000);

  // ── (f) PM-keyed, NOT git-keyed ──
  it("git LOOKS like an orphan but NO open incident → recoverOrphanedInner does NOTHING (empty outcomes, no lease/push)", async () => {
    await restoreOuterToP();
    const outerBefore = await bareMainSha(outerBare);
    const innerBefore = await bareMainSha(innerBare);

    // Inner main is ahead of the gitlink (looks like an orphan), but the store
    // has NO open incident.
    const store: FakeIncidentStore = {
      incidents: [],
      calls: [],
      resolves: [],
    };
    const deps = depsFor(store);

    const result = await recoverOrphanedInner({ projectId: "proj-1", resource: "main" }, deps);

    expect(result.outcomes).toHaveLength(0);
    expect(store.resolves).toHaveLength(0);
    // Nothing mutated: outer + inner bare mains byte-identical.
    expect(await bareMainSha(outerBare)).toBe(outerBefore);
    expect(await bareMainSha(innerBare)).toBe(innerBefore);

    // Worktrees never leased → still reacquirable.
    assertPoolsReacquirable();
  }, 30_000);

  // ── (g) isAncestor git-ops unit ──
  it("isAncestor: linear A→O true, O→A false, divergent C→O false, bad object REJECTS", async () => {
    const wt = innerPool.acquire();
    expect(wt).not.toBeNull();
    if (!wt) throw new Error("no worktree");
    try {
      await wt.resetForAttempt();
      const git = createGitOps(simpleGit(wt.path));
      await git.fetch(GIT_REMOTE);
      // Make sure C is fetchable in the worktree (it lives only on the divergent
      // branch in the inner bare — fetch the SHA directly).
      await git.fetchFromPath(innerBare, innerC);

      // Linear: P is an ancestor of O (P→O on main).
      expect(await git.isAncestor(innerP, innerO)).toBe(true);
      // O is NOT an ancestor of P.
      expect(await git.isAncestor(innerO, innerP)).toBe(false);
      // Divergent C off P is NOT an ancestor of O.
      expect(await git.isAncestor(innerC, innerO)).toBe(false);
      // A bad/nonexistent object → REJECTS (not silently false).
      await expect(git.isAncestor("dead".repeat(10), innerO)).rejects.toThrow();
    } finally {
      innerPool.release(wt);
    }
  }, 30_000);
});
