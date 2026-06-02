import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createId, epicGraphSchema } from "@pm/shared";
import {
  createTestApp,
  createTestEpic,
  createTestProject,
  createTestTask,
  type TestApp,
} from "../utils.js";
import { taskDependencies } from "../../src/db/index.js";
import * as epicGraphService from "../../src/services/epic-graph.service.js";

let ctx: TestApp;

beforeEach(() => {
  ctx = createTestApp();
});

afterEach(() => {
  ctx.cleanup();
});

/** Insert a task_dependencies row directly (no factory exists). */
function addDep(
  taskId: string,
  dependsOnTaskId: string,
  dependencyType: "blocks" | "relates_to" = "blocks",
) {
  ctx.db
    .insert(taskDependencies)
    .values({
      id: createId(),
      taskId,
      dependsOnTaskId,
      dependencyType,
      createdAt: new Date().toISOString(),
    })
    .run();
}

describe("epic-graph.service getGraph", () => {
  it("dedups multiple cross-epic blocks deps into a single A→B edge", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });
    const epicB = createTestEpic(ctx.db, { projectId: project.id });

    const a1 = createTestTask(ctx.db, { projectId: project.id, epicId: epicA.id });
    const a2 = createTestTask(ctx.db, { projectId: project.id, epicId: epicA.id });
    const b1 = createTestTask(ctx.db, { projectId: project.id, epicId: epicB.id });
    const b2 = createTestTask(ctx.db, { projectId: project.id, epicId: epicB.id });

    // Two tasks in B each blocks-depend on tasks in A → must collapse to ONE edge.
    addDep(b1.id, a1.id);
    addDep(b2.id, a2.id);

    const graph = epicGraphService.getGraph(project.id);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({
      from: epicA.id,
      to: epicB.id,
      dependency_type: "blocks",
      provenance: "derived",
    });
  });

  it("produces no self-edge for a blocks dep within the same epic", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });

    const t1 = createTestTask(ctx.db, { projectId: project.id, epicId: epicA.id });
    const t2 = createTestTask(ctx.db, { projectId: project.id, epicId: epicA.id });
    addDep(t2.id, t1.id);

    const graph = epicGraphService.getGraph(project.id);
    expect(graph.edges).toHaveLength(0);
  });

  it("includes isolated epics as nodes (node count == epic count)", () => {
    const project = createTestProject(ctx.db);
    createTestEpic(ctx.db, { projectId: project.id });
    createTestEpic(ctx.db, { projectId: project.id });
    createTestEpic(ctx.db, { projectId: project.id });

    const graph = epicGraphService.getGraph(project.id);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(0);
  });

  it("carries taskSummary on nodes from the single completion source", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });

    createTestTask(ctx.db, { projectId: project.id, epicId: epicA.id, status: "done" });
    createTestTask(ctx.db, { projectId: project.id, epicId: epicA.id, status: "backlog" });
    createTestTask(ctx.db, { projectId: project.id, epicId: epicA.id, status: "in_progress" });

    const graph = epicGraphService.getGraph(project.id);
    const node = graph.nodes.find((n) => n.id === epicA.id)!;

    expect(node.taskSummary.total).toBe(3);
    expect(node.taskSummary.done).toBe(1);
    expect(node.taskSummary.byStatus).toEqual({
      done: 1,
      backlog: 1,
      in_progress: 1,
    });
  });

  it("excludes relates_to deps from derived edges", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });
    const epicB = createTestEpic(ctx.db, { projectId: project.id });

    const a1 = createTestTask(ctx.db, { projectId: project.id, epicId: epicA.id });
    const b1 = createTestTask(ctx.db, { projectId: project.id, epicId: epicB.id });
    addDep(b1.id, a1.id, "relates_to");

    const graph = epicGraphService.getGraph(project.id);
    expect(graph.edges).toHaveLength(0);
  });

  it("conforms to the canonical epicGraphSchema contract", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });
    const epicB = createTestEpic(ctx.db, { projectId: project.id });

    const a1 = createTestTask(ctx.db, { projectId: project.id, epicId: epicA.id });
    const b1 = createTestTask(ctx.db, { projectId: project.id, epicId: epicB.id });
    addDep(b1.id, a1.id);

    const graph = epicGraphService.getGraph(project.id);

    expect(() => epicGraphSchema.parse(graph)).not.toThrow();
    expect(graph.hasCycle).toBe(false);
    expect(graph.cycles).toBeUndefined();
  });

  it("does not leak cross-epic deps from another project", () => {
    const projectA = createTestProject(ctx.db);
    const projectB = createTestProject(ctx.db);

    // A cross-epic blocks dep entirely inside project B.
    const bEpic1 = createTestEpic(ctx.db, { projectId: projectB.id });
    const bEpic2 = createTestEpic(ctx.db, { projectId: projectB.id });
    const bt1 = createTestTask(ctx.db, { projectId: projectB.id, epicId: bEpic1.id });
    const bt2 = createTestTask(ctx.db, { projectId: projectB.id, epicId: bEpic2.id });
    addDep(bt2.id, bt1.id);

    // Project A has its own epics but no deps.
    createTestEpic(ctx.db, { projectId: projectA.id });

    const graphA = epicGraphService.getGraph(projectA.id);
    expect(graphA.edges).toHaveLength(0);

    // Sanity: project B does have the edge.
    const graphB = epicGraphService.getGraph(projectB.id);
    expect(graphB.edges).toHaveLength(1);
  });
});
