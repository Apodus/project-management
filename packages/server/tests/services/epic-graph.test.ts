import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createId, epicGraphSchema } from "@pm/shared";
import {
  createTestApp,
  createTestEpic,
  createTestProject,
  createTestTask,
  type TestApp,
} from "../utils.js";
import { taskDependencies, epicDependencies } from "../../src/db/index.js";
import { AppError } from "../../src/types.js";
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

describe("epic-graph.service explicit edges + provenance union", () => {
  it("surfaces an explicit-only edge with provenance explicit", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });
    const epicB = createTestEpic(ctx.db, { projectId: project.id });

    // epicB depends on epicA → from=A (prerequisite), to=B (dependent).
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicB.id,
      dependsOnEpicId: epicA.id,
    });

    const graph = epicGraphService.getGraph(project.id);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({
      from: epicA.id,
      to: epicB.id,
      dependency_type: "blocks",
      provenance: "explicit",
    });
  });

  it("collapses a derived + explicit edge on the same pair to one explicit edge (explicit wins)", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });
    const epicB = createTestEpic(ctx.db, { projectId: project.id });

    // Derived A→B via a cross-epic task blocks dep.
    const a1 = createTestTask(ctx.db, { projectId: project.id, epicId: epicA.id });
    const b1 = createTestTask(ctx.db, { projectId: project.id, epicId: epicB.id });
    addDep(b1.id, a1.id);

    // Explicit A→B blocks dep on the SAME ordered pair.
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicB.id,
      dependsOnEpicId: epicA.id,
    });

    const graph = epicGraphService.getGraph(project.id);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].provenance).toBe("explicit");
  });

  it("keeps blocks + relates_to on the same pair as two distinct edges", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });
    const epicB = createTestEpic(ctx.db, { projectId: project.id });

    epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicB.id,
      dependsOnEpicId: epicA.id,
      dependencyType: "blocks",
    });
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicB.id,
      dependsOnEpicId: epicA.id,
      dependencyType: "relates_to",
    });

    const graph = epicGraphService.getGraph(project.id);
    expect(graph.edges).toHaveLength(2);
    const types = graph.edges.map((e) => e.dependency_type).sort();
    expect(types).toEqual(["blocks", "relates_to"]);
    expect(graph.edges.every((e) => e.provenance === "explicit")).toBe(true);
  });
});

describe("epic-graph.service cycle detection", () => {
  it("flags a two-node cycle A→B→A and includes both members", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });
    const epicB = createTestEpic(ctx.db, { projectId: project.id });

    // A→B (B depends on A) and B→A (A depends on B).
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicB.id,
      dependsOnEpicId: epicA.id,
    });
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicA.id,
      dependsOnEpicId: epicB.id,
    });

    const graph = epicGraphService.getGraph(project.id);
    expect(graph.hasCycle).toBe(true);
    expect(graph.cycles).toBeDefined();
    const members = new Set(graph.cycles!.flat());
    expect(members.has(epicA.id)).toBe(true);
    expect(members.has(epicB.id)).toBe(true);
  });

  it("flags a triangle cycle A→B→C→A", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });
    const epicB = createTestEpic(ctx.db, { projectId: project.id });
    const epicC = createTestEpic(ctx.db, { projectId: project.id });

    // edges from→to: A→B, B→C, C→A
    // (epicId depends on dependsOnEpicId → from = dependsOn, to = epicId)
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicB.id,
      dependsOnEpicId: epicA.id,
    });
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicC.id,
      dependsOnEpicId: epicB.id,
    });
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicA.id,
      dependsOnEpicId: epicC.id,
    });

    const graph = epicGraphService.getGraph(project.id);
    expect(graph.hasCycle).toBe(true);
    const members = new Set(graph.cycles!.flat());
    expect(members.has(epicA.id)).toBe(true);
    expect(members.has(epicB.id)).toBe(true);
    expect(members.has(epicC.id)).toBe(true);
  });

  it("reports an acyclic explicit graph as hasCycle false with cycles undefined", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });
    const epicB = createTestEpic(ctx.db, { projectId: project.id });
    const epicC = createTestEpic(ctx.db, { projectId: project.id });

    // A→B, B→C (acyclic chain)
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicB.id,
      dependsOnEpicId: epicA.id,
    });
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicC.id,
      dependsOnEpicId: epicB.id,
    });

    const graph = epicGraphService.getGraph(project.id);
    expect(graph.hasCycle).toBe(false);
    expect(graph.cycles).toBeUndefined();
    expect(() => epicGraphSchema.parse(graph)).not.toThrow();
  });
});

describe("epic-graph.service createDependency / deleteDependency", () => {
  it("rejects a self-dependency with 400 SELF_DEPENDENCY (DB check)", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });

    try {
      epicGraphService.createDependency({
        projectId: project.id,
        epicId: epicA.id,
        dependsOnEpicId: epicA.id,
      });
      throw new Error("expected createDependency to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).code).toBe("SELF_DEPENDENCY");
    }
  });

  it("rejects a duplicate with 409 CONFLICT (DB unique index)", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });
    const epicB = createTestEpic(ctx.db, { projectId: project.id });

    epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicB.id,
      dependsOnEpicId: epicA.id,
    });

    try {
      epicGraphService.createDependency({
        projectId: project.id,
        epicId: epicB.id,
        dependsOnEpicId: epicA.id,
      });
      throw new Error("expected createDependency to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(409);
      expect((err as AppError).code).toBe("CONFLICT");
    }
  });

  it("404s when an epic does not exist", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });

    try {
      epicGraphService.createDependency({
        projectId: project.id,
        epicId: epicA.id,
        dependsOnEpicId: "nonexistent-epic",
      });
      throw new Error("expected createDependency to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(404);
    }
  });

  it("400 CROSS_PROJECT when the two epics belong to different projects", () => {
    const projectA = createTestProject(ctx.db);
    const projectB = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: projectA.id });
    const epicB = createTestEpic(ctx.db, { projectId: projectB.id });

    try {
      epicGraphService.createDependency({
        projectId: projectA.id,
        epicId: epicA.id,
        dependsOnEpicId: epicB.id,
      });
      throw new Error("expected createDependency to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).code).toBe("CROSS_PROJECT");
    }
  });

  it("deletes an existing dependency and 404s on an unknown id", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });
    const epicB = createTestEpic(ctx.db, { projectId: project.id });

    const dep = epicGraphService.createDependency({
      projectId: project.id,
      epicId: epicB.id,
      dependsOnEpicId: epicA.id,
    });

    const deleted = epicGraphService.deleteDependency(dep.id);
    expect(deleted.id).toBe(dep.id);

    const remaining = ctx.db.select().from(epicDependencies).all();
    expect(remaining).toHaveLength(0);

    try {
      epicGraphService.deleteDependency("nonexistent-dep");
      throw new Error("expected deleteDependency to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(404);
    }
  });
});
