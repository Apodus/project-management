import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { createId } from "@pm/shared";
import {
  authRequest,
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  createTestUser,
  type TestApp,
  type TestProject,
} from "../utils.js";
import { users } from "../../src/db/index.js";
import * as requestSvc from "../../src/services/merge-request.service.js";

// ── Helpers ───────────────────────────────────────────────────────

/** A member (non-admin) human user with a known API token. */
function createMemberToken(testApp: TestApp): string {
  const ts = new Date().toISOString();
  const id = createId();
  const token = `member-token-${id}`;
  testApp.db
    .insert(users)
    .values({
      id,
      username: `member-${id.slice(-6)}`,
      displayName: "Member",
      role: "member",
      type: "human",
      apiTokenHash: bcrypt.hashSync(token, 10),
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return token;
}

/** Seed an `integrating` request and force-land it via the route — which
 * writes a `force_land` audit row — returning the request id. */
async function forceLandOne(
  testApp: TestApp,
  project: TestProject,
  reason: string,
): Promise<string> {
  const submitter = createTestUser(testApp.db);
  const taskId = createTestTask(testApp.db, { projectId: project.id }).id;
  const r = requestSvc.submit({
    projectId: project.id,
    submittedBy: submitter.id,
    taskId,
    branch: "feat/x",
  });
  const agent = createTestAiAgent(testApp.db);
  requestSvc.transitionToIntegrating(r.id, {
    id: agent.user.id,
    role: agent.user.role,
    type: agent.user.type,
  });
  const res = await authRequest(
    testApp.app,
    "POST",
    `/api/v1/merge-requests/${r.id}/force-land`,
    { body: { landedSha: "ff00ba5", reason } },
  );
  expect(res.status).toBe(200);
  return r.id;
}

describe("Audit-log route", () => {
  let testApp: TestApp;
  let memberToken: string;

  beforeEach(() => {
    testApp = createTestApp();
    memberToken = createMemberToken(testApp);
  });

  afterEach(() => {
    testApp.cleanup();
  });

  describe("GET /api/v1/projects/{projectId}/audit-log", () => {
    it("admin → 200 with { data, pagination }", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/audit-log`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toMatchObject({
        total: expect.any(Number),
        page: expect.any(Number),
        perPage: expect.any(Number),
      });
    });

    it("non-admin (member) → 403", async () => {
      const project = createTestProject(testApp.db);
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/audit-log`,
        { token: memberToken },
      );
      expect(res.status).toBe(403);
    });

    it("unauthenticated → 401", async () => {
      const project = createTestProject(testApp.db);
      const res = await testApp.app.request(
        `/api/v1/projects/${project.id}/audit-log`,
      );
      expect(res.status).toBe(401);
    });

    it("returns the force_land audit row after a force-land", async () => {
      const project = createTestProject(testApp.db);
      await forceLandOne(testApp, project, "hotfix for prod outage");

      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/audit-log`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      const actions = body.data.map((r: { action: string }) => r.action);
      expect(actions).toContain("force_land");
      const row = body.data.find(
        (r: { action: string }) => r.action === "force_land",
      );
      expect(row.targetType).toBe("merge_request");
      expect(row.reason).toBe("hotfix for prod outage");
      expect(row.metadataAfter).toMatchObject({
        status: "landed",
        overridden: true,
      });
    });

    it("filters by action", async () => {
      const project = createTestProject(testApp.db);
      await forceLandOne(testApp, project, "r1");
      await forceLandOne(testApp, project, "r2");

      // force_land rows present...
      const landed = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/audit-log?action=force_land`,
      );
      const landedBody = await landed.json();
      expect(landedBody.data.length).toBe(2);
      expect(
        landedBody.data.every(
          (r: { action: string }) => r.action === "force_land",
        ),
      ).toBe(true);

      // ...and a filter for an action with no rows returns empty.
      const paused = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/audit-log?action=pause`,
      );
      const pausedBody = await paused.json();
      expect(pausedBody.data.length).toBe(0);
      expect(pausedBody.pagination.total).toBe(0);
    });

    it("filters by targetType", async () => {
      const project = createTestProject(testApp.db);
      await forceLandOne(testApp, project, "r1");
      // Pause writes a `train`-target audit row.
      await authRequest(
        testApp.app,
        "POST",
        `/api/v1/projects/${project.id}/train/pause`,
        { body: { reason: "drain" } },
      );

      const mrOnly = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/audit-log?targetType=merge_request`,
      );
      const mrBody = await mrOnly.json();
      expect(mrBody.data.length).toBe(1);
      expect(mrBody.data[0].targetType).toBe("merge_request");

      const trainOnly = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/audit-log?targetType=train`,
      );
      const trainBody = await trainOnly.json();
      expect(trainBody.data.length).toBe(1);
      expect(trainBody.data[0].action).toBe("pause");
    });

    it("filters by userId (actor) and a from/to window", async () => {
      const project = createTestProject(testApp.db);
      await forceLandOne(testApp, project, "r1");

      // The default admin user (test-admin) is the force-land actor.
      const all = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/audit-log`,
      );
      const allBody = await all.json();
      const actorId = allBody.data[0].actorId as string;

      const byActor = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/audit-log?userId=${actorId}`,
      );
      const byActorBody = await byActor.json();
      expect(byActorBody.data.length).toBe(1);

      const byOther = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/audit-log?userId=${createId()}`,
      );
      expect((await byOther.json()).data.length).toBe(0);

      // A future-only window excludes the just-written row.
      const future = "2999-01-01T00:00:00.000Z";
      const windowed = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${project.id}/audit-log?from=${future}`,
      );
      expect((await windowed.json()).data.length).toBe(0);
    });

    it("404 for an unknown project", async () => {
      const res = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/projects/${createId()}/audit-log`,
      );
      expect(res.status).toBe(404);
    });
  });
});
