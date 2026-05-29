import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  type TestApp,
} from "../utils.js";
import { mergeLocks } from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";

describe("Merge Locks API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── acquire ─────────────────────────────────────────────────────
  describe("POST /api/v1/projects/:projectId/merge-locks/:resource/acquire", () => {
    it("acquires the lock when free", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.ok).toBe(true);
      expect(body.data.status).toBe("held");
      expect(body.data.expiresAt).toBeTruthy();
    });

    it("queues a second caller while the first holds", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: b.token },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("queued");
      expect(body.data.position).toBe(1);
    });

    it("is idempotent for the current holder", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("already_held");
    });

    it("returns 401 when the request is unauthenticated", async () => {
      const project = createTestProject(testApp.db);
      const res = await testApp.app.request(
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { method: "POST" },
      );
      expect(res.status).toBe(401);
    });

    it("returns 404 when the project does not exist", async () => {
      const a = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/does-not-exist/merge-locks/main/acquire`,
        { token: a.token },
      );
      expect(res.status).toBe(404);
    });

    it("rejects an invalid resource slug", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/bad%20name/acquire`,
        { token: a.token },
      );
      expect(res.status).toBe(400);
    });
  });

  // ── heartbeat ───────────────────────────────────────────────────
  describe("POST /api/v1/projects/:projectId/merge-locks/:resource/heartbeat", () => {
    it("refreshes the holder's lease", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);

      const first = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      const firstExpiry = (await first.json()).data.expiresAt as string;
      // Force original expiry to a stale value so we can observe extension.
      testApp.db
        .update(mergeLocks)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(mergeLocks.projectId, project.id))
        .run();

      // Re-acquire to bring the lock into a held state via the holder's
      // path is not the right test — heartbeat must work even close to
      // expiry. Instead, set a near-future expiry, heartbeat, expect
      // extension.
      const newExpiry = new Date(Date.now() + 1000).toISOString();
      testApp.db
        .update(mergeLocks)
        .set({ expiresAt: newExpiry })
        .where(eq(mergeLocks.projectId, project.id))
        .run();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/heartbeat`,
        { token: a.token },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.ok).toBe(true);
      expect(body.data.status).toBe("refreshed");
      const refreshed = new Date(body.data.expiresAt).getTime();
      expect(refreshed).toBeGreaterThan(new Date(newExpiry).getTime());
      expect(refreshed).toBeGreaterThan(new Date(firstExpiry).getTime() - 1);
    });

    it("returns not_holder for a non-holder", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/heartbeat`,
        { token: b.token },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.ok).toBe(false);
      expect(body.data.status).toBe("not_holder");
    });
  });

  // ── release ─────────────────────────────────────────────────────
  describe("POST /api/v1/projects/:projectId/merge-locks/:resource/release", () => {
    it("releases the lock and promotes the queue head", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: b.token },
      );

      const grantedEvents: unknown[] = [];
      getEventBus().on(EVENT_NAMES.MERGE_LOCK_GRANTED, (p) =>
        grantedEvents.push(p),
      );

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/release`,
        { token: a.token, body: {} },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("released");
      expect(body.data.grantedTo).toBe(b.user.id);
      expect(grantedEvents).toHaveLength(1);

      // B is now the holder
      const bView = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: b.token },
      );
      const bBody = await bView.json();
      expect(bBody.data.holder).toBe("you");
    });

    it("records landedSha and the release event carries it", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );

      const released: Array<{ entity: { landedSha?: string } }> = [];
      getEventBus().on(EVENT_NAMES.MERGE_LOCK_RELEASED, (p) =>
        released.push(p as never),
      );

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/release`,
        { token: a.token, body: { landedSha: "abc1234" } },
      );
      expect(res.status).toBe(200);
      expect(released[0]?.entity.landedSha).toBe("abc1234");

      // GET shows landedSha
      const view = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: a.token },
      );
      const body = await view.json();
      expect(body.data.landedSha).toBe("abc1234");
    });

    it("returns not_held when no one holds the lock", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      // Touch the lock so the row exists, then release without acquire.
      await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: a.token },
      );
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/release`,
        { token: a.token },
      );
      const body = await res.json();
      expect(body.data.status).toBe("not_held");
    });

    it("returns not_holder when releasing a lock held by someone else", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/release`,
        { token: b.token },
      );
      const body = await res.json();
      expect(body.data.status).toBe("not_holder");
    });
  });

  // ── expiry sweep ────────────────────────────────────────────────
  describe("lease expiry & sweep", () => {
    it("sweeps an expired holder and auto-promotes the queue head", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: b.token },
      );

      // Force A's lease into the past.
      testApp.db
        .update(mergeLocks)
        .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(mergeLocks.projectId, project.id))
        .run();

      const expired: unknown[] = [];
      const granted: unknown[] = [];
      getEventBus().on(EVENT_NAMES.MERGE_LOCK_EXPIRED, (p) => expired.push(p));
      getEventBus().on(EVENT_NAMES.MERGE_LOCK_GRANTED, (p) => granted.push(p));

      // Any operation triggers sweep — use GET as the cheapest.
      const view = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: b.token },
      );
      const body = await view.json();
      expect(body.data.holder).toBe("you"); // B was promoted
      expect(body.data.queueLength).toBe(0);
      expect(expired).toHaveLength(1);
      expect(granted).toHaveLength(1);
    });
  });

  // ── isolation ───────────────────────────────────────────────────
  describe("isolation between resources / projects", () => {
    it("separate resource names within one project are independent", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);

      const main = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      const release = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/release-branch/acquire`,
        { token: b.token },
      );
      expect((await main.json()).data.status).toBe("held");
      expect((await release.json()).data.status).toBe("held");
    });

    it("separate projects don't interfere", async () => {
      const p1 = createTestProject(testApp.db);
      const p2 = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);

      const r1 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${p1.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      const r2 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${p2.id}/merge-locks/main/acquire`,
        { token: b.token },
      );
      expect((await r1.json()).data.status).toBe("held");
      expect((await r2.json()).data.status).toBe("held");
    });
  });

  // ── list ────────────────────────────────────────────────────────
  describe("GET /api/v1/projects/:projectId/merge-locks", () => {
    it("lists locks for a project", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/release-branch`,
        { token: a.token },
      );

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks`,
        { token: a.token },
      );
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });
  });

  // ── view masks identity ────────────────────────────────────────
  describe("GET /api/v1/projects/:projectId/merge-locks/:resource", () => {
    it("reports the holder as 'someone_else' when held by another", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: b.token },
      );
      const body = await res.json();
      expect(body.data.holder).toBe("someone_else");
      expect(body.data.holderId).toBeNull(); // not leaked
    });

    it("reports 'none' when the lock is free", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: a.token },
      );
      const body = await res.json();
      expect(body.data.holder).toBe("none");
      expect(body.data.queueLength).toBe(0);
    });
  });

  // ── landing intent ──────────────────────────────────────────────
  describe("landing intent", () => {
    it("acquire with intent surfaces fields on the held state", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: a.user.id,
        assigneeId: a.user.id,
      });

      const acq = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        {
          token: a.token,
          body: {
            taskId: task.id,
            branch: "feat/skinning",
            commitSha: "abc1234",
            verifyCmd: "cargo test --workspace",
            worktreePath: "D:\\work\\skin",
          },
        },
      );
      expect(acq.status).toBe(200);

      const view = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: a.token },
      );
      const body = await view.json();
      expect(body.data.taskId).toBe(task.id);
      expect(body.data.branch).toBe("feat/skinning");
      expect(body.data.commitSha).toBe("abc1234");
      expect(body.data.verifyCmd).toBe("cargo test --workspace");
      expect(body.data.worktreePath).toBe("D:\\work\\skin");
    });

    it("intent is observable by other agents (not masked like holderId)", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token, body: { branch: "feat/skinning" } },
      );
      const view = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: b.token },
      );
      const body = await view.json();
      expect(body.data.holder).toBe("someone_else");
      expect(body.data.holderId).toBeNull(); // identity still masked
      expect(body.data.branch).toBe("feat/skinning"); // intent visible
    });

    it("queued caller's intent is promoted onto the held state on grant", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token, body: { branch: "feat/skinning" } },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: b.token, body: { branch: "fix/anim-blend" } },
      );

      // A releases without landing
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/release`,
        { token: a.token, body: { reason: "verify failed" } },
      );

      // B is now the holder — their queue intent is surfaced
      const view = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: b.token },
      );
      const body = await view.json();
      expect(body.data.holder).toBe("you");
      expect(body.data.branch).toBe("fix/anim-blend");
    });

    it("re-acquire while holding updates the intent (e.g. new commit_sha)", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token, body: { commitSha: "abc1234" } },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token, body: { commitSha: "def5678" } },
      );
      const view = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: a.token },
      );
      const body = await view.json();
      expect(body.data.commitSha).toBe("def5678");
    });

    it("intent is cleared on release", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token, body: { branch: "feat/skinning" } },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/release`,
        { token: a.token, body: { landedSha: "abc1234" } },
      );
      const view = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: a.token },
      );
      const body = await view.json();
      expect(body.data.branch).toBeNull();
      expect(body.data.landedSha).toBe("abc1234");
    });

    it("rejects acquire with taskId from another project", async () => {
      const p1 = createTestProject(testApp.db);
      const p2 = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const otherProjectTask = createTestTask(testApp.db, {
        projectId: p2.id,
        reporterId: a.user.id,
      });
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${p1.id}/merge-locks/main/acquire`,
        { token: a.token, body: { taskId: otherProjectTask.id } },
      );
      expect(res.status).toBe(400);
    });
  });

  // ── abandon flow ────────────────────────────────────────────────
  describe("abandon flow", () => {
    it("release without landedSha stores abandon_reason and carries it on event", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );

      const released: Array<{
        entity: { abandonReason?: string | null; landedSha?: string | null };
      }> = [];
      getEventBus().on(EVENT_NAMES.MERGE_LOCK_RELEASED, (p) =>
        released.push(p as never),
      );

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/release`,
        {
          token: a.token,
          body: { reason: "verify failed: skinned_renderer.cpp API drift" },
        },
      );
      expect(res.status).toBe(200);
      expect(released[0]?.entity.abandonReason).toBe(
        "verify failed: skinned_renderer.cpp API drift",
      );
      expect(released[0]?.entity.landedSha).toBeNull();
    });

    it("abandon_reason persists on the lock for the next holder to see", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: b.token },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/release`,
        { token: a.token, body: { reason: "build broke" } },
      );

      // B is now the holder — they should still see why A bailed
      const view = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: b.token },
      );
      const body = await view.json();
      expect(body.data.holder).toBe("you");
      expect(body.data.abandonReason).toBe("build broke");
    });

    it("release with landedSha + reason drops the reason (a land has no failure)", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/release`,
        {
          token: a.token,
          body: { landedSha: "abc1234", reason: "should be ignored" },
        },
      );
      expect(res.status).toBe(200);

      const view = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: a.token },
      );
      const body = await view.json();
      expect(body.data.landedSha).toBe("abc1234");
      expect(body.data.abandonReason).toBeNull();
    });

    it("fresh acquire after an abandon clears the prior reason", async () => {
      const project = createTestProject(testApp.db);
      const a = createTestAiAgent(testApp.db);
      const b = createTestAiAgent(testApp.db);

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: a.token },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/release`,
        { token: a.token, body: { reason: "first attempt failed" } },
      );

      // No queue head — lock is free, abandon_reason is preserved on the row.
      // B comes along fresh, acquires — gets a clean slate.
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/merge-locks/main/acquire`,
        { token: b.token },
      );
      const view = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/merge-locks/main`,
        { token: b.token },
      );
      const body = await view.json();
      expect(body.data.abandonReason).toBeNull();
    });
  });
});
