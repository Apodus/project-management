/**
 * Campaign 2026-08-30 §S5 — the incident a group CURES closes when that group
 * lands, not at whatever later assembly happens to look.
 *
 * The §S2 gate opens a `dangling_gitlink` incident on the `heals` verdict too:
 * main is broken at the moment of measurement, and a repair that left no record
 * is how `pm_list_merge_incidents` came to say "No merge incidents" about a lane
 * that had one. But nothing closed that row except a LATER group's `holds`
 * verdict — so on a lane with no further cross-repo traffic it stays open
 * forever, telling every reader that a healthy lane needs a human (the type's
 * `curedBy` is "human"). These tests are the ones that say the land closes it.
 *
 * Driven through `runGroupLaneOnce` rather than `landAssembledGroup`, because
 * the properties under test are properties of the SCHEDULER's pass: that the
 * close happens only on `landed`, and that no failure inside it can turn a
 * successful atomic land into `{ kind: "error" }`.
 *
 * Real two-repo fixtures (the group-main-gitlink-gate.test.ts idiom): bare
 * repos + seed clones, a seeded 160000 gitlink, size-1 worktree pools, binding
 * clones, and a FakePm with an incident STORE so open/list/resolve is a state
 * machine rather than three unrelated spies.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { simpleGit, type SimpleGit } from "simple-git";
import type { MergeAttemptView, MergeRequestView } from "@pm/shared";
import { createGitOps, type GitOps } from "../src/git-ops.js";
import { createWorktreePool, type WorktreePool } from "../src/worktree-pool.js";
import type { Logger } from "../src/logger.js";
import { runGroupLaneOnce, type RunBatchLoopDeps } from "../src/batch.js";
import type { PmClient } from "../src/pm-client.js";

function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

const GITLINK_PATH = "vendor/rynx";
const GIT_REMOTE = "origin";
const GIT_MAIN = "main";
const PROJECT_ID = "proj-1";
const RESOURCE = "main";
const INNER_REPO = "rynx-inner";
const OUTER_REPO = "app-outer";
const GROUP_ID = "grp-s5";

async function configIdentity(g: SimpleGit): Promise<void> {
  await g.addConfig("user.email", "int@test.local");
  await g.addConfig("user.name", "Integrator Test");
  await g.addConfig("commit.gpgsign", "false");
}

async function resolveVerified(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    return (await git.revparse(["--verify", `${ref}^{commit}`])).trim();
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Capturing logger (a real pino over an in-memory destination) ─────

interface LogRecord {
  level: string;
  msg: string;
  [k: string]: unknown;
}

function capturingLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger = pino(
    { level: "debug", formatters: { level: (label) => ({ level: label }) } },
    {
      write(line: string): void {
        records.push(JSON.parse(line) as LogRecord);
      },
    },
  );
  return { logger, records };
}

const find = (records: LogRecord[], re: RegExp): LogRecord[] =>
  records.filter((r) => re.test(r.msg ?? ""));

// ─── In-memory fake PM (batch-lane surface + an incident store) ───────

interface FakeIncident {
  id: string;
  type: string;
  innerRepo: string;
  outerRepo: string;
  orphanedSha: string;
  state: "open" | "auto_resolved";
}

interface FakePm {
  members: MergeRequestView[];
  attempts: MergeAttemptView[];
  calls: string[];
  incidents: FakeIncident[];
  listFilters: { state?: string; type?: string }[];
  resolveCalls: { id: string; mode: string; note?: string; resolvedByGroupId?: string }[];
  releases: { landedSha?: string; reason?: string }[];
  lockHeld: boolean;
  /** Fault injection for the non-fatal contract. */
  failListDangling?: boolean;
  failResolveIds?: string[];
}

function newState(members: MergeRequestView[], over: Partial<FakePm> = {}): FakePm {
  return {
    members,
    attempts: [],
    calls: [],
    incidents: [],
    listFilters: [],
    resolveCalls: [],
    releases: [],
    lockHeld: false,
    ...over,
  };
}

