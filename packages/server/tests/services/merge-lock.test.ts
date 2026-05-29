import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestAiAgent,
  createTestApp,
  createTestProject,
  type TestApp,
} from "../utils.js";
import { mergeLocks, mergeLockQueue } from "../../src/db/index.js";
import * as svc from "../../src/services/merge-lock.service.js";

describe("merge-lock service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("creates the lock row lazily on first acquire", async () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);

    expect(
      testApp.db
        .select()
        .from(mergeLocks)
        .where(eq(mergeLocks.projectId, project.id))
        .all(),
    ).toHaveLength(0);

    svc.acquire(project.id, "main", { id: a.user.id });

    expect(
      testApp.db
        .select()
        .from(mergeLocks)
        .where(eq(mergeLocks.projectId, project.id))
        .all(),
    ).toHaveLength(1);
  });

  it("acquire is race-safe — only one caller wins from the same starting state", async () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const b = createTestAiAgent(testApp.db);

    // Same starting state — neither has acquired yet.
    const r1 = svc.acquire(project.id, "main", { id: a.user.id });
    const r2 = svc.acquire(project.id, "main", { id: b.user.id });

    expect(r1.status).toBe("held");
    expect(r2.status).toBe("queued");
    expect(r2.position).toBe(1);
  });

  it("queue position reflects FIFO order", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const b = createTestAiAgent(testApp.db);
    const c = createTestAiAgent(testApp.db);

    svc.acquire(project.id, "main", { id: a.user.id });
    const r2 = svc.acquire(project.id, "main", { id: b.user.id });
    const r3 = svc.acquire(project.id, "main", { id: c.user.id });

    expect(r2.position).toBe(1);
    expect(r3.position).toBe(2);
  });

  it("queue join is idempotent for the same caller", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const b = createTestAiAgent(testApp.db);

    svc.acquire(project.id, "main", { id: a.user.id });
    svc.acquire(project.id, "main", { id: b.user.id });
    svc.acquire(project.id, "main", { id: b.user.id });

    const lock = testApp.db
      .select()
      .from(mergeLocks)
      .where(eq(mergeLocks.projectId, project.id))
      .get()!;
    const queue = testApp.db
      .select()
      .from(mergeLockQueue)
      .where(eq(mergeLockQueue.lockId, lock.id))
      .all();
    expect(queue).toHaveLength(1);
  });

  it("sweep evicts an expired holder and promotes the queue head", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const b = createTestAiAgent(testApp.db);

    svc.acquire(project.id, "main", { id: a.user.id });
    svc.acquire(project.id, "main", { id: b.user.id });

    // Force A's lease into the past.
    testApp.db
      .update(mergeLocks)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(mergeLocks.projectId, project.id))
      .run();

    const view = svc.getLock(project.id, "main", { id: b.user.id });
    expect(view.holder).toBe("you");
    expect(view.queueLength).toBe(0);
  });

  it("release without queue leaves the lock free", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);

    svc.acquire(project.id, "main", { id: a.user.id });
    const r = svc.release(project.id, "main", { id: a.user.id });
    expect(r.status).toBe("released");
    expect(r.grantedTo).toBeNull();

    const lock = testApp.db
      .select()
      .from(mergeLocks)
      .where(eq(mergeLocks.projectId, project.id))
      .get()!;
    expect(lock.holderId).toBeNull();
  });

  it("heartbeat extends expiresAt", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);

    const acq = svc.acquire(project.id, "main", { id: a.user.id });
    const originalExpiry = acq.expiresAt as string;

    // Set expiry to a near future point so we can verify extension.
    const near = new Date(Date.now() + 500).toISOString();
    testApp.db
      .update(mergeLocks)
      .set({ expiresAt: near })
      .where(eq(mergeLocks.projectId, project.id))
      .run();

    const hb = svc.heartbeat(project.id, "main", { id: a.user.id });
    expect(hb.status).toBe("refreshed");
    expect(new Date(hb.expiresAt as string).getTime()).toBeGreaterThan(
      new Date(near).getTime(),
    );
    // And meaningfully extended (roughly back to LEASE_TTL).
    expect(new Date(hb.expiresAt as string).getTime()).toBeGreaterThan(
      new Date(originalExpiry).getTime() - 1000,
    );
  });
});
