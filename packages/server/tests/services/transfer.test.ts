import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestEpic,
  createTestProject,
  createTestProposal,
  createTestTask,
  type TestApp,
} from "../utils.js";
import {
  activityLog,
  auditLog,
  comments,
  epicDependencies,
  epics,
  gitRefs,
  labels,
  mergeIncidents,
  mergeLocks,
  mergeRequestGroups,
  mergeRequests,
  milestones,
  proposals,
  taskDependencies,
  taskLabels,
  tasks,
  workspaces,
} from "../../src/db/index.js";
import * as transferSvc from "../../src/services/transfer.service.js";
import * as depSvc from "../../src/services/dependency.service.js";
import { AppError } from "../../src/types.js";

/**
 * Engine-independence C4-P4: tasks, epics and proposals move between projects of
 * one workspace without being re-created; cross-project task dependencies are a
 * contract, not an accident.
 */

let t: TestApp;
const NOW = new Date().toISOString();
const human = () => ({ id: t.testUser.id, type: "human" as const });

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return `${err.statusCode} ${err.code}`;
    throw err;
  }
  return "no error";
}

function request(projectId: string, taskId: string, status: string, groupId: string | null = null) {
  const id = createId();
  t.db
    .insert(mergeRequests)
    .values({
      id,
      projectId,
      resource: "main",
      submittedBy: t.testUser.id,
      taskId,
      groupId,
      status,
      enqueuedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  return id;
}

function group(projectId: string, state: string) {
  const id = createId();
  t.db
    .insert(mergeRequestGroups)
    .values({
      id,
      projectId,
      resource: "main",
      state,
      submittedBy: t.testUser.id,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  return id;
}

beforeEach(() => {
  t = createTestApp();
});
afterEach(() => {
  t.cleanup();
});

describe("transfer: a task", () => {
  it("moves the task; comments, git refs, claim and dependencies follow; labels are dropped and listed", () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const epic = createTestEpic(t.db, { projectId: game.id });
    const agent = createTestAiAgent(t.db);
    const task = createTestTask(t.db, {
      projectId: game.id,
      epicId: epic.id,
      assigneeId: agent.user.id,
    });
    const other = createTestTask(t.db, { projectId: game.id });
    t.db
      .insert(comments)
      .values({
        id: createId(),
        taskId: task.id,
        authorId: t.testUser.id,
        body: "context",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    t.db
      .insert(gitRefs)
      .values({
        id: createId(),
        taskId: task.id,
        refType: "branch",
        refValue: "engine-ind/x",
        createdAt: NOW,
      })
      .run();
    t.db
      .insert(taskDependencies)
      .values({
        id: createId(),
        taskId: other.id,
        dependsOnTaskId: task.id,
        dependencyType: "blocks",
        createdAt: NOW,
      })
      .run();
    const label = createId();
    t.db.insert(labels).values({ id: label, projectId: game.id, name: "physics" }).run();
    t.db.insert(taskLabels).values({ taskId: task.id, labelId: label }).run();

    const res = transferSvc.transfer(
      "task",
      task.id,
      { id: agent.user.id, type: "ai_agent" },
      {
        target_project_id: engine.id,
        reason: "engine work lives in rynx-engine",
      },
    );

    expect(res).toMatchObject({
      entity_type: "task",
      from_project_id: game.id,
      to_project_id: engine.id,
      moved_task_ids: [task.id],
      dropped_labels: [`${task.id}: physics`],
    });
    const moved = t.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(moved.projectId).toBe(engine.id);
    expect(moved.epicId).toBeNull(); // its epic stayed in the game project
    expect(moved.assigneeId).toBe(agent.user.id); // the claim holder is unchanged
    expect(t.db.select().from(comments).where(eq(comments.taskId, task.id)).all()).toHaveLength(1);
    expect(t.db.select().from(gitRefs).where(eq(gitRefs.taskId, task.id)).all()).toHaveLength(1);
    expect(
      t.db
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.dependsOnTaskId, task.id))
        .all(),
    ).toHaveLength(1);
    expect(t.db.select().from(taskLabels).where(eq(taskLabels.taskId, task.id)).all()).toHaveLength(
      0,
    );

    const activity = t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, task.id), eq(activityLog.action, "transferred")))
      .all();
    expect(activity.map((a) => a.projectId).sort()).toEqual([game.id, engine.id].sort());
    const audit = t.db.select().from(auditLog).where(eq(auditLog.id, res.audit_id)).get()!;
    expect(audit).toMatchObject({
      projectId: game.id,
      action: "transfer",
      targetType: "task",
      reason: "engine work lives in rynx-engine",
    });
  });

  it("files the task under an epic of the TARGET project, and refuses an epic of any other", () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const engineEpic = createTestEpic(t.db, { projectId: engine.id });
    const gameEpic = createTestEpic(t.db, { projectId: game.id });
    const task = createTestTask(t.db, { projectId: game.id });
    expect(
      codeOf(() =>
        transferSvc.transfer("task", task.id, human(), {
          target_project_id: engine.id,
          target_epic_id: gameEpic.id,
          reason: "r",
        }),
      ),
    ).toBe("409 TARGET_EPIC");
    transferSvc.transfer("task", task.id, human(), {
      target_project_id: engine.id,
      target_epic_id: engineEpic.id,
      reason: "r",
    });
    expect(t.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.epicId).toBe(
      engineEpic.id,
    );
  });

  it.each(["queued", "integrating"])(
    "refuses while a merge request is %s (it lands in the old lane)",
    (status) => {
      const game = createTestProject(t.db);
      const engine = createTestProject(t.db);
      const task = createTestTask(t.db, { projectId: game.id });
      request(game.id, task.id, status);
      expect(
        codeOf(() =>
          transferSvc.transfer("task", task.id, human(), {
            target_project_id: engine.id,
            reason: "r",
          }),
        ),
      ).toBe("409 OPEN_MERGE_REQUEST");
      expect(t.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.projectId).toBe(game.id);
    },
  );

  it("refuses while a group the task belongs to is still forming", () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const task = createTestTask(t.db, { projectId: game.id });
    request(game.id, task.id, "landed", group(game.id, "forming"));
    expect(
      codeOf(() =>
        transferSvc.transfer("task", task.id, human(), {
          target_project_id: engine.id,
          reason: "r",
        }),
      ),
    ).toBe("409 OPEN_MERGE_REQUEST");
  });

  it("a task whose merge requests all ended moves (history stays with the old lane)", () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const task = createTestTask(t.db, { projectId: game.id });
    request(game.id, task.id, "landed");
    request(game.id, task.id, "rejected", group(game.id, "rejected"));
    transferSvc.transfer("task", task.id, human(), { target_project_id: engine.id, reason: "r" });
    expect(t.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.projectId).toBe(engine.id);
  });

  it("refuses while it holds a merge lock or has an open merge incident", () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const a = createTestTask(t.db, { projectId: game.id });
    t.db
      .insert(mergeLocks)
      .values({
        id: createId(),
        projectId: game.id,
        resource: "main",
        holderId: t.testUser.id,
        taskId: a.id,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    expect(
      codeOf(() =>
        transferSvc.transfer("task", a.id, human(), { target_project_id: engine.id, reason: "r" }),
      ),
    ).toBe("409 MERGE_LOCK");
    const b = createTestTask(t.db, { projectId: game.id });
    t.db
      .insert(mergeIncidents)
      .values({
        id: createId(),
        projectId: game.id,
        type: "orphaned_inner",
        innerRepo: "rynx",
        orphanedSha: "abc",
        outerRepo: "game_one",
        taskId: b.id,
        state: "open",
        openedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    expect(
      codeOf(() =>
        transferSvc.transfer("task", b.id, human(), { target_project_id: engine.id, reason: "r" }),
      ),
    ).toBe("409 OPEN_INCIDENT");
  });

  it("refuses to split a parent from its subtasks, either way", () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const parent = createTestTask(t.db, { projectId: game.id });
    const child = createTestTask(t.db, { projectId: game.id, parentTaskId: parent.id });
    expect(
      codeOf(() =>
        transferSvc.transfer("task", parent.id, human(), {
          target_project_id: engine.id,
          reason: "r",
        }),
      ),
    ).toBe("409 SUBTASK_SPLIT");
    expect(
      codeOf(() =>
        transferSvc.transfer("task", child.id, human(), {
          target_project_id: engine.id,
          reason: "r",
        }),
      ),
    ).toBe("409 SUBTASK_SPLIT");
  });

  it("authz: an agent may move only what it holds; a human may move anything", () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const holder = createTestAiAgent(t.db);
    const stranger = createTestAiAgent(t.db);
    const task = createTestTask(t.db, { projectId: game.id, assigneeId: holder.user.id });
    expect(
      codeOf(() =>
        transferSvc.transfer(
          "task",
          task.id,
          { id: stranger.user.id, type: "ai_agent" },
          { target_project_id: engine.id, reason: "r" },
        ),
      ),
    ).toBe("403 FORBIDDEN");
    const unclaimed = createTestTask(t.db, { projectId: game.id });
    expect(
      codeOf(() =>
        transferSvc.transfer(
          "task",
          unclaimed.id,
          { id: holder.user.id, type: "ai_agent" },
          { target_project_id: engine.id, reason: "r" },
        ),
      ),
    ).toBe("403 FORBIDDEN");
    transferSvc.transfer("task", unclaimed.id, human(), {
      target_project_id: engine.id,
      reason: "r",
    });
  });

  it("refuses another workspace, an archived target, the same project, an empty reason", () => {
    const game = createTestProject(t.db);
    const wsId = createId();
    t.db
      .insert(workspaces)
      .values({ id: wsId, name: "elsewhere", createdAt: NOW, updatedAt: NOW })
      .run();
    const foreign = createTestProject(t.db, { workspaceId: wsId });
    const archived = createTestProject(t.db, { status: "archived" });
    const task = createTestTask(t.db, { projectId: game.id });
    const go = (to: string, reason = "r") =>
      codeOf(() =>
        transferSvc.transfer("task", task.id, human(), { target_project_id: to, reason }),
      );
    expect(go(foreign.id)).toBe("409 CROSS_WORKSPACE");
    expect(go(archived.id)).toBe("409 TARGET_ARCHIVED");
    expect(go(game.id)).toBe("409 SAME_PROJECT");
    expect(go(createId())).toBe("404 NOT_FOUND");
    expect(go(archived.id, "   ")).toBe("400 VALIDATION_ERROR");
  });
});

