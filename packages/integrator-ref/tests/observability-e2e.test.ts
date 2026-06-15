/**
 * Full-stack END-TO-END observability + break-glass regression net for phase
 * 7.4 (Step 13).
 *
 * The phase's regression net. Boots a REAL PM server in-process (createApp +
 * @hono/node-server serve, file SQLite the TEST PROCESS owns), and — for the
 * flows that need a live integrator — spawns the BUILT integrator
 * (`node dist/index.js`) as a SEPARATE process. The integrator heartbeats on a
 * fixed interval (§3.5/§3.6) and honors admin pause (§4.2).
 *
 * Mirrors batch-e2e.test.ts / group-e2e.test.ts for harness primitives
 * (in-process server, spawnIntegrator + "Integrator ready" await, liveProcs
 * guard, teardown, the git fixture, win32 idioms) and adds an admin-with-token
 * human identity (createTestUser does NOT set a token — inserted inline like
 * createTestApp).
 *
 * One describe per flow; fileParallelism:false (the harness is process-global —
 * one server/DB/integrator live at a time).
 *
 * Flows:
 *   (a) heartbeat → fresh → stop → back-date last_seen → stale → unhealthy.
 *       BOUNDED staleness (no real 90s wait): direct-DB back-date of lastSeenAt
 *       to 91s ago, then the on-read GET fires the edge. Asserts BOTH the DB
 *       latch (unhealthyNotified — the hard floor) AND the SSE
 *       train.integrator_unhealthy frame (soft belt).
 *   (b) pause → req2 stays queued → resume → lands (bounded negative window).
 *   (c) force-land → audit (deterministic, NO spawn).
 *   (d) metrics reflect a directly-seeded train (deterministic, NO spawn).
 *   (e) force-release unwedges a lock (deterministic, NO spawn).
 *
 * GATING: runs iff git is available AND the integrator dist exists. Build with:
 *   pnpm --filter @pm/shared build
 *   pnpm --filter @pm/server build
 *   pnpm --filter @urtela/pm-integrator build
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createId } from "@pm/shared";
import { simpleGit } from "simple-git";
import { serve, type ServerType } from "@hono/node-server";
import { createApp } from "../../server/src/app.js";
import {
  initializeDatabase,
  closeDb,
  projects,
  users,
  integratorHealth,
  mergeRequests,
  mergeAttempts,
  mergeLocks,
  type AppDatabase,
} from "../../server/src/db/index.js";
import { createTestProject, createTestAiAgent } from "../../server/tests/utils.js";

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

interface HealthView {
  resource: string;
  status: string;
  healthy: boolean;
  last_seen_at: string | null;
  staleness_ms: number | null;
  pool_size: number | null;
  version: string | null;
}

interface AuditRow {
  id: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
}

interface Harness {
  tmpRoot: string;
  bareRepo: string;
  db: AppDatabase;
  baseUrl: string;
  project: { id: string; slug: string };
  integratorToken: string;
  workerToken: string;
  workerId: string;
  adminToken: string;
  adminId: string;
  spawnIntegrator: () => Promise<ChildProcess>;
  proc: () => ChildProcess | null;
  submit: (token: string, body: Record<string, unknown>) => Promise<MergeRequest>;
  getRequest: (id: string) => Promise<MergeRequest>;
  pollTerminal: (id: string, timeoutMs?: number) => Promise<MergeRequest>;
  mainSha: () => Promise<string>;
  getHealth: () => Promise<HealthView>;
  getMetrics: (token: string) => Promise<Record<string, unknown>>;
  pauseTrain: () => Promise<void>;
  resumeTrain: () => Promise<void>;
  getTrainState: () => Promise<{ state: string }>;
  forceLand: (
    id: string,
    body: { landedSha: string; reason: string },
  ) => Promise<{ status: number; data: MergeRequest }>;
  forceRelease: (
    resource: string,
    body: { reason: string },
  ) => Promise<{
    status: number;
    data: { ok: boolean; priorHolderId: string | null };
  }>;
  acquireLock: (token: string, resource: string) => Promise<{ ok: boolean; status: string }>;
  getAudit: (query: string) => Promise<AuditRow[]>;
  teardown: () => Promise<void>;
}

const TERMINAL = new Set(["landed", "rejected", "abandoned"]);

// ─── Harness ──────────────────────────────────────────────────────

async function makeObsHarness(): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-obs-e2e-"));
  const bareRepo = path.join(tmpRoot, "bare.git");
  const authorClone = path.join(tmpRoot, "author");

  // ── Git fixture: bare remote + author clone with two DISJOINT branches. ──
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

  const branches: Array<{ name: string; file: string }> = [
    { name: "feature/clean", file: "clean.txt" },
    { name: "feature/clean2", file: "clean2.txt" },
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
  // integrator + worker are ai_agents (createTestAiAgent sets apiTokenHash).
  const integratorToken = createTestAiAgent(db, {
    username: "integrator",
  }).token;
  const workerAgent = createTestAiAgent(db, { username: "worker" });
  const workerToken = workerAgent.token;
  const workerId = workerAgent.user.id;

  // admin is a HUMAN with a token — createTestUser does NOT set apiTokenHash,
  // so insert inline (mirrors createTestApp: bcrypt.hashSync(token) into
  // users.apiTokenHash, role:"admin", type:"human").
  const adminToken = "admin-token-obs-e2e";
  const adminId = createId();
  {
    const ts = new Date().toISOString();
    db.insert(users)
      .values({
        id: adminId,
        username: "obs-admin",
        displayName: "Obs Admin",
        email: "obs-admin@test.local",
        role: "admin",
        type: "human",
        apiTokenHash: bcrypt.hashSync(adminToken, 10),
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
  }

  // ── Seed project with integrator settings (enabled, verify exit 0). ──
  const proj = createTestProject(db, {
    settings: {
      integrator: {
        enabled: true,
        verify_command: "exit 0",
        verify_timeout_sec: 30,
        worktree_root: path.join(tmpRoot, "wt"),
        worktree_name: "obs-e2e",
        git_remote: "origin",
        git_main_branch: "main",
        parallelism: 1,
      },
    },
  });
  const project = { id: proj.id, slug: proj.slug };
  db.update(projects).set({ gitRepoUrl: bareRepo }).where(eq(projects.id, project.id)).run();

  // ── Spawnable integrator (factored out so flows opt-in). ──
  let currentProc: ChildProcess | null = null;

  async function spawnIntegrator(): Promise<ChildProcess> {
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

  // ── HTTP helpers. ──
  async function submit(token: string, body: Record<string, unknown>): Promise<MergeRequest> {
    const res = await fetch(`${baseUrl}/api/v1/projects/${project.id}/merge-requests`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
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

  async function pollTerminal(id: string, timeoutMs = 40_000): Promise<MergeRequest> {
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

  async function getHealth(): Promise<HealthView> {
    const res = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/integrator/health?resource=main`,
      { headers: { Authorization: `Bearer ${workerToken}` } },
    );
    expect(res.status).toBe(200);
    return (await res.json()).data as HealthView;
  }

  async function getMetrics(token: string): Promise<Record<string, unknown>> {
    const res = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/train/metrics?resource=main`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    return (await res.json()).data as Record<string, unknown>;
  }

  async function pauseTrain(): Promise<void> {
    const res = await fetch(`${baseUrl}/api/v1/projects/${project.id}/train/pause`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resource: "main" }),
    });
    expect(res.status).toBe(200);
  }

  async function resumeTrain(): Promise<void> {
    const res = await fetch(`${baseUrl}/api/v1/projects/${project.id}/train/resume`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resource: "main" }),
    });
    expect(res.status).toBe(200);
  }

  async function getTrainState(): Promise<{ state: string }> {
    const res = await fetch(`${baseUrl}/api/v1/projects/${project.id}/train/state?resource=main`, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()).data as { state: string };
  }

  async function forceLand(
    id: string,
    body: { landedSha: string; reason: string },
  ): Promise<{ status: number; data: MergeRequest }> {
    const res = await fetch(`${baseUrl}/api/v1/merge-requests/${id}/force-land`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { data?: MergeRequest };
    return { status: res.status, data: json.data as MergeRequest };
  }

  async function forceRelease(
    resource: string,
    body: { reason: string },
  ): Promise<{
    status: number;
    data: { ok: boolean; priorHolderId: string | null };
  }> {
    const res = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/merge-locks/${resource}/force-release`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const json = (await res.json()) as {
      data?: { ok: boolean; priorHolderId: string | null };
    };
    return {
      status: res.status,
      data: json.data as { ok: boolean; priorHolderId: string | null },
    };
  }

  async function acquireLock(
    token: string,
    resource: string,
  ): Promise<{ ok: boolean; status: string }> {
    const res = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/merge-locks/${resource}/acquire`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(200);
    return (await res.json()).data as { ok: boolean; status: string };
  }

  async function getAudit(query: string): Promise<AuditRow[]> {
    const res = await fetch(`${baseUrl}/api/v1/projects/${project.id}/audit-log?${query}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()).data as AuditRow[];
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
    db,
    baseUrl,
    project,
    integratorToken,
    workerToken,
    workerId,
    adminToken,
    adminId,
    spawnIntegrator,
    proc: () => currentProc,
    submit,
    getRequest,
    pollTerminal,
    mainSha,
    getHealth,
    getMetrics,
    pauseTrain,
    resumeTrain,
    getTrainState,
    forceLand,
    forceRelease,
    acquireLock,
    getAudit,
    teardown,
  };
}

// ─── SSE collector ─────────────────────────────────────────────────
// Subscribe to /api/v1/events?project_id=… and accumulate the raw stream text.
// Returns a stop() + a `saw(eventName)` predicate over the accumulated buffer.
// The SSE frame's `event:` field is the FULL event name (events.ts sets
// `event` to the bus event name), so we match on `event: <name>`.
interface SseCollector {
  saw: (eventName: string) => boolean;
  stop: () => void;
}

function collectSse(baseUrl: string, projectId: string, token: string): SseCollector {
  const controller = new AbortController();
  let buffer = "";
  void (async () => {
    try {
      const res = await fetch(`${baseUrl}/api/v1/events?project_id=${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
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

// ─── Flow (a): heartbeat → fresh → stop → stale → unhealthy ────────

describe.skipIf(!RUN)("observability E2E (a) — health fresh → stale → unhealthy", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeObsHarness();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("spawn → fresh+healthy heartbeat; stop + back-date last_seen → stale; edge fires (DB latch + SSE)", async () => {
    const proc = await h.spawnIntegrator();

    // 1) Poll health until the boot beat lands: healthy + last_seen non-null.
    let health = await h.getHealth();
    const freshDeadline = Date.now() + 15_000;
    while ((!health.healthy || health.last_seen_at === null) && Date.now() < freshDeadline) {
      await sleep(200);
      health = await h.getHealth();
    }
    expect(health.healthy).toBe(true);
    expect(health.last_seen_at).not.toBeNull();
    expect(["idle", "integrating"]).toContain(health.status);
    expect(health.version).toBeTruthy();
    expect(health.pool_size).not.toBeNull();

    // 2) Kill the integrator (SIGTERM → SIGKILL fallback), await exit so no
    //    further heartbeat re-arms the latch after we back-date.
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await Promise.race([once(proc, "exit"), sleep(5000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
    liveProcs.delete(proc);

    // 3) BOUNDED staleness: back-date lastSeenAt to 91s ago directly in the DB
    //    (no real 90s wait). The on-read GET then computes staleness > 90s.
    const staleIso = new Date(Date.now() - 91_000).toISOString();
    h.db
      .update(integratorHealth)
      .set({ lastSeenAt: staleIso })
      .where(
        and(eq(integratorHealth.projectId, h.project.id), eq(integratorHealth.resource, "main")),
      )
      .run();

    // 4) Subscribe SSE BEFORE the stale read so the edge frame is captured.
    const sse = collectSse(h.baseUrl, h.project.id, h.workerToken);
    // Give the stream a moment to establish (the "connected" frame).
    await sleep(300);

    // 5) The stale on-read GET → unhealthy + staleness > 90s, and fires the edge.
    const stale = await h.getHealth();
    expect(stale.healthy).toBe(false);
    expect(stale.staleness_ms).not.toBeNull();
    expect(stale.staleness_ms as number).toBeGreaterThan(90_000);

    // (i) HARD floor: the DB latch flipped to true (the edge fired exactly once).
    const latchRow = h.db
      .select({ unhealthyNotified: integratorHealth.unhealthyNotified })
      .from(integratorHealth)
      .where(
        and(eq(integratorHealth.projectId, h.project.id), eq(integratorHealth.resource, "main")),
      )
      .get();
    expect(latchRow?.unhealthyNotified).toBe(true);

    // (ii) SOFT belt: SSE saw train.integrator_unhealthy within a grace window.
    const sseDeadline = Date.now() + 5_000;
    while (!sse.saw("train.integrator_unhealthy") && Date.now() < sseDeadline) {
      await sleep(100);
    }
    expect(sse.saw("train.integrator_unhealthy")).toBe(true);
    sse.stop();
  }, 60_000);
});

// ─── Flow (b): pause → no-pickup → resume ─────────────────────────

describe.skipIf(!RUN)("observability E2E (b) — pause holds new pickups, resume lands", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeObsHarness();
    await h.spawnIntegrator();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("req1 lands live; pause → req2 STAYS queued (bounded window); resume → req2 lands", async () => {
    // 1) req1 lands with the live integrator.
    const before1 = await h.mainSha();
    const req1 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean",
      verifyCmd: "exit 0",
    });
    const f1 = await h.pollTerminal(req1.id, 40_000);
    expect(f1.status).toBe("landed");
    expect(await h.mainSha()).not.toBe(before1);

    // 2) Pause, then poll the train state until it actually reads paused so the
    //    integrator's NEXT isPaused check observes it before req2 is submitted.
    await h.pauseTrain();
    let state = await h.getTrainState();
    const pauseDeadline = Date.now() + 10_000;
    while (state.state !== "paused" && Date.now() < pauseDeadline) {
      await sleep(150);
      state = await h.getTrainState();
    }
    expect(state.state).toBe("paused");

    // 3) Submit req2. NEGATIVE assertion over a BOUNDED window (~8s, ≥5 poll
    //    cycles at the integrator's 1s poll): it must STAY queued + pickedUpAt
    //    null THROUGHOUT — a single read would not prove the train is held.
    const req2 = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean2",
      verifyCmd: "exit 0",
    });
    const negWindow = Date.now() + 8_000;
    while (Date.now() < negWindow) {
      const r = await h.getRequest(req2.id);
      expect(r.status).toBe("queued");
      expect(r.pickedUpAt).toBeNull();
      await sleep(500);
    }

    // 4) Resume → req2 lands, main advances again.
    const before2 = await h.mainSha();
    await h.resumeTrain();
    const f2 = await h.pollTerminal(req2.id, 40_000);
    expect(f2.status).toBe("landed");
    expect(await h.mainSha()).not.toBe(before2);
  }, 90_000);
});

// ─── Flow (c): force-land → audit (deterministic, NO spawn) ───────

describe.skipIf(!RUN)("observability E2E (c) — force-land + audit", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeObsHarness();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("force-land an integrating request → landed + synthesized override attempt + exactly one force_land audit row", async () => {
    // Submit via API, then move it to integrating directly (no integrator racing).
    const req = await h.submit(h.workerToken, {
      resource: "main",
      branch: "feature/clean",
      verifyCmd: "exit 0",
    });
    const now = new Date().toISOString();
    h.db
      .update(mergeRequests)
      .set({ status: "integrating", pickedUpAt: now, updatedAt: now })
      .where(eq(mergeRequests.id, req.id))
      .run();

    const overrideSha = "deadbeefcafef00d1234567890abcdef12345678";
    const result = await h.forceLand(req.id, {
      landedSha: overrideSha,
      reason: "e2e breakglass",
    });
    expect(result.status).toBe(200);
    expect(result.data.status).toBe("landed");
    expect(result.data.landedSha).toBe(overrideSha);

    // The synthesized attempt: latest merge_attempt carries the override marker.
    const attempts = h.db
      .select()
      .from(mergeAttempts)
      .where(eq(mergeAttempts.requestId, req.id))
      .all();
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    const latest = attempts.sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
    expect(latest.failureReason ?? "").toContain("force_land override");

    // Exactly one force_land audit row scoped to this request, actor=admin.
    const rows = await h.getAudit(`action=force_land&targetId=${req.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(h.adminId);
    expect(rows[0].reason).toBe("e2e breakglass");
  }, 60_000);
});

// ─── Flow (d): metrics reflect a seeded train (deterministic, NO spawn) ──

describe.skipIf(!RUN)("observability E2E (d) — metrics over a seeded train", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeObsHarness();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("queue_depth / in_flight / verify_success_rate / abandon_rate / time_to_land match the seed exactly", async () => {
    const N_LANDED = 3; // landed in-window (counted for time-to-land + verify pass)
    const M_REJECTED = 2; // rejected in-window
    const K_ABANDONED = 2; // abandoned in-window
    const QUEUED = 2;
    const INTEGRATING = 2;

    const now = Date.now();
    const iso = (ms: number): string => new Date(ms).toISOString();

    // verify_success_rate is computed over merge_attempts (status passed/failed,
    // by completedAt in-window) joined to their request — NOT over request
    // resolution. So a seeded landed request needs a `passed` attempt and a
    // rejected request a `failed` attempt for the rate to count it. attemptVerify
    // controls whether (and how) to seed that attempt.
    function seedRequest(
      status: string,
      opts: {
        enqueuedAt?: string;
        resolvedAt?: string | null;
        attemptVerify?: "passed" | "failed";
      } = {},
    ): string {
      const id = createId();
      const ts = iso(now);
      h.db
        .insert(mergeRequests)
        .values({
          id,
          projectId: h.project.id,
          resource: "main",
          submittedBy: h.workerId,
          status,
          enqueuedAt: opts.enqueuedAt ?? ts,
          resolvedAt: opts.resolvedAt ?? null,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      if (opts.attemptVerify) {
        h.db
          .insert(mergeAttempts)
          .values({
            id: createId(),
            requestId: id,
            attemptNumber: 1,
            baseSha: "0".repeat(40),
            treeSha: opts.attemptVerify === "passed" ? "1".repeat(40) : null,
            status: opts.attemptVerify,
            startedAt: iso(now - 30_000),
            completedAt: iso(now),
            createdAt: ts,
          })
          .run();
      }
      return id;
    }

    // N landed within 24h: enqueuedAt 60s before resolvedAt (well in-window),
    // each with a `passed` verify attempt.
    for (let i = 0; i < N_LANDED; i += 1) {
      seedRequest("landed", {
        enqueuedAt: iso(now - 60_000),
        resolvedAt: iso(now),
        attemptVerify: "passed",
      });
    }
    // M rejected within 24h, each with a `failed` verify attempt.
    for (let i = 0; i < M_REJECTED; i += 1) {
      seedRequest("rejected", {
        enqueuedAt: iso(now - 60_000),
        resolvedAt: iso(now),
        attemptVerify: "failed",
      });
    }
    // K abandoned within 24h (no verify attempt — abandons aren't verify outcomes).
    for (let i = 0; i < K_ABANDONED; i += 1) {
      seedRequest("abandoned", {
        enqueuedAt: iso(now - 60_000),
        resolvedAt: iso(now),
      });
    }
    // Queued + integrating (no resolvedAt).
    for (let i = 0; i < QUEUED; i += 1) seedRequest("queued");
    for (let i = 0; i < INTEGRATING; i += 1) seedRequest("integrating");

    const metrics = await h.getMetrics(h.workerToken);

    // queue_depth === #queued ; in_flight === #integrating.
    expect(metrics.queue_depth).toBe(QUEUED);
    expect(metrics.in_flight).toBe(INTEGRATING);

    // verify_success_rate counts merge_attempts: passed = the N passed attempts
    // (one per landed), total = passed + failed = N landed + M rejected (the K
    // abandons carry no verify attempt, so they're excluded — as designed).
    const vsr = metrics.verify_success_rate as {
      total: number;
      passed: number;
    };
    expect(vsr.total).toBe(N_LANDED + M_REJECTED);
    expect(vsr.passed).toBe(N_LANDED);

    // abandon_rate: abandoned === K ; resolved === landed + rejected + abandoned.
    const ar = metrics.abandon_rate as {
      abandoned: number;
      resolved: number;
    };
    expect(ar.abandoned).toBe(K_ABANDONED);
    expect(ar.resolved).toBe(N_LANDED + M_REJECTED + K_ABANDONED);

    // time_to_land sample_size === #landed in window.
    const ttl = metrics.time_to_land as { sample_size: number };
    expect(ttl.sample_size).toBe(N_LANDED);
  }, 60_000);
});

// ─── Flow (e): force-release unwedges a lock (deterministic, NO spawn) ──

describe.skipIf(!RUN)("observability E2E (e) — force-release a wedged lock", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeObsHarness();
  }, 90_000);
  afterAll(async () => {
    if (h) await h.teardown();
  });

  it("acquire (held) → force-release hard-clears the lock + one force_release_lock audit row", async () => {
    // A lock-holder acquires (worker is the holder).
    const acq = await h.acquireLock(h.workerToken, "main");
    expect(acq.status).toBe("held");

    // Admin force-releases.
    const result = await h.forceRelease("main", { reason: "unwedge" });
    expect(result.status).toBe(200);
    expect(result.data.ok).toBe(true);
    expect(result.data.priorHolderId).toBe(h.workerId);

    // The lock is FREE via DB — the hard-clear set holder/acquired/expires null.
    const lock = h.db
      .select()
      .from(mergeLocks)
      .where(and(eq(mergeLocks.projectId, h.project.id), eq(mergeLocks.resource, "main")))
      .get();
    expect(lock).toBeDefined();
    expect(lock!.holderId).toBeNull();
    expect(lock!.acquiredAt).toBeNull();
    expect(lock!.expiresAt).toBeNull();

    // Exactly one force_release_lock audit row, actor=admin, reason=unwedge.
    const rows = await h.getAudit(`action=force_release_lock&targetId=main`);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(h.adminId);
    expect(rows[0].reason).toBe("unwedge");
  }, 60_000);
});
