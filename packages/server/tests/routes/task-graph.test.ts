import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createId } from "@pm/shared";
import {
  createTestApp,
  createTestEpic,
  createTestProject,
  createTestTask,
  authRequest,
  type TestApp,
} from "../utils.js";
import { taskDependencies } from "../../src/db/index.js";

describe("GET /api/v1/projects/:projectId/epics/:epicId/task-graph", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("returns the task graph with nodes and intra-epic edges", async () => {
    const project = createTestProject(testApp.db);
    const epic = createTestEpic(testApp.db, { projectId: project.id });

    const a = createTestTask(testApp.db, { projectId: project.id, epicId: epic.id });
    const b = createTestTask(testApp.db, { projectId: project.id, epicId: epic.id });
    testApp.db
      .insert(taskDependencies)
      .values({
        id: createId(),
        taskId: b.id,
        dependsOnTaskId: a.id,
        dependencyType: "blocks",
        createdAt: new Date().toISOString(),
      })
      .run();

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/epics/${epic.id}/task-graph`,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.nodes).toHaveLength(2);
    expect(body.data.edges).toEqual([
      {
        from: a.id,
        to: b.id,
        dependency_type: "blocks",
        provenance: "explicit",
      },
    ]);
    expect(body.data.hasCycle).toBe(false);
  });

  it("404s when the epic does not exist", async () => {
    const project = createTestProject(testApp.db);

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/epics/nonexistent/task-graph`,
    );
    expect(res.status).toBe(404);
  });
});
