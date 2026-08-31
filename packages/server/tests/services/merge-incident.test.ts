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

/**
 * openIncident returns { incident, created } (the open is idempotent). Most
 * tests want the row; the dedup tests below read `created` directly.
 */
const openInc = (...args: Parameters<typeof svc.openIncident>) =>
  svc.openIncident(...args).incident;

function baseParams(
  projectId: string,
  overrides: Partial<{
    type: "orphaned_inner" | "dangling_gitlink";
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
    type: overrides.type ?? ("orphaned_inner" as const),
    groupId: overrides.groupId ?? null,
    innerRepo: overrides.innerRepo ?? "inner-repo",
    orphanedSha: overrides.orphanedSha ?? "Ri000",
    outerRepo: overrides.outerRepo ?? "outer-repo",
    innerRequestId: overrides.innerRequestId === undefined ? null : overrides.innerRequestId,
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

      const out = openInc(
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

      const out = openInc(
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

      const rows = testApp.db.select().from(comments).where(eq(comments.taskId, task.id)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].commentType).toBe("merge_incident");
      expect(rows[0].body).toContain("Orphaned inner: core@RiAA");
      expect(rows[0].body).toContain("shell's gitlink was not updated to it");
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

      const out = openInc(baseParams(project.id), AGENT(integrator.user.id));

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

      const out = openInc(baseParams(project.id, { taskId: null }), AGENT(integrator.user.id));

      expect(out.state).toBe("open");
      expect(listener).toHaveBeenCalledTimes(1);
      const all = testApp.db.select().from(comments).all();
      expect(all.filter((c) => c.commentType === "merge_incident")).toHaveLength(0);
    });

    it("non-ai_agent → 403 FORBIDDEN", () => {
      const project = createTestProject(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      expect(() => openInc(baseParams(project.id), HUMAN(admin.id, "admin"))).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });

    it("missing project → 404 NOT_FOUND", () => {
      const integrator = createTestAiAgent(testApp.db);
      expect(() =>
        openInc(baseParams("01PROJECTMISSING000000000000"), AGENT(integrator.user.id)),
      ).toThrowError(expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }));
    });

    it("emit-after-commit: listener reads the persisted open incident", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      let observedState: string | undefined;
      getEventBus().on(EVENT_NAMES.MERGE_INCIDENT_OPENED, (p) => {
        observedState = svc.getById(p.entity.incidentId as string).state;
      });
      openInc(baseParams(project.id), AGENT(integrator.user.id));
      expect(observedState).toBe("open");
    });
  });

  // ─── openIncident — idempotency (a blocked lane re-gates every pass) ─
  describe("openIncident dedup", () => {
    it("reuses the OPEN row: one row, created=false, one event, one comment", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id });
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_INCIDENT_OPENED, listener);
      const params = baseParams(project.id, {
        type: "dangling_gitlink",
        taskId: task.id,
      });

      const first = svc.openIncident(params, AGENT(integrator.user.id));
      const second = svc.openIncident(params, AGENT(integrator.user.id));

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.incident.id).toBe(first.incident.id);
      expect(svc.list(project.id)).toHaveLength(1);
      expect(listener).toHaveBeenCalledTimes(1);
      const rows = testApp.db.select().from(comments).where(eq(comments.taskId, task.id)).all();
      expect(rows.filter((c) => c.commentType === "merge_incident")).toHaveLength(1);
    });

    it("dedups two lane-scoped opens with groupId null (the shape a gate uses)", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const params = baseParams(project.id, { type: "dangling_gitlink", groupId: null });
      svc.openIncident(params, AGENT(integrator.user.id));
      svc.openIncident(params, AGENT(integrator.user.id));
      expect(svc.list(project.id, { state: "open" })).toHaveLength(1);
    });

    it("does NOT dedup across groupId — two groups orphaning one SHA stay two", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const gA = makeGroup(project, submitter).groupId;
      const gB = makeGroup(project, submitter).groupId;
      openInc(baseParams(project.id, { groupId: gA }), AGENT(integrator.user.id));
      openInc(baseParams(project.id, { groupId: gB }), AGENT(integrator.user.id));
      expect(svc.list(project.id, { state: "open" })).toHaveLength(2);
    });

    it("does NOT dedup across orphanedSha or across type", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      openInc(baseParams(project.id, { orphanedSha: "Ri1" }), AGENT(integrator.user.id));
      openInc(baseParams(project.id, { orphanedSha: "Ri2" }), AGENT(integrator.user.id));
      openInc(
        baseParams(project.id, { orphanedSha: "Ri1", type: "dangling_gitlink" }),
        AGENT(integrator.user.id),
      );
      expect(svc.list(project.id, { state: "open" })).toHaveLength(3);
    });

    it("dedup is OPEN-only: a recurrence after a cure opens a FRESH incident", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const params = baseParams(project.id, { type: "dangling_gitlink" });
      const first = svc.openIncident(params, AGENT(integrator.user.id));
      svc.resolve(first.incident.id, { mode: "auto_observed" }, AGENT(integrator.user.id));

      const again = svc.openIncident(params, AGENT(integrator.user.id));
      expect(again.created).toBe(true);
      expect(again.incident.id).not.toBe(first.incident.id);
      expect(svc.list(project.id)).toHaveLength(2);
    });

    it("a dangling_gitlink comment states the outer→inner direction, not the orphan one", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id });

      openInc(
        baseParams(project.id, {
          type: "dangling_gitlink",
          innerRepo: "core",
          orphanedSha: "D4NGL1",
          outerRepo: "shell",
          taskId: task.id,
        }),
        AGENT(integrator.user.id),
      );

      const rows = testApp.db.select().from(comments).where(eq(comments.taskId, task.id)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toContain("Dangling gitlink: shell main's gitlink points at D4NGL1");
      expect(rows[0].body).toContain("not on core main");
      expect(rows[0].body).toContain("A human must decide");
      expect(rows[0].body).not.toContain("Orphaned inner");
      expect(rows[0].body).not.toContain("auto-rollforward");
    });
  });

  // ─── getById ──────────────────────────────────────────────────────
  describe("getById", () => {
    it("returns the view incl resolution null while open; 404 for missing", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const out = openInc(baseParams(project.id), AGENT(integrator.user.id));
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

      // Distinct SHAs: identical params would be DEDUPED into one open row.
      const i1 = openInc(
        baseParams(project.id, { orphanedSha: "Ri001" }),
        AGENT(integrator.user.id),
      );
      const i2 = openInc(
        baseParams(project.id, { orphanedSha: "Ri002" }),
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
          openInc(baseParams(project.id, { orphanedSha: `Ri10${i}` }), AGENT(integrator.user.id))
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
      const a = openInc(baseParams(project.id, { groupId: gA }), AGENT(integrator.user.id));
      openInc(baseParams(project.id, { groupId: gB }), AGENT(integrator.user.id));
      const got = svc.list(project.id, { groupId: gA });
      expect(got.map((i) => i.id)).toEqual([a.id]);
    });

    it("filters by state=auto_resolved", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const a = openInc(
        baseParams(project.id, { orphanedSha: "Ri201" }),
        AGENT(integrator.user.id),
      );
      openInc(baseParams(project.id, { orphanedSha: "Ri202" }), AGENT(integrator.user.id));
      svc.resolve(
        a.id,
        { mode: "auto_rollforward", outerLandedSha: "O" },
        AGENT(integrator.user.id),
      );
      const got = svc.list(project.id, { state: "auto_resolved" });
      expect(got.map((i) => i.id)).toEqual([a.id]);
    });

    it("404 for missing project", () => {
      expect(() => svc.list("01PROJECTMISSING000000000000")).toThrowError(
        expect.objectContaining({ statusCode: 404 }),
      );
    });
  });

  // ─── resolve (auto) ───────────────────────────────────────────────
  describe("resolve auto_rollforward", () => {
    it("open → auto_resolved; resolution recorded; emits AUTO_RESOLVED; ai_agent allowed", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const groupId = makeGroup(project, submitter).groupId;
      const inc = openInc(baseParams(project.id, { groupId }), AGENT(integrator.user.id));
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
      const inc = openInc(baseParams(project.id), AGENT(integrator.user.id));
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

  // ─── resolve (auto_observed) ──────────────────────────────────────
  describe("resolve auto_observed", () => {
    /** A dangling-gitlink incident on a task, the shape the gate opens. */
    function openDangling(project: { id: string }, integrator: string, taskId: string | null) {
      return openInc(
        baseParams(project.id, {
          type: "dangling_gitlink",
          innerRepo: "core",
          orphanedSha: "D4NGL1",
          outerRepo: "shell",
          taskId,
        }),
        AGENT(integrator),
      );
    }

    it("terminates at auto_resolved, ai_agent allowed, note recorded, emits AUTO_RESOLVED", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const inc = openDangling(project, integrator.user.id, null);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_INCIDENT_AUTO_RESOLVED, listener);

      const out = svc.resolve(
        inc.id,
        { mode: "auto_observed", note: "gitlink target D4NGL1 is now an ancestor of core main" },
        AGENT(integrator.user.id),
      );

      expect(out.state).toBe("auto_resolved");
      expect(out.resolvedAt).toBeTruthy();
      expect(out.resolution).toEqual({
        mode: "auto_observed",
        note: "gitlink target D4NGL1 is now an ancestor of core main",
      });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("a human admin CANNOT auto_observed-resolve → 403 (same gate as rollforward)", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      const inc = openDangling(project, integrator.user.id, null);
      expect(() =>
        svc.resolve(inc.id, { mode: "auto_observed" }, HUMAN(admin.id, "admin")),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    });

    it("second auto_observed is an idempotent noop; a later human resolve still 409s", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      const inc = openDangling(project, integrator.user.id, null);
      svc.resolve(inc.id, { mode: "auto_observed", note: "first" }, AGENT(integrator.user.id));

      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_INCIDENT_AUTO_RESOLVED, listener);
      const out = svc.resolve(
        inc.id,
        { mode: "auto_observed", note: "second" },
        AGENT(integrator.user.id),
      );
      expect(out.resolution?.note).toBe("first");
      expect(listener).not.toHaveBeenCalled();

      expect(() =>
        svc.resolve(inc.id, { mode: "human", note: "x" }, HUMAN(admin.id, "admin")),
      ).toThrowError(expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }));
    });

    it("the resolve comment names the incident and does NOT claim a gitlink was moved", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id });
      const inc = openDangling(project, integrator.user.id, task.id);

      svc.resolve(inc.id, { mode: "auto_observed" }, AGENT(integrator.user.id));

      const bodies = testApp.db
        .select()
        .from(comments)
        .where(eq(comments.taskId, task.id))
        .all()
        .map((c) => c.body);
      const resolved = bodies.find((b) => b.startsWith("Incident resolved"));
      expect(resolved).toBeDefined();
      expect(resolved).toContain("Dangling gitlink");
      expect(resolved).toContain("core@D4NGL1");
      expect(resolved).toContain("the train observed the cure and applied none");
      expect(resolved).not.toContain("gitlink now at");
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
      const inc = openInc(baseParams(project.id, { groupId }), AGENT(integrator.user.id));
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
      expect(listener.mock.calls[0][0].entity.note).toBe("manually bumped the submodule");
    });
  });

  // ─── illegal / idempotent ─────────────────────────────────────────
  describe("transitions: idempotency + cross-terminal", () => {
    it("second resolve(auto) on auto_resolved → idempotent noop, no 2nd event", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const inc = openInc(baseParams(project.id), AGENT(integrator.user.id));
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
      const inc = openInc(baseParams(project.id), AGENT(integrator.user.id));
      svc.resolve(
        inc.id,
        { mode: "auto_rollforward", outerLandedSha: "O" },
        AGENT(integrator.user.id),
      );
      expect(() =>
        svc.resolve(inc.id, { mode: "human", note: "x" }, HUMAN(admin.id, "admin")),
      ).toThrowError(expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }));
    });
  });

  // ─── authz split ──────────────────────────────────────────────────
  describe("resolve authz split (auto=ai_agent, human=admin)", () => {
    it("human admin CANNOT auto-resolve → 403", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const admin = createTestUser(testApp.db, { role: "admin" });
      const inc = openInc(baseParams(project.id), AGENT(integrator.user.id));
      expect(() =>
        svc.resolve(
          inc.id,
          { mode: "auto_rollforward", outerLandedSha: "O" },
          HUMAN(admin.id, "admin"),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    });

    it("ai_agent CANNOT human-resolve → 403", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const inc = openInc(baseParams(project.id), AGENT(integrator.user.id));
      expect(() =>
        svc.resolve(inc.id, { mode: "human", note: "x" }, AGENT(integrator.user.id)),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    });

    it("plain member CANNOT human-resolve → 403", () => {
      const project = createTestProject(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const member = createTestUser(testApp.db, { role: "member" });
      const inc = openInc(baseParams(project.id), AGENT(integrator.user.id));
      expect(() =>
        svc.resolve(inc.id, { mode: "human", note: "x" }, HUMAN(member.id)),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    });
  });
});
