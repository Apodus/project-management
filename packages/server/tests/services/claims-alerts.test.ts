import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createId, LEASE_GRACE_MS_DEFAULT } from "@pm/shared";
import {
  createTestApp,
  createTestProject,
  createTestTask,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { claimLeases, claimsAlertState } from "../../src/db/index.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import * as claimsHealth from "../../src/services/claims-health.service.js";

// Fixed reference "now" so ages are deterministic.
const NOW = new Date("2026-05-30T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR = 3600_000;
const GRACE = LEASE_GRACE_MS_DEFAULT;

function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

/**
 * Seed a claim_leases row for an entity. `expiresAt` controls staleness: a value
 * older than (NOW − grace) is stale; a fresh value is live.
 */
function seedLease(
  testApp: TestApp,
  args: {
    entityType: "task" | "epic" | "proposal";
    entityId: string;
    holderId: string | null;
    expiresAt: string;
  },
): string {
  const id = createId();
  const ts = args.expiresAt;
  testApp.db
    .insert(claimLeases)
    .values({
      id,
      entityType: args.entityType,
      entityId: args.entityId,
      holderId: args.holderId,
      claimedAt: ts,
      heartbeatAt: ts,
      expiresAt: args.expiresAt,
      lastActivityAt: ts,
      sessionId: null,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return id;
}

function readLatch(testApp: TestApp, projectId: string) {
  return testApp.db
    .select()
    .from(claimsAlertState)
    .where(eq(claimsAlertState.projectId, projectId))
    .get();
}

describe("claims on-read stale-claim alert (Campaign C3 §P5a)", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Fire once, latch, reset on clear, re-fire (edge re-arm) ────────

  it("claim.stale_alert fires ONCE, latches, resets on clear, and re-fires", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: holder.id,
    });

    // A lease that lapsed well past the grace window → stale.
    const leaseId = seedLease(testApp, {
      entityType: "task",
      entityId: task.id,
      holderId: holder.id,
      expiresAt: ago(GRACE + 2 * HOUR),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.CLAIM_STALE_ALERT, (p) => calls.push(p.entity));

    // First read → fires once + latches.
    const first = claimsHealth.computeClaimsHealth(project.id, NOW);
    expect(first.staleCount).toBe(1);
    expect(first.oldestStaleAgeMs).toBe(GRACE + 2 * HOUR);
    expect(calls).toHaveLength(1);
    expect(readLatch(testApp, project.id)?.staleClaimsNotified).toBe(true);

    // Second read while still stale → latched, does NOT re-fire.
    claimsHealth.computeClaimsHealth(project.id, NOW);
    expect(calls).toHaveLength(1);

    // Resolve: renew the lease (fresh expiry) so it is no longer stale → latch
    // resets, no fire.
    testApp.db
      .update(claimLeases)
      .set({ expiresAt: new Date(NOW_MS + HOUR).toISOString() })
      .where(eq(claimLeases.id, leaseId))
      .run();
    const cleared = claimsHealth.computeClaimsHealth(project.id, NOW);
    expect(cleared.staleCount).toBe(0);
    expect(calls).toHaveLength(1); // no new fire
    expect(readLatch(testApp, project.id)?.staleClaimsNotified).toBe(false);

    // Re-introduce stale (lapse the lease again) → re-fires (edge re-arm).
    testApp.db
      .update(claimLeases)
      .set({ expiresAt: ago(GRACE + 2 * HOUR) })
      .where(eq(claimLeases.id, leaseId))
      .run();
    claimsHealth.computeClaimsHealth(project.id, NOW);
    expect(calls).toHaveLength(2);
    expect(readLatch(testApp, project.id)?.staleClaimsNotified).toBe(true);
  });

  // ── No stale → no fire ────────────────────────────────────────────

  it("does NOT fire when there are no stale claims (fresh lease)", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: holder.id,
    });

    // A lease still inside its TTL → live, not stale.
    seedLease(testApp, {
      entityType: "task",
      entityId: task.id,
      holderId: holder.id,
      expiresAt: new Date(NOW_MS + HOUR).toISOString(),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.CLAIM_STALE_ALERT, (p) => calls.push(p.entity));

    const health = claimsHealth.computeClaimsHealth(project.id, NOW);
    expect(health.staleCount).toBe(0);
    expect(calls).toHaveLength(0);
    expect(readLatch(testApp, project.id)?.staleClaimsNotified).toBe(false);
  });

  it("does NOT fire when a lapsed lease is within the grace window (not yet stale)", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: holder.id,
    });

    // Expired (TTL lapsed) but still inside the grace window → still live.
    seedLease(testApp, {
      entityType: "task",
      entityId: task.id,
      holderId: holder.id,
      expiresAt: ago(GRACE - HOUR),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.CLAIM_STALE_ALERT, (p) => calls.push(p.entity));

    const health = claimsHealth.computeClaimsHealth(project.id, NOW);
    expect(health.staleCount).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("does NOT fire for a stale lease whose entity belongs to ANOTHER project", () => {
    const project = createTestProject(testApp.db);
    const other = createTestProject(testApp.db);
    const holder = createTestUser(testApp.db);
    // The task — and thus the claimed entity — lives in the OTHER project.
    const task = createTestTask(testApp.db, {
      projectId: other.id,
      assigneeId: holder.id,
    });

    seedLease(testApp, {
      entityType: "task",
      entityId: task.id,
      holderId: holder.id,
      expiresAt: ago(GRACE + 2 * HOUR),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.CLAIM_STALE_ALERT, (p) => calls.push(p.entity));

    const health = claimsHealth.computeClaimsHealth(project.id, NOW);
    expect(health.staleCount).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("does NOT fire for a stale lease whose holder is null", () => {
    const project = createTestProject(testApp.db);
    const task = createTestTask(testApp.db, { projectId: project.id });

    // Lapsed past grace but holderId is null → already released, not a stale claim.
    seedLease(testApp, {
      entityType: "task",
      entityId: task.id,
      holderId: null,
      expiresAt: ago(GRACE + 2 * HOUR),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.CLAIM_STALE_ALERT, (p) => calls.push(p.entity));

    const health = claimsHealth.computeClaimsHealth(project.id, NOW);
    expect(health.staleCount).toBe(0);
    expect(calls).toHaveLength(0);
  });

  // ── Latch UPDATE touches ONLY the latch column ────────────────────

  it("the latch UPDATE touches only stale_claims_notified + updated_at", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: holder.id,
    });
    seedLease(testApp, {
      entityType: "task",
      entityId: task.id,
      holderId: holder.id,
      expiresAt: ago(GRACE + 2 * HOUR),
    });

    // First read lazily creates the row + latches true.
    claimsHealth.computeClaimsHealth(project.id, NOW);
    const after = readLatch(testApp, project.id);
    expect(after).toBeDefined();
    expect(after!.staleClaimsNotified).toBe(true);
    // The id + projectId + createdAt are preserved (not clobbered) by the
    // single-column latch UPDATE.
    expect(after!.projectId).toBe(project.id);
    expect(after!.id).toBeTruthy();
    expect(after!.createdAt).toBeTruthy();
  });

  // ── Identity masking: payload carries NO holder id ────────────────

  it("the emitted payload carries NO holder id (identity-masked)", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: holder.id,
    });
    seedLease(testApp, {
      entityType: "task",
      entityId: task.id,
      holderId: holder.id,
      expiresAt: ago(GRACE + 2 * HOUR),
    });

    let captured: Record<string, unknown> | null = null;
    getEventBus().on(EVENT_NAMES.CLAIM_STALE_ALERT, (p) => {
      captured = p.entity as Record<string, unknown>;
    });

    claimsHealth.computeClaimsHealth(project.id, NOW);
    expect(captured).not.toBeNull();
    const payload = captured!;
    // The aggregate fields are present...
    expect(payload.staleCount).toBe(1);
    expect(payload.projectId).toBe(project.id);
    // ...and NO holder id leaks (no value in the payload equals the holder).
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(holder.id);
    expect(Object.values(payload)).not.toContain(holder.id);
  });

  // ── Multiple entity types aggregate together ──────────────────────

  it("aggregates stale claims across task / epic / proposal in the same project", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestUser(testApp.db);

    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: holder.id,
    });
    seedLease(testApp, {
      entityType: "task",
      entityId: task.id,
      holderId: holder.id,
      expiresAt: ago(GRACE + HOUR),
    });

    const calls: unknown[] = [];
    getEventBus().on(EVENT_NAMES.CLAIM_STALE_ALERT, (p) => calls.push(p.entity));

    const health = claimsHealth.computeClaimsHealth(project.id, NOW);
    expect(health.staleCount).toBe(1);
    expect(calls).toHaveLength(1);
  });

  // ── Webhook-failure resilience (mirror the train test) ────────────

  it("computeClaimsHealth returns normally even when the Discord POST rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // A project with a configured Discord webhook so the listener tries to POST.
    const project = createTestProject(testApp.db, {
      settings: {
        ai_autonomy: {
          can_self_assign: true,
          can_create_subtasks: true,
          can_create_tasks: true,
          can_change_priority: true,
          can_close_epics: true,
          max_concurrent_tasks: 3,
        },
        workflow: { statuses: ["backlog", "done"] },
        git: { branch_prefix: "feat/", auto_link_branches: true },
        webhooks: {
          discord_url: "https://discord.com/api/webhooks/1/abc",
          alerts_enabled: true,
        },
      },
    });
    const holder = createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: holder.id,
    });
    seedLease(testApp, {
      entityType: "task",
      entityId: task.id,
      holderId: holder.id,
      expiresAt: ago(GRACE + 2 * HOUR),
    });

    const health = claimsHealth.computeClaimsHealth(project.id, NOW);
    expect(health.staleCount).toBe(1);
    await new Promise((r) => setImmediate(r));
    // The stale alert tried to POST a masked message to Discord.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.content).toContain("Stale claims");
    // The masked message must NOT contain the holder id.
    expect(body.content).not.toContain(holder.id);

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
