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
import { gitRefs, mergeRequestGroups, mergeRequests } from "../../src/db/index.js";
import * as svc from "../../src/services/merge-group.service.js";
import * as mrSvc from "../../src/services/merge-request.service.js";
import * as incidentSvc from "../../src/services/merge-incident.service.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";

const HUMAN = (id: string, role = "member") => ({ id, role, type: "human" });
const AGENT = (id: string) => ({ id, role: "member", type: "ai_agent" });

describe("merge-group service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  /** Create N queued merge requests in `project`, optionally with tasks. */
  function makeMembers(
    project: { id: string },
    submitter: { id: string },
    n: number,
    opts: { withTasks?: boolean; resource?: string } = {},
  ) {
    const out: { id: string; taskId: string | null }[] = [];
    for (let i = 0; i < n; i++) {
      const task = opts.withTasks ? createTestTask(testApp.db, { projectId: project.id }) : null;
      const r = mrSvc.submit({
        projectId: project.id,
        submittedBy: submitter.id,
        resource: opts.resource ?? "main",
        taskId: task?.id ?? null,
      });
      out.push({ id: r.id, taskId: task?.id ?? null });
    }
    return out;
  }

  // ─── createGroup ──────────────────────────────────────────────────
  describe("createGroup", () => {
    it("associates >=2 members; group forming, members still queued", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const [m1, m2] = makeMembers(project, submitter, 2);

      const g = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: [m1.id, m2.id],
        },
        HUMAN(submitter.id),
      );

      expect(g.state).toBe("forming");
      expect(g.members).toHaveLength(2);
      for (const m of g.members) {
        expect(m.status).toBe("queued");
      }
      const rows = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.groupId, g.id))
        .all();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.groupId === g.id)).toBe(true);
    });

    it("cross-project member → 400 VALIDATION_ERROR", () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const [a] = makeMembers(projectA, submitter, 1);
      const [b] = makeMembers(projectB, submitter, 1);
      expect(() =>
        svc.createGroup(
          {
            projectId: projectA.id,
            submittedBy: submitter.id,
            memberRequestIds: [a.id, b.id],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }));
    });

    it("mismatched resource → 400 VALIDATION_ERROR", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const [m1] = makeMembers(project, submitter, 1);
      const [m2] = makeMembers(project, submitter, 1, { resource: "release" });
      expect(() =>
        svc.createGroup(
          {
            projectId: project.id,
            submittedBy: submitter.id,
            memberRequestIds: [m1.id, m2.id],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }));
    });

    it("non-queued member → 409 INVALID_TRANSITION", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const [m1, m2] = makeMembers(project, submitter, 2);
      mrSvc.transitionToIntegrating(m1.id, AGENT(integrator.user.id));
      expect(() =>
        svc.createGroup(
          {
            projectId: project.id,
            submittedBy: submitter.id,
            memberRequestIds: [m1.id, m2.id],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }));
    });

    it("already-grouped member → 409 ALREADY_GROUPED (and no partial writes)", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const [m1, m2, m3] = makeMembers(project, submitter, 3);
      svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: [m1.id, m2.id],
        },
        HUMAN(submitter.id),
      );
      // m1 is now grouped; trying to group it again with m3 must fail atomically.
      expect(() =>
        svc.createGroup(
          {
            projectId: project.id,
            submittedBy: submitter.id,
            memberRequestIds: [m1.id, m3.id],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 409, code: "ALREADY_GROUPED" }));
      // m3 must NOT have been written to any group (atomic rollback).
      const m3row = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, m3.id))
        .get();
      expect(m3row?.groupId).toBeNull();
    });

    it("rowcount guard rolls back when a member is concurrently grouped (atomic claim)", () => {
      // Simulate the TOCTOU race: validation passes, but the member is grouped
      // out-from-under us before the guarded UPDATE. We force this by stubbing
      // the read used in validation to report queued/ungrouped, while the DB
      // row is actually already grouped — the rowcount guard must catch it.
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const [m1, m2] = makeMembers(project, submitter, 2);
      // Pre-grouped m1 directly in the DB so the WHERE guard (group_id IS NULL)
      // excludes it → rowcount mismatch → whole txn rolls back.
      const decoy = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: makeMembers(project, submitter, 2).map((m) => m.id),
        },
        HUMAN(submitter.id),
      );
      testApp.db
        .update(mergeRequests)
        .set({ groupId: decoy.id })
        .where(eq(mergeRequests.id, m1.id))
        .run();
      // m1 now grouped; createGroup([m1,m2]) validation reads m1 as grouped and
      // 409s before the txn — but even if validation were bypassed, the guard
      // would catch it. Assert m2 stays ungrouped (no partial write).
      expect(() =>
        svc.createGroup(
          {
            projectId: project.id,
            submittedBy: submitter.id,
            memberRequestIds: [m1.id, m2.id],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 409 }));
      const m2row = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.id, m2.id))
        .get();
      expect(m2row?.groupId).toBeNull();
    });

    it("<2 members → 400 VALIDATION_ERROR", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const [m1] = makeMembers(project, submitter, 1);
      expect(() =>
        svc.createGroup(
          {
            projectId: project.id,
            submittedBy: submitter.id,
            memberRequestIds: [m1.id],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }));
    });

    it("missing member → 404 NOT_FOUND", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const [m1] = makeMembers(project, submitter, 1);
      expect(() =>
        svc.createGroup(
          {
            projectId: project.id,
            submittedBy: submitter.id,
            memberRequestIds: [m1.id, "01MISSING000000000000000000"],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }));
    });

    it("missing project → 404 NOT_FOUND", () => {
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.createGroup(
          {
            projectId: "01PROJECTMISSING000000000000",
            submittedBy: submitter.id,
            memberRequestIds: ["a", "b"],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }));
    });

    it("emits no event on create", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const [m1, m2] = makeMembers(project, submitter, 2);
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_STARTED, listener);
      svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: [m1.id, m2.id],
        },
        HUMAN(submitter.id),
      );
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ─── createGroup (atomic submit-and-group arm) ────────────────────
  describe("createGroup (atomic members arm)", () => {
    it("atomic create → group forming, 2 members born group-bound + queued + branch persisted", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);

      const g = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          members: [{ branch: "feat/inner" }, { commitSha: "abc1234" }],
        },
        HUMAN(submitter.id),
      );

      expect(g.state).toBe("forming");
      expect(g.members).toHaveLength(2);
      for (const m of g.members) {
        expect(m.groupId === undefined).toBe(true); // view has no groupId field
        expect(m.status).toBe("queued");
      }
      // Verify the DB rows: each born with groupId === g.id, queued, branch set.
      const rows = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.groupId, g.id))
        .all();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.groupId === g.id)).toBe(true);
      expect(rows.every((r) => r.status === "queued")).toBe(true);
      expect(rows.some((r) => r.branch === "feat/inner")).toBe(true);
      expect(rows.some((r) => r.commitSha === "abc1234")).toBe(true);
    });

    it("a born-grouped member is NEVER single-repo-pickable (Part B guard → 409 GROUPED_MEMBER)", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);

      const g = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          members: [{ branch: "feat/inner" }, { branch: "feat/outer" }],
        },
        HUMAN(submitter.id),
      );

      const memberId = g.members[0].id;
      expect(() => mrSvc.transitionToIntegrating(memberId, AGENT(integrator.user.id))).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "GROUPED_MEMBER" }),
      );
    });

    it("emits NO MERGE_REQUEST_QUEUED per member during atomic create", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const queuedListener = vi.fn();
      const startedListener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_QUEUED, queuedListener);
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_STARTED, startedListener);

      svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          members: [{ branch: "feat/inner" }, { branch: "feat/outer" }],
        },
        HUMAN(submitter.id),
      );

      expect(queuedListener).not.toHaveBeenCalled();
      expect(startedListener).not.toHaveBeenCalled();
    });

    it("persists taskId + verifyCmd from a spec", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const task = createTestTask(testApp.db, { projectId: project.id });

      const g = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          members: [
            { branch: "feat/inner", taskId: task.id, verifyCmd: "pnpm test" },
            { commitSha: "abc1234" },
          ],
        },
        HUMAN(submitter.id),
      );

      const taskMember = g.members.find((m) => m.taskId === task.id);
      expect(taskMember).toBeDefined();
      expect(taskMember!.verifyCmd).toBe("pnpm test");
    });

    it("a spec with a cross-project taskId → 400 VALIDATION_ERROR (no rows written)", () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const foreignTask = createTestTask(testApp.db, { projectId: projectB.id });

      expect(() =>
        svc.createGroup(
          {
            projectId: projectA.id,
            submittedBy: submitter.id,
            members: [{ branch: "feat/inner", taskId: foreignTask.id }, { branch: "feat/outer" }],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }));
      // No group/members written (validation throws before the txn).
      const groups = svc.list(projectA.id);
      expect(groups).toHaveLength(0);
    });

    it("a spec with a missing taskId → 404 NOT_FOUND", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.createGroup(
          {
            projectId: project.id,
            submittedBy: submitter.id,
            members: [
              { branch: "feat/inner", taskId: "01MISSINGTASK0000000000000" },
              { branch: "feat/outer" },
            ],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }));
    });

    it("a spec with neither branch nor commitSha → 400 VALIDATION_ERROR", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.createGroup(
          {
            projectId: project.id,
            submittedBy: submitter.id,
            members: [{ branch: "feat/inner" }, { verifyCmd: "pnpm test" }],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }));
    });

    it("<2 members → 400 VALIDATION_ERROR", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.createGroup(
          {
            projectId: project.id,
            submittedBy: submitter.id,
            members: [{ branch: "feat/inner" }],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }));
    });

    it("providing BOTH members and memberRequestIds → 400 VALIDATION_ERROR", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const [m1, m2] = makeMembers(project, submitter, 2);
      expect(() =>
        svc.createGroup(
          {
            projectId: project.id,
            submittedBy: submitter.id,
            memberRequestIds: [m1.id, m2.id],
            members: [{ branch: "feat/inner" }, { branch: "feat/outer" }],
          },
          HUMAN(submitter.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }));
    });

    it("providing NEITHER members nor memberRequestIds → 400 VALIDATION_ERROR", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.createGroup({ projectId: project.id, submittedBy: submitter.id }, HUMAN(submitter.id)),
      ).toThrowError(expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }));
    });

    it("a born-grouped member still lands via its group (back-compat with group land path)", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);

      const g = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          members: [{ branch: "feat/inner" }, { branch: "feat/outer" }],
        },
        HUMAN(submitter.id),
      );

      // Group pickup flips members to integrating WITHOUT routing through the
      // guarded transitionToIntegrating (markIntegrating owns its own tx).
      svc.markIntegrating(g.id, AGENT(integrator.user.id));
      const landed = svc.landGroup(
        g.id,
        {
          members: g.members.map((m) => ({
            requestId: m.id,
            landedSha: `sha-${m.id}`,
          })),
        },
        AGENT(integrator.user.id),
      );
      expect(landed.state).toBe("landed");
      expect(landed.members.every((m) => m.status === "landed")).toBe(true);
    });
  });

  // ─── createGroup (inner-only synthesizeOuter arm) ─────────────────
  describe("createGroup (inner-only synthesizeOuter arm)", () => {
    // The minimal valid topology: exactly one inner + one outer repo declared.
    const XREPO_SETTINGS = {
      integrator: {
        linked_repos: [
          { name: "rynx", path: "../rynx", role: "inner" },
          { name: "game", path: ".", role: "outer", gitlink_path: "rynx" },
        ],
      },
    };

    function setupInnerOnly(opts: { withTask?: boolean } = {}) {
      const project = createTestProject(testApp.db, { settings: XREPO_SETTINGS });
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const task = opts.withTask ? createTestTask(testApp.db, { projectId: project.id }) : null;
      const g = svc.createGroup({
        projectId: project.id,
        submittedBy: submitter.id,
        members: [
          {
            branch: "feat/inner",
            verifyCmd: "pnpm verify",
            ...(task ? { taskId: task.id } : {}),
          },
        ],
        synthesizeOuter: true,
      });
      const real = g.members.find((m) => !m.synthetic)!;
      const synthetic = g.members.find((m) => m.synthetic)!;
      return { project, submitter, integrator, task, g, real, synthetic };
    }

    /** Assert NOTHING was written for the project (txn/pre-txn atomicity). */
    function expectNoRows(projectId: string) {
      const groups = testApp.db
        .select()
        .from(mergeRequestGroups)
        .where(eq(mergeRequestGroups.projectId, projectId))
        .all();
      const requests = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.projectId, projectId))
        .all();
      expect(groups).toHaveLength(0);
      expect(requests).toHaveLength(0);
    }

    it("happy path: forming group with the real inner member + a synthetic outer member", () => {
      const { g, real, synthetic, task } = setupInnerOnly({ withTask: true });

      expect(g.state).toBe("forming");
      expect(g.members).toHaveLength(2);

      // The real member persists the spec fields and is NOT synthetic.
      expect(real.branch).toBe("feat/inner");
      expect(real.verifyCmd).toBe("pnpm verify");
      expect(real.taskId).toBe(task!.id);
      expect(real.status).toBe("queued");
      expect(real.synthetic).toBe(false);

      // The synthetic member: all-null refs, queued, group-bound, synthetic.
      expect(synthetic.branch).toBeNull();
      expect(synthetic.commitSha).toBeNull();
      expect(synthetic.verifyCmd).toBeNull();
      expect(synthetic.taskId).toBeNull();
      expect(synthetic.status).toBe("queued");
      expect(synthetic.synthetic).toBe(true);

      // Direct DB read: exactly 2 member rows, both bound to the group, the
      // synthetic one flagged + ref-less.
      const rows = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.groupId, g.id))
        .all();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.groupId === g.id)).toBe(true);
      const syntheticRow = rows.find((r) => r.synthetic)!;
      expect(syntheticRow.id).toBe(synthetic.id);
      expect(syntheticRow.branch).toBeNull();
      expect(syntheticRow.commitSha).toBeNull();
      expect(syntheticRow.status).toBe("queued");

      // getById view round-trips the flag.
      const got = svc.getById(g.id);
      expect(got.members.find((m) => m.id === synthetic.id)!.synthetic).toBe(true);
      expect(got.members.find((m) => m.id === real.id)!.synthetic).toBe(false);
    });

    it("flag + 2 specs → 400 (exactly one member spec required); nothing written", () => {
      const project = createTestProject(testApp.db, { settings: XREPO_SETTINGS });
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.createGroup({
          projectId: project.id,
          submittedBy: submitter.id,
          members: [{ branch: "feat/a" }, { branch: "feat/b" }],
          synthesizeOuter: true,
        }),
      ).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message:
            "synthesizeOuter requires exactly one member spec (the inner change); the outer member is synthesized at integration time.",
        }),
      );
      expectNoRows(project.id);
    });

    it("flag + memberRequestIds → 400 (cannot combine); nothing written", () => {
      const project = createTestProject(testApp.db, { settings: XREPO_SETTINGS });
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.createGroup({
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: ["a", "b"],
          synthesizeOuter: true,
        }),
      ).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message:
            "synthesizeOuter cannot be combined with memberRequestIds; provide members with exactly one inner member spec.",
        }),
      );
      expectNoRows(project.id);
    });

    it("1 spec WITHOUT the flag → 400 with the exact legacy message; nothing written", () => {
      const project = createTestProject(testApp.db, { settings: XREPO_SETTINGS });
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.createGroup({
          projectId: project.id,
          submittedBy: submitter.id,
          members: [{ branch: "feat/inner" }],
        }),
      ).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "A merge group requires at least 2 member specs.",
        }),
      );
      expectNoRows(project.id);
    });

    it("1 spec with an EXPLICIT synthesizeOuter: false → 400 (strict === true); nothing written", () => {
      const project = createTestProject(testApp.db, { settings: XREPO_SETTINGS });
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.createGroup({
          projectId: project.id,
          submittedBy: submitter.id,
          members: [{ branch: "feat/inner" }],
          synthesizeOuter: false,
        }),
      ).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "A merge group requires at least 2 member specs.",
        }),
      );
      expectNoRows(project.id);
    });

    it("flag without linked_repos settings → 400 topology error; nothing written", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.createGroup({
          projectId: project.id,
          submittedBy: submitter.id,
          members: [{ branch: "feat/inner" }],
          synthesizeOuter: true,
        }),
      ).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message:
            "synthesizeOuter requires settings.integrator.linked_repos to declare exactly one inner and one outer repo; found 0 inner / 0 outer.",
        }),
      );
      expectNoRows(project.id);
    });

    it("flag with TWO inners declared → 400 topology error; nothing written", () => {
      const project = createTestProject(testApp.db, {
        settings: {
          integrator: {
            linked_repos: [
              { name: "rynx", path: "../rynx", role: "inner" },
              { name: "treegen", path: "../treegen", role: "inner" },
              { name: "game", path: ".", role: "outer" },
            ],
          },
        },
      });
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.createGroup({
          projectId: project.id,
          submittedBy: submitter.id,
          members: [{ branch: "feat/inner" }],
          synthesizeOuter: true,
        }),
      ).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message:
            "synthesizeOuter requires settings.integrator.linked_repos to declare exactly one inner and one outer repo; found 2 inner / 1 outer.",
        }),
      );
      expectNoRows(project.id);
    });

    it("flag with NO outer declared → 400 topology error; nothing written", () => {
      const project = createTestProject(testApp.db, {
        settings: {
          integrator: {
            linked_repos: [{ name: "rynx", path: "../rynx", role: "inner" }],
          },
        },
      });
      const submitter = createTestUser(testApp.db);
      expect(() =>
        svc.createGroup({
          projectId: project.id,
          submittedBy: submitter.id,
          members: [{ branch: "feat/inner" }],
          synthesizeOuter: true,
        }),
      ).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message:
            "synthesizeOuter requires settings.integrator.linked_repos to declare exactly one inner and one outer repo; found 1 inner / 0 outer.",
        }),
      );
      expectNoRows(project.id);
    });

    it("emits NO events on inner-only create (parity with the other arms)", () => {
      const project = createTestProject(testApp.db, { settings: XREPO_SETTINGS });
      const submitter = createTestUser(testApp.db);
      const queuedListener = vi.fn();
      const startedListener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_QUEUED, queuedListener);
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_STARTED, startedListener);

      svc.createGroup({
        projectId: project.id,
        submittedBy: submitter.id,
        members: [{ branch: "feat/inner" }],
        synthesizeOuter: true,
      });

      expect(queuedListener).not.toHaveBeenCalled();
      expect(startedListener).not.toHaveBeenCalled();
    });

    it("synthetic member is never single-repo-pickable (409 GROUPED_MEMBER)", () => {
      const { synthetic, integrator } = setupInnerOnly();
      expect(() =>
        mrSvc.transitionToIntegrating(synthetic.id, AGENT(integrator.user.id)),
      ).toThrowError(expect.objectContaining({ statusCode: 409, code: "GROUPED_MEMBER" }));
    });

    it("synthetic member is never individually cancellable (409 GROUPED_MEMBER)", () => {
      const { synthetic, submitter } = setupInnerOnly();
      expect(() => mrSvc.cancel(synthetic.id, HUMAN(submitter.id))).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "GROUPED_MEMBER" }),
      );
    });

    it("markIntegrating flips the synthetic member queued→integrating; resetGroup returns it to queued (pickedUpAt null)", () => {
      const { g, synthetic, integrator } = setupInnerOnly();

      const integrating = svc.markIntegrating(g.id, AGENT(integrator.user.id));
      const sIntegrating = integrating.members.find((m) => m.id === synthetic.id)!;
      expect(sIntegrating.status).toBe("integrating");
      expect(sIntegrating.pickedUpAt).toBeTruthy();

      const reset = svc.resetGroup(g.id, AGENT(integrator.user.id));
      const sReset = reset.members.find((m) => m.id === synthetic.id)!;
      expect(sReset.status).toBe("queued");
      expect(sReset.pickedUpAt).toBeNull();
    });

    it("rejectGroup rejects the synthetic member with the rest of the group", () => {
      const { g, synthetic, submitter } = setupInnerOnly();
      const out = svc.rejectGroup(g.id, { reason: "abandoned" }, HUMAN(submitter.id));
      expect(out.state).toBe("rejected");
      expect(out.members.find((m) => m.id === synthetic.id)!.status).toBe("rejected");
    });

    it("landGroup lands the synthetic member: landedSha=Ro, NO git_ref, member event gitRefId null, group event outerLandedSha", () => {
      const { g, real, synthetic, integrator } = setupInnerOnly({
        withTask: true,
      });
      svc.markIntegrating(g.id, AGENT(integrator.user.id));

      const memberLanded = vi.fn();
      const groupLanded = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_MEMBER_LANDED, memberLanded);
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_LANDED, groupLanded);

      const out = svc.landGroup(
        g.id,
        {
          members: [
            { requestId: real.id, landedSha: "Ri", role: "inner" },
            { requestId: synthetic.id, landedSha: "Ro", role: "outer" },
          ],
        },
        AGENT(integrator.user.id),
      );

      expect(out.state).toBe("landed");
      const sLanded = out.members.find((m) => m.id === synthetic.id)!;
      expect(sLanded.status).toBe("landed");
      expect(sLanded.landedSha).toBe("Ro");

      // No git_ref for the task-less synthetic member — only the real inner
      // member (which carries the task) gets one.
      const refs = testApp.db.select().from(gitRefs).all();
      expect(refs).toHaveLength(1);
      expect(refs[0].refValue).toBe("Ri");

      // The synthetic MERGE_GROUP_MEMBER_LANDED carries gitRefId null.
      const syntheticEvent = memberLanded.mock.calls
        .map((c) => c[0])
        .find((p) => p.entity.requestId === synthetic.id);
      expect(syntheticEvent).toBeDefined();
      expect(syntheticEvent.entity.gitRefId).toBeNull();

      // The group event derives outerLandedSha from the synthetic member.
      expect(groupLanded).toHaveBeenCalledTimes(1);
      const lp = groupLanded.mock.calls[0][0];
      expect(lp.entity.innerLandedSha).toBe("Ri");
      expect(lp.entity.outerLandedSha).toBe("Ro");
    });

    it("list(ungrouped: true) excludes the synthetic member (and the real one — both group-bound)", () => {
      const { project, submitter, synthetic } = setupInnerOnly();
      // An ungrouped control request that MUST appear.
      const control = mrSvc.submit({
        projectId: project.id,
        submittedBy: submitter.id,
        branch: "feat/solo",
      });
      const listed = mrSvc.list(project.id, { ungrouped: true });
      const ids = listed.data.map((r) => r.id);
      expect(ids).toContain(control.id);
      expect(ids).not.toContain(synthetic.id);
    });

    it("legacy regression: both legacy arms produce synthetic:false members with the pinned view key set", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);

      // Pinned member-view shape: the pre-campaign keys ∪ {"synthetic"}.
      const PINNED_KEYS = [
        "branch",
        "commitSha",
        "createdAt",
        "enqueuedAt",
        "failedFiles",
        "id",
        "landedSha",
        "logExcerpt",
        "logUrl",
        "pickedUpAt",
        "projectId",
        "rejectCategory",
        "rejectReason",
        "resolvedAt",
        "resolvedFrom",
        "resource",
        "status",
        "submittedBy",
        "synthetic",
        "taskId",
        "updatedAt",
        "verifyCmd",
        "worktreePath",
      ];

      const ids = svc.createGroup({
        projectId: project.id,
        submittedBy: submitter.id,
        memberRequestIds: makeMembers(project, submitter, 2).map((m) => m.id),
      });
      const atomic = svc.createGroup({
        projectId: project.id,
        submittedBy: submitter.id,
        members: [{ branch: "feat/a" }, { branch: "feat/b" }],
      });

      for (const g of [ids, atomic]) {
        for (const m of g.members) {
          expect(m.synthetic).toBe(false);
          expect(Object.keys(m).sort()).toEqual(PINNED_KEYS);
        }
      }
    });
  });

  // ─── getById / list ───────────────────────────────────────────────
  describe("getById / list", () => {
    it("getById returns members ordered by enqueuedAt asc; 404 for missing", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const [m1, m2] = makeMembers(project, submitter, 2);
      const g = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: [m1.id, m2.id],
        },
        HUMAN(submitter.id),
      );
      const got = svc.getById(g.id);
      expect(got.members.map((m) => m.id)).toEqual([m1.id, m2.id]);
      expect(() => svc.getById("01MISSING000000000000000000")).toThrowError(
        expect.objectContaining({ statusCode: 404 }),
      );
    });

    it("list filters by state and orders by createdAt asc; 404 for missing project", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const g1 = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: makeMembers(project, submitter, 2).map((m) => m.id),
        },
        HUMAN(submitter.id),
      );
      const all = svc.list(project.id);
      expect(all.map((g) => g.id)).toContain(g1.id);
      const forming = svc.list(project.id, { state: "forming" });
      expect(forming).toHaveLength(1);
      const landed = svc.list(project.id, { state: "landed" });
      expect(landed).toHaveLength(0);
      expect(() => svc.list("01MISSING000000000000000000")).toThrowError(
        expect.objectContaining({ statusCode: 404 }),
      );
    });
  });

  // ─── G1 guard ─────────────────────────────────────────────────────
  describe("assertMemberLandableViaGroup (G1)", () => {
    it("throws 409 GROUPED_MEMBER for a grouped member, passes for an ungrouped one", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const [m1, m2] = makeMembers(project, submitter, 2);
      const ungrouped = makeMembers(project, submitter, 1)[0];
      svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: [m1.id, m2.id],
        },
        HUMAN(submitter.id),
      );
      expect(() => svc.assertMemberLandableViaGroup(m1.id)).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "GROUPED_MEMBER" }),
      );
      expect(() => svc.assertMemberLandableViaGroup(ungrouped.id)).not.toThrow();
    });
  });

  // ─── markIntegrating ──────────────────────────────────────────────
  describe("markIntegrating", () => {
    function setupForming(opts: { withTasks?: boolean } = {}) {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const members = makeMembers(project, submitter, 2, opts);
      const g = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: members.map((m) => m.id),
        },
        HUMAN(submitter.id),
      );
      return { project, submitter, integrator, members, g };
    }

    it("forming → integrating; flips members queued→integrating; emits MERGE_GROUP_STARTED", () => {
      const { g, integrator, members } = setupForming();
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_STARTED, listener);

      const out = svc.markIntegrating(g.id, AGENT(integrator.user.id));
      expect(out.state).toBe("integrating");
      expect(out.integratorId).toBe(integrator.user.id);
      for (const m of out.members) {
        expect(m.status).toBe("integrating");
        expect(m.pickedUpAt).toBeTruthy();
      }
      expect(listener).toHaveBeenCalledTimes(1);
      const payload = listener.mock.calls[0][0];
      expect(payload.entity.memberCount).toBe(2);
      expect(payload.entity.memberRequestIds.sort()).toEqual(members.map((m) => m.id).sort());
    });

    it("does NOT emit per-member merge.request.integrating (PIN C: single visibility event)", () => {
      const { g, integrator } = setupForming();
      const memberListener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_REQUEST_INTEGRATING, memberListener);
      svc.markIntegrating(g.id, AGENT(integrator.user.id));
      expect(memberListener).not.toHaveBeenCalled();
    });

    it("emit-after-commit: listener sees group already integrating", () => {
      const { g, integrator } = setupForming();
      let observedState: string | undefined;
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_STARTED, () => {
        observedState = svc.getById(g.id).state;
      });
      svc.markIntegrating(g.id, AGENT(integrator.user.id));
      expect(observedState).toBe("integrating");
    });

    it("integrating → 409 INVALID_TRANSITION (no idempotent case)", () => {
      const { g, integrator } = setupForming();
      svc.markIntegrating(g.id, AGENT(integrator.user.id));
      expect(() => svc.markIntegrating(g.id, AGENT(integrator.user.id))).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("non-ai_agent → 403 FORBIDDEN", () => {
      const { g, submitter } = setupForming();
      expect(() => svc.markIntegrating(g.id, HUMAN(submitter.id, "admin"))).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });
  });

  // ─── landGroup ────────────────────────────────────────────────────
  describe("landGroup", () => {
    function setupIntegrating(opts: { withTasks?: boolean } = {}) {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const members = makeMembers(project, submitter, 2, opts);
      const g = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: members.map((m) => m.id),
        },
        HUMAN(submitter.id),
      );
      svc.markIntegrating(g.id, AGENT(integrator.user.id));
      return { project, submitter, integrator, members, g };
    }

    it("integrating → landed; members landed+landedSha; git_ref per member; emits per-member then group landed", () => {
      const { g, integrator, members } = setupIntegrating({ withTasks: true });
      const memberLanded = vi.fn();
      const groupLanded = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_MEMBER_LANDED, memberLanded);
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_LANDED, groupLanded);

      const out = svc.landGroup(
        g.id,
        {
          members: [
            { requestId: members[0].id, landedSha: "inner1", role: "inner" },
            { requestId: members[1].id, landedSha: "outer1", role: "outer" },
          ],
        },
        AGENT(integrator.user.id),
      );

      expect(out.state).toBe("landed");
      for (const m of out.members) {
        expect(m.status).toBe("landed");
        expect(m.landedSha).toBeTruthy();
      }
      // git_ref per member with a taskId.
      for (const m of members) {
        const refs = testApp.db.select().from(gitRefs).where(eq(gitRefs.taskId, m.taskId!)).all();
        expect(refs).toHaveLength(1);
        expect(refs[0].refType).toBe("landed_sha");
      }
      expect(memberLanded).toHaveBeenCalledTimes(2);
      expect(groupLanded).toHaveBeenCalledTimes(1);
      const lp = groupLanded.mock.calls[0][0];
      expect(lp.entity.innerLandedSha).toBe("inner1");
      expect(lp.entity.outerLandedSha).toBe("outer1");
    });

    it("emit-after-commit: member_landed listener sees member already landed", () => {
      const { g, integrator, members } = setupIntegrating();
      const observed: string[] = [];
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_MEMBER_LANDED, (p) => {
        const reqId = p.entity.requestId as string;
        const row = testApp.db
          .select()
          .from(mergeRequests)
          .where(eq(mergeRequests.id, reqId))
          .get();
        observed.push(row!.status);
      });
      svc.landGroup(
        g.id,
        {
          members: [
            { requestId: members[0].id, landedSha: "a" },
            { requestId: members[1].id, landedSha: "b" },
          ],
        },
        AGENT(integrator.user.id),
      );
      expect(observed).toEqual(["landed", "landed"]);
    });

    it("idempotent: second land on landed returns row, no second event, no duplicate git_ref", () => {
      const { g, integrator, members } = setupIntegrating({ withTasks: true });
      svc.landGroup(
        g.id,
        {
          members: [
            { requestId: members[0].id, landedSha: "a" },
            { requestId: members[1].id, landedSha: "b" },
          ],
        },
        AGENT(integrator.user.id),
      );
      const memberLanded = vi.fn();
      const groupLanded = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_MEMBER_LANDED, memberLanded);
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_LANDED, groupLanded);

      const out = svc.landGroup(
        g.id,
        {
          members: [
            { requestId: members[0].id, landedSha: "a" },
            { requestId: members[1].id, landedSha: "b" },
          ],
        },
        AGENT(integrator.user.id),
      );
      expect(out.state).toBe("landed");
      expect(memberLanded).not.toHaveBeenCalled();
      expect(groupLanded).not.toHaveBeenCalled();
      for (const m of members) {
        const refs = testApp.db.select().from(gitRefs).where(eq(gitRefs.taskId, m.taskId!)).all();
        expect(refs).toHaveLength(1);
      }
    });

    it("from forming → 409 INVALID_TRANSITION", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const members = makeMembers(project, submitter, 2);
      const g = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: members.map((m) => m.id),
        },
        HUMAN(submitter.id),
      );
      expect(() =>
        svc.landGroup(
          g.id,
          { members: [{ requestId: members[0].id, landedSha: "x" }] },
          AGENT(integrator.user.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }));
    });

    it("from rejected → 409 INVALID_TRANSITION", () => {
      const { g, integrator, members, submitter } = setupIntegrating();
      svc.rejectGroup(g.id, { reason: "x" }, HUMAN(submitter.id, "admin"));
      expect(() =>
        svc.landGroup(
          g.id,
          { members: [{ requestId: members[0].id, landedSha: "x" }] },
          AGENT(integrator.user.id),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }));
    });

    it("non-ai_agent → 403 FORBIDDEN", () => {
      const { g, members, submitter } = setupIntegrating();
      expect(() =>
        svc.landGroup(
          g.id,
          { members: [{ requestId: members[0].id, landedSha: "x" }] },
          HUMAN(submitter.id, "admin"),
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    });
  });

  // ─── rejectGroup ──────────────────────────────────────────────────
  describe("rejectGroup", () => {
    function setupForming() {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db, { role: "member" });
      const integrator = createTestAiAgent(testApp.db);
      const members = makeMembers(project, submitter, 2);
      const g = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: members.map((m) => m.id),
        },
        HUMAN(submitter.id),
      );
      return { project, submitter, integrator, members, g };
    }

    it("forming → rejected by submitter; members rejected; emits MERGE_GROUP_REJECTED outcome rejected", () => {
      const { g, submitter, members } = setupForming();
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_REJECTED, listener);

      const out = svc.rejectGroup(g.id, { reason: "changed my mind" }, HUMAN(submitter.id));
      expect(out.state).toBe("rejected");
      expect(out.resolutionReason).toBe("changed my mind");
      for (const m of members) {
        const row = testApp.db.select().from(mergeRequests).where(eq(mergeRequests.id, m.id)).get();
        expect(row!.status).toBe("rejected");
      }
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].entity.outcome).toBe("rejected");
    });

    it("integrating → rejected by integrator", () => {
      const { g, integrator, members } = setupForming();
      svc.markIntegrating(g.id, AGENT(integrator.user.id));
      const out = svc.rejectGroup(
        g.id,
        { reason: "verify failed", category: "test_failed" },
        AGENT(integrator.user.id),
      );
      expect(out.state).toBe("rejected");
      for (const m of members) {
        const row = testApp.db.select().from(mergeRequests).where(eq(mergeRequests.id, m.id)).get();
        expect(row!.status).toBe("rejected");
      }
    });

    it("admin may reject", () => {
      const { g } = setupForming();
      const admin = createTestUser(testApp.db, { role: "admin" });
      const out = svc.rejectGroup(g.id, { reason: "kill" }, HUMAN(admin.id, "admin"));
      expect(out.state).toBe("rejected");
    });

    it("stranger → 403 FORBIDDEN", () => {
      const { g } = setupForming();
      const stranger = createTestUser(testApp.db, { role: "member" });
      expect(() => svc.rejectGroup(g.id, { reason: "x" }, HUMAN(stranger.id))).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });

    it("idempotent: second reject on rejected → noop, no event", () => {
      const { g, submitter } = setupForming();
      svc.rejectGroup(g.id, { reason: "1" }, HUMAN(submitter.id));
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_REJECTED, listener);
      const out = svc.rejectGroup(g.id, { reason: "2" }, HUMAN(submitter.id));
      expect(out.state).toBe("rejected");
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ─── markInnerOrphaned + markPartiallyLanded ──────────────────────
  describe("markInnerOrphaned + markPartiallyLanded", () => {
    function setupIntegrating() {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const members = makeMembers(project, submitter, 2);
      const g = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: members.map((m) => m.id),
        },
        HUMAN(submitter.id),
      );
      svc.markIntegrating(g.id, AGENT(integrator.user.id));
      return { project, submitter, integrator, members, g };
    }

    it("markInnerOrphaned sets inner orphaned; no incident; no member_landed event", () => {
      const { integrator, members } = setupIntegrating();
      const memberLanded = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_MEMBER_LANDED, memberLanded);

      const out = svc.markInnerOrphaned(members[0].id, "orphansha", AGENT(integrator.user.id));
      expect(out.status).toBe("orphaned");
      expect(out.landedSha).toBe("orphansha");
      expect(out.resolvedAt).toBeTruthy();
      expect(memberLanded).not.toHaveBeenCalled();
    });

    it("markInnerOrphaned on ungrouped request → 409 INVALID_TRANSITION", () => {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const r = mrSvc.submit({ projectId: project.id, submittedBy: submitter.id });
      mrSvc.transitionToIntegrating(r.id, AGENT(integrator.user.id));
      expect(() => svc.markInnerOrphaned(r.id, "s", AGENT(integrator.user.id))).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("markInnerOrphaned on non-integrating member → 409", () => {
      const { integrator, members } = setupIntegrating();
      // First orphan it; second call is from state orphaned → 409.
      svc.markInnerOrphaned(members[0].id, "s", AGENT(integrator.user.id));
      expect(() =>
        svc.markInnerOrphaned(members[0].id, "s", AGENT(integrator.user.id)),
      ).toThrowError(expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }));
    });

    it("markInnerOrphaned non-ai_agent → 403", () => {
      const { members, submitter } = setupIntegrating();
      expect(() =>
        svc.markInnerOrphaned(members[0].id, "s", HUMAN(submitter.id, "admin")),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    });

    it("markPartiallyLanded → partially_landed; emits MERGE_GROUP_REJECTED outcome partially_landed", () => {
      const { g, integrator } = setupIntegrating();
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_REJECTED, listener);

      const out = svc.markPartiallyLanded(
        g.id,
        { reason: "outer push failed", incidentId: "inc1" },
        AGENT(integrator.user.id),
      );
      expect(out.state).toBe("partially_landed");
      expect(listener).toHaveBeenCalledTimes(1);
      const p = listener.mock.calls[0][0];
      expect(p.entity.outcome).toBe("partially_landed");
      expect(p.entity.incidentId).toBe("inc1");
    });

    it("markPartiallyLanded idempotent: second → noop, no event", () => {
      const { g, integrator } = setupIntegrating();
      svc.markPartiallyLanded(g.id, { reason: "x" }, AGENT(integrator.user.id));
      const listener = vi.fn();
      getEventBus().on(EVENT_NAMES.MERGE_GROUP_REJECTED, listener);
      const out = svc.markPartiallyLanded(g.id, { reason: "y" }, AGENT(integrator.user.id));
      expect(out.state).toBe("partially_landed");
      expect(listener).not.toHaveBeenCalled();
    });

    it("markPartiallyLanded non-ai_agent → 403", () => {
      const { g, submitter } = setupIntegrating();
      expect(() =>
        svc.markPartiallyLanded(g.id, { reason: "x" }, HUMAN(submitter.id, "admin")),
      ).toThrowError(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    });
  });

  // ─── resetGroup (stranded-group recovery, §9 finding 2 / §6.4) ────
  describe("resetGroup", () => {
    function setupIntegrating(opts: { withTasks?: boolean } = {}) {
      const project = createTestProject(testApp.db);
      const submitter = createTestUser(testApp.db);
      const integrator = createTestAiAgent(testApp.db);
      const members = makeMembers(project, submitter, 2, opts);
      const g = svc.createGroup(
        {
          projectId: project.id,
          submittedBy: submitter.id,
          memberRequestIds: members.map((m) => m.id),
        },
        HUMAN(submitter.id),
      );
      svc.markIntegrating(g.id, AGENT(integrator.user.id));
      return { project, submitter, integrator, members, g };
    }

    it("integrating → forming; resets members integrating→queued (pickedUpAt cleared); clears integratorId", () => {
      const { g, integrator } = setupIntegrating();
      const before = svc.getById(g.id);
      expect(before.state).toBe("integrating");
      for (const m of before.members) expect(m.status).toBe("integrating");

      const out = svc.resetGroup(g.id, AGENT(integrator.user.id), {
        reason: "restart",
      });
      expect(out.state).toBe("forming");
      expect(out.integratorId).toBeNull();
      for (const m of out.members) {
        expect(m.status).toBe("queued");
        expect(m.pickedUpAt).toBeNull();
      }
    });

    it("atomic group+members: the members are queued together with the group forming", () => {
      const { g, integrator } = setupIntegrating();
      const out = svc.resetGroup(g.id, AGENT(integrator.user.id));
      // Group forming AND every member queued — never a half-integrating group.
      expect(out.state).toBe("forming");
      expect(out.members.every((m) => m.status === "queued")).toBe(true);
      const rows = testApp.db
        .select()
        .from(mergeRequests)
        .where(eq(mergeRequests.groupId, g.id))
        .all();
      expect(rows.every((r) => r.status === "queued")).toBe(true);
      expect(rows.every((r) => r.pickedUpAt === null)).toBe(true);
    });

    it("forming → forming idempotent noop (no error)", () => {
      const { g, integrator } = setupIntegrating();
      svc.resetGroup(g.id, AGENT(integrator.user.id));
      // Second reset (already forming) is a safe no-op.
      const out = svc.resetGroup(g.id, AGENT(integrator.user.id));
      expect(out.state).toBe("forming");
    });

    it("CORRUPTION FENCE: partially_landed group → 409 INVALID_TRANSITION (a real orphan, not stranded)", () => {
      const { g, integrator } = setupIntegrating();
      svc.markPartiallyLanded(g.id, { reason: "outer push failed" }, AGENT(integrator.user.id));
      expect(() => svc.resetGroup(g.id, AGENT(integrator.user.id))).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("CORRUPTION FENCE: integrating group WITH an open incident → 409 INVALID_TRANSITION", () => {
      const { g, project, integrator, members } = setupIntegrating();
      // Open a real orphaned_inner incident for this group.
      incidentSvc.openIncident(
        {
          projectId: project.id,
          groupId: g.id,
          type: "orphaned_inner",
          innerRepo: "rynx-inner",
          orphanedSha: "a".repeat(40),
          outerRepo: "app-outer",
          innerRequestId: members[0].id,
          taskId: null,
        },
        AGENT(integrator.user.id),
      );
      expect(() => svc.resetGroup(g.id, AGENT(integrator.user.id))).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
      // The group stays integrating (untouched).
      expect(svc.getById(g.id).state).toBe("integrating");
    });

    it("landed group → 409 INVALID_TRANSITION (terminal, never reset)", () => {
      const { g, integrator, members } = setupIntegrating();
      svc.landGroup(
        g.id,
        {
          members: members.map((m, i) => ({
            requestId: m.id,
            landedSha: `landed${i}`,
            role: i === 0 ? "inner" : "outer",
          })),
        },
        AGENT(integrator.user.id),
      );
      expect(() => svc.resetGroup(g.id, AGENT(integrator.user.id))).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "INVALID_TRANSITION" }),
      );
    });

    it("non-ai_agent → 403 FORBIDDEN", () => {
      const { g, submitter } = setupIntegrating();
      expect(() => svc.resetGroup(g.id, HUMAN(submitter.id, "admin"))).toThrowError(
        expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }),
      );
    });
  });
});
