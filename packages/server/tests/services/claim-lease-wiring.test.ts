import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  CLAIM_LEASE_RECLAIMED_EVENT,
  LEASE_GRACE_MS_DEFAULT,
  LEASE_TTL_MS_DEFAULT,
} from "@pm/shared";
import {
  createTestAiAgent,
  createTestEpic,
  createTestProject,
  createTestProposal,
  createTestTask,
  createTestUser,
  type TestApp,
  createTestApp,
} from "../utils.js";
import { claimLeases, epics, tasks } from "../../src/db/index.js";
import { getEventBus } from "../../src/events/event-bus.js";
import type { AuthUser } from "../../src/types.js";
import * as taskSvc from "../../src/services/task.service.js";
import * as epicSvc from "../../src/services/epic.service.js";
import * as proposalSvc from "../../src/services/proposal.service.js";
import * as claimLeaseSvc from "../../src/services/claim-lease.service.js";

// ──────────────────────────────────────────────────────────────────
// Campaign C2 (claim-lease §P3): the lease wired into the claim
// lifecycle + the liveness-aware assertClaimOk seam. Verifies that
// every claim/release/terminal/force/sync point keeps the lease in
// step, that a holder's own write self-heals + renews its lease (so a
// holder is never 409'd for its own stale lease), and that the sweep
// wiring is observe-only (shadow) in the production posture.
// ──────────────────────────────────────────────────────────────────

