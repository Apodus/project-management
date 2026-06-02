import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createId, taskGraphSchema } from "@pm/shared";
import {
  createTestApp,
  createTestEpic,
  createTestProject,
  createTestTask,
  type TestApp,
} from "../utils.js";
import { taskDependencies } from "../../src/db/index.js";
import { AppError } from "../../src/types.js";
import * as taskGraphService from "../../src/services/task-graph.service.js";

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

describe("task-graph.service getTaskGraph", () => {
  it("keeps only intra-epic edges (a dep to a task in ANOTHER epic is excluded)", () => {
    const project = createTestProject(ctx.db);
    const epicA = createTestEpic(ctx.db, { projectId: project.id });
    const epicB = createTestEpic(ctx.db, { projectId: project.id });

    const a1 = createTestTask(ctx.db, { projectId: project.id, epicId: epicA.id });
    const a2 = createTestTask(ctx.db, { projectId: project.id, epicId: epicA.id });
    const b1 = createTestTask(ctx.db, { projectId: project.id, epicId: epicB.id });

    // Intra-epic dep within A (a2 depends on a1) → kept.
    addDep(a2.id, a1.id);
    // Cross-epic dep (a1 depends on b1, b1 is in epic B) → excluded.
    addDep(a1.id, b1.id);

    const graph = taskGraphService.getTaskGraph(project.id, epicA.id);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({
      from: a1.id, // prerequisite (depends_on_task_id)
      to: a2.id, // dependent (task_id)
      dependency_type: "blocks",
      provenance: "explicit",
    });
  });

  it("derives done from status === 'done' per node", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });

    const t1 = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "done" });
    const t2 = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "in_progress" });
    const t3 = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "backlog" });

    const graph = taskGraphService.getTaskGraph(project.id, epic.id);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    expect(byId.get(t1.id)!.done).toBe(true);
    expect(byId.get(t2.id)!.done).toBe(false);
    expect(byId.get(t3.id)!.done).toBe(false);
  });

  it("includes ALL the epic's tasks as nodes (a cancelled task is present)", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });

    const live = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "in_progress" });
    const cancelled = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "cancelled" });

    const graph = taskGraphService.getTaskGraph(project.id, epic.id);
    const ids = new Set(graph.nodes.map((n) => n.id));

    expect(graph.nodes).toHaveLength(2);
    expect(ids.has(live.id)).toBe(true);
    expect(ids.has(cancelled.id)).toBe(true);
  });

  it("flags a 3-task cycle a→b→c→a (via blocks) and includes all members", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });

    const a = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });
    const b = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });
    const c = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });

    // edges from→to (from = depends_on, to = task): a→b, b→c, c→a
    addDep(b.id, a.id); // b depends on a → from a, to b
    addDep(c.id, b.id); // c depends on b → from b, to c
    addDep(a.id, c.id); // a depends on c → from c, to a

    const graph = taskGraphService.getTaskGraph(project.id, epic.id);
    expect(graph.hasCycle).toBe(true);
    expect(graph.cycles).toBeDefined();
    const members = new Set(graph.cycles!.flat());
    expect(members.has(a.id)).toBe(true);
    expect(members.has(b.id)).toBe(true);
    expect(members.has(c.id)).toBe(true);
  });

  it("reports an acyclic graph as hasCycle false with cycles undefined", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });

    const a = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });
    const b = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });
    const c = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });

    addDep(b.id, a.id); // a→b
    addDep(c.id, b.id); // b→c

    const graph = taskGraphService.getTaskGraph(project.id, epic.id);
    expect(graph.hasCycle).toBe(false);
    expect(graph.cycles).toBeUndefined();
    expect(() => taskGraphSchema.parse(graph)).not.toThrow();
  });

  it("returns an empty graph for an epic with no tasks", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });

    const graph = taskGraphService.getTaskGraph(project.id, epic.id);
    expect(graph).toEqual({ nodes: [], edges: [], hasCycle: false });
  });

  it("returns nodes with empty edges when tasks have no deps", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });

    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });

    const graph = taskGraphService.getTaskGraph(project.id, epic.id);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(0);
  });

  it("conforms to the canonical taskGraphSchema contract", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });

    const a = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });
    const b = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });
    addDep(b.id, a.id);

    const graph = taskGraphService.getTaskGraph(project.id, epic.id);
    expect(() => taskGraphSchema.parse(graph)).not.toThrow();
  });

  it("404s when the epic does not exist", () => {
    const project = createTestProject(ctx.db);

    try {
      taskGraphService.getTaskGraph(project.id, "nonexistent-epic");
      throw new Error("expected getTaskGraph to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(404);
    }
  });

  it("404s when the epic belongs to a different project (cross-project)", () => {
    const projectA = createTestProject(ctx.db);
    const projectB = createTestProject(ctx.db);
    const epicB = createTestEpic(ctx.db, { projectId: projectB.id });

    try {
      taskGraphService.getTaskGraph(projectA.id, epicB.id);
      throw new Error("expected getTaskGraph to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(404);
    }
  });
});
