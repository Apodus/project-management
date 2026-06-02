/**
 * Full-stack END-TO-END net for phase 7.5 SMART VERIFY (Step 8): the multi-step
 * verify-pipeline DAG + the verify-cache (on / shadow) + per-step observability,
 * proven against a SPAWNED reference integrator (`node dist/index.js`) talking
 * over pure HTTP to a REAL in-process PM server (createApp + @hono/node-server
 * serve on port 0, file SQLite the test process owns).
 *
 * Mirrors observability-e2e.test.ts / batch-e2e.test.ts VERBATIM for harness
 * primitives (git fixture, in-process server, spawnIntegrator + "Integrator
 * ready" await, the module-level liveProcs exit guard, SIGTERM→SIGKILL teardown,
 * the submit/getRequest/pollTerminal helpers, the win32 verify idioms, the
 * collectSse `event: <name>` matcher) and adds the smart-verify surface:
 *   - per-harness verify_steps DAG + cache_enabled + cache_mode seeded into
 *     project.settings.integrator (config.ts reads these snake_case keys).
 *   - getTimeline (CAMELCASE step fields per merge-requests.ts), getMetrics
 *     (SNAKE_CASE verify sub-block per routes/train.ts metricsToResponse), and
 *     getVerifyCache (the debug list GET, CAMELCASE row view).
 *
 * Five scenarios, EACH its OWN describe + fresh harness instance (own tmp dir,
 * own port, own DB, own spawned integrator) — a leaked integrator on the lane
 * would wedge the next, and a fresh harness per scenario sidesteps the
 * settings-change-mid-flight race + isolates leaks. fileParallelism:false is
 * project-wide so describes run sequentially.
 *
 *   A. Multi-step DAG land + fail-fast (cache off).
 *   B. Cache `on` MISS→HIT via the empty-commit-off-the-new-main mechanism.
 *   C. Shadow mismatch → REAL verdict wins (sentinel-flip + empty-commit).
 *   D. Per-step observability (timeline camelCase + metrics snake_case).
 *   E. Backward-compat (no verify_steps + cache off = inert, byte-identical 7.4).
 *
 * ── THE CACHE-HIT MECHANISM (empty-commit-off-the-new-main) ──────────────────
 * The cache key's tree_sha is the content-addressed git TREE sha
 * (batch.ts:1479 resolveRef("<rebasedCommit>^{tree}")). When a single-member
 * batch with a REAL file change MISSes, it records a row keyed on tree T = its
 * rebased tree, and on LAND pushes that exact rebased commit so new main's tree
 * == T. A SECOND member that is an EMPTY commit branched off the POST-LAND main
 * rebases up-to-date → HEAD^{tree} == main's tree == T → its lookup keyed on T
 * is a GUARANTEED HIT (bumps hit_count server-side). MANDATORY: member 2's
 * branch is created AFTER member 1 lands, off the freshly-advanced origin/main
 * (a member 2 off the ORIGINAL main carries member-1's-absent-file → rebases to
 * a DIFFERENT tree → no HIT). Create-after-land is REQUIRED.
 *
 * ── snake/camel split (load-bearing) ────────────────────────────────────────
 *   - metrics.verify.* is SNAKE_CASE (cache_enabled / cache_mode /
 *     cache_hit_rate.{ratio,hits,lookups} / time_saved_ms / per_step[].{step_id,
 *     runs,cached,pass_rate,avg_duration_ms,fail_count} / cache_mismatches).
 *   - the TIMELINE attempt steps[] is CAMELCASE ({stepId, outcome, cached,
 *     durationMs, treeSha, stepConfigSha, logUrl}).
 *   - the verify-cache debug ROW view is CAMELCASE ({stepId, result, hitCount,
 *     lastHitAt, createdAt, durationMs, treeSha, stepConfigSha}).
 *   - cache_mismatches is HARDCODED 0 in metrics (a non-persisted SSE relay) —
 *     the mismatch is asserted ONLY via the verify.cache_mismatch SSE event.
 *
 * GATING: runs iff git is available AND the integrator dist exists. Build with:
 *   pnpm --filter @pm/shared build
 *   pnpm --filter @pm/server build
 *   pnpm --filter @apodus/pm-integrator build
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const isWin = process.platform === "win32";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Bounded poll over an async predicate (the §13 de-flake discipline — NEVER a
 * bare sleep for an outcome). Resolves true the first cycle the predicate holds,
 * false on timeout.
 */
