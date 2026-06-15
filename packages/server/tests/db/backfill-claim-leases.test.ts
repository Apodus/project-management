import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createTestAiAgent,
  createTestApp,
  createTestEpic,
  createTestProject,
  createTestProposal,
  createTestTask,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { claimLeases, epics, proposals } from "../../src/db/index.js";
import { getRawDb } from "../../src/db/index.js";
import * as taskSvc from "../../src/services/task.service.js";
import type { AuthUser } from "../../src/types.js";

// ──────────────────────────────────────────────────────────────────
// Migration 0034 — backfill an already-expired lease for every legacy
// claimed-but-leaseless (non-terminal) entity, so "no lease ⇒ stale by
// definition" holds with no leaseless holders left in the data. The test
// runs the REAL shipped .sql against seeded legacy rows (the migration
// itself was a no-op at app init since the tables were empty).
// ──────────────────────────────────────────────────────────────────

const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL("../../src/db/migrations/0034_backfill_claim_leases.sql", import.meta.url)),
  "utf8",
);

const EPOCH = "1970-01-01T00:00:00.000Z";

describe("migration 0034 — backfill claim_leases", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  function runBackfill() {
    getRawDb().exec(MIGRATION_SQL);
  }

  function leaseRow(entityType: string, entityId: string) {
    return testApp.db
      .select()
      .from(claimLeases)
      .where(and(eq(claimLeases.entityType, entityType), eq(claimLeases.entityId, entityId)))
      .get();
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

  it("backfills an expired lease for a leaseless claimed task/epic/proposal", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestAiAgent(testApp.db);

    // Claimed (holder set) but NO lease row — the legacy pre-engine state.
    // createTestTask sets assigneeId directly; epic/proposal holders are set via
    // a direct UPDATE (the helpers don't expose those fields), neither of which
    // creates a lease.
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: holder.user.id,
      status: "ready",
    });
    const epic = createTestEpic(testApp.db, {
      projectId: project.id,
      status: "active",
    });
    testApp.db.update(epics).set({ assigneeId: holder.user.id }).where(eq(epics.id, epic.id)).run();
    const proposal = createTestProposal(testApp.db, {
      projectId: project.id,
      status: "draft",
    });
    testApp.db
      .update(proposals)
      .set({ claimedBy: holder.user.id })
      .where(eq(proposals.id, proposal.id))
      .run();

    expect(leaseRow("task", task.id)).toBeUndefined();
    expect(leaseRow("epic", epic.id)).toBeUndefined();
    expect(leaseRow("proposal", proposal.id)).toBeUndefined();

    runBackfill();

    for (const [type, id] of [
      ["task", task.id],
      ["epic", epic.id],
      ["proposal", proposal.id],
    ] as const) {
      const lease = leaseRow(type, id);
      expect(lease, `${type} lease`).toBeDefined();
      expect(lease!.holderId).toBe(holder.user.id);
      // Epoch expiry ⇒ stale by definition (always past TTL + grace).
      expect(lease!.expiresAt).toBe(EPOCH);
    }
  });

  it("does NOT backfill a terminal (closed) claimed entity", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestAiAgent(testApp.db);

    const doneTask = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: holder.user.id,
      status: "done",
    });
    const completedEpic = createTestEpic(testApp.db, {
      projectId: project.id,
      status: "completed",
    });
    testApp.db
      .update(epics)
      .set({ assigneeId: holder.user.id })
      .where(eq(epics.id, completedEpic.id))
      .run();
    const rejectedProposal = createTestProposal(testApp.db, {
      projectId: project.id,
      status: "rejected",
    });
    testApp.db
      .update(proposals)
      .set({ claimedBy: holder.user.id })
      .where(eq(proposals.id, rejectedProposal.id))
      .run();

    runBackfill();

    expect(leaseRow("task", doneTask.id)).toBeUndefined();
    expect(leaseRow("epic", completedEpic.id)).toBeUndefined();
    expect(leaseRow("proposal", rejectedProposal.id)).toBeUndefined();
  });

  it("does NOT backfill an unclaimed entity", () => {
    const project = createTestProject(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      status: "ready",
    });

    runBackfill();

    expect(leaseRow("task", task.id)).toBeUndefined();
  });

  it("leaves an entity that already has a live lease untouched", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestAiAgent(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      status: "ready",
    });
    // A real claim creates a live (future-expiry) lease.
    taskSvc.claim(task.id, aiActor(holder.user.id));
    const before = leaseRow("task", task.id)!;
    expect(before.expiresAt).not.toBe(EPOCH);

    runBackfill();

    const after = leaseRow("task", task.id)!;
    // Same row, NOT overwritten to the epoch — the NOT EXISTS guard skipped it.
    expect(after.id).toBe(before.id);
    expect(after.expiresAt).toBe(before.expiresAt);
  });

  it("is idempotent — a second run creates no duplicate lease", () => {
    const project = createTestProject(testApp.db);
    const holder = createTestAiAgent(testApp.db);
    createTestUser(testApp.db);
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      assigneeId: holder.user.id,
      status: "ready",
    });

    runBackfill();
    runBackfill();

    const rows = testApp.db
      .select()
      .from(claimLeases)
      .where(and(eq(claimLeases.entityType, "task"), eq(claimLeases.entityId, task.id)))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiresAt).toBe(EPOCH);
  });
});
