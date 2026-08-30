/**
 * Campaign 2026-08-30 §S2 — the invariant gate inside a real cross-repo
 * assembly: what it rejects, what it deliberately permits, the durable incident
 * in both directions, and the reject an author actually reads.
 *
 * S1 stopped git choking on the managed gitlink during our own fetches, which
 * means a dangling gitlink on outer main now sails silently into assembly and
 * step 8 rewrites the pointer BACKWARD onto live inner main — a loud stall
 * traded for a silent submodule regression. This gate is the only thing that
 * looks, so these are the tests that say it looked.
 *
 * Real two-repo fixtures throughout (the group-synthetic.test.ts idiom): bare
 * repos + seed clones, a seeded 160000 gitlink, size-1 worktree pools, binding
 * clones with the resolveVerified idiom, and a FakePm — extended here with an
 * incident STORE, so open/list/resolve is a state machine rather than three
 * unrelated spies.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { simpleGit, type SimpleGit } from "simple-git";
import type { MergeAttemptView, MergeRequestView } from "@pm/shared";
import { createGitOps, type GitOps } from "../src/git-ops.js";
import { createWorktreePool, type WorktreePool } from "../src/worktree-pool.js";
import type { Logger } from "../src/logger.js";
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
const PROJECT_ID = "proj-1";
const INNER_REPO = "rynx-inner";
const OUTER_REPO = "app-outer";

async function resolveVerified(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    return (await git.revparse(["--verify", `${ref}^{commit}`])).trim();
  } catch {
    return null;
  }
}

// ─── Capturing logger ─────────────────────────────────────────────────
//
// A REAL pino logger over an in-memory destination, not a hand-rolled double:
// the code under test logs through the full pino surface, and the assertions
// here are about LEVELS and FIELDS (a `heals` open must be info WITHOUT
// `escalation`, a `dangling` open must be warn WITH it), which a stub that only
// records call names cannot see.

interface LogRecord {
  level: string;
  msg: string;
  escalation?: boolean;
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

// ─── In-memory fake PM client (with an incident STORE) ────────────────

interface FakeIncident {
  id: string;
  type: string;
  innerRepo: string;
  outerRepo: string;
  orphanedSha: string;
  state: "open" | "auto_resolved";
}

interface OpenIncidentParams {
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
  group: { state: string; members: MergeRequestView[] };
  attempts: MergeAttemptView[];
  calls: string[];
  rejectPayload?: { reason: string; category?: string };
  landGroupBody?: { members: { requestId: string; landedSha: string; role: string }[] };
  incidents: FakeIncident[];
  openCalls: OpenIncidentParams[];
  listFilters: { state?: string; type?: string }[];
  resolveCalls: { id: string; mode: string; note?: string; resolvedByGroupId?: string }[];
  requestRejects: { requestId: string; category: string; reason: string }[];
  attemptCompletions: { attemptId: string; status: string }[];
  comments: { taskId: string; commentType: string; category?: string; reason?: string }[];
  /** Fault injection for the non-fatal paths. */
  failOpenIncident?: boolean;
  failListIncidents?: boolean;
  failResolveIds?: string[];
}