describe("transfer: an epic", () => {
  it("moves the epic with ALL its tasks atomically; its milestone is cleared", () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const milestone = createId();
    t.db
      .insert(milestones)
      .values({ id: milestone, projectId: game.id, name: "m", createdAt: NOW, updatedAt: NOW })
      .run();
    const epic = createTestEpic(t.db, { projectId: game.id, milestoneId: milestone });
    const a = createTestTask(t.db, { projectId: game.id, epicId: epic.id });
    const b = createTestTask(t.db, { projectId: game.id, epicId: epic.id, parentTaskId: a.id });
    const res = transferSvc.transfer("epic", epic.id, human(), {
      target_project_id: engine.id,
      reason: "r",
    });
    expect(res.moved_task_ids.sort()).toEqual([a.id, b.id].sort());
    expect(res.dropped_milestone_id).toBe(milestone);
    const e = t.db.select().from(epics).where(eq(epics.id, epic.id)).get()!;
    expect([e.projectId, e.milestoneId]).toEqual([engine.id, null]);
    for (const id of [a.id, b.id]) {
      const row = t.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
      expect([row.projectId, row.epicId]).toEqual([engine.id, epic.id]);
    }
  });

  it("one task with in-flight merge work refuses the WHOLE epic: nothing moves", () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const epic = createTestEpic(t.db, { projectId: game.id });
    const a = createTestTask(t.db, { projectId: game.id, epicId: epic.id });
    const b = createTestTask(t.db, { projectId: game.id, epicId: epic.id });
    request(game.id, b.id, "queued");
    expect(
      codeOf(() =>
        transferSvc.transfer("epic", epic.id, human(), {
          target_project_id: engine.id,
          reason: "r",
        }),
      ),
    ).toBe("409 OPEN_MERGE_REQUEST");
    expect(t.db.select().from(epics).where(eq(epics.id, epic.id)).get()!.projectId).toBe(game.id);
    expect(t.db.select().from(tasks).where(eq(tasks.id, a.id)).get()!.projectId).toBe(game.id);
  });

  it.each(["depends on", "is depended on by"])(
    "an epic that %s a staying epic is refused (epic links never cross projects)",
    (dir) => {
      const game = createTestProject(t.db);
      const engine = createTestProject(t.db);
      const moving = createTestEpic(t.db, { projectId: game.id });
      const staying = createTestEpic(t.db, { projectId: game.id });
      const [epicId, dependsOnEpicId] =
        dir === "depends on" ? [moving.id, staying.id] : [staying.id, moving.id];
      t.db
        .insert(epicDependencies)
        .values({
          id: createId(),
          projectId: game.id,
          epicId,
          dependsOnEpicId,
          dependencyType: "blocks",
          createdAt: NOW,
        })
        .run();
      expect(
        codeOf(() =>
          transferSvc.transfer("epic", moving.id, human(), {
            target_project_id: engine.id,
            reason: "r",
          }),
        ),
      ).toBe("409 CROSS_PROJECT");
    },
  );

  it("an epic with a task whose subtask lives in another epic is refused", () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const epic = createTestEpic(t.db, { projectId: game.id });
    const a = createTestTask(t.db, { projectId: game.id, epicId: epic.id });
    createTestTask(t.db, { projectId: game.id, parentTaskId: a.id });
    expect(
      codeOf(() =>
        transferSvc.transfer("epic", epic.id, human(), {
          target_project_id: engine.id,
          reason: "r",
        }),
      ),
    ).toBe("409 SUBTASK_SPLIT");
  });
});

