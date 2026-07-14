/**
 * Inner-only groups (campaign 2026-06-10) — synthetic-outer member tests
 * (real two-repo fixtures).
 *
 * The stale-outer-bump failure class: a worker-minted outer gitlink-bump
 * branch conflicts the moment ANY other gitlink change lands on outer main
 * (every game_one group rejection on 2026-06-10). With a synthetic outer
 * member the integrator synthesizes the outer candidate AT ASSEMBLY — one
 * gitlink-bump commit on top of LIVE outer main, no pre-minted branch, no
 * outer rebase ⇒ `outer_conflict` structurally unreachable.
 *
 * Mirrors the group-integration.test.ts / group-land.test.ts idioms exactly:
 * bare repos (--initial-branch=main) + seed clones + configIdentity, the
 * .gitmodules forward-slash URL, a seeded 160000 gitlink, size-1
 * createWorktreePool pairs, binding clones with the resolveVerified idiom,
 * and the fuller FakePm from group-land.test.ts (landGroupBody /
 * attemptCompletions / ordered calls).
 *
 * Proves: (a) the binding (unresolvable ref / two synthetics / a ref-carrying
 * synthetic → rejected PRE-pickup, no leak; a lone OUTER real member now binds
 * real→outer / synthetic→inner and reaches ready_to_land — no longer rejected);
 * (b) synthetic assembly (baseOuterSha == live outer main; Ro == exactly ONE
 * gitlink commit on top of it; gitlink @ Ri; materialized working tree;
 * truthful attempt bases); (c) the land flows UNCHANGED keyed by requestId
 * (synthetic outer's landedSha == Ro, role "outer"); (d) CONFLICT-IMMUNITY —
 * the live game_one drift at unit level: another gitlink land advances outer
 * main between submit and integrate, and the synthetic group still lands;
 * (e) the NO-OP land — content already on both mains → idempotent gitlink op
 * (no empty bump commit ever exists) + up-to-date FF pushes land cleanly at
 * the current mains; (f) OUTER-ONLY (synthetic-inner, Tier-3, campaign
 * umbrella-widening P4): a lone outer lands with inner as a no-op (Ri = live
 * inner main), ancestry-gated — ancestor+source → normalize+LANDS, pure bump →
 * convert+LANDS, present-but-not-ancestor → gitlink_diverged, absent-after-
 * fetch → gitlink_unreachable (both Tier-2 legible rejects on the real outer).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { MergeAttemptView, MergeRequestView } from "@pm/shared";
import { createGitOps } from "../src/git-ops.js";
import { createWorktreePool, type WorktreePool } from "../src/worktree-pool.js";
import { createLogger } from "../src/logger.js";
import {
  runGroupIntegration,
  type GroupIntegrationDeps,
  type RepoLane,
} from "../src/group-integration.js";
import { landAssembledGroup } from "../src/group-land.js";

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

/**
 * Resolve `ref` in a clone, returning the SHA only if the object actually
 * EXISTS here. `--verify <ref>^{commit}` fails (→ null) on an absent object —
 * unlike a bare `rev-parse <full-sha>` which echoes any 40-hex back.
 */
async function resolveVerified(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    return (await git.revparse(["--verify", `${ref}^{commit}`])).trim();
  } catch {
    return null;
  }
}

// ─── In-memory fake PM client (the fuller group-land surface) ─────────

interface FakeGroupState {
  state: "forming" | "integrating" | "rejected" | "landed" | "partially_landed";
  members: MergeRequestView[];
}

interface OpenedIncident {
  id: string;
  projectId: string;
  type: string;
  innerRepo: string;
  orphanedSha: string;
  outerRepo: string;
  groupId?: string | null;
  innerRequestId?: string | null;
  taskId?: string | null;
}

