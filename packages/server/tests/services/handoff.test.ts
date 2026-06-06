import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { LEASE_GRACE_MS_DEFAULT, LEASE_TTL_MS_DEFAULT } from "@pm/shared";
import {
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { auditLog, claimLeases, tasks } from "../../src/db/index.js";
import { getEventBus, EVENT_NAMES } from "../../src/events/event-bus.js";
import type { AuthUser } from "../../src/types.js";
import * as taskSvc from "../../src/services/task.service.js";
import * as claimLeaseSvc from "../../src/services/claim-lease.service.js";

// ──────────────────────────────────────────────────────────────────
// Campaign C3 §P5b — handoff primitives (release-to + request-takeover)
// over the shared audited-transfer core (performClaimTransfer). The
// load-bearing case (B1): an AI holder releases to ANOTHER named worker
// — which forceClaim could NOT serve (its self-or-human gate would 403).
// request-takeover is stomp-safe: a live claim is NEVER mutated.
// ──────────────────────────────────────────────────────────────────

describe("handoff primitives (C3 §P5b)", () => {
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

  function forceClaimAudits(targetId: string) {
    return testApp.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetId, targetId),
          eq(auditLog.action, "force_claim"),
        ),
      )
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

  function humanActor(id: string): AuthUser {
    return {
      id,
      username: `human-${id.slice(-4)}`,
      displayName: "Human",
      role: "admin",
      type: "human",
    };
  }

  // ── release-to ────────────────────────────────────────────────────

  it("release-to transfers holder→target with ONE audit row + lease moved (human)", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestAiAgent(testApp.db);
    const target = createTestAiAgent(testApp.db);
    const human = createTestUser(testApp.db, { type: "human" });
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });

    expect(taskSvc.claim(task.id, aiActor(holder.user.id)).ok).toBe(true);

    const res = taskSvc.releaseTo(task.id, humanActor(human.id), {
      reason: "reassigning to night-shift worker",
      targetId: target.user.id,
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe("force_claimed");
    expect(taskRow(task.id)!.assigneeId).toBe(target.user.id);
    expect(leaseRow("task", task.id)!.holderId).toBe(target.user.id);
    // exactly one force_claim audit row for this handoff.
    expect(forceClaimAudits(task.id).length).toBe(1);
  });

  it("THE LOAD-BEARING CASE (B1): an AI holder releases to ANOTHER worker → 200, lease + one audit row", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestAiAgent(testApp.db);
    const target = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });

    expect(taskSvc.claim(task.id, aiActor(holder.user.id)).ok).toBe(true);

    // forceClaim CANNOT do this (its target!==actor && !human → 403). releaseTo
    // can, because the AI agent HOLDS the claim.
    const res = taskSvc.releaseTo(task.id, aiActor(holder.user.id), {
      reason: "handing off to a fresh worker",
      targetId: target.user.id,
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe("force_claimed");
    expect(res.previousHolder).toBe(holder.user.id);
    expect(res.newHolder).toBe(target.user.id);
    expect(taskRow(task.id)!.assigneeId).toBe(target.user.id);
    expect(leaseRow("task", task.id)!.holderId).toBe(target.user.id);
    expect(forceClaimAudits(task.id).length).toBe(1);
  });

  it("release-to by a NON-holder AI agent → 403", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestAiAgent(testApp.db);
    const intruder = createTestAiAgent(testApp.db);
    const target = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });

    expect(taskSvc.claim(task.id, aiActor(holder.user.id)).ok).toBe(true);

    expect(() =>
      taskSvc.releaseTo(task.id, aiActor(intruder.user.id), {
        reason: "not mine to give",
        targetId: target.user.id,
      }),
    ).toThrow(/holder/i);
    // unchanged.
    expect(taskRow(task.id)!.assigneeId).toBe(holder.user.id);
    expect(leaseRow("task", task.id)!.holderId).toBe(holder.user.id);
  });

  it("release-to requires a non-empty reason and a target", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestAiAgent(testApp.db);
    const target = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });
    expect(taskSvc.claim(task.id, aiActor(holder.user.id)).ok).toBe(true);

    expect(() =>
      taskSvc.releaseTo(task.id, aiActor(holder.user.id), {
        reason: "  ",
        targetId: target.user.id,
      }),
    ).toThrow(/reason/i);
    expect(() =>
      taskSvc.releaseTo(task.id, aiActor(holder.user.id), {
        reason: "valid",
        targetId: "",
      }),
    ).toThrow(/target/i);
  });

  // ── request-takeover ──────────────────────────────────────────────

  it("request-takeover on a STALE claim auto-grants (holder=requester, audit, lease moved)", () => {
    const t0 = new Date("2026-06-06T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(t0);

    const project = createTestProject(testApp.db);
    const holder = createTestAiAgent(testApp.db);
    const requester = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });

    expect(taskSvc.claim(task.id, aiActor(holder.user.id)).ok).toBe(true);

    // Advance past TTL + grace so the holder's lease is stale.
    vi.setSystemTime(
      new Date(t0.getTime() + LEASE_TTL_MS_DEFAULT + LEASE_GRACE_MS_DEFAULT + 60_000),
    );

    const res = taskSvc.requestTakeover(task.id, aiActor(requester.user.id), {
      reason: "holder went dark; taking over",
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe("force_claimed");
    expect(taskRow(task.id)!.assigneeId).toBe(requester.user.id);
    expect(leaseRow("task", task.id)!.holderId).toBe(requester.user.id);
    expect(forceClaimAudits(task.id).length).toBe(1);
  });

  it("request-takeover on a LIVE claim → NO mutation, emits CLAIM_TAKEOVER_REQUESTED, returns notified_holder", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestAiAgent(testApp.db);
    const requester = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });

    expect(taskSvc.claim(task.id, aiActor(holder.user.id)).ok).toBe(true);

    let notified = 0;
    let leakedHolder = false;
    getEventBus().on(EVENT_NAMES.CLAIM_TAKEOVER_REQUESTED, (p) => {
      notified += 1;
      // identity-masked: the payload must not carry the holder id.
      if (p.actorId === holder.user.id) leakedHolder = true;
      const blob = JSON.stringify(p);
      if (blob.includes(holder.user.id)) leakedHolder = true;
    });

    const res = taskSvc.requestTakeover(task.id, aiActor(requester.user.id), {
      reason: "I'd like this one",
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe("notified_holder");
    // CARDINAL INVARIANT: nothing mutated.
    expect(taskRow(task.id)!.assigneeId).toBe(holder.user.id);
    expect(leaseRow("task", task.id)!.holderId).toBe(holder.user.id);
    expect(forceClaimAudits(task.id).length).toBe(0);
    // exactly one notification, no holder id leaked.
    expect(notified).toBe(1);
    expect(leakedHolder).toBe(false);
  });

  it("request-takeover by the holder → already_claimed_by_you (no-op)", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });
    expect(taskSvc.claim(task.id, aiActor(holder.user.id)).ok).toBe(true);

    const res = taskSvc.requestTakeover(task.id, aiActor(holder.user.id), {
      reason: "checking",
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe("already_claimed_by_you");
    expect(forceClaimAudits(task.id).length).toBe(0);
  });

  it("request-takeover on an UNCLAIMED entity → not_held", () => {
    const project = createTestProject(testApp.db);
    const requester = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });

    const res = taskSvc.requestTakeover(task.id, aiActor(requester.user.id), {
      reason: "is this free?",
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe("not_held");
  });

  it("two agents racing request-takeover on one STALE item → exactly one wins", () => {
    const t0 = new Date("2026-06-06T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(t0);

    const project = createTestProject(testApp.db);
    const holder = createTestAiAgent(testApp.db);
    const r1 = createTestAiAgent(testApp.db);
    const r2 = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });
    expect(taskSvc.claim(task.id, aiActor(holder.user.id)).ok).toBe(true);

    vi.setSystemTime(
      new Date(t0.getTime() + LEASE_TTL_MS_DEFAULT + LEASE_GRACE_MS_DEFAULT + 60_000),
    );

    // Synchronous execution: the first request takes the stale claim; the second
    // now sees a fresh (live) holder = r1 and is no longer stale → notified.
    const res1 = taskSvc.requestTakeover(task.id, aiActor(r1.user.id), {
      reason: "first",
    });
    const res2 = taskSvc.requestTakeover(task.id, aiActor(r2.user.id), {
      reason: "second",
    });

    const granted = [res1, res2].filter((r) => r.status === "force_claimed");
    expect(granted.length).toBe(1);
    // the winner is the holder; the entity is held by exactly one of them.
    const finalHolder = taskRow(task.id)!.assigneeId;
    expect(finalHolder).toBe(r1.user.id);
    expect(leaseRow("task", task.id)!.holderId).toBe(r1.user.id);
    // r2 got notified, not granted.
    expect(res2.status).toBe("notified_holder");
  });
});
