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

  it("carries each epic's category onto its graph node", async () => {
    const project = createTestProject(testApp.db);
    const categorized = createTestEpic(testApp.db, {
      projectId: project.id,
      category: "Backend",
    });
    const uncategorized = createTestEpic(testApp.db, {
      projectId: project.id,
    });

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/epic-graph`,
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const nodeById = new Map(
      body.data.nodes.map((n: { id: string }) => [n.id, n]),
    );
    expect((nodeById.get(categorized.id) as { category: unknown }).category).toBe(
      "Backend",
    );
    expect(
      (nodeById.get(uncategorized.id) as { category: unknown }).category,
    ).toBeNull();
  });
});

describe("Epic dependency CRUD routes", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  function postDep(
    projectId: string,
    epicId: string,
    body: unknown,
  ): Promise<Response> {
    return authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${projectId}/epics/${epicId}/dependencies`,
      { body },
    );
  }

  it("creates an explicit epic dependency (201)", async () => {
    const project = createTestProject(testApp.db);
    const epicA = createTestEpic(testApp.db, { projectId: project.id });
    const epicB = createTestEpic(testApp.db, { projectId: project.id });

    const res = await postDep(project.id, epicB.id, {
      dependsOnEpicId: epicA.id,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.epicId).toBe(epicB.id);
    expect(body.data.dependsOnEpicId).toBe(epicA.id);
    expect(body.data.dependencyType).toBe("blocks");
  });

  it("rejects a duplicate dependency (409)", async () => {
    const project = createTestProject(testApp.db);
    const epicA = createTestEpic(testApp.db, { projectId: project.id });
    const epicB = createTestEpic(testApp.db, { projectId: project.id });

    await postDep(project.id, epicB.id, { dependsOnEpicId: epicA.id });
    const res = await postDep(project.id, epicB.id, {
      dependsOnEpicId: epicA.id,
    });
    expect(res.status).toBe(409);
  });

  it("rejects a self-dependency (400)", async () => {
    const project = createTestProject(testApp.db);
    const epicA = createTestEpic(testApp.db, { projectId: project.id });

    const res = await postDep(project.id, epicA.id, {
      dependsOnEpicId: epicA.id,
    });
    expect(res.status).toBe(400);
  });

  it("404s when an epic is missing", async () => {
    const project = createTestProject(testApp.db);
    const epicA = createTestEpic(testApp.db, { projectId: project.id });

    const res = await postDep(project.id, epicA.id, {
      dependsOnEpicId: "nonexistent",
    });
    expect(res.status).toBe(404);
  });

  it("400s when epics are in different projects (cross-project)", async () => {
    const projectA = createTestProject(testApp.db);
    const projectB = createTestProject(testApp.db);
    const epicA = createTestEpic(testApp.db, { projectId: projectA.id });
    const epicB = createTestEpic(testApp.db, { projectId: projectB.id });

    const res = await postDep(projectA.id, epicA.id, {
      dependsOnEpicId: epicB.id,
    });
    expect(res.status).toBe(400);
  });

  it("GET surfaces an explicit edge with provenance explicit", async () => {
    const project = createTestProject(testApp.db);
    const epicA = createTestEpic(testApp.db, { projectId: project.id });
    const epicB = createTestEpic(testApp.db, { projectId: project.id });

    await postDep(project.id, epicB.id, { dependsOnEpicId: epicA.id });

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/epic-graph`,
    );
    const body = await res.json();
    expect(body.data.edges).toEqual([
      {
        from: epicA.id,
        to: epicB.id,
        dependency_type: "blocks",
        provenance: "explicit",
      },
    ]);
  });

  it("GET reports hasCycle + cycles after A→B and B→A", async () => {
    const project = createTestProject(testApp.db);
    const epicA = createTestEpic(testApp.db, { projectId: project.id });
    const epicB = createTestEpic(testApp.db, { projectId: project.id });

    await postDep(project.id, epicB.id, { dependsOnEpicId: epicA.id });
    await postDep(project.id, epicA.id, { dependsOnEpicId: epicB.id });

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/epic-graph`,
    );
    const body = await res.json();
    expect(body.data.hasCycle).toBe(true);
    expect(Array.isArray(body.data.cycles)).toBe(true);
    const members = new Set<string>(body.data.cycles.flat());
    expect(members.has(epicA.id)).toBe(true);
    expect(members.has(epicB.id)).toBe(true);
  });

  it("deletes a dependency (200) and 404s on unknown id", async () => {
    const project = createTestProject(testApp.db);
    const epicA = createTestEpic(testApp.db, { projectId: project.id });
    const epicB = createTestEpic(testApp.db, { projectId: project.id });

    const created = await postDep(project.id, epicB.id, {
      dependsOnEpicId: epicA.id,
    });
    const dep = (await created.json()).data;

    const del = await authRequest(
      testApp.app,
      "DELETE",
      `/api/v1/projects/${project.id}/epics/${epicB.id}/dependencies/${dep.id}`,
    );
    expect(del.status).toBe(200);

    const del404 = await authRequest(
      testApp.app,
      "DELETE",
      `/api/v1/projects/${project.id}/epics/${epicB.id}/dependencies/unknown`,
    );
    expect(del404.status).toBe(404);
  });
});