interface FakePm {
  group: FakeGroupState;
  attempts: MergeAttemptView[];
  /** Ordered call log (the passed-before-landGroup assertion reads this). */
  calls: string[];
  rejectPayload?: { reason: string; category?: string };
  /** landGroup body (members + roles). */
  landGroupBody?: {
    members: { requestId: string; landedSha: string; role: string }[];
  };
  /** Recorded openIncident params. */
  incident?: OpenedIncident;
  /** Recorded markPartiallyLanded body. */
  partiallyLanded?: { reason: string; incidentId?: string };
  /** Recorded markInnerOrphaned (requestId → orphanedSha). */
  orphaned?: { requestId: string; orphanedSha: string };
  /** Recorded per-request rejectMergeRequest. */
  requestRejects: { requestId: string; category: string; reason: string }[];
  /** Per-attempt completion payloads, in order. */
  attemptCompletions: {
    attemptId: string;
    status: string;
    treeSha?: string;
    steps?: unknown[];
  }[];
  /** Recorded noteOuterConverted args (Direction-C surfacing). */
  outerConverted?: { requestId: string; reason: string };
  /** Recorded noteOuterGitlinkNormalized args (P2/P4 normalization surfacing). */
  outerGitlinkNormalized?: { requestId: string; reason: string };
  /** Recorded merge_rejection task comments (rejectGroupLegibly), in order. */
  comments: { taskId: string; commentType: string; category?: string; reason?: string }[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeFakePm(state: FakePm): GroupIntegrationDeps["pmClient"] {
  let seq = 0;
  let incidentSeq = 0;
  const fake = {
    async markGroupIntegrating(_id: string): Promise<unknown> {
      state.calls.push("markGroupIntegrating");
      state.group.state = "integrating";
      for (const m of state.group.members) m.status = "integrating";
      return { ...state.group };
    },
    async rejectGroup(
      _id: string,
      payload: { reason: string; category?: string },
    ): Promise<unknown> {
      state.calls.push("rejectGroup");
      state.rejectPayload = payload;
      state.group.state = "rejected";
      for (const m of state.group.members) {
        if (m.status === "queued" || m.status === "integrating") {
          m.status = "rejected";
          m.rejectReason = payload.reason;
        }
      }
      return { ...state.group };
    },
    async startAttempt(requestId: string, baseSha: string): Promise<MergeAttemptView> {
      seq += 1;
      const att: MergeAttemptView = {
        id: `att-${seq}`,
        requestId,
        attemptNumber: seq,
        baseSha,
        treeSha: null,
        status: "running",
        startedAt: nowIso(),
        completedAt: null,
        verifyDurationMs: null,
        failureCategory: null,
        failureReason: null,
        failedFiles: null,
        logExcerpt: null,
        logUrl: null,
        createdAt: nowIso(),
      };
      state.attempts.push(att);
      state.calls.push(`startAttempt:${requestId}`);
      return att;
    },
    async completeAttempt(
      attemptId: string,
      body: { status: string; treeSha?: string; steps?: unknown[] },
    ): Promise<MergeAttemptView> {
      const att = state.attempts.find((a) => a.id === attemptId);
      if (!att) throw new Error(`no attempt ${attemptId}`);
      att.status = body.status as MergeAttemptView["status"];
      att.completedAt = nowIso();
      if (body.treeSha) att.treeSha = body.treeSha;
      state.calls.push(`completeAttempt:${body.status}`);
      state.attemptCompletions.push({
        attemptId,
        status: body.status,
        treeSha: body.treeSha,
        steps: body.steps,
      });
      return att;
    },
    // ── group-land family ──
    async landGroup(
      _groupId: string,
      body: {
        members: { requestId: string; landedSha: string; role: string }[];
      },
    ): Promise<unknown> {
      state.calls.push("landGroup");
      state.landGroupBody = body;
      state.group.state = "landed";
      for (const m of state.group.members) {
        const land = body.members.find((b) => b.requestId === m.id);
        if (land) {
          m.status = "landed";
          m.landedSha = land.landedSha;
        }
      }
      return { ...state.group };
    },
    async markInnerOrphaned(requestId: string, orphanedSha: string): Promise<unknown> {
      state.calls.push("markInnerOrphaned");
      state.orphaned = { requestId, orphanedSha };
      const m = state.group.members.find((x) => x.id === requestId);
      if (m) {
        m.status = "orphaned" as MergeRequestView["status"];
        m.landedSha = orphanedSha;
      }
      return m;
    },
    async openIncident(params: {
      projectId: string;
      type: string;
      innerRepo: string;
      orphanedSha: string;
      outerRepo: string;
      groupId?: string | null;
      innerRequestId?: string | null;
      taskId?: string | null;
    }): Promise<{ id: string }> {
      state.calls.push("openIncident");
      incidentSeq += 1;
      state.incident = { id: `inc-${incidentSeq}`, ...params };
      return { id: state.incident.id };
    },
    async markPartiallyLanded(
      _groupId: string,
      body: { reason: string; incidentId?: string },
    ): Promise<unknown> {
      state.calls.push("markPartiallyLanded");
      state.partiallyLanded = body;
      state.group.state = "partially_landed";
      return { ...state.group };
    },
    async rejectMergeRequest(
      requestId: string,
      payload: { category: string; reason: string },
    ): Promise<unknown> {
      state.calls.push("rejectMergeRequest");
      state.requestRejects.push({
        requestId,
        category: payload.category,
        reason: payload.reason,
      });
      const m = state.group.members.find((x) => x.id === requestId);
      if (m) {
        m.status = "rejected";
        m.rejectReason = payload.reason;
      }
      return m;
    },
    // ── surfacing spies (Direction-C conversion + P2/P4 normalization) ──
    async noteOuterConverted(requestId: string, reason: string): Promise<void> {
      state.calls.push("noteOuterConverted");
      state.outerConverted = { requestId, reason };
    },
    async noteOuterGitlinkNormalized(requestId: string, reason: string): Promise<void> {
      state.calls.push("noteOuterGitlinkNormalized");
      state.outerGitlinkNormalized = { requestId, reason };
    },
    // ── legibility: the per-real-member merge_rejection task comment ──
    async postTaskComment(
      taskId: string,
      body: { commentType: string; metadata?: { category?: string; reason?: string } },
    ): Promise<unknown> {
      state.calls.push("postTaskComment");
      state.comments.push({
        taskId,
        commentType: body.commentType,
        category: body.metadata?.category,
        reason: body.metadata?.reason,
      });
      return {};
    },
  };
  return fake as unknown as GroupIntegrationDeps["pmClient"];
}

function makeMember(over: Partial<MergeRequestView>): MergeRequestView {
  return {
    id: "req-1",
    projectId: "proj-1",
    resource: "main",
    submittedBy: "worker-1",
    taskId: null,
    resolvedFrom: null,
    synthetic: false,
    branch: null,
    commitSha: null,
    verifyCmd: null,
    worktreePath: null,
    status: "queued",
    enqueuedAt: nowIso(),
    pickedUpAt: null,
    resolvedAt: null,
    landedSha: null,
    rejectCategory: null,
    rejectReason: null,
    failedFiles: null,
    logExcerpt: null,
    logUrl: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...over,
  };
}

/** The PM-minted synthetic outer member: ref-less, ownerless of intent. */
function makeSynthetic(over: Partial<MergeRequestView> = {}): MergeRequestView {
  return makeMember({
    id: "req-synth",
    synthetic: true,
    branch: null,
    commitSha: null,
    verifyCmd: null,
    taskId: null,
    ...over,
  });
}

// ─── Main fixture: binding guard + assembly + land ─────────────────────

describe.skipIf(!GIT_AVAILABLE)("synthetic-outer groups (real two-repo)", () => {
  let tmpRoot: string;
  let innerBare: string;
  let outerBare: string;
  let innerMainSha: string;
  let innerFeatureSha: string;
  let outerFeatureSha: string;
  let innerPool: WorktreePool;
  let outerPool: WorktreePool;
  let innerBindGit: SimpleGit;
  let outerBindGit: SimpleGit;
  const logger = createLogger("error");

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-grpsynth-"));
    innerBare = path.join(tmpRoot, "inner.git");
    outerBare = path.join(tmpRoot, "outer.git");
    const worktreeRoot = path.join(tmpRoot, "wtroot");

    await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
    await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);

    // ── seed INNER ──
    const innerSeed = path.join(tmpRoot, "inner-seed");
    await simpleGit().clone(innerBare, innerSeed);
    const ig = simpleGit(innerSeed);
    await configIdentity(ig);
    writeFileSync(path.join(innerSeed, "lib.txt"), "v1\n");
    await ig.add(["lib.txt"]);
    await ig.commit("inner main base");
    await ig.branch(["-M", "main"]);
    await ig.push(["-u", "origin", "main"]);
    innerMainSha = (await ig.revparse(["HEAD"])).trim();

    // The REAL inner change (a fresh feature sha — guarantees a REAL gitlink
    // bump: Ri != the seeded gitlink innerMainSha).
    await ig.checkoutLocalBranch("feature/inner");
    writeFileSync(path.join(innerSeed, "feature.txt"), "inner feature\n");
    await ig.add(["feature.txt"]);
    await ig.commit("inner feature commit");
    await ig.push(["-u", "origin", "feature/inner"]);
    innerFeatureSha = (await ig.revparse(["HEAD"])).trim();

    // ── seed OUTER (with the gitlink) ──
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
    await og.raw([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${innerMainSha},${GITLINK_PATH}`,
    ]);
    await og.commit("outer main base with gitlink");
    await og.branch(["-M", "main"]);
    await og.push(["-u", "origin", "main"]);

    // An OUTER-repo commit (for the binding-guard outer-bound sub-case: a real
    // member whose ref binds to the OUTER repo must be rejected with guidance).
    await og.checkoutLocalBranch("feature/outer");
    writeFileSync(path.join(outerSeed, "app.txt"), "outer feature\n");
    await og.add(["app.txt"]);
    await og.commit("outer feature commit");
    await og.push(["-u", "origin", "feature/outer"]);
    outerFeatureSha = (await og.revparse(["HEAD"])).trim();

    // ── per-repo pools (parallelism 1 → size-1 → no-reacquire proves a leak) ──
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

    // ── binding clones with the resolveVerified idiom ──
    const innerBind = path.join(tmpRoot, "inner-bind");
    const outerBind = path.join(tmpRoot, "outer-bind");
    await simpleGit().clone(innerBare, innerBind);
    await simpleGit().clone(outerBare, outerBind);
    innerBindGit = simpleGit(innerBind);
    outerBindGit = simpleGit(outerBind);
    await innerBindGit.fetch("origin");
    await outerBindGit.fetch("origin");
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function bareMainSha(bare: string): Promise<string> {
    return (await simpleGit(bare).revparse([GIT_MAIN])).trim();
  }

  function innerLane(over?: Partial<RepoLane>): RepoLane {
    return {
      role: "inner",
      name: "rynx-inner",
      acquire: () => innerPool.acquire(),
      release: (wt) => innerPool.release(wt),
      gitOps: (p) => createGitOps(simpleGit(p)),
      gitlinkPath: GITLINK_PATH,
      resolveRefInClone: (ref) => resolveVerified(innerBindGit, ref),
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
      resolveRefInClone: (ref) => resolveVerified(outerBindGit, ref),
      ...over,
    };
  }

  function makeState(members: MergeRequestView[]): FakePm {
    return {
      group: { state: "forming", members },
      attempts: [],
      calls: [],
      requestRejects: [],
      attemptCompletions: [],
      comments: [],
    };
  }

  function depsFor(state: FakePm, over?: Partial<GroupIntegrationDeps>): GroupIntegrationDeps {
    return {
      pmClient: makeFakePm(state),
      logger,
      innerLane: innerLane(),
      outerLane: outerLane(),
      gitRemote: GIT_REMOTE,
      defaultVerifyCommand: "echo verify-ok",
      verifyTimeoutSec: 30,
      ...over,
    };
  }

  // Drain + reacquire proves the worktrees were released exactly once (or
  // never leased on a pre-pickup reject).
  function assertPoolsReacquirable(): void {
    const i = innerPool.acquire();
    const o = outerPool.acquire();
    expect(i).not.toBeNull();
    expect(o).not.toBeNull();
    if (i) innerPool.release(i);
    if (o) outerPool.release(o);
  }

  // ── (a) the binding — a lone outer real member is NO LONGER rejected ──
  // (was the obsolete "outer-only changes don't need a group" guard). Tier-3
  // (campaign umbrella-widening P4): a real member that binds to the OUTER repo
  // now flips roles — real → OUTER, synthetic → INNER (innerRef null) — and the
  // group lands the outer with inner as a no-op. Here the outer member carries
  // NO managed-gitlink change (feature/outer only touches app.txt), so the
  // classifier fails open to the legacy rebase; the point of THIS test is only
  // that the bind flips and reaches ready_to_land (no PRE-pickup reject). The
  // deep gitlink-classification cases (normalize / pure_bump / diverged /
  // unreachable) live in the dedicated outer-only fixture below.
  it("binding: a lone outer real member binds real→OUTER / synthetic→INNER and reaches ready_to_land (no longer rejected)", async () => {
    const state = makeState([
      makeMember({ id: "req-real", commitSha: outerFeatureSha }),
      makeSynthetic(),
    ]);
    const outcome = await runGroupIntegration(
      { id: "grp-synth-a1", members: state.group.members },
      depsFor(state),
    );
    expect(outcome.kind).toBe("ready_to_land");
    if (outcome.kind !== "ready_to_land") throw new Error("not ready_to_land");
    // Roles flipped: the real outer member is the OUTER; the synthetic is INNER.
    expect(outcome.outerMember.id).toBe("req-real");
    expect(outcome.innerMember.id).toBe("req-synth");
    // Inner is a no-op: Ri == live inner main (baseInnerSha), the inner never
    // rebased. The inner verify was short-circuited (no completeAttempt:failed).
    expect(outcome.Ri).toBe(outcome.assembled.baseInnerSha);
    expect(state.calls).toContain("markGroupIntegrating");
    expect(state.calls).not.toContain("rejectGroup");
    outcome.assembled.release();
    assertPoolsReacquirable();
  }, 30_000);

  it("binding guard: real member ref resolves in NEITHER repo → rejected", async () => {
    const state = makeState([
      makeMember({ id: "req-real", commitSha: "a".repeat(40) }),
      makeSynthetic(),
    ]);
    const outcome = await runGroupIntegration(
      { id: "grp-synth-a2", members: state.group.members },
      depsFor(state),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toMatch(/resolves in NEITHER repo/);
    }
    expect(state.calls).not.toContain("markGroupIntegrating");
    assertPoolsReacquirable();
  });

  it("binding guard: TWO synthetic members → rejected (expected at most one)", async () => {
    const state = makeState([makeSynthetic(), makeSynthetic({ id: "req-synth-2" })]);
    const outcome = await runGroupIntegration(
      { id: "grp-synth-a3", members: state.group.members },
      depsFor(state),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toMatch(/2 synthetic members; expected at most one/);
    }
    expect(state.calls).not.toContain("markGroupIntegrating");
    assertPoolsReacquirable();
  });

  it("binding guard: synthetic member unexpectedly carrying a commitSha → rejected (defense-in-depth)", async () => {
    const state = makeState([
      makeMember({ id: "req-real", commitSha: innerFeatureSha }),
      makeSynthetic({ commitSha: innerFeatureSha }),
    ]);
    const outcome = await runGroupIntegration(
      { id: "grp-synth-a4", members: state.group.members },
      depsFor(state),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toMatch(
        /synthetic member req-synth unexpectedly carries a branch\/commitSha/,
      );
    }
    expect(state.calls).not.toContain("markGroupIntegrating");
    assertPoolsReacquirable();
  });

  // ── (b) synthetic assembly → ready_to_land ──
  it("synthetic assembly: baseOuterSha == live outer main; Ro == exactly ONE gitlink commit on top; gitlink @ Ri; materialized; truthful attempt bases", async () => {
    const liveOuterMain = await bareMainSha(outerBare);
    const state = makeState([
      makeMember({
        id: "req-real",
        commitSha: innerFeatureSha,
        verifyCmd: "echo inner-ok",
      }),
      makeSynthetic(),
    ]);
    const outcome = await runGroupIntegration(
      { id: "grp-synth-b", members: state.group.members },
      depsFor(state),
    );
    expect(outcome.kind).toBe("ready_to_land");
    if (outcome.kind !== "ready_to_land") throw new Error("not ready_to_land");

    // Bound roles: real → inner, synthetic → outer.
    expect(outcome.innerMember.id).toBe("req-real");
    expect(outcome.outerMember.id).toBe("req-synth");

    const asm = outcome.assembled;
    // The synthesized outer candidate anchors to LIVE outer main (no pre-minted
    // branch, nothing to go stale).
    expect(asm.baseOuterSha).toBe(liveOuterMain);

    // Ro is exactly ONE commit (the gitlink bump) on top of live outer main.
    // The fixture guarantees a REAL gitlink change (Ri = a fresh inner feature
    // sha != the seeded gitlink), so the idempotence shortcut did NOT fire.
    const outerWtGit = simpleGit(asm.outerWt.path);
    const roParent = (await outerWtGit.revparse([`${outcome.Ro}^`])).trim();
    expect(roParent).toBe(asm.baseOuterSha);
    const bumpCount = parseInt(
      (await outerWtGit.raw(["rev-list", "--count", `${asm.baseOuterSha}..${outcome.Ro}`])).trim(),
      10,
    );
    expect(bumpCount).toBe(1);

    // The committed gitlink references Ri.
    expect(await asm.outerGitOps.readSubmoduleGitlink(GITLINK_PATH)).toBe(outcome.Ri);
    // The inner sources are materialized in the outer WORKING tree.
    expect(existsSync(path.join(asm.outerWt.path, "vendor", "rynx", "feature.txt"))).toBe(true);

    // The synthetic member's attempt base is the TRUTHFUL baseOuterSha.
    const outerAtt = state.attempts.find((a) => a.id === outcome.outerAttemptId)!;
    expect(outerAtt.requestId).toBe("req-synth");
    expect(outerAtt.baseSha).toBe(asm.baseOuterSha);

    // Worktrees held at the seam; release → pools reacquirable.
    expect(innerPool.acquire()).toBeNull();
    expect(outerPool.acquire()).toBeNull();
    outcome.assembled.release();
    assertPoolsReacquirable();
  }, 30_000);

  // ── (c) land: identical landGroup body keyed by requestId ──
  it("land: synthetic group lands; both bare mains advance; landGroupBody carries req-synth @ Ro role outer; passed-before-landGroup", async () => {
    const state = makeState([
      makeMember({
        id: "req-real",
        commitSha: innerFeatureSha,
        verifyCmd: "echo inner-ok",
        taskId: "task-inner",
      }),
      makeSynthetic(),
    ]);
    const deps = depsFor(state);
    const integ = await runGroupIntegration(
      { id: "grp-synth-c", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error("not ready");

    const result = await landAssembledGroup(
      {
        groupId: "grp-synth-c",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );

    expect(result.kind).toBe("landed");
    if (result.kind !== "landed") throw new Error("not landed");

    // Both bare mains advanced; outer main == Ro (the synthesized bump).
    expect(await bareMainSha(innerBare)).toBe(integ.Ri);
    expect(await bareMainSha(outerBare)).toBe(integ.Ro);

    // The IDENTICAL landGroup body, keyed by requestId: the synthetic outer
    // member's landedSha is Ro with role "outer"; the real member @ Ri "inner".
    expect(state.landGroupBody?.members).toEqual([
      { requestId: "req-real", landedSha: integ.Ri, role: "inner" },
      { requestId: "req-synth", landedSha: integ.Ro, role: "outer" },
    ]);

    // completeAttempt:passed (both) precede landGroup in the recorded calls.
    const landIdx = state.calls.indexOf("landGroup");
    const passedIndices = state.calls
      .map((c, i) => (c === "completeAttempt:passed" ? i : -1))
      .filter((i) => i >= 0);
    expect(passedIndices.length).toBe(2);
    for (const pi of passedIndices) expect(pi).toBeLessThan(landIdx);

    // No orphan / incident / reject on the clean path.
    expect(state.calls).not.toContain("openIncident");
    expect(state.calls).not.toContain("rejectGroup");
    expect(state.group.state).toBe("landed");

    assertPoolsReacquirable();
  }, 30_000);
});

// ─── (d) CONFLICT-IMMUNITY: the live game_one drift, unit level ─────────
//
// Own fixture: it mutates both bare mains (the simulated concurrent gitlink
// land) and then lands again. The failure class being killed: a worker-minted
// outer gitlink-bump branch (anchored to the OLD outer main) textually
// conflicts on the gitlink line the moment another gitlink change lands on
// outer main. The synthetic group has NO pre-minted outer branch — the bump is
// synthesized on whatever outer main is LIVE at assembly — so the same drift
// lands cleanly.
describe.skipIf(!GIT_AVAILABLE)("synthetic-outer conflict-immunity (own fixture)", () => {
  let tmpRoot: string;
  const logger = createLogger("error");

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-grpsynth-drift-"));
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("a concurrent gitlink land advances outer main → the synthetic group STILL lands (no conflict rejection)", async () => {
    const innerBare = path.join(tmpRoot, "inner.git");
    const outerBare = path.join(tmpRoot, "outer.git");
    const worktreeRoot = path.join(tmpRoot, "wtroot");
    await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
    await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);

    // Seed INNER + the ORIGINAL feature (the change our group carries).
    const innerSeed = path.join(tmpRoot, "inner-seed");
    await simpleGit().clone(innerBare, innerSeed);
    const ig = simpleGit(innerSeed);
    await configIdentity(ig);
    writeFileSync(path.join(innerSeed, "lib.txt"), "v1\n");
    await ig.add(["lib.txt"]);
    await ig.commit("inner main base");
    await ig.branch(["-M", "main"]);
    await ig.push(["-u", "origin", "main"]);
    const innerMainSha = (await ig.revparse(["HEAD"])).trim();

    await ig.checkoutLocalBranch("feature/inner");
    writeFileSync(path.join(innerSeed, "feature.txt"), "inner feature\n");
    await ig.add(["feature.txt"]);
    await ig.commit("inner feature commit");
    await ig.push(["-u", "origin", "feature/inner"]);
    const innerFeatureSha = (await ig.revparse(["HEAD"])).trim();

    // Seed OUTER with the gitlink @ inner main base.
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
    await og.raw([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${innerMainSha},${GITLINK_PATH}`,
    ]);
    await og.commit("outer main base with gitlink");
    await og.branch(["-M", "main"]);
    await og.push(["-u", "origin", "main"]);

    // ── SIMULATE ANOTHER GITLINK LAND (the drift that killed worker-minted
    //    bumps): a second inner change lands on inner main AND outer main's
    //    gitlink advances to it. ──
    await ig.checkout("main");
    writeFileSync(path.join(innerSeed, "other.txt"), "someone else's change\n");
    await ig.add(["other.txt"]);
    await ig.commit("concurrent inner change");
    await ig.push(["origin", "main"]);
    const innerSecondSha = (await ig.revparse(["HEAD"])).trim();

    await og.raw([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${innerSecondSha},${GITLINK_PATH}`,
    ]);
    await og.commit("concurrent gitlink land -> second inner sha");
    await og.push(["origin", "main"]);
    const advancedOuterMain = (await og.revparse(["HEAD"])).trim();

    // ── Pools + binding clones (built AFTER the drift; resetForAttempt would
    //    fetch the advance regardless). ──
    const innerPool = createWorktreePool({
      worktreeRoot,
      worktreeName: "inner",
      gitRepoUrl: innerBare,
      gitRemote: GIT_REMOTE,
      gitMainBranch: GIT_MAIN,
      parallelism: 1,
      cleanKeep: [],
    });
    const outerPool = createWorktreePool({
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

    const innerBind = path.join(tmpRoot, "inner-bind");
    const outerBind = path.join(tmpRoot, "outer-bind");
    await simpleGit().clone(innerBare, innerBind);
    await simpleGit().clone(outerBare, outerBind);
    const innerBindGit = simpleGit(innerBind);
    const outerBindGit = simpleGit(outerBind);
    await innerBindGit.fetch("origin");
    await outerBindGit.fetch("origin");

    const state: FakePm = {
      group: {
        state: "forming",
        members: [
          makeMember({
            id: "req-real",
            commitSha: innerFeatureSha, // the ORIGINAL pre-drift inner sha
            verifyCmd: "echo inner-ok",
          }),
          makeSynthetic(),
        ],
      },
      attempts: [],
      calls: [],
      requestRejects: [],
      attemptCompletions: [],
      comments: [],
    };
    const deps: GroupIntegrationDeps = {
      pmClient: makeFakePm(state),
      logger,
      innerLane: {
        role: "inner",
        name: "rynx-inner",
        acquire: () => innerPool.acquire(),
        release: (wt) => innerPool.release(wt),
        gitOps: (p) => createGitOps(simpleGit(p)),
        gitlinkPath: GITLINK_PATH,
        resolveRefInClone: (ref) => resolveVerified(innerBindGit, ref),
      },
      outerLane: {
        role: "outer",
        name: "app-outer",
        acquire: () => outerPool.acquire(),
        release: (wt) => outerPool.release(wt),
        gitOps: (p) => createGitOps(simpleGit(p)),
        resolveRefInClone: (ref) => resolveVerified(outerBindGit, ref),
      },
      gitRemote: GIT_REMOTE,
      defaultVerifyCommand: "echo verify-ok",
      verifyTimeoutSec: 30,
    };

    const integ = await runGroupIntegration(
      { id: "grp-synth-drift", members: state.group.members },
      deps,
    );

    // NOT a conflict rejection — the synthesized bump anchors to the ADVANCED
    // outer main, so there is nothing to conflict with.
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") {
      throw new Error(
        `expected ready_to_land, got ${integ.kind}${integ.kind === "rejected" ? `: ${integ.reason}` : ""}`,
      );
    }
    expect(integ.assembled.baseOuterSha).toBe(advancedOuterMain);

    const result = await landAssembledGroup(
      {
        groupId: "grp-synth-drift",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );

    expect(result.kind).toBe("landed");
    expect(state.calls).not.toContain("rejectGroup");
    expect(state.rejectPayload).toBeUndefined();

    // Outer main advanced PAST the drift to Ro; its gitlink references Ri
    // (which carries BOTH inner changes — the rebase folded the original
    // feature onto the concurrent inner change).
    expect((await simpleGit(outerBare).revparse([GIT_MAIN])).trim()).toBe(integ.Ro);
    expect((await simpleGit(innerBare).revparse([GIT_MAIN])).trim()).toBe(integ.Ri);
    const lsTree = await simpleGit(outerBare).raw(["ls-tree", GIT_MAIN, GITLINK_PATH]);
    expect(lsTree.trim()).toBe(`160000 commit ${integ.Ri}\t${GITLINK_PATH}`);
  }, 30_000);
});

// ─── (e) NO-OP land: content already on both mains ──────────────────────
//
// Own fixture: the inner "feature" is ALREADY inner main's tip and outer
// main's gitlink ALREADY references it (a duplicate / out-of-band-landed
// re-submission). The synthetic group must land as a clean NO-OP: the
// idempotent gitlink op returns the current HEAD (NO empty bump commit ever
// exists), the up-to-date FF pushes succeed, and both mains are byte-unchanged.
describe.skipIf(!GIT_AVAILABLE)("synthetic-outer no-op land (own fixture)", () => {
  let tmpRoot: string;
  const logger = createLogger("error");

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-int-grpsynth-noop-"));
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("inner change already on both mains → Ri == baseInnerSha, Ro == baseOuterSha, land is a clean no-op (outer main byte-unchanged)", async () => {
    const innerBare = path.join(tmpRoot, "inner.git");
    const outerBare = path.join(tmpRoot, "outer.git");
    const worktreeRoot = path.join(tmpRoot, "wtroot");
    await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
    await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);

    // Seed INNER: the "feature" is committed DIRECTLY on main (already landed).
    const innerSeed = path.join(tmpRoot, "inner-seed");
    await simpleGit().clone(innerBare, innerSeed);
    const ig = simpleGit(innerSeed);
    await configIdentity(ig);
    writeFileSync(path.join(innerSeed, "lib.txt"), "v1\n");
    await ig.add(["lib.txt"]);
    await ig.commit("inner main base");
    writeFileSync(path.join(innerSeed, "feature.txt"), "inner feature\n");
    await ig.add(["feature.txt"]);
    await ig.commit("inner feature commit (already on main)");
    await ig.branch(["-M", "main"]);
    await ig.push(["-u", "origin", "main"]);
    const innerFeatureSha = (await ig.revparse(["HEAD"])).trim();

    // Seed OUTER: the gitlink ALREADY references the feature sha.
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
    await og.raw([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${innerFeatureSha},${GITLINK_PATH}`,
    ]);
    await og.commit("outer main with gitlink ALREADY at the feature sha");
    await og.branch(["-M", "main"]);
    await og.push(["-u", "origin", "main"]);

    const innerPool = createWorktreePool({
      worktreeRoot,
      worktreeName: "inner",
      gitRepoUrl: innerBare,
      gitRemote: GIT_REMOTE,
      gitMainBranch: GIT_MAIN,
      parallelism: 1,
      cleanKeep: [],
    });
    const outerPool = createWorktreePool({
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

    const innerBind = path.join(tmpRoot, "inner-bind");
    const outerBind = path.join(tmpRoot, "outer-bind");
    await simpleGit().clone(innerBare, innerBind);
    await simpleGit().clone(outerBare, outerBind);
    const innerBindGit = simpleGit(innerBind);
    const outerBindGit = simpleGit(outerBind);
    await innerBindGit.fetch("origin");
    await outerBindGit.fetch("origin");

    const outerBareGit = simpleGit(outerBare);
    const outerMainBefore = (await outerBareGit.revparse([GIT_MAIN])).trim();
    const outerCountBefore = parseInt(
      (await outerBareGit.raw(["rev-list", "--count", GIT_MAIN])).trim(),
      10,
    );
    const innerMainBefore = (await simpleGit(innerBare).revparse([GIT_MAIN])).trim();
    expect(innerMainBefore).toBe(innerFeatureSha);

    const state: FakePm = {
      group: {
        state: "forming",
        members: [
          makeMember({
            id: "req-real",
            commitSha: innerFeatureSha,
            verifyCmd: "echo inner-ok",
          }),
          makeSynthetic(),
        ],
      },
      attempts: [],
      calls: [],
      requestRejects: [],
      attemptCompletions: [],
      comments: [],
    };
    const deps: GroupIntegrationDeps = {
      pmClient: makeFakePm(state),
      logger,
      innerLane: {
        role: "inner",
        name: "rynx-inner",
        acquire: () => innerPool.acquire(),
        release: (wt) => innerPool.release(wt),
        gitOps: (p) => createGitOps(simpleGit(p)),
        gitlinkPath: GITLINK_PATH,
        resolveRefInClone: (ref) => resolveVerified(innerBindGit, ref),
      },
      outerLane: {
        role: "outer",
        name: "app-outer",
        acquire: () => outerPool.acquire(),
        release: (wt) => outerPool.release(wt),
        gitOps: (p) => createGitOps(simpleGit(p)),
        resolveRefInClone: (ref) => resolveVerified(outerBindGit, ref),
      },
      gitRemote: GIT_REMOTE,
      defaultVerifyCommand: "echo verify-ok",
      verifyTimeoutSec: 30,
    };

    const integ = await runGroupIntegration(
      { id: "grp-synth-noop", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") {
      throw new Error(
        `expected ready_to_land, got ${integ.kind}${integ.kind === "rejected" ? `: ${integ.reason}` : ""}`,
      );
    }

    // The rebase is a no-op (the feature IS inner main) and the gitlink op is
    // the EXPLICIT idempotent path (gitlink already @ Ri → current HEAD back,
    // no empty bump commit ever exists).
    expect(integ.Ri).toBe(integ.assembled.baseInnerSha);
    expect(integ.Ri).toBe(innerFeatureSha);
    expect(integ.Ro).toBe(integ.assembled.baseOuterSha);
    expect(integ.Ro).toBe(outerMainBefore);

    const result = await landAssembledGroup(
      {
        groupId: "grp-synth-noop",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );

    // A clean LANDED outcome (the up-to-date FF pushes are safe no-ops)…
    expect(result.kind).toBe("landed");
    // …and the outer bare main is BYTE-UNCHANGED: same sha, same commit count
    // (no empty bump commit was ever created, let alone pushed).
    expect((await outerBareGit.revparse([GIT_MAIN])).trim()).toBe(outerMainBefore);
    const outerCountAfter = parseInt(
      (await outerBareGit.raw(["rev-list", "--count", GIT_MAIN])).trim(),
      10,
    );
    expect(outerCountAfter).toBe(outerCountBefore);
    expect((await simpleGit(innerBare).revparse([GIT_MAIN])).trim()).toBe(innerMainBefore);

    // landGroup carries the EXISTING main shas, keyed by requestId.
    expect(state.landGroupBody?.members).toEqual([
      { requestId: "req-real", landedSha: innerFeatureSha, role: "inner" },
      { requestId: "req-synth", landedSha: outerMainBefore, role: "outer" },
    ]);
    expect(state.group.state).toBe("landed");
    expect(state.calls).not.toContain("rejectGroup");
  }, 30_000);
});

// ─── (f) OUTER-ONLY (synthetic-inner) groups — Tier-3, campaign umbrella P4 ──
//
// The MIRROR of the inner-only synthetic-outer form: a lone REAL outer member
// binds real→OUTER / synthetic→INNER (innerRef null) and lands the outer with
// inner as a NO-OP (Ri = live inner main; inner never advances). The gitlink is
// ancestry-gated by classifyOuterGitlinkDiff:
//   - ancestor + source          → normalize (strip gitlink hunk, apply source) → LANDS
//   - ancestor, gitlink-only      → pure_bump (convert)                          → LANDS
//   - present-but-not-ancestor    → gitlink_diverged   (Tier-2 legible reject)
//   - absent after all-refs fetch → gitlink_unreachable (Tier-2 legible reject)
// Each scenario runs against its OWN fresh two-repo world (a landing test
// advances outer main, so isolation keeps the ancestry/no-op assertions crisp).
describe.skipIf(!GIT_AVAILABLE)("outer-only (synthetic-inner) groups (own fixtures)", () => {
  const tmpRoots: string[] = [];
  const logger = createLogger("error");

  afterAll(() => {
    for (const r of tmpRoots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  interface OuterOnlyWorld {
    innerBare: string;
    outerBare: string;
    innerBaseA: string;
    innerMainB: string;
    innerDivergedD: string;
    innerUnreachableU: string;
    featureNormalize: string;
    featurePurebump: string;
    featureDiverged: string;
    featureUnreachable: string;
    innerPool: WorktreePool;
    outerPool: WorktreePool;
    innerBindGit: SimpleGit;
    outerBindGit: SimpleGit;
  }

  /** Build a fresh isolated two-repo world for one outer-only scenario. */
  async function buildWorld(tag: string): Promise<OuterOnlyWorld> {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), `pm-int-outeronly-${tag}-`));
    tmpRoots.push(tmpRoot);
    const innerBare = path.join(tmpRoot, "inner.git");
    const outerBare = path.join(tmpRoot, "outer.git");
    const worktreeRoot = path.join(tmpRoot, "wtroot");
    await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
    await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);

    // ── seed INNER: main A → B (A ancestor of B = Ri), a DIVERGED side commit
    //    D (present but not on main), and an UNPUSHED U (never on the remote). ──
    const innerSeed = path.join(tmpRoot, "inner-seed");
    await simpleGit().clone(innerBare, innerSeed);
    const ig = simpleGit(innerSeed);
    await configIdentity(ig);
    writeFileSync(path.join(innerSeed, "lib.txt"), "v1\n");
    await ig.add(["lib.txt"]);
    await ig.commit("inner main base (A)");
    await ig.branch(["-M", "main"]);
    await ig.push(["-u", "origin", "main"]);
    const innerBaseA = (await ig.revparse(["HEAD"])).trim();

    writeFileSync(path.join(innerSeed, "lib.txt"), "v2\n");
    await ig.add(["lib.txt"]);
    await ig.commit("inner main advance (B)");
    await ig.push(["origin", "main"]);
    const innerMainB = (await ig.revparse(["HEAD"])).trim();

    // DIVERGED D: branch off A, a commit NOT reachable from main (present after
    // an all-refs fetch, but not an ancestor of B).
    await ig.checkout(innerBaseA);
    await ig.checkoutLocalBranch("diverged");
    writeFileSync(path.join(innerSeed, "side.txt"), "divergent\n");
    await ig.add(["side.txt"]);
    await ig.commit("inner diverged commit (D)");
    await ig.push(["-u", "origin", "diverged"]);
    const innerDivergedD = (await ig.revparse(["HEAD"])).trim();

    // UNREACHABLE U: a real commit whose object is created locally and NEVER
    // pushed — absent from the bare remote even after an all-refs fetch.
    await ig.checkout(innerBaseA);
    await ig.checkoutLocalBranch("unpushed");
    writeFileSync(path.join(innerSeed, "ghost.txt"), "never pushed\n");
    await ig.add(["ghost.txt"]);
    await ig.commit("inner unreachable commit (U)");
    const innerUnreachableU = (await ig.revparse(["HEAD"])).trim();
    await ig.checkout("main"); // leave the seed on main; U stays unpushed

    // ── seed OUTER: main gitlink @ A, plus one feature branch per scenario. ──
    const outerSeed = path.join(tmpRoot, "outer-seed");
    await simpleGit().clone(outerBare, outerSeed);
    const og = simpleGit(outerSeed);
    await configIdentity(og);
    const innerUrlForGitmodules = innerBare.replace(/\\/g, "/");
    writeFileSync(path.join(outerSeed, "top.txt"), "top v1\n");
    writeFileSync(
      path.join(outerSeed, ".gitmodules"),
      `[submodule "rynx"]\n\tpath = ${GITLINK_PATH}\n\turl = ${innerUrlForGitmodules}\n`,
    );
    await og.add(["top.txt", ".gitmodules"]);
    await og.raw(["update-index", "--add", "--cacheinfo", `160000,${innerBaseA},${GITLINK_PATH}`]);
    await og.commit("outer main base with gitlink @ A");
    await og.branch(["-M", "main"]);
    await og.push(["-u", "origin", "main"]);

    // A feature branch that bumps the managed gitlink to `target` and, when
    // `withSource`, also carries a real source file (→ normalize vs pure_bump).
    const mkFeature = async (
      name: string,
      target: string,
      withSource: boolean,
    ): Promise<string> => {
      await og.checkout("main");
      await og.checkoutLocalBranch(name);
      if (withSource) {
        writeFileSync(path.join(outerSeed, "app.txt"), `outer source for ${name}\n`);
        await og.add(["app.txt"]);
      }
      await og.raw(["update-index", "--cacheinfo", `160000,${target},${GITLINK_PATH}`]);
      await og.commit(
        `outer ${name}: gitlink -> ${target.slice(0, 8)}${withSource ? " + source" : ""}`,
      );
      await og.push(["-u", "origin", name]);
      const sha = (await og.revparse(["HEAD"])).trim();
      return sha;
    };

    const featureNormalize = await mkFeature("feature/normalize", innerMainB, true);
    const featurePurebump = await mkFeature("feature/purebump", innerMainB, false);
    const featureDiverged = await mkFeature("feature/diverged", innerDivergedD, false);
    const featureUnreachable = await mkFeature("feature/unreachable", innerUnreachableU, false);
    await og.checkout("main");

    // ── pools (size-1) + binding clones (all feature branches fetched). ──
    const innerPool = createWorktreePool({
      worktreeRoot,
      worktreeName: "inner",
      gitRepoUrl: innerBare,
      gitRemote: GIT_REMOTE,
      gitMainBranch: GIT_MAIN,
      parallelism: 1,
      cleanKeep: [],
    });
    const outerPool = createWorktreePool({
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

    const innerBind = path.join(tmpRoot, "inner-bind");
    const outerBind = path.join(tmpRoot, "outer-bind");
    await simpleGit().clone(innerBare, innerBind);
    await simpleGit().clone(outerBare, outerBind);
    const innerBindGit = simpleGit(innerBind);
    const outerBindGit = simpleGit(outerBind);
    await innerBindGit.fetch("origin");
    await outerBindGit.fetch("origin");

    return {
      innerBare,
      outerBare,
      innerBaseA,
      innerMainB,
      innerDivergedD,
      innerUnreachableU,
      featureNormalize,
      featurePurebump,
      featureDiverged,
      featureUnreachable,
      innerPool,
      outerPool,
      innerBindGit,
      outerBindGit,
    };
  }

  function worldDeps(w: OuterOnlyWorld, state: FakePm): GroupIntegrationDeps {
    return {
      pmClient: makeFakePm(state),
      logger,
      innerLane: {
        role: "inner",
        name: "rynx-inner",
        acquire: () => w.innerPool.acquire(),
        release: (wt) => w.innerPool.release(wt),
        gitOps: (p) => createGitOps(simpleGit(p)),
        gitlinkPath: GITLINK_PATH,
        resolveRefInClone: (ref) => resolveVerified(w.innerBindGit, ref),
      },
      outerLane: {
        role: "outer",
        name: "app-outer",
        acquire: () => w.outerPool.acquire(),
        release: (wt) => w.outerPool.release(wt),
        gitOps: (p) => createGitOps(simpleGit(p)),
        resolveRefInClone: (ref) => resolveVerified(w.outerBindGit, ref),
      },
      gitRemote: GIT_REMOTE,
      defaultVerifyCommand: "echo verify-ok",
      verifyTimeoutSec: 30,
    };
  }

  function outerOnlyState(outerCommitSha: string): FakePm {
    return {
      group: {
        state: "forming",
        members: [
          makeMember({ id: "req-outer", commitSha: outerCommitSha, taskId: "task-outer" }),
          makeSynthetic({ id: "req-synth-inner" }),
        ],
      },
      attempts: [],
      calls: [],
      requestRejects: [],
      attemptCompletions: [],
      comments: [],
    };
  }

  async function bareSha(bare: string, ref: string): Promise<string> {
    return (await simpleGit(bare).revparse([ref])).trim();
  }

  // ── ANCESTOR + source → normalize → LANDS ──
  it("ancestor gitlink + source → normalize, LANDS: inner main unchanged, outer gitlink -> Ri, noteOuterGitlinkNormalized on the real outer", async () => {
    const w = await buildWorld("norm");
    const state = outerOnlyState(w.featureNormalize);
    const deps = worldDeps(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-outeronly-norm", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error(`not ready: ${JSON.stringify(integ)}`);

    // Roles flipped: real → OUTER, synthetic → INNER.
    expect(integ.outerMember.id).toBe("req-outer");
    expect(integ.innerMember.id).toBe("req-synth-inner");

    const asm = integ.assembled;
    // Normalization arm fired (gitlink stripped + source applied), NOT convert.
    expect(asm.outerGitlinkNormalized).toBe(true);
    expect(asm.outerConverted).toBe(false);
    // Inner is a NO-OP: Ri == live inner main == B, no inner rebase.
    expect(integ.Ri).toBe(asm.baseInnerSha);
    expect(integ.Ri).toBe(w.innerMainB);
    // The committed gitlink references Ri (the landing inner main).
    expect(await asm.outerGitOps.readSubmoduleGitlink(GITLINK_PATH)).toBe(integ.Ri);
    // Surfacing: noteOuterGitlinkNormalized on the REAL outer member.
    expect(state.calls).toContain("noteOuterGitlinkNormalized");
    expect(state.outerGitlinkNormalized?.requestId).toBe("req-outer");

    const result = await landAssembledGroup(
      {
        groupId: "grp-outeronly-norm",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );
    expect(result.kind).toBe("landed");

    // Inner bare main is BYTE-UNCHANGED (the no-op inner never advanced).
    expect(await bareSha(w.innerBare, GIT_MAIN)).toBe(w.innerMainB);
    // Outer advanced to Ro; its gitlink references Ri and the source landed.
    expect(await bareSha(w.outerBare, GIT_MAIN)).toBe(integ.Ro);
    const lsTree = await simpleGit(w.outerBare).raw(["ls-tree", GIT_MAIN, GITLINK_PATH]);
    expect(lsTree.trim()).toBe(`160000 commit ${integ.Ri}\t${GITLINK_PATH}`);
    const appBlob = await simpleGit(w.outerBare).raw(["ls-tree", GIT_MAIN, "app.txt"]);
    expect(appBlob.trim()).not.toBe("");

    // landGroup body keyed by requestId, [inner, outer]: synthetic inner @ Ri,
    // real outer @ Ro.
    expect(state.landGroupBody?.members).toEqual([
      { requestId: "req-synth-inner", landedSha: integ.Ri, role: "inner" },
      { requestId: "req-outer", landedSha: integ.Ro, role: "outer" },
    ]);
    expect(state.calls).not.toContain("rejectGroup");
  }, 45_000);

  // ── ANCESTOR, gitlink-only → pure_bump (convert) → LANDS no-op inner ──
  it("pure gitlink bump to inner main → convert, LANDS: inner main unchanged (no-op inner), outer advances, noteOuterConverted on the real outer", async () => {
    const w = await buildWorld("bump");
    const innerCountBefore = parseInt(
      (await simpleGit(w.innerBare).raw(["rev-list", "--count", GIT_MAIN])).trim(),
      10,
    );
    const state = outerOnlyState(w.featurePurebump);
    const deps = worldDeps(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-outeronly-bump", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error(`not ready: ${JSON.stringify(integ)}`);

    const asm = integ.assembled;
    // Pure-bump arm fired (convert), NOT normalize.
    expect(asm.outerConverted).toBe(true);
    expect(asm.outerGitlinkNormalized).toBe(false);
    // No-op inner: Ri == live inner main == B.
    expect(integ.Ri).toBe(asm.baseInnerSha);
    expect(integ.Ri).toBe(w.innerMainB);
    expect(await asm.outerGitOps.readSubmoduleGitlink(GITLINK_PATH)).toBe(integ.Ri);
    expect(state.calls).toContain("noteOuterConverted");
    expect(state.outerConverted?.requestId).toBe("req-outer");

    const result = await landAssembledGroup(
      {
        groupId: "grp-outeronly-bump",
        projectId: "proj-1",
        ready: integ,
        innerRepoName: "rynx-inner",
        outerRepoName: "app-outer",
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );
    expect(result.kind).toBe("landed");

    // Inner bare main BYTE-UNCHANGED: same sha AND same commit count.
    expect(await bareSha(w.innerBare, GIT_MAIN)).toBe(w.innerMainB);
    const innerCountAfter = parseInt(
      (await simpleGit(w.innerBare).raw(["rev-list", "--count", GIT_MAIN])).trim(),
      10,
    );
    expect(innerCountAfter).toBe(innerCountBefore);
    // Outer advanced; gitlink -> Ri (inner main).
    expect(await bareSha(w.outerBare, GIT_MAIN)).toBe(integ.Ro);
    const lsTree = await simpleGit(w.outerBare).raw(["ls-tree", GIT_MAIN, GITLINK_PATH]);
    expect(lsTree.trim()).toBe(`160000 commit ${integ.Ri}\t${GITLINK_PATH}`);
  }, 45_000);

  // ── present-but-NOT-ancestor → gitlink_diverged (Tier-2 legible reject) ──
  it("diverged gitlink (present, not an ancestor of inner main) → gitlink_diverged reject + category + merge_rejection comment on the real outer task", async () => {
    const w = await buildWorld("div");
    const state = outerOnlyState(w.featureDiverged);
    const deps = worldDeps(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-outeronly-div", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("rejected");
    if (integ.kind === "rejected") {
      expect(integ.reason).toMatch(/gitlink_diverged/);
    }
    // Category surfaced correctly (not collapsed to "other").
    expect(state.rejectPayload?.category).toBe("gitlink_diverged");
    // PRE-pickup: never picked up (assembly failed before markGroupIntegrating).
    expect(state.calls).not.toContain("markGroupIntegrating");
    expect(state.calls).toContain("rejectGroup");
    // Legibility: the merge_rejection comment targets the REAL OUTER member's
    // task (the synthetic inner has a null taskId and is skipped).
    const outerComment = state.comments.find((c) => c.taskId === "task-outer");
    expect(outerComment).toBeDefined();
    expect(outerComment?.commentType).toBe("merge_rejection");
    expect(outerComment?.category).toBe("gitlink_diverged");
    // Inner main never touched; pools released (assembly leased then freed).
    expect(await bareSha(w.innerBare, GIT_MAIN)).toBe(w.innerMainB);
    const i = w.innerPool.acquire();
    const o = w.outerPool.acquire();
    expect(i).not.toBeNull();
    expect(o).not.toBeNull();
    if (i) w.innerPool.release(i);
    if (o) w.outerPool.release(o);
  }, 45_000);

  // ── absent after all-refs fetch → gitlink_unreachable (Tier-2 reject) ──
  it("unreachable gitlink (absent after an all-refs fetch) → gitlink_unreachable reject + category + merge_rejection comment on the real outer task", async () => {
    const w = await buildWorld("unr");
    const state = outerOnlyState(w.featureUnreachable);
    const deps = worldDeps(w, state);
    const integ = await runGroupIntegration(
      { id: "grp-outeronly-unr", members: state.group.members },
      deps,
    );
    expect(integ.kind).toBe("rejected");
    if (integ.kind === "rejected") {
      expect(integ.reason).toMatch(/gitlink_unreachable/);
    }
    expect(state.rejectPayload?.category).toBe("gitlink_unreachable");
    expect(state.calls).not.toContain("markGroupIntegrating");
    const outerComment = state.comments.find((c) => c.taskId === "task-outer");
    expect(outerComment).toBeDefined();
    expect(outerComment?.commentType).toBe("merge_rejection");
    expect(outerComment?.category).toBe("gitlink_unreachable");
    expect(await bareSha(w.innerBare, GIT_MAIN)).toBe(w.innerMainB);
  }, 45_000);
});
