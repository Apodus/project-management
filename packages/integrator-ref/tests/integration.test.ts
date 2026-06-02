/**
 * Full-stack END-TO-END regression net for the worker/integrator split.
 *
 * This boots a REAL PM server in-process (via @hono/node-server's `serve`)
 * backed by a file-based SQLite database the TEST PROCESS owns, then spawns
 * the BUILT integrator (`node dist/index.js`) as a SEPARATE process that talks
 * to it over pure HTTP. A real temp bare git remote provides the merge target.
 *
 * It covers four flows end to end:
 *   1. Land    — a clean branch that passes verify advances `main`.
 *   2. Reject  — a branch whose verify fails leaves `main` untouched and posts a
 *                `merge_rejection` comment.
 *   3. Queue   — two requests land FIFO (earlier enqueuedAt → earlier pickedUpAt).
 *   4. Cancel  — a queued request is cancelled while the integrator is starved on
 *                the Stage-1 lock; after the lock releases the integrator skips it.
 *
 * ── Architecture notes (verified) ────────────────────────────────────────────
 * - The test process owns the ONLY SQLite connection. Merge outcomes are asserted
 *   via direct-DB reads and HTTP GETs — never via SSE data.
 * - SSE is used ONLY to assert event-NAME ordering. The `/api/v1/events` frame is
 *   FLAT: the dotted event name is on the `event:` line and the request id is
 *   `entity_id` (snake_case) inside the `data:` JSON. There is no nested entity.
 * - Cross-package imports use RELATIVE SOURCE paths because `@pm/server`'s package
 *   `exports` does not re-export `createApp`, the DB handle, the tables, or the
 *   test-util factories. The integrator-ref tsconfig only typechecks `src/`
 *   (`"include": ["src"]`), so these cross-boundary test imports do NOT break
 *   `pnpm typecheck`. Vitest transforms the test independently.
 *
 * GATING: runs iff git is available AND the integrator dist exists. Build with
 *   pnpm --filter @pm/shared build
 *   pnpm --filter @pm/server build
 *   pnpm --filter @apodus/pm-integrator build
 *
 * ── Phase 7.2 Step 9 batch-of-one invariant (DO NOT silently break) ──────────
 * As of Step 9 the spawned integrator (`dist/index.js`) drives `runBatchLoop`,
 * NOT 7.1's serial `runLoop`. This E2E is the regression net proving the rewire
 * preserves 7.1 observable behavior. It relies on TWO invariants:
 *   1. `config.parallelism` defaults to 1 (config.ts: `ic.parallelism ?? 1`),
 *      and the spawn env below does NOT set a project `parallelism` setting —
 *      so the pool is size 1 and every batch is a BATCH-OF-ONE.
 *   2. runBatchOnce drains ALL currently-queued requests per single lock
 *      acquisition. At parallelism:1 this is one member at a time, FIFO,
 *      byte-identical to the serial loop (acquire → pickup → … → land →
 *      release, then re-list). Flow 3 (two queued → FIFO) exercises the
 *      multi-iteration drain at batch-of-one.
 * If a future change raises the default parallelism (or the spawn raises it),
 * Flow 4 (cancel-while-lock-starved) and the FIFO timing in Flow 3 can change
 * shape — re-validate this file before changing that default.
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
  mergeAttempts,
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

// Belt-and-suspenders: never leak the spawned integrator even if afterAll is
// skipped (e.g. a beforeAll throw). Module-level so the exit hook can see it.
let proc: ChildProcess | undefined;
process.on("exit", () => {
  try {
    if (proc?.pid && proc.exitCode === null) proc.kill("SIGKILL");
  } catch {
    /* ignore */
  }
});

// ─── Standalone config-failure check (no server / git needed) ─────

describe.skipIf(!distExists)("integrator config failure", () => {
  it("exits with code 2 on missing project id", async () => {
    const p = spawn("node", [distPath, "--resource", "main"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PM_API_TOKEN: "dummy", PM_PROJECT_ID: "" },
    });
    let stderr = "";
    p.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    const [code] = (await once(p, "exit")) as [number | null, ...unknown[]];
    expect(code).toBe(2);
    void stderr;
  }, 15_000);
});

// ─── Full-stack E2E ───────────────────────────────────────────────

