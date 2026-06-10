/**
 * Full-stack END-TO-END cross-repo + chaos regression net for phase 7.3 (Step 13).
 *
 * The phase's regression net + the §6.4 crash-recovery proof. Boots a REAL PM
 * server in-process (createApp + @hono/node-server serve, file SQLite the TEST
 * PROCESS owns), spawns the BUILT integrator (`node dist/index.js`) as a SEPARATE
 * process with a project configured for cross-repo atomicity (linked_repos:
 * inner rynx + outer app, gitlink vendor/rynx). Two REAL bare remotes
 * (inner.git + outer.git) seeded EXACTLY as group-land.test.ts.
 *
 * Mirrors batch-e2e.test.ts for harness primitives (in-process server, spawned
 * dist integrator, ready-await, liveProcs guard, teardown) and the two-repo
 * fixture from group-land.test.ts / group-recovery.test.ts (inner main lib.txt +
 * feature/inner; outer main top.txt + .gitmodules forward-slashed + seeded
 * 160000 gitlink + feature/outer; fetch.recurseSubmodules=false on outer
 * worktrees). `spawnIntegrator(env)` is factored out for re-spawn (the chaos
 * flows kill + re-spawn).
 *
 * One describe per flow; fileParallelism:false (the harness is process-global —
 * one server/DB/integrator live at a time). Poll-until-terminal (no fixed
 * sleeps for outcomes).
 *
 * Flows:
 *   (a) clean atomic land — both bare mains advance, gitlink @ Ri.
 *   (b) assembled-verify-fail → reject, NEITHER advances, no incident.
 *   (c) orphan → PM-visible → auto-resolve (PM_CHAOS_FAIL_OUTER_PUSH=once).
 *   (d) un-reconcilable orphan → stays open (divergent intervening gitlink bump).
 *   (chaos-1) crash after inner push, before outer push (§6.4) → reclaim →
 *             clean atomic land, NO orphan ever, no half-landed gitlink.
 *   (chaos-2) crash mid-assembly → re-spawn → clean land, zero side effects.
 *   (g) inner-only synthetic group (synthesizeOuter) — gitlink drift between
 *       submit and pickup still lands (drift immunity, the campaign seal) +
 *       a second group submitted against the LIVE built drain lands.
 *
 * GATING: runs iff git is available AND the integrator dist exists. Build with:
 *   pnpm --filter @pm/shared build
 *   pnpm --filter @pm/server build
 *   pnpm --filter @urtela/pm-integrator build
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { simpleGit, type SimpleGit } from "simple-git";
import { serve, type ServerType } from "@hono/node-server";
import { createApp } from "../../server/src/app.js";
import {
  initializeDatabase,
  closeDb,
  projects,
  type AppDatabase,
} from "../../server/src/db/index.js";
import {
  createTestProject,
  createTestAiAgent,
  createTestTask,
} from "../../server/tests/utils.js";

// ─── Gating ───────────────────────────────────────────────────────

function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

// git-lfs availability gate (copied from group-assembly.test.ts) — flow (e)
// requires a real git-lfs to seed + smudge the inner LFS binary.
function hasGitLfs(): boolean {
  try {
    return spawnSync("git", ["lfs", "version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const distPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const distExists = existsSync(distPath);
const RUN = hasGit() && distExists;
const LFS_AVAILABLE = hasGitLfs();

// A fixed, deterministic "binary" (NOT randomBytes — reproducible). Copied from
// group-assembly.test.ts so flow (e)'s real-bytes precondition asserts against
// the SAME ground-truth content the inner LFS seed writes.
const originalBytes = Buffer.from([
  0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0xfc, 0x10, 0x20, 0x30, 0x40, 0x50,
  0x60, 0x70, 0x80,
]);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const GITLINK_PATH = "vendor/rynx";
const GIT_REMOTE = "origin";
const GIT_MAIN = "main";

async function configIdentity(g: SimpleGit): Promise<void> {
  await g.addConfig("user.email", "int@test.local");
  await g.addConfig("user.name", "Integrator Test");
  await g.addConfig("commit.gpgsign", "false");
}

// ─── Module-level live-proc guard (never leak a spawned integrator) ──
const liveProcs = new Set<ChildProcess>();
process.on("exit", () => {
  for (const p of liveProcs) {
    try {
      if (p.pid && p.exitCode === null) p.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
});

// ─── Types ────────────────────────────────────────────────────────

interface MergeRequest {
  id: string;
  status: string;
  landedSha: string | null;
  // Flow (g) — present on the merge-groups GET/201 member payload
  // (routes/merge-groups.ts mergeGroupMemberSchema).
  synthetic: boolean;
  branch: string | null;
  commitSha: string | null;
  rejectReason: string | null;
}

interface MergeGroup {
  id: string;
  state: string;
}

interface MergeGroupDetail extends MergeGroup {
  members: MergeRequest[];
}

interface MergeIncident {
  id: string;
  state: string;
  type: string;
  innerRepo: string;
  outerRepo: string;
  orphanedSha: string;
  groupId: string | null;
  innerRequestId: string | null;
  taskId: string | null;
  resolution: { mode?: string; outerLandedSha?: string } | null;
}

interface Harness {
  tmpRoot: string;
  innerBare: string;
  outerBare: string;
  db: AppDatabase;
  baseUrl: string;
  project: { id: string; slug: string };
  workerToken: string;
  integratorToken: string;
  /** Spawn the built integrator with the given extra env (chaos vars). Resolves
   *  on "Integrator ready" (30s cap) or rejects on early exit. */
  spawnIntegrator: (extraEnv?: Record<string, string>) => Promise<ChildProcess>;
  /** The current spawned integrator process (re-assigned by spawnIntegrator). */
  proc: () => ChildProcess | null;
  submitMember: (
    commitSha: string,
    taskId: string | null,
  ) => Promise<MergeRequest>;
  createGroup: (memberIds: string[]) => Promise<MergeGroup>;
  submitGroup: (
    innerCommit: string,
    outerCommit: string,
    opts?: {
      innerVerify?: string;
      outerVerify?: string;
      innerTask?: string | null;
    },
  ) => Promise<{ group: MergeGroup; inner: MergeRequest; outer: MergeRequest }>;
  /** Flow (g): ONE atomic POST of the inner-only synthesizeOuter form. */
  submitInnerOnlyGroup: (
    innerCommit: string,
    opts?: { verifyCmd?: string; taskId?: string },
  ) => Promise<{ group: MergeGroup; members: MergeRequest[] }>;
  getGroup: (id: string) => Promise<MergeGroup>;
  /** Same GET as getGroup, wider cast — includes the members array. */
  getGroupDetail: (id: string) => Promise<MergeGroupDetail>;
  pollGroup: (id: string, timeoutMs?: number) => Promise<MergeGroup>;
  listOpenIncidents: () => Promise<MergeIncident[]>;
  getIncident: (id: string) => Promise<MergeIncident>;
  innerBareMainSha: () => Promise<string>;
  outerBareMainSha: () => Promise<string>;
  gitlinkOnOuterBareMain: () => Promise<string>;
  outerFileOnMain: (file: string) => boolean;
  innerFileOnMain: (file: string) => boolean;
  teardown: () => Promise<void>;
}

