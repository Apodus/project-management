import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  CLAIM_LEASE_RECLAIMED_EVENT,
  LEASE_TTL_MS_DEFAULT,
} from "@pm/shared";
import {
  createTestAiAgent,
  createTestApp,
  createTestEpic,
  createTestProject,
  createTestProposal,
  createTestTask,
  type TestApp,
} from "../utils.js";
import { auditLog, claimLeases, epics, proposals, tasks } from "../../src/db/index.js";
import {
  EVENT_NAMES,
  getEventBus,
  type EventName,
} from "../../src/events/event-bus.js";
import * as svc from "../../src/services/claim-lease.service.js";

// ──────────────────────────────────────────────────────────────────
// Campaign C2 (claim-lease §P2): the claim-lease engine — lifecycle
// (acquire/renew/read), on-read liveness, and the opportunistic
// stale-claim sweep (off/shadow/on). Pure mechanics: the only entity
// mutation is a mode `on` reclaim clearing the holder.
// ──────────────────────────────────────────────────────────────────

describe("claim-lease service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // Convenience: count the audit_log rows for a target.
  function auditRows(targetId: string) {
    return testApp.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, targetId))
      .all();
  }

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

  // ── 1. acquire / read / renew lifecycle ──────────────────────────
  it("acquire creates one row; readLease returns it; renew advances heartbeat/expiry", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });

    const t0 = new Date("2026-06-06T10:00:00.000Z");
    const lease = svc.acquireLease(
      "task",
      task.id,
      { id: a.user.id },
      { now: t0, sessionId: "sess-1" },
    );

    expect(lease.holderId).toBe(a.user.id);
    expect(lease.sessionId).toBe("sess-1");
    expect(lease.claimedAt).toBe(t0.toISOString());
    expect(lease.heartbeatAt).toBe(t0.toISOString());
    expect(lease.lastActivityAt).toBe(t0.toISOString());
    expect(lease.expiresAt).toBe(
      new Date(t0.getTime() + LEASE_TTL_MS_DEFAULT).toISOString(),
    );

    // Exactly one row exists.
    expect(
      testApp.db
        .select()
        .from(claimLeases)
        .where(eq(claimLeases.entityId, task.id))
        .all(),
    ).toHaveLength(1);

    const read = svc.readLease("task", task.id);
    expect(read?.id).toBe(lease.id);

    // Renew advances heartbeat/expiry/lastActivity but keeps the same row id.
    const t1 = new Date(t0.getTime() + 60_000);
    const renewed = svc.renewLease("task", task.id, { id: a.user.id }, { now: t1 });
    expect(renewed).not.toBeNull();
    expect(renewed!.id).toBe(lease.id);
    expect(renewed!.heartbeatAt).toBe(t1.toISOString());
    expect(renewed!.lastActivityAt).toBe(t1.toISOString());
    expect(renewed!.expiresAt).toBe(
      new Date(t1.getTime() + LEASE_TTL_MS_DEFAULT).toISOString(),
    );
    // claimedAt is the original acquire time — renew doesn't reset it.
    expect(renewed!.claimedAt).toBe(t0.toISOString());
  });

  // ── 2. acquire is idempotent / overwrite ─────────────────────────
  it("acquire overwrites in place (still exactly one row)", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const b = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });

    const first = svc.acquireLease("task", task.id, { id: a.user.id });
    const second = svc.acquireLease("task", task.id, { id: b.user.id });

    // Same logical row (one lease per entity), now held by b.
    expect(second.id).toBe(first.id);
    expect(second.holderId).toBe(b.user.id);
    expect(
      testApp.db
        .select()
        .from(claimLeases)
        .where(eq(claimLeases.entityId, task.id))
        .all(),
    ).toHaveLength(1);
  });

  // ── renew refuses a non-holder / absent lease ────────────────────
  it("renew returns null when the lease is absent or held by another identity", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const b = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });

    expect(svc.renewLease("task", task.id, { id: a.user.id })).toBeNull();

    svc.acquireLease("task", task.id, { id: a.user.id });
    expect(svc.renewLease("task", task.id, { id: b.user.id })).toBeNull();
  });

  // ── 3. deriveLiveness boundaries ─────────────────────────────────
  it("deriveLiveness: live within expiry+grace, stale beyond, fail-safe to live", () => {
    const grace = 1000;
    const expiresAt = "2026-06-06T10:00:00.000Z";
    const expiry = Date.parse(expiresAt);

    // Before expiry → live.
    expect(svc.deriveLiveness(new Date(expiry - 1), expiresAt, grace)).toBe("live");
    // Exactly at the expiry+grace boundary → still live (strict >).
    expect(svc.deriveLiveness(new Date(expiry + grace), expiresAt, grace)).toBe(
      "live",
    );
    // One ms past the boundary → stale.
    expect(
      svc.deriveLiveness(new Date(expiry + grace + 1), expiresAt, grace),
    ).toBe("stale");

    // Fail-safe: null / unparseable → live.
    expect(svc.deriveLiveness(new Date(), null, grace)).toBe("live");
    expect(svc.deriveLiveness(new Date(), "not-a-date", grace)).toBe("live");
  });

  // ── 4. sweep mode `on` frees a stale task lease ──────────────────
  it("sweep mode on reclaims a stale task lease (entity cleared, lease gone, audit + event)", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: a.user.id,
    });

    const t0 = new Date("2026-06-06T10:00:00.000Z");
    svc.acquireLease("task", task.id, { id: a.user.id }, { now: t0, ttlMs: 1000 });

    const reclaimedListener = vi.fn();
    getEventBus().on(CLAIM_LEASE_RECLAIMED_EVENT as EventName, reclaimedListener);

    // Well past expiry + grace.
    const now = new Date(t0.getTime() + 1000 + 5000 + 1);
    const result = svc.sweepStaleClaims({
      entityType: "task",
      entityId: task.id,
      mode: "on",
      graceMs: 5000,
      now,
    });

    expect(result.reclaimed).toHaveLength(1);
    expect(result.observed).toHaveLength(0);
    expect(result.reclaimed[0]).toMatchObject({
      entityType: "task",
      entityId: task.id,
      holderId: a.user.id,
    });

    // The entity's holder is cleared.
    const freshTask = testApp.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get();
    expect(freshTask!.assigneeId).toBeNull();

    // The lease row is gone.
    expect(leaseRow("task", task.id)).toBeUndefined();

    // Exactly one claim_reclaimed audit row, before/after honest.
    const audits = auditRows(task.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("claim_reclaimed");
    expect(audits[0].targetType).toBe("task");
    expect(audits[0].metadataBefore).toEqual({ assignee_id: a.user.id });
    expect(audits[0].metadataAfter).toEqual({ assignee_id: null });

    // The domain event fired exactly once.
    expect(reclaimedListener).toHaveBeenCalledTimes(1);
  });

  // ── 5. sweep NEVER frees a live lease ────────────────────────────
  it("sweep on does not free a live lease (future expiry, and expired-but-within-grace)", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);

    const reclaimedListener = vi.fn();
    const auditListener = vi.fn();
    getEventBus().on(CLAIM_LEASE_RECLAIMED_EVENT as EventName, reclaimedListener);
    getEventBus().on(EVENT_NAMES.AUDIT_RECORDED, auditListener);

    // (a) future expiry — clearly live.
    const liveTask = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: a.user.id,
    });
    const t0 = new Date("2026-06-06T10:00:00.000Z");
    svc.acquireLease("task", liveTask.id, { id: a.user.id }, { now: t0, ttlMs: 60_000 });
    const r1 = svc.sweepStaleClaims({
      entityType: "task",
      entityId: liveTask.id,
      mode: "on",
      graceMs: 5000,
      now: new Date(t0.getTime() + 30_000),
    });
    expect(r1.reclaimed).toHaveLength(0);

    // (b) expired but still within grace — live by the grace rule.
    const graceTask = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: a.user.id,
    });
    svc.acquireLease("task", graceTask.id, { id: a.user.id }, { now: t0, ttlMs: 1000 });
    const r2 = svc.sweepStaleClaims({
      entityType: "task",
      entityId: graceTask.id,
      mode: "on",
      graceMs: 60_000,
      // Past expiry (t0+1000) but within +60s grace.
      now: new Date(t0.getTime() + 1000 + 10_000),
    });
    expect(r2.reclaimed).toHaveLength(0);

    // Holders + leases intact; no audit, no event.
    expect(
      testApp.db.select().from(tasks).where(eq(tasks.id, liveTask.id)).get()!
        .assigneeId,
    ).toBe(a.user.id);
    expect(
      testApp.db.select().from(tasks).where(eq(tasks.id, graceTask.id)).get()!
        .assigneeId,
    ).toBe(a.user.id);
    expect(leaseRow("task", liveTask.id)).toBeDefined();
    expect(leaseRow("task", graceTask.id)).toBeDefined();
    expect(reclaimedListener).not.toHaveBeenCalled();
    expect(auditListener).not.toHaveBeenCalled();
  });

  // ── 6. mode shadow detects but does not mutate ───────────────────
  it("sweep mode shadow observes a stale lease without mutating/auditing/emitting", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: a.user.id,
    });

    const reclaimedListener = vi.fn();
    const auditListener = vi.fn();
    getEventBus().on(CLAIM_LEASE_RECLAIMED_EVENT as EventName, reclaimedListener);
    getEventBus().on(EVENT_NAMES.AUDIT_RECORDED, auditListener);

    const t0 = new Date("2026-06-06T10:00:00.000Z");
    svc.acquireLease("task", task.id, { id: a.user.id }, { now: t0, ttlMs: 1000 });

    const result = svc.sweepStaleClaims({
      entityType: "task",
      entityId: task.id,
      mode: "shadow",
      graceMs: 5000,
      now: new Date(t0.getTime() + 1000 + 5000 + 1),
    });

    expect(result.observed).toHaveLength(1);
    expect(result.observed[0]).toMatchObject({
      entityType: "task",
      entityId: task.id,
      holderId: a.user.id,
    });
    expect(result.reclaimed).toHaveLength(0);

    // Nothing mutated.
    expect(
      testApp.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!
        .assigneeId,
    ).toBe(a.user.id);
    expect(leaseRow("task", task.id)).toBeDefined();
    expect(auditRows(task.id)).toHaveLength(0);
    expect(reclaimedListener).not.toHaveBeenCalled();
    expect(auditListener).not.toHaveBeenCalled();
  });

  // ── 7. mode off is inert ─────────────────────────────────────────
  it("sweep mode off returns empty and mutates nothing", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: a.user.id,
    });

    const t0 = new Date("2026-06-06T10:00:00.000Z");
    svc.acquireLease("task", task.id, { id: a.user.id }, { now: t0, ttlMs: 1000 });

    const result = svc.sweepStaleClaims({
      entityType: "task",
      entityId: task.id,
      mode: "off",
      graceMs: 5000,
      now: new Date(t0.getTime() + 1_000_000),
    });

    expect(result.reclaimed).toHaveLength(0);
    expect(result.observed).toHaveLength(0);
    expect(
      testApp.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!
        .assigneeId,
    ).toBe(a.user.id);
    expect(leaseRow("task", task.id)).toBeDefined();
    expect(auditRows(task.id)).toHaveLength(0);
  });

  // ── 8. fail-safe skips ───────────────────────────────────────────
  it("sweep on is a no-op for missing-lease / null-holder / null-expiry / null-project cases", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);

    // (a) missing lease → no-op.
    const noLeaseTask = createTestTask(testApp.db, { projectId: project.id });
    expect(
      svc.sweepStaleClaims({
        entityType: "task",
        entityId: noLeaseTask.id,
        mode: "on",
        now: new Date(),
      }).reclaimed,
    ).toHaveLength(0);

    // (b) holderId null lease → not reclaimed.
    const orphanTask = createTestTask(testApp.db, { projectId: project.id });
    const t0 = new Date("2026-06-06T10:00:00.000Z");
    svc.acquireLease("task", orphanTask.id, { id: a.user.id }, { now: t0, ttlMs: 1000 });
    // Null the holder directly (simulating ON DELETE SET NULL).
    testApp.db
      .update(claimLeases)
      .set({ holderId: null })
      .where(eq(claimLeases.entityId, orphanTask.id))
      .run();
    const rOrphan = svc.sweepStaleClaims({
      entityType: "task",
      entityId: orphanTask.id,
      mode: "on",
      graceMs: 0,
      now: new Date(t0.getTime() + 1_000_000),
    });
    expect(rOrphan.reclaimed).toHaveLength(0);
    expect(leaseRow("task", orphanTask.id)).toBeDefined();

    // (c) null expiry → live (fail-safe), not reclaimed.
    const nullExpiryTask = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: a.user.id,
    });
    svc.acquireLease("task", nullExpiryTask.id, { id: a.user.id }, { now: t0 });
    // expiresAt is NOT NULL in the schema, but deriveLiveness fails safe on a
    // null/unparseable value — exercise via an unparseable string.
    testApp.db
      .update(claimLeases)
      .set({ expiresAt: "not-a-date" })
      .where(eq(claimLeases.entityId, nullExpiryTask.id))
      .run();
    const rNullExp = svc.sweepStaleClaims({
      entityType: "task",
      entityId: nullExpiryTask.id,
      mode: "on",
      graceMs: 0,
      now: new Date(t0.getTime() + 1_000_000),
    });
    expect(rNullExp.reclaimed).toHaveLength(0);
    expect(
      testApp.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, nullExpiryTask.id))
        .get()!.assigneeId,
    ).toBe(a.user.id);

    // (d) proposal with null projectId + stale lease + mode on → skipped.
    const noProjProposal = createTestProposal(testApp.db, { projectId: project.id });
    // Detach the proposal from its project (null projectId blocks audit).
    testApp.db
      .update(proposals)
      .set({ projectId: null, claimedBy: a.user.id })
      .where(eq(proposals.id, noProjProposal.id))
      .run();
    svc.acquireLease("proposal", noProjProposal.id, { id: a.user.id }, {
      now: t0,
      ttlMs: 1000,
    });
    const rNoProj = svc.sweepStaleClaims({
      entityType: "proposal",
      entityId: noProjProposal.id,
      mode: "on",
      graceMs: 0,
      now: new Date(t0.getTime() + 1_000_000),
    });
    expect(rNoProj.reclaimed).toHaveLength(0);
    expect(leaseRow("proposal", noProjProposal.id)).toBeDefined();
    expect(
      testApp.db
        .select()
        .from(proposals)
        .where(eq(proposals.id, noProjProposal.id))
        .get()!.claimedBy,
    ).toBe(a.user.id);
  });

  // ── 9. epic + proposal reclaim parity ────────────────────────────
  it("sweep on reclaims epic + proposal with the correct holderJsonKey in audit", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const t0 = new Date("2026-06-06T10:00:00.000Z");
    const past = new Date(t0.getTime() + 1_000_000);

    // Epic uses assignee_id.
    const epic = createTestEpic(testApp.db, {
      projectId: project.id,
      // createTestEpic has no assigneeId override; set it directly.
    });
    testApp.db
      .update(epics)
      .set({ assigneeId: a.user.id })
      .where(eq(epics.id, epic.id))
      .run();
    svc.acquireLease("epic", epic.id, { id: a.user.id }, { now: t0, ttlMs: 1000 });
    const rEpic = svc.sweepStaleClaims({
      entityType: "epic",
      entityId: epic.id,
      mode: "on",
      graceMs: 0,
      now: past,
    });
    expect(rEpic.reclaimed).toHaveLength(1);
    expect(
      testApp.db.select().from(epics).where(eq(epics.id, epic.id)).get()!
        .assigneeId,
    ).toBeNull();
    const epicAudit = auditRows(epic.id);
    expect(epicAudit).toHaveLength(1);
    expect(epicAudit[0].targetType).toBe("epic");
    expect(epicAudit[0].metadataBefore).toEqual({ assignee_id: a.user.id });
    expect(epicAudit[0].metadataAfter).toEqual({ assignee_id: null });

    // Proposal uses claimed_by.
    const proposal = createTestProposal(testApp.db, { projectId: project.id });
    testApp.db
      .update(proposals)
      .set({ claimedBy: a.user.id })
      .where(eq(proposals.id, proposal.id))
      .run();
    svc.acquireLease("proposal", proposal.id, { id: a.user.id }, {
      now: t0,
      ttlMs: 1000,
    });
    const rProp = svc.sweepStaleClaims({
      entityType: "proposal",
      entityId: proposal.id,
      mode: "on",
      graceMs: 0,
      now: past,
    });
    expect(rProp.reclaimed).toHaveLength(1);
    expect(
      testApp.db
        .select()
        .from(proposals)
        .where(eq(proposals.id, proposal.id))
        .get()!.claimedBy,
    ).toBeNull();
    const propAudit = auditRows(proposal.id);
    expect(propAudit).toHaveLength(1);
    expect(propAudit[0].targetType).toBe("proposal");
    expect(propAudit[0].metadataBefore).toEqual({ claimed_by: a.user.id });
    expect(propAudit[0].metadataAfter).toEqual({ claimed_by: null });
  });

  // ── 10. bounded batch ────────────────────────────────────────────
  it("batch sweep honors the limit (N stale leases, limit 2 → at most 2 reclaimed)", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const t0 = new Date("2026-06-06T10:00:00.000Z");

    // Four stale task leases.
    for (let i = 0; i < 4; i++) {
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        assigneeId: a.user.id,
      });
      svc.acquireLease(
        "task",
        task.id,
        { id: a.user.id },
        // Stagger expiry so the oldest-first order is well-defined.
        { now: new Date(t0.getTime() + i), ttlMs: 1000 },
      );
    }

    const result = svc.sweepStaleClaims({
      entityType: "task",
      // No entityId → batch path.
      limit: 2,
      mode: "on",
      graceMs: 0,
      now: new Date(t0.getTime() + 1_000_000),
    });

    expect(result.reclaimed).toHaveLength(2);
    // Two leases reclaimed, two remain.
    expect(
      testApp.db
        .select()
        .from(claimLeases)
        .where(eq(claimLeases.entityType, "task"))
        .all(),
    ).toHaveLength(2);
  });
});