describe.skipIf(!RUN)("integrator full-stack E2E", () => {
  let tmpRoot: string;
  let bareRepo: string;
  let db: AppDatabase;
  let server: ServerType;
  let baseUrl: string;

  let project: { id: string; slug: string };
  let integratorToken: string;
  let workerToken: string;
  let lockHolderToken: string;

  // ── Git fixture: bare remote + author clone with feature branches. ──
  async function setupGitFixture(): Promise<string> {
    const bare = path.join(tmpRoot, "bare.git");
    const author = path.join(tmpRoot, "author");

    await simpleGit().init(["--bare", "--initial-branch=main", bare]);
    await simpleGit().clone(bare, author);
    const g = simpleGit(author);
    await g.addConfig("user.email", "int@test.local");
    await g.addConfig("user.name", "Integrator Test");
    await g.addConfig("commit.gpgsign", "false");

    // main / base.txt
    writeFileSync(path.join(author, "base.txt"), "base\n");
    await g.add(["base.txt"]);
    await g.commit("initial");
    await g.branch(["-M", "main"]);
    await g.push(["-u", "origin", "main"]);

    // Each feature branch touches a DISTINCT file so no branch is a no-op and
    // none conflict with each other when rebased onto a moved main.
    const branches: Array<{ name: string; file: string; bad?: boolean }> = [
      { name: "feature/clean", file: "clean.txt" },
      { name: "feature/q1", file: "q1.txt" },
      { name: "feature/q2", file: "q2.txt" },
      { name: "feature/q-cancel", file: "q-cancel.txt" },
      { name: "feature/bad", file: "bad.txt", bad: true },
    ];
    for (const b of branches) {
      await g.checkout("main");
      await g.checkoutLocalBranch(b.name);
      writeFileSync(path.join(author, b.file), `${b.name}\n`);
      await g.add([b.file]);
      await g.commit(`add ${b.file}`);
      await g.push(["-u", "origin", b.name]);
    }
    await g.checkout("main");
    return bare;
  }

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "pm-e2e-"));
    bareRepo = await setupGitFixture();

    // ── In-process PM server (test owns the only DB connection). ──
    const dbPath = path.join(tmpRoot, "pm.db");
    db = initializeDatabase({ dbPath });
    const app = createApp();
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    // Wait for the underlying http.Server to be listening.
    await once(server, "listening");
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // ── Seed identities. ──
    integratorToken = createTestAiAgent(db, { username: "integrator" }).token;
    workerToken = createTestAiAgent(db, { username: "worker" }).token;
    lockHolderToken = createTestAiAgent(db, { username: "lock-holder" }).token;

    // ── Seed project with integrator settings + a clonable repo URL. ──
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
        },
      },
    });
    project = { id: proj.id, slug: proj.slug };
    db.update(projects)
      .set({ gitRepoUrl: bareRepo })
      .where(eq(projects.id, project.id))
      .run();

    // ── Spawn the built integrator (separate process, HTTP only). ──
    proc = spawn(
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
        "2",
        "--log-level",
        "error",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PM_API_TOKEN: integratorToken },
      },
    );
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
      proc?.once("exit", (code) => {
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
  }, 60_000);

  afterAll(async () => {
    try {
      if (proc && proc.exitCode === null) {
        proc.kill("SIGTERM");
        await Promise.race([once(proc, "exit"), sleep(5000)]);
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
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
  });

  // ── HTTP + git helpers ──────────────────────────────────────────

  interface MergeRequest {
    id: string;
    status: string;
    landedSha: string | null;
    rejectCategory: string | null;
    enqueuedAt: string;
    pickedUpAt: string | null;
  }

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

  const TERMINAL = new Set(["landed", "rejected", "abandoned"]);

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

  // SSE collector: parse `event:` names + `entity_id` from `data:`.
  interface SseEvent {
    event: string;
    entity_id: string | null;
  }
  function collectSse(token: string): {
    stop: (graceMs: number) => Promise<SseEvent[]>;
  } {
    const controller = new AbortController();
    const events: SseEvent[] = [];
    let buffer = "";
    const done = (async () => {
      const res = await fetch(
        `${baseUrl}/api/v1/events?project_id=${project.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        },
      );
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done: rdone } = await reader.read();
          if (rdone) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let name: string | null = null;
            let entityId: string | null = null;
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) {
                name = line.slice("event:".length).trim();
              } else if (line.startsWith("data:")) {
                try {
                  const data = JSON.parse(line.slice("data:".length).trim());
                  if (typeof data.entity_id === "string")
                    entityId = data.entity_id;
                } catch {
                  /* non-JSON data line */
                }
              }
            }
            if (name) events.push({ event: name, entity_id: entityId });
          }
        }
      } catch {
        // aborted — expected
      }
    })();
    return {
      stop: async (graceMs: number) => {
        await sleep(graceMs);
        controller.abort();
        await done.catch(() => {});
        return events;
      },
    };
  }

  // ── Flow 1: Land ────────────────────────────────────────────────
  it("Flow 1 — lands a clean branch and advances main", async () => {
    const task = createTestTask(db, { projectId: project.id });
    const before = await mainSha();
    const sse = collectSse(workerToken);
    await sleep(300); // let the SSE connection establish before pickup events fire

    const req = await submit(workerToken, {
      resource: "main",
      branch: "feature/clean",
      taskId: task.id,
      verifyCmd: "exit 0",
    });

    const final = await pollTerminal(req.id);
    expect(final.status).toBe("landed");
    expect(final.landedSha).toBeTruthy();

    const after = await mainSha();
    expect(after).not.toBe(before);
    expect(after).toBe(final.landedSha);

    // Direct-DB: landed_sha git ref attached to the task.
    const refs = db
      .select()
      .from(gitRefs)
      .where(
        and(eq(gitRefs.taskId, task.id), eq(gitRefs.refType, "landed_sha")),
      )
      .all();
    expect(refs.length).toBe(1);
    expect(refs[0].refValue).toBe(final.landedSha);

    // SSE: integrating precedes landed for this request.
    const events = await sse.stop(500);
    const mine = events.filter((e) => e.entity_id === req.id).map((e) => e.event);
    const iIdx = mine.indexOf("merge.request.integrating");
    const lIdx = mine.indexOf("merge.request.landed");
    expect(iIdx).toBeGreaterThanOrEqual(0);
    expect(lIdx).toBeGreaterThanOrEqual(0);
    expect(iIdx).toBeLessThan(lIdx);
  }, 40_000);

  // ── Flow 2: Reject ──────────────────────────────────────────────
  it("Flow 2 — rejects on verify failure, main unchanged, posts comment", async () => {
    const task = createTestTask(db, { projectId: project.id });
    const before = await mainSha();

    const req = await submit(workerToken, {
      resource: "main",
      branch: "feature/bad",
      taskId: task.id,
      verifyCmd: "exit 1",
    });

    const final = await pollTerminal(req.id);
    expect(final.status).toBe("rejected");
    expect(final.rejectCategory).not.toBeNull();

    const after = await mainSha();
    expect(after).toBe(before);

    const rejComments = db
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
  }, 40_000);

  // ── Flow 3: Queue ordering (FIFO) ───────────────────────────────
  it("Flow 3 — drains two queued requests in FIFO order", async () => {
    const task1 = createTestTask(db, { projectId: project.id });
    const task2 = createTestTask(db, { projectId: project.id });

    const req1 = await submit(workerToken, {
      resource: "main",
      branch: "feature/q1",
      taskId: task1.id,
      verifyCmd: "exit 0",
    });
    const req2 = await submit(workerToken, {
      resource: "main",
      branch: "feature/q2",
      taskId: task2.id,
      verifyCmd: "exit 0",
    });

    const final1 = await pollTerminal(req1.id);
    const final2 = await pollTerminal(req2.id);
    expect(final1.status).toBe("landed");
    expect(final2.status).toBe("landed");

    // FIFO: earlier enqueuedAt → earlier pickedUpAt.
    const [early, late] =
      final1.enqueuedAt <= final2.enqueuedAt
        ? [final1, final2]
        : [final2, final1];
    expect(early.pickedUpAt).toBeTruthy();
    expect(late.pickedUpAt).toBeTruthy();
    expect(
      new Date(early.pickedUpAt!).getTime(),
    ).toBeLessThanOrEqual(new Date(late.pickedUpAt!).getTime());

    // The last-landed SHA is the current tip of main.
    expect(await mainSha()).toBe(late.landedSha);
  }, 50_000);

  // ── Flow 4: Cancel (deterministic via lock starvation) ──────────
  it("Flow 4 — cancelled request is skipped by the integrator", async () => {
    const task = createTestTask(db, { projectId: project.id });
    const before = await mainSha();

    // Hold the Stage-1 lock so the integrator can never pick up the request.
    const acquire = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/merge-locks/main/acquire`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lockHolderToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(acquire.status).toBe(200);
    expect((await acquire.json()).data.status).toBe("held");

    const req = await submit(workerToken, {
      resource: "main",
      branch: "feature/q-cancel",
      taskId: task.id,
      verifyCmd: "exit 0",
    });

    // Cancel immediately (queued → abandoned) while the integrator is starved.
    const cancel = await fetch(
      `${baseUrl}/api/v1/merge-requests/${req.id}/cancel`,
      { method: "POST", headers: { Authorization: `Bearer ${workerToken}` } },
    );
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).data.status).toBe("abandoned");

    // Release the lock; the integrator wakes, lists queued (finds none), skips.
    const release = await fetch(
      `${baseUrl}/api/v1/projects/${project.id}/merge-locks/main/release`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lockHolderToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(release.status).toBe(200);

    await sleep(3000);

    const final = await getRequest(req.id);
    expect(final.status).toBe("abandoned");
    expect(await mainSha()).toBe(before);

    // No attempts were ever started for this request.
    const attempts = db
      .select()
      .from(mergeAttempts)
      .where(eq(mergeAttempts.requestId, req.id))
      .all();
    expect(attempts.length).toBe(0);
  }, 40_000);
});