describe("transfer: a proposal", () => {
  it("moves the proposal; its comments follow; target_epic_id is refused", () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const p = createTestProposal(t.db, { projectId: game.id });
    t.db
      .insert(comments)
      .values({
        id: createId(),
        proposalId: p.id,
        authorId: t.testUser.id,
        body: "design",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    expect(
      codeOf(() =>
        transferSvc.transfer("proposal", p.id, human(), {
          target_project_id: engine.id,
          target_epic_id: "x",
          reason: "r",
        }),
      ),
    ).toBe("400 VALIDATION_ERROR");
    const res = transferSvc.transfer("proposal", p.id, human(), {
      target_project_id: engine.id,
      reason: "r",
    });
    expect(res.moved_task_ids).toEqual([]);
    expect(t.db.select().from(proposals).where(eq(proposals.id, p.id)).get()!.projectId).toBe(
      engine.id,
    );
    expect(t.db.select().from(comments).where(eq(comments.proposalId, p.id)).all()).toHaveLength(1);
  });
});

describe("cross-project task dependencies are a contract", () => {
  it("a game task may be blocked by a task of another project", () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const gameTask = createTestTask(t.db, { projectId: game.id });
    const engineTask = createTestTask(t.db, { projectId: engine.id });
    depSvc.addDependency(gameTask.id, engineTask.id, "blocks");
    expect(
      t.db.select().from(taskDependencies).where(eq(taskDependencies.taskId, gameTask.id)).all(),
    ).toHaveLength(1);
  });
});

describe("POST /api/v1/{kind}/{id}/transfer", () => {
  it("transfers through the route and refuses an empty reason", async () => {
    const game = createTestProject(t.db);
    const engine = createTestProject(t.db);
    const task = createTestTask(t.db, { projectId: game.id });
    const bad = await authRequest(t.app, "POST", `/api/v1/tasks/${task.id}/transfer`, {
      token: t.testToken,
      body: { target_project_id: engine.id, reason: "" },
    });
    expect(bad.status).toBe(400);
    const res = await authRequest(t.app, "POST", `/api/v1/tasks/${task.id}/transfer`, {
      token: t.testToken,
      body: { target_project_id: engine.id, reason: "engine work" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { to_project_id: string } };
    expect(body.data.to_project_id).toBe(engine.id);
    const epic = createTestEpic(t.db, { projectId: game.id });
    const viaEpics = await authRequest(t.app, "POST", `/api/v1/epics/${epic.id}/transfer`, {
      token: t.testToken,
      body: { target_project_id: engine.id, reason: "r" },
    });
    expect(viaEpics.status).toBe(200);
  });
});
