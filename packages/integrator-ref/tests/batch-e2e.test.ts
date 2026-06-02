/**
 * Full-stack END-TO-END batching regression net for phase 7.2 (Step 10).
 *
 * This is the phase's regression net. It boots a REAL PM server in-process
 * (via @hono/node-server's `serve`) backed by a file-based SQLite database the
 * TEST PROCESS owns, then spawns the BUILT integrator (`node dist/index.js`) as
 * a SEPARATE process driving `runBatchLoop` at a project-configured parallelism.
 * A real temp bare git remote with DISJOINT-file feature branches provides the
 * merge target.
 *
 * It mirrors `tests/integration.test.ts` VERBATIM for its harness primitives
 * (git fixture, in-process server, integrator spawn + ready-await, the
 * submit/getRequest/pollTerminal/mainSha helpers, the proc guard, teardown) and
 * differs ONLY in:
 *   - parallelism is supplied per-flow via `makeHarness(N)` →
 *     `settings.integrator.parallelism = N` (config.ts reads
 *     `project.settings.integrator.parallelism`; there is NO env var for it).
 *   - one `describe` per flow, each with its own beforeAll(makeHarness)/afterAll,
 *     so exactly one server/DB/integrator is live at a time (closeDb is
 *     process-global; vitest fileParallelism:false keeps describes sequential).
 *
 * Four flows prove the REAL batching behavior (not just "all landed"):
 *   (a) 3 clean @parallelism:3 — all land, verify windows OVERLAP, ordered land,
 *       main +3 commits, all three files present.
 *   (b) suffix invalidation @parallelism:3 — req0 lands, req1 (delayed-fail)
 *       rejects + posts a merge_rejection comment, req2 INVALIDATED then re-admitted
 *       and lands. Main has clean.txt + clean3.txt but NOT clean2.txt (the suffix
 *       was invalidated EXACTLY; predecessors still land). req2's corrected base
 *       anchors to req0's landedSha (exact) and shows ≥2 attempts (structural).
 *   (c) backpressure @parallelism:3, 5 branches — all land; peak concurrent
 *       `integrating` is HARD-capped at 3 (pool.acquire caps at parallelism);
 *       saturation evidence (≥2) is SOFT.
 *   (d) parallelism:1 == the 7.1 serial oracle — land / reject / FIFO, plus the
 *       single-attempt invariant (batch-of-one never double-attempts).
 *
 * GATING: runs iff git is available AND the integrator dist exists. Default-on,
 * NO opt-in env var. Build with:
 *   pnpm --filter @pm/shared build
 *   pnpm --filter @pm/server build
 *   pnpm --filter @apodus/pm-integrator build
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { eq, and } from "drizzle-orm";
import { simpleGit } from "simple-git";
import { serve, type ServerType } from "@hono/node-server";
import { createApp } from "../../server/src/app.js";
import {
  initializeDatabase,
  closeDb,
  projects,
  gitRefs,
  comments,
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

const distPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const distExists = existsSync(distPath);
const RUN = hasGit() && distExists;

// ─── Helpers ──────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const isWin = process.platform === "win32";

// Per-request verify one-liner that writes a `.start` marker, sleeps, then
// writes a `.end` marker. runVerify spawns shell:true, so the compound one-liner
// runs as a single shell command. win32 uses cmd.exe idioms (never a bare
// `sleep`); posix uses sh.
//
// CPU-contention de-flake (Step 13): widened the sleep to ~1.5-2s (win32 ping
// -n 4 ≈ 3s of pings → ~1.5-2s effective wait; posix sleep 1.5) so the verify
// windows still overlap under full-suite CPU contention (the flow-a overlap
// assertion flaked in Step 12 under load, passed isolated).
function markerVerify(markerDir: string, name: string): string {
  if (isWin) {
    const start = path.join(markerDir, `${name}.start`);
    const end = path.join(markerDir, `${name}.end`);
    return `echo x > "${start}" & ping -n 4 127.0.0.1 > nul & echo x > "${end}"`;
  }
  const start = path.join(markerDir, `${name}.start`);
  const end = path.join(markerDir, `${name}.end`);
  return `date > '${start}'; sleep 1.5; date > '${end}'`;
}

// A ~600ms sleep verify (no markers) for the backpressure flow.
const SLEEP_600 = isWin ? "ping -n 2 127.0.0.1 > nul" : "sleep 0.6";

// A verify that SLEEPS then FAILS (exit non-zero). The delay guarantees the
// successor speculates on this member BEFORE it fails — so the suffix truly
// chains onto it and must be invalidated when it fails.
const DELAY_FAIL = isWin
  ? "ping -n 3 127.0.0.1 > nul & exit 1"
  : "sleep 2; exit 1";

// ─── Module-level live-proc guard ─────────────────────────────────
// Belt-and-suspenders: never leak a spawned integrator even if an afterAll is
// skipped (e.g. a beforeAll throw). A Set so multiple sequential harnesses are
// all covered by the single exit hook.
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

// ─── Harness ──────────────────────────────────────────────────────

interface MergeRequest {
  id: string;
  status: string;
  landedSha: string | null;
  rejectCategory: string | null;
  enqueuedAt: string;
  pickedUpAt: string | null;
}

interface MergeAttempt {
  id: string;
  attemptNumber: number;
  baseSha: string;
  status: string;
}

interface Harness {
  tmpRoot: string;
  bareRepo: string;
  authorClone: string;
  markerDir: string;
  db: AppDatabase;
  baseUrl: string;
  project: { id: string; slug: string };
  workerToken: string;
  submit: (
    token: string,
    body: Record<string, unknown>,
  ) => Promise<MergeRequest>;
  getRequest: (id: string) => Promise<MergeRequest>;
  getDetail: (
    id: string,
  ) => Promise<MergeRequest & { attempts: MergeAttempt[] }>;
  pollTerminal: (id: string, timeoutMs?: number) => Promise<MergeRequest>;
  mainSha: () => Promise<string>;
  mainCommitCount: () => number;
  fileOnMain: (file: string) => boolean;
  listIntegrating: () => Promise<number>;
  teardown: () => Promise<void>;
}

const TERMINAL = new Set(["landed", "rejected", "abandoned"]);

async function makeHarness(parallelism: number): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-batch-e2e-"));
  const bareRepo = path.join(tmpRoot, "bare.git");
  const authorClone = path.join(tmpRoot, "author");
  // Absolute marker dir for the per-request marker-writing verify commands.
  const markerDir = path.join(tmpRoot, "markers");
  mkdirSync(markerDir, { recursive: true });

  // ── Git fixture: bare remote + author clone with DISJOINT feature branches. ──
  await simpleGit().init(["--bare", "--initial-branch=main", bareRepo]);
  await simpleGit().clone(bareRepo, authorClone);
  const g = simpleGit(authorClone);
  await g.addConfig("user.email", "int@test.local");
  await g.addConfig("user.name", "Integrator Test");
  await g.addConfig("commit.gpgsign", "false");

  // main / base.txt
  writeFileSync(path.join(authorClone, "base.txt"), "base\n");
  await g.add(["base.txt"]);
  await g.commit("initial");
  await g.branch(["-M", "main"]);
  await g.push(["-u", "origin", "main"]);

  // Five DISJOINT clean branches (each touches a distinct file). clean4/clean5
  // are not in the 7.1 fixture — added here for the 5-branch backpressure flow.
  const branches: Array<{ name: string; file: string }> = [
    { name: "feature/clean", file: "clean.txt" },
    { name: "feature/clean2", file: "clean2.txt" },
    { name: "feature/clean3", file: "clean3.txt" },
    { name: "feature/clean4", file: "clean4.txt" },
    { name: "feature/clean5", file: "clean5.txt" },
  ];
  for (const b of branches) {
    await g.checkout("main");
    await g.checkoutLocalBranch(b.name);
    writeFileSync(path.join(authorClone, b.file), `${b.name}\n`);
    await g.add([b.file]);
    await g.commit(`add ${b.file}`);
    await g.push(["-u", "origin", b.name]);
  }
  await g.checkout("main");

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
  const integratorToken = createTestAiAgent(db, {
    username: "integrator",
  }).token;
  const workerToken = createTestAiAgent(db, { username: "worker" }).token;

  // ── Seed project with integrator settings (parallelism = N) + repo URL. ──
  const proj = createTestProject(db, {
    settings: {
      integrator: {
        enabled: true,
        verify_command: "exit 0",
        verify_timeout_sec: 30,
        worktree_root: path.join(tmpRoot, "wt"),
        worktree_name: "e2e-int",
        git_remote: "origin",
        git_main_branch: "main",
        parallelism,
      },
    },
  });
  const project = { id: proj.id, slug: proj.slug };
  db.update(projects)
    .set({ gitRepoUrl: bareRepo })
    .where(eq(projects.id, project.id))
    .run();

  // ── Spawn the built integrator (separate process, HTTP only). ──
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
      env: { ...process.env, PM_API_TOKEN: integratorToken },
    },
  );
  liveProcs.add(proc);
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
  proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

  // Await the "Integrator ready" line (or a child crash).
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

  // ── HTTP + git helpers ──────────────────────────────────────────

  async function submit(
    token: string,
    body: Record<string, unknown>,
  ): Promise<MergeRequest> {
    const res = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/merge-requests`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    expect(res.status).toBe(201);
    return (await res.json()).data as MergeRequest;
  }

  async function getRequest(id: string): Promise<MergeRequest> {
    const res = await fetch(`${baseUrl}/api/v1/merge-requests/${id}`, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()).data as MergeRequest;
  }

  async function getDetail(
    id: string,
  ): Promise<MergeRequest & { attempts: MergeAttempt[] }> {
    const res = await fetch(`${baseUrl}/api/v1/merge-requests/${id}`, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()).data as MergeRequest & {
      attempts: MergeAttempt[];
    };
  }

  async function pollTerminal(
    id: string,
    timeoutMs = 25_000,
  ): Promise<MergeRequest> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await getRequest(id);
      if (TERMINAL.has(r.status)) return r;
      await sleep(150);
    }
    throw new Error(`request ${id} did not reach a terminal state in time`);
  }

  async function mainSha(): Promise<string> {
    return (await simpleGit(bareRepo).revparse(["refs/heads/main"])).trim();
  }

  function mainCommitCount(): number {
    const out = spawnSync(
      "git",
      ["-C", bareRepo, "rev-list", "--count", "main"],
      { encoding: "utf8" },
    );
    return parseInt(out.stdout.trim(), 10);
  }

  function fileOnMain(file: string): boolean {
    const out = spawnSync(
      "git",
      ["-C", bareRepo, "cat-file", "-e", `refs/heads/main:${file}`],
      { stdio: "ignore" },
    );
    return out.status === 0;
  }

  async function listIntegrating(): Promise<number> {
    const res = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/merge-requests?status=integrating&resource=main`,
      { headers: { Authorization: `Bearer ${workerToken}` } },
    );
    expect(res.status).toBe(200);
    return ((await res.json()).data as unknown[]).length;
  }

  async function teardown(): Promise<void> {
    try {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await Promise.race([once(proc, "exit"), sleep(5000)]);
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    } finally {
      liveProcs.delete(proc);
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

  return {
    tmpRoot,
    bareRepo,
    authorClone,
    markerDir,
    db,
    baseUrl,
    project,
    workerToken,
    submit,
    getRequest,
    getDetail,
    pollTerminal,
    mainSha,
    mainCommitCount,
    fileOnMain,
    listIntegrating,
    teardown,
  };
}

// ─── Flow (a): 3 clean @parallelism:3 — land in order + OVERLAP ────

describe.skipIf(!RUN)("batch E2E (a) — 3 clean @parallelism:3", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness(3);
  }, 60_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("all land, verify windows overlap, ordered land, main +3", async () => {
    const before = h.mainCommitCount();
    const specs = [
      { branch: "feature/clean", file: "clean.txt", marker: "clean" },
      { branch: "feature/clean2", file: "clean2.txt", marker: "clean2" },
      { branch: "feature/clean3", file: "clean3.txt", marker: "clean3" },
    ];
    const reqs: MergeRequest[] = [];
    for (const s of specs) {
      const task = createTestTask(h.db, { projectId: h.project.id });
      reqs.push(
        await h.submit(h.workerToken, {
          resource: "main",
          branch: s.branch,
          taskId: task.id,
          verifyCmd: markerVerify(h.markerDir, s.marker),
        }),
      );
    }

    const finals: MergeRequest[] = [];
    for (const r of reqs) finals.push(await h.pollTerminal(r.id, 30_000));
    for (const f of finals) expect(f.status).toBe("landed");

    // OVERLAP: read each member's .start/.end marker mtimes, assert ≥1 PAIR of
    // verify intervals intersects (a.start < b.end && b.start < a.end). This is
    // the non-flaky interval-intersection form ported from batch.test.ts — it
    // proves ≥2 verifies ran CONCURRENTLY (real spec batching), not serially.
    const windows = specs.map((s) => ({
      start: statSync(path.join(h.markerDir, `${s.marker}.start`)).mtimeMs,
      end: statSync(path.join(h.markerDir, `${s.marker}.end`)).mtimeMs,
    }));
    let overlap = false;
    for (let i = 0; i < windows.length && !overlap; i += 1) {
      for (let j = i + 1; j < windows.length; j += 1) {
        const a = windows[i];
        const b = windows[j];
        if (a.start < b.end && b.start < a.end) {
          overlap = true;
          break;
        }
      }
    }
    // CPU-contention de-flake (Step 13): the direct interval-overlap can flake
    // under full-suite CPU contention (marker mtimes jitter when 3 verifies
    // contend for cores). A SUB-LINEAR total wall-clock is itself proof of
    // concurrency: if the 3 verifies (each ~verifyDuration) had run serially the
    // span (first .start → last .end) would be ≥3×verifyDuration; a span below
    // that threshold means they overlapped. Accept EITHER signal.
    const firstStart = Math.min(...windows.map((w) => w.start));
    const lastEnd = Math.max(...windows.map((w) => w.end));
    const span = lastEnd - firstStart;
    const perVerifyMin = windows.reduce(
      (min, w) => Math.min(min, w.end - w.start),
      Infinity,
    );
    const subLinear = span < 3 * perVerifyMin;
    expect(overlap || subLinear).toBe(true);

    // Ordered land: final main tip == the LAST member (req2)'s landedSha.
    const req2Final = finals[2];
    expect(req2Final.landedSha).toBeTruthy();
    expect(await h.mainSha()).toBe(req2Final.landedSha);

    // Main advanced by EXACTLY 3 commits.
    expect(h.mainCommitCount() - before).toBe(3);

    // Remote main has all three disjoint files.
    expect(h.fileOnMain("clean.txt")).toBe(true);
    expect(h.fileOnMain("clean2.txt")).toBe(true);
    expect(h.fileOnMain("clean3.txt")).toBe(true);
  }, 60_000);
});

// ─── Flow (b): suffix invalidation @parallelism:3 ─────────────────

describe.skipIf(!RUN)("batch E2E (b) — suffix invalidation @parallelism:3", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness(3);
  }, 60_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("req0 lands, req1 rejects (suffix), req2 re-admitted + lands onto main+0", async () => {
    const before = h.mainCommitCount();
    const task0 = createTestTask(h.db, { projectId: h.project.id });
    const task1 = createTestTask(h.db, { projectId: h.project.id });
    const task2 = createTestTask(h.db, { projectId: h.project.id });

    // FIFO submit. req1 fails AFTER req2 has speculated on it (DELAY_FAIL).
    const req0 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean",
      taskId: task0.id,
      verifyCmd: "exit 0",
    });
    const req1 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean2",
      taskId: task1.id,
      verifyCmd: DELAY_FAIL,
    });
    const req2 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean3",
      taskId: task2.id,
      verifyCmd: "exit 0",
    });

    const f0 = await h.pollTerminal(req0.id, 40_000);
    const f1 = await h.pollTerminal(req1.id, 40_000);
    const f2 = await h.pollTerminal(req2.id, 40_000);

    // §7.4 outcome: req0 lands, req1 rejected, req2 lands.
    expect(f0.status).toBe("landed");
    expect(f1.status).toBe("rejected");
    expect(f1.rejectCategory).not.toBeNull();
    expect(f2.status).toBe("landed");

    // req1's task carries a merge_rejection comment (direct-DB).
    const rejComments = h.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.taskId, task1.id),
          eq(comments.commentType, "merge_rejection"),
        ),
      )
      .all();
    expect(rejComments.length).toBe(1);

    // LOAD-BEARING: invalidate EXACTLY the suffix — predecessors still land.
    // Remote main has clean.txt + clean3.txt but NOT clean2.txt.
    expect(h.fileOnMain("clean.txt")).toBe(true);
    expect(h.fileOnMain("clean3.txt")).toBe(true);
    expect(h.fileOnMain("clean2.txt")).toBe(false);

    // Main advanced by EXACTLY 2 commits (req0 + req2; req1 never landed).
    expect(h.mainCommitCount() - before).toBe(2);

    // FOLD 1: req2's corrected base — BOTH ways.
    const detail2 = await h.getDetail(req2.id);
    // Structural backstop: ≥2 attempts (initial speculative + re-admit).
    expect(detail2.attempts.length).toBeGreaterThanOrEqual(2);
    // Exact: attempts are desc(attemptNumber) → [0] is the LAST (re-admit). Its
    // base anchors to live main == req0's landedSha (the surviving prefix).
    expect(f0.landedSha).toBeTruthy();
    expect(detail2.attempts[0].baseSha).toBe(f0.landedSha);
  }, 60_000);
});

// ─── Flow (c): backpressure @parallelism:3, 5 branches ────────────

describe.skipIf(!RUN)("batch E2E (c) — backpressure @parallelism:3", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness(3);
  }, 60_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("5 branches land; peak integrating <= 3 (hard), saturation evidence (soft)", async () => {
    const before = h.mainCommitCount();
    const branches = [
      { branch: "feature/clean", file: "clean.txt" },
      { branch: "feature/clean2", file: "clean2.txt" },
      { branch: "feature/clean3", file: "clean3.txt" },
      { branch: "feature/clean4", file: "clean4.txt" },
      { branch: "feature/clean5", file: "clean5.txt" },
    ];
    const reqs: MergeRequest[] = [];
    for (const b of branches) {
      const task = createTestTask(h.db, { projectId: h.project.id });
      reqs.push(
        await h.submit(h.workerToken, {
          resource: "main",
          branch: b.branch,
          taskId: task.id,
          verifyCmd: SLEEP_600,
        }),
      );
    }

    // Poll the live `integrating` count while the batch drains.
    let peak = 0;
    let stopPoller = false;
    const poller = (async () => {
      while (!stopPoller) {
        try {
          const n = await h.listIntegrating();
          if (n > peak) peak = n;
        } catch {
          /* server may be mid-shutdown; ignore */
        }
        await sleep(50);
      }
    })();

    const finals: MergeRequest[] = [];
    for (const r of reqs) finals.push(await h.pollTerminal(r.id, 40_000));
    stopPoller = true;
    await poller;

    for (const f of finals) expect(f.status).toBe("landed");

    // HARD: pool.acquire caps at parallelism → >3 concurrent integrating is
    // structurally impossible.
    expect(peak).toBeLessThanOrEqual(3);

    // FOLD 2: saturation evidence is SOFT — a fast machine may drain members
    // before 5 pile up, so do NOT fail the test on it. Just surface it.
    if (peak < 2) {
      // eslint-disable-next-line no-console
      console.warn(
        `[batch-e2e flow c] saturation evidence weak: peak integrating = ${peak} (<2); machine drained fast — not a failure`,
      );
    }
    expect.soft(peak).toBeGreaterThanOrEqual(2);

    // Main advanced by EXACTLY 5 commits; all five files present.
    expect(h.mainCommitCount() - before).toBe(5);
    for (const b of branches) expect(h.fileOnMain(b.file)).toBe(true);
  }, 90_000);
});

