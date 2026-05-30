import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestAiAgent,
  createTestApp,
  createTestProject,
  createTestTask,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { comments } from "../../src/db/index.js";
import * as svc from "../../src/services/merge-incident.service.js";
import * as mrSvc from "../../src/services/merge-request.service.js";
import * as groupSvc from "../../src/services/merge-group.service.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";

const HUMAN = (id: string, role = "member") => ({ id, role, type: "human" });
const AGENT = (id: string) => ({ id, role: "member", type: "ai_agent" });

function baseParams(
  projectId: string,
  overrides: Partial<{
    groupId: string | null;
    innerRepo: string;
    orphanedSha: string;
    outerRepo: string;
    innerRequestId: string | null;
    taskId: string | null;
  }> = {},
) {
  return {
    projectId,
    type: "orphaned_inner" as const,
    groupId: overrides.groupId ?? null,
    innerRepo: overrides.innerRepo ?? "inner-repo",
    orphanedSha: overrides.orphanedSha ?? "Ri000",
    outerRepo: overrides.outerRepo ?? "outer-repo",
    innerRequestId:
      overrides.innerRequestId === undefined ? null : overrides.innerRequestId,
    taskId: overrides.taskId === undefined ? null : overrides.taskId,
  };
}

describe("merge-incident service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  /** Create a real merge group (id usable as a FK-valid groupId). */
  function makeGroup(project: { id: string }, submitter: { id: string }) {
    const m1 = mrSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
    });
    const m2 = mrSvc.submit({
      projectId: project.id,
      submittedBy: submitter.id,
    });
    const g = groupSvc.createGroup(
      {
        projectId: project.id,
        submittedBy: submitter.id,
        memberRequestIds: [m1.id, m2.id],
      },
      HUMAN(submitter.id),
    );
    return { groupId: g.id, innerRequestId: m1.id };
  }

  // ─── openIncident ─────────────────────────────────────────────────
  describe("openIncident", () => {
    it("inserts an open incident row with all columns set", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const { groupId, innerRequestId } = makeGroup(project, submitter);

      const out = svc.openIncident(
        baseParams(project.id, {
          groupId,
          innerRepo: "core",
          orphanedSha: "Ri42",
          outerRepo: "shell",
          innerRequestId,
        }),
        AGENT(integrator.user.id),
      );

      expect(out.state).toBe("open");
      expect(out.type).toBe("orphaned_inner");
      expect(out.groupId).toBe(groupId);
      expect(out.innerRepo).toBe("core");
      expect(out.orphanedSha).toBe("Ri42");
      expect(out.outerRepo).toBe("shell");
      expect(out.innerRequestId).toBe(innerRequestId);
      expect(out.taskId).toBeNull();
      expect(out.resolvedAt).toBeNull();
      expect(out.resolution).toBeNull();
      expect(out.openedAt).toBeTruthy();
    });

    it("posts a merge_incident comment on taskId (same txn) with metadata", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id });
      const { groupId, innerRequestId } = makeGroup(project, submitter);

      const out = svc.openIncident(
        baseParams(project.id, {
          groupId,
          innerRepo: "core",
          orphanedSha: "RiAA",
          outerRepo: "shell",
          innerRequestId,
          taskId: task.id,
        }),
        AGENT(integrator.user.id),
      );

      const rows = testApp.db
        .select()
        .from(comments)
        .where(eq(comments.taskId, task.id))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0].commentType).toBe("merge_incident");
      expect(rows[0].body).toContain("Orphaned inner: core@RiAA");
      expect(rows[0].body).toContain("shell gitlink was not updated");
      const meta = rows[0].metadata as Record<string, unknown>;
      expect(meta.incidentId).toBe(out.id);
      expect(meta.groupId).toBe(groupId);
      expect(meta.innerRepo).toBe("core");
      expect(meta.orphanedSha).toBe("RiAA");
      expect(meta.outerRepo).toBe("shell");
      expect(meta.innerRequestId).toBe(innerRequestId);
    });

    it("emits MERGE_INCIDENT_OPENED exactly once", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_INCIDENT_OPENED, listener);

      const out = svc.openIncident(
        baseParams(project.id),
        AGENT(integrator.user.id),
      );

      expect(listener).toHaveBeenCalledTimes(1);
      const payload = listener.mock.calls[0][0];
      expect(payload.entityType).toBe("merge_incident");
      expect(payload.entity.incidentId).toBe(out.id);
      expect(payload.entity.orphanedSha).toBe("Ri000");
    });

    it("creates the row + emits but posts NO comment when taskId is null", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_INCIDENT_OPENED, listener);

      const out = svc.openIncident(
        baseParams(project.id, { taskId: null }),
        AGENT(integrator.user.id),
      );

      expect(out.state).toBe("open");
      expect(listener).toHaveBeenCalledTimes(1);
      const all = testApp.db.select().from(comments).all();
      expect(all.filter((c) => c.commentType === "merge_incident")).toHaveLength(
        0,
      );
    });

    it("non-ai_agent → 403 FORBIDDEN", () => {
      const project = createTestProject(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      expect(() =>
        svc.openIncident(baseParams(project.id), HUMAN(admin.id, "admin")),
      ).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });

    it("missing project → 404 NOT_FOUND", () => {
      const integrator = createTestAiAgent(testApp.db);
      expect(() =>
        svc.openIncident(
          baseParams("01PROJECTMISSING000000000000"),
          AGENT(integrator.user.id),
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }),
      );
    });

    it("emit-after-commit: listener reads the persisted open incident", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      let observedState: string | undefined;
      getEventBus().on(EVENT_NAMES.MERGE_INCIDENT_OPENED, (p) => {
        observedState = svc.getById(p.entity.incidentId as string).state;
      });
      svc.openIncident(baseParams(project.id), AGENT(integrator.user.id));
      expect(observedState).toBe("open");
    });
  });

  // ─── getById ──────────────────────────────────────────────────────
  describe("getById", () => {
    it("returns the view incl resolution null while open; 404 for missing", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const out = svc.openIncident(
        baseParams(project.id),
        AGENT(integrator.user.id),
      );
      const got = svc.getById(out.id);
      expect(got.id).toBe(out.id);
      expect(got.state).toBe("open");
      expect(got.resolution).toBeNull();
      expect(() => svc.getById("01MISSING000000000000000000")).toThrowError(
        expect.objectContaining({ statusCode: 404 }),
      );
    });
  });

  // ─── list ─────────────────────────────────────────────────────────
  describe("list", () => {
    it("recovery query: state=open + type=orphaned_inner, oldest first", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);

      const i1 = svc.openIncident(
        baseParams(project.id),
        AGENT(integrator.user.id),
      );
      const i2 = svc.openIncident(
        baseParams(project.id),
        AGENT(integrator.user.id),
      );
      // Resolve i1 so it drops out of the open filter.
      svc.resolve(
        i1.id,
        { mode: "auto_rollforward", outerLandedSha: "O1" },
        AGENT(integrator.user.id),
      );

      const open = svc.list(project.id, {
        state: "open",
        type: "orphaned_inner",
      });
      expect(open.map((i) => i.id)).toEqual([i2.id]);
    });

    it("orders >=2 open incidents by openedAt asc", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(
          svc.openIncident(baseParams(project.id), AGENT(integrator.user.id))
            .id,
        );
      }
      const open = svc.list(project.id, { state: "open" });
      const got = open.map((i) => i.id);
      // openedAt asc; insertion order is non-decreasing in openedAt.
      const byOpened = [...open].sort((a, b) =>
        a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0,
      );
      expect(got).toEqual(byOpened.map((i) => i.id));
      expect(got.length).toBe(3);
      expect(new Set(got)).toEqual(new Set(ids));
    });

    it("filters by groupId", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const gA = makeGroup(project, submitter).groupId;
      const gB = makeGroup(project, submitter).groupId;
      const a = svc.openIncident(
        baseParams(project.id, { groupId: gA }),
        AGENT(integrator.user.id),
      );
      svc.openIncident(
        baseParams(project.id, { groupId: gB }),
        AGENT(integrator.user.id),
      );
      const got = svc.list(project.id, { groupId: gA });
      expect(got.map((i) => i.id)).toEqual([a.id]);
    });

    it("filters by state=auto_resolved", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const a = svc.openIncident(
        baseParams(project.id),
        AGENT(integrator.user.id),
      );
      svc.openIncident(baseParams(project.id), AGENT(integrator.user.id));
      svc.resolve(
        a.id,
        { mode: "auto_rollforward", outerLandedSha: "O" },
        AGENT(integrator.user.id),
      );
      const got = svc.list(project.id, { state: "auto_resolved" });
      expect(got.map((i) => i.id)).toEqual([a.id]);
    });

    it("404 for missing project", () => {
      expect(() =>
        svc.list("01PROJECTMISSING000000000000"),
      ).toThrowError(expect.objectContaining({ statusCode: 404 }));
    });
  });

  // ─── resolve (auto) ───────────────────────────────────────────────
  describe("resolve auto_rollforward", () => {
    it("open → auto_resolved; resolution recorded; emits AUTO_RESOLVED; ai_agent allowed", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const groupId = makeGroup(project, submitter).groupId;
      const inc = svc.openIncident(
        baseParams(project.id, { groupId }),
        AGENT(integrator.user.id),
      );
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_INCIDENT_AUTO_RESOLVED, listener);

      const out = svc.resolve(
        inc.id,
        {
          mode: "auto_rollforward",
          outerLandedSha: "Outer99",
          resolvedByGroupId: "g2",
        },
        AGENT(integrator.user.id),
      );

      expect(out.state).toBe("auto_resolved");
      expect(out.resolvedAt).toBeTruthy();
      expect(out.resolution).toEqual({
        mode: "auto_rollforward",
        outerLandedSha: "Outer99",
        resolvedByGroupId: "g2",
      });
      expect(listener).toHaveBeenCalledTimes(1);
      const p = listener.mock.calls[0][0];
      expect(p.entity.outerLandedSha).toBe("Outer99");
      expect(p.entity.resolvedByGroupId).toBe("g2");
    });

    it("emit-after-commit: listener reads the persisted auto_resolved state", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const inc = svc.openIncident(
        baseParams(project.id),
        AGENT(integrator.user.id),
      );
      let observed: string | undefined;
      getEventBus().on(EVENT_NAMES.MERGE_INCIDENT_AUTO_RESOLVED, () => {
        observed = svc.getById(inc.id).state;
      });
      svc.resolve(
        inc.id,
        { mode: "auto_rollforward", outerLandedSha: "O" },
        AGENT(integrator.user.id),
      );
      expect(observed).toBe("auto_resolved");
    });
  });

  // ─── resolve (human) ──────────────────────────────────────────────
  describe("resolve human", () => {
    it("open → human_resolved; resolution recorded; emits HUMAN_RESOLVED; admin allowed", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      const groupId = makeGroup(project, submitter).groupId;
      const inc = svc.openIncident(
        baseParams(project.id, { groupId }),
        AGENT(integrator.user.id),
      );
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_INCIDENT_HUMAN_RESOLVED, listener);

      const out = svc.resolve(
        inc.id,
        { mode: "human", note: "manually bumped the submodule" },
        HUMAN(admin.id, "admin"),
      );

      expect(out.state).toBe("human_resolved");
      expect(out.resolution).toEqual({
        mode: "human",
        note: "manually bumped the submodule",
      });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].entity.note).toBe(
        "manually bumped the submodule",
      );
    });
  });

  // ─── illegal / idempotent ─────────────────────────────────────────
  describe("transitions: idempotency + cross-terminal", () => {
    it("second resolve(auto) on auto_resolved → idempotent noop, no 2nd event", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const inc = svc.openIncident(
        baseParams(project.id),
        AGENT(integrator.user.id),
      );
      svc.resolve(
        inc.id,
        { mode: "auto_rollforward", outerLandedSha: "O" },
        AGENT(integrator.user.id),
      );
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_INCIDENT_AUTO_RESOLVED, listener);
      const out = svc.resolve(
        inc.id,
        { mode: "auto_rollforward", outerLandedSha: "O2" },
        AGENT(integrator.user.id),
      );
      expect(out.state).toBe("auto_resolved");
      // Idempotent — original resolution preserved, no new event.
      expect(out.resolution?.outerLandedSha).toBe("O");
      expect(listener).not.toHaveBeenCalled();
    });

    it("resolve(human) on auto_resolved → 409 INVALID_TRANSITION (cross-terminal)", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      const inc = svc.openIncident(
        baseParams(project.id),
        AGENT(integrator.user.id),
      );
      svc.resolve(
        inc.id,
        { mode: "auto_rollforward", outerLandedSha: "O" },
        AGENT(integrator.user.id),
      );
      expect(() =>
        svc.resolve(inc.id, { mode: "human", note: "x" }, HUMAN(admin.id, "admin")),
      ).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });
  });

  // ─── authz split ──────────────────────────────────────────────────
  describe("resolve authz split (auto=ai_agent, human=admin)", () => {
    it("human admin CANNOT auto-resolve → 403", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      const inc = svc.openIncident(
        baseParams(project.id),
        AGENT(integrator.user.id),
      );
      expect(() =>
        svc.resolve(
          inc.id,
          { mode: "auto_rollforward", outerLandedSha: "O" },
          HUMAN(admin.id, "admin"),
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });

    it("ai_agent CANNOT human-resolve → 403", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const inc = svc.openIncident(
        baseParams(project.id),
        AGENT(integrator.user.id),
      );
      expect(() =>
        svc.resolve(
          inc.id,
          { mode: "human", note: "x" },
          AGENT(integrator.user.id),
        ),
      ).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });

    it("plain member CANNOT human-resolve → 403", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const member = createTestUser(testApp.db, { role: "member" });
      const inc = svc.openIncident(
        baseParams(project.id),
        AGENT(integrator.user.id),
      );
      expect(() =>
        svc.resolve(inc.id, { mode: "human", note: "x" }, HUMAN(member.id)),
      ).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });
  });
});
