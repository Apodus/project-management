import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  initializeDatabase,
  closeDb,
  workspaces,
  users,
  projects,
  tasks,
  claimLeases,
} from "../../src/db/index.js";
import type { AppDatabase } from "../../src/db/index.js";

function now(): string {
  return new Date().toISOString();
}

function setupDb(): AppDatabase {
  return initializeDatabase({ inMemory: true });
}

// ──────────────────────────────────────────────────────────────────
// Campaign C2 (claim-lease §P1): the claim_leases table. P1 adds the
// table only (no service reads/writes it yet) — these tests pin the
// shape, the FK/uniqueness contracts, and a basic round-trip.
// ──────────────────────────────────────────────────────────────────

describe("claim_leases schema (C2 P1)", () => {
  afterEach(() => {
    closeDb();
  });

  // ── Table + column shape ─────────────────────────────────────────
  describe("table existence", () => {
    it("creates claim_leases with all 11 columns", () => {
      const db = setupDb();
      const present = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name='claim_leases'`,
      );
      expect((present as any[]).map((r: any) => r.name)).toContain("claim_leases");

      const cols = db.all<{ name: string }>(sql`PRAGMA table_info(claim_leases)`);
      const names = (cols as any[]).map((c: any) => c.name).sort();
      expect(names).toEqual(
        [
          "id",
          "entity_type",
          "entity_id",
          "holder_id",
          "claimed_at",
          "heartbeat_at",
          "expires_at",
          "last_activity_at",
          "session_id",
          "created_at",
          "updated_at",
        ].sort(),
      );
    });

    it("creates the unique entity index and the reclaim-sweep index", () => {
      const db = setupDb();
      const indexes = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='claim_leases'`,
      );
      const names = (indexes as any[]).map((r: any) => r.name);
      expect(names).toContain("idx_claim_leases_entity");
      expect(names).toContain("idx_claim_leases_type_expires");
      expect(names).toContain("idx_claim_leases_holder");
    });
  });

  // ── CRUD + constraints ───────────────────────────────────────────
  describe("rows and constraints", () => {
    let db: AppDatabase;
    let userId: string;
    let taskId: string;

    beforeEach(() => {
      db = setupDb();
      const workspaceId = db.select().from(workspaces).all()[0].id;
      const ts = now();

      userId = createId();
      db.insert(users)
        .values({
          id: userId,
          username: "leaser",
          displayName: "Lease Holder",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "Lease Project",
          slug: "lease-project",
          createdAt: ts,
          updatedAt: ts,
          createdBy: userId,
        })
        .run();

      // A task the lease will point at (entityId is not an FK, but seed a
      // real entity for realism).
      taskId = createId();
      db.insert(tasks)
        .values({
          id: taskId,
          projectId,
          title: "Leased task",
          reporterId: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    });

    it("inserts a lease and reads it back (sessionId null when omitted)", () => {
      const id = createId();
      const ts = now();
      db.insert(claimLeases)
        .values({
          id,
          entityType: "task",
          entityId: taskId,
          holderId: userId,
          claimedAt: ts,
          heartbeatAt: ts,
          expiresAt: ts,
          lastActivityAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db.select().from(claimLeases).where(eq(claimLeases.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.entityType).toBe("task");
      expect(result!.entityId).toBe(taskId);
      expect(result!.holderId).toBe(userId);
      expect(result!.sessionId).toBeNull();
    });

    it("rejects a duplicate (entityType, entityId) — one active lease per entity", () => {
      const ts = now();
      db.insert(claimLeases)
        .values({
          id: createId(),
          entityType: "task",
          entityId: taskId,
          holderId: userId,
          claimedAt: ts,
          heartbeatAt: ts,
          expiresAt: ts,
          lastActivityAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      expect(() => {
        db.insert(claimLeases)
          .values({
            id: createId(),
            entityType: "task",
            entityId: taskId,
            holderId: userId,
            claimedAt: ts,
            heartbeatAt: ts,
            expiresAt: ts,
            lastActivityAt: ts,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }).toThrow();
    });

    it("SET NULL on holder_id when the holder is deleted (lease survives)", () => {
      const ts = now();
      // A distinct holder so the delete is clean (not the project creator).
      const holderId = createId();
      db.insert(users)
        .values({
          id: holderId,
          username: "transient",
          displayName: "Transient Holder",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const id = createId();
      db.insert(claimLeases)
        .values({
          id,
          entityType: "epic",
          entityId: createId(),
          holderId,
          claimedAt: ts,
          heartbeatAt: ts,
          expiresAt: ts,
          lastActivityAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      db.delete(users).where(eq(users.id, holderId)).run();

      const result = db.select().from(claimLeases).where(eq(claimLeases.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.holderId).toBeNull();
      expect(result!.entityType).toBe("epic");
    });

    it("rejects a nonexistent holder_id (FK enforced)", () => {
      const ts = now();
      expect(() => {
        db.insert(claimLeases)
          .values({
            id: createId(),
            entityType: "proposal",
            entityId: createId(),
            holderId: "nonexistent",
            claimedAt: ts,
            heartbeatAt: ts,
            expiresAt: ts,
            lastActivityAt: ts,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }).toThrow();
    });
  });
});