// ─── Flow (d): parallelism:1 == 7.1 serial oracle ─────────────────

describe.skipIf(!RUN)("batch E2E (d) — parallelism:1 serial oracle", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness(1);
  }, 60_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("land: clean branch advances main + landed_sha git_ref + single attempt", async () => {
    const task = createTestTask(h.db, { projectId: h.project.id });
    const before = await h.mainSha();

    const req = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean",
      taskId: task.id,
      verifyCmd: "exit 0",
    });
    const final = await h.pollTerminal(req.id, 40_000);
    expect(final.status).toBe("landed");
    expect(final.landedSha).toBeTruthy();

    const after = await h.mainSha();
    expect(after).not.toBe(before);
    expect(after).toBe(final.landedSha);

    // landed_sha git_ref attached to the task (direct-DB).
    const refs = h.db
      .select()
      .from(gitRefs)
      .where(and(eq(gitRefs.taskId, task.id), eq(gitRefs.refType, "landed_sha")))
      .all();
    expect(refs.length).toBe(1);
    expect(refs[0].refValue).toBe(final.landedSha);

    // Single-attempt invariant: batch-of-one did NOT double-attempt.
    const detail = await h.getDetail(req.id);
    expect(detail.attempts.length).toBe(1);
  }, 60_000);

  it("reject: verify-fail leaves main unchanged + merge_rejection comment", async () => {
    const task = createTestTask(h.db, { projectId: h.project.id });
    const before = await h.mainSha();

    const req = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean2",
      taskId: task.id,
      verifyCmd: "exit 1",
    });
    const final = await h.pollTerminal(req.id, 40_000);
    expect(final.status).toBe("rejected");
    expect(final.rejectCategory).not.toBeNull();

    expect(await h.mainSha()).toBe(before);

    const rejComments = h.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.taskId, task.id),
          eq(comments.commentType, "merge_rejection"),
        ),
      )
      .all();
    expect(rejComments.length).toBe(1);
  }, 60_000);

  it("FIFO: two clean branches both land, earlier enqueued → earlier-or-equal pickedUp, last == main tip", async () => {
    const task1 = createTestTask(h.db, { projectId: h.project.id });
    const task2 = createTestTask(h.db, { projectId: h.project.id });

    const req1 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean3",
      taskId: task1.id,
      verifyCmd: "exit 0",
    });
    const req2 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean4",
      taskId: task2.id,
      verifyCmd: "exit 0",
    });

    const f1 = await h.pollTerminal(req1.id, 40_000);
    const f2 = await h.pollTerminal(req2.id, 40_000);
    expect(f1.status).toBe("landed");
    expect(f2.status).toBe("landed");

    const [early, late] =
      f1.enqueuedAt <= f2.enqueuedAt ? [f1, f2] : [f2, f1];
    expect(early.pickedUpAt).toBeTruthy();
    expect(late.pickedUpAt).toBeTruthy();
    expect(new Date(early.pickedUpAt!).getTime()).toBeLessThanOrEqual(
      new Date(late.pickedUpAt!).getTime(),
    );
    expect(await h.mainSha()).toBe(late.landedSha);

    // Single-attempt invariant holds for both landed requests.
    const d1 = await h.getDetail(req1.id);
    const d2 = await h.getDetail(req2.id);
    expect(d1.attempts.length).toBe(1);
    expect(d2.attempts.length).toBe(1);
  }, 60_000);
});
