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

describe("GET /api/v1/projects/:projectId/epic-graph", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("returns the epic graph with nodes and derived edges", async () => {
    const project = createTestProject(testApp.db);
    const epicA = createTestEpic(testApp.db, { projectId: project.id });
    const epicB = createTestEpic(testApp.db, { projectId: project.id });

    const a1 = createTestTask(testApp.db, { projectId: project.id, epicId: epicA.id });
    const b1 = createTestTask(testApp.db, { projectId: project.id, epicId: epicB.id });
    testApp.db
      .insert(taskDependencies)
      .values({
        id: createId(),
        taskId: b1.id,
        dependsOnTaskId: a1.id,
        dependencyType: "blocks",
        createdAt: new Date().toISOString(),
      })
      .run();

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/epic-graph`,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.nodes).toHaveLength(2);
    expect(body.data.edges).toEqual([
      {
        from: epicA.id,
        to: epicB.id,
        dependency_type: "blocks",
        provenance: "derived",
      },
    ]);
    expect(body.data.hasCycle).toBe(false);
  });
});
