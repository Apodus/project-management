import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestProject,
  createTestTask,
  createTestEpic,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";

describe("Templates API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Template CRUD ────────────────────────────────────────────────

  describe("GET /api/v1/templates", () => {
    it("should return empty list when no templates exist", async () => {
      const res = await authRequest(testApp.app, "GET", "/api/v1/templates");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
    });

    it("should return all templates", async () => {
      // Create two templates
      await authRequest(testApp.app, "POST", "/api/v1/templates", {
        body: {
          name: "Bug Template",
          template_type: "task",
          template_data: { type: "bug" },
        },
      });
      await authRequest(testApp.app, "POST", "/api/v1/templates", {
        body: {
          name: "Project Template",
          template_type: "project",
          template_data: { description: "A project" },
        },
      });

      const res = await authRequest(testApp.app, "GET", "/api/v1/templates");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
    });

    it("should filter by template_type", async () => {
      await authRequest(testApp.app, "POST", "/api/v1/templates", {
        body: {
          name: "Bug Template",
          template_type: "task",
          template_data: { type: "bug" },
        },
      });
      await authRequest(testApp.app, "POST", "/api/v1/templates", {
        body: {
          name: "Project Template",
          template_type: "project",
          template_data: { description: "A project" },
        },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/templates?template_type=task",
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].templateType).toBe("task");
    });

    it("should filter by project_id and include workspace-level templates", async () => {
      const project = createTestProject(testApp.db);

      // Create a project-specific template
      await authRequest(testApp.app, "POST", "/api/v1/templates", {
        body: {
          name: "Project-specific Template",
          template_type: "task",
          template_data: { type: "bug" },
          project_id: project.id,
        },
      });

      // Create a workspace-level template (no project_id)
      await authRequest(testApp.app, "POST", "/api/v1/templates", {
        body: {
          name: "Workspace Template",
          template_type: "task",
          template_data: { type: "chore" },
        },
      });

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/templates?project_id=${project.id}`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      // Should include both project-specific and workspace-level
      expect(body.data).toHaveLength(2);
    });
  });

  describe("POST /api/v1/templates", () => {
    it("should create a task template", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/templates", {
        body: {
          name: "Bug Fix Template",
          description: "Template for bug fixes",
          template_type: "task",
          template_data: {
            title_prefix: "Bug Fix: ",
            description: "## Steps to reproduce\n\n## Expected\n\n## Actual",
            type: "bug",
            priority: "high",
            estimated_effort: "m",
            subtasks: [
              { title: "Investigate", type: "research", effort: "s" },
              { title: "Fix", type: "feature", effort: "m" },
            ],
          },
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toBe("Bug Fix Template");
      expect(body.data.templateType).toBe("task");
      expect(body.data.id).toBeDefined();
      expect(body.data.projectId).toBeNull();

      const templateData = body.data.templateData;
      expect(templateData.type).toBe("bug");
      expect(templateData.subtasks).toHaveLength(2);
    });

    it("should create a project template", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/templates", {
        body: {
          name: "Web Feature Project",
          template_type: "project",
          template_data: {
            description: "Standard web feature project",
            epics: [
              {
                name: "Design",
                tasks: [{ title: "Create design doc", type: "design" }],
              },
              {
                name: "Implementation",
                tasks: [{ title: "Core work", type: "feature" }],
              },
            ],
            labels: [
              { name: "frontend", color: "#3b82f6" },
              { name: "backend", color: "#10b981" },
            ],
          },
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toBe("Web Feature Project");
      expect(body.data.templateType).toBe("project");

      const templateData = body.data.templateData;
      expect(templateData.epics).toHaveLength(2);
      expect(templateData.labels).toHaveLength(2);
    });

    it("should create a template with project_id", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(testApp.app, "POST", "/api/v1/templates", {
        body: {
          name: "Project-specific Template",
          template_type: "task",
          template_data: { type: "chore" },
          project_id: project.id,
        },
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.projectId).toBe(project.id);
    });

    it("should reject missing name", async () => {
      const res = await authRequest(testApp.app, "POST", "/api/v1/templates", {
        body: {
          template_type: "task",
          template_data: { type: "bug" },
        },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/v1/templates/:id", () => {
    it("should update template name", async () => {
      const createRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/templates",
        {
          body: {
            name: "Original Name",
            template_type: "task",
            template_data: { type: "bug" },
          },
        },
      );
      const created = await createRes.json();

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/templates/${created.data.id}`,
        { body: { name: "Updated Name" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.name).toBe("Updated Name");
    });

    it("should update template_data", async () => {
      const createRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/templates",
        {
          body: {
            name: "Test Template",
            template_type: "task",
            template_data: { type: "bug", priority: "low" },
          },
        },
      );
      const created = await createRes.json();

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/templates/${created.data.id}`,
        { body: { template_data: { type: "feature", priority: "high" } } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.templateData.type).toBe("feature");
      expect(body.data.templateData.priority).toBe("high");
    });

    it("should return 404 for non-existent template", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/templates/${fakeId}`,
        { body: { name: "Nope" } },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/templates/:id", () => {
    it("should delete a template", async () => {
      const createRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/templates",
        {
          body: {
            name: "To Delete",
            template_type: "task",
            template_data: { type: "chore" },
          },
        },
      );
      const created = await createRes.json();

      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/templates/${created.data.id}`,
      );
      expect(res.status).toBe(200);

      // Verify it's gone
      const listRes = await authRequest(
        testApp.app,
        "GET",
        "/api/v1/templates",
      );
      const listBody = await listRes.json();
      expect(listBody.data).toHaveLength(0);
    });

    it("should return 404 for non-existent template", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/templates/${fakeId}`,
      );
      expect(res.status).toBe(404);
    });
  });

  // ── Task Template Instantiation ──────────────────────────────────

  describe("POST /api/v1/templates/:id/instantiate (task)", () => {
    it("should create a task from a template", async () => {
      const project = createTestProject(testApp.db);

      // Create a task template
      const createRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/templates",
        {
          body: {
            name: "Bug Fix Template",
            template_type: "task",
            template_data: {
              description: "## Bug description",
              type: "bug",
              priority: "high",
              estimated_effort: "m",
            },
          },
        },
      );
      const template = await createRes.json();

      // Instantiate
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/templates/${template.data.id}/instantiate`,
        {
          body: {
            project_id: project.id,
            overrides: { title: "Fix login bug" },
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.task).toBeDefined();
      expect(body.data.task.title).toBe("Fix login bug");
      expect(body.data.task.type).toBe("bug");
      expect(body.data.task.priority).toBe("high");
      expect(body.data.task.description).toBe("## Bug description");
      expect(body.data.task.projectId).toBe(project.id);
    });

    it("should create task with subtasks from template", async () => {
      const project = createTestProject(testApp.db);

      const createRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/templates",
        {
          body: {
            name: "Bug Fix Template with Subtasks",
            template_type: "task",
            template_data: {
              type: "bug",
              priority: "high",
              subtasks: [
                { title: "Investigate root cause", type: "research", effort: "s" },
                { title: "Implement fix", type: "feature", effort: "m" },
                { title: "Write tests", type: "chore", effort: "s" },
              ],
            },
          },
        },
      );
      const template = await createRes.json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/templates/${template.data.id}/instantiate`,
        {
          body: {
            project_id: project.id,
            overrides: { title: "Fix crash on startup" },
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.task).toBeDefined();
      expect(body.data.subtasks).toHaveLength(3);
      expect(body.data.subtasks[0].title).toBe("Investigate root cause");
      expect(body.data.subtasks[0].type).toBe("research");
      expect(body.data.subtasks[1].title).toBe("Implement fix");
      expect(body.data.subtasks[2].title).toBe("Write tests");

      // Verify subtasks have parentTaskId set
      expect(body.data.subtasks[0].parentTaskId).toBe(body.data.task.id);
    });

    it("should reject instantiation without project_id for task template", async () => {
      const createRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/templates",
        {
          body: {
            name: "Task Template",
            template_type: "task",
            template_data: { type: "feature" },
          },
        },
      );
      const template = await createRes.json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/templates/${template.data.id}/instantiate`,
        { body: {} },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("should reject using a project template as task template", async () => {
      const project = createTestProject(testApp.db);

      const createRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/templates",
        {
          body: {
            name: "Project Template",
            template_type: "project",
            template_data: { description: "test" },
          },
        },
      );
      const template = await createRes.json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/templates/${template.data.id}/instantiate`,
        {
          body: {
            project_id: project.id,
          },
        },
      );
      // This should go to the project branch, requiring workspace_id
      expect(res.status).toBe(400);
    });
  });

  // ── Project Template Instantiation ───────────────────────────────

  describe("POST /api/v1/templates/:id/instantiate (project)", () => {
    it("should create a project from a template", async () => {
      // Get workspace ID
      const project = createTestProject(testApp.db);
      const workspaceId = project.workspaceId;

      // Create a project template
      const createRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/templates",
        {
          body: {
            name: "Web Feature Template",
            template_type: "project",
            template_data: {
              description: "A standard web feature project",
              epics: [
                {
                  name: "Design",
                  tasks: [{ title: "Create design doc", type: "design" }],
                },
                {
                  name: "Implementation",
                  tasks: [
                    { title: "Core implementation", type: "feature" },
                    { title: "API endpoints", type: "feature" },
                  ],
                },
              ],
              labels: [
                { name: "frontend", color: "#3b82f6" },
                { name: "backend", color: "#10b981" },
              ],
            },
            created_by: testApp.testUser.id,
          },
        },
      );
      const template = await createRes.json();

      // Instantiate
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/templates/${template.data.id}/instantiate`,
        {
          body: {
            workspace_id: workspaceId,
            name: "User Dashboard Feature",
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.project).toBeDefined();
      expect(body.data.project.name).toBe("User Dashboard Feature");
      expect(body.data.project.description).toBe(
        "A standard web feature project",
      );

      // Verify labels
      expect(body.data.labels).toHaveLength(2);
      expect(body.data.labels[0].name).toBe("frontend");
      expect(body.data.labels[1].name).toBe("backend");

      // Verify epics and tasks
      expect(body.data.epics).toHaveLength(2);
      expect(body.data.epics[0].epic.name).toBe("Design");
      expect(body.data.epics[0].tasks).toHaveLength(1);
      expect(body.data.epics[0].tasks[0].title).toBe("Create design doc");

      expect(body.data.epics[1].epic.name).toBe("Implementation");
      expect(body.data.epics[1].tasks).toHaveLength(2);
    });

    it("should reject instantiation without workspace_id for project template", async () => {
      const createRes = await authRequest(
        testApp.app,
        "POST",
        "/api/v1/templates",
        {
          body: {
            name: "Project Template",
            template_type: "project",
            template_data: { description: "test" },
          },
        },
      );
      const template = await createRes.json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/templates/${template.data.id}/instantiate`,
        { body: { name: "Test" } },
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ── Create Template from Task ────────────────────────────────────

  describe("POST /api/v1/tasks/:id/create-template", () => {
    it("should create a template from a task", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Original Task",
        description: "Task description",
        type: "bug",
        priority: "high",
        estimatedEffort: "m",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/create-template`,
        {
          body: {
            name: "Bug Fix Template",
            description: "Created from a bug fix task",
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toBe("Bug Fix Template");
      expect(body.data.description).toBe("Created from a bug fix task");
      expect(body.data.templateType).toBe("task");
      expect(body.data.projectId).toBe(project.id);

      const templateData = body.data.templateData;
      expect(templateData.type).toBe("bug");
      expect(templateData.priority).toBe("high");
      expect(templateData.estimated_effort).toBe("m");
      expect(templateData.description).toBe("Task description");
    });

    it("should include subtasks in the template", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const parent = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        title: "Parent Task",
        type: "feature",
        priority: "medium",
      });

      // Create subtasks
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        parentTaskId: parent.id,
        title: "Subtask 1",
        type: "research",
        estimatedEffort: "s",
      });
      createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
        parentTaskId: parent.id,
        title: "Subtask 2",
        type: "chore",
        estimatedEffort: "m",
      });

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${parent.id}/create-template`,
        {
          body: { name: "Feature with Subtasks" },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      const templateData = body.data.templateData;
      expect(templateData.subtasks).toHaveLength(2);
      expect(templateData.subtasks[0].title).toBe("Subtask 1");
      expect(templateData.subtasks[0].type).toBe("research");
      expect(templateData.subtasks[0].effort).toBe("s");
      expect(templateData.subtasks[1].title).toBe("Subtask 2");
    });

    it("should return 404 for non-existent task", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${fakeId}/create-template`,
        {
          body: { name: "Template" },
        },
      );
      expect(res.status).toBe(404);
    });
  });
});