describe("claim-lease wiring (P3)", () => {
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
      .where(and(eq(claimLeases.entityType, entityType), eq(claimLeases.entityId, entityId)))
      .get();
  }

  function leaseRows(entityType: string, entityId: string) {
    return testApp.db
      .select()
      .from(claimLeases)
      .where(and(eq(claimLeases.entityType, entityType), eq(claimLeases.entityId, entityId)))
      .all();
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

  // ── 1. Headline self-stale: holder writes past TTL+grace, no 409 ──
  it("a holder's write past TTL+grace does NOT 409 and advances its lease expiry", () => {
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

    // A claims → lease established at t0 (expiry t0 + TTL).
    expect(taskSvc.claim(task.id, aiActor(a.user.id)).ok).toBe(true);
    const initial = leaseRow("task", task.id)!;
    expect(initial.holderId).toBe(a.user.id);

    // Advance well past TTL + grace — the lease is "stale" by liveness.
    const later = new Date(t0.getTime() + LEASE_TTL_MS_DEFAULT + LEASE_GRACE_MS_DEFAULT + 60_000);
    vi.setSystemTime(later);

    // A's own write (a non-status update) must NOT be denied — and it heals
    // the lease forward (renew advances expiresAt to now + TTL).
    expect(() =>
      taskSvc.update(task.id, { title: "still mine" }, aiActor(a.user.id)),
    ).not.toThrow();

    const after = leaseRow("task", task.id)!;
    expect(after.holderId).toBe(a.user.id);
    expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(initial.expiresAt));
    expect(after.expiresAt).toBe(new Date(later.getTime() + LEASE_TTL_MS_DEFAULT).toISOString());
  });

  // ── 2. Self-stale create-if-missing (legacy holder, no lease row) ──
  it("a legacy holder (assigneeId set, no lease) writes without 409 and a lease is created", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    // Born already-assigned to A but with NO lease row (pre-engine state).
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      assigneeId: a.user.id,
      status: "in_progress",
    });

    expect(leaseRow("task", task.id)).toBeUndefined();

    expect(() =>
      taskSvc.update(task.id, { title: "legacy write" }, aiActor(a.user.id)),
    ).not.toThrow();

    const lease = leaseRow("task", task.id);
    expect(lease).toBeDefined();
    expect(lease!.holderId).toBe(a.user.id);
  });

  // ── 3. Claim creates exactly one lease (task/epic/proposal) ───────
  it("claim creates exactly one lease held by the claimant — task/epic/proposal", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);

    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });
    const epic = createTestEpic(testApp.db, { projectId: project.id });
    const proposal = createTestProposal(testApp.db, { projectId: project.id });

    taskSvc.claim(task.id, aiActor(a.user.id));
    epicSvc.claim(epic.id, aiActor(a.user.id));
    proposalSvc.claim(proposal.id, aiActor(a.user.id));

    for (const [type, id] of [
      ["task", task.id],
      ["epic", epic.id],
      ["proposal", proposal.id],
    ] as const) {
      const rows = leaseRows(type, id);
      expect(rows).toHaveLength(1);
      expect(rows[0].holderId).toBe(a.user.id);
    }
  });

  // ── 4. Any holder action renews (expiresAt advances) ──────────────
  it("a holder action renews the lease (expiresAt advances)", () => {
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

    taskSvc.claim(task.id, aiActor(a.user.id));
    const before = leaseRow("task", task.id)!;

    // 5 minutes later (well within TTL) the holder writes again.
    const t1 = new Date(t0.getTime() + 5 * 60_000);
    vi.setSystemTime(t1);
    taskSvc.update(task.id, { title: "touch" }, aiActor(a.user.id));

    const after = leaseRow("task", task.id)!;
    expect(after.id).toBe(before.id);
    expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(before.expiresAt));
  });

  // ── 5. Release deletes the lease (task/epic/proposal) ─────────────
  it("release deletes the lease — task/epic/proposal", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);

    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });
    const epic = createTestEpic(testApp.db, { projectId: project.id });
    const proposal = createTestProposal(testApp.db, { projectId: project.id });

    taskSvc.claim(task.id, aiActor(a.user.id));
    epicSvc.claim(epic.id, aiActor(a.user.id));
    proposalSvc.claim(proposal.id, aiActor(a.user.id));

    taskSvc.release(task.id, aiActor(a.user.id));
    epicSvc.release(epic.id, aiActor(a.user.id));
    proposalSvc.release(proposal.id, aiActor(a.user.id));

    expect(leaseRow("task", task.id)).toBeUndefined();
    expect(leaseRow("epic", epic.id)).toBeUndefined();
    expect(leaseRow("proposal", proposal.id)).toBeUndefined();
  });

  // ── 6. Terminal status deletes the lease ──────────────────────────
  it("reaching a terminal status deletes the lease — task→done, epic→completed, proposal→rejected", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);

    // Task: claim, start, complete → done is terminal.
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });
    taskSvc.claim(task.id, aiActor(a.user.id));
    taskSvc.transition(task.id, "in_progress", aiActor(a.user.id));
    expect(leaseRow("task", task.id)).toBeDefined();
    taskSvc.transition(task.id, "done", aiActor(a.user.id));
    expect(leaseRow("task", task.id)).toBeUndefined();

    // Epic: claim, then update → completed is terminal.
    const epic = createTestEpic(testApp.db, {
      projectId: project.id,
      status: "in_progress",
    });
    epicSvc.claim(epic.id, aiActor(a.user.id));
    expect(leaseRow("epic", epic.id)).toBeDefined();
    epicSvc.update(epic.id, { status: "completed" }, aiActor(a.user.id));
    expect(leaseRow("epic", epic.id)).toBeUndefined();

    // Proposal: claim, then transition open→rejected (human, terminal).
    const human = createTestUser(testApp.db);
    const proposal = createTestProposal(testApp.db, {
      projectId: project.id,
      status: "open",
    });
    proposalSvc.claim(proposal.id, aiActor(a.user.id));
    expect(leaseRow("proposal", proposal.id)).toBeDefined();
    proposalSvc.transition(proposal.id, "rejected", humanActor(human.id));
    expect(leaseRow("proposal", proposal.id)).toBeUndefined();
  });

  // ── 7. Force-claim transfers the lease (A → B) ────────────────────
  it("force-claim transfers the lease from the old holder to the new", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });

    taskSvc.claim(task.id, aiActor(a.user.id));
    expect(leaseRow("task", task.id)!.holderId).toBe(a.user.id);

    // B (a different AI agent) force-claims to itself (claim-to-self allowed).
    const b = createTestAiAgent(testApp.db);
    taskSvc.forceClaim(task.id, aiActor(b.user.id), { reason: "taking over" });

    const rows = leaseRows("task", task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].holderId).toBe(b.user.id);
  });

  // ── 8. Non-holder still 409, with NO lease side effect ────────────
  it("a non-holder write still 409s and creates NO lease for the rejected agent", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const b = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });

    taskSvc.claim(task.id, aiActor(a.user.id));

    expect(() => taskSvc.update(task.id, { title: "not mine" }, aiActor(b.user.id))).toThrow(
      /claimed by another agent/i,
    );

    // The lease still belongs to A — B created nothing.
    const rows = leaseRows("task", task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].holderId).toBe(a.user.id);
  });

  // ── 9. Human write creates no lease ───────────────────────────────
  it("a human write neither requires nor creates a lease", () => {
    const project = createTestProject(testApp.db);
    const human = createTestUser(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });

    expect(() =>
      taskSvc.update(task.id, { title: "human edit" }, humanActor(human.id)),
    ).not.toThrow();

    expect(leaseRow("task", task.id)).toBeUndefined();
  });

  // ── 10. Sweep wired on claim/pick is a shadow no-op ───────────────
  it("the sweep wired on claim is shadow: a lapsed lease on another entity is untouched, no reclaim event", () => {
    const t0 = new Date("2026-06-06T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(t0);

    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);

    // Task 1 claimed by A, then time lapses past TTL+grace → its lease is stale.
    const stale = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
      assigneeId: a.user.id,
    });
    taskSvc.claim(stale.id, aiActor(a.user.id)); // idempotent re-claim arms lease

    const later = new Date(t0.getTime() + LEASE_TTL_MS_DEFAULT + LEASE_GRACE_MS_DEFAULT + 60_000);
    vi.setSystemTime(later);

    let reclaimed = 0;
    getEventBus().on(CLAIM_LEASE_RECLAIMED_EVENT as never, () => {
      reclaimed += 1;
    });

    // A different agent claims a different task — this runs the batch sweep at
    // the top of claim (entityType-wide). In the default shadow posture it must
    // NOT reclaim/clear the lapsed lease, NOT null the stale task's assignee,
    // and NOT emit a reclaim event.
    const b = createTestAiAgent(testApp.db);
    const other = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });
    taskSvc.claim(other.id, aiActor(b.user.id));

    // The stale lease + its holder are untouched.
    const staleLease = leaseRow("task", stale.id);
    expect(staleLease).toBeDefined();
    expect(staleLease!.holderId).toBe(a.user.id);
    const staleTask = testApp.db.select().from(tasks).where(eq(tasks.id, stale.id)).get()!;
    expect(staleTask.assigneeId).toBe(a.user.id);
    expect(reclaimed).toBe(0);
  });

  // ── 11. Idempotent re-claim arms a lease for a legacy holder ──────
  it("an idempotent re-claim (already_claimed_by_you) creates a lease for a legacy holder", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const reporter = createTestUser(testApp.db);
    // Already assigned to A, but NO lease (pre-engine).
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      assigneeId: a.user.id,
      status: "in_progress",
    });
    expect(leaseRow("task", task.id)).toBeUndefined();

    const res = taskSvc.claim(task.id, aiActor(a.user.id));
    expect(res).toEqual({ ok: true, status: "already_claimed_by_you" });

    const lease = leaseRow("task", task.id);
    expect(lease).toBeDefined();
    expect(lease!.holderId).toBe(a.user.id);
  });

  // ── 12. task.update assignee-change keeps the lease in sync ────────
  it("a direct assignee PATCH syncs the lease: null deletes, a new id acquires for that holder", () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    const b = createTestAiAgent(testApp.db);
    const human = createTestUser(testApp.db);
    const reporter = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: reporter.id,
      status: "ready",
    });

    // A holds (lease exists).
    taskSvc.claim(task.id, aiActor(a.user.id));
    expect(leaseRow("task", task.id)!.holderId).toBe(a.user.id);

    // Human PATCHes assignee → null: the lease is deleted.
    taskSvc.update(task.id, { assigneeId: null }, humanActor(human.id));
    expect(leaseRow("task", task.id)).toBeUndefined();

    // Human PATCHes assignee → B: the lease is acquired for B.
    taskSvc.update(task.id, { assigneeId: b.user.id }, humanActor(human.id));
    const lease = leaseRow("task", task.id);
    expect(lease).toBeDefined();
    expect(lease!.holderId).toBe(b.user.id);
  });

  // ── 13. Headline through the real claim path: a claimed (not started)
  //        epic whose lease lapses is freed by an explicit mode `on` sweep ──
  it("an epic claimed via epicSvc.claim (no status change) is freed by a mode-on sweep after expiry", () => {
    const t0 = new Date("2026-06-06T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(t0);

    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);

    // Claim acquires the lease through the real path; the epic never leaves its
    // initial status (no transition is performed).
    const epic = createTestEpic(testApp.db, { projectId: project.id });
    expect(epicSvc.claim(epic.id, aiActor(a.user.id)).ok).toBe(true);
    expect(leaseRow("epic", epic.id)!.holderId).toBe(a.user.id);
    const claimedEpic = testApp.db.select().from(epics).where(eq(epics.id, epic.id)).get()!;
    expect(claimedEpic.assigneeId).toBe(a.user.id);

    // Lapse past TTL + grace, then run the sweep in mode `on` explicitly.
    const later = new Date(t0.getTime() + LEASE_TTL_MS_DEFAULT + LEASE_GRACE_MS_DEFAULT + 60_000);
    const result = claimLeaseSvc.sweepStaleClaims({
      entityType: "epic",
      entityId: epic.id,
      now: later,
    });

    expect(result.reclaimed).toHaveLength(1);
    expect(leaseRow("epic", epic.id)).toBeUndefined();
    expect(
      testApp.db.select().from(epics).where(eq(epics.id, epic.id)).get()!.assigneeId,
    ).toBeNull();
  });
});
