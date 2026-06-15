/**
 * C2 amendment 7: the stale-claim ALERT grace must derive from the SAME
 * env-driven config as the lease engine (PM_LEASE_GRACE_SEC), not the pinned
 * LEASE_GRACE_MS_DEFAULT — otherwise badge-staleness (deriveClaimState) and
 * alert-staleness silently diverge under a tuned grace.
 *
 * This file tunes the env BEFORE importing any module (module-level consts in
 * claim-lease/claims-health resolve at import), so it lives alone — vitest's
 * per-file isolation gives it a fresh module registry. A lease lapsed ~20
 * minutes past expiry would be LIVE under the default 24h grace; with
 * PM_LEASE_GRACE_SEC=60 it must count as STALE in the alert aggregate.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

vi.stubEnv("PM_LEASE_GRACE_SEC", "60"); // 1-minute grace (default: 86400)

// The stub above runs at module evaluation; all app modules are imported
// DYNAMICALLY in beforeAll so their module-level env reads see the stub.
describe("claims-health alert grace follows PM_LEASE_GRACE_SEC (C2)", () => {
  let utils: typeof import("../utils.js");
  let claimsHealth: typeof import("../../src/services/claims-health.service.js");
  let leaseSvc: typeof import("../../src/services/claim-lease.service.js");
  let db: typeof import("../../src/db/index.js");
  let testApp: import("../utils.js").TestApp;

  beforeAll(async () => {
    utils = await import("../utils.js");
    claimsHealth = await import("../../src/services/claims-health.service.js");
    leaseSvc = await import("../../src/services/claim-lease.service.js");
    db = await import("../../src/db/index.js");
    testApp = utils.createTestApp();
  });

  afterAll(() => {
    testApp.cleanup();
    vi.unstubAllEnvs();
  });

  it("the lease engine resolved the tuned grace", () => {
    expect(leaseSvc.resolveActiveLeaseGraceMs()).toBe(60_000);
  });

  it("a claim ~20min past expiry counts STALE under the tuned 60s grace (it would be LIVE under the pinned 24h default)", () => {
    const project = utils.createTestProject(testApp.db);
    const agent = utils.createTestAiAgent(testApp.db);
    const t0 = new Date("2026-06-10T10:00:00.000Z");

    const task = utils.createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: agent.user.id,
    });
    // Acquire a short lease, then look 20 minutes past its expiry: past the
    // tuned 60s grace, far inside the default 86400s grace.
    leaseSvc.acquireLease("task", task.id, { id: agent.user.id }, { now: t0, ttlMs: 1000 });
    const later = new Date(t0.getTime() + 1_000 + 20 * 60_000);

    const health = claimsHealth.computeClaimsHealth(project.id, later);
    expect(health.staleCount).toBe(1);
    expect(health.oldestStaleAgeMs).toBeGreaterThan(0);

    // Sanity: the task row really is the one counted.
    const row = testApp.db.select().from(db.tasks).where(eq(db.tasks.id, task.id)).get();
    expect(row?.assigneeId).toBe(agent.user.id);
  });
});