function makeFakePm(state: FakePm): PmClient {
  let seq = 0;
  let incidentSeq = 0;
  const fake = {
    // ── lane lock ──
    async acquireLock(): Promise<{ ok: boolean; status: string }> {
      state.calls.push("acquireLock");
      state.lockHeld = true;
      return { ok: true, status: "held" };
    },
    async heartbeatLock(): Promise<{ ok: boolean; status: string }> {
      return { ok: true, status: "refreshed" };
    },
    async releaseLock(
      _projectId: string,
      _resource: string,
      body?: { landedSha?: string; reason?: string },
    ): Promise<{ ok: boolean; status: string }> {
      state.calls.push("releaseLock");
      state.releases.push(body ?? {});
      state.lockHeld = false;
      return { ok: true, status: "released" };
    },
    async getTrainState(
      _projectId: string,
      resource: string,
    ): Promise<{ state: string; resource: string }> {
      return { state: "running", resource };
    },
    // ── group lifecycle ──
    async listMergeGroups(): Promise<unknown[]> {
      state.calls.push("listMergeGroups");
      return [{ id: GROUP_ID }];
    },
    async getMergeGroup(): Promise<unknown> {
      state.calls.push("getMergeGroup");
      return { id: GROUP_ID, members: state.members };
    },
    async markGroupIntegrating(): Promise<unknown> {
      state.calls.push("markGroupIntegrating");
      for (const m of state.members) m.status = "integrating";
      return { id: GROUP_ID, members: state.members };
    },
    async rejectGroup(_id: string, payload: { reason: string }): Promise<unknown> {
      state.calls.push("rejectGroup");
      state.calls.push(`rejectGroupReason:${payload.reason}`);
      return {};
    },
    async resetGroup(): Promise<unknown> {
      state.calls.push("resetGroup");
      return {};
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
      state.calls.push("startAttempt");
      return att;
    },
    async completeAttempt(attemptId: string, body: { status: string }): Promise<MergeAttemptView> {
      const att = state.attempts.find((a) => a.id === attemptId);
      if (!att) throw new Error(`no attempt ${attemptId}`);
      att.status = body.status as MergeAttemptView["status"];
      att.completedAt = nowIso();
      state.calls.push(`completeAttempt:${body.status}`);
      return att;
    },
    async landGroup(
      _groupId: string,
      body: { members: { requestId: string; landedSha: string }[] },
    ): Promise<unknown> {
      state.calls.push("landGroup");
      for (const m of state.members) {
        const land = body.members.find((b) => b.requestId === m.id);
        if (land) {
          m.status = "landed";
          m.landedSha = land.landedSha;
        }
      }
      return {};
    },
    async markInnerOrphaned(): Promise<unknown> {
      state.calls.push("markInnerOrphaned");
      return {};
    },
    async markPartiallyLanded(): Promise<unknown> {
      state.calls.push("markPartiallyLanded");
      return {};
    },
    async rejectMergeRequest(): Promise<unknown> {
      state.calls.push("rejectMergeRequest");
      return {};
    },
    async postTaskComment(): Promise<unknown> {
      state.calls.push("postTaskComment");
      return {};
    },
    async noteOuterConverted(): Promise<void> {
      state.calls.push("noteOuterConverted");
    },
    async noteOuterGitlinkNormalized(): Promise<void> {
      state.calls.push("noteOuterGitlinkNormalized");
    },
    // ── incidents ──
    async openIncident(params: {
      type: string;
      innerRepo: string;
      outerRepo: string;
      orphanedSha: string;
    }): Promise<{ incident: { id: string }; created: boolean }> {
      state.calls.push("openIncident");
      const existing = state.incidents.find(
        (i) =>
          i.state === "open" &&
          i.type === params.type &&
          i.innerRepo === params.innerRepo &&
          i.outerRepo === params.outerRepo &&
          i.orphanedSha === params.orphanedSha,
      );
      if (existing) return { incident: { id: existing.id }, created: false };
      incidentSeq += 1;
      const row: FakeIncident = {
        id: `inc-${incidentSeq}`,
        type: params.type,
        innerRepo: params.innerRepo,
        outerRepo: params.outerRepo,
        orphanedSha: params.orphanedSha,
        state: "open",
      };
      state.incidents.push(row);
      return { incident: { id: row.id }, created: true };
    },
    async listMergeIncidents(
      _projectId: string,
      filters?: { state?: string; type?: string },
    ): Promise<unknown[]> {
      state.calls.push("listMergeIncidents");
      state.listFilters.push({ state: filters?.state, type: filters?.type });
      if (state.failListDangling && filters?.type === "dangling_gitlink") {
        throw new Error("PM is down");
      }
      return state.incidents.filter(
        (i) =>
          (!filters?.state || i.state === filters.state) &&
          (!filters?.type || i.type === filters.type),
      );
    },
    async resolveIncident(
      incidentId: string,
      body: { mode: string; note?: string; resolvedByGroupId?: string },
    ): Promise<unknown> {
      state.calls.push("resolveIncident");
      state.resolveCalls.push({ id: incidentId, ...body });
      if (state.failResolveIds?.includes(incidentId)) throw new Error("PM rejected the resolve");
      const row = state.incidents.find((i) => i.id === incidentId);
      if (row) row.state = "auto_resolved";
      return row;
    },
  };
  return fake as unknown as PmClient;
}

