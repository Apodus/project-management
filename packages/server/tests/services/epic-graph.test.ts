import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createId, epicGraphSchema, EPIC_HEALTHS } from "@pm/shared";
import {
  createTestApp,
  createTestEpic,
  createTestProject,
  createTestTask,
  type TestApp,
} from "../utils.js";
import { tasks, taskDependencies, epicDependencies } from "../../src/db/index.js";
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

// ─── P4 node enrichment: health / activity_recency / time_window ──────

/** Fetch the enriched node for an epic from a fresh getGraph call. */
function nodeFor(projectId: string, epicId: string) {
  const graph = epicGraphService.getGraph(projectId);
  // Every emitted node satisfies the (now-required) enriched contract.
  expect(() => epicGraphSchema.parse(graph)).not.toThrow();
  return graph.nodes.find((n) => n.id === epicId)!;
}

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

describe("epic-graph.service P4 health truth table", () => {
  it("done via epic status=completed (zero tasks)", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id, status: "completed" });
    expect(nodeFor(project.id, epic.id).health).toBe("done");
  });

  it("done via all tasks done", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "done" });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "done" });
    expect(nodeFor(project.id, epic.id).health).toBe("done");
  });

  it("done beats a past target_date", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, {
      projectId: project.id,
      status: "completed",
      targetDate: PAST,
    });
    expect(nodeFor(project.id, epic.id).health).toBe("done");
  });

  it("done beats an incomplete prerequisite (blocked is not reached)", () => {
    const project = createTestProject(ctx.db);
    const pre = createTestEpic(ctx.db, { projectId: project.id }); // incomplete prereq
    const dep = createTestEpic(ctx.db, { projectId: project.id, status: "completed" });
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: dep.id,
      dependsOnEpicId: pre.id,
    });
    expect(nodeFor(project.id, dep.id).health).toBe("done");
  });

  it("blocked when an explicit blocks prerequisite is incomplete", () => {
    const project = createTestProject(ctx.db);
    const pre = createTestEpic(ctx.db, { projectId: project.id }); // incomplete
    const dep = createTestEpic(ctx.db, { projectId: project.id });
    createTestTask(ctx.db, { projectId: project.id, epicId: dep.id, status: "in_progress" });
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: dep.id,
      dependsOnEpicId: pre.id,
    });
    expect(nodeFor(project.id, dep.id).health).toBe("blocked");
  });

  it("blocked beats at_risk (blocked + past target)", () => {
    const project = createTestProject(ctx.db);
    const pre = createTestEpic(ctx.db, { projectId: project.id }); // incomplete
    const dep = createTestEpic(ctx.db, { projectId: project.id, targetDate: PAST });
    createTestTask(ctx.db, { projectId: project.id, epicId: dep.id, status: "in_progress" });
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: dep.id,
      dependsOnEpicId: pre.id,
    });
    expect(nodeFor(project.id, dep.id).health).toBe("blocked");
  });

  it("blocked beats not_started (blocked + done===0)", () => {
    const project = createTestProject(ctx.db);
    const pre = createTestEpic(ctx.db, { projectId: project.id }); // incomplete
    const dep = createTestEpic(ctx.db, { projectId: project.id });
    createTestTask(ctx.db, { projectId: project.id, epicId: dep.id, status: "backlog" });
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: dep.id,
      dependsOnEpicId: pre.id,
    });
    expect(nodeFor(project.id, dep.id).health).toBe("blocked");
  });

  it("a COMPLETE prerequisite does not block (prereq done ⇒ not blocked)", () => {
    const project = createTestProject(ctx.db);
    const pre = createTestEpic(ctx.db, { projectId: project.id, status: "completed" });
    const dep = createTestEpic(ctx.db, { projectId: project.id });
    createTestTask(ctx.db, { projectId: project.id, epicId: dep.id, status: "done" });
    createTestTask(ctx.db, { projectId: project.id, epicId: dep.id, status: "in_progress" });
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: dep.id,
      dependsOnEpicId: pre.id,
    });
    expect(nodeFor(project.id, dep.id).health).toBe("on_track");
  });

  it("a relates_to prerequisite never blocks", () => {
    const project = createTestProject(ctx.db);
    const pre = createTestEpic(ctx.db, { projectId: project.id }); // incomplete
    const dep = createTestEpic(ctx.db, { projectId: project.id });
    createTestTask(ctx.db, { projectId: project.id, epicId: dep.id, status: "done" });
    createTestTask(ctx.db, { projectId: project.id, epicId: dep.id, status: "in_progress" });
    epicGraphService.createDependency({
      projectId: project.id,
      epicId: dep.id,
      dependsOnEpicId: pre.id,
      dependencyType: "relates_to",
    });
    expect(nodeFor(project.id, dep.id).health).toBe("on_track");
  });

  it("at_risk when incomplete, not blocked, past target, done>0", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id, targetDate: PAST });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "done" });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "backlog" });
    expect(nodeFor(project.id, epic.id).health).toBe("at_risk");
  });

  it("at_risk with a date-only past target (2020-01-01 orders before now)", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id, targetDate: "2020-01-01" });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "done" });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "backlog" });
    expect(nodeFor(project.id, epic.id).health).toBe("at_risk");
  });

  it("a null target_date is never at_risk (on_track for done>0)", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id, targetDate: null });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "done" });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "backlog" });
    expect(nodeFor(project.id, epic.id).health).toBe("on_track");
  });

  it("a future target_date is never at_risk", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id, targetDate: FUTURE });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "done" });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "backlog" });
    expect(nodeFor(project.id, epic.id).health).toBe("on_track");
  });

  it("not_started when there are tasks but done===0", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "backlog" });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "ready" });
    expect(nodeFor(project.id, epic.id).health).toBe("not_started");
  });

  it("a zero-task epic is not_started", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });
    expect(nodeFor(project.id, epic.id).health).toBe("not_started");
  });

  it("on_track when done>0, no/future target, not blocked", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "done" });
    createTestTask(ctx.db, { projectId: project.id, epicId: epic.id, status: "in_progress" });
    expect(nodeFor(project.id, epic.id).health).toBe("on_track");
  });

  it("every node's health is a member of EPIC_HEALTHS", () => {
    const project = createTestProject(ctx.db);
    createTestEpic(ctx.db, { projectId: project.id });
    const completed = createTestEpic(ctx.db, { projectId: project.id, status: "completed" });
    createTestTask(ctx.db, { projectId: project.id, epicId: completed.id, status: "done" });

    const graph = epicGraphService.getGraph(project.id);
    for (const n of graph.nodes) {
      expect(EPIC_HEALTHS).toContain(n.health);
    }
  });
});

