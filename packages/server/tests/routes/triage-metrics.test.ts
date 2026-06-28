import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createId } from "@pm/shared";
import {
  authRequest,
  createTestApp,
  createTestProject,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { notes, triageDecisions } from "../../src/db/index.js";

function seedNote(testApp: TestApp, projectId: string, authorId: string): string {
  const id = createId();
  const ts = new Date().toISOString();
  testApp.db
    .insert(notes)
    .values({
      id,
      projectId,
      kind: "bug",
      status: "open",
      title: "n",
      body: null,
      anchorType: null,
      anchorId: null,
      codeLocator: null,
      severity: null,
      authorId,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return id;
}

function seedDecision(
  testApp: TestApp,
  args: {
    projectId: string;
    noteId: string;
    actorId: string;
    mode: string;
    decision: string;
    createdAt?: string;
  },
): void {
  testApp.db
    .insert(triageDecisions)
    .values({
      id: createId(),
      projectId: args.projectId,
      noteId: args.noteId,
      mode: args.mode,
      decision: args.decision,
      rationale: null,
      confidence: null,
      resultingProposalId: null,
      resultingTaskId: null,
      actorId: args.actorId,
      createdAt: args.createdAt ?? new Date().toISOString(),
    })
    .run();
}

describe("Triage metrics route", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  it("GET /triage-decisions/metrics returns a snake_case {data} envelope (200)", async () => {
    const project = createTestProject(testApp.db);
    const actor = createTestUser(testApp.db);
    const note = seedNote(testApp, project.id, actor.id);
    seedDecision(testApp, {
      projectId: project.id,
      noteId: note,
      actorId: actor.id,
      mode: "shadow",
      decision: "dismiss",
    });
    seedDecision(testApp, {
      projectId: project.id,
      noteId: note,
      actorId: actor.id,
      mode: "on",
      decision: "promote_standard",
    });

    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/triage-decisions/metrics`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, any> };
    expect(body.data).toHaveProperty("decision_mix");
    expect(body.data).toHaveProperty("lane_counts");
    expect(body.data).toHaveProperty("latency");
    expect(body.data).toHaveProperty("heartbeat");
    expect(body.data).toHaveProperty("scope");
    expect(body.data.decision_mix.shadow.dismiss).toBe(1);
    expect(body.data.decision_mix.on.promote_standard).toBe(1);
    expect(body.data.decision_mix.total).toBe(2);
    expect(body.data.lane_counts.open).toBe(1);
    expect(body.data.scope.filtered).toBe(false);
    expect(body.data.window_since).toBeNull();
  });

  it("honors the since query param (windows out older rows)", async () => {
    const project = createTestProject(testApp.db);
    const actor = createTestUser(testApp.db);
    const note = seedNote(testApp, project.id, actor.id);
    const old = new Date(Date.now() - 5 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    seedDecision(testApp, {
      projectId: project.id,
      noteId: note,
      actorId: actor.id,
      mode: "shadow",
      decision: "dismiss",
      createdAt: old,
    });
    seedDecision(testApp, {
      projectId: project.id,
      noteId: note,
      actorId: actor.id,
      mode: "on",
      decision: "give_up",
      createdAt: recent,
    });

    const since = new Date(Date.now() - 3600_000).toISOString();
    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${project.id}/triage-decisions/metrics?since=${encodeURIComponent(since)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, any> };
    expect(body.data.total).toBe(1);
    expect(body.data.decision_mix.on.give_up).toBe(1);
    expect(body.data.decision_mix.shadow.dismiss).toBe(0);
    expect(body.data.window_since).toBe(since);
  });

  it("404s on an unknown project", async () => {
    const res = await authRequest(
      testApp.app,
      "GET",
      `/api/v1/projects/${createId()}/triage-decisions/metrics`,
    );
    expect(res.status).toBe(404);
  });

  it("401s without authentication", async () => {
    const project = createTestProject(testApp.db);
    const res = await testApp.app.request(
      `/api/v1/projects/${project.id}/triage-decisions/metrics`,
      { method: "GET" },
    );
    expect(res.status).toBe(401);
  });
});
