import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  CLAIM_LEASE_RECLAIMED_EVENT,
  LEASE_PICK_MARGIN_MS_DEFAULT,
  LEASE_TTL_MS_DEFAULT,
} from "@pm/shared";
import {
  createTestAiAgent,
  createTestProject,
  createTestTask,
  createTestUser,
  type TestApp,
  createTestApp,
} from "../utils.js";
import { auditLog, claimLeases, tasks } from "../../src/db/index.js";
import { getEventBus } from "../../src/events/event-bus.js";
import type { AuthUser } from "../../src/types.js";
import * as taskSvc from "../../src/services/task.service.js";

// ──────────────────────────────────────────────────────────────────
// pickNextTask acts on liveness.
//
//   Phase A — prefer fresh, UNASSIGNED ready work. Phase B (when A found
//   nothing) — reclaim-then-claim a STALE-CLAIMED ready task whose lease
//   has lapsed past TTL + grace + pick-margin. The lease engine is always
//   active, so Phase B is unconditional. A pick NEVER stomps a live lease.
//
// The now/graceMs knobs are an INTERNAL override (3rd arg), reached here
// directly — they are structurally unreachable from wire input.
// ──────────────────────────────────────────────────────────────────

describe("pickNextTask liveness (C3.P3)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    vi.useRealTimers();
    testApp.cleanup();
  });

  function aiActor(id: string): AuthUser {
    return {
      id,
      username: `ai-${id.slice(-4)}`,
      displayName: "AI",
      role: "member",
      type: "ai_agent",
    };
  }

  function leaseRow(entityId: string) {
    return testApp.db
      .select()
      .from(claimLeases)
      .where(and(eq(claimLeases.entityType, "task"), eq(claimLeases.entityId, entityId)))
      .get();
  }

  function taskRow(id: string) {
    return testApp.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
  }

  function reclaimAuditCount(targetId: string) {
    return testApp.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "claim_reclaimed"), eq(auditLog.targetId, targetId)))
      .all().length;
  }

  // Count CLAIM_LEASE_RECLAIMED SSE events while running `fn`. The event-bus
  // listeners are reset per-test (cleanup → resetEventBus), so a fresh counter
  // is registered here and torn down between tests.
  function withReclaimCounter<T>(fn: (count: () => number) => T): T {
    let reclaimed = 0;
    getEventBus().on(CLAIM_LEASE_RECLAIMED_EVENT as never, () => {
      reclaimed += 1;
    });
    return fn(() => reclaimed);
  }

  const T0 = new Date("2026-06-06T10:00:00.000Z");

  // Arm a stale-claimed READY task: A claims it at t0 (lease expiry = t0 + TTL),
  // then the clock is advanced so the lease lapses. The task stays `ready` +
  // assigned (claim sets assignee, not status) — the Phase B candidate shape.
  function makeStaleReadyTask(opts?: { projectId?: string; holderId?: string }) {
    const projectId = opts?.projectId ?? createTestProject(testApp.db).id;
    const reporter = createTestUser(testApp.db);
    const holderId = opts?.holderId ?? createTestAiAgent(testApp.db).user.id;
    const task = createTestTask(testApp.db, {
      projectId,
      reporterId: reporter.id,
      status: "ready",
    });
    taskSvc.claim(task.id, aiActor(holderId)); // arms the lease at the current clock
    return { task, projectId, holderId };
  }

  // ── 1. mode=on SKIPS a live-claimed ready task (fresh lease) ──────
  it("mode=on does not grab a live-claimed ready task (fresh lease) — no reclaim", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const { task, holderId } = makeStaleReadyTask();

    // Picker runs while the lease is still fresh (well inside TTL).
    const picker = createTestAiAgent(testApp.db);
    const now = new Date(T0.getTime() + 60_000); // 1 min later — lease live

    const result = withReclaimCounter((count) => {
      const r = taskSvc.pickNextTask(aiActor(picker.user.id), undefined, {
        now,
        graceMs: 0,
      });
      expect(count()).toBe(0);
      return r;
    });

    expect(result).toBeNull();
    expect(taskRow(task.id).assigneeId).toBe(holderId);
    expect(leaseRow(task.id)!.holderId).toBe(holderId);
    expect(reclaimAuditCount(task.id)).toBe(0);
  });

  // ── 2. mode=on RECLAIMS + CLAIMS a stale-claimed ready task ───────
  it("mode=on reclaims and claims a stale-claimed ready task — one audit + one SSE", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const { task, holderId } = makeStaleReadyTask();

    const picker = createTestAiAgent(testApp.db);
    // graceMs=0 → stale once now > expiry + margin. Go well past.
    const now = new Date(
      T0.getTime() + LEASE_TTL_MS_DEFAULT + LEASE_PICK_MARGIN_MS_DEFAULT + 60_000,
    );

    const result = withReclaimCounter((count) => {
      const r = taskSvc.pickNextTask(aiActor(picker.user.id), undefined, {
        now,
        graceMs: 0,
      });
      expect(count()).toBe(1);
      return r;
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe(task.id);

    const row = taskRow(task.id);
    expect(row.assigneeId).toBe(picker.user.id);
    expect(row.status).toBe("in_progress");
    expect(row.startedAt).not.toBeNull();
    expect(holderId).not.toBe(picker.user.id);

    // Exactly one reclaim audit row, and the lease is now held by the picker.
    expect(reclaimAuditCount(task.id)).toBe(1);
    expect(leaseRow(task.id)!.holderId).toBe(picker.user.id);
  });

  // ── 3. Two concurrent pickers on one stale task → exactly one wins ─
  it("two pickers race one stale task — exactly one wins, exactly one reclaim", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const { task } = makeStaleReadyTask();

    const p1 = createTestAiAgent(testApp.db);
    const p2 = createTestAiAgent(testApp.db);
    const now = new Date(
      T0.getTime() + LEASE_TTL_MS_DEFAULT + LEASE_PICK_MARGIN_MS_DEFAULT + 60_000,
    );

    const { r1, r2, total } = withReclaimCounter((count) => {
      const a = taskSvc.pickNextTask(aiActor(p1.user.id), undefined, {
        now,
        graceMs: 0,
      });
      const b = taskSvc.pickNextTask(aiActor(p2.user.id), undefined, {
        now,
        graceMs: 0,
      });
      return { r1: a, r2: b, total: count() };
    });

    // Exactly one picker got the task.
    const winners = [r1, r2].filter((x) => x !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe(task.id);

    const row = taskRow(task.id);
    expect([p1.user.id, p2.user.id]).toContain(row.assigneeId);
    expect(row.status).toBe("in_progress");

    // The second picker, finding the (now reclaimed + claimed) task no longer a
    // lapsed-and-assignable candidate, reclaims nothing.
    expect(total).toBe(1);
    expect(reclaimAuditCount(task.id)).toBe(1);
  });

  // ── 5. Barely-stale within the pick margin → does NOT grab ────────
  it("a barely-stale lease (past grace, within grace+margin) is NOT grabbed in mode=on", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const { task, holderId } = makeStaleReadyTask();

    const picker = createTestAiAgent(testApp.db);
    // graceMs=0 → reclaim-grace boundary is exactly expiry (t0 + TTL). Land the
    // clock PAST expiry but WITHIN the extra pick margin (30s of 60s).
    const expiry = T0.getTime() + LEASE_TTL_MS_DEFAULT;
    const now = new Date(expiry + LEASE_PICK_MARGIN_MS_DEFAULT / 2);

    const result = withReclaimCounter((count) => {
      const r = taskSvc.pickNextTask(aiActor(picker.user.id), undefined, {
        now,
        graceMs: 0,
      });
      expect(count()).toBe(0);
      return r;
    });

    expect(result).toBeNull();
    expect(taskRow(task.id).assigneeId).toBe(holderId);
    expect(leaseRow(task.id)!.holderId).toBe(holderId);
    expect(reclaimAuditCount(task.id)).toBe(0);
  });

  // ── 6. claimed, NO lease row → not a Phase B candidate ───────────
  // Phase B is lease-driven (INNER JOIN claim_leases), so a leaseless holder is
  // never reclaimed by pick. (Post-migration-0034 this state doesn't occur — a
  // backfilled expired lease WOULD be grabbed; the human Release action handles
  // any that slip through.)
  it("a claimed ready task with NO lease row is not a Phase B candidate (not grabbed)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const project = createTestProject(testApp.db);
    const reporter = createTestUser(testApp.db);
    const holder = createTestAiAgent(testApp.db);
    // Born assigned but with NO lease row (pre-engine / legacy state).
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      assigneeId: holder.user.id,
      status: "ready",
    });
    expect(leaseRow(task.id)).toBeUndefined();

    const picker = createTestAiAgent(testApp.db);
    const now = new Date(
      T0.getTime() + LEASE_TTL_MS_DEFAULT + LEASE_PICK_MARGIN_MS_DEFAULT + 60_000,
    );

    const result = withReclaimCounter((count) => {
      const r = taskSvc.pickNextTask(aiActor(picker.user.id), undefined, {
        now,
        graceMs: 0,
      });
      expect(count()).toBe(0);
      return r;
    });

    // No lease row ⇒ the Phase B JOIN finds no candidate ⇒ untouched.
    expect(result).toBeNull();
    expect(taskRow(task.id).assigneeId).toBe(holder.user.id);
    expect(leaseRow(task.id)).toBeUndefined();
    expect(reclaimAuditCount(task.id)).toBe(0);
  });

  // ── 7. Phase A precedence: an unassigned task wins over a stale one ─
  it("mode=on prefers an unassigned ready task over a stale-claimed one (Phase A precedence)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const project = createTestProject(testApp.db);
    const { task: stale, holderId } = makeStaleReadyTask({
      projectId: project.id,
    });

    // A fresh, unassigned ready task in the same project.
    const reporter = createTestUser(testApp.db);
    const fresh = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });

    const picker = createTestAiAgent(testApp.db);
    const now = new Date(
      T0.getTime() + LEASE_TTL_MS_DEFAULT + LEASE_PICK_MARGIN_MS_DEFAULT + 60_000,
    );

    const result = withReclaimCounter((count) => {
      const r = taskSvc.pickNextTask(aiActor(picker.user.id), undefined, {
        now,
        graceMs: 0,
      });
      // Phase A satisfied the pick → Phase B never ran → no reclaim.
      expect(count()).toBe(0);
      return r;
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe(fresh.id);
    expect(taskRow(fresh.id).assigneeId).toBe(picker.user.id);

    // The stale task is untouched (still held by the original holder).
    expect(taskRow(stale.id).assigneeId).toBe(holderId);
    expect(leaseRow(stale.id)!.holderId).toBe(holderId);
    expect(reclaimAuditCount(stale.id)).toBe(0);
  });
});
