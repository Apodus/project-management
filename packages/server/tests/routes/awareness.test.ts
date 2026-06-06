import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  type TestApp,
} from "../utils.js";
import { createId } from "@pm/shared";
import { labels, taskLabels } from "../../src/db/index.js";

describe("Awareness endpoint", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  function attachLabel(
    projectId: string,
    name: string,
    taskId: string,
  ): string {
    const existing = testApp.db
      .select()
      .from(labels)
      .where(and(eq(labels.projectId, projectId), eq(labels.name, name)))
      .get();
    const labelId = existing?.id ?? createId();
    if (!existing) {
      testApp.db
        .insert(labels)
        .values({
          id: labelId,
          projectId,
          name,
          color: null,
          description: null,
        })
        .run();
    }
    testApp.db.insert(taskLabels).values({ taskId, labelId }).run();
    return labelId;
  }

  it("returns empty when nothing is in flight", async () => {
    const project = createTestProject(testApp.db);
    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/awareness?label=renderer`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.label).toBe("renderer");
    expect(body.data.inFlight).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  it("returns only in_progress tasks (filters out backlog/ready/done)", async () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);

    const backlog = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: a.user.id,
      assigneeId: a.user.id,
      status: "backlog",
      title: "back",
    });
    const inProg = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: a.user.id,
      assigneeId: a.user.id,
      status: "in_progress",
      title: "in flight",
      gitBranch: "feat/skinning",
    });
    const done = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: a.user.id,
      assigneeId: a.user.id,
      status: "done",
      title: "finished",
    });
    attachLabel(project.id, "renderer", backlog.id);
    attachLabel(project.id, "renderer", inProg.id);
    attachLabel(project.id, "renderer", done.id);

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/awareness?label=renderer`,
    );
    const body = await res.json();
    expect(body.data.inFlight).toHaveLength(1);
    expect(body.data.inFlight[0].title).toBe("in flight");
  });

  it("surfaces assignee name + type + gitBranch on each in-flight task", async () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db, { displayName: "Alpha" });
    const task = createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: a.user.id,
      assigneeId: a.user.id,
      status: "in_progress",
      gitBranch: "feat/skinning",
    });
    attachLabel(project.id, "renderer", task.id);

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/awareness?label=renderer`,
    );
    const body = await res.json();
    const entry = body.data.inFlight[0];
    expect(entry.assignee.id).toBe(a.user.id);
    expect(entry.assignee.name).toBe("Alpha");
    expect(entry.assignee.type).toBe("ai_agent");
    expect(entry.gitBranch).toBe("feat/skinning");
    // C3.P1: awareness is caller-agnostic — a held in-flight task reads "live"
    // (never "yours"); the lease is absent so fail-safe-to-live applies.
    expect(entry.claimState).toBe("live");
  });

  it("does not leak labels from other projects with the same name", async () => {
    const project1 = createTestProject(testApp.db);
    const project2 = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);

    const t1 = createTestTask(testApp.db, {
      projectId: project1.id,
      reporterId: a.user.id,
      assigneeId: a.user.id,
      status: "in_progress",
      title: "p1 task",
    });
    const t2 = createTestTask(testApp.db, {
      projectId: project2.id,
      reporterId: a.user.id,
      assigneeId: a.user.id,
      status: "in_progress",
      title: "p2 task",
    });
    attachLabel(project1.id, "renderer", t1.id);
    attachLabel(project2.id, "renderer", t2.id);

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project1.id}/awareness?label=renderer`,
    );
    const body = await res.json();
    expect(body.data.inFlight).toHaveLength(1);
    expect(body.data.inFlight[0].title).toBe("p1 task");
  });

  it("returns all in-flight tasks when no label is supplied", async () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: a.user.id,
      assigneeId: a.user.id,
      status: "in_progress",
      title: "one",
    });
    createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: a.user.id,
      assigneeId: a.user.id,
      status: "in_progress",
      title: "two",
    });

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/awareness`,
    );
    const body = await res.json();
    expect(body.data.label).toBeNull();
    expect(body.data.total).toBe(2);
  });

  it("returns empty when label name does not resolve in the project", async () => {
    const project = createTestProject(testApp.db);
    const a = createTestAiAgent(testApp.db);
    createTestTask(testApp.db, {
      projectId: project.id,
      reporterId: a.user.id,
      assigneeId: a.user.id,
      status: "in_progress",
    });

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/awareness?label=unknown-area`,
    );
    const body = await res.json();
    expect(body.data.inFlight).toEqual([]);
  });
});