describe("epic-graph.service P4 activity_recency", () => {
  it("is max(task.updated_at) across the epic's tasks", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });
    const t1 = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });
    const t2 = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });

    const older = "2026-01-01T00:00:00.000Z";
    const newer = "2026-03-01T00:00:00.000Z";
    ctx.db.update(tasks).set({ updatedAt: older }).where(eq(tasks.id, t1.id)).run();
    ctx.db.update(tasks).set({ updatedAt: newer }).where(eq(tasks.id, t2.id)).run();

    expect(nodeFor(project.id, epic.id).activity_recency).toBe(newer);
  });

  it("falls back to epic.updated_at when the epic has no tasks", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });

    const node = nodeFor(project.id, epic.id);
    // No tasks ⇒ not in the recency map ⇒ fall back to the epic's own updated_at.
    expect(node.activity_recency).toBe(node.updated_at);
  });
});

describe("epic-graph.service P4 time_window", () => {
  it("{ start: created_at, end: target_date } when a target is set", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id, targetDate: FUTURE });
    const node = nodeFor(project.id, epic.id);
    expect(node.time_window).toEqual({ start: node.created_at, end: FUTURE });
  });

  it("{ start: created_at, end: null } when no target is set", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id, targetDate: null });
    const node = nodeFor(project.id, epic.id);
    expect(node.time_window).toEqual({ start: node.created_at, end: null });
  });

  it("start === created_at even when a task has a different started_at", () => {
    const project = createTestProject(ctx.db);
    const epic = createTestEpic(ctx.db, { projectId: project.id });
    const t = createTestTask(ctx.db, { projectId: project.id, epicId: epic.id });
    // A task's own timestamps must not leak into the epic's window start.
    ctx.db
      .update(tasks)
      .set({ updatedAt: "2026-04-04T00:00:00.000Z" })
      .where(eq(tasks.id, t.id))
      .run();
    const node = nodeFor(project.id, epic.id);
    expect(node.time_window.start).toBe(node.created_at);
  });
});
