import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestUser,
  createTestProject,
  createTestTask,
  authRequest,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";

describe("Labels API", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── GET /api/v1/projects/:projectId/labels ────────────────────────
  describe("GET /api/v1/projects/:projectId/labels", () => {
    it("should return empty list when no labels exist", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/labels`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it("should return labels for a project", async () => {
      const project = createTestProject(testApp.db);

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug", color: "#ff0000" } },
      );
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "feature", color: "#00ff00" } },
      );

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/labels`,
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });
  });

  // ── POST /api/v1/projects/:projectId/labels ───────────────────────
  describe("POST /api/v1/projects/:projectId/labels", () => {
    it("should create a label with valid data", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        {
          body: {
            name: "bug",
            color: "#ff0000",
            description: "Bug reports",
          },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toBe("bug");
      expect(body.data.color).toBe("#ff0000");
      expect(body.data.description).toBe("Bug reports");
      expect(body.data.projectId).toBe(project.id);
      expect(body.data.id).toBeDefined();
    });

    it("should create a label without color", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        {
          body: { name: "enhancement" },
        },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.name).toBe("enhancement");
      expect(body.data.color).toBeNull();
    });

    it("should reject missing name", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { color: "#ff0000" } },
      );
      expect(res.status).toBe(400);
    });

    it("should enforce unique name within project", async () => {
      const project = createTestProject(testApp.db);

      // First creation should succeed
      const res1 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug" } },
      );
      expect(res1.status).toBe(201);

      // Second with same name should fail
      const res2 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug" } },
      );
      expect(res2.status).toBe(409);

      const body = await res2.json();
      expect(body.error.code).toBe("CONFLICT");
    });

    it("should allow same name in different projects", async () => {
      const project1 = createTestProject(testApp.db);
      const project2 = createTestProject(testApp.db);

      const res1 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project1.id}/labels`,
        { body: { name: "bug" } },
      );
      expect(res1.status).toBe(201);

      const res2 = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project2.id}/labels`,
        { body: { name: "bug" } },
      );
      expect(res2.status).toBe(201);
    });

    it("should reject invalid hex color", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug", color: "red" } },
      );
      expect(res.status).toBe(400);
    });

    it("should reject 3-digit hex color", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug", color: "#f00" } },
      );
      expect(res.status).toBe(400);
    });

    it("should accept valid 6-digit hex color", async () => {
      const project = createTestProject(testApp.db);

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug", color: "#aaBBcc" } },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.color).toBe("#aaBBcc");
    });
  });

  // ── PATCH /api/v1/labels/:id ──────────────────────────────────────
  describe("PATCH /api/v1/labels/:id", () => {
    it("should update label name", async () => {
      const project = createTestProject(testApp.db);

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug", color: "#ff0000" } },
      );
      const created = await createRes.json();

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/labels/${created.data.id}`,
        { body: { name: "defect" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.name).toBe("defect");
    });

    it("should update label color", async () => {
      const project = createTestProject(testApp.db);

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug", color: "#ff0000" } },
      );
      const created = await createRes.json();

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/labels/${created.data.id}`,
        { body: { color: "#00ff00" } },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.color).toBe("#00ff00");
    });

    it("should return 404 for non-existent label", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/labels/${fakeId}`,
        { body: { name: "nope" } },
      );
      expect(res.status).toBe(404);
    });

    it("should reject renaming to a name that already exists in the project", async () => {
      const project = createTestProject(testApp.db);

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug" } },
      );

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "feature" } },
      );
      const created = await createRes.json();

      const res = await authRequest(
        testApp.app,
        "PATCH",
        `/api/v1/labels/${created.data.id}`,
        { body: { name: "bug" } },
      );
      expect(res.status).toBe(409);
    });
  });

  // ── DELETE /api/v1/labels/:id ─────────────────────────────────────
  describe("DELETE /api/v1/labels/:id", () => {
    it("should delete a label", async () => {
      const project = createTestProject(testApp.db);

      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug" } },
      );
      const created = await createRes.json();

      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/labels/${created.data.id}`,
      );
      expect(res.status).toBe(200);

      // Verify it's gone
      const listRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/labels`,
      );
      const listBody = await listRes.json();
      expect(listBody.data).toHaveLength(0);
    });

    it("should return 404 for non-existent label", async () => {
      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/labels/${fakeId}`,
      );
      expect(res.status).toBe(404);
    });

    it("should cascade delete to task_labels associations", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      // Create and attach a label
      const createRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug" } },
      );
      const created = await createRes.json();

      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/labels`,
        { body: { labelId: created.data.id } },
      );

      // Delete the label
      const deleteRes = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/labels/${created.data.id}`,
      );
      expect(deleteRes.status).toBe(200);

      // The detach should now fail with 404 (association already cleaned up)
      const detachRes = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/tasks/${task.id}/labels/${created.data.id}`,
      );
      expect(detachRes.status).toBe(404);
    });
  });

  // ── POST /api/v1/tasks/:id/labels (attach) ───────────────────────
  describe("POST /api/v1/tasks/:id/labels", () => {
    it("should attach a label to a task", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const labelRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug" } },
      );
      const label = await labelRes.json();

      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/labels`,
        { body: { labelId: label.data.id } },
      );
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.taskId).toBe(task.id);
      expect(body.data.labelId).toBe(label.data.id);
    });

    it("should reject duplicate attachment", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const labelRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug" } },
      );
      const label = await labelRes.json();

      // First attach
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/labels`, {
        body: { labelId: label.data.id },
      });

      // Second attach should fail
      const res = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/tasks/${task.id}/labels`,
        { body: { labelId: label.data.id } },
      );
      expect(res.status).toBe(409);
    });
  });

  // ── DELETE /api/v1/tasks/:id/labels/:labelId (detach) ─────────────
  describe("DELETE /api/v1/tasks/:id/labels/:labelId", () => {
    it("should detach a label from a task", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const labelRes = await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/labels`,
        { body: { name: "bug" } },
      );
      const label = await labelRes.json();

      // Attach
      await authRequest(testApp.app, "POST", `/api/v1/tasks/${task.id}/labels`, {
        body: { labelId: label.data.id },
      });

      // Detach
      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/tasks/${task.id}/labels/${label.data.id}`,
      );
      expect(res.status).toBe(200);
    });

    it("should return 404 when label is not attached", async () => {
      const project = createTestProject(testApp.db);
      const user = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, {
        projectId: project.id,
        reporterId: user.id,
      });

      const fakeId = createId();
      const res = await authRequest(
        testApp.app,
        "DELETE",
        `/api/v1/tasks/${task.id}/labels/${fakeId}`,
      );
      expect(res.status).toBe(404);
    });
  });
});