function makeMember(over: Partial<MergeRequestView>): MergeRequestView {
  return {
    id: "req-1",
    projectId: PROJECT_ID,
    resource: RESOURCE,
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

// ─── Lane fixture: outer main's gitlink points AHEAD of inner main ────

interface Lane {
  innerBare: string;
  outerBare: string;
  innerPool: WorktreePool;
  outerPool: WorktreePool;
  innerBindGit: SimpleGit;
  outerBindGit: SimpleGit;
  /** The dangling target: an inner commit ahead of inner main, which the
   *  group's own member lands. The gate's `heals` verdict. */
  ahead: string;
}

/**
 * The lane shape S5 is about: outer main names an inner commit that is NOT on
 * inner main (so the gate opens an incident) but IS what this group's member
 * lands (so the very same pass repairs it).
 */
async function buildHealingLane(root: string, label: string): Promise<Lane> {
  const dir = path.join(root, label);
  const innerBare = path.join(dir, "inner.git");
  const outerBare = path.join(dir, "outer.git");
  await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
  await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);

  const innerSeedDir = path.join(dir, "inner-seed");
  await simpleGit().clone(innerBare, innerSeedDir);
  const ig = simpleGit(innerSeedDir);
  await configIdentity(ig);
  writeFileSync(path.join(innerSeedDir, "lib.txt"), "v1\n");
  await ig.add(["lib.txt"]);
  await ig.commit("inner main base");
  await ig.branch(["-M", GIT_MAIN]);
  await ig.push(["-u", GIT_REMOTE, GIT_MAIN]);
  await ig.checkout(["-b", "ahead"]);
  writeFileSync(path.join(innerSeedDir, "engine.txt"), "new engine\n");
  await ig.add(["engine.txt"]);
  await ig.commit("the commit outer main names, ahead of inner main");
  const ahead = (await ig.revparse(["HEAD"])).trim();
  await ig.push(["-u", GIT_REMOTE, "ahead"]);
  await ig.checkout(GIT_MAIN);

  const outerSeedDir = path.join(dir, "outer-seed");
  await simpleGit().clone(outerBare, outerSeedDir);
  const og = simpleGit(outerSeedDir);
  await configIdentity(og);
  writeFileSync(path.join(outerSeedDir, "top.txt"), "top v1\n");
  writeFileSync(
    path.join(outerSeedDir, ".gitmodules"),
    `[submodule "rynx"]\n\tpath = ${GITLINK_PATH}\n\turl = ${innerBare.replace(/\\/g, "/")}\n`,
  );
  await og.add(["top.txt", ".gitmodules"]);
  await og.raw(["update-index", "--add", "--cacheinfo", `160000,${ahead},${GITLINK_PATH}`]);
  await og.commit("outer main base with a gitlink ahead of inner main");
  await og.branch(["-M", GIT_MAIN]);
  await og.push(["-u", GIT_REMOTE, GIT_MAIN]);

  const worktreeRoot = path.join(dir, "wtroot");
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

  const innerBind = path.join(dir, "inner-bind");
  const outerBind = path.join(dir, "outer-bind");
  await simpleGit().clone(innerBare, innerBind);
  await simpleGit().clone(outerBare, outerBind);
  const innerBindGit = simpleGit(innerBind);
  const outerBindGit = simpleGit(outerBind);
  await innerBindGit.fetch(GIT_REMOTE);
  await outerBindGit.fetch(GIT_REMOTE);

  return { innerBare, outerBare, innerPool, outerPool, innerBindGit, outerBindGit, ahead };
}

function depsFor(
  lane: Lane,
  state: FakePm,
  logger: Logger,
  gitOpsFactory?: (p: string) => GitOps,
): RunBatchLoopDeps {
  // Assembly builds BOTH repos' handles from the INNER lane's factory
  // (group-integration.ts wires `gitOps: (p) => innerLane.gitOps(p)`), so a
  // fault injected for one repo has to discriminate on the worktree path.
  const ops = gitOpsFactory ?? ((p: string) => createGitOps(simpleGit(p)));
  return {
    pmClient: makeFakePm(state),
    // The single-repo lane is never reached in these tests; runGroupLaneOnce
    // returns before the scheduler falls through.
    pool: lane.innerPool,
    gitOps: (p: string) => createGitOps(simpleGit(p)),
    logger,
    projectId: PROJECT_ID,
    resource: RESOURCE,
    defaultVerifyCommand: "echo verify-ok",
    verifyTimeoutSec: 60,
    gitRemote: GIT_REMOTE,
    gitMainBranch: GIT_MAIN,
    groupLane: {
      innerLane: {
        role: "inner",
        name: INNER_REPO,
        acquire: () => lane.innerPool.acquire(),
        release: (wt) => lane.innerPool.release(wt),
        gitOps: ops,
        gitlinkPath: GITLINK_PATH,
        resolveRefInClone: (ref) => resolveVerified(lane.innerBindGit, ref),
      },
      outerLane: {
        role: "outer",
        name: OUTER_REPO,
        acquire: () => lane.outerPool.acquire(),
        release: (wt) => lane.outerPool.release(wt),
        gitOps: ops,
        resolveRefInClone: (ref) => resolveVerified(lane.outerBindGit, ref),
      },
    },
    waitForWork: async () => {},
    shouldContinue: () => true,
  };
}

/** The group S5 is about: a real inner member landing the dangling target, plus
 *  the PM-minted synthetic outer member (`synthesize_outer`). */
function healingGroup(lane: Lane): MergeRequestView[] {
  return [
    makeMember({ id: "req-inner", commitSha: lane.ahead, taskId: "task-inner" }),
    makeMember({ id: "req-synth", synthetic: true }),
  ];
}

async function bareSha(bare: string, ref = GIT_MAIN): Promise<string> {
  return (await simpleGit(bare).revparse([ref])).trim();
}

// ─── The tests ────────────────────────────────────────────────────────

describe.skipIf(!GIT_AVAILABLE)("a landed cross-repo group closes the incident it cured", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "pm-int-s5-"));
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("T1. the `heals` group opens the incident and its own land closes it, as an OBSERVATION", async () => {
    const lane = await buildHealingLane(root, "t1");
    const state = newState(healingGroup(lane));
    const { logger, records } = capturingLogger();

    const outcome = await runGroupLaneOnce(depsFor(lane, state, logger));

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("expected resolved");
    expect(outcome.land?.kind).toBe("landed");

    // The gate opened it (main really was broken when measured) and the land
    // cured it, in ONE pass — the case that used to leave a row open forever.
    expect(state.incidents).toHaveLength(1);
    expect(state.incidents[0]).toMatchObject({ type: "dangling_gitlink", orphanedSha: lane.ahead });
    expect(state.incidents[0].state).toBe("auto_resolved");

    expect(state.resolveCalls).toHaveLength(1);
    expect(state.resolveCalls[0]).toMatchObject({
      id: state.incidents[0].id,
      // NEVER auto_rollforward: that mode asserts the train pushed a RECOVERY.
      mode: "auto_observed",
      resolvedByGroupId: GROUP_ID,
    });
    // §14.21's lesson: the record names the commit. Both the cured target and
    // the two shas that entail the cure.
    const note = state.resolveCalls[0].note ?? "";
    expect(note).toContain(lane.ahead);
    expect(note).toContain(await bareSha(lane.outerBare));
    expect(note).toMatch(/applied no cure/);
    // It must not claim a probe it never ran.
    expect(note).toMatch(/not re-measured after it/);

    // The lane really is healthy: outer main's gitlink IS inner main.
    const innerMain = await bareSha(lane.innerBare);
    expect(innerMain).toBe(lane.ahead);
    expect((await simpleGit(lane.outerBare).raw(["ls-tree", GIT_MAIN, GITLINK_PATH])).trim()).toBe(
      `160000 commit ${innerMain}\t${GITLINK_PATH}`,
    );

    // Closed with an operator-visible trace, and by the LAND, not a measurement.
    const closed = find(records, /dangling_gitlink incident resolved \(entailed by the land/);
    expect(closed).toHaveLength(1);
    expect(closed[0].level).toBe("info");

    // Only THIS direction was listed — an orphaned_inner is a different broken
    // invariant nothing on this path measured, and it is the rollforward's input.
    expect(state.listFilters).toContainEqual({ state: "open", type: "dangling_gitlink" });
  }, 120_000);

  it("T2. an ORPHANED land closes nothing — outer main's gitlink never moved", async () => {
    const lane = await buildHealingLane(root, "t2");
    const state = newState(healingGroup(lane));
    const { logger } = capturingLogger();

    // The outer push fails AFTER the inner one succeeded: the §6.5 orphan. Not
    // `non_fast_forward` (that re-queues) — an opaque failure, which orphans.
    const failOuterPush = (p: string): GitOps => {
      const real = createGitOps(simpleGit(p));
      if (!path.basename(p).startsWith("outer-")) return real;
      return { ...real, push: async () => ({ ok: false as const, reason: "other" as const }) };
    };
    const outcome = await runGroupLaneOnce(depsFor(lane, state, logger, failOuterPush));

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("expected resolved");
    expect(outcome.land?.kind).toBe("orphaned");

    // The dangling incident the gate opened is STILL OPEN: outer main was never
    // pushed, so the target it names still dangles. Closing it here would be the
    // exoneration this campaign exists to delete.
    const dangling = state.incidents.filter((i) => i.type === "dangling_gitlink");
    expect(dangling).toHaveLength(1);
    expect(dangling[0].state).toBe("open");
    expect(state.resolveCalls).toHaveLength(0);
    // The orphan record was opened instead — a different, still-broken invariant.
    expect(state.incidents.some((i) => i.type === "orphaned_inner")).toBe(true);
  }, 120_000);

  it("T3. another lane's dangling incident is untouched, and only this direction is listed", async () => {
    const lane = await buildHealingLane(root, "t3");
    const state = newState(healingGroup(lane), {
      incidents: [
        // A SECOND cross-repo lane in the same project. `listMergeIncidents` has
        // no repo filter, so only the client-side lane check protects this row.
        {
          id: "inc-other-lane",
          type: "dangling_gitlink",
          innerRepo: "some-other-inner",
          outerRepo: "some-other-outer",
          orphanedSha: "f00dfeed",
          state: "open",
        },
        // The other DIRECTION, on this lane. Nothing here measured it. The
        // request's type filter is what protects it in production (the server
        // honors `params.type`); this fake honors the same filter, so the
        // load-bearing assertion is the one on `listFilters` below.
        {
          id: "inc-orphan-here",
          type: "orphaned_inner",
          innerRepo: INNER_REPO,
          outerRepo: OUTER_REPO,
          orphanedSha: "0rphaned",
          state: "open",
        },
      ],
    });
    const { logger } = capturingLogger();

    const outcome = await runGroupLaneOnce(depsFor(lane, state, logger));
    expect(outcome.kind).toBe("resolved");

    expect(state.resolveCalls.map((c) => c.id)).not.toContain("inc-other-lane");
    expect(state.resolveCalls.map((c) => c.id)).not.toContain("inc-orphan-here");
    expect(state.incidents.find((i) => i.id === "inc-other-lane")?.state).toBe("open");
    expect(state.incidents.find((i) => i.id === "inc-orphan-here")?.state).toBe("open");
    // Every dangling list this pass made was type-scoped.
    const dangling = state.listFilters.filter((f) => f.type === "dangling_gitlink");
    expect(dangling.length).toBeGreaterThan(0);
    for (const f of dangling) expect(f).toEqual({ state: "open", type: "dangling_gitlink" });
  }, 120_000);

  it("T4. NOTHING in the close can turn a successful atomic land into an error", async () => {
    // The load-bearing guard, not belt-and-braces: the close runs inside
    // runGroupLaneOnce's try, so an escaping throw would be caught there and the
    // pass would report `{ kind: "error" }` for a group that LANDED on both
    // remotes — the worst possible lie about a merge.
    for (const fault of ["list", "resolve"] as const) {
      const lane = await buildHealingLane(root, `t4-${fault}`);
      const state = newState(healingGroup(lane), {
        failListDangling: fault === "list",
        // The gate mints inc-1 during this same pass.
        failResolveIds: fault === "resolve" ? ["inc-1"] : undefined,
      });
      const { logger, records } = capturingLogger();

      const outcome = await runGroupLaneOnce(depsFor(lane, state, logger));

      expect(outcome.kind).toBe("resolved");
      if (outcome.kind !== "resolved") throw new Error("expected resolved");
      expect(outcome.land?.kind).toBe("landed");
      if (outcome.land?.kind !== "landed") throw new Error("expected landed");
      // The lock still released, and it named the outer landed sha — a lane that
      // released with a plain reason would read as a pass that landed nothing.
      expect(state.lockHeld).toBe(false);
      expect(state.releases).toEqual([{ landedSha: outcome.land.outerLandedSha }]);
      // The row simply stays open for the next observation; the failure is a
      // debug line, not an escalation.
      expect(state.incidents[0].state).toBe("open");
      expect(find(records, /retry next pass/).length).toBeGreaterThan(0);
    }
  }, 240_000);

  it("T5. exactly two source files resolve an incident (one resolver, not three)", () => {
    // Design lock 6, as a source guard (S3's anti-exoneration guard is the
    // precedent). The day someone writes a THIRD resolve loop instead of calling
    // the helper that exists, this fails.
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files = spawnSync("git", ["ls-files", "*.ts"], { cwd: srcDir, encoding: "utf8" })
      .stdout.split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(10);
    const resolvers = files.filter((f) =>
      readFileSync(path.join(srcDir, f), "utf8").includes("pmClient.resolveIncident("),
    );
    expect(resolvers.sort()).toEqual(["group-integration.ts", "group-recovery.ts"]);
  });
});
