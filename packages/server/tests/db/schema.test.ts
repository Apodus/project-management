import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  initializeDatabase,
  getDb,
  closeDb,
  seedDefaultWorkspace,
  workspaces,
  users,
  projects,
  milestones,
  proposals,
  epics,
  tasks,
  taskDependencies,
  labels,
  taskLabels,
  comments,
  activityLog,
  gitRefs,
  mergeRequests,
  mergeRequestGroups,
  mergeIncidents,
  mergeResolutions,
  auditLog,
  trainState,
  claimsAlertState,
} from "../../src/db/index.js";
import type { AppDatabase } from "../../src/db/index.js";

// ──────────────────────────────────────────────────────────────────
// Helper: returns an in-memory database for each test
// ──────────────────────────────────────────────────────────────────
function now(): string {
  return new Date().toISOString();
}

function setupDb(): AppDatabase {
  return initializeDatabase({ inMemory: true });
}

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe("Database schema", () => {
  afterEach(() => {
    closeDb();
  });

  // ── Table existence ──────────────────────────────────────────────
  describe("table existence", () => {
    it("should create all 33 tables", () => {
      const db = setupDb();
      const tableNames = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' AND name NOT LIKE '%_fts%' ORDER BY name`,
      );

      // Extract just the name strings
      const names = (tableNames as any[]).map((r: any) => r.name).sort();

      const expected = [
        "activity_log",
        "agent_claims",
        "agent_pools",
        "audit_log",
        "automation_rules",
        "claim_leases",
        "claims_alert_state",
        "comments",
        "epic_dependencies",
        "epics",
        "git_refs",
        "integrator_health",
        "labels",
        "merge_attempts",
        "merge_incidents",
        "merge_lock_queue",
        "merge_locks",
        "merge_request_groups",
        "merge_requests",
        "merge_resolutions",
        "milestones",
        "notes",
        "projects",
        "proposals",
        "sessions",
        "task_dependencies",
        "task_labels",
        "tasks",
        "templates",
        "train_state",
        "users",
        "verify_cache",
        "workspaces",
      ].sort();

      expect(names).toEqual(expected);
    });

    it("migration 0016: merge_attempts has the additive steps column", () => {
      const db = setupDb();
      const cols = db.all<{ name: string }>(sql`PRAGMA table_info(merge_attempts)`);
      const names = (cols as any[]).map((c: any) => c.name);
      expect(names).toContain("steps");
    });

    it("migration 0017: merge_requests has the additive resolved_from column", () => {
      const db = setupDb();
      const cols = db.all<{ name: string }>(sql`PRAGMA table_info(merge_requests)`);
      const names = (cols as any[]).map((c: any) => c.name);
      expect(names).toContain("resolved_from");
    });

    it("migration 0022: agent_claims has the additive worker-binding columns", () => {
      const db = setupDb();
      const cols = db.all<{ name: string }>(sql`PRAGMA table_info(agent_claims)`);
      const names = (cols as any[]).map((c: any) => c.name);
      expect(names).toContain("worker_key");
      expect(names).toContain("worker_key_pool_id");
      expect(names).toContain("bind_handle");
    });
  });

  // ── Index existence ──────────────────────────────────────────────
  describe("index existence", () => {
    it("should create all expected indexes", () => {
      const db = setupDb();
      const indexes = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      );
      const names = (indexes as any[]).map((r: any) => r.name).sort();

      const expected = [
        "idx_users_username",
        "idx_projects_workspace_slug",
        "idx_proposals_project_status",
        "idx_proposals_created_by",
        "idx_tasks_project_status",
        "idx_tasks_project_epic",
        "idx_tasks_assignee",
        "idx_tasks_parent",
        "idx_tasks_priority",
        "idx_tasks_status_priority",
        "idx_activity_project",
        "idx_activity_entity",
        "idx_git_refs_task",
        "idx_git_refs_branch",
        "idx_comments_task",
        "idx_comments_proposal",
        "idx_deps_task",
        "idx_deps_depends_on",
        "idx_labels_project_name",
        "idx_merge_request_groups_project_state",
        "idx_merge_request_groups_resource_state",
        "idx_merge_incidents_project_state",
        "idx_merge_incidents_group",
        "idx_merge_incidents_open",
        "idx_merge_requests_group",
        "idx_audit_log_project_created",
        "idx_audit_log_actor",
        "idx_audit_log_target",
        "idx_integrator_health_project_resource",
        "idx_train_state_project_resource",
        "idx_verify_cache_key",
        "idx_verify_cache_project_resource_created",
        "idx_merge_resolutions_project_state",
        "idx_merge_resolutions_resource_state",
        "idx_merge_resolutions_origin",
        "idx_claim_leases_entity",
        "idx_claim_leases_type_expires",
        "idx_claim_leases_holder",
        "idx_agent_claims_worker",
        "idx_claims_alert_state_project",
      ].sort();

      for (const idx of expected) {
        expect(names).toContain(idx);
      }
    });
  });

  // ── FTS5 virtual tables ──────────────────────────────────────────
  describe("FTS5 virtual tables", () => {
    it("should create all 3 FTS5 virtual tables", () => {
      const db = setupDb();
      const vtables = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%' ORDER BY name`,
      );
      const names = (vtables as any[]).map((r: any) => r.name);

      expect(names).toContain("proposals_fts");
      expect(names).toContain("tasks_fts");
      expect(names).toContain("comments_fts");
    });
  });

  // ── SQLite pragmas ───────────────────────────────────────────────
  describe("SQLite pragmas", () => {
    it("should have WAL mode enabled", () => {
      // In-memory databases report journal_mode as "memory" even after
      // setting WAL, because WAL requires a file. We verify that the
      // pragma was set by checking it returns "memory" (expected for
      // in-memory) or "wal" (for file-based DBs).
      const db = setupDb();
      const result = db.all<{ journal_mode: string }>(sql`PRAGMA journal_mode`);
      const mode = (result as any[])[0].journal_mode;
      // In-memory SQLite uses "memory" journal mode; file-based would use "wal"
      expect(["wal", "memory"]).toContain(mode);
    });

    it("should have foreign keys enabled", () => {
      const db = setupDb();
      const result = db.all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`);
      expect((result as any[])[0].foreign_keys).toBe(1);
    });
  });

  // ── Default workspace seeding ────────────────────────────────────
  describe("default workspace seeding", () => {
    it("should seed a default workspace on init", () => {
      const db = setupDb();
      const ws = db.select().from(workspaces).all();
      expect(ws).toHaveLength(1);
      expect(ws[0].name).toBe("Default Workspace");
      expect(ws[0].id).toBeTruthy();
      expect(ws[0].createdAt).toBeTruthy();
      expect(ws[0].updatedAt).toBeTruthy();
    });

    it("should not duplicate workspace on re-init", () => {
      const db = setupDb();
      const ws1 = db.select().from(workspaces).all();
      expect(ws1).toHaveLength(1);

      // Call seedDefaultWorkspace again — should be idempotent
      seedDefaultWorkspace(db);

      const ws2 = db.select().from(workspaces).all();
      expect(ws2).toHaveLength(1);
    });
  });

  // ── Singleton behavior ───────────────────────────────────────────
  describe("singleton behavior", () => {
    it("getDb() should throw before init", () => {
      // closeDb was called in afterEach, and we haven't called init yet
      expect(() => getDb()).toThrow("Database not initialized");
    });

    it("closeDb() should reset singleton", () => {
      setupDb();
      expect(() => getDb()).not.toThrow();
      closeDb();
      expect(() => getDb()).toThrow("Database not initialized");
    });
  });

  // ── Basic CRUD on core tables ────────────────────────────────────
  describe("basic CRUD", () => {
    let db: AppDatabase;
    let workspaceId: string;
    let userId: string;
    let projectId: string;

    beforeEach(() => {
      db = setupDb();
      workspaceId = db.select().from(workspaces).all()[0].id;

      // Create a user
      userId = createId();
      const ts = now();
      db.insert(users)
        .values({
          id: userId,
          username: "testuser",
          displayName: "Test User",
          role: "admin",
          type: "human",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      // Create a project
      projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "Test Project",
          slug: "test-project",
          createdAt: ts,
          updatedAt: ts,
          createdBy: userId,
        })
        .run();
    });

    it("should insert and read back a user", () => {
      const result = db.select().from(users).where(eq(users.id, userId)).get();
      expect(result).toBeDefined();
      expect(result!.username).toBe("testuser");
      expect(result!.displayName).toBe("Test User");
      expect(result!.isActive).toBe(true);
    });

    it("should insert and read back a project", () => {
      const result = db.select().from(projects).where(eq(projects.id, projectId)).get();
      expect(result).toBeDefined();
      expect(result!.name).toBe("Test Project");
      expect(result!.slug).toBe("test-project");
      expect(result!.status).toBe("active");
    });

    it("should insert and read back a proposal", () => {
      const id = createId();
      const ts = now();
      db.insert(proposals)
        .values({
          id,
          projectId,
          title: "My Proposal",
          description: "Some idea",
          createdBy: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db.select().from(proposals).where(eq(proposals.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.title).toBe("My Proposal");
      expect(result!.status).toBe("open");
    });

    it("should insert and read back a task", () => {
      const id = createId();
      const ts = now();
      db.insert(tasks)
        .values({
          id,
          projectId,
          title: "Implement feature X",
          reporterId: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.title).toBe("Implement feature X");
      expect(result!.status).toBe("backlog");
      expect(result!.priority).toBe("medium");
      expect(result!.type).toBe("feature");
    });

    it("should insert and read back a milestone", () => {
      const id = createId();
      const ts = now();
      db.insert(milestones)
        .values({
          id,
          projectId,
          name: "v1.0",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db.select().from(milestones).where(eq(milestones.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.name).toBe("v1.0");
      expect(result!.status).toBe("open");
    });

    it("should insert and read back an epic", () => {
      const id = createId();
      const ts = now();
      db.insert(epics)
        .values({
          id,
          projectId,
          name: "Epic 1",
          createdBy: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db.select().from(epics).where(eq(epics.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.name).toBe("Epic 1");
      expect(result!.status).toBe("draft");
    });

    it("should insert and read back a comment", () => {
      const taskId = createId();
      const ts = now();
      db.insert(tasks)
        .values({
          id: taskId,
          projectId,
          title: "Some task",
          reporterId: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const commentId = createId();
      db.insert(comments)
        .values({
          id: commentId,
          taskId,
          authorId: userId,
          body: "This is a comment",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db.select().from(comments).where(eq(comments.id, commentId)).get();
      expect(result).toBeDefined();
      expect(result!.body).toBe("This is a comment");
      expect(result!.commentType).toBe("comment");
    });

    it("should insert and read back a label", () => {
      const id = createId();
      db.insert(labels)
        .values({
          id,
          projectId,
          name: "bug",
          color: "#ff0000",
        })
        .run();

      const result = db.select().from(labels).where(eq(labels.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.name).toBe("bug");
      expect(result!.color).toBe("#ff0000");
    });

    it("should insert and read back an activity log entry", () => {
      const id = createId();
      const ts = now();
      db.insert(activityLog)
        .values({
          id,
          entityType: "task",
          entityId: createId(),
          projectId,
          actorId: userId,
          action: "created",
          createdAt: ts,
        })
        .run();

      const result = db.select().from(activityLog).where(eq(activityLog.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.action).toBe("created");
      expect(result!.entityType).toBe("task");
    });

    it("should insert and read back a git ref", () => {
      const taskId = createId();
      const ts = now();
      db.insert(tasks)
        .values({
          id: taskId,
          projectId,
          title: "A task",
          reporterId: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const refId = createId();
      db.insert(gitRefs)
        .values({
          id: refId,
          taskId,
          refType: "branch",
          refValue: "feat/my-feature",
          createdAt: ts,
        })
        .run();

      const result = db.select().from(gitRefs).where(eq(gitRefs.id, refId)).get();
      expect(result).toBeDefined();
      expect(result!.refType).toBe("branch");
      expect(result!.refValue).toBe("feat/my-feature");
    });
  });

  // ── Merge groups + incidents (Phase 7.3) ─────────────────────────
  describe("merge groups and incidents", () => {
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
          username: "mguser",
          displayName: "Merge Group User",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "MG Project",
          slug: "mg-project",
          createdAt: ts,
          updatedAt: ts,
          createdBy: userId,
        })
        .run();
    });

    it("should insert a group with default state and resource", () => {
      const id = createId();
      const ts = now();
      db.insert(mergeRequestGroups)
        .values({
          id,
          projectId,
          submittedBy: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db
        .select()
        .from(mergeRequestGroups)
        .where(eq(mergeRequestGroups.id, id))
        .get();
      expect(result).toBeDefined();
      expect(result!.state).toBe("forming");
      expect(result!.resource).toBe("main");
      expect(result!.integratorId).toBeNull();
    });

    it("should insert an incident referencing a group with default open state", () => {
      const groupId = createId();
      const ts = now();
      db.insert(mergeRequestGroups)
        .values({
          id: groupId,
          projectId,
          submittedBy: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const incidentId = createId();
      db.insert(mergeIncidents)
        .values({
          id: incidentId,
          projectId,
          groupId,
          type: "orphaned_inner",
          innerRepo: "game_one",
          orphanedSha: "abc123",
          outerRepo: "outer",
          openedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db
        .select()
        .from(mergeIncidents)
        .where(eq(mergeIncidents.id, incidentId))
        .get();
      expect(result).toBeDefined();
      expect(result!.state).toBe("open");
      expect(result!.groupId).toBe(groupId);
      expect(result!.type).toBe("orphaned_inner");
    });

    it("should round-trip the incident resolution JSON column", () => {
      const groupId = createId();
      const ts = now();
      db.insert(mergeRequestGroups)
        .values({
          id: groupId,
          projectId,
          submittedBy: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const incidentId = createId();
      const resolution = {
        mode: "auto_rollforward" as const,
        outerLandedSha: "def456",
        resolvedByGroupId: createId(),
        note: "healed by next group",
      };
      db.insert(mergeIncidents)
        .values({
          id: incidentId,
          projectId,
          groupId,
          type: "orphaned_inner",
          innerRepo: "game_one",
          orphanedSha: "abc123",
          outerRepo: "outer",
          state: "auto_resolved",
          openedAt: ts,
          resolvedAt: ts,
          resolution,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db
        .select()
        .from(mergeIncidents)
        .where(eq(mergeIncidents.id, incidentId))
        .get();
      expect(result).toBeDefined();
      expect(result!.resolution).toEqual(resolution);
    });

    it("should insert a merge request associated to a group", () => {
      const groupId = createId();
      const ts = now();
      db.insert(mergeRequestGroups)
        .values({
          id: groupId,
          projectId,
          submittedBy: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const requestId = createId();
      db.insert(mergeRequests)
        .values({
          id: requestId,
          projectId,
          submittedBy: userId,
          groupId,
          enqueuedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db.select().from(mergeRequests).where(eq(mergeRequests.id, requestId)).get();
      expect(result).toBeDefined();
      expect(result!.groupId).toBe(groupId);
    });

    it("should SET NULL (not cascade-delete) on group deletion", () => {
      const groupId = createId();
      const ts = now();
      db.insert(mergeRequestGroups)
        .values({
          id: groupId,
          projectId,
          submittedBy: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const incidentId = createId();
      db.insert(mergeIncidents)
        .values({
          id: incidentId,
          projectId,
          groupId,
          type: "orphaned_inner",
          innerRepo: "game_one",
          orphanedSha: "abc123",
          outerRepo: "outer",
          openedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const requestId = createId();
      db.insert(mergeRequests)
        .values({
          id: requestId,
          projectId,
          submittedBy: userId,
          groupId,
          enqueuedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      // Delete the group — FK ON DELETE SET NULL must null the references,
      // NOT cascade-delete the dependent rows. Requires foreign_keys=ON.
      db.delete(mergeRequestGroups).where(eq(mergeRequestGroups.id, groupId)).run();

      const incident = db
        .select()
        .from(mergeIncidents)
        .where(eq(mergeIncidents.id, incidentId))
        .get();
      expect(incident).toBeDefined();
      expect(incident!.groupId).toBeNull();

      const request = db.select().from(mergeRequests).where(eq(mergeRequests.id, requestId)).get();
      expect(request).toBeDefined();
      expect(request!.groupId).toBeNull();
    });
  });

  // ── Merge resolutions (Phase 7.6) ────────────────────────────────
  describe("merge resolutions", () => {
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
          username: "resolveruser",
          displayName: "Resolver User",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "Resolution Project",
          slug: "resolution-project",
          createdAt: ts,
          updatedAt: ts,
          createdBy: userId,
        })
        .run();
    });

    it("defaults resolved_from to null on a normal merge request", () => {
      const requestId = createId();
      const ts = now();
      db.insert(mergeRequests)
        .values({
          id: requestId,
          projectId,
          submittedBy: userId,
          enqueuedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db.select().from(mergeRequests).where(eq(mergeRequests.id, requestId)).get();
      expect(result).toBeDefined();
      expect(result!.resolvedFrom).toBeNull();
    });

    it("links a resolved request to its origin via resolved_from", () => {
      const ts = now();
      const originId = createId();
      db.insert(mergeRequests)
        .values({
          id: originId,
          projectId,
          submittedBy: userId,
          enqueuedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const resolvedId = createId();
      db.insert(mergeRequests)
        .values({
          id: resolvedId,
          projectId,
          submittedBy: userId,
          resolvedFrom: originId,
          enqueuedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db.select().from(mergeRequests).where(eq(mergeRequests.id, resolvedId)).get();
      expect(result!.resolvedFrom).toBe(originId);
    });

    it("inserts a resolution with default state=pending, resource=main, nullables null", () => {
      const id = createId();
      const ts = now();
      db.insert(mergeResolutions).values({ id, projectId, createdAt: ts, updatedAt: ts }).run();

      const result = db.select().from(mergeResolutions).where(eq(mergeResolutions.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.state).toBe("pending");
      expect(result!.resource).toBe("main");
      expect(result!.originRequestId).toBeNull();
      expect(result!.resolvedRequestId).toBeNull();
      expect(result!.conflictingFiles).toBeNull();
      expect(result!.attemptStartedAt).toBeNull();
      expect(result!.attemptEndedAt).toBeNull();
      expect(result!.escalationTarget).toBeNull();
      expect(result!.detail).toBeNull();
    });

    it("round-trips the conflicting_files and detail JSON columns", () => {
      const id = createId();
      const ts = now();
      const conflictingFiles = ["src/foo.ts", "src/bar.ts"];
      const detail = {
        budgetConsumedSec: 120,
        tokensConsumed: 8000,
        verifyVerdict: "pass" as const,
        escalationReason: "n/a",
        logUrl: "file:///tmp/resolver.log",
      };
      db.insert(mergeResolutions)
        .values({
          id,
          projectId,
          state: "resolved",
          conflictingFiles,
          attemptStartedAt: ts,
          attemptEndedAt: ts,
          detail,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db.select().from(mergeResolutions).where(eq(mergeResolutions.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.conflictingFiles).toEqual(conflictingFiles);
      expect(result!.detail).toEqual(detail);
    });

    it("SET NULL on origin_request_id when the origin request is deleted", () => {
      const ts = now();
      const originId = createId();
      db.insert(mergeRequests)
        .values({
          id: originId,
          projectId,
          submittedBy: userId,
          enqueuedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const resolutionId = createId();
      db.insert(mergeResolutions)
        .values({
          id: resolutionId,
          projectId,
          originRequestId: originId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      // foreign_keys is ON → ON DELETE SET NULL nulls the reference rather
      // than cascade-deleting the durable resolution record.
      db.delete(mergeRequests).where(eq(mergeRequests.id, originId)).run();

      const result = db
        .select()
        .from(mergeResolutions)
        .where(eq(mergeResolutions.id, resolutionId))
        .get();
      expect(result).toBeDefined();
      expect(result!.originRequestId).toBeNull();
    });

    it("rejects a resolution with an invalid project_id (FK enforced)", () => {
      const ts = now();
      expect(() => {
        db.insert(mergeResolutions)
          .values({
            id: createId(),
            projectId: "nonexistent",
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }).toThrow();
    });
  });

  // ── Audit log (Phase 7.4) ────────────────────────────────────────
  describe("audit log", () => {
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
          username: "auditor",
          displayName: "Audit User",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "Audit Project",
          slug: "audit-project",
          createdAt: ts,
          updatedAt: ts,
          createdBy: userId,
        })
        .run();
    });

    it("should round-trip json metadata before/after as objects and a null reason", () => {
      const id = createId();
      const ts = now();
      const before = { status: "integrating", landedSha: null };
      const after = { status: "landed", landedSha: "ff00", overridden: true };
      db.insert(auditLog)
        .values({
          id,
          projectId,
          actorId: userId,
          action: "land",
          targetType: "merge_request",
          targetId: createId(),
          reason: null,
          metadataBefore: before,
          metadataAfter: after,
          createdAt: ts,
        })
        .run();

      const result = db.select().from(auditLog).where(eq(auditLog.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.action).toBe("land");
      expect(result!.targetType).toBe("merge_request");
      expect(result!.reason).toBeNull();
      // JSON columns round-trip as objects (not strings).
      expect(result!.metadataBefore).toEqual(before);
      expect(result!.metadataAfter).toEqual(after);
    });

    it("should reject an audit row with an invalid project_id (FK enforced)", () => {
      const ts = now();
      expect(() => {
        db.insert(auditLog)
          .values({
            id: createId(),
            projectId: "nonexistent",
            actorId: userId,
            action: "pause",
            targetType: "train",
            targetId: "main",
            createdAt: ts,
          })
          .run();
      }).toThrow();
    });

    it("should reject an audit row with an invalid actor_id (FK enforced)", () => {
      const ts = now();
      expect(() => {
        db.insert(auditLog)
          .values({
            id: createId(),
            projectId,
            actorId: "nonexistent",
            action: "pause",
            targetType: "train",
            targetId: "main",
            createdAt: ts,
          })
          .run();
      }).toThrow();
    });
  });

  // ── Train state (Phase 7.4) ──────────────────────────────────────
  describe("train state", () => {
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
          username: "trainop",
          displayName: "Train Operator",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "Train Project",
          slug: "train-project",
          createdAt: ts,
          updatedAt: ts,
          createdBy: userId,
        })
        .run();
    });

    it("should insert a train_state row with default state=running and resource=main", () => {
      const id = createId();
      const ts = now();
      db.insert(trainState).values({ id, projectId, createdAt: ts, updatedAt: ts }).run();

      const result = db.select().from(trainState).where(eq(trainState.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.state).toBe("running");
      expect(result!.resource).toBe("main");
      expect(result!.changedBy).toBeNull();
      expect(result!.stuckNotified).toBe(false);
      expect(result!.abandonNotified).toBe(false);
      // Migration 0020: the integration-stalled alert latch, default false.
      expect(result!.stalledNotified).toBe(false);
    });

    it("should reject a duplicate (project, resource) lane (unique index)", () => {
      const ts = now();
      db.insert(trainState)
        .values({ id: createId(), projectId, createdAt: ts, updatedAt: ts })
        .run();
      expect(() => {
        db.insert(trainState)
          .values({ id: createId(), projectId, createdAt: ts, updatedAt: ts })
          .run();
      }).toThrow();
    });

    it("should SET NULL on changed_by when the user is deleted", () => {
      const ts = now();
      // A distinct operator (not the project creator) so the delete is clean.
      const opId = createId();
      db.insert(users)
        .values({
          id: opId,
          username: "op2",
          displayName: "Operator 2",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const id = createId();
      db.insert(trainState)
        .values({
          id,
          projectId,
          state: "paused",
          changedBy: opId,
          changedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      db.delete(users).where(eq(users.id, opId)).run();

      const result = db.select().from(trainState).where(eq(trainState.id, id)).get();
      expect(result).toBeDefined();
      expect(result!.changedBy).toBeNull();
      expect(result!.state).toBe("paused");
    });
  });

  // ── Claims alert state (Campaign C3 §P5a) ────────────────────────
  describe("claims alert state", () => {
    let db: AppDatabase;
    let projectId: string;

    beforeEach(() => {
      db = setupDb();
      const workspaceId = db.select().from(workspaces).all()[0].id;
      const ts = now();

      const userId = createId();
      db.insert(users)
        .values({
          id: userId,
          username: "claimsop",
          displayName: "Claims Operator",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "Claims Project",
          slug: "claims-project",
          createdAt: ts,
          updatedAt: ts,
          createdBy: userId,
        })
        .run();
    });

    it("should insert a claims_alert_state row with default stale_claims_notified=false", () => {
      const id = createId();
      const ts = now();
      db.insert(claimsAlertState).values({ id, projectId, createdAt: ts, updatedAt: ts }).run();

      const result = db
        .select()
        .from(claimsAlertState)
        .where(eq(claimsAlertState.id, id))
        .get();
      expect(result).toBeDefined();
      expect(result!.projectId).toBe(projectId);
      expect(result!.staleClaimsNotified).toBe(false);
    });

    it("should reject a duplicate project (unique index)", () => {
      const ts = now();
      db.insert(claimsAlertState)
        .values({ id: createId(), projectId, createdAt: ts, updatedAt: ts })
        .run();
      expect(() => {
        db.insert(claimsAlertState)
          .values({ id: createId(), projectId, createdAt: ts, updatedAt: ts })
          .run();
      }).toThrow();
    });

    it("should reject a row with an invalid project_id (FK enforced)", () => {
      const ts = now();
      expect(() => {
        db.insert(claimsAlertState)
          .values({ id: createId(), projectId: "nonexistent", createdAt: ts, updatedAt: ts })
          .run();
      }).toThrow();
    });
  });

  // ── Foreign key constraint enforcement ───────────────────────────
  describe("FK constraint enforcement", () => {
    it("should reject a project with invalid workspace_id", () => {
      const db = setupDb();
      const ts = now();
      expect(() => {
        db.insert(projects)
          .values({
            id: createId(),
            workspaceId: "nonexistent",
            name: "Bad Project",
            slug: "bad",
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }).toThrow();
    });

    it("should reject a task with invalid project_id", () => {
      const db = setupDb();
      const ts = now();
      // Create a user first
      const userId = createId();
      db.insert(users)
        .values({
          id: userId,
          username: "u1",
          displayName: "User 1",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      expect(() => {
        db.insert(tasks)
          .values({
            id: createId(),
            projectId: "nonexistent",
            title: "Bad Task",
            reporterId: userId,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }).toThrow();
    });

    it("should reject a comment with invalid author_id", () => {
      const db = setupDb();
      const ts = now();
      expect(() => {
        db.insert(comments)
          .values({
            id: createId(),
            authorId: "nonexistent",
            body: "Bad comment",
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }).toThrow();
    });
  });

  // ── Composite PK on task_labels ──────────────────────────────────
  describe("composite PK on task_labels", () => {
    it("should reject duplicate task-label combinations", () => {
      const db = setupDb();
      const ts = now();
      const workspaceId = db.select().from(workspaces).all()[0].id;

      const userId = createId();
      db.insert(users)
        .values({
          id: userId,
          username: "u2",
          displayName: "User 2",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "P",
          slug: "p",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const taskId = createId();
      db.insert(tasks)
        .values({
          id: taskId,
          projectId,
          title: "T",
          reporterId: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const labelId = createId();
      db.insert(labels).values({ id: labelId, projectId, name: "bug" }).run();

      db.insert(taskLabels).values({ taskId, labelId }).run();

      expect(() => {
        db.insert(taskLabels).values({ taskId, labelId }).run();
      }).toThrow();
    });
  });

  // ── Unique constraints ───────────────────────────────────────────
  describe("unique constraints", () => {
    it("should reject duplicate usernames", () => {
      const db = setupDb();
      const ts = now();
      db.insert(users)
        .values({
          id: createId(),
          username: "dupe",
          displayName: "D1",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      expect(() => {
        db.insert(users)
          .values({
            id: createId(),
            username: "dupe",
            displayName: "D2",
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }).toThrow();
    });

    it("should reject duplicate label names within the same project", () => {
      const db = setupDb();
      const ts = now();
      const workspaceId = db.select().from(workspaces).all()[0].id;

      const userId = createId();
      db.insert(users)
        .values({
          id: userId,
          username: "u3",
          displayName: "User 3",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "Proj",
          slug: "proj",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      db.insert(labels).values({ id: createId(), projectId, name: "bug" }).run();

      expect(() => {
        db.insert(labels).values({ id: createId(), projectId, name: "bug" }).run();
      }).toThrow();
    });

    it("should allow same label name in different projects", () => {
      const db = setupDb();
      const ts = now();
      const workspaceId = db.select().from(workspaces).all()[0].id;

      const userId = createId();
      db.insert(users)
        .values({
          id: userId,
          username: "u4",
          displayName: "User 4",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const proj1 = createId();
      const proj2 = createId();
      db.insert(projects)
        .values({
          id: proj1,
          workspaceId,
          name: "P1",
          slug: "p1",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      db.insert(projects)
        .values({
          id: proj2,
          workspaceId,
          name: "P2",
          slug: "p2",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      db.insert(labels).values({ id: createId(), projectId: proj1, name: "bug" }).run();
      db.insert(labels).values({ id: createId(), projectId: proj2, name: "bug" }).run();

      // Should not throw — different projects
      const all = db.select().from(labels).all();
      expect(all).toHaveLength(2);
    });

    it("should reject duplicate project slugs within the same workspace", () => {
      const db = setupDb();
      const ts = now();
      const workspaceId = db.select().from(workspaces).all()[0].id;

      db.insert(projects)
        .values({
          id: createId(),
          workspaceId,
          name: "First",
          slug: "same-slug",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      expect(() => {
        db.insert(projects)
          .values({
            id: createId(),
            workspaceId,
            name: "Second",
            slug: "same-slug",
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }).toThrow();
    });
  });

  // ── Self-referential FK (tasks → parent_task_id) ─────────────────
  describe("self-referential tasks", () => {
    it("should support parent-child task relationships", () => {
      const db = setupDb();
      const ts = now();
      const workspaceId = db.select().from(workspaces).all()[0].id;

      const userId = createId();
      db.insert(users)
        .values({
          id: userId,
          username: "u5",
          displayName: "User 5",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "P",
          slug: "p",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const parentId = createId();
      db.insert(tasks)
        .values({
          id: parentId,
          projectId,
          title: "Parent Task",
          reporterId: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const childId = createId();
      db.insert(tasks)
        .values({
          id: childId,
          projectId,
          title: "Child Task",
          parentTaskId: parentId,
          reporterId: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const child = db.select().from(tasks).where(eq(tasks.id, childId)).get();
      expect(child).toBeDefined();
      expect(child!.parentTaskId).toBe(parentId);
    });
  });

  // ── Polymorphic comments ─────────────────────────────────────────
  describe("polymorphic comments", () => {
    it("should allow comments on proposals (no task_id)", () => {
      const db = setupDb();
      const ts = now();
      const workspaceId = db.select().from(workspaces).all()[0].id;

      const userId = createId();
      db.insert(users)
        .values({
          id: userId,
          username: "u6",
          displayName: "User 6",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "P",
          slug: "p-poly",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const proposalId = createId();
      db.insert(proposals)
        .values({
          id: proposalId,
          projectId,
          title: "A Proposal",
          createdBy: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const commentId = createId();
      db.insert(comments)
        .values({
          id: commentId,
          proposalId,
          authorId: userId,
          body: "Proposal comment",
          commentType: "design_discussion",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db.select().from(comments).where(eq(comments.id, commentId)).get();
      expect(result).toBeDefined();
      expect(result!.proposalId).toBe(proposalId);
      expect(result!.taskId).toBeNull();
    });
  });

  // ── JSON fields ──────────────────────────────────────────────────
  describe("JSON fields", () => {
    it("should store and retrieve JSON context on tasks", () => {
      const db = setupDb();
      const ts = now();
      const workspaceId = db.select().from(workspaces).all()[0].id;

      const userId = createId();
      db.insert(users)
        .values({
          id: userId,
          username: "u7",
          displayName: "User 7",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "P",
          slug: "p-json",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const taskId = createId();
      const ctx = {
        relevant_files: ["src/foo.ts"],
        acceptance_criteria: ["Must pass tests"],
      };

      db.insert(tasks)
        .values({
          id: taskId,
          projectId,
          title: "JSON task",
          reporterId: userId,
          context: ctx,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const result = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      expect(result).toBeDefined();
      expect(result!.context).toEqual(ctx);
    });
  });

  // ── Task dependencies ────────────────────────────────────────────
  describe("task dependencies", () => {
    it("should insert and read back task dependencies", () => {
      const db = setupDb();
      const ts = now();
      const workspaceId = db.select().from(workspaces).all()[0].id;

      const userId = createId();
      db.insert(users)
        .values({
          id: userId,
          username: "u8",
          displayName: "User 8",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const projectId = createId();
      db.insert(projects)
        .values({
          id: projectId,
          workspaceId,
          name: "P",
          slug: "p-deps",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const task1 = createId();
      const task2 = createId();
      db.insert(tasks)
        .values({
          id: task1,
          projectId,
          title: "Task 1",
          reporterId: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      db.insert(tasks)
        .values({
          id: task2,
          projectId,
          title: "Task 2",
          reporterId: userId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const depId = createId();
      db.insert(taskDependencies)
        .values({
          id: depId,
          taskId: task1,
          dependsOnTaskId: task2,
          dependencyType: "blocks",
          createdAt: ts,
        })
        .run();

      const result = db.select().from(taskDependencies).where(eq(taskDependencies.id, depId)).get();
      expect(result).toBeDefined();
      expect(result!.taskId).toBe(task1);
      expect(result!.dependsOnTaskId).toBe(task2);
      expect(result!.dependencyType).toBe("blocks");
    });
  });
});
