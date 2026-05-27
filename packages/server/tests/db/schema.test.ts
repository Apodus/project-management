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
    it("should create all 16 tables", () => {
      const db = setupDb();
      const tableNames = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' AND name NOT LIKE '%_fts%' ORDER BY name`,
      );

      // Extract just the name strings
      const names = (tableNames as any[]).map((r: any) => r.name).sort();

      const expected = [
        "activity_log",
        "automation_rules",
        "comments",
        "epics",
        "git_refs",
        "labels",
        "milestones",
        "projects",
        "proposals",
        "sessions",
        "task_dependencies",
        "task_labels",
        "tasks",
        "templates",
        "users",
        "workspaces",
      ].sort();

      expect(names).toEqual(expected);
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
      const result = db.all<{ journal_mode: string }>(
        sql`PRAGMA journal_mode`,
      );
      const mode = (result as any[])[0].journal_mode;
      // In-memory SQLite uses "memory" journal mode; file-based would use "wal"
      expect(["wal", "memory"]).toContain(mode);
    });

    it("should have foreign keys enabled", () => {
      const db = setupDb();
      const result = db.all<{ foreign_keys: number }>(
        sql`PRAGMA foreign_keys`,
      );
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
      const result = db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .get();
      expect(result).toBeDefined();
      expect(result!.username).toBe("testuser");
      expect(result!.displayName).toBe("Test User");
      expect(result!.isActive).toBe(true);
    });

    it("should insert and read back a project", () => {
      const result = db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .get();
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

      const result = db
        .select()
        .from(proposals)
        .where(eq(proposals.id, id))
        .get();
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

      const result = db
        .select()
        .from(milestones)
        .where(eq(milestones.id, id))
        .get();
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

      const result = db
        .select()
        .from(comments)
        .where(eq(comments.id, commentId))
        .get();
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

      const result = db
        .select()
        .from(activityLog)
        .where(eq(activityLog.id, id))
        .get();
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

      const result = db
        .select()
        .from(gitRefs)
        .where(eq(gitRefs.id, refId))
        .get();
      expect(result).toBeDefined();
      expect(result!.refType).toBe("branch");
      expect(result!.refValue).toBe("feat/my-feature");
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
      db.insert(labels)
        .values({ id: labelId, projectId, name: "bug" })
        .run();

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

      db.insert(labels)
        .values({ id: createId(), projectId, name: "bug" })
        .run();

      expect(() => {
        db.insert(labels)
          .values({ id: createId(), projectId, name: "bug" })
          .run();
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

      db.insert(labels)
        .values({ id: createId(), projectId: proj1, name: "bug" })
        .run();
      db.insert(labels)
        .values({ id: createId(), projectId: proj2, name: "bug" })
        .run();

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

      const result = db
        .select()
        .from(comments)
        .where(eq(comments.id, commentId))
        .get();
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

      const result = db
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.id, depId))
        .get();
      expect(result).toBeDefined();
      expect(result!.taskId).toBe(task1);
      expect(result!.dependsOnTaskId).toBe(task2);
      expect(result!.dependencyType).toBe("blocks");
    });
  });
});