async function pollUntil(
  pred: () => Promise<boolean>,
  timeoutMs: number,
  interval = 150,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(interval);
  }
}

// ─── win32-safe deterministic verify commands ─────────────────────
// All run via runVerify shell:true (cmd.exe builtins / sh). Forward-slash any
// embedded absolute path (cmd.exe accepts forward slashes in `if exist`).

const PASS_CMD = "exit 0";
const FAIL_CMD = "exit 1";
// A timed PASS (non-zero durationMs so time_saved_ms is observably >0 after a HIT).
const TIMED_PASS = isWin ? "ping -n 3 127.0.0.1 > nul" : "sleep 1.5";

/**
 * A sentinel-gated step: real verdict FLIPS to fail iff the absolute sentinel
 * file exists. The sentinel lives OUTSIDE any git checkout (under tmpRoot, an
 * untracked path) → the git ^{tree} is INVARIANT to its creation (the integrator
 * keys on the content-addressed tree, not a working-dir hash). The command is
 * verbatim from project settings (identical for every member) so the absolute
 * path resolves identically across members' distinct worktrees — keep ABSOLUTE.
 */
function sentinelGated(absSentinel: string): string {
  const fwd = absSentinel.replace(/\\/g, "/");
  return isWin
    ? `cmd /c if exist "${fwd}" (exit 1) else (exit 0)`
    : `[ -e '${fwd}' ] && exit 1 || exit 0`;
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
  rejectCategory: string | null;
  enqueuedAt: string;
  pickedUpAt: string | null;
}

interface VerifyStepConfig {
  id: string;
  command: string;
  depends_on?: string[];
}

interface TimelineStep {
  stepId: string;
  outcome: "pass" | "fail";
  cached: boolean;
  durationMs: number;
  treeSha: string;
  stepConfigSha: string;
  logUrl?: string;
}

interface TimelineEvent {
  at: string;
  kind: string;
  status?: string;
  steps?: TimelineStep[] | null;
}

interface VerifyCacheRow {
  id: string;
  stepId: string;
  result: "pass" | "fail";
  treeSha: string;
  stepConfigSha: string;
  durationMs: number | null;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
}

interface VerifyMetrics {
  cache_enabled: boolean;
  cache_mode: string;
  cache_hit_rate: { ratio: number | null; hits: number; lookups: number };
  time_saved_ms: number;
  per_step: Array<{
    step_id: string;
    runs: number;
    cached: number;
    pass_rate: number | null;
    avg_duration_ms: number | null;
    fail_count: number;
  }>;
  cache_mismatches: number;
}

interface HarnessOpts {
  verifySteps: VerifyStepConfig[];
  cacheEnabled: boolean;
  cacheMode: "off" | "on" | "shadow";
  verifyCommand?: string;
}

interface Harness {
  tmpRoot: string;
  bareRepo: string;
  authorClone: string;
  db: AppDatabase;
  baseUrl: string;
  project: { id: string; slug: string };
  workerToken: string;
  spawnIntegrator: () => Promise<ChildProcess>;
  submit: (
    token: string,
    body: Record<string, unknown>,
  ) => Promise<MergeRequest>;
  getRequest: (id: string) => Promise<MergeRequest>;
  pollTerminal: (id: string, timeoutMs?: number) => Promise<MergeRequest>;
  getTimeline: (id: string) => Promise<TimelineEvent[]>;
  getMetrics: () => Promise<VerifyMetrics>;
  getVerifyCache: () => Promise<VerifyCacheRow[]>;
  mainSha: () => Promise<string>;
  /** Create an EMPTY commit off the freshly-advanced origin/main + push it. */
  pushEmptyOffMain: (branch: string) => Promise<void>;
  collectSse: (token: string) => SseCollector;
  teardown: () => Promise<void>;
}