function newState(members: MergeRequestView[], over: Partial<FakePm> = {}): FakePm {
  return {
    group: { state: "forming", members },
    attempts: [],
    calls: [],
    incidents: [],
    openCalls: [],
    listFilters: [],
    resolveCalls: [],
    requestRejects: [],
    attemptCompletions: [],
    comments: [],
    ...over,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeFakePm(state: FakePm): GroupIntegrationDeps["pmClient"] {
  let seq = 0;
  let incidentSeq = 0;
  const fake = {
    async markGroupIntegrating(): Promise<unknown> {
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
        if (m.status === "queued" || m.status === "integrating") m.status = "rejected";
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
    async completeAttempt(attemptId: string, body: { status: string }): Promise<MergeAttemptView> {
      const att = state.attempts.find((a) => a.id === attemptId);
      if (!att) throw new Error(`no attempt ${attemptId}`);
      att.status = body.status as MergeAttemptView["status"];
      att.completedAt = nowIso();
      state.calls.push(`completeAttempt:${body.status}`);
      state.attemptCompletions.push({ attemptId, status: body.status });
      return att;
    },
    async landGroup(
      _groupId: string,
      body: { members: { requestId: string; landedSha: string; role: string }[] },
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
      const m = state.group.members.find((x) => x.id === requestId);
      if (m) m.landedSha = orphanedSha;
      return m;
    },
    async openIncident(
      params: OpenIncidentParams,
    ): Promise<{ incident: { id: string }; created: boolean }> {
      state.calls.push("openIncident");
      state.openCalls.push(params);
      if (state.failOpenIncident) throw new Error("PM is down");
      // Server-side dedup among OPEN incidents, mirrored here so a repeated
      // pass on a blocked lane is a no-op the way production's is.
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
      state.listFilters.push(filters ?? {});
      if (state.failListIncidents) throw new Error("PM is down");
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
    async markPartiallyLanded(): Promise<unknown> {
      state.calls.push("markPartiallyLanded");
      state.group.state = "partially_landed";
      return { ...state.group };
    },
    async rejectMergeRequest(
      requestId: string,
      payload: { category: string; reason: string },
    ): Promise<unknown> {
      state.calls.push("rejectMergeRequest");
      state.requestRejects.push({ requestId, ...payload });
      return null;
    },
    async noteOuterConverted(): Promise<void> {
      state.calls.push("noteOuterConverted");
    },
    async noteOuterGitlinkNormalized(): Promise<void> {
      state.calls.push("noteOuterGitlinkNormalized");
    },
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
    projectId: PROJECT_ID,
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

/** The PM-minted synthetic member: ref-less, ownerless of intent. */
function makeSynthetic(over: Partial<MergeRequestView> = {}): MergeRequestView {
  return makeMember({ id: "req-synth", synthetic: true, taskId: null, ...over });
}

// ─── Lane fixture ─────────────────────────────────────────────────────

interface Lane {
  innerBare: string;
  outerBare: string;
  innerSeedDir: string;
  innerSeed: SimpleGit;
  outerSeed: SimpleGit;
  innerPool: WorktreePool;
  outerPool: WorktreePool;
  innerBindGit: SimpleGit;
  outerBindGit: SimpleGit;
  innerMainSha: string;
  outerMainSha: string;
}

interface LaneOpts {
  root: string;
  label: string;
  /** Extra inner history, after main's base commit. May advance main. */
  inner?(ig: SimpleGit, dir: string): Promise<void>;
  /** Extra outer history, after outer main's gitlink commit. */
  outer?(og: SimpleGit, dir: string): Promise<void>;
  /** The 160000 target committed on outer MAIN — evaluated after `inner` ran. */
  gitlinkTarget(innerMainSha: string): string;
}

async function buildLane(opts: LaneOpts): Promise<Lane> {
  const dir = path.join(opts.root, opts.label);
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
  await ig.branch(["-M", "main"]);
  await ig.push(["-u", GIT_REMOTE, "main"]);
  if (opts.inner) await opts.inner(ig, innerSeedDir);
  const innerMainSha = (await simpleGit(innerBare).revparse([GIT_MAIN])).trim();

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
  await og.raw([
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${opts.gitlinkTarget(innerMainSha)},${GITLINK_PATH}`,
  ]);
  await og.commit("outer main base with gitlink");
  await og.branch(["-M", "main"]);
  await og.push(["-u", GIT_REMOTE, "main"]);
  if (opts.outer) await opts.outer(og, outerSeedDir);
  const outerMainSha = (await simpleGit(outerBare).revparse([GIT_MAIN])).trim();

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

  return {
    innerBare,
    outerBare,
    innerSeedDir,
    innerSeed: ig,
    outerSeed: og,
    innerPool,
    outerPool,
    innerBindGit,
    outerBindGit,
    innerMainSha,
    outerMainSha,
  };
}

function depsFor(
  lane: Lane,
  state: FakePm,
  logger: Logger,
  over: Partial<GroupIntegrationDeps> = {},
): GroupIntegrationDeps {
  return {
    pmClient: makeFakePm(state),
    logger,
    innerLane: {
      role: "inner",
      name: INNER_REPO,
      acquire: () => lane.innerPool.acquire(),
      release: (wt) => lane.innerPool.release(wt),
      gitOps: (p) => createGitOps(simpleGit(p)),
      gitlinkPath: GITLINK_PATH,
      resolveRefInClone: (ref) => resolveVerified(lane.innerBindGit, ref),
    },
    outerLane: {
      role: "outer",
      name: OUTER_REPO,
      acquire: () => lane.outerPool.acquire(),
      release: (wt) => lane.outerPool.release(wt),
      gitOps: (p) => createGitOps(simpleGit(p)),
      resolveRefInClone: (ref) => resolveVerified(lane.outerBindGit, ref),
    },
    gitRemote: GIT_REMOTE,
    defaultVerifyCommand: "echo verify-ok",
    verifyTimeoutSec: 30,
    // The observation site is guarded on projectId — an unconfigured caller
    // observes nothing at all.
    projectId: PROJECT_ID,
    ...over,
  };
}

async function bareSha(bare: string, ref = GIT_MAIN): Promise<string> {
  return (await simpleGit(bare).revparse([ref])).trim();
}

/**
 * Extract the shell check the REJECT printed and RUN it against a branch.
 *
 * Deliberately not a hand-written copy of the three conditions: a test that
 * writes its own command cannot catch the reject printing a different one,
 * which is exactly the defect class this guards (an earlier draft printed an
 * ancestor-only check that a merge-built branch PASSES, and the train then
 * rejected that branch anyway). Only the SHAPE is interpreted here — `git ...`
 * by exit code, `test "$(git ...)" = N` by stdout — never the content.
 */
function runPrintedCheck(rejectText: string, branch: string, cwd: string): boolean {
  const m = /One check, all three conditions: (.+?)\.\s/.exec(rejectText);
  if (!m) throw new Error(`the reject printed no check command:\n${rejectText}`);
  const cmd = m[1].replace(/<branch>/g, branch);
  const parts = cmd.split("&&").map((p) => p.trim());
  expect(parts.length).toBe(3);
  for (const part of parts) {
    const asTest = /^test "\$\(git (.+?)\)" = (\S+)$/.exec(part);
    if (asTest) {
      const out = spawnSync("git", asTest[1].split(/\s+/), { cwd, encoding: "utf8" });
      if (out.status !== 0) return false;
      if (out.stdout.trim() !== asTest[2]) return false;
      continue;
    }
    if (!part.startsWith("git ")) throw new Error(`unrecognized check segment: ${part}`);
    if (spawnSync("git", part.split(/\s+/).slice(1), { cwd, encoding: "utf8" }).status !== 0) {
      return false;
    }
  }
  return true;
}

// ─── The tests ────────────────────────────────────────────────────────

describe.skipIf(!GIT_AVAILABLE)("main-gitlink invariant gate (real two-repo groups)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "pm-int-maingate-grp-"));
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("T1. THE OUTAGE REGRESSION: a lone-outer group against a dangling main is rejected, and the incident is lane-scoped", async () => {
    // game_one's shape on 2026-08-29: outer main's gitlink points at an inner
    // commit that was pushed past the train, and the group carries NO inner
    // member — so Ri == live inner main and landing would drag the pointer
    // BACKWARD. The Ri predicate must not rescue this group.
    let dangling = "";
    let docsSha = "";
    const lane = await buildLane({
      root,
      label: "t1",
      async inner(ig, dir) {
        await ig.checkout(["-b", "pushed-past-the-train"]);
        writeFileSync(path.join(dir, "engine.txt"), "new engine\n");
        await ig.add(["engine.txt"]);
        await ig.commit("the commit outer main names");
        dangling = (await ig.revparse(["HEAD"])).trim();
        await ig.push(["-u", GIT_REMOTE, "pushed-past-the-train"]);
        await ig.checkout(GIT_MAIN);
      },
      async outer(og, dir) {
        await og.checkoutLocalBranch("docs/only");
        writeFileSync(path.join(dir, "README.md"), "docs\n");
        await og.add(["README.md"]);
        await og.commit("documentation-only outer change");
        docsSha = (await og.revparse(["HEAD"])).trim();
        await og.push(["-u", GIT_REMOTE, "docs/only"]);
        await og.checkout(GIT_MAIN);
      },
      gitlinkTarget: () => dangling,
    });
    const outerMainBefore = await bareSha(lane.outerBare);
    const innerMainBefore = await bareSha(lane.innerBare);

    const state = newState([
      makeMember({ id: "req-outer", commitSha: docsSha, taskId: "task-outer" }),
      makeSynthetic(),
    ]);
    const { logger, records } = capturingLogger();
    const outcome = await runGroupIntegration(
      { id: "grp-t1", members: state.group.members },
      depsFor(lane, state, logger),
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected a reject");
    expect(outcome.reason).toContain("main_gitlink_dangling");
    // Rejected, never re-queued: this is not a lost race the next pass wins.
    expect(state.calls).toContain("rejectGroup");
    expect(state.calls).not.toContain("markGroupIntegrating");
    expect(state.rejectPayload?.category).toBe("main_gitlink_dangling");

    // The incident is a property of the LANE — no group, no request, no task.
    expect(state.openCalls).toHaveLength(1);
    expect(state.openCalls[0]).toMatchObject({
      projectId: PROJECT_ID,
      type: "dangling_gitlink",
      innerRepo: INNER_REPO,
      outerRepo: OUTER_REPO,
      orphanedSha: dangling,
      groupId: null,
      innerRequestId: null,
      taskId: null,
    });
    // Opened loudly, because a human has to cure it.
    const opened = find(records, /not reachable from inner main; the lane is blocked/);
    expect(opened).toHaveLength(1);
    expect(opened[0].level).toBe("warn");
    expect(opened[0].escalation).toBe(true);

    // T8's half: step 8 never ran. Neither main moved, and the detail names the
    // live outer main — the adjacency the gate's `outerMainSha` label asserts.
    expect(await bareSha(lane.outerBare)).toBe(outerMainBefore);
    expect(await bareSha(lane.innerBare)).toBe(innerMainBefore);
    expect(outcome.reason).toContain(`outer main ${outerMainBefore}`);
    expect(state.calls).not.toContain("landGroup");

    // The printed cure is REACHABLE here: `pushed-past-the-train` is a linear
    // descendant of inner main ending at the target, which is exactly the
    // branch the reject asks for. Extracted from the reject and RUN, so the
    // instruction and the gate cannot drift apart (T2b is the mirror — the
    // branch the check must REFUSE).
    expect(runPrintedCheck(outcome.reason, "pushed-past-the-train", lane.innerSeedDir)).toBe(true);

    // The real member's author is told, where they work.
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]).toMatchObject({
      taskId: "task-outer",
      commentType: "merge_rejection",
      category: "main_gitlink_dangling",
    });
  }, 60_000);

  it("T2/T3. THE HEALING GROUP lands and the next healthy pass closes the incident it opened", async () => {
    // Main is dangling because the target is AHEAD of inner main. A group whose
    // landing inner CONTAINS that target moves the pointer forward and cures
    // the lane — gating on health would reject the one cure the train can take.
    let ahead = "";
    const lane = await buildLane({
      root,
      label: "t2",
      async inner(ig, dir) {
        await ig.checkout(["-b", "ahead"]);
        writeFileSync(path.join(dir, "engine.txt"), "new engine\n");
        await ig.add(["engine.txt"]);
        await ig.commit("the commit outer main names (ahead of inner main)");
        ahead = (await ig.revparse(["HEAD"])).trim();
        await ig.push(["-u", GIT_REMOTE, "ahead"]);
        await ig.checkout(GIT_MAIN);
      },
      gitlinkTarget: () => ahead,
    });

    const state = newState([
      makeMember({ id: "req-inner", commitSha: ahead, taskId: "task-inner" }),
      makeSynthetic(),
    ]);
    const { logger, records } = capturingLogger();
    const deps = depsFor(lane, state, logger);
    const integ = await runGroupIntegration({ id: "grp-t2", members: state.group.members }, deps);

    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") {
      throw new Error(
        `expected ready_to_land, got ${integ.kind}${integ.kind === "rejected" ? `: ${integ.reason}` : ""}`,
      );
    }
    // The branch fast-forwards inner main and ends AT the target, so the rebase
    // is a no-op and what lands IS the target.
    expect(integ.Ri).toBe(ahead);
    expect(integ.assembled.mainGitlink.kind).toBe("heals");

    // The incident STILL opens — health is false right now, and a repair that
    // left no record is how `pm_list_merge_incidents` came to say "No merge
    // incidents" about a lane that had one.
    expect(state.openCalls).toHaveLength(1);
    expect(state.openCalls[0]).toMatchObject({ type: "dangling_gitlink", orphanedSha: ahead });
    const healed = find(records, /this group's landing inner contains it, so the land repairs/);
    expect(healed).toHaveLength(1);
    // INFO and no escalation: nothing needs a human, and the alert channel must
    // not page for something this very land fixes.
    expect(healed[0].level).toBe("info");
    expect(healed[0].escalation).toBeUndefined();
    const incidentId = state.incidents[0].id;

    const landed = await landAssembledGroup(
      {
        groupId: "grp-t2",
        projectId: PROJECT_ID,
        ready: integ,
        innerRepoName: INNER_REPO,
        outerRepoName: OUTER_REPO,
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );
    expect(landed.kind).toBe("landed");
    // Step 8 authored the gitlink to Ri, which CONTAINS the target — the
    // pointer moved forward, and the lane is cured.
    expect(await bareSha(lane.innerBare)).toBe(ahead);
    expect((await simpleGit(lane.outerBare).raw(["ls-tree", GIT_MAIN, GITLINK_PATH])).trim()).toBe(
      `160000 commit ${ahead}\t${GITLINK_PATH}`,
    );

    // ── the next pass: a healthy group over the cured lane ──
    await lane.innerSeed.fetch(GIT_REMOTE);
    await lane.innerSeed.checkout(["-b", "next", ahead]);
    writeFileSync(path.join(lane.innerSeedDir, "next.txt"), "more work\n");
    await lane.innerSeed.add(["next.txt"]);
    await lane.innerSeed.commit("a perfectly ordinary follow-up");
    const next = (await lane.innerSeed.revparse(["HEAD"])).trim();
    await lane.innerSeed.push(["-u", GIT_REMOTE, "next"]);
    await lane.innerBindGit.fetch(GIT_REMOTE);

    const state2: FakePm = {
      ...newState([makeMember({ id: "req-inner-2", commitSha: next }), makeSynthetic()]),
      // The SAME incident store — this is one lane across two passes.
      incidents: state.incidents,
    };
    const deps2 = depsFor(lane, state2, logger);
    const integ2 = await runGroupIntegration(
      { id: "grp-t3", members: state2.group.members },
      deps2,
    );
    expect(integ2.kind).toBe("ready_to_land");
    if (integ2.kind !== "ready_to_land") throw new Error("expected ready_to_land");
    expect(integ2.assembled.mainGitlink.kind).toBe("holds");
    integ2.assembled.release();

    // The incident closes itself, as an OBSERVATION — the train applied nothing.
    expect(state2.openCalls).toHaveLength(0);
    expect(state2.resolveCalls).toHaveLength(1);
    expect(state2.resolveCalls[0]).toMatchObject({
      id: incidentId,
      mode: "auto_observed",
      resolvedByGroupId: "grp-t3",
    });
    expect(state2.resolveCalls[0].note).toMatch(/it did not apply a cure/);
    expect(state.incidents[0].state).toBe("auto_resolved");
    const closed = find(records, /invariant holds again; dangling_gitlink incident resolved/);
    expect(closed).toHaveLength(1);
    expect(closed[0].level).toBe("info");
    // Only THIS direction is listed — an orphaned_inner is a different broken
    // invariant this check never measured.
    expect(state2.listFilters).toContainEqual({ state: "open", type: "dangling_gitlink" });
  }, 90_000);

  it("T2b. THE FALSE GREEN: a merge-built cure branch is rejected, and the check the reject PRINTS says so first", async () => {
    // The branch an author builds when inner main has diverged from the target:
    // `checkout -b cure <innerMain>; merge <target>`. It CONTAINS the target and
    // has inner main as an ancestor — an ancestor-only check passes it — but the
    // range holds a merge commit, so the rebase flattens it and rewrites the
    // target. An earlier draft of the reject printed exactly that check.
    let target = "";
    let cure = "";
    const lane = await buildLane({
      root,
      label: "t2b",
      async inner(ig, dir) {
        const base = (await ig.revparse(["HEAD"])).trim();
        await ig.checkout(["-b", "engine", base]);
        writeFileSync(path.join(dir, "engine.txt"), "new engine\n");
        await ig.add(["engine.txt"]);
        await ig.commit("the commit outer main names");
        target = (await ig.revparse(["HEAD"])).trim();
        await ig.push(["-u", GIT_REMOTE, "engine"]);

        // inner main moves on, DIVERGING from the target.
        await ig.checkout(GIT_MAIN);
        writeFileSync(path.join(dir, "lib.txt"), "v2\n");
        await ig.add(["lib.txt"]);
        await ig.commit("inner main advances");
        await ig.push([GIT_REMOTE, GIT_MAIN]);

        // The obvious cure branch — and the trap.
        await ig.checkout(["-b", "cure", GIT_MAIN]);
        await ig.raw(["merge", "--no-ff", "-m", "merge the engine work", target]);
        cure = (await ig.revparse(["HEAD"])).trim();
        await ig.push(["-u", GIT_REMOTE, "cure"]);
        await ig.checkout(GIT_MAIN);
      },
      gitlinkTarget: () => target,
    });

    const state = newState([
      makeMember({ id: "req-inner", commitSha: cure, taskId: "task-inner" }),
      makeSynthetic(),
    ]);
    const { logger } = capturingLogger();
    const outcome = await runGroupIntegration(
      { id: "grp-t2b", members: state.group.members },
      depsFor(lane, state, logger),
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected a reject");
    expect(outcome.reason).toContain("main_gitlink_dangling");

    // ── the guard: the printed check must REFUSE this branch BEFORE submission,
    //    which is the whole point of printing it. Extracted from the reject, not
    //    written here, so the text and the behaviour cannot drift. ──
    expect(runPrintedCheck(outcome.reason, "cure", lane.innerSeedDir)).toBe(false);
    // Nor does any other branch here: this is the DIVERGED case, so the cure is
    // out of the train's reach entirely and the text must say so rather than
    // sending the author round the loop again. (T1 is the positive control —
    // the same extracted check PASSES a branch the gate would permit.)
    expect(runPrintedCheck(outcome.reason, "engine", lane.innerSeedDir)).toBe(false);
    expect(outcome.reason).toMatch(/out of the train's reach/);
  }, 60_000);

  it("T4. a two-member group whose target is on neither main nor Ri is rejected", async () => {
    let dangling = "";
    let innerFeature = "";
    let outerFeature = "";
    const lane = await buildLane({
      root,
      label: "t4",
      async inner(ig, dir) {
        const base = (await ig.revparse(["HEAD"])).trim();
        await ig.checkout(["-b", "off-main", base]);
        writeFileSync(path.join(dir, "off.txt"), "off main\n");
        await ig.add(["off.txt"]);
        await ig.commit("the commit outer main names");
        dangling = (await ig.revparse(["HEAD"])).trim();
        await ig.push(["-u", GIT_REMOTE, "off-main"]);
        await ig.checkout(["-b", "feature/inner", GIT_MAIN]);
        writeFileSync(path.join(dir, "feature.txt"), "inner feature\n");
        await ig.add(["feature.txt"]);
        await ig.commit("inner feature");
        innerFeature = (await ig.revparse(["HEAD"])).trim();
        await ig.push(["-u", GIT_REMOTE, "feature/inner"]);
        await ig.checkout(GIT_MAIN);
      },
      async outer(og, dir) {
        await og.checkoutLocalBranch("feature/outer");
        writeFileSync(path.join(dir, "app.txt"), "outer feature\n");
        await og.add(["app.txt"]);
        await og.commit("outer feature");
        outerFeature = (await og.revparse(["HEAD"])).trim();
        await og.push(["-u", GIT_REMOTE, "feature/outer"]);
        await og.checkout(GIT_MAIN);
      },
      gitlinkTarget: () => dangling,
    });

    const state = newState([
      makeMember({ id: "req-inner", commitSha: innerFeature }),
      makeMember({ id: "req-outer", commitSha: outerFeature }),
    ]);
    const { logger } = capturingLogger();
    const outcome = await runGroupIntegration(
      { id: "grp-t4", members: state.group.members },
      depsFor(lane, state, logger),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected a reject");
    expect(outcome.reason).toContain("main_gitlink_dangling");
    expect(state.openCalls).toHaveLength(1);
  }, 60_000);

  it("T5. THE ORDERING TRAP: a lone-outer group bumping to a GOOD target is still caught — by the gate, not the classifier", async () => {
    // classifyOuterGitlinkDiff would call this a clean `pure_bump` and let step
    // 8 drag outer main's pointer backward. The two checks ask different
    // questions about different commits, and only this one looks at MAIN.
    let dangling = "";
    let goodTarget = "";
    let bumpSha = "";
    const lane = await buildLane({
      root,
      label: "t5",
      async inner(ig, dir) {
        const base = (await ig.revparse(["HEAD"])).trim();
        await ig.checkout(["-b", "off-main", base]);
        writeFileSync(path.join(dir, "off.txt"), "off main\n");
        await ig.add(["off.txt"]);
        await ig.commit("the commit outer main names");
        dangling = (await ig.revparse(["HEAD"])).trim();
        await ig.push(["-u", GIT_REMOTE, "off-main"]);
        await ig.checkout(GIT_MAIN);
      },
      async outer(og) {
        // A bump to live inner main — a target the classifier is happy with.
        await og.checkoutLocalBranch("bump/good");
        await og.raw([
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${goodTarget},${GITLINK_PATH}`,
        ]);
        await og.commit("bump the gitlink to live inner main");
        bumpSha = (await og.revparse(["HEAD"])).trim();
        await og.push(["-u", GIT_REMOTE, "bump/good"]);
        await og.checkout(GIT_MAIN);
      },
      // Runs BEFORE `outer`, which is what lets the bump branch name it.
      gitlinkTarget(innerMainSha) {
        goodTarget = innerMainSha;
        return dangling;
      },
    });

    const state = newState([makeMember({ id: "req-outer", commitSha: bumpSha }), makeSynthetic()]);
    const { logger } = capturingLogger();
    const outcome = await runGroupIntegration(
      { id: "grp-t5", members: state.group.members },
      depsFor(lane, state, logger),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected a reject");
    expect(outcome.reason).toContain("main_gitlink_dangling");
    // NOT the classifier's verdict — that one never looks at outer main.
    expect(outcome.reason).not.toContain("gitlink_diverged");
  }, 60_000);

  it("T6. the composed reject reads as one paragraph: the finding, the cure, what will be rejected again, and the incident", async () => {
    let dangling = "";
    const lane = await buildLane({
      root,
      label: "t6",
      async inner(ig, dir) {
        const base = (await ig.revparse(["HEAD"])).trim();
        await ig.checkout(["-b", "off-main", base]);
        writeFileSync(path.join(dir, "off.txt"), "off main\n");
        await ig.add(["off.txt"]);
        await ig.commit("the commit outer main names");
        dangling = (await ig.revparse(["HEAD"])).trim();
        await ig.push(["-u", GIT_REMOTE, "off-main"]);
        await ig.checkout(GIT_MAIN);
      },
      gitlinkTarget: () => dangling,
    });
    const state = newState([
      makeMember({ id: "req-inner", commitSha: lane.innerMainSha }),
      makeSynthetic(),
    ]);
    const { logger } = capturingLogger();
    const outcome = await runGroupIntegration(
      { id: "grp-t6", members: state.group.members },
      depsFor(lane, state, logger),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected a reject");
    const text = outcome.reason;

    // (1) it names every commit it judged — the 2026-08-22 lesson.
    expect(text).toContain(dangling);
    expect(text).toContain(lane.innerMainSha);
    expect(text).toContain(lane.outerMainSha);
    expect(text).toContain(GITLINK_PATH);

    // (2) the cure is CONSTRUCTIBLE: the tool, the flag a single-member group
    //     requires, the FAST-FORWARD condition, and a check that decides all
    //     three of its parts. Each of these was a defect at some point in this
    //     step's review — an ancestor-only check is a false green, and a
    //     submission without the flag is a 400.
    expect(text).toContain("pm_request_merge_group");
    expect(text).toContain("synthesize_outer: true");
    expect(text).toContain("FAST-FORWARD");
    expect(text).toContain("git merge-base --is-ancestor");
    expect(text).toContain("rev-list --count --merges");

    // (3) what will be rejected again, and the other cure.
    expect(text).toMatch(/rejected here again/);
    expect(text).toMatch(/only reverts the gitlink/);
    expect(text).toMatch(/ordinary outer-repo change/);
    // The cure text must not assert that this project's single-repo lane IS the
    // outer repo — that is a gitRepoUrl config choice.
    expect(text).not.toMatch(/plain single-repo merge request/);

    // (4) the incident, and the join between two authors' text.
    expect(text).toContain(state.incidents[0].id);
    expect(text).toContain(". The cure that keeps outer main compiling");

    // (5) design lock 3: no pre-emptive exoneration beyond the one measured
    //     clause the lane_blocked verdict licenses.
    expect(text).not.toContain("defect in the train");

    // (6) each of the `why`'s clauses appears EXACTLY once in the whole
    //     paragraph — S2 consumes S3's sentence, it never restates it.
    for (const clause of [
      "not this change",
      "does not repair it",
      "not reachable from inner main",
      "measured, not inferred",
      "resolver session cannot help",
      "consumers of outer main compile",
    ]) {
      expect(text.split(clause), clause).toHaveLength(2);
    }
  }, 60_000);

  it("T7. the ABSENT variant says the objects are gone and still names the landing inner", async () => {
    const absent = "e".repeat(40);
    const lane = await buildLane({
      root,
      label: "t7",
      gitlinkTarget: () => absent,
    });
    const state = newState([
      makeMember({ id: "req-inner", commitSha: lane.innerMainSha }),
      makeSynthetic(),
    ]);
    const { logger } = capturingLogger();
    const outcome = await runGroupIntegration(
      { id: "grp-t7", members: state.group.members },
      depsFor(lane, state, logger),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected a reject");
    expect(outcome.reason).toMatch(/absent from the inner repo even after an all-refs fetch/);
    expect(outcome.reason).toMatch(/in no clone the daemon can reach/);
    // Still names Ri — the verdict depended on it.
    expect(outcome.reason).toContain(`landing inner ${lane.innerMainSha}`);
    // And it still carries the whole constructibility set (an earlier draft
    // dropped the check command from this variant).
    expect(outcome.reason).toContain("synthesize_outer: true");
    expect(outcome.reason).toContain("rev-list --count --merges");
    expect(outcome.reason).toContain("FAST-FORWARD");
  }, 60_000);

  it("T9. openIncident failing on the reject path degrades the text and changes nothing else", async () => {
    let dangling = "";
    const lane = await buildLane({
      root,
      label: "t9",
      async inner(ig, dir) {
        const base = (await ig.revparse(["HEAD"])).trim();
        await ig.checkout(["-b", "off-main", base]);
        writeFileSync(path.join(dir, "off.txt"), "off main\n");
        await ig.add(["off.txt"]);
        await ig.commit("the commit outer main names");
        dangling = (await ig.revparse(["HEAD"])).trim();
        await ig.push(["-u", GIT_REMOTE, "off-main"]);
        await ig.checkout(GIT_MAIN);
      },
      gitlinkTarget: () => dangling,
    });
    const state = newState(
      [makeMember({ id: "req-inner", commitSha: lane.innerMainSha }), makeSynthetic()],
      { failOpenIncident: true },
    );
    const { logger, records } = capturingLogger();
    const outcome = await runGroupIntegration(
      { id: "grp-t9", members: state.group.members },
      depsFor(lane, state, logger),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected a reject");
    // Exactly one reject, no unhandled rejection, and the text names no id.
    expect(state.calls.filter((c) => c === "rejectGroup")).toHaveLength(1);
    expect(outcome.reason).toMatch(
      /The train re-checks the invariant on every cross-repo group and stops rejecting once it holds\.$/,
    );
    expect(outcome.reason).not.toMatch(/Incident inc-/);
    expect(find(records, /openIncident\(dangling_gitlink\) failed/)).toHaveLength(1);
  }, 60_000);

  it("T10. openIncident failing on the HEALS path must not block the repair", async () => {
    let ahead = "";
    const lane = await buildLane({
      root,
      label: "t10",
      async inner(ig, dir) {
        await ig.checkout(["-b", "ahead"]);
        writeFileSync(path.join(dir, "engine.txt"), "new engine\n");
        await ig.add(["engine.txt"]);
        await ig.commit("the commit outer main names");
        ahead = (await ig.revparse(["HEAD"])).trim();
        await ig.push(["-u", GIT_REMOTE, "ahead"]);
        await ig.checkout(GIT_MAIN);
      },
      gitlinkTarget: () => ahead,
    });
    const state = newState([makeMember({ id: "req-inner", commitSha: ahead }), makeSynthetic()], {
      failOpenIncident: true,
    });
    const { logger } = capturingLogger();
    const deps = depsFor(lane, state, logger);
    const integ = await runGroupIntegration({ id: "grp-t10", members: state.group.members }, deps);
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error("expected ready_to_land");
    const landed = await landAssembledGroup(
      {
        groupId: "grp-t10",
        projectId: PROJECT_ID,
        ready: integ,
        innerRepoName: INNER_REPO,
        outerRepoName: OUTER_REPO,
      },
      { pmClient: deps.pmClient, logger, gitRemote: GIT_REMOTE, gitMainBranch: GIT_MAIN },
    );
    expect(landed.kind).toBe("landed");
  }, 60_000);

  it("T11-T15. the resolve side: right lane only, right direction only, and never load-bearing", async () => {
    const lane = await buildLane({
      root,
      label: "t11",
      gitlinkTarget: (innerMainSha) => innerMainSha,
    });
    const member = (): MergeRequestView[] => [
      makeMember({ id: "req-inner", commitSha: lane.innerMainSha }),
      makeSynthetic(),
    ];
    const { logger, records } = capturingLogger();

    // T11 — a healthy lane resolves ONLY its own direction, in its own repo pair.
    const other: FakeIncident[] = [
      {
        id: "inc-other-lane",
        type: "dangling_gitlink",
        innerRepo: "some-other-inner",
        outerRepo: "some-other-outer",
        orphanedSha: "a".repeat(40),
        state: "open",
      },
      {
        id: "inc-orphan",
        type: "orphaned_inner",
        innerRepo: INNER_REPO,
        outerRepo: OUTER_REPO,
        orphanedSha: "b".repeat(40),
        state: "open",
      },
    ];
    const s11 = newState(member(), { incidents: [...other] });
    const i11 = await runGroupIntegration(
      { id: "grp-t11", members: s11.group.members },
      depsFor(lane, s11, logger),
    );
    expect(i11.kind).toBe("ready_to_land");
    if (i11.kind !== "ready_to_land") throw new Error("expected ready_to_land");
    i11.assembled.release();
    expect(s11.resolveCalls).toHaveLength(0);
    expect(s11.incidents.every((i) => i.state === "open")).toBe(true);

    // T13 — a healthy lane with nothing open opens nothing and closes nothing.
    const s13 = newState(member());
    const i13 = await runGroupIntegration(
      { id: "grp-t13", members: s13.group.members },
      depsFor(lane, s13, logger),
    );
    if (i13.kind !== "ready_to_land") throw new Error("expected ready_to_land");
    i13.assembled.release();
    expect(s13.openCalls).toHaveLength(0);
    expect(s13.resolveCalls).toHaveLength(0);

    // T14 — listMergeIncidents throwing is a quiet retry-next-pass, not noise.
    const before = records.length;
    const s14 = newState(member(), { failListIncidents: true });
    const i14 = await runGroupIntegration(
      { id: "grp-t14", members: s14.group.members },
      depsFor(lane, s14, logger),
    );
    if (i14.kind !== "ready_to_land") throw new Error("expected ready_to_land");
    i14.assembled.release();
    const listFailures = find(records.slice(before), /listMergeIncidents failed while observing/);
    expect(listFailures).toHaveLength(1);
    expect(listFailures[0].level).toBe("debug");

    // T15 — one failing resolve must not abort the loop over the others.
    const s15 = newState(member(), {
      incidents: [
        {
          id: "inc-a",
          type: "dangling_gitlink",
          innerRepo: INNER_REPO,
          outerRepo: OUTER_REPO,
          orphanedSha: "c".repeat(40),
          state: "open",
        },
        {
          id: "inc-b",
          type: "dangling_gitlink",
          innerRepo: INNER_REPO,
          outerRepo: OUTER_REPO,
          orphanedSha: "d".repeat(40),
          state: "open",
        },
      ],
      failResolveIds: ["inc-a"],
    });
    const i15 = await runGroupIntegration(
      { id: "grp-t15", members: s15.group.members },
      depsFor(lane, s15, logger),
    );
    if (i15.kind !== "ready_to_land") throw new Error("expected ready_to_land");
    i15.assembled.release();
    expect(s15.resolveCalls.map((r) => r.id)).toEqual(["inc-a", "inc-b"]);
    expect(s15.incidents.find((i) => i.id === "inc-a")?.state).toBe("open");
    expect(s15.incidents.find((i) => i.id === "inc-b")?.state).toBe("auto_resolved");
  }, 90_000);

  it("T12. an UNDECIDED probe changes nothing at all — no gate, no open, no resolve", async () => {
    // Design lock 5. A broken probe must not wedge a healthy lane, and it must
    // not touch an incident it did not measure either.
    const lane = await buildLane({
      root,
      label: "t12",
      gitlinkTarget: (innerMainSha) => innerMainSha,
    });
    const state = newState(
      [makeMember({ id: "req-inner", commitSha: lane.innerMainSha }), makeSynthetic()],
      {
        incidents: [
          {
            id: "inc-standing",
            type: "dangling_gitlink",
            innerRepo: INNER_REPO,
            outerRepo: OUTER_REPO,
            orphanedSha: "f".repeat(40),
            state: "open",
          },
        ],
      },
    );
    const { logger, records } = capturingLogger();
    const deps = depsFor(lane, state, logger);
    const broken: RepoLane = {
      ...deps.innerLane,
      gitOps: (p): GitOps => ({
        ...createGitOps(simpleGit(p)),
        isAncestor: () => {
          throw new Error("merge-base exploded");
        },
      }),
    };
    const integ = await runGroupIntegration(
      { id: "grp-t12", members: state.group.members },
      { ...deps, innerLane: broken },
    );
    expect(integ.kind).toBe("ready_to_land");
    if (integ.kind !== "ready_to_land") throw new Error("expected ready_to_land");
    expect(integ.assembled.mainGitlink.kind).toBe("undecided");
    integ.assembled.release();

    expect(state.openCalls).toHaveLength(0);
    expect(state.resolveCalls).toHaveLength(0);
    expect(state.incidents[0].state).toBe("open");
    // Loud enough for an operator to notice a gate that is protecting nothing.
    const warned = find(records, /main-gitlink invariant check could not decide/);
    expect(warned).toHaveLength(1);
    expect(warned[0].level).toBe("warn");
  }, 60_000);

  it("T16. HEALTH ⟹ LANDING holds on every assembly arm — the premise the short-circuit rests on", async () => {
    // A CORRECTNESS dependency, not an optimization detail: the gate returns
    // `holds` without ever probing Ri, so an assembly that stopped producing an
    // Ri descended from baseInnerSha would make it report a safe landing it
    // never measured, and the ordering trap would reopen silently. Nothing else
    // in the suite pins it.
    let innerFeature = "";
    let outerFeature = "";
    const lane = await buildLane({
      root,
      label: "t16",
      async inner(ig, dir) {
        await ig.checkout(["-b", "feature/inner"]);
        writeFileSync(path.join(dir, "feature.txt"), "inner feature\n");
        await ig.add(["feature.txt"]);
        await ig.commit("inner feature");
        innerFeature = (await ig.revparse(["HEAD"])).trim();
        await ig.push(["-u", GIT_REMOTE, "feature/inner"]);
        // Inner main then MOVES ON, so the submitted branch has DIVERGED from
        // it. That is what makes the ancestry assertion below a real question:
        // the submitted tip is NOT a descendant of live inner main, and only
        // the rebase makes Ri one.
        await ig.checkout(GIT_MAIN);
        writeFileSync(path.join(dir, "lib.txt"), "v2\n");
        await ig.add(["lib.txt"]);
        await ig.commit("inner main advances past the branch point");
        await ig.push([GIT_REMOTE, GIT_MAIN]);
      },
      async outer(og, dir) {
        await og.checkoutLocalBranch("feature/outer");
        writeFileSync(path.join(dir, "app.txt"), "outer feature\n");
        await og.add(["app.txt"]);
        await og.commit("outer feature");
        outerFeature = (await og.revparse(["HEAD"])).trim();
        await og.push(["-u", GIT_REMOTE, "feature/outer"]);
        await og.checkout(GIT_MAIN);
      },
      gitlinkTarget: (innerMainSha) => innerMainSha,
    });
    const { logger } = capturingLogger();

    const arms: {
      name: string;
      members: MergeRequestView[];
      syntheticInner: boolean;
      /** The inner tip this arm submitted, when it submitted one. */
      submittedTip: string | null;
    }[] = [
      {
        name: "inner-only (synthetic outer)",
        members: [makeMember({ id: "req-inner", commitSha: innerFeature }), makeSynthetic()],
        syntheticInner: false,
        submittedTip: innerFeature,
      },
      {
        name: "lone-outer (synthetic inner)",
        members: [makeMember({ id: "req-outer", commitSha: outerFeature }), makeSynthetic()],
        syntheticInner: true,
        submittedTip: null,
      },
      {
        name: "two-member",
        members: [
          makeMember({ id: "req-inner", commitSha: innerFeature }),
          makeMember({ id: "req-outer", commitSha: outerFeature }),
        ],
        syntheticInner: false,
        submittedTip: innerFeature,
      },
    ];

    for (const arm of arms) {
      const state = newState(arm.members);
      const integ = await runGroupIntegration(
        { id: `grp-t16-${arm.name}`, members: state.group.members },
        depsFor(lane, state, logger),
      );
      if (integ.kind !== "ready_to_land") {
        throw new Error(
          `${arm.name}: expected ready_to_land, got ${integ.kind}${integ.kind === "rejected" ? `: ${integ.reason}` : ""}`,
        );
      }
      const { baseInnerSha, Ri, innerGitOps } = integ.assembled;
      // Probed in the assembly's OWN inner worktree: Ri is a candidate commit
      // that exists in no other clone until the land pushes it.
      expect(await innerGitOps.isAncestor(baseInnerSha, Ri), arm.name).toBe(true);
      // ...and the fixture makes that a real question rather than an accident:
      // the tip the author SUBMITTED is not a descendant of live inner main, so
      // an assembly that skipped the rebase (or squashed, or cherry-picked)
      // would fail the line above instead of passing it for free.
      if (arm.submittedTip !== null) {
        expect(await innerGitOps.isAncestor(baseInnerSha, arm.submittedTip), arm.name).toBe(false);
      }
      // Equality is exactly the synthetic-inner arm — which is also why the
      // gate reuses the health answer there instead of spawning a second
      // identical merge-base.
      expect(Ri === baseInnerSha, arm.name).toBe(arm.syntheticInner);
      integ.assembled.release();
    }
  }, 90_000);
});
