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
  createTestEpic,
  createTestProject,
  createTestProposal,
  createTestTask,
  type TestApp,
} from "../utils.js";
import { auditLog, claimLeases, epics, proposals, tasks } from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus, type EventName } from "../../src/events/event-bus.js";
import * as svc from "../../src/services/claim-lease.service.js";

// ──────────────────────────────────────────────────────────────────
// The claim-lease engine — lifecycle (acquire/renew/read), on-read
// liveness, and the opportunistic stale-claim sweep. The engine is
// always active: a lapsed lease is always reclaimed (clear the holder +
// delete the lease + audit + event).
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
    return testApp.db.select().from(auditLog).where(eq(auditLog.targetId, targetId)).all();
  }

  function leaseRow(entityType: string, entityId: string) {
    return testApp.db
      .select()
      .from(claimLeases)
      .where(and(eq(claimLeases.entityType, entityType), eq(claimLeases.entityId, entityId)))
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
    expect(lease.expiresAt).toBe(new Date(t0.getTime() + LEASE_TTL_MS_DEFAULT).toISOString());

    // Exactly one row exists.
    expect(
      testApp.db.select().from(claimLeases).where(eq(claimLeases.entityId, task.id)).all(),
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
    expect(renewed!.expiresAt).toBe(new Date(t1.getTime() + LEASE_TTL_MS_DEFAULT).toISOString());
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
      testApp.db.select().from(claimLeases).where(eq(claimLeases.entityId, task.id)).all(),
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
    expect(svc.deriveLiveness(new Date(expiry + grace), expiresAt, grace)).toBe("live");
    // One ms past the boundary → stale.
    expect(svc.deriveLiveness(new Date(expiry + grace + 1), expiresAt, grace)).toBe("stale");

    // Fail-safe: null / unparseable → live.
    expect(svc.deriveLiveness(new Date(), null, grace)).toBe("live");
    expect(svc.deriveLiveness(new Date(), "not-a-date", grace)).toBe("live");
  });

  // ── 3b. readLeasesFor batch read (C3.P1) ─────────────────────────
  it("readLeasesFor returns a Map of only present leases over a mixed set", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const withLive = createTestTask(testApp.db, { projectId: project.id });
    const withLapsed = createTestTask(testApp.db, { projectId: project.id });
    const noLease = createTestTask(testApp.db, { projectId: project.id });

    const t0 = new Date("2026-06-06T10:00:00.000Z");
    // A live lease (long TTL) and a lapsed lease (already expired) — the helper
    // returns BOTH rows; readLeasesFor itself doesn't filter on liveness.
    svc.acquireLease("task", withLive.id, { id: a.user.id }, { now: t0 });
    svc.acquireLease("task", withLapsed.id, { id: a.user.id }, { now: t0, ttlMs: 1000 });

    const map = svc.readLeasesFor("task", [withLive.id, withLapsed.id, noLease.id]);

    expect(map.size).toBe(2);
    expect(map.has(withLive.id)).toBe(true);
    expect(map.has(withLapsed.id)).toBe(true);
    expect(map.has(noLease.id)).toBe(false);
    expect(map.get(withLive.id)?.holderId).toBe(a.user.id);
  });

  it("readLeasesFor over an empty id set returns an empty Map (no throw)", () => {
    expect(svc.readLeasesFor("task", []).size).toBe(0);
  });

  it("readLeasesFor scopes by entityType", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });
    const epic = createTestEpic(testApp.db, { projectId: project.id });

    svc.acquireLease("task", task.id, { id: a.user.id });
    svc.acquireLease("epic", epic.id, { id: a.user.id });

    // Querying tasks with an epic id mixed in only returns the task lease.
    const map = svc.readLeasesFor("task", [task.id, epic.id]);
    expect(map.size).toBe(1);
    expect(map.has(task.id)).toBe(true);
    expect(map.has(epic.id)).toBe(false);
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
      graceMs: 5000,
      now,
    });

    expect(result.reclaimed).toHaveLength(1);
    expect(result.reclaimed[0]).toMatchObject({
      entityType: "task",
      entityId: task.id,
      holderId: a.user.id,
    });

    // The entity's holder is cleared.
    const freshTask = testApp.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
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
      graceMs: 60_000,
      // Past expiry (t0+1000) but within +60s grace.
      now: new Date(t0.getTime() + 1000 + 10_000),
    });
    expect(r2.reclaimed).toHaveLength(0);

    // Holders + leases intact; no audit, no event.
    expect(testApp.db.select().from(tasks).where(eq(tasks.id, liveTask.id)).get()!.assigneeId).toBe(
      a.user.id,
    );
    expect(
      testApp.db.select().from(tasks).where(eq(tasks.id, graceTask.id)).get()!.assigneeId,
    ).toBe(a.user.id);
    expect(leaseRow("task", liveTask.id)).toBeDefined();
    expect(leaseRow("task", graceTask.id)).toBeDefined();
    expect(reclaimedListener).not.toHaveBeenCalled();
    expect(auditListener).not.toHaveBeenCalled();
  });

  // ── 6. fail-safe skips ───────────────────────────────────────────
  it("sweep on is a no-op for missing-lease / null-holder / null-expiry / null-project cases", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);

    // (a) missing lease → no-op.
    const noLeaseTask = createTestTask(testApp.db, { projectId: project.id });
    expect(
      svc.sweepStaleClaims({
        entityType: "task",
        entityId: noLeaseTask.id,
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
      graceMs: 0,
      now: new Date(t0.getTime() + 1_000_000),
    });
    expect(rNullExp.reclaimed).toHaveLength(0);
    expect(
      testApp.db.select().from(tasks).where(eq(tasks.id, nullExpiryTask.id)).get()!.assigneeId,
    ).toBe(a.user.id);

    // (d) proposal with null projectId + stale lease + mode on → skipped.
    const noProjProposal = createTestProposal(testApp.db, { projectId: project.id });
    // Detach the proposal from its project (null projectId blocks audit).
    testApp.db
      .update(proposals)
      .set({ projectId: null, claimedBy: a.user.id })
      .where(eq(proposals.id, noProjProposal.id))
      .run();
    svc.acquireLease(
      "proposal",
      noProjProposal.id,
      { id: a.user.id },
      {
        now: t0,
        ttlMs: 1000,
      },
    );
    const rNoProj = svc.sweepStaleClaims({
      entityType: "proposal",
      entityId: noProjProposal.id,
      graceMs: 0,
      now: new Date(t0.getTime() + 1_000_000),
    });
    expect(rNoProj.reclaimed).toHaveLength(0);
    expect(leaseRow("proposal", noProjProposal.id)).toBeDefined();
    expect(
      testApp.db.select().from(proposals).where(eq(proposals.id, noProjProposal.id)).get()!
        .claimedBy,
    ).toBe(a.user.id);
  });

  // ── 8b. de-silenced skips (C2): the fail-safe skips WARN ──────────
  it("reclaim skip on a VANISHED entity warns (C2 de-silence)", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const t0 = new Date("2026-06-06T10:00:00.000Z");

    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: a.user.id,
    });
    svc.acquireLease("task", task.id, { id: a.user.id }, { now: t0, ttlMs: 1000 });
    // Vanish the entity row, leaving the lease dangling.
    testApp.db.delete(tasks).where(eq(tasks.id, task.id)).run();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = svc.sweepStaleClaims({
        entityType: "task",
        entityId: task.id,
        graceMs: 0,
        now: new Date(t0.getTime() + 1_000_000),
      });
      expect(r.reclaimed).toHaveLength(0);
      const warned = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(
        warned.some((m) => m.includes("[claim-lease]") && m.includes("entity row is gone")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("reclaim skip on a NULL-projectId entity warns (C2 de-silence)", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const t0 = new Date("2026-06-06T10:00:00.000Z");

    const prop = createTestProposal(testApp.db, { projectId: project.id });
    testApp.db
      .update(proposals)
      .set({ projectId: null, claimedBy: a.user.id })
      .where(eq(proposals.id, prop.id))
      .run();
    svc.acquireLease("proposal", prop.id, { id: a.user.id }, { now: t0, ttlMs: 1000 });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = svc.sweepStaleClaims({
        entityType: "proposal",
        entityId: prop.id,
        graceMs: 0,
        now: new Date(t0.getTime() + 1_000_000),
      });
      expect(r.reclaimed).toHaveLength(0);
      const warned = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warned.some((m) => m.includes("[claim-lease]") && m.includes("null projectId"))).toBe(
        true,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── 8c. env-driven grace derivation (C2 amendment 7) ──────────────
  it("resolveLeaseGraceMs derives from PM_LEASE_GRACE_SEC and is byte-identical to the default when unset/invalid", () => {
    expect(svc.resolveLeaseGraceMs("60")).toBe(60_000);
    expect(svc.resolveLeaseGraceMs("7200")).toBe(7_200_000);
    // Unset / invalid / non-positive → the @pm/shared default.
    expect(svc.resolveLeaseGraceMs(undefined)).toBe(LEASE_GRACE_MS_DEFAULT);
    expect(svc.resolveLeaseGraceMs("not-a-number")).toBe(LEASE_GRACE_MS_DEFAULT);
    expect(svc.resolveLeaseGraceMs("0")).toBe(LEASE_GRACE_MS_DEFAULT);
    expect(svc.resolveLeaseGraceMs("-5")).toBe(LEASE_GRACE_MS_DEFAULT);
    // The active getter agrees with a fresh resolution of the live env.
    expect(svc.resolveActiveLeaseGraceMs()).toBe(svc.resolveLeaseGraceMs());
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
    testApp.db.update(epics).set({ assigneeId: a.user.id }).where(eq(epics.id, epic.id)).run();
    svc.acquireLease("epic", epic.id, { id: a.user.id }, { now: t0, ttlMs: 1000 });
    const rEpic = svc.sweepStaleClaims({
      entityType: "epic",
      entityId: epic.id,
      graceMs: 0,
      now: past,
    });
    expect(rEpic.reclaimed).toHaveLength(1);
    expect(
      testApp.db.select().from(epics).where(eq(epics.id, epic.id)).get()!.assigneeId,
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
    svc.acquireLease(
      "proposal",
      proposal.id,
      { id: a.user.id },
      {
        now: t0,
        ttlMs: 1000,
      },
    );
    const rProp = svc.sweepStaleClaims({
      entityType: "proposal",
      entityId: proposal.id,
      graceMs: 0,
      now: past,
    });
    expect(rProp.reclaimed).toHaveLength(1);
    expect(
      testApp.db.select().from(proposals).where(eq(proposals.id, proposal.id)).get()!.claimedBy,
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
      graceMs: 0,
      now: new Date(t0.getTime() + 1_000_000),
    });

    expect(result.reclaimed).toHaveLength(2);
    // Two leases reclaimed, two remain.
    expect(
      testApp.db.select().from(claimLeases).where(eq(claimLeases.entityType, "task")).all(),
    ).toHaveLength(2);
  });

  // ── 11. headline: stale NOT-STARTED epic reclaim (mode on) ───────
  //
  // The campaign C2 headline: reclaim is status-agnostic. An epic that was
  // claimed but never moved out of its initial `draft` status (no status
  // transition) is still freed when its lease goes stale — this is the gap the
  // old tasks-only, in_progress-only, 4h-threshold reclaimStaleTasks could not
  // reach. Asserts: reclaimed length 1, assigneeId null, lease gone, exactly
  // one claim_reclaimed audit row (targetType epic, before/after honest), and
  // the claim.lease.reclaimed listener fired exactly once.
  it("reclaims a stale not-started (draft) epic and fires claim.lease.reclaimed once", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);

    // A freshly-created epic stays in its initial `draft` status — no status
    // transition is performed.
    const epic = createTestEpic(testApp.db, { projectId: project.id });
    expect(epic.status).toBe("draft");
    testApp.db.update(epics).set({ assigneeId: a.user.id }).where(eq(epics.id, epic.id)).run();

    const t0 = new Date("2026-06-06T10:00:00.000Z");
    svc.acquireLease("epic", epic.id, { id: a.user.id }, { now: t0, ttlMs: 1000 });

    const reclaimedListener = vi.fn();
    getEventBus().on(EVENT_NAMES.CLAIM_LEASE_RECLAIMED, reclaimedListener);

    // Well past expiry + grace.
    const now = new Date(t0.getTime() + 1000 + 5000 + 1);
    const result = svc.sweepStaleClaims({
      entityType: "epic",
      entityId: epic.id,
      graceMs: 5000,
      now,
    });

    expect(result.reclaimed).toHaveLength(1);
    expect(result.reclaimed[0]).toMatchObject({
      entityType: "epic",
      entityId: epic.id,
      holderId: a.user.id,
    });

    // Status is irrelevant to the reclaim — still draft, now unassigned.
    const fresh = testApp.db.select().from(epics).where(eq(epics.id, epic.id)).get();
    expect(fresh!.status).toBe("draft");
    expect(fresh!.assigneeId).toBeNull();

    // Lease gone.
    expect(leaseRow("epic", epic.id)).toBeUndefined();

    // Exactly one honest claim_reclaimed audit row.
    const audits = auditRows(epic.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("claim_reclaimed");
    expect(audits[0].targetType).toBe("epic");
    expect(audits[0].metadataBefore).toEqual({ assignee_id: a.user.id });
    expect(audits[0].metadataAfter).toEqual({ assignee_id: null });

    // The registered SSE event name fired exactly once.
    expect(reclaimedListener).toHaveBeenCalledTimes(1);
  });

  // ── 12. headline parity: stale not-started proposal reclaim ──────
  it("reclaims a stale not-started (open) proposal and fires claim.lease.reclaimed once", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);

    // A freshly-created proposal stays `open` — no transition.
    const proposal = createTestProposal(testApp.db, { projectId: project.id });
    expect(proposal.status).toBe("open");
    testApp.db
      .update(proposals)
      .set({ claimedBy: a.user.id })
      .where(eq(proposals.id, proposal.id))
      .run();

    const t0 = new Date("2026-06-06T10:00:00.000Z");
    svc.acquireLease(
      "proposal",
      proposal.id,
      { id: a.user.id },
      {
        now: t0,
        ttlMs: 1000,
      },
    );

    const reclaimedListener = vi.fn();
    getEventBus().on(EVENT_NAMES.CLAIM_LEASE_RECLAIMED, reclaimedListener);

    const now = new Date(t0.getTime() + 1000 + 5000 + 1);
    const result = svc.sweepStaleClaims({
      entityType: "proposal",
      entityId: proposal.id,
      graceMs: 5000,
      now,
    });

    expect(result.reclaimed).toHaveLength(1);
    expect(result.reclaimed[0]).toMatchObject({
      entityType: "proposal",
      entityId: proposal.id,
      holderId: a.user.id,
    });

    // Status untouched (still open), holder cleared via claimed_by.
    const fresh = testApp.db.select().from(proposals).where(eq(proposals.id, proposal.id)).get();
    expect(fresh!.status).toBe("open");
    expect(fresh!.claimedBy).toBeNull();

    expect(leaseRow("proposal", proposal.id)).toBeUndefined();

    const audits = auditRows(proposal.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("claim_reclaimed");
    expect(audits[0].targetType).toBe("proposal");
    expect(audits[0].metadataBefore).toEqual({ claimed_by: a.user.id });
    expect(audits[0].metadataAfter).toEqual({ claimed_by: null });

    expect(reclaimedListener).toHaveBeenCalledTimes(1);
  });

  // ── 13. live epic + proposal leases are NEVER freed ──────────────
  it("sweep on never frees a live epic/proposal lease (future expiry AND within-grace)", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const t0 = new Date("2026-06-06T10:00:00.000Z");

    const reclaimedListener = vi.fn();
    const auditListener = vi.fn();
    getEventBus().on(EVENT_NAMES.CLAIM_LEASE_RECLAIMED, reclaimedListener);
    getEventBus().on(EVENT_NAMES.AUDIT_RECORDED, auditListener);

    // (a) Epic with future expiry — clearly live.
    const liveEpic = createTestEpic(testApp.db, { projectId: project.id });
    testApp.db.update(epics).set({ assigneeId: a.user.id }).where(eq(epics.id, liveEpic.id)).run();
    svc.acquireLease("epic", liveEpic.id, { id: a.user.id }, { now: t0, ttlMs: 60_000 });
    expect(
      svc.sweepStaleClaims({
        entityType: "epic",
        entityId: liveEpic.id,
        graceMs: 5000,
        now: new Date(t0.getTime() + 30_000),
      }).reclaimed,
    ).toHaveLength(0);

    // (b) Proposal expired but within grace — live by the grace rule.
    const graceProposal = createTestProposal(testApp.db, { projectId: project.id });
    testApp.db
      .update(proposals)
      .set({ claimedBy: a.user.id })
      .where(eq(proposals.id, graceProposal.id))
      .run();
    svc.acquireLease(
      "proposal",
      graceProposal.id,
      { id: a.user.id },
      {
        now: t0,
        ttlMs: 1000,
      },
    );
    expect(
      svc.sweepStaleClaims({
        entityType: "proposal",
        entityId: graceProposal.id,
        graceMs: 60_000,
        // Past expiry (t0+1000) but within +60s grace.
        now: new Date(t0.getTime() + 1000 + 10_000),
      }).reclaimed,
    ).toHaveLength(0);

    // Holders + leases intact; nothing audited, nothing emitted.
    expect(testApp.db.select().from(epics).where(eq(epics.id, liveEpic.id)).get()!.assigneeId).toBe(
      a.user.id,
    );
    expect(
      testApp.db.select().from(proposals).where(eq(proposals.id, graceProposal.id)).get()!
        .claimedBy,
    ).toBe(a.user.id);
    expect(leaseRow("epic", liveEpic.id)).toBeDefined();
    expect(leaseRow("proposal", graceProposal.id)).toBeDefined();
    expect(reclaimedListener).not.toHaveBeenCalled();
    expect(auditListener).not.toHaveBeenCalled();
  });
});
