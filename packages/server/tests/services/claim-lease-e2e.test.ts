import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  CLAIM_LEASE_RECLAIMED_EVENT,
  LEASE_GRACE_MS_DEFAULT,
  LEASE_TTL_MS_DEFAULT,
} from "@pm/shared";
import {
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { auditLog, claimLeases, tasks } from "../../src/db/index.js";
import { getEventBus, type EventName } from "../../src/events/event-bus.js";
import type { AuthUser } from "../../src/types.js";
import * as taskSvc from "../../src/services/task.service.js";
import * as claimLeaseSvc from "../../src/services/claim-lease.service.js";

// ──────────────────────────────────────────────────────────────────
// Campaign C2 (claim-lease §P5): the full-lifecycle e2e — claim →
// renew-on-action → lapse → mode-`on` reclaim (entity cleared, lease
// gone, exactly one audit + one SSE) → self-stale renew-never-409 —
// all through the REAL service paths (taskSvc.claim/update +
// claimLeaseSvc.sweepStaleClaims), not the pure-mechanics seams.
// ──────────────────────────────────────────────────────────────────

describe("claim-lease end-to-end lifecycle (P5)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    vi.useRealTimers();
    testApp.cleanup();
  });

  function leaseRow(entityType: string, entityId: string) {
    return testApp.db
      .select()
      .from(claimLeases)
      .where(
        and(
          eq(claimLeases.entityType, entityType),
          eq(claimLeases.entityId, entityId),
        ),
      )
      .get();
  }

  function auditRows(targetId: string) {
    return testApp.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, targetId))
      .all();
  }

  function taskRow(id: string) {
    return testApp.db.select().from(tasks).where(eq(tasks.id, id)).get();
  }

  function aiActor(id: string): AuthUser {
    return {
      id,
      username: `ai-${id.slice(-4)}`,
      displayName: "AI",
      role: "member",
      type: "ai_agent",
    };
  }

  // ── Headline: the whole lease lifecycle through real paths ─────────
  it("claim → renew-on-action → lapse → mode-on reclaim → self-stale renew (no 409)", () => {
    const t0 = new Date("2026-06-06T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(t0);

    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });

    // 1. Claim through the real path → lease held by A, entity assigned to A.
    expect(taskSvc.claim(task.id, aiActor(a.user.id)).ok).toBe(true);
    const claimed = leaseRow("task", task.id)!;
    expect(claimed.holderId).toBe(a.user.id);
    expect(taskRow(task.id)!.assigneeId).toBe(a.user.id);

    // 2. ~5 min later (within TTL) a holder write renews — same lease id,
    //    expiry advanced.
    const t1 = new Date(t0.getTime() + 5 * 60_000);
    vi.setSystemTime(t1);
    taskSvc.update(task.id, { title: "renewed" }, aiActor(a.user.id));
    const renewed = leaseRow("task", task.id)!;
    expect(renewed.id).toBe(claimed.id);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(
      Date.parse(claimed.expiresAt),
    );

    // 3. Lapse past TTL + grace (+60s).
    const later = new Date(
      t1.getTime() + LEASE_TTL_MS_DEFAULT + LEASE_GRACE_MS_DEFAULT + 60_000,
    );

    // 4. Register the reclaim listener, then sweep mode `on` for this task.
    let reclaimedEvents = 0;
    getEventBus().on(CLAIM_LEASE_RECLAIMED_EVENT as EventName, () => {
      reclaimedEvents += 1;
    });

    const result = claimLeaseSvc.sweepStaleClaims({
      entityType: "task",
      entityId: task.id,
      mode: "on",
      now: later,
    });

    expect(result.reclaimed).toHaveLength(1);
    expect(result.reclaimed[0]).toMatchObject({
      entityType: "task",
      entityId: task.id,
      holderId: a.user.id,
    });

    // The lease is gone and the entity holder cleared.
    expect(leaseRow("task", task.id)).toBeUndefined();
    expect(taskRow(task.id)!.assigneeId).toBeNull();

    // Exactly one claim_reclaimed audit row, before/after honest.
    const audits = auditRows(task.id).filter(
      (r) => r.action === "claim_reclaimed",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].targetType).toBe("task");
    expect(audits[0].metadataBefore).toEqual({ assignee_id: a.user.id });
    expect(audits[0].metadataAfter).toEqual({ assignee_id: null });

    // Exactly one reclaim SSE event.
    expect(reclaimedEvents).toBe(1);

    // 5. Self-stale leg: a fresh task claimed by C, lapsed past TTL+grace,
    //    then C's own write must NOT throw and must heal its lease forward.
    const c = createTestAiAgent(testApp.db);
    vi.setSystemTime(t0);
    const task2 = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });
    expect(taskSvc.claim(task2.id, aiActor(c.user.id)).ok).toBe(true);
    const beforeSelfStale = leaseRow("task", task2.id)!;

    const lapsed = new Date(
      t0.getTime() + LEASE_TTL_MS_DEFAULT + LEASE_GRACE_MS_DEFAULT + 60_000,
    );
    vi.setSystemTime(lapsed);

    expect(() =>
      taskSvc.update(task2.id, { title: "still mine" }, aiActor(c.user.id)),
    ).not.toThrow();

    const afterSelfStale = leaseRow("task", task2.id)!;
    expect(afterSelfStale.holderId).toBe(c.user.id);
    expect(Date.parse(afterSelfStale.expiresAt)).toBeGreaterThan(
      Date.parse(beforeSelfStale.expiresAt),
    );
  });
});