interface SseCollector {
  saw: (eventName: string) => boolean;
  stop: () => void;
}

const TERMINAL = new Set(["landed", "rejected", "abandoned"]);

// ─── Harness ──────────────────────────────────────────────────────

async function makeHarness(opts: HarnessOpts): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-smartv-e2e-"));
  const bareRepo = path.join(tmpRoot, "bare.git");
  const authorClone = path.join(tmpRoot, "author");

  // ── Git fixture: bare remote + author clone with a single REAL-change branch
  //    (feature/clean). Empty-commit member branches are created AFTER a land,
  //    off the freshly-advanced origin/main (pushEmptyOffMain). ──
  await simpleGit().init(["--bare", "--initial-branch=main", bareRepo]);
  await simpleGit().clone(bareRepo, authorClone);
  const g = simpleGit(authorClone);
  await g.addConfig("user.email", "int@test.local");
  await g.addConfig("user.name", "Integrator Test");
  await g.addConfig("commit.gpgsign", "false");

  writeFileSync(path.join(authorClone, "base.txt"), "base\n");
  await g.add(["base.txt"]);
  await g.commit("initial");
  await g.branch(["-M", "main"]);
  await g.push(["-u", "origin", "main"]);

  // Real-change branches (distinct files so none is a no-op).
  const branches: Array<{ name: string; file: string }> = [
    { name: "feature/clean", file: "clean.txt" },
    { name: "feature/bad", file: "bad.txt" },
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

  // ── Seed project with the smart-verify integrator settings. ──
  const proj = createTestProject(db, {
    settings: {
      integrator: {
        enabled: true,
        verify_command: opts.verifyCommand ?? "exit 0",
        verify_timeout_sec: 30,
        worktree_root: path.join(tmpRoot, "wt"),
        worktree_name: "smartv-e2e",
        git_remote: "origin",
        git_main_branch: "main",
        parallelism: 2,
        verify_steps: opts.verifySteps,
        cache_enabled: opts.cacheEnabled,
        cache_mode: opts.cacheMode,
      },
    },
  });
  const project = { id: proj.id, slug: proj.slug };
  db.update(projects)
    .set({ gitRepoUrl: bareRepo })
    .where(eq(projects.id, project.id))
    .run();

  // ── Spawnable integrator. ──
  let currentProc: ChildProcess | null = null;

  async function spawnIntegrator(): Promise<ChildProcess> {
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

  // ── HTTP + git helpers. ──
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

  async function pollTerminal(
    id: string,
    timeoutMs = 40_000,
  ): Promise<MergeRequest> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await getRequest(id);
      if (TERMINAL.has(r.status)) return r;
      await sleep(150);
    }
    throw new Error(`request ${id} did not reach a terminal state in time`);
  }

  async function getTimeline(id: string): Promise<TimelineEvent[]> {
    const res = await fetch(
      `${baseUrl}/api/v1/merge-requests/${id}/timeline`,
      { headers: { Authorization: `Bearer ${workerToken}` } },
    );
    expect(res.status).toBe(200);
    return ((await res.json()).data as { events: TimelineEvent[] }).events;
  }

  async function getMetrics(): Promise<VerifyMetrics> {
    const res = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/train/metrics?resource=main`,
      { headers: { Authorization: `Bearer ${workerToken}` } },
    );
    expect(res.status).toBe(200);
    return ((await res.json()).data as { verify: VerifyMetrics }).verify;
  }

  async function getVerifyCache(): Promise<VerifyCacheRow[]> {
    const res = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/verify-cache?resource=main&perPage=200`,
      { headers: { Authorization: `Bearer ${workerToken}` } },
    );
    expect(res.status).toBe(200);
    return (await res.json()).data as VerifyCacheRow[];
  }

  async function mainSha(): Promise<string> {
    return (await simpleGit(bareRepo).revparse(["refs/heads/main"])).trim();
  }

  async function pushEmptyOffMain(branch: string): Promise<void> {
    // Fetch the freshly-advanced main, hard-reset the author clone to it, then
    // an EMPTY commit + push the member branch. Branching off origin/main AFTER
    // a land is what makes the empty-commit member's rebased tree == main's tree
    // == the recorded cache key → a guaranteed HIT.
    await g.fetch(["origin"]);
    await g.checkout("main");
    await g.reset(["--hard", "origin/main"]);
    await g.raw(["commit", "--allow-empty", "-m", `empty ${branch}`]);
    await g.push(["origin", `HEAD:refs/heads/${branch}`, "-f"]);
    await g.checkout("main");
  }

  // ── SSE collector (matches `event: <name>` over the raw stream). ──
  function collectSse(token: string): SseCollector {
    const controller = new AbortController();
    let buffer = "";
    void (async () => {
      try {
        const res = await fetch(
          `${baseUrl}/api/v1/events?project_id=${project.id}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          },
        );
        if (!res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        }
      } catch {
        /* aborted or stream closed — ignore */
      }
    })();
    return {
      saw: (eventName: string) => buffer.includes(`event: ${eventName}`),
      stop: () => controller.abort(),
    };
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

  return {
    tmpRoot,
    bareRepo,
    authorClone,
    db,
    baseUrl,
    project,
    workerToken,
    spawnIntegrator,
    submit,
    getRequest,
    pollTerminal,
    getTimeline,
    getMetrics,
    getVerifyCache,
    mainSha,
    pushEmptyOffMain,
    collectSse,
    teardown,
  };
}

/** The attempt-kind timeline event's steps[] (the verify pipeline outcome). */
function attemptSteps(events: TimelineEvent[]): TimelineStep[] {
  const attempts = events.filter((e) => e.kind === "attempt" && e.steps);
  // The LAST attempt is the one that landed/rejected the request.
  const last = attempts[attempts.length - 1];
  return last?.steps ?? [];
}

// ─── Scenario A: Multi-step DAG land + fail-fast (cache off) ───────

describe.skipIf(!RUN)("smart-verify E2E (A) — multi-step DAG land", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({
      verifySteps: [
        { id: "format", command: PASS_CMD, depends_on: [] },
        { id: "lint", command: PASS_CMD, depends_on: ["format"] },
        { id: "typecheck", command: TIMED_PASS, depends_on: ["format"] },
        { id: "unit", command: PASS_CMD, depends_on: ["lint", "typecheck"] },
      ],
      cacheEnabled: false,
      cacheMode: "off",
    });
    await h.spawnIntegrator();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("4-step DAG lands; timeline shows all 4 steps pass + cached:false (camelCase)", async () => {
    const before = await h.mainSha();
    const req = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean",
      verifyCmd: PASS_CMD,
    });
    const final = await h.pollTerminal(req.id, 40_000);
    expect(final.status).toBe("landed");
    expect(await h.mainSha()).not.toBe(before);

    const steps = attemptSteps(await h.getTimeline(req.id));
    const byId = new Map(steps.map((s) => [s.stepId, s]));
    for (const id of ["format", "lint", "typecheck", "unit"]) {
      const s = byId.get(id);
      expect(s, `step ${id} present`).toBeDefined();
      expect(s!.outcome).toBe("pass");
      expect(s!.cached).toBe(false);
    }
    expect(steps.length).toBe(4);
  }, 60_000);
});

describe.skipIf(!RUN)("smart-verify E2E (A2) — fail-fast short-circuit", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({
      verifySteps: [
        { id: "format", command: PASS_CMD, depends_on: [] },
        { id: "lint", command: FAIL_CMD, depends_on: ["format"] },
        { id: "unit", command: TIMED_PASS, depends_on: ["lint"] },
      ],
      cacheEnabled: false,
      cacheMode: "off",
    });
    await h.spawnIntegrator();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("lint fails → rejected; timeline shows lint fail + unit ABSENT (fail-fast)", async () => {
    const before = await h.mainSha();
    const req = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean",
      verifyCmd: PASS_CMD,
    });
    const final = await h.pollTerminal(req.id, 40_000);
    expect(final.status).toBe("rejected");
    expect(await h.mainSha()).toBe(before);

    const steps = attemptSteps(await h.getTimeline(req.id));
    const byId = new Map(steps.map((s) => [s.stepId, s]));
    expect(byId.get("lint")?.outcome).toBe("fail");
    // fail-fast: `unit` (downstream of the failing lint) never ran → ABSENT.
    expect(byId.has("unit")).toBe(false);
  }, 60_000);
});

// ─── Scenario B: Cache `on` MISS→HIT (empty-commit mechanism) ──────

describe.skipIf(!RUN)("smart-verify E2E (B) — cache on MISS→HIT", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({
      verifySteps: [{ id: "unit", command: TIMED_PASS, depends_on: [] }],
      cacheEnabled: true,
      cacheMode: "on",
    });
    await h.spawnIntegrator();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("member1 (real) MISSes+records hitCount0; member2 (empty off new main) HITs", async () => {
    // ── Member 1: a REAL change → MISS, run, record a row keyed on its tree. ──
    const req1 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean",
      verifyCmd: TIMED_PASS,
    });
    const f1 = await h.pollTerminal(req1.id, 40_000);
    expect(f1.status).toBe("landed");

    // Bounded-poll the cache row appears (the MISS recorded a pass row, hit 0).
    let unitRow: VerifyCacheRow | undefined;
    const rowAppeared = await pollUntil(async () => {
      const rows = await h.getVerifyCache();
      unitRow = rows.find((r) => r.stepId === "unit" && r.result === "pass");
      return unitRow !== undefined;
    }, 10_000);
    expect(rowAppeared, "unit cache row recorded after member1").toBe(true);
    expect(unitRow!.hitCount).toBe(0);
    const recordedTree = unitRow!.treeSha;

    // ── Member 2: an EMPTY commit off the POST-member1-land main. Created AFTER
    //    the land so it rebases up-to-date → same tree as member1 → HIT. ──
    await h.pushEmptyOffMain("feature/empty2");
    const req2 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/empty2",
      verifyCmd: TIMED_PASS,
    });
    const f2 = await h.pollTerminal(req2.id, 40_000);
    expect(f2.status).toBe("landed");

    // The robust cross-process HIT proof: the SAME row's hitCount climbed >= 1
    // AND the metric hits >= 1. Poll BOTH independently (the §13 visible-before-
    // committed race: don't read one then assume the other).
    const hitBumped = await pollUntil(async () => {
      const rows = await h.getVerifyCache();
      const row = rows.find(
        (r) => r.stepId === "unit" && r.treeSha === recordedTree,
      );
      return (row?.hitCount ?? 0) >= 1;
    }, 15_000);
    expect(hitBumped, "the recorded row's hitCount bumped to >=1").toBe(true);

    const metricHit = await pollUntil(async () => {
      const m = await h.getMetrics();
      return m.cache_hit_rate.hits >= 1;
    }, 15_000);
    expect(metricHit, "metrics.verify.cache_hit_rate.hits >= 1").toBe(true);

    // The timed step × a HIT → observable time saved (SNAKE metrics path).
    const m = await h.getMetrics();
    expect(m.time_saved_ms).toBeGreaterThan(0);
  }, 90_000);
});

// ─── Scenario C: Shadow mismatch → real verdict wins ──────────────

describe.skipIf(!RUN)("smart-verify E2E (C) — shadow mismatch, real fail wins", () => {
  let h: Harness;
  let sentinel: string;
  beforeAll(async () => {
    // The sentinel lives under tmpRoot, OUTSIDE any git checkout → tree-invariant.
    const root = mkdtempSync(path.join(tmpdir(), "pm-smartv-sentinel-"));
    sentinel = path.join(root, "gate.flag");
    h = await makeHarness({
      verifySteps: [{ id: "gate", command: sentinelGated(sentinel) }],
      cacheEnabled: true,
      cacheMode: "shadow",
    });
    await h.spawnIntegrator();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
    try {
      rmSync(path.dirname(sentinel), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("member1 records pass; sentinel flips real→fail; member2 mismatches + the REAL fail wins", async () => {
    // ── (1) sentinel ABSENT → gate real=pass. member1 lands, shadow records pass. ──
    const req1 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean",
      verifyCmd: sentinelGated(sentinel),
    });
    const f1 = await h.pollTerminal(req1.id, 40_000);
    expect(f1.status).toBe("landed");

    let gateRow: VerifyCacheRow | undefined;
    const recorded = await pollUntil(async () => {
      const rows = await h.getVerifyCache();
      gateRow = rows.find((r) => r.stepId === "gate");
      return gateRow !== undefined && gateRow.result === "pass";
    }, 10_000);
    expect(recorded, "gate row recorded pass after member1").toBe(true);
    const gateTree = gateRow!.treeSha;
    const firstCreatedAt = gateRow!.createdAt;

    // ── (2) CREATE the sentinel → gate real flips to fail (tree T unchanged). ──
    writeFileSync(sentinel, "flip\n");

    // ── (3) Subscribe SSE BEFORE submitting member 2 (the establish grace). ──
    const sse = h.collectSse(h.workerToken);
    await sleep(300);

    // member2 = empty commit off the POST-member1-land main → same tree T →
    // shadow lookup HITs cached pass, real run FAILS → mismatch + REAL fail wins.
    const before2 = await h.mainSha();
    await h.pushEmptyOffMain("feature/empty-c");
    const req2 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/empty-c",
      verifyCmd: sentinelGated(sentinel),
    });

    // The REAL fail won (NOT the stale cached pass) — the false-pass detector.
    const f2 = await h.pollTerminal(req2.id, 40_000);
    expect(f2.status).toBe("rejected");
    // Main did NOT advance on the rejected member.
    expect(await h.mainSha()).toBe(before2);

    // The mismatch is asserted ONLY via the SSE event (cache_mismatches metric is
    // hardcoded 0 — a non-persisted relay).
    const sawMismatch = await pollUntil(
      async () => sse.saw("verify.cache_mismatch"),
      5_000,
      100,
    );
    expect(sawMismatch, "verify.cache_mismatch SSE within 5s").toBe(true);
    sse.stop();

    // The shadow self-heal: the (T,"gate") row's verdict re-recorded to fail,
    // while hitCount/createdAt SURVIVE (preserve-on-re-record).
    const healed = await pollUntil(async () => {
      const rows = await h.getVerifyCache();
      const row = rows.find(
        (r) => r.stepId === "gate" && r.treeSha === gateTree,
      );
      return row?.result === "fail";
    }, 15_000);
    expect(healed, "gate row self-healed to fail").toBe(true);

    const finalRows = await h.getVerifyCache();
    const finalGate = finalRows.find(
      (r) => r.stepId === "gate" && r.treeSha === gateTree,
    )!;
    expect(finalGate.result).toBe("fail");
    // createdAt preserved across the re-record (metric integrity).
    expect(finalGate.createdAt).toBe(firstCreatedAt);
    // The shadow HIT bumped the counter (lookup ran in shadow), so it survived.
    expect(finalGate.hitCount).toBeGreaterThanOrEqual(1);
  }, 90_000);
});

// ─── Scenario D: Per-step observability surfaces ──────────────────

describe.skipIf(!RUN)("smart-verify E2E (D) — per-step observability", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({
      verifySteps: [
        { id: "format", command: PASS_CMD, depends_on: [] },
        { id: "build", command: TIMED_PASS, depends_on: ["format"] },
      ],
      cacheEnabled: true,
      cacheMode: "on",
    });
    await h.spawnIntegrator();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("timeline steps[] (camelCase) match the DAG; metrics.verify (snake_case) echoes config + per_step", async () => {
    const req = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean",
      verifyCmd: PASS_CMD,
    });
    const final = await h.pollTerminal(req.id, 40_000);
    expect(final.status).toBe("landed");

    // TIMELINE — CAMELCASE step fields.
    const steps = attemptSteps(await h.getTimeline(req.id));
    const byId = new Map(steps.map((s) => [s.stepId, s]));
    expect(byId.has("format")).toBe(true);
    expect(byId.has("build")).toBe(true);
    for (const s of steps) {
      expect(s.outcome).toBe("pass");
      expect(typeof s.cached).toBe("boolean");
      expect(typeof s.durationMs).toBe("number");
      expect(typeof s.treeSha).toBe("string");
      expect(typeof s.stepConfigSha).toBe("string");
    }

    // METRICS — SNAKE_CASE verify sub-block; lookups>=1 (the on-mode MISS lookups),
    // per_step has an entry per ran step_id with runs>=1.
    const climbed = await pollUntil(async () => {
      const m = await h.getMetrics();
      return m.cache_hit_rate.lookups >= 1;
    }, 10_000);
    expect(climbed, "cache_hit_rate.lookups >= 1").toBe(true);

    const m = await h.getMetrics();
    expect(m.cache_enabled).toBe(true);
    expect(m.cache_mode).toBe("on");
    const perStepById = new Map(m.per_step.map((p) => [p.step_id, p]));
    for (const id of ["format", "build"]) {
      const p = perStepById.get(id);
      expect(p, `per_step entry for ${id}`).toBeDefined();
      expect(p!.runs).toBeGreaterThanOrEqual(1);
    }
  }, 60_000);
});

// ─── Scenario E: Backward-compat (no verify_steps + cache off, inert) ──

describe.skipIf(!RUN)("smart-verify E2E (E) — backward-compat (cache inert)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({
      verifySteps: [],
      cacheEnabled: false,
      cacheMode: "off",
      verifyCommand: "exit 0",
    });
    await h.spawnIntegrator();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("land + reject behave 7.4-identically AND the cache stays fully inert", async () => {
    // ── Land: clean branch advances main + landed_sha git_ref. ──
    const task1 = createTestTask(h.db, { projectId: h.project.id });
    const before = await h.mainSha();
    const req1 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean",
      taskId: task1.id,
      verifyCmd: "exit 0",
    });
    const f1 = await h.pollTerminal(req1.id, 40_000);
    expect(f1.status).toBe("landed");
    const after = await h.mainSha();
    expect(after).not.toBe(before);
    expect(after).toBe(f1.landedSha);

    const refs = h.db
      .select()
      .from(gitRefs)
      .where(
        and(eq(gitRefs.taskId, task1.id), eq(gitRefs.refType, "landed_sha")),
      )
      .all();
    expect(refs.length).toBe(1);
    expect(refs[0].refValue).toBe(f1.landedSha);

    // ── Reject: verify-fail leaves main unchanged + merge_rejection comment. ──
    const task2 = createTestTask(h.db, { projectId: h.project.id });
    const beforeBad = await h.mainSha();
    const req2 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/bad",
      taskId: task2.id,
      verifyCmd: "exit 1",
    });
    const f2 = await h.pollTerminal(req2.id, 40_000);
    expect(f2.status).toBe("rejected");
    expect(await h.mainSha()).toBe(beforeBad);

    const rejComments = h.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.taskId, task2.id),
          eq(comments.commentType, "merge_rejection"),
        ),
      )
      .all();
    expect(rejComments.length).toBe(1);

    // ── The kill-switch end-to-end: the cache NEVER recorded a row, and the
    //    metric reports disabled + zero lookups (poll a bounded window to prove
    //    it STAYS empty even after both members fully resolved). ──
    const stayedInert = await pollUntil(async () => {
      const rows = await h.getVerifyCache();
      const m = await h.getMetrics();
      return (
        rows.length === 0 &&
        m.cache_enabled === false &&
        m.cache_hit_rate.lookups === 0
      );
    }, 3_000);
    expect(stayedInert, "cache stayed inert (no rows, disabled, 0 lookups)").toBe(
      true,
    );

    // Final hard assertions (a single read after the bounded window).
    expect(await h.getVerifyCache()).toEqual([]);
    const m = await h.getMetrics();
    expect(m.cache_enabled).toBe(false);
    expect(m.cache_hit_rate.lookups).toBe(0);
  }, 90_000);
});