const GROUP_TERMINAL = new Set([
  "landed",
  "rejected",
  "partially_landed",
]);

// ─── Two-repo fixture + harness ────────────────────────────────────

interface FixtureRefs {
  innerMainSha: string;
  innerFeatureSha: string;
  outerFeatureSha: string;
}

async function makeGroupHarness(
  opts: { innerLfs?: boolean; innerPathAsFileUrl?: boolean } = {},
): Promise<{ h: Harness; refs: FixtureRefs }> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-group-e2e-"));
  const innerBare = path.join(tmpRoot, "inner.git");
  const outerBare = path.join(tmpRoot, "outer.git");

  await simpleGit().init(["--bare", "--initial-branch=main", innerBare]);
  await simpleGit().init(["--bare", "--initial-branch=main", outerBare]);

  // ── seed INNER: main lib.txt + feature/inner. ──
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
  if (opts.innerLfs) {
    // Seed an LFS-tracked binary on feature/inner (copied pattern from
    // group-assembly.test.ts). The bare then holds the LFS POINTER in-tree +
    // the LFS object in its lfs store, so a smudge-enabled clone yields the real
    // bytes — exactly what the daemon's inner pool worktree must smudge before
    // the P2 overlay copies the real binary into the outer working tree.
    await ig.raw(["lfs", "install", "--local"]);
    await ig.raw(["lfs", "track", "*.bin"]);
    writeFileSync(path.join(innerSeed, "blob.bin"), originalBytes);
    await ig.add([".gitattributes", "blob.bin"]);
  }
  writeFileSync(path.join(innerSeed, "feature.txt"), "inner feature\n");
  await ig.add(["feature.txt"]);
  await ig.commit("inner feature commit");
  await ig.push(["-u", "origin", "feature/inner"]);
  const innerFeatureSha = (await ig.revparse(["HEAD"])).trim();

  // ── seed OUTER: main top.txt + .gitmodules + 160000 gitlink + feature/outer. ──
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

  await og.checkoutLocalBranch("feature/outer");
  writeFileSync(path.join(outerSeed, "app.txt"), "outer feature\n");
  await og.add(["app.txt"]);
  await og.commit("outer feature commit");
  await og.push(["-u", "origin", "feature/outer"]);
  const outerFeatureSha = (await og.revparse(["HEAD"])).trim();

  // ── In-process PM server (test owns the only DB connection). ──
  const dbPath = path.join(tmpRoot, "pm.db");
  const db = initializeDatabase({ dbPath });
  const app = createApp();
  const server: ServerType = serve({
    fetch: app.fetch,
    port: 0,
    hostname: "127.0.0.1",
  });
  await once(server, "listening");
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // ── Seed identities. ──
  const integratorToken = createTestAiAgent(db, { username: "integrator" }).token;
  const workerToken = createTestAiAgent(db, { username: "worker" }).token;

  // ── Seed project: integrator with linked_repos + gitRepoUrl=outerBare. ──
  const proj = createTestProject(db, {
    settings: {
      integrator: {
        enabled: true,
        verify_command: "exit 0",
        verify_timeout_sec: 30,
        worktree_root: path.join(tmpRoot, "wt"),
        worktree_name: "grp-e2e",
        git_remote: "origin",
        git_main_branch: "main",
        parallelism: 1,
        linked_repos: [
          {
            name: "rynx-inner",
            // Optionally drive P1's mirror-clone branch end-to-end: a remote
            // `file://` URL the integrator must `--mirror`-bind to resolve refs
            // (simple-git can't bind a URL directly). Derivation copied from
            // binding-clone.test.ts. Default = the bare path (byte-identical to
            // every existing flow a-d/chaos call site).
            path: opts.innerPathAsFileUrl
              ? "file:///" + innerBare.split(path.sep).join("/")
              : innerBare,
            role: "inner",
            gitlink_path: GITLINK_PATH,
          },
          { name: "app-outer", path: outerBare, role: "outer" },
        ],
      },
    },
  });
  const project = { id: proj.id, slug: proj.slug };
  db.update(projects)
    .set({ gitRepoUrl: outerBare })
    .where(eq(projects.id, project.id))
    .run();

  // ── Spawnable integrator (factored out for re-spawn). ──
  let currentProc: ChildProcess | null = null;

  async function spawnIntegrator(
    extraEnv: Record<string, string> = {},
  ): Promise<ChildProcess> {
    // Kill any previous live integrator first — only ONE integrator owns the
    // lane at a time (the chaos flows re-spawn, and a leftover would race the
    // lane lock and corrupt the next flow's group).
    if (currentProc && currentProc.exitCode === null) {
      currentProc.kill("SIGTERM");
      await Promise.race([once(currentProc, "exit"), sleep(5000)]);
      if (currentProc.exitCode === null) currentProc.kill("SIGKILL");
      liveProcs.delete(currentProc);
    }
    const proc = spawn(
      "node",
      [
        distPath,
        "--project",
        project.id,
        "--resource",
        "main",
        "--pm-url",
        baseUrl,
        "--poll-interval-sec",
        "1",
        "--log-level",
        "error",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PM_API_TOKEN: integratorToken, ...extraEnv },
      },
    );
    liveProcs.add(proc);
    currentProc = proc;
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

    const ready = new Promise<void>((resolve, reject) => {
      const t = setInterval(() => {
        if (stdout.includes("Integrator ready")) {
          clearInterval(t);
          resolve();
        }
      }, 50);
      proc.once("exit", (code) => {
        clearInterval(t);
        reject(
          new Error(
            `integrator exited early (code ${code}) before ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      });
    });
    await Promise.race([
      ready,
      sleep(30_000).then(() => {
        throw new Error(
          `integrator did not become ready in 30s.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }),
    ]);
    return proc;
  }

  // ── HTTP helpers. ──
  async function submitMember(
    commitSha: string,
    taskId: string | null,
    verifyCmd?: string,
  ): Promise<MergeRequest> {
    const res = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/merge-requests`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          resource: "main",
          commitSha,
          taskId,
          ...(verifyCmd ? { verifyCmd } : {}),
        }),
      },
    );
    expect(res.status).toBe(201);
    return (await res.json()).data as MergeRequest;
  }

  async function createGroupRaw(
    memberIds: string[],
  ): Promise<{ status: number; group?: MergeGroup }> {
    const res = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/merge-groups`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ resource: "main", memberRequestIds: memberIds }),
      },
    );
    if (res.status === 201) {
      return { status: 201, group: (await res.json()).data as MergeGroup };
    }
    return { status: res.status };
  }

  async function createGroup(memberIds: string[]): Promise<MergeGroup> {
    const r = await createGroupRaw(memberIds);
    expect(r.status).toBe(201);
    return r.group as MergeGroup;
  }

  async function submitGroup(
    innerCommit: string,
    outerCommit: string,
    opts: {
      innerVerify?: string;
      outerVerify?: string;
      innerTask?: string | null;
    } = {},
  ): Promise<{ group: MergeGroup; inner: MergeRequest; outer: MergeRequest }> {
    // Submit both members then group them. There is a small window where a
    // freshly-submitted ungrouped member could be picked up by the single-repo
    // drain (the integrator's group lane only protects ALREADY-grouped members
    // via the ungrouped filter). If createGroup 409s (a member was claimed),
    // re-submit fresh members and retry — deterministic because the integrator
    // claims at most one per ~1s poll, so a bounded retry converges.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const inner = await submitMember(
        innerCommit,
        opts.innerTask ?? null,
        opts.innerVerify,
      );
      const outer = await submitMember(outerCommit, null, opts.outerVerify);
      const r = await createGroupRaw([inner.id, outer.id]);
      if (r.status === 201 && r.group) {
        return { group: r.group, inner, outer };
      }
      // A member was claimed in the window — wait a poll cycle and retry with
      // fresh members.
      await sleep(1200);
    }
    throw new Error("submitGroup: could not atomically group members after retries");
  }

  // Flow (g): the inner-only synthesizeOuter submit-and-group form. ONE fetch,
  // NO retry loop — unlike submitGroup above there is no pickup race to retry
  // around: the atomic `members` form mints members born group-bound in one
  // txn, so the single-repo drain can never claim one in a window.
  async function submitInnerOnlyGroup(
    innerCommit: string,
    opts: { verifyCmd?: string; taskId?: string } = {},
  ): Promise<{ group: MergeGroup; members: MergeRequest[] }> {
    const res = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/merge-groups`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          resource: "main",
          synthesizeOuter: true,
          members: [
            {
              commitSha: innerCommit,
              verifyCmd: opts.verifyCmd ?? "exit 0",
              // taskId OMITTED when absent (never null): the route Zod is
              // z.string().min(1).optional() — an explicit null → 400.
              ...(opts.taskId ? { taskId: opts.taskId } : {}),
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(201);
    const detail = (await res.json()).data as MergeGroupDetail;
    return { group: detail, members: detail.members };
  }

  async function getGroup(id: string): Promise<MergeGroup> {
    const res = await fetch(`${baseUrl}/api/v1/merge-groups/${id}`, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()).data as MergeGroup;
  }

  // Same GET endpoint as getGroup — wider cast for flow (g)'s member-level
  // PM assertions (synthetic / landedSha / rejectReason per member).
  async function getGroupDetail(id: string): Promise<MergeGroupDetail> {
    const res = await fetch(`${baseUrl}/api/v1/merge-groups/${id}`, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()).data as MergeGroupDetail;
  }

  async function pollGroup(
    id: string,
    timeoutMs = 60_000,
  ): Promise<MergeGroup> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const g = await getGroup(id);
      if (GROUP_TERMINAL.has(g.state)) return g;
      await sleep(200);
    }
    throw new Error(`group ${id} did not reach a terminal state in time`);
  }

  async function listOpenIncidents(): Promise<MergeIncident[]> {
    const res = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/merge-incidents?state=open&type=orphaned_inner`,
      { headers: { Authorization: `Bearer ${workerToken}` } },
    );
    expect(res.status).toBe(200);
    return (await res.json()).data as MergeIncident[];
  }

  async function getIncident(id: string): Promise<MergeIncident> {
    const res = await fetch(`${baseUrl}/api/v1/merge-incidents/${id}`, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()).data as MergeIncident;
  }

  async function bareMainSha(bare: string): Promise<string> {
    return (await simpleGit(bare).revparse([GIT_MAIN])).trim();
  }

  async function gitlinkOnOuterBareMain(): Promise<string> {
    const out = await simpleGit(outerBare).raw([
      "ls-tree",
      GIT_MAIN,
      GITLINK_PATH,
    ]);
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === "160000" && parts[2]) return parts[2];
    }
    throw new Error("no gitlink on outer bare main");
  }

  function outerFileOnMain(file: string): boolean {
    const out = spawnSync(
      "git",
      ["-C", outerBare, "cat-file", "-e", `refs/heads/main:${file}`],
      { stdio: "ignore" },
    );
    return out.status === 0;
  }

  // Inner-side twin of outerFileOnMain — flow (g) asserts the rebased inner
  // main carries BOTH the feature file and the concurrent drift file.
  function innerFileOnMain(file: string): boolean {
    const out = spawnSync(
      "git",
      ["-C", innerBare, "cat-file", "-e", `refs/heads/main:${file}`],
      { stdio: "ignore" },
    );
    return out.status === 0;
  }

  async function killProc(proc: ChildProcess | null): Promise<void> {
    if (!proc) return;
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await Promise.race([once(proc, "exit"), sleep(5000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
    liveProcs.delete(proc);
  }

  async function teardown(): Promise<void> {
    try {
      await killProc(currentProc);
    } finally {
      await new Promise<void>((r) => {
        if (server) server.close(() => r());
        else r();
      });
      try {
        closeDb();
      } catch {
        /* ignore */
      }
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  const h: Harness = {
    tmpRoot,
    innerBare,
    outerBare,
    db,
    baseUrl,
    project,
    workerToken,
    integratorToken,
    spawnIntegrator,
    proc: () => currentProc,
    submitMember: (commitSha, taskId) => submitMember(commitSha, taskId),
    createGroup,
    submitGroup,
    submitInnerOnlyGroup,
    getGroup,
    getGroupDetail,
    pollGroup,
    listOpenIncidents,
    getIncident,
    innerBareMainSha: () => bareMainSha(innerBare),
    outerBareMainSha: () => bareMainSha(outerBare),
    gitlinkOnOuterBareMain,
    outerFileOnMain,
    innerFileOnMain,
    teardown,
  };
  return { h, refs: { innerMainSha, innerFeatureSha, outerFeatureSha } };
}

// Seed a SECOND inner+outer feature pair (for flow c's reconciling group) onto
// the live bare mains, returning the new feature SHAs.
async function seedSecondFeaturePair(
  h: Harness,
  suffix: string,
): Promise<{ innerFeat: string; outerFeat: string }> {
  // Inner feature off live inner main.
  const innerWk = path.join(h.tmpRoot, `inner-feat-${suffix}`);
  await simpleGit().clone(h.innerBare, innerWk);
  const ig = simpleGit(innerWk);
  await configIdentity(ig);
  await ig.checkout("main");
  await ig.pull("origin", "main");
  await ig.checkoutLocalBranch(`feature/inner-${suffix}`);
  writeFileSync(path.join(innerWk, `inner-${suffix}.txt`), `inner ${suffix}\n`);
  await ig.add([`inner-${suffix}.txt`]);
  await ig.commit(`inner feature ${suffix}`);
  await ig.push(["-u", "origin", `feature/inner-${suffix}`]);
  const innerFeat = (await ig.revparse(["HEAD"])).trim();

  // Outer feature off live outer main.
  const outerWk = path.join(h.tmpRoot, `outer-feat-${suffix}`);
  await simpleGit().clone(h.outerBare, outerWk);
  const og = simpleGit(outerWk);
  await configIdentity(og);
  await og.addConfig("fetch.recurseSubmodules", "false");
  await og.checkout("main");
  await og.pull("origin", "main");
  await og.checkoutLocalBranch(`feature/outer-${suffix}`);
  writeFileSync(path.join(outerWk, `outer-${suffix}.txt`), `outer ${suffix}\n`);
  await og.add([`outer-${suffix}.txt`]);
  await og.commit(`outer feature ${suffix}`);
  await og.push(["-u", "origin", `feature/outer-${suffix}`]);
  const outerFeat = (await og.revparse(["HEAD"])).trim();

  return { innerFeat, outerFeat };
}

// ─── Flow (a): clean atomic land ──────────────────────────────────

describe.skipIf(!RUN)("group E2E (a) — clean atomic land", () => {
  let h: Harness;
  let refs: FixtureRefs;
  beforeAll(async () => {
    ({ h, refs } = await makeGroupHarness());
    await h.spawnIntegrator();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("both bare mains advance, gitlink @ Ri, group + members landed, no incidents", async () => {
    const innerTask = createTestTask(h.db, { projectId: h.project.id });
    const { group } = await h.submitGroup(
      refs.innerFeatureSha,
      refs.outerFeatureSha,
      { innerVerify: "exit 0", outerVerify: "exit 0", innerTask: innerTask.id },
    );

    const final = await h.pollGroup(group.id, 90_000);
    expect(final.state).toBe("landed");

    const Ri = await h.innerBareMainSha();
    const Ro = await h.outerBareMainSha();
    // Inner main advanced past its base; outer main advanced; gitlink → Ri.
    expect(Ri).not.toBe(refs.innerMainSha);
    expect(await h.gitlinkOnOuterBareMain()).toBe(Ri);
    expect(Ro).toBeTruthy();
    expect(h.outerFileOnMain("app.txt")).toBe(true);

    // No open incidents on the clean path.
    expect(await h.listOpenIncidents()).toHaveLength(0);
  }, 90_000);
});

// ─── Flow (b): assembled-verify-fail → reject, NEITHER advances ───

describe.skipIf(!RUN)("group E2E (b) — assembled verify fail → reject", () => {
  let h: Harness;
  let refs: FixtureRefs;
  beforeAll(async () => {
    ({ h, refs } = await makeGroupHarness());
    await h.spawnIntegrator();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("group rejected, inner+outer bare mains unchanged, no incident", async () => {
    const innerBefore = await h.innerBareMainSha();
    const outerBefore = await h.outerBareMainSha();

    // Outer verify FAILS → the assembled AND fails → reject from integrating.
    const { group } = await h.submitGroup(
      refs.innerFeatureSha,
      refs.outerFeatureSha,
      { innerVerify: "exit 0", outerVerify: "exit 1" },
    );

    const final = await h.pollGroup(group.id, 90_000);
    expect(final.state).toBe("rejected");

    // NEITHER advanced (verify gates BEFORE any push).
    expect(await h.innerBareMainSha()).toBe(innerBefore);
    expect(await h.outerBareMainSha()).toBe(outerBefore);
    expect(await h.listOpenIncidents()).toHaveLength(0);
  }, 90_000);
});

// ─── Flow (c): orphan → PM-visible → auto-resolve ─────────────────

describe.skipIf(!RUN)("group E2E (c) — orphan → PM-visible → auto-resolve", () => {
  let h: Harness;
  let refs: FixtureRefs;
  beforeAll(async () => {
    ({ h, refs } = await makeGroupHarness());
    // Spawn with the one-shot outer-push-fail chaos → the first outer push fails
    // → orphan + incident; subsequent pushes (incl. recovery) succeed.
    await h.spawnIntegrator({ PM_CHAOS_FAIL_OUTER_PUSH: "once" });
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("orphan opens incident (PM-visible), inner landed + outer NOT advanced, then a 2nd group auto-resolves it", async () => {
    const preOrphanGitlink = await h.gitlinkOnOuterBareMain();
    const innerTask = createTestTask(h.db, { projectId: h.project.id });

    // 1) First group → orphan (outer push fails once).
    const { group: g1, inner } = await h.submitGroup(
      refs.innerFeatureSha,
      refs.outerFeatureSha,
      { innerVerify: "exit 0", outerVerify: "exit 0", innerTask: innerTask.id },
    );

    // Poll until an open incident appears (the orphan is PM-visible).
    let incidents: MergeIncident[] = [];
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      incidents = await h.listOpenIncidents();
      if (incidents.length > 0) break;
      await sleep(200);
    }
    expect(incidents).toHaveLength(1);
    const incident = incidents[0];

    const Ri = await h.innerBareMainSha();
    expect(incident.type).toBe("orphaned_inner");
    expect(incident.orphanedSha).toBe(Ri);
    expect(incident.innerRepo).toBe("rynx-inner");
    expect(incident.outerRepo).toBe("app-outer");
    expect(incident.groupId).toBe(g1.id);
    expect(incident.innerRequestId).toBe(inner.id);
    expect(incident.taskId).toBe(innerTask.id);

    // Inner DID land; outer NOT advanced (gitlink still at the PRE-orphan SHA).
    expect(Ri).not.toBe(refs.innerMainSha);
    expect(await h.gitlinkOnOuterBareMain()).toBe(preOrphanGitlink);
    const g1Final = await h.getGroup(g1.id);
    expect(g1Final.state).toBe("partially_landed");

    // 2) Submit a SECOND clean group. recoverOrphanedInner runs FIRST under the
    //    lane lock → rolls the gitlink forward to Ri → incident auto_resolved.
    const second = await seedSecondFeaturePair(h, "c2");
    const { group: g2 } = await h.submitGroup(
      second.innerFeat,
      second.outerFeat,
      { innerVerify: "exit 0", outerVerify: "exit 0" },
    );

    // Poll the incident until auto_resolved.
    let resolved: MergeIncident | undefined;
    const deadline2 = Date.now() + 90_000;
    while (Date.now() < deadline2) {
      const inc = await h.getIncident(incident.id);
      if (inc.state === "auto_resolved") {
        resolved = inc;
        break;
      }
      await sleep(200);
    }
    expect(resolved).toBeDefined();
    expect(resolved!.resolution?.mode).toBe("auto_rollforward");

    // The gitlink rolled forward to Ri; no more open incidents.
    expect(await h.gitlinkOnOuterBareMain()).toBe(Ri);
    expect(await h.listOpenIncidents()).toHaveLength(0);

    // The 2nd group itself lands cleanly after recovery.
    const g2Final = await h.pollGroup(g2.id, 90_000);
    expect(g2Final.state).toBe("landed");
  }, 120_000);
});

// ─── Flow (d): un-reconcilable orphan → stays open ────────────────

describe.skipIf(!RUN)("group E2E (d) — un-reconcilable orphan stays open", () => {
  let h: Harness;
  let refs: FixtureRefs;
  beforeAll(async () => {
    ({ h, refs } = await makeGroupHarness());
    await h.spawnIntegrator({ PM_CHAOS_FAIL_OUTER_PUSH: "once" });
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("orphan, then a DIVERGENT gitlink bump → recovery escalates, incident stays open, outer untouched", async () => {
    // 1) Produce an orphan (as flow c).
    const { group: g1 } = await h.submitGroup(
      refs.innerFeatureSha,
      refs.outerFeatureSha,
      { innerVerify: "exit 0", outerVerify: "exit 0" },
    );
    let incidents: MergeIncident[] = [];
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      incidents = await h.listOpenIncidents();
      if (incidents.length > 0) break;
      await sleep(200);
    }
    expect(incidents).toHaveLength(1);
    const incident = incidents[0];
    const Ri = await h.innerBareMainSha();
    expect(incident.orphanedSha).toBe(Ri);

    // De-flake (Step 13): the integrator writes the open incident and the
    // group's partially_landed transition as TWO separate writes — under CPU
    // contention the incident can be visible BEFORE the group transition
    // commits. Poll the group until it reaches partially_landed (bounded ~30s,
    // mirroring flow c's incident-poll idiom) instead of reading once.
    let g1Final = await h.getGroup(g1.id);
    const stateDeadline = Date.now() + 30_000;
    while (g1Final.state !== "partially_landed" && Date.now() < stateDeadline) {
      await sleep(200);
      g1Final = await h.getGroup(g1.id);
    }
    expect(g1Final.state).toBe("partially_landed");

    // 2) Out-of-band: bump the OUTER gitlink to a DIVERGENT inner SHA C (a branch
    //    off the pre-orphan inner base, NOT an ancestor of Ri). This makes the
    //    reconciliation predicate isAncestor(C, Ri) FALSE → escalate.
    const divBranchWk = path.join(h.tmpRoot, "inner-divergent");
    await simpleGit().clone(h.innerBare, divBranchWk);
    const dg = simpleGit(divBranchWk);
    await configIdentity(dg);
    // Branch off the original inner main base (refs.innerMainSha) → divergent C.
    await dg.checkout(refs.innerMainSha);
    await dg.checkoutLocalBranch("divergent");
    writeFileSync(path.join(divBranchWk, "diverge.txt"), "divergent line\n");
    await dg.add(["diverge.txt"]);
    await dg.commit("inner C (divergent off base)");
    await dg.push(["-u", "origin", "divergent"]);
    const innerC = (await dg.revparse(["HEAD"])).trim();
    expect(innerC).not.toBe(Ri);

    // Push a clone-built outer commit bumping the gitlink to C.
    const bumpWk = path.join(h.tmpRoot, "outer-bump");
    await simpleGit().clone(h.outerBare, bumpWk);
    const bg = simpleGit(bumpWk);
    await configIdentity(bg);
    await bg.raw([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${innerC},${GITLINK_PATH}`,
    ]);
    await bg.commit("intervening outer: bump gitlink to divergent C");
    await bg.push(["origin", "main"]);
    expect(await h.gitlinkOnOuterBareMain()).toBe(innerC);
    const outerAfterBump = await h.outerBareMainSha();

    // 3) The open incident ITSELF triggers a recovery-only pass every poll (the
    //    lane lock is taken solely to sweep incidents — no second group needed).
    //    recoverOrphanedInner runs: isAncestor(C, Ri) false → escalate. Incident
    //    STAYS open; outer main is byte-identical (R1 trivially held — no push on
    //    escalate). Bounded window covering several poll cycles.
    const window = Date.now() + 25_000;
    while (Date.now() < window) {
      const inc = await h.getIncident(incident.id);
      expect(inc.state).not.toBe("auto_resolved");
      await sleep(500);
    }
    const finalInc = await h.getIncident(incident.id);
    expect(finalInc.state).toBe("open");
    // Outer bare main BYTE-IDENTICAL across the recovery pass (still at the
    // divergent bump commit; recovery escalated, never pushed).
    expect(await h.outerBareMainSha()).toBe(outerAfterBump);
    expect(await h.gitlinkOnOuterBareMain()).toBe(innerC);
  }, 120_000);
});

// ─── Chaos (deterministic env-gated kills, re-spawn) ──────────────

describe.skipIf(!RUN)("group E2E chaos", () => {
  let h: Harness;
  let refs: FixtureRefs;
  beforeAll(async () => {
    ({ h, refs } = await makeGroupHarness());
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  // ── (chaos-1) crash after inner push, before outer push (§6.4, load-bearing) ──
  it("chaos-1: crash after inner push → reclaim stranded group → clean atomic land, NO orphan, no half-landed gitlink", async () => {
    const preGitlink = await h.gitlinkOnOuterBareMain();

    // Spawn with the after_inner_push crash point. The integrator picks up the
    // group, pushes inner, then process.exit(137) BEFORE the outer push.
    const proc1 = await h.spawnIntegrator({
      PM_CHAOS_CRASH_AT: "after_inner_push",
    });

    const innerTask = createTestTask(h.db, { projectId: h.project.id });
    const { group } = await h.submitGroup(
      refs.innerFeatureSha,
      refs.outerFeatureSha,
      { innerVerify: "exit 0", outerVerify: "exit 0", innerTask: innerTask.id },
    );

    // Await the crash (the chaos hook exits the process after PUSH 1).
    await once(proc1, "exit");
    liveProcs.delete(proc1);

    // State now: inner bare main at Ri, NO incident, group integrating.
    const Ri = await h.innerBareMainSha();
    expect(Ri).not.toBe(refs.innerMainSha); // inner DID push
    expect(await h.listOpenIncidents()).toHaveLength(0); // no incident
    const strandedGroup = await h.getGroup(group.id);
    expect(strandedGroup.state).toBe("integrating");
    // CRITICAL: outer gitlink NEVER half-landed — still at the pre-orphan SHA.
    expect(await h.gitlinkOnOuterBareMain()).toBe(preGitlink);

    // Re-spawn WITHOUT the chaos var → startup reclaimStrandedGroups resets the
    // group → re-integration: inner re-push is a ff no-op, outer push completes.
    await h.spawnIntegrator();

    const final = await h.pollGroup(group.id, 90_000);
    expect(final.state).toBe("landed");

    // The atom completed: gitlink → Ri (the inner SHA from the first, crashed
    // push — fast-forward no-op re-push lands the SAME Ri), both mains consistent.
    expect(await h.gitlinkOnOuterBareMain()).toBe(Ri);
    expect(await h.innerBareMainSha()).toBe(Ri);
    // NO orphan incident EVER (the atom completed on re-integration).
    expect(await h.listOpenIncidents()).toHaveLength(0);
    // The outer gitlink only ever held the pre-orphan SHA or Ri — never a third
    // value (no half-landed gitlink).
    const gitlinkNow = await h.gitlinkOnOuterBareMain();
    expect([preGitlink, Ri]).toContain(gitlinkNow);
  }, 120_000);

  // ── (chaos-2) crash mid-assembly ──
  it("chaos-2: crash mid-assembly → re-spawn → clean land, zero side effects from the crashed pass", async () => {
    const innerBefore = await h.innerBareMainSha();
    const outerBefore = await h.outerBareMainSha();

    // Spawn with mid_assembly crash → after assembleGroup ok, before
    // markGroupIntegrating. Group still forming, nothing pushed.
    const proc1 = await h.spawnIntegrator({ PM_CHAOS_CRASH_AT: "mid_assembly" });

    const second = await seedSecondFeaturePair(h, "chaos2");
    const { group } = await h.submitGroup(second.innerFeat, second.outerFeat, {
      innerVerify: "exit 0",
      outerVerify: "exit 0",
    });

    await once(proc1, "exit");
    liveProcs.delete(proc1);

    // Group still forming; nothing pushed (zero side effects).
    const stranded = await h.getGroup(group.id);
    expect(stranded.state).toBe("forming");
    expect(await h.innerBareMainSha()).toBe(innerBefore);
    expect(await h.outerBareMainSha()).toBe(outerBefore);

    // Re-spawn → the still-forming group integrates from scratch → clean land.
    await h.spawnIntegrator();
    const final = await h.pollGroup(group.id, 90_000);
    expect(final.state).toBe("landed");

    const Ri = await h.innerBareMainSha();
    expect(Ri).not.toBe(innerBefore);
    expect(await h.gitlinkOnOuterBareMain()).toBe(Ri);
    expect(await h.outerBareMainSha()).not.toBe(outerBefore);
    expect(await h.listOpenIncidents()).toHaveLength(0);
  }, 120_000);
});

// ─── Flow (e): remote-URL binding + inner-LFS materialize compose → land ──
//
// Proves the P1 (remote/`file://` binding `--mirror` clone) + P2 (LFS-aware
// materialize: real binaries overlaid into the outer working tree for verify)
// fixes COMPOSE through the REAL spawned daemon and produce a clean atomic land.
// The bug shape both fixes target is a THROW during assemble/materialize (a
// URL `path` simple-git can't bind; an outer-LFS smudge 404 on the inner's
// objects) — so "landed" here is the composition signal.
//
// Byte-level overlay CORRECTNESS (real bytes, not a pointer) is unit-proven in
// group-assembly.test.ts (P2) and now structurally GUARDED fail-loud in git-ops
// (P4 step 1: an unsmudged inner pointer throws rather than silently shipping a
// pointer). This flow proves composition-through-the-daemon + land — with a
// REAL-BYTES PRECONDITION (below) so "landed" is a meaningful signal and not a
// pointer false-green.
describe.skipIf(!RUN || !LFS_AVAILABLE)(
  "group E2E (e) — remote-URL binding + inner-LFS materialize compose → clean atomic land",
  () => {
    let h: Harness;
    let refs: FixtureRefs;
    beforeAll(async () => {
      ({ h, refs } = await makeGroupHarness({
        innerLfs: true,
        innerPathAsFileUrl: true,
      }));
      await h.spawnIntegrator();
    }, 90_000);
    afterAll(async () => {
      if (h) await h.teardown();
    });

    it("file:// inner binding + LFS-inner group composes P1+P2 and lands atomically", async () => {
      // ── REQUIRED PRECONDITION (the anti-false-green fix) ──
      // Clone the EXACT inner source the daemon will bind (the `file://` URL —
      // same string the linked_repos[].path carries) into a temp dir with LFS
      // smudge ACTIVE, then ASSERT the cloned `blob.bin` on feature/inner equals
      // originalBytes (REAL bytes, not a pointer). This proves the daemon's clone
      // source genuinely yields the real binary — so a later "landed" means the
      // overlay shipped real bytes, not that a pointer slipped through. If this
      // precondition cannot smudge (a misconfigured host), it FAILS LOUD here
      // rather than letting the test pass on garbage.
      const innerFileUrl =
        "file:///" + h.innerBare.split(path.sep).join("/");
      const preClone = path.join(h.tmpRoot, "precond-inner-clone");
      const pc = spawnSync(
        "git",
        ["clone", "-b", "feature/inner", innerFileUrl, preClone],
        { stdio: "pipe", encoding: "utf8" },
      );
      expect(pc.status, `precondition clone failed: ${pc.stderr}`).toBe(0);
      // Force-smudge in case the host has GIT_LFS_SKIP_SMUDGE / a partial clone.
      const pull = spawnSync("git", ["-C", preClone, "lfs", "pull"], {
        stdio: "pipe",
        encoding: "utf8",
      });
      expect(pull.status, `precondition lfs pull failed: ${pull.stderr}`).toBe(0);
      const preBlob = path.join(preClone, "blob.bin");
      expect(existsSync(preBlob)).toBe(true);
      // REAL bytes — byte-for-byte. (If this were a pointer the daemon's clone
      // source could only ever yield a pointer too, and "landed" would be a
      // false-green; this assertion forbids that.)
      expect(
        Buffer.compare(readFileSync(preBlob), originalBytes),
        "precondition: inner clone source did not yield the REAL binary (smudge misconfigured) — a 'landed' would be a pointer false-green",
      ).toBe(0);
      // It is NOT a pointer.
      expect(
        readFileSync(preBlob, "utf8").startsWith("version https://git-lfs"),
      ).toBe(false);

      // ── Submit the LFS-inner group (members born group-bound), poll to land ──
      const innerTask = createTestTask(h.db, { projectId: h.project.id });
      const { group } = await h.submitGroup(
        refs.innerFeatureSha,
        refs.outerFeatureSha,
        {
          innerVerify: "exit 0",
          outerVerify: "exit 0",
          innerTask: innerTask.id,
        },
      );

      const final = await h.pollGroup(group.id, 90_000);
      // The LFS-inner group bound via `file://` composed P1 (mirror-bind ref
      // resolution) + P2 (LFS-aware materialize) through the real daemon and
      // landed — the bug shape was a THROW during assemble/materialize.
      expect(final.state).toBe("landed");

      // Atomic land assertions (mirror flow a): gitlink on outer bare main === Ri,
      // inner bare main advanced to Ri, no open incidents.
      const Ri = await h.innerBareMainSha();
      expect(Ri).not.toBe(refs.innerMainSha);
      expect(await h.gitlinkOnOuterBareMain()).toBe(Ri);
      expect(h.outerFileOnMain("app.txt")).toBe(true);
      expect(await h.listOpenIncidents()).toHaveLength(0);
    }, 90_000);
  },
);

// ─── Flow (f): LFS-bearing orphan → auto-rollforward recovery ─────────
//
// Closes TODO(xrepo-lfs): the orphan roll-forward recovery is now LFS-aware.
// Composes flow (c)'s chaos-orphan structure + the P4 `innerLfs` harness option
// + flow (e)'s real-bytes precondition.
//
// THE DISCRIMINATING SIGNAL is `auto_resolved` ITSELF — NOT a verify trick (the
// harness default verify_command "exit 0" stays). With an LFS-bearing orphan,
// the legacy recovery materialize (no inner worktree → no overlay) would throw
// the outer-smudge 404 → escalate; only the working LFS overlay (checkout O in
// the inner worktree → real binaries copied) yields auto_resolved. The P4
// fail-loud pointer guard guarantees materialize THROWS rather than shipping a
// pointer, so auto_resolved ⟹ real bytes were shipped. The real-bytes
// precondition (below) guards against a false-green where the inner source
// could only ever yield a pointer.
describe.skipIf(!RUN || !LFS_AVAILABLE)(
  "group E2E (f) — LFS orphan auto-rolls-forward with real binaries",
  () => {
    let h: Harness;
    let refs: FixtureRefs;
    beforeAll(async () => {
      // innerLfs:true seeds a real LFS binary on inner; default
      // innerPathAsFileUrl:false (flows c/d bind the bare path; the LFS object is
      // in the inner bare's lfs store regardless of how the path is bound).
      ({ h, refs } = await makeGroupHarness({ innerLfs: true }));
      // One-shot outer-push-fail chaos → the first outer push fails → orphan +
      // incident; subsequent pushes (incl. recovery) succeed.
      await h.spawnIntegrator({ PM_CHAOS_FAIL_OUTER_PUSH: "once" });
    }, 90_000);
    afterAll(async () => {
      if (h) await h.teardown();
    });

    it("an LFS-bearing orphan auto-rolls-forward (auto_resolved ⟹ real bytes overlaid)", async () => {
      // ── REQUIRED PRECONDITION (anti-false-green; copies flow (e)) ──
      // Clone the inner source at feature/inner with LFS smudge ACTIVE, assert
      // the cloned blob.bin byte-equals originalBytes (and is NOT a pointer) —
      // proves the orphan's LFS source genuinely yields real bytes, so a later
      // auto_resolved means the overlay shipped real bytes, not a pointer.
      const innerFileUrl = "file:///" + h.innerBare.split(path.sep).join("/");
      const preClone = path.join(h.tmpRoot, "precond-inner-clone-f");
      const pc = spawnSync(
        "git",
        ["clone", "-b", "feature/inner", innerFileUrl, preClone],
        { stdio: "pipe", encoding: "utf8" },
      );
      expect(pc.status, `precondition clone failed: ${pc.stderr}`).toBe(0);
      const pull = spawnSync("git", ["-C", preClone, "lfs", "pull"], {
        stdio: "pipe",
        encoding: "utf8",
      });
      expect(pull.status, `precondition lfs pull failed: ${pull.stderr}`).toBe(0);
      const preBlob = path.join(preClone, "blob.bin");
      expect(existsSync(preBlob)).toBe(true);
      expect(
        Buffer.compare(readFileSync(preBlob), originalBytes),
        "precondition: inner orphan source did not yield the REAL binary (smudge misconfigured) — an 'auto_resolved' would be a pointer false-green",
      ).toBe(0);
      expect(
        readFileSync(preBlob, "utf8").startsWith("version https://git-lfs"),
      ).toBe(false);

      // ── 1) Produce the orphan (mirror flow (c)) ──
      const preOrphanGitlink = await h.gitlinkOnOuterBareMain();
      const innerTask = createTestTask(h.db, { projectId: h.project.id });
      const { group: g1 } = await h.submitGroup(
        refs.innerFeatureSha,
        refs.outerFeatureSha,
        { innerVerify: "exit 0", outerVerify: "exit 0", innerTask: innerTask.id },
      );

      // Poll until one open orphaned_inner incident appears.
      let incidents: MergeIncident[] = [];
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        incidents = await h.listOpenIncidents();
        if (incidents.length > 0) break;
        await sleep(200);
      }
      expect(incidents).toHaveLength(1);
      const incident = incidents[0];

      const Ri = await h.innerBareMainSha();
      expect(incident.type).toBe("orphaned_inner");
      expect(incident.orphanedSha).toBe(Ri);
      // Inner DID land; outer NOT advanced (gitlink still at the PRE-orphan SHA).
      expect(Ri).not.toBe(refs.innerMainSha);
      expect(await h.gitlinkOnOuterBareMain()).toBe(preOrphanGitlink);
      const g1Final = await h.getGroup(g1.id);
      expect(g1Final.state).toBe("partially_landed");

      // ── 2) Trigger recovery: submit a 2nd clean group (mirror flow (c)) ──
      // recoverOrphanedInner runs FIRST under the lane lock → the LFS-aware
      // roll-forward (checkout O in the inner worktree → real binaries overlaid)
      // rolls the gitlink forward to Ri → incident auto_resolved.
      const second = await seedSecondFeaturePair(h, "f2");
      await h.submitGroup(second.innerFeat, second.outerFeat, {
        innerVerify: "exit 0",
        outerVerify: "exit 0",
      });

      // Poll the incident until auto_resolved.
      let resolved: MergeIncident | undefined;
      const deadline2 = Date.now() + 90_000;
      while (Date.now() < deadline2) {
        const inc = await h.getIncident(incident.id);
        if (inc.state === "auto_resolved") {
          resolved = inc;
          break;
        }
        await sleep(200);
      }
      // auto_resolved is THE load-bearing proof the LFS overlay ran: with
      // innerLfs the legacy materialize would have thrown the outer-smudge 404 →
      // escalate (incident stays open); only the working overlay reaches here.
      expect(resolved).toBeDefined();
      expect(resolved!.resolution?.mode).toBe("auto_rollforward");

      // ── 3) Durable outer BARE state (not the ephemeral worktree) ──
      // The gitlink rolled forward to Ri on outer bare main; no open incidents.
      expect(await h.gitlinkOnOuterBareMain()).toBe(Ri);
      expect(await h.listOpenIncidents()).toHaveLength(0);
    }, 120_000);
  },
);

// ─── Flow (g): inner-only synthetic group — drift-immune land ─────────
//
// The CAMPAIGN SEAL for inner-only groups. P1 pinned the wire form
// (synthesizeOuter + synthetic member birth), P2 the MCP surface, P3 the
// binding/assembly tier — this flow proves the whole arc through the REAL
// built integrator: an inner-only group whose OUTER gitlink drifted between
// submit and pickup still lands, because the synthesized outer bump is built
// against LIVE outer main at integration time (there is no stale
// worker-authored outer commit to conflict — the exact failure mode of the
// legacy two-member form under drift).
describe.skipIf(!RUN)(
  "group E2E (g) — inner-only synthetic group: drift-immune land + live-drain submit",
  () => {
    let h: Harness;
    let refs: FixtureRefs;
    beforeAll(async () => {
      // Deliberately NO spawnIntegrator here: it 1's drift determinism depends
      // on the submit → drift → spawn ordering (the chaos describes are the
      // deferred-spawn precedent). it 1 spawns AFTER drifting both remotes;
      // it 2 then runs against the already-live drain.
      ({ h, refs } = await makeGroupHarness());
    }, 90_000);
    afterAll(async () => {
      if (h) await h.teardown();
    });

    it("conflict immunity (campaign seal): gitlink drift between submit and pickup → inner-only group still lands", async () => {
      const innerTask = createTestTask(h.db, { projectId: h.project.id });
      const { group, members } = await h.submitInnerOnlyGroup(
        refs.innerFeatureSha,
        { taskId: innerTask.id },
      );

      // ── Birth shape: forming group, EXACTLY ONE synthetic member with no
      //    refs to land, one real member carrying the inner commit. ──
      expect(group.state).toBe("forming");
      expect(members).toHaveLength(2);
      const synthAtBirth = members.filter((m) => m.synthetic);
      expect(synthAtBirth).toHaveLength(1);
      expect(synthAtBirth[0].branch).toBeNull();
      expect(synthAtBirth[0].commitSha).toBeNull();
      expect(synthAtBirth[0].status).toBe("queued");
      const realAtBirth = members.find((m) => !m.synthetic);
      expect(realAtBirth).toBeDefined();
      expect(realAtBirth!.commitSha).toBe(refs.innerFeatureSha);

      // ── Drift BOTH remotes between submit and pickup (real remotes;
      //    mirrors flow (d)'s clone-built outer gitlink bump). ──
      // inner: a concurrent change lands on inner main.
      const innerDriftWk = path.join(h.tmpRoot, "inner-drift-g");
      await simpleGit().clone(h.innerBare, innerDriftWk);
      const ig = simpleGit(innerDriftWk);
      await configIdentity(ig);
      await ig.checkout("main");
      writeFileSync(path.join(innerDriftWk, "other.txt"), "concurrent\n");
      await ig.add(["other.txt"]);
      await ig.commit("concurrent inner change");
      await ig.push(["origin", "main"]);
      const innerSecondSha = (await ig.revparse(["HEAD"])).trim();

      // outer: main's gitlink is bumped to the concurrent inner SHA — the
      // exact drift a stale worker-authored outer commit would conflict on.
      const outerDriftWk = path.join(h.tmpRoot, "outer-drift-g");
      await simpleGit().clone(h.outerBare, outerDriftWk);
      const og = simpleGit(outerDriftWk);
      await configIdentity(og);
      await og.raw([
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${innerSecondSha},${GITLINK_PATH}`,
      ]);
      await og.commit("concurrent outer: bump gitlink to the drifted inner");
      await og.push(["origin", "main"]);
      const advancedOuterMain = await h.outerBareMainSha();
      expect(await h.gitlinkOnOuterBareMain()).toBe(innerSecondSha);

      // NOW spawn — the integrator's first sight of the group is post-drift.
      await h.spawnIntegrator();

      const final = await h.pollGroup(group.id, 90_000);
      expect(final.state).toBe("landed");

      // ── Git: inner rebased ONTO the drift (a NEW Ri carrying BOTH lines);
      //    outer = the drifted main + exactly ONE synthesized bump to Ri. ──
      const Ri = await h.innerBareMainSha();
      expect(Ri).not.toBe(refs.innerFeatureSha);
      expect(Ri).not.toBe(innerSecondSha);
      const innerAnc = spawnSync(
        "git",
        ["-C", h.innerBare, "merge-base", "--is-ancestor", innerSecondSha, Ri],
        { stdio: "ignore" },
      );
      expect(innerAnc.status).toBe(0);
      expect(h.innerFileOnMain("feature.txt")).toBe(true);
      expect(h.innerFileOnMain("other.txt")).toBe(true);
      expect(await h.gitlinkOnOuterBareMain()).toBe(Ri);
      const outerAnc = spawnSync(
        "git",
        [
          "-C",
          h.outerBare,
          "merge-base",
          "--is-ancestor",
          advancedOuterMain,
          GIT_MAIN,
        ],
        { stdio: "ignore" },
      );
      expect(outerAnc.status).toBe(0);
      const bumpCount = (
        await simpleGit(h.outerBare).raw([
          "rev-list",
          "--count",
          `${advancedOuterMain}..${GIT_MAIN}`,
        ])
      ).trim();
      expect(bumpCount).toBe("1");

      // ── PM: both members landed; real landedSha = Ri; the SYNTHETIC
      //    member's landedSha = the bump commit (current outer main). ──
      const detail = await h.getGroupDetail(group.id);
      expect(detail.members).toHaveLength(2);
      for (const m of detail.members) {
        expect(m.status).toBe("landed");
        expect(m.rejectReason).toBeNull();
      }
      const realFinal = detail.members.find((m) => !m.synthetic)!;
      const synthFinal = detail.members.find((m) => m.synthetic)!;
      expect(realFinal.landedSha).toBe(Ri);
      expect(synthFinal.landedSha).toBe(await h.outerBareMainSha());
      expect(await h.listOpenIncidents()).toHaveLength(0);
    }, 120_000);

    it("second inner-only group submitted while the built integrator is live → born group-bound, lands", async () => {
      // Fresh inner feature off LIVE inner main (post-it-1 Ri). Inline seed —
      // seedSecondFeaturePair stays untouched (it also seeds an outer feature
      // this flow must NOT have: there is no worker-authored outer change).
      const wk = path.join(h.tmpRoot, "inner-feat-g2");
      await simpleGit().clone(h.innerBare, wk);
      const ig = simpleGit(wk);
      await configIdentity(ig);
      await ig.checkout("main");
      await ig.pull("origin", "main");
      await ig.checkoutLocalBranch("feature/inner-g2");
      writeFileSync(path.join(wk, "inner-g2.txt"), "inner g2\n");
      await ig.add(["inner-g2.txt"]);
      await ig.commit("inner feature g2");
      await ig.push(["-u", "origin", "feature/inner-g2"]);
      const innerFeatG2 = (await ig.revparse(["HEAD"])).trim();

      // The point under test: a SINGLE atomic POST against the LIVE polling
      // drain — members born group-bound in one txn, so no pickup race and
      // no retry loop (contrast submitGroup's bounded-retry idiom).
      const { group } = await h.submitInnerOnlyGroup(innerFeatG2);
      const final = await h.pollGroup(group.id, 90_000);
      expect(final.state).toBe("landed");

      const Ri = await h.innerBareMainSha();
      expect(await h.gitlinkOnOuterBareMain()).toBe(Ri);
      const detail = await h.getGroupDetail(group.id);
      const synthFinal = detail.members.find((m) => m.synthetic)!;
      expect(synthFinal.landedSha).toBe(await h.outerBareMainSha());
      expect(await h.listOpenIncidents()).toHaveLength(0);
    }, 120_000);
  },
);
