import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestProject,
  createTestProposal,
  createTestEpic,
  createTestTask,
  authRequest,
  type TestApp,
} from "../utils.js";
import {
  milestones,
  labels,
  taskLabels,
  taskDependencies,
  gitRefs,
  comments,
} from "../../src/db/index.js";
import { createId } from "@pm/shared";

describe("Export/Import API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // Helper: create a fully populated project with all entity types
  function createFullProject() {
    const user = createTestUser(testApp.db);
    const project = createTestProject(testApp.db, {
      createdBy: user.id,
      name: "Export Test Project",
    });
    const ts = new Date().toISOString();

    // Create a milestone
    const milestoneId = createId();
    testApp.db
      .insert(milestones)
      .values({
        id: milestoneId,
        projectId: project.id,
        name: "v1.0 Release",
        description: "First release milestone",
        targetDate: "2026-12-31",
        status: "open",
        sortOrder: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    // Create a proposal
    const proposal = createTestProposal(testApp.db, {
      projectId: project.id,
      title: "Feature Proposal",
      description: "Add a new feature",
      createdBy: user.id,
    });

    // Create an epic
    const epic = createTestEpic(testApp.db, {
      projectId: project.id,
      name: "Authentication Epic",
      milestoneId,
      proposalId: proposal.id,
      createdBy: user.id,
    });

    // Create a label
    const labelId = createId();
    testApp.db
      .insert(labels)
      .values({
        id: labelId,
        projectId: project.id,
        name: "frontend",
        color: "#3b82f6",
        description: "Frontend tasks",
      })
      .run();

    // Create tasks
    const task1 = createTestTask(testApp.db, {
      projectId: project.id,
      title: "Implement login",
      epicId: epic.id,
      reporterId: user.id,
      status: "in_progress",
      priority: "high",
      type: "feature",
    });

    const task2 = createTestTask(testApp.db, {
      projectId: project.id,
      title: "Write tests",
      epicId: epic.id,
      reporterId: user.id,
      parentTaskId: task1.id,
      status: "backlog",
    });

    // Add task label
    testApp.db
      .insert(taskLabels)
      .values({
        taskId: task1.id,
        labelId,
      })
      .run();

    // Add task dependency
    const depId = createId();
    testApp.db
      .insert(taskDependencies)
      .values({
        id: depId,
        taskId: task2.id,
        dependsOnTaskId: task1.id,
        dependencyType: "blocks",
        createdAt: ts,
      })
      .run();

    // Add a comment
    const commentId = createId();
    testApp.db
      .insert(comments)
      .values({
        id: commentId,
        taskId: task1.id,
        proposalId: null,
        authorId: user.id,
        body: "Working on this now",
        commentType: "comment",
        metadata: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    // Add a proposal comment
    const proposalCommentId = createId();
    testApp.db
      .insert(comments)
      .values({
        id: proposalCommentId,
        taskId: null,
        proposalId: proposal.id,
        authorId: user.id,
        body: "Looks good",
        commentType: "comment",
        metadata: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    // Add a git ref
    const gitRefId = createId();
    testApp.db
      .insert(gitRefs)
      .values({
        id: gitRefId,
        taskId: task1.id,
        refType: "branch",
        refValue: "feature/login",
        url: "https://github.com/test/repo/tree/feature/login",
        title: "Login branch",
        status: "active",
        metadata: null,
        createdAt: ts,
      })
      .run();

    return {
      user,
      project,
      milestoneId,
      proposal,
      epic,
      labelId,
      task1,
      task2,
      depId,
      commentId,
      proposalCommentId,
      gitRefId,
    };
  }

  // ── GET /api/v1/projects/:id/export ──────────────────────────────
  describe("GET /api/v1/projects/:id/export", () => {
    it("should export a project with all entity types", async () => {
      const data = createFullProject();

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${data.project.id}/export`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.version).toBe("1.0");
      expect(body.exported_at).toBeDefined();
      expect(body.project.id).toBe(data.project.id);
      expect(body.project.name).toBe("Export Test Project");

      // Verify all entity types present
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0].title).toBe("Feature Proposal");

      expect(body.epics).toHaveLength(1);
      expect(body.epics[0].name).toBe("Authentication Epic");

      expect(body.milestones).toHaveLength(1);
      expect(body.milestones[0].name).toBe("v1.0 Release");

      expect(body.tasks).toHaveLength(2);

      expect(body.comments).toHaveLength(2);

      expect(body.labels).toHaveLength(1);
      expect(body.labels[0].name).toBe("frontend");

      expect(body.task_labels).toHaveLength(1);
      expect(body.task_dependencies).toHaveLength(1);
      expect(body.git_refs).toHaveLength(1);

      // Activity log should not be included by default
      expect(body.activity_log).toBeUndefined();
    });

    it("should include activity log when requested", async () => {
      const data = createFullProject();

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${data.project.id}/export?include_activity=true`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.activity_log).toBeDefined();
      expect(Array.isArray(body.activity_log)).toBe(true);
    });

    it("should return 404 for non-existent project", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${fakeId}/export`,
      );
      expect(res.status).toBe(404);
    });

    it("should export a project with no related data", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/export`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.project.id).toBe(project.id);
      expect(body.proposals).toHaveLength(0);
      expect(body.epics).toHaveLength(0);
      expect(body.milestones).toHaveLength(0);
      expect(body.tasks).toHaveLength(0);
      expect(body.comments).toHaveLength(0);
      expect(body.labels).toHaveLength(0);
      expect(body.task_labels).toHaveLength(0);
      expect(body.task_dependencies).toHaveLength(0);
      expect(body.git_refs).toHaveLength(0);
    });

    it("should set Content-Disposition header for download", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/export`,
      );
      expect(res.status).toBe(200);

      const disposition = res.headers.get("content-disposition");
      expect(disposition).toContain("attachment");
      expect(disposition).toContain(project.id);
    });
  });

  // ── POST /api/v1/projects/import ─────────────────────────────────
  describe("POST /api/v1/projects/import", () => {
    it("should import a project from exported JSON", async () => {
      const data = createFullProject();

      // Export first
      const exportRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${data.project.id}/export`,
      );
      const exportData = await exportRes.json();

      // Import
      const importRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/projects/import",
        { body: exportData },
      );
      expect(importRes.status).toBe(201);

      const importBody = await importRes.json();
      expect(importBody.data.id).toBeDefined();
      expect(importBody.data.id).not.toBe(data.project.id); // New ID
      expect(importBody.data.name).toContain("Export Test Project");
      expect(importBody.data.name).toContain("(imported)");
    });

    it("should create all entities with new IDs", async () => {
      const data = createFullProject();

      // Export
      const exportRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${data.project.id}/export`,
      );
      const exportData = await exportRes.json();

      // Import
      const importRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/projects/import",
        { body: exportData },
      );
      expect(importRes.status).toBe(201);

      const importBody = await importRes.json();
      const newProjectId = importBody.data.id;

      // Export the imported project to verify all data was created
      const reExportRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${newProjectId}/export`,
      );
      expect(reExportRes.status).toBe(200);

      const reExportData = await reExportRes.json();

      // Verify counts match
      expect(reExportData.proposals).toHaveLength(exportData.proposals.length);
      expect(reExportData.epics).toHaveLength(exportData.epics.length);
      expect(reExportData.milestones).toHaveLength(
        exportData.milestones.length,
      );
      expect(reExportData.tasks).toHaveLength(exportData.tasks.length);
      expect(reExportData.comments).toHaveLength(exportData.comments.length);
      expect(reExportData.labels).toHaveLength(exportData.labels.length);
      expect(reExportData.task_labels).toHaveLength(
        exportData.task_labels.length,
      );
      expect(reExportData.task_dependencies).toHaveLength(
        exportData.task_dependencies.length,
      );
      expect(reExportData.git_refs).toHaveLength(exportData.git_refs.length);

      // Verify all IDs are different
      expect(reExportData.project.id).not.toBe(exportData.project.id);
      for (let i = 0; i < reExportData.proposals.length; i++) {
        expect(reExportData.proposals[i].id).not.toBe(
          exportData.proposals[i].id,
        );
      }
      for (let i = 0; i < reExportData.tasks.length; i++) {
        expect(reExportData.tasks[i].id).not.toBe(exportData.tasks[i].id);
      }
    });

    it("should maintain relationships via remapped IDs (round-trip)", async () => {
      const data = createFullProject();

      // Export
      const exportRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${data.project.id}/export`,
      );
      const exportData = await exportRes.json();

      // Import
      const importRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/projects/import",
        { body: exportData },
      );
      const importBody = await importRes.json();
      const newProjectId = importBody.data.id;

      // Re-export to get the imported data with new IDs
      const reExportRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${newProjectId}/export`,
      );
      const reExportData = await reExportRes.json();

      // Verify field-by-field data matches (ignoring IDs and timestamps)
      // Project fields
      expect(reExportData.project.description).toBe(
        exportData.project.description,
      );
      expect(reExportData.project.status).toBe(exportData.project.status);

      // Milestone fields
      expect(reExportData.milestones[0].name).toBe(
        exportData.milestones[0].name,
      );
      expect(reExportData.milestones[0].description).toBe(
        exportData.milestones[0].description,
      );

      // Proposal fields
      expect(reExportData.proposals[0].title).toBe(
        exportData.proposals[0].title,
      );
      expect(reExportData.proposals[0].description).toBe(
        exportData.proposals[0].description,
      );

      // Epic fields
      expect(reExportData.epics[0].name).toBe(exportData.epics[0].name);
      expect(reExportData.epics[0].description).toBe(
        exportData.epics[0].description,
      );

      // Verify relationships are internally consistent
      const newEpic = reExportData.epics[0];
      const newProposal = reExportData.proposals[0];
      const newMilestone = reExportData.milestones[0];

      // Epic should reference the new milestone and proposal IDs
      expect(newEpic.proposalId).toBe(newProposal.id);
      expect(newEpic.milestoneId).toBe(newMilestone.id);
      expect(newEpic.projectId).toBe(newProjectId);

      // Tasks: find parent-child relationship
      const parentTask = reExportData.tasks.find(
        (t: Record<string, unknown>) => t.parentTaskId === null,
      );
      const childTask = reExportData.tasks.find(
        (t: Record<string, unknown>) => t.parentTaskId !== null,
      );
      if (parentTask && childTask) {
        expect(childTask.parentTaskId).toBe(parentTask.id);
      }

      // Task dependency: should reference remapped task IDs
      if (reExportData.task_dependencies.length > 0) {
        const dep = reExportData.task_dependencies[0];
        const taskIds = reExportData.tasks.map(
          (t: Record<string, unknown>) => t.id,
        );
        expect(taskIds).toContain(dep.taskId);
        expect(taskIds).toContain(dep.dependsOnTaskId);
      }

      // Task labels: should reference remapped IDs
      if (reExportData.task_labels.length > 0) {
        const tl = reExportData.task_labels[0];
        const taskIds = reExportData.tasks.map(
          (t: Record<string, unknown>) => t.id,
        );
        const labelIds = reExportData.labels.map(
          (l: Record<string, unknown>) => l.id,
        );
        expect(taskIds).toContain(tl.taskId);
        expect(labelIds).toContain(tl.labelId);
      }

      // Label fields
      expect(reExportData.labels[0].name).toBe(exportData.labels[0].name);
      expect(reExportData.labels[0].color).toBe(exportData.labels[0].color);

      // Comment fields
      const taskComment = reExportData.comments.find(
        (c: Record<string, unknown>) => c.taskId !== null,
      );
      const origTaskComment = exportData.comments.find(
        (c: Record<string, unknown>) => c.taskId !== null,
      );
      expect(taskComment.body).toBe(origTaskComment.body);

      // Git ref fields
      expect(reExportData.git_refs[0].refType).toBe(
        exportData.git_refs[0].refType,
      );
      expect(reExportData.git_refs[0].refValue).toBe(
        exportData.git_refs[0].refValue,
      );
      expect(reExportData.git_refs[0].url).toBe(exportData.git_refs[0].url);
    });

    it("should reject invalid data (missing version)", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/projects/import",
        {
          body: {
            version: "2.0",
            exported_at: new Date().toISOString(),
            project: { name: "Test" },
            proposals: [],
            epics: [],
            milestones: [],
            tasks: [],
            comments: [],
            labels: [],
            task_labels: [],
            task_dependencies: [],
            git_refs: [],
          },
        },
      );
      // Should fail with 400 (unsupported version)
      expect(res.status).toBe(400);
    });

    it("should reject import data missing required arrays", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/projects/import",
        {
          body: {
            version: "1.0",
            exported_at: new Date().toISOString(),
            project: { name: "Test" },
            // Missing arrays — will fail zod validation before reaching service
          },
        },
      );
      expect(res.status).toBe(400);
    });

    it("should import a project with no related data", async () => {
      const res = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/projects/import",
        {
          body: {
            version: "1.0",
            exported_at: new Date().toISOString(),
            project: {
              id: createId(),
              name: "Empty Project",
              slug: "empty-project",
              description: null,
              status: "active",
              settings: null,
              sortOrder: 0,
            },
            proposals: [],
            epics: [],
            milestones: [],
            tasks: [],
            comments: [],
            labels: [],
            task_labels: [],
            task_dependencies: [],
            git_refs: [],
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toContain("Empty Project");
      expect(body.data.name).toContain("(imported)");
    });
  });

  // ── POST /api/v1/backup ──────────────────────────────────────────
  describe("POST /api/v1/backup", () => {
    it("should fail for in-memory database (test DB)", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/backup");
      // In-memory DB cannot be backed up
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("BACKUP_ERROR");
    });
  });
});
