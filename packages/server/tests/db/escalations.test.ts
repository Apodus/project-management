import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  initializeDatabase,
  closeDb,
  workspaces,
  users,
  projects,
  escalations,
  escalationMessages,
} from "../../src/db/index.js";
import type { AppDatabase } from "../../src/db/index.js";

function now(): string {
  return new Date().toISOString();
}

function setupDb(): AppDatabase {
  return initializeDatabase({ inMemory: true });
}

// ──────────────────────────────────────────────────────────────────
// Campaign C1 (escalation-channel §P1): the escalations +
// escalation_messages tables. P1 adds the tables only (no service
// reads/writes them yet) — these tests pin the shape, the FK/uniqueness
// contracts, the JSON round-trips, and the cascade/set-null behavior.
// ──────────────────────────────────────────────────────────────────

describe("escalations schema (C1 P1)", () => {
  afterEach(() => {
    closeDb();
  });

  // ── Table + column shape ─────────────────────────────────────────
  describe("table existence", () => {
    it("creates escalations with all 19 columns", () => {
      const db = setupDb();
      const present = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name='escalations'`,
      );
      expect((present as any[]).map((r: any) => r.name)).toContain("escalations");

      const cols = db.all<{ name: string }>(sql`PRAGMA table_info(escalations)`);
      const names = (cols as any[]).map((c: any) => c.name).sort();
      expect(names).toEqual(
        [
          "id",
          "project_id",
          "kind",
          "status",
          "severity",
          "title",
          "body",
          "code_locator",
          "anchor_type",
          "anchor_id",
          "origin_repo",
          "origin_worker_key",
          "holder_id",
          "author_id",
          "created_at",
          "updated_at",
          "resolved_at",
          "resolved_by",
          "origin_last_seen_seq",
        ].sort(),
      );
    });

    it("creates escalation_messages with all 8 columns (incl. seq)", () => {
      const db = setupDb();
      const present = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name='escalation_messages'`,
      );
      expect((present as any[]).map((r: any) => r.name)).toContain("escalation_messages");

      const cols = db.all<{ name: string }>(sql`PRAGMA table_info(escalation_messages)`);
      const names = (cols as any[]).map((c: any) => c.name).sort();
      expect(names).toContain("seq");
      expect(names).toEqual(
        [
          "id",
          "escalation_id",
          "seq",
          "author_id",
          "body",
          "message_type",
          "metadata",
          "created_at",
        ].sort(),
      );
    });

    it("creates the escalations indexes and the thread-seq unique index", () => {
      const db = setupDb();
      const escIndexes = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='escalations'`,
      );
      const escNames = (escIndexes as any[]).map((r: any) => r.name);
      expect(escNames).toContain("idx_escalations_project_status");
      expect(escNames).toContain("idx_escalations_holder");
      expect(escNames).toContain("idx_escalations_origin");

      const msgIndexes = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='escalation_messages'`,
      );
      const msgNames = (msgIndexes as any[]).map((r: any) => r.name);
      expect(msgNames).toContain("idx_escalation_messages_thread_seq");
    });
  });

  // ── CRUD + constraints ───────────────────────────────────────────
  describe("rows and constraints", () => {
    let db: AppDatabase;
    let userId: string;
    let projectId: string;

    beforeEach(() => {
      db = setupDb();
      const workspaceId = db.select().from(workspaces).all()[0].id;
      const ts = now();

      userId = createId();
      db.insert(users)
        .values({
          id: userId,
          username: "escalator",
          displayName: "Escalation Author",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "Escalation Project",
          slug: "escalation-project",
          createdAt: ts,
          updatedAt: ts,
          createdBy: userId,
        })
        .run();
    });

    function insertEscalation(overrides: Record<string, unknown> = {}): string {
      const id = createId();
      const ts = now();
      db.insert(escalations)
        .values({
          id,
          projectId,
          kind: "bug_report",
          title: "Something is broken",
          originRepo: "game_one",
          originWorkerKey: "worker-1",
          authorId: userId,
          createdAt: ts,
          updatedAt: ts,
          ...overrides,
        })
        .run();
      return id;
    }

    it("inserts an escalation + a message and reads them back (defaults + nullables)", () => {
      const escId = insertEscalation();

      const esc = db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(esc).toBeDefined();
      expect(esc!.kind).toBe("bug_report");
      expect(esc!.status).toBe("open"); // default
      // Nullable columns default null.
      expect(esc!.severity).toBeNull();
      expect(esc!.body).toBeNull();
      expect(esc!.codeLocator).toBeNull();
      expect(esc!.anchorType).toBeNull();
      expect(esc!.anchorId).toBeNull();
      expect(esc!.holderId).toBeNull();
      expect(esc!.resolvedAt).toBeNull();
      expect(esc!.resolvedBy).toBeNull();

      const msgId = createId();
      const ts = now();
      db.insert(escalationMessages)
        .values({
          id: msgId,
          escalationId: escId,
          seq: 1,
          authorId: userId,
          body: "Here is more detail",
          createdAt: ts,
        })
        .run();

      const msg = db
        .select()
        .from(escalationMessages)
        .where(eq(escalationMessages.id, msgId))
        .get();
      expect(msg).toBeDefined();
      expect(msg!.escalationId).toBe(escId);
      expect(msg!.seq).toBe(1);
      expect(msg!.body).toBe("Here is more detail");
      expect(msg!.messageType).toBeNull();
      expect(msg!.metadata).toBeNull();
    });

    it("round-trips codeLocator and metadata JSON as objects", () => {
      const codeLocator = {
        repo: "game_one",
        path: "src/render.rs",
        lineStart: 42,
        lineEnd: 50,
      };
      const escId = insertEscalation({ codeLocator });

      const esc = db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(esc!.codeLocator).toEqual(codeLocator);

      const msgId = createId();
      const ts = now();
      const metadata = { attempt: 3, tags: ["blocking", "ci"] };
      db.insert(escalationMessages)
        .values({
          id: msgId,
          escalationId: escId,
          seq: 1,
          authorId: userId,
          body: "with metadata",
          metadata,
          createdAt: ts,
        })
        .run();

      const msg = db
        .select()
        .from(escalationMessages)
        .where(eq(escalationMessages.id, msgId))
        .get();
      expect(msg!.metadata).toEqual(metadata);
    });

    it("rejects two messages with the same (escalationId, seq) — per-thread monotonicity", () => {
      const escId = insertEscalation();
      const ts = now();
      db.insert(escalationMessages)
        .values({
          id: createId(),
          escalationId: escId,
          seq: 1,
          authorId: userId,
          body: "first",
          createdAt: ts,
        })
        .run();

      expect(() => {
        db.insert(escalationMessages)
          .values({
            id: createId(),
            escalationId: escId,
            seq: 1,
            authorId: userId,
            body: "duplicate seq",
            createdAt: ts,
          })
          .run();
      }).toThrow();
    });

    it("CASCADE: deleting an escalation deletes its messages", () => {
      const escId = insertEscalation();
      const ts = now();
      const msgId = createId();
      db.insert(escalationMessages)
        .values({
          id: msgId,
          escalationId: escId,
          seq: 1,
          authorId: userId,
          body: "to be cascaded",
          createdAt: ts,
        })
        .run();

      db.delete(escalations).where(eq(escalations.id, escId)).run();

      const msg = db
        .select()
        .from(escalationMessages)
        .where(eq(escalationMessages.id, msgId))
        .get();
      expect(msg).toBeUndefined();
    });

    it("SET NULL on holder_id when the holder is deleted (escalation survives)", () => {
      const ts = now();
      // A distinct holder so the delete is clean (not the author/project creator).
      const holderId = createId();
      db.insert(users)
        .values({
          id: holderId,
          username: "holder",
          displayName: "Escalation Holder",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const escId = insertEscalation({ holderId });
      db.delete(users).where(eq(users.id, holderId)).run();

      const esc = db.select().from(escalations).where(eq(escalations.id, escId)).get();
      expect(esc).toBeDefined();
      expect(esc!.holderId).toBeNull();
    });

    it("rejects an escalation with a nonexistent project_id (FK enforced)", () => {
      const ts = now();
      expect(() => {
        db.insert(escalations)
          .values({
            id: createId(),
            projectId: "nonexistent",
            kind: "question",
            title: "bad project",
            originRepo: "game_one",
            originWorkerKey: "worker-1",
            authorId: userId,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }).toThrow();
    });

    it("rejects a message with a nonexistent escalation_id (FK enforced)", () => {
      const ts = now();
      expect(() => {
        db.insert(escalationMessages)
          .values({
            id: createId(),
            escalationId: "nonexistent",
            seq: 1,
            authorId: userId,
            body: "orphan message",
            createdAt: ts,
          })
          .run();
      }).toThrow();
    });
  });
});
